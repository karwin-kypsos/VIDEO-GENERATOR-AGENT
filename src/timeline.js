import { MIN_SCENE_SECONDS, SCENE_LEAD, SCENE_TAIL } from './config.js';
import { captionOptions, chunkWords } from './captions.js';

const normalize = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * When each bullet should appear (seconds into the scene): as the voice reaches it if the narration
 * mentions it, otherwise evenly spread across the narration.
 */
export function bulletTimes(items, words, lead, voiceDuration) {
  const spoken = words.map((w) => normalize(w.text));
  const times = [];
  let cursor = 0;
  items.forEach((item, i) => {
    const keys = item.split(/\s+/).map(normalize).filter((k) => k.length >= 4);
    let at = null;
    for (let j = cursor; j < spoken.length && at === null; j++) {
      if (keys.includes(spoken[j])) {
        at = lead + words[j].start - 0.15;
        cursor = j + 1;
      }
    }
    const even = lead + ((i + 0.35) / items.length) * voiceDuration * 0.85;
    times.push(at ?? even);
  });
  // The headline gets a beat to itself first, and bullets never arrive on top of each other.
  let floor = 0.55;
  return times.map((t) => {
    const at = Math.max(t, floor);
    floor = at + 0.35;
    return Number(at.toFixed(3));
  });
}

/**
 * Place scenes on a timeline. Each scene lasts as long as its narration plus a short lead-in and
 * tail, rounded up to whole frames so picture and sound can never drift apart.
 *
 * @param {object} storyboard normalized storyboard
 * @param {(object|null)[]} clips voice clip per scene ({file, duration, words}) or null
 */
export function buildTimeline(storyboard, clips, { fps, formatName, captions = true }) {
  let cursorFrames = 0;
  const scenes = storyboard.scenes.map((scene, index) => {
    const clip = clips[index];
    const lead = index === 0 ? 0.15 : SCENE_LEAD;
    const voiceDuration = clip?.duration ?? 0;
    const wanted = Math.max(
      MIN_SCENE_SECONDS,
      clip ? lead + voiceDuration + SCENE_TAIL : 0,
      scene.duration ?? 0,
    );
    const frames = Math.ceil(wanted * fps - 1e-6);
    const start = cursorFrames / fps;
    cursorFrames += frames;

    const words = clip?.words ?? [];
    const chunks = captions
      ? chunkWords(words, captionOptions(formatName)).map((chunk) => ({
          start: lead + chunk.start,
          hideAt: lead + chunk.hideAt,
          words: chunk.words.map((w) => ({ text: w.text, start: lead + w.start, until: lead + w.until })),
        }))
      : [];

    return {
      ...scene,
      index,
      frames,
      duration: frames / fps,
      start,
      lead,
      voiceAt: start + lead,
      voiceFile: clip?.file ?? null,
      words,
      captionChunks: chunks,
      itemTimes: scene.type === 'bullets' ? bulletTimes(scene.items, words, lead, voiceDuration || wanted * 0.7) : [],
    };
  });
  return { scenes, fps, frames: cursorFrames, total: cursorFrames / fps };
}
