import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './util.js';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_DIR = path.join(PKG_ROOT, 'templates');

export const FORMATS = {
  reel: { width: 1080, height: 1920, label: '9:16 — Reels, TikTok, Shorts, Stories' },
  square: { width: 1080, height: 1080, label: '1:1 — feed posts' },
  landscape: { width: 1920, height: 1080, label: '16:9 — YouTube, website, LinkedIn' },
};

/** Narration pace used to size scripts and to fake timings in --draft mode. */
export const WORDS_PER_SECOND = 2.6;

/** Seconds of picture before the voice starts in a scene, and after it ends. */
export const SCENE_LEAD = 0.25;
export const SCENE_TAIL = 0.2;
export const MIN_SCENE_SECONDS = 1.8;

const DEFAULT_BRAND = {
  name: 'Your Brand',
  url: '',
  handle: '',
  logo: '',
  tone: 'confident, clear and friendly',
  colors: {
    bg: '#0B1020',
    bg2: '#1A1F4B',
    text: '#FFFFFF',
    muted: '#AEB8D6',
    accent: '#7C5CFF',
    accent2: '#22D3EE',
  },
  fonts: { heading: 'Plus Jakarta Sans', body: 'Inter', files: [] },
  voice: { id: '', model: '', stability: 0.5, similarity: 0.75, style: 0, speed: 1 },
  captions: true,
  progressBar: true,
  ambientMotion: true,
};

/** Load .env from the working directory without overriding variables that are already set. */
export function loadEnv(cwd = process.cwd()) {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = value;
  }
}

/**
 * Brand settings: `--brand <file>`, else ./brand.json, else the brand.json shipped with the tool.
 * Paths inside the file (logo, font files) resolve relative to the file itself.
 */
export function loadBrand(explicitPath, cwd = process.cwd()) {
  const candidates = explicitPath
    ? [path.resolve(cwd, explicitPath)]
    : [path.join(cwd, 'brand.json'), path.join(PKG_ROOT, 'brand.json')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (explicitPath && !file) throw new UserError(`Brand file not found: ${explicitPath}`);

  let raw = {};
  if (file) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new UserError(`Could not read ${file}: ${err.message}`);
    }
  }
  const brand = {
    ...DEFAULT_BRAND,
    ...raw,
    colors: { ...DEFAULT_BRAND.colors, ...raw.colors },
    fonts: { ...DEFAULT_BRAND.fonts, ...raw.fonts },
    voice: { ...DEFAULT_BRAND.voice, ...raw.voice },
  };
  const base = file ? path.dirname(file) : cwd;
  if (brand.logo) {
    brand.logo = path.resolve(base, brand.logo);
    if (!fs.existsSync(brand.logo)) throw new UserError(`Brand logo not found: ${brand.logo}`);
  }
  brand.fonts.files = (brand.fonts.files ?? []).map((f) => ({ ...f, path: path.resolve(base, f.path) }));
  return brand;
}

export function resolveFormat(name = 'reel') {
  const format = FORMATS[name];
  if (!format) throw new UserError(`Unknown format "${name}". Use one of: ${Object.keys(FORMATS).join(', ')}.`);
  return { name, ...format };
}
