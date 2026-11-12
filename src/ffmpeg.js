import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './util.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Run ffmpeg to completion. Resolves with stderr (where ffmpeg writes its report). */
export function ffmpeg(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => reject(missingFfmpeg(err)));
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.split('\n').slice(-12).join('\n')}`));
    });
  });
}

function missingFfmpeg(err) {
  if (err.code !== 'ENOENT') return err;
  return new UserError(
    'ffmpeg was not found. Install it (macOS: `brew install ffmpeg`, Windows: `winget install ffmpeg`, ' +
      'Linux: `apt install ffmpeg`) or set FFMPEG_PATH in .env.',
  );
}

export async function assertFfmpeg() {
  await ffmpeg(['-version']);
}

/** Duration of a media file in seconds, read from ffmpeg's own header dump (no ffprobe needed). */
export async function mediaDuration(file) {
  const report = await ffmpeg(['-i', file], { allowFailure: true });
  const m = report.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`Could not read the duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Start an encoder that takes JPEG frames on stdin and writes one H.264 MPEG-TS segment.
 * Segments made with identical settings concatenate without re-encoding.
 */
export function startSegmentEncoder(outFile, { fps, crf = 18, preset = 'veryfast' }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    // Chrome's JPEGs are full-range BT.601; video players expect limited-range BT.709.
    '-vf', 'scale=in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(fps), '-g', String(fps * 2), '-bf', '0',
    '-f', 'mpegts', outFile,
  ];
  const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let failure = null;
  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (err) => (failure = missingFfmpeg(err)));
  child.stdin.on('error', (err) => (failure ??= err));
  const closed = new Promise((resolve) => child.on('close', resolve));

  return {
    /** Write one frame, honouring backpressure so frames never pile up in memory. */
    async write(buffer) {
      if (failure) throw failure;
      if (!child.stdin.write(buffer)) await new Promise((r) => child.stdin.once('drain', r));
    },
    async finish() {
      child.stdin.end();
      const code = await closed;
      if (failure) throw failure;
      if (code !== 0) throw new Error(`ffmpeg (segment encoder) exited with code ${code}:\n${stderr.slice(-2000)}`);
    },
  };
}

/**
 * Lay each scene's voice clip at its position on the timeline, optionally add music, and write one
 * AAC file exactly `total` seconds long.
 * @param {{file: string, at: number}[]} clips
 */
export async function buildAudioTrack(clips, total, outFile, { music, musicVolume = 0.12 } = {}) {
  const args = ['-y'];
  const filters = [];
  const voiceLabels = [];

  clips.forEach((clip, i) => {
    args.push('-i', clip.file);
    const ms = Math.round(clip.at * 1000);
    filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}:all=1[v${i}]`);
    voiceLabels.push(`[v${i}]`);
  });

  let voice = null;
  if (voiceLabels.length === 1) voice = voiceLabels[0];
  else if (voiceLabels.length > 1) {
    filters.push(`${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:normalize=0:dropout_transition=0[voice]`);
    voice = '[voice]';
  }

  let mixed = voice;
  if (music) {
    const idx = clips.length;
    args.push('-stream_loop', '-1', '-i', music);
    const fadeAt = Math.max(0, total - 1.5).toFixed(3);
    filters.push(
      `[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${musicVolume},` +
        `afade=t=in:d=0.6,afade=t=out:st=${fadeAt}:d=1.5[music]`,
    );
    if (voice) {
      filters.push(`${voice}[music]amix=inputs=2:normalize=0:dropout_transition=0[mix]`);
      mixed = '[mix]';
    } else mixed = '[music]';
  }

  if (!mixed) {
    // Nothing to play (draft mode with no music): a silent track keeps players and platforms happy.
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-t', total.toFixed(3), '-c:a', 'aac', '-b:a', '128k', outFile);
    return ffmpeg(args);
  }

  filters.push(`${mixed}apad,atrim=0:${total.toFixed(3)},alimiter=limit=0.95[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', outFile);
  return ffmpeg(args);
}

/** Join the video segments, attach the audio track, and write a web-ready MP4. */
export async function muxVideo(segments, audioFile, outFile) {
  const listFile = path.join(path.dirname(segments[0]), 'segments.txt');
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy',
    '-movflags', '+faststart', '-shortest', outFile,
  ]);
}

/** Grab one frame as a cover image. */
export async function extractFrame(videoFile, atSeconds, outFile) {
  await ffmpeg(['-y', '-ss', atSeconds.toFixed(3), '-i', videoFile, '-frames:v', '1', '-q:v', '2', outFile]);
}

/** Shrink an image to a size that is cheap to send to the script-writing model. */
export async function makePreview(imageFile, outFile, maxSide = 1400) {
  await ffmpeg([
    '-y', '-i', imageFile,
    '-vf', `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
    '-frames:v', '1', '-q:v', '4', outFile,
  ]);
}
