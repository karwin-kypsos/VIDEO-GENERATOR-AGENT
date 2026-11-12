import fs from 'node:fs';
import path from 'node:path';
import { WORDS_PER_SECOND } from './config.js';
import { mediaDuration } from './ffmpeg.js';
import { UserError, mapLimit, sha256, sleep } from './util.js';

const API = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new UserError(
      'ELEVENLABS_API_KEY is not set. Add it to .env (see .env.example), or pass --draft to render a silent preview.',
    );
  }
  return key;
}

async function request(pathname, { method = 'GET', body, query } = {}) {
  const url = new URL(pathname, API);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const key = apiKey();

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < 3) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new UserError(`Could not reach ElevenLabs (${err.cause?.code ?? err.message}). Check your connection.`);
    }
    if (res.ok) return res.json();

    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text).detail;
      detail = typeof parsed === 'string' ? parsed : (parsed?.message ?? JSON.stringify(parsed));
    } catch {}

    // 429 covers both rate limits and "too many concurrent requests"; both clear on their own.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) {
      // ElevenLabs uses 401 for a bad key and also for an exhausted character quota.
      throw new UserError(`ElevenLabs rejected the request (401): ${detail}`);
    }
    throw new UserError(`ElevenLabs error ${res.status}: ${detail}`);
  }
}

/** Voices available on the account, optionally filtered by a search term. */
export async function listVoices(search) {
  const voices = [];
  let pageToken;
  do {
    const page = await request('/v2/voices', { query: { page_size: 100, search, next_page_token: pageToken } });
    voices.push(...(page.voices ?? []));
    pageToken = page.has_more ? page.next_page_token : undefined;
  } while (pageToken && voices.length < 500);
  return voices.map((v) => ({
    id: v.voice_id,
    name: v.name ?? '',
    category: v.category ?? '',
    labels: v.labels ?? {},
    previewUrl: v.preview_url ?? '',
  }));
}

/** Accept a voice ID, a voice name, or nothing (first voice on the account). */
export async function resolveVoice(wanted) {
  if (wanted && /^[A-Za-z0-9]{20}$/.test(wanted)) return { id: wanted, name: wanted };
  const voices = await listVoices(wanted || undefined);
  if (!voices.length) {
    throw new UserError(
      wanted
        ? `No ElevenLabs voice matches "${wanted}". Run \`vidgen voices\` to see what is available.`
        : 'Your ElevenLabs account has no voices. Add one in the ElevenLabs voice library first.',
    );
  }
  if (!wanted) return voices[0];
  const exact = voices.find((v) => v.name.toLowerCase() === wanted.toLowerCase());
  const prefix = voices.find((v) => v.name.toLowerCase().startsWith(wanted.toLowerCase()));
  return exact ?? prefix ?? voices[0];
}

/** Turn ElevenLabs' per-character timings into per-word timings. */
export function wordsFromAlignment(alignment) {
  const chars = alignment?.characters ?? [];
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  const words = [];
  let current = null;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (current) words.push(current);
      current = null;
    } else if (current) {
      current.text += chars[i];
      current.end = ends[i];
    } else {
      current = { text: chars[i], start: starts[i], end: ends[i] };
    }
  }
  if (current) words.push(current);
  return words;
}

/** Evenly paced word timings, weighted by word length. Used for drafts and as a fallback. */
export function estimateWords(text, duration) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const total = duration ?? tokens.length / WORDS_PER_SECOND;
  const weights = tokens.map((t) => t.length + 2 + (/[.!?,;:]$/.test(t) ? 3 : 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return tokens.map((text, i) => {
    const span = (weights[i] / sum) * total;
    const word = { text, start: t, end: t + span * 0.9 };
    t += span;
    return word;
  });
}

function supportsStitching(model) {
  // previous_text / next_text keep prosody continuous across separately generated scenes.
  // Documented for the v2 family; left off for other models rather than risk a rejected request.
  return /_v2(_|$)/.test(model);
}

/**
 * Synthesize one scene's narration. Returns { file, duration, words } where `words` carry timings
 * relative to the start of the clip. Results are cached on disk by content, so re-rendering after a
 * visual tweak — or after editing a single scene — never pays for the same audio twice.
 */
async function synthesizeOne({ text, previousText, nextText, voiceId, model, settings, language, cacheDir }) {
  const body = {
    text,
    model_id: model,
    voice_settings: {
      stability: settings.stability,
      similarity_boost: settings.similarity,
      style: settings.style,
      speed: settings.speed,
      use_speaker_boost: true,
    },
  };
  if (language && !/multilingual_v2/.test(model)) body.language_code = language;
  if (supportsStitching(model)) {
    if (previousText) body.previous_text = previousText;
    if (nextText) body.next_text = nextText;
  }

  const key = sha256(voiceId, OUTPUT_FORMAT, body);
  const audioFile = path.join(cacheDir, `${key}.mp3`);
  const metaFile = path.join(cacheDir, `${key}.json`);
  if (fs.existsSync(audioFile) && fs.existsSync(metaFile)) {
    return { ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), file: audioFile, cached: true };
  }

  const res = await request(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, {
    method: 'POST',
    query: { output_format: OUTPUT_FORMAT },
    body,
  });
  if (!res.audio_base64) throw new UserError('ElevenLabs returned no audio for a scene.');
  fs.writeFileSync(audioFile, Buffer.from(res.audio_base64, 'base64'));

  const duration = await mediaDuration(audioFile);
  let words = wordsFromAlignment(res.alignment ?? res.normalized_alignment);
  if (!words.length) words = estimateWords(text, duration);
  const meta = { duration, words };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  return { ...meta, file: audioFile, cached: false };
}

/**
 * Voice every scene that has narration.
 * @returns {Promise<({file: string|null, duration: number, words: object[]}|null)[]>} one entry per scene
 */
export async function synthesizeScenes(scenes, { voice, brandVoice, language, cacheDir, draft, onProgress }) {
  if (draft) {
    return scenes.map((scene) => {
      if (!scene.narration) return null;
      const words = estimateWords(scene.narration);
      return { file: null, duration: words.at(-1).end + 0.1, words, cached: false };
    });
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const model = process.env.ELEVENLABS_MODEL || brandVoice.model || DEFAULT_MODEL;
  const concurrency = Number(process.env.ELEVENLABS_CONCURRENCY) || 2;
  let done = 0;
  return mapLimit(scenes, concurrency, async (scene, i) => {
    if (!scene.narration) return null;
    const clip = await synthesizeOne({
      text: scene.narration,
      previousText: scenes[i - 1]?.narration,
      nextText: scenes[i + 1]?.narration,
      voiceId: voice.id,
      model,
      settings: brandVoice,
      language,
      cacheDir,
    });
    onProgress?.(++done, scenes.length);
    return clip;
  });
}
