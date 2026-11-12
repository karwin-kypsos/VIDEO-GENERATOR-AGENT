import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { TEMPLATE_DIR } from './config.js';
import { startSegmentEncoder } from './ffmpeg.js';

const ORIGIN = 'http://vidgen.local';
const require = createRequire(import.meta.url);

const BUNDLED_FONTS = {
  'Plus Jakarta Sans': '@fontsource-variable/plus-jakarta-sans',
  Inter: '@fontsource-variable/inter',
};

const fileUrl = (absPath) => `${ORIGIN}/f/${encodeURIComponent(absPath)}`;

/**
 * @font-face rules for the brand's fonts. Bundled families come from npm so renders need no
 * network; anything else falls back to a font installed on the machine, or to files in brand.json.
 * @returns {{css: string, files: string[]}} the CSS and every local file it references
 */
export function buildFontCss(brand) {
  const files = [];
  let css = '';
  for (const family of new Set([brand.fonts.heading, brand.fonts.body])) {
    const pkg = BUNDLED_FONTS[family];
    if (!pkg) continue;
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    css += fs
      .readFileSync(path.join(dir, 'wght.css'), 'utf8')
      .replace(/font-family:\s*['"][^'"]+['"]/g, `font-family: '${family}'`)
      .replace(/font-display:\s*swap/g, 'font-display: block')
      .replace(/url\(\.\/files\/([^)]+)\)/g, (_, name) => {
        const file = path.join(dir, 'files', name);
        files.push(file);
        return `url(${fileUrl(file)})`;
      });
  }
  for (const font of brand.fonts.files) {
    files.push(font.path);
    css += `@font-face { font-family: '${font.family}'; src: url(${fileUrl(font.path)}); font-weight: ${font.weight ?? '100 900'}; font-style: ${font.style ?? 'normal'}; font-display: block; }\n`;
  }
  return { css, files };
}

function scenePayload(scene, timeline, { format, brand, fontCss, showCaptions }) {
  return {
    format: format.name,
    duration: scene.duration,
    start: scene.start,
    total: timeline.total,
    showCaptions: showCaptions && scene.captionChunks.length > 0,
    captions: scene.captionChunks,
    fontCss,
    brand: {
      name: brand.name,
      url: brand.url,
      handle: brand.handle,
      logoUrl: brand.logo ? fileUrl(brand.logo) : '',
      colors: brand.colors,
      fonts: { heading: brand.fonts.heading, body: brand.fonts.body },
      progressBar: brand.progressBar,
      ambientMotion: brand.ambientMotion,
    },
    scene: {
      type: scene.type,
      kicker: scene.kicker,
      headline: scene.headline,
      subhead: scene.subhead,
      items: scene.items,
      itemTimes: scene.itemTimes,
      value: scene.value,
      label: scene.label,
      quote: scene.quote,
      author: scene.author,
      button: scene.button,
      imageUrl: scene.image ? fileUrl(scene.image) : '',
      frame: scene.frame,
      motion: scene.motion,
      focusX: scene.focusX,
      focusY: scene.focusY,
      highlight: scene.highlight,
    },
  };
}

/** Serve the template and the handful of local files a scene needs, and nothing else. */
async function serveLocalFiles(context, allowed) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    let file = null;
    if (pathname.startsWith('/t/')) file = path.join(TEMPLATE_DIR, path.basename(pathname));
    else if (pathname.startsWith('/f/')) {
      const wanted = decodeURIComponent(pathname.slice(3));
      if (allowed.has(wanted)) file = wanted;
    }
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ path: file });
  });
}

/**
 * Render every scene to H.264 segments, in timeline order.
 *
 * Time inside the page is paused and stepped one frame at a time, so the result is identical
 * however fast or slow the machine is. Scenes are cut into short jobs that several browsers work
 * through in parallel; frames where nothing moved are reused instead of captured again.
 *
 * @returns {Promise<string[]>} segment files in playback order
 */
export async function renderSegments(timeline, { format, brand, workDir, showCaptions, quality = 92, crf = 18, onProgress }) {
  const { fps } = timeline;
  const { css: fontCss, files: fontFiles } = buildFontCss(brand);
  const allowed = new Set([...fontFiles, brand.logo, ...timeline.scenes.map((s) => s.image)].filter(Boolean));

  const jobFrames = fps * 4;
  const jobs = [];
  for (const scene of timeline.scenes) {
    for (let from = 0; from < scene.frames; from += jobFrames) {
      const to = Math.min(scene.frames, from + jobFrames);
      const file = path.join(workDir, `seg-${String(scene.index).padStart(3, '0')}-${String(from).padStart(5, '0')}.ts`);
      jobs.push({ scene, from, to, file });
    }
  }

  const payloads = new Map(
    timeline.scenes.map((scene) => [scene.index, scenePayload(scene, timeline, { format, brand, fontCss, showCaptions })]),
  );
  const workerCount = Math.max(1, Math.min(jobs.length, os.availableParallelism(), Number(process.env.VIDGEN_WORKERS) || 6));
  const queue = [...jobs];
  let framesDone = 0;

  async function worker() {
    // One browser process per worker: separate processes are what make capture scale across cores.
    const { browser, frameControl } = await launchBrowser({ frameControl: true });
    const capture = async (cdp) => {
      if (!frameControl) {
        return (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true })).data;
      }
      const params = { screenshot: { format: 'jpeg', quality, optimizeForSpeed: true } };
      // A frame with no visible change can come back without image data; asking again returns it.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { screenshotData } = await cdp.send('HeadlessExperimental.beginFrame', params);
        if (screenshotData) return screenshotData;
      }
      return null;
    };
    try {
      const context = await browser.newContext({
        viewport: { width: format.width, height: format.height },
        deviceScaleFactor: 1,
      });
      await serveLocalFiles(context, allowed);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      const cdp = await context.newCDPSession(page);

      for (let job = queue.shift(); job; job = queue.shift()) {
        await page.goto(`${ORIGIN}/t/scene.html`);
        try {
          await page.evaluate((payload) => window.__mount(payload), payloads.get(job.scene.index));
        } catch (err) {
          throw new Error(`Scene ${job.scene.index + 1} failed to build: ${pageErrors.at(-1) ?? err.message}`);
        }

        const encoder = startSegmentEncoder(job.file, { fps, crf });
        let frame = null;
        let previous = -1;
        for (let f = job.from; f < job.to; f++) {
          const t = f / fps;
          const changed = await page.evaluate(([now, prev]) => window.__seek(now, prev), [t, previous]);
          if (changed || !frame) {
            const data = await capture(cdp);
            if (data) frame = Buffer.from(data, 'base64');
            else if (!frame) throw new Error(`Scene ${job.scene.index + 1}: the browser returned no image for a frame.`);
          }
          await encoder.write(frame);
          previous = t;
          onProgress?.(++framesDone, timeline.frames);
        }
        await encoder.finish();
      }
    } catch (err) {
      queue.length = 0; // stop the other workers instead of letting them render a video that will be discarded
      throw err;
    } finally {
      await browser.close();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return jobs.map((job) => job.file);
}
