import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './util.js';

export const SCENE_TYPES = ['title', 'screen', 'bullets', 'stat', 'quote', 'cta'];
export const FRAMES = ['auto', 'phone', 'browser', 'none'];
export const MOTIONS = ['auto', 'zoom-in', 'zoom-out', 'pan-down', 'static'];

const text = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const percent = (v) => (typeof v === 'number' && v >= 0 && v <= 100 ? v : null);

/**
 * Bring a storyboard — written by the planner or by hand — into the one shape the renderer expects,
 * and report every problem at once so a hand-edited file can be fixed in a single pass.
 *
 * @param {object} raw parsed storyboard JSON
 * @param {string} baseDir directory that relative image paths resolve against
 */
export function normalizeStoryboard(raw, baseDir) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new UserError('The storyboard needs a "scenes" array with at least one scene.');
  }

  const scenes = raw.scenes.map((input, i) => {
    const n = `Scene ${i + 1}`;
    const scene = {
      type: text(input.type),
      narration: text(input.narration),
      kicker: text(input.kicker),
      headline: text(input.headline),
      subhead: text(input.subhead),
      items: (Array.isArray(input.items) ? input.items : []).map(text).filter(Boolean).slice(0, 5),
      value: text(input.value),
      label: text(input.label),
      quote: text(input.quote),
      author: text(input.author),
      button: text(input.button),
      image: text(input.image),
      frame: FRAMES.includes(input.frame) ? input.frame : 'auto',
      motion: MOTIONS.includes(input.motion) ? input.motion : 'auto',
      focusX: percent(input.focusX),
      focusY: percent(input.focusY),
      highlight: input.highlight === true,
      duration: typeof input.duration === 'number' && input.duration > 0 ? input.duration : null,
    };

    if (!SCENE_TYPES.includes(scene.type)) {
      problems.push(`${n}: unknown type "${scene.type}". Use one of: ${SCENE_TYPES.join(', ')}.`);
      return scene;
    }
    if (scene.type === 'title' && !scene.headline) problems.push(`${n} (title): needs a "headline".`);
    if (scene.type === 'bullets' && !scene.items.length) problems.push(`${n} (bullets): needs "items".`);
    if (scene.type === 'stat' && !scene.value) problems.push(`${n} (stat): needs a "value".`);
    if (scene.type === 'quote' && !scene.quote) problems.push(`${n} (quote): needs a "quote".`);
    if (scene.type === 'cta' && !scene.headline) problems.push(`${n} (cta): needs a "headline".`);
    if (scene.type === 'screen') {
      if (!scene.image) problems.push(`${n} (screen): needs an "image".`);
      else {
        scene.image = path.resolve(baseDir, scene.image);
        if (!fs.existsSync(scene.image)) problems.push(`${n} (screen): image not found: ${scene.image}`);
      }
    } else {
      scene.image = '';
    }
    if (!scene.narration && !scene.duration) scene.duration = 3;
    return scene;
  });

  if (problems.length) throw new UserError(`The storyboard has problems:\n  - ${problems.join('\n  - ')}`);
  return { title: text(raw.title) || 'Untitled video', format: text(raw.format), scenes };
}

export function loadStoryboard(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new UserError(`Storyboard not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new UserError(`${file} is not valid JSON: ${err.message}`);
  }
  return normalizeStoryboard(raw, path.dirname(abs));
}

/** Write a storyboard back out with image paths relative to the file, dropping unused fields. */
export function saveStoryboard(storyboard, file) {
  const dir = path.dirname(path.resolve(file));
  const scenes = storyboard.scenes.map((scene) => {
    const out = {};
    for (const [key, value] of Object.entries(scene)) {
      if (value === '' || value === null || value === false) continue;
      if (Array.isArray(value) && !value.length) continue;
      if ((key === 'frame' || key === 'motion') && value === 'auto') continue;
      out[key] = key === 'image' ? path.relative(dir, value).split(path.sep).join('/') : value;
    }
    return out;
  });
  const doc = { title: storyboard.title, ...(storyboard.format ? { format: storyboard.format } : {}), scenes };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}
