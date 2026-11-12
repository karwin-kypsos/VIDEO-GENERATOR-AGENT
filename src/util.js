import { createHash } from 'node:crypto';

/** An error whose message is meant to be shown to the person running the CLI as-is. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

export function slugify(text, max = 48) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'video';
}

export function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p)).update('\0');
  return h.digest('hex');
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatSeconds(s) {
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Tiny step logger: `const done = step('Voice'); … done('6 clips')`. */
export function step(label) {
  const t0 = performance.now();
  process.stdout.write(`• ${label}…\n`);
  return (detail = '') => {
    const dt = (performance.now() - t0) / 1000;
    process.stdout.write(`✓ ${label}${detail ? ` — ${detail}` : ''} (${formatSeconds(dt)})\n`);
  };
}

export function progress(label) {
  const tty = process.stdout.isTTY;
  let lastPct = -1;
  return (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct === lastPct) return;
    if (tty) process.stdout.write(`\r  ${label} ${pct}%   `);
    else if (pct % 25 === 0) process.stdout.write(`  ${label} ${pct}%\n`);
    lastPct = pct;
    if (tty && done >= total) process.stdout.write('\r' + ' '.repeat(label.length + 12) + '\r');
  };
}
