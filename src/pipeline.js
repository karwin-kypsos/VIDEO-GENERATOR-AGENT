import fs from 'node:fs';
import path from 'node:path';
import { buildSrt } from './captions.js';
import { captureUrl } from './capture.js';
import { loadBrand, resolveFormat } from './config.js';
import { assertFfmpeg, buildAudioTrack, extractFrame, muxVideo } from './ffmpeg.js';
import { planStoryboard } from './planner.js';
import { renderSegments } from './render.js';
import { loadStoryboard, normalizeStoryboard, saveStoryboard } from './storyboard.js';
import { buildTimeline } from './timeline.js';
import { resolveVoice, synthesizeScenes } from './tts.js';
import { UserError, formatSeconds, progress, slugify, step } from './util.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Expand --screens values (folders or files) into a list of image files, in name order. */
function collectScreens(inputs) {
  const files = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) throw new UserError(`Screens not found: ${input}`);
    if (fs.statSync(abs).isDirectory()) {
      const found = fs
        .readdirSync(abs)
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((name) => path.join(abs, name));
      if (!found.length) throw new UserError(`No images (png, jpg, webp) in ${input}`);
      files.push(...found);
    } else if (IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
      files.push(abs);
    } else {
      throw new UserError(`Not an image: ${input}`);
    }
  }
  return files;
}

function projectDir(options, fallbackName) {
  if (options.out) return path.resolve(options.out);
  return path.resolve('out', slugify(options.name || fallbackName));
}

/**
 * Turn a brief (plus optional screenshots or a URL) into a storyboard file.
 * @returns {Promise<{file: string, dir: string, storyboard: object}>}
 */
export async function plan(options) {
  const brand = loadBrand(options.brand);
  const format = resolveFormat(options.format);
  const host = options.url ? options.url.replace(/^https?:\/\//, '').split('/')[0] : '';
  let brief = options.brief?.trim() ?? '';
  if (!brief && !options.url && !options.screens?.length) {
    throw new UserError('Nothing to make a video from. Pass a brief, --screens, --url, or --storyboard.');
  }

  const dir = projectDir(options, brief.split(/\s+/).slice(0, 7).join(' ') || host || 'video');
  const screensDir = path.join(dir, 'screens');
  const workDir = path.join(dir, '.work');
  fs.mkdirSync(workDir, { recursive: true });

  const screens = [];
  if (options.screens?.length) {
    fs.mkdirSync(screensDir, { recursive: true });
    collectScreens(options.screens).forEach((file, i) => {
      const name = `${String(i + 1).padStart(2, '0')}-${slugify(path.parse(file).name, 32)}${path.extname(file).toLowerCase()}`;
      fs.copyFileSync(file, path.join(screensDir, name));
      screens.push({ name: `screens/${name}`, file: path.join(screensDir, name) });
    });
  }

  let site = null;
  if (options.url) {
    const done = step(`Capturing ${host}`);
    const device = options.capture ?? (format.name === 'reel' ? 'mobile' : 'desktop');
    const captured = await captureUrl(options.url, screensDir, { device });
    site = captured.site;
    for (const file of captured.files) screens.push({ name: `screens/${path.basename(file)}`, file });
    done(`${captured.files.length} screenshots`);
  }

  if (!brief) {
    brief = site
      ? 'Introduce this website to someone seeing it for the first time: what it is, who it is for, and why they should visit.'
      : 'Walk a new viewer through what these screens show and why it matters to them.';
  }

  const done = step('Writing the storyboard');
  const raw = await planStoryboard({
    brief,
    brand,
    format,
    targetSeconds: options.duration ?? 30,
    screens,
    site,
    language: options.lang,
    workDir,
  });
  const storyboard = normalizeStoryboard({ ...raw, format: format.name }, dir);
  const file = path.join(dir, 'storyboard.json');
  saveStoryboard(storyboard, file);
  fs.rmSync(workDir, { recursive: true, force: true });
  const wordCount = storyboard.scenes.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
  done(`${storyboard.scenes.length} scenes, ${wordCount} words`);
  return { file, dir, storyboard };
}

/**
 * Render a storyboard to an MP4.
 * @returns {Promise<{video: string, cover: string, captions: string, duration: number}>}
 */
export async function render(storyboardFile, options) {
  const started = performance.now();
  await assertFfmpeg();
  const storyboard = loadStoryboard(storyboardFile);
  const brand = loadBrand(options.brand);
  const format = resolveFormat(options.format || storyboard.format || 'reel');
  const showCaptions = options.captions ?? brand.captions;
  const fps = options.fps ?? (options.draft ? 15 : 30);

  // A file called storyboard.json marks a project folder (that is what `plan` writes), so its
  // outputs go next to it. Any other storyboard renders into out/<title>.
  const ownFolder = path.basename(storyboardFile) === 'storyboard.json';
  const dir = options.out
    ? path.resolve(options.out)
    : options.name
      ? path.resolve('out', slugify(options.name))
      : ownFolder
        ? path.dirname(path.resolve(storyboardFile))
        : path.resolve('out', slugify(storyboard.title));
  const workDir = path.join(dir, '.work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  if (options.music && !fs.existsSync(options.music)) throw new UserError(`Music file not found: ${options.music}`);

  // 1. Voice
  let voice = null;
  const doneVoice = step(options.draft ? 'Estimating timing (draft: no voice)' : 'Generating voice with ElevenLabs');
  if (!options.draft) {
    voice = await resolveVoice(options.voice || process.env.ELEVENLABS_VOICE_ID || brand.voice.id);
  }
  const clips = await synthesizeScenes(storyboard.scenes, {
    voice,
    brandVoice: brand.voice,
    language: /^[a-z]{2}$/i.test(options.lang ?? '') ? options.lang.toLowerCase() : undefined,
    cacheDir: path.resolve('.cache', 'tts'),
    draft: options.draft,
  });
  const voiced = clips.filter(Boolean);
  const reused = voiced.filter((c) => c.cached).length;
  doneVoice(
    options.draft
      ? `${voiced.length} scenes`
      : `voice "${voice.name}", ${voiced.length} clips${reused ? ` (${reused} from cache)` : ''}`,
  );

  // 2. Timeline
  const timeline = buildTimeline(storyboard, clips, { fps, formatName: format.name, captions: showCaptions });

  // 3. Picture
  const doneRender = step(`Rendering ${timeline.frames} frames at ${format.width}x${format.height}`);
  const segments = await renderSegments(timeline, {
    format,
    brand,
    workDir,
    showCaptions,
    quality: options.draft ? 80 : 92,
    crf: options.draft ? 24 : 18,
    onProgress: progress('frames'),
  });
  doneRender();

  // 4. Sound and final file
  const doneMux = step('Mixing audio and writing the MP4');
  const audioFile = path.join(workDir, 'audio.m4a');
  await buildAudioTrack(
    timeline.scenes.filter((s) => s.voiceFile).map((s) => ({ file: s.voiceFile, at: s.voiceAt })),
    timeline.total,
    audioFile,
    { music: options.music },
  );
  const base = `${slugify(storyboard.title)}-${format.name}${options.draft ? '-draft' : ''}`;
  const video = path.join(dir, `${base}.mp4`);
  await muxVideo(segments, audioFile, video);

  const cover = path.join(dir, `${base}-cover.jpg`);
  await extractFrame(video, Math.min(timeline.scenes[0].duration * 0.6, 1.6), cover);
  const captions = path.join(dir, `${base}.srt`);
  fs.writeFileSync(captions, buildSrt(timeline.scenes));
  if (!options.keepWork) fs.rmSync(workDir, { recursive: true, force: true });
  doneMux();

  const elapsed = (performance.now() - started) / 1000;
  return { video, cover, captions, duration: timeline.total, elapsed, format, scenes: timeline.scenes.length };
}

/** Brief in, video out. */
export async function make(options) {
  let storyboardFile = options.storyboard;
  if (!storyboardFile) {
    const planned = await plan(options);
    storyboardFile = planned.file;
    options = { ...options, out: planned.dir };
  }
  const result = await render(storyboardFile, options);
  console.log(
    `\n🎬 ${path.relative(process.cwd(), result.video)}\n` +
      `   ${formatSeconds(result.duration)} · ${result.scenes} scenes · ${result.format.width}x${result.format.height} · made in ${formatSeconds(result.elapsed)}\n` +
      `   cover: ${path.relative(process.cwd(), result.cover)}\n` +
      `   subtitles: ${path.relative(process.cwd(), result.captions)}`,
  );
  if (options.draft) console.log('   Draft: silent, 15 fps. Run again without --draft for the voiced, full-quality video.');
  return result;
}
