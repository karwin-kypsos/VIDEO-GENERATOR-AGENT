import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { UserError } from './util.js';

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
};

/**
 * Screenshot a public web page so it can be used as the video's screens.
 * Takes one shot per screenful down the page (up to `maxShots`) plus one tall capture for scrolling.
 * Pages behind a login (most social profiles) cannot be captured this way — pass screenshots instead.
 *
 * @returns {Promise<{files: string[], site: {url: string, title: string, description: string, text: string}}>}
 */
export async function captureUrl(url, outDir, { device = 'desktop', maxShots = 5 } = {}) {
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new UserError(`Not a valid URL: ${url}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const { browser } = await launchBrowser();
  try {
    const context = await browser.newContext(DEVICES[device] ?? DEVICES.desktop);
    const page = await context.newPage();
    try {
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (err) {
      throw new UserError(`Could not open ${target.href}: ${err.message.split('\n')[0]}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Scroll through once so lazy-loaded sections and images are present, then return to the top.
    const viewportHeight = page.viewportSize().height;
    for (let i = 0; i < 12; i++) {
      const atEnd = await page.evaluate((step) => {
        window.scrollBy(0, step);
        return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      }, viewportHeight);
      await page.waitForTimeout(250);
      if (atEnd) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

    const site = await page.evaluate(() => ({
      title: document.title ?? '',
      description: document.querySelector('meta[name="description"], meta[property="og:description"]')?.content ?? '',
      text: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000),
      pageHeight: document.documentElement.scrollHeight,
    }));

    const files = [];
    const screens = Math.max(1, Math.min(maxShots, Math.ceil(site.pageHeight / viewportHeight)));
    const lastTop = Math.max(0, site.pageHeight - viewportHeight);
    for (let i = 0; i < screens; i++) {
      const top = screens === 1 ? 0 : Math.round((lastTop * i) / (screens - 1));
      await page.evaluate((y) => window.scrollTo(0, y), top);
      await page.waitForTimeout(350);
      const file = path.join(outDir, `site-${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: file });
      files.push(file);
    }

    // One tall capture for a scroll-through scene. Capped so the image stays a workable size.
    if (site.pageHeight > viewportHeight * 1.6) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      const file = path.join(outDir, 'site-scroll.png');
      const { width } = page.viewportSize();
      await page.screenshot({
        path: file,
        fullPage: true,
        clip: { x: 0, y: 0, width, height: Math.min(site.pageHeight, viewportHeight * 6) },
      });
      files.push(file);
    }

    delete site.pageHeight;
    return { files, site: { url: target.href, ...site } };
  } finally {
    await browser.close();
  }
}
