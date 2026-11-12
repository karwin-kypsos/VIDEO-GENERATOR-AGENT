import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './util.js';

const BASE_ARGS = ['--force-color-profile=srgb', '--font-render-hinting=none'];

// With these flags Chromium draws a frame only when asked to, which makes stepping through a scene
// noticeably faster. Only the "headless shell" build supports it, so support is probed at launch.
const BEGIN_FRAME_ARGS = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
];

/** Chromium builds that an earlier Playwright install left on this machine, whatever their revision. */
function findInstalledChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter(Boolean);
  const fullBuilds = [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
  ];
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => /^chromium_headless_shell-\d+$/.test(name))) {
      for (const sub of fs.readdirSync(path.join(root, entry)).filter((name) => name.startsWith('chrome-headless-shell-'))) {
        for (const exe of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
          const candidate = path.join(root, entry, sub, exe);
          if (fs.existsSync(candidate)) found.unshift(candidate); // prefer the headless shell
        }
      }
    }
    for (const entry of entries.filter((name) => /^chromium-\d+$/.test(name))) {
      for (const parts of fullBuilds) {
        const candidate = path.join(root, entry, ...parts);
        if (fs.existsSync(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

async function supportsBeginFrame(browser) {
  const probe = async () => {
    const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send('HeadlessExperimental.beginFrame', { screenshot: { format: 'jpeg', quality: 50 } });
    await context.close();
    return Boolean(result.screenshotData);
  };
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
  return Promise.race([probe().catch(() => false), timeout]);
}

// Working out which browser to use (and whether it can draw frames on demand) happens once;
// every launch after that, including parallel ones, reuses the answer.
let resolving = null;

async function resolveTarget(chromium, launch) {
  const targets = process.env.CHROMIUM_PATH
    ? [{ executablePath: process.env.CHROMIUM_PATH }]
    : [{}, { channel: 'chrome' }, ...findInstalledChromium().map((executablePath) => ({ executablePath }))];

  for (const target of targets) {
    let browser;
    try {
      browser = await launch(target, true);
    } catch {
      continue; // not launchable this way; try the next one
    }
    const frameControl = await supportsBeginFrame(browser);
    await browser.close().catch(() => {});
    return { target, frameControl };
  }
  throw new UserError(
    process.env.CHROMIUM_PATH
      ? `Could not start the browser at CHROMIUM_PATH (${process.env.CHROMIUM_PATH}).`
      : 'No browser available for rendering. Run `npx playwright install chromium` once, ' +
          'or set CHROMIUM_PATH in .env to an existing Chrome/Chromium executable.',
  );
}

/**
 * Start headless Chromium. Looks, in order, at CHROMIUM_PATH, Playwright's own browser, an
 * installed Google Chrome, then any Chromium a previous Playwright install left on this machine.
 *
 * @param {{frameControl?: boolean}} [options] ask for on-demand frame drawing (used by the renderer)
 * @returns {Promise<{browser: import('playwright').Browser, frameControl: boolean}>}
 */
export async function launchBrowser({ frameControl = false } = {}) {
  const { chromium } = await import('playwright');
  const launch = (target, fast) => chromium.launch({ ...target, args: fast ? [...BASE_ARGS, ...BEGIN_FRAME_ARGS] : BASE_ARGS });

  resolving ??= resolveTarget(chromium, launch);
  const resolved = await resolving;
  const fast = frameControl && resolved.frameControl;
  return { browser: await launch(resolved.target, fast), frameControl: fast };
}
