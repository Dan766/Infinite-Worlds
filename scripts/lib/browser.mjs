/**
 * Shared browser plumbing for the screenshot and verification scripts.
 *
 * Two things here are load-bearing for the whole project's verification story:
 *
 *  1. The GPU backend is pinned to SwiftShader. Without that, a machine with a
 *     real GPU produces different pixels from a CI container and the committed
 *     baselines become worthless.
 *  2. Captures wait on `window.__worldReady`, never on a timer. A sleep-based
 *     harness starts producing flaky diffs the moment a phase adds async work,
 *     and by then nobody trusts the baselines any more.
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

/**
 * This container pre-installs Chromium and the installed Playwright may expect
 * a different build number, so point at the binary directly rather than letting
 * Playwright resolve it. Never run `playwright install` here.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

export const VIEWPORT = { width: 1280, height: 720 };

const LAUNCH_ARGS = [
  // Pin software rendering so screenshots are machine-independent.
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--hide-scrollbars',
  // Keep rendering at full speed even though the window is never focused.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

export async function launchBrowser() {
  const executablePath = process.env.CHROMIUM_PATH ?? PREINSTALLED_CHROMIUM;
  const options = { args: LAUNCH_ARGS };
  if (existsSync(executablePath)) options.executablePath = executablePath;
  return chromium.launch(options);
}

/**
 * Force the parameters that make a view reproducible.
 *
 * `hud=0` is the important one: the HUD shows fps and heap, which cannot match
 * between two runs, so a visible HUD makes byte-identical screenshots
 * impossible by construction.
 */
export function canonicalizeUrl(baseUrl, params = '') {
  const url = new URL(params, baseUrl);
  url.searchParams.set('hud', '0');
  url.searchParams.set('panel', '0');
  if (!url.searchParams.has('freeze')) url.searchParams.set('freeze', '1');
  return url.toString();
}

/**
 * Open a URL, wait until the app reports itself ready, and return the page plus
 * anything that went wrong while loading.
 */
export async function openPage(browser, url, { viewport = VIEWPORT, timeout = 30000 } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.url()} (HTTP ${response.status()})`);
  });

  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(() => window.__worldReady === true, undefined, { timeout });

  return { context, page, consoleErrors, failedRequests };
}

/**
 * Count distinct colours in a downsampled copy of the canvas.
 *
 * A byte-comparison harness has one dangerous failure mode: if the app renders
 * nothing, every screenshot is an identical flat rectangle and the comparison
 * passes while proving nothing at all. This gives the scripts a cheap way to
 * assert that a frame actually contains an image before trusting its hash.
 */
async function measureFrame(page) {
  return page.evaluate(() => {
    const source = document.querySelector('canvas');
    if (source === null) return { distinctColors: 0 };

    const width = 64;
    const height = 36;
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d');
    if (ctx === null) return { distinctColors: 0 };

    ctx.drawImage(source, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);

    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
      // Quantise to 5 bits per channel so antialiasing noise does not inflate
      // the count into looking like content.
      seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
    }
    return { distinctColors: seen.size };
  });
}

/** Capture a canonical screenshot to `outPath`. */
export async function capture(browser, url, outPath, options = {}) {
  const { context, page, consoleErrors, failedRequests } = await openPage(browser, url, options);
  try {
    await page.screenshot({ path: outPath, animations: 'disabled', caret: 'hide' });
    const { distinctColors } = await measureFrame(page);
    return { consoleErrors, failedRequests, distinctColors };
  } finally {
    await context.close();
  }
}
