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

/**
 * @param {{ extraArgs?: string[] }} options extra Chromium flags. Used only by
 *   `npm run soak`, which needs precise heap reporting; screenshot runs must
 *   never pass anything here or baselines stop being comparable.
 */
export async function launchBrowser({ extraArgs = [] } = {}) {
  const executablePath = process.env.CHROMIUM_PATH ?? PREINSTALLED_CHROMIUM;
  const options = { args: [...LAUNCH_ARGS, ...extraArgs] };
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
 * How long a view gets to reach `window.__worldReady`.
 *
 * Raised from 30 s in Phase 3a. This is a wall-clock allowance for a software
 * rasteriser to stream ~300 nodes, not a correctness threshold: waiting on
 * readiness is what makes the byte comparison meaningful, so a generous limit
 * loosens nothing. Water pushed a coastal view's payload up by around 40% and
 * the third of three back-to-back `shots:check` runs timed out on a loaded
 * container -- a harness that goes red under load teaches people to re-run
 * until green, which is exactly the trust problem the byte comparison exists to
 * avoid.
 */
const READY_TIMEOUT_MS = 120000;

const SCREENSHOT_TIMEOUT_MS = 120000;

/**
 * Open a fresh context+page, navigate to `url`, wait until the app reports
 * itself ready, and return the page plus anything that went wrong while loading.
 *
 * Used by the soak and by one-off `capture()`. The canonical sequence uses
 * {@link openCaptureSession} + {@link captureOnPage} instead, so it does not
 * pay for a new context per view.
 */
export async function openPage(
  browser,
  url,
  { viewport = VIEWPORT, timeout = READY_TIMEOUT_MS, holdFlight = false } = {},
) {
  const session = await openCaptureSession(browser, { viewport, holdFlight });
  try {
    await navigateReady(session.page, url, timeout);
  } catch (error) {
    await session.context.close();
    throw error;
  }
  return session;
}

/**
 * Create one context+page with error collectors. Caller owns closing `context`.
 *
 * @param {import('playwright').Browser} browser
 */
export async function openCaptureSession(
  browser,
  { viewport = VIEWPORT, holdFlight = false } = {},
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  // HOLD THE AUTOPILOT UNTIL THE CALLER HAS TAKEN ITS BASELINE.
  //
  // Phase 4b stopped the flight advancing before `window.__worldReady`, which
  // fixed the 400-900 m of drift the soak's "at the start" claims used to suffer
  // from. It cannot fix the rest of the gap: readiness is observed by POLLING
  // from Node, and a main thread building a hundred meshes stalls for over a
  // second at a time under a software rasteriser, so the poll can land tens of
  // seconds late -- 1,296 m downrange on the run that exposed this, which put
  // the round-tripped square out over open sea and failed three checks that had
  // nothing wrong with them.
  //
  // The flag is opt-in and set BEFORE the document runs, so nothing but a
  // harness that asked for it is affected: `undefined !== false` releases the
  // flight, which is what a human opening a `?fly=` URL gets.
  if (holdFlight) {
    await context.addInitScript(() => {
      window.__flightReleased = false;
    });
  }
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

  return { context, page, consoleErrors, failedRequests };
}

async function navigateReady(page, url, timeout = READY_TIMEOUT_MS) {
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(() => window.__worldReady === true, undefined, { timeout });
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

/**
 * Navigate an existing page to `url`, wait for readiness, screenshot, measure.
 *
 * Clears the session's error collectors first so each view reports only its own
 * console/request problems.
 */
export async function captureOnPage(session, url, outPath, { timeout = READY_TIMEOUT_MS } = {}) {
  const { page, consoleErrors, failedRequests } = session;
  consoleErrors.length = 0;
  failedRequests.length = 0;

  await navigateReady(page, url, timeout);
  await page.screenshot({
    path: outPath,
    animations: 'disabled',
    caret: 'hide',
    // Forest nodes after Phase 7a can make SwiftShader take longer than the
    // Playwright default 30s to rasterise a 1280x720 frame.
    timeout: SCREENSHOT_TIMEOUT_MS,
  });
  const { distinctColors } = await measureFrame(page);
  return {
    consoleErrors: [...consoleErrors],
    failedRequests: [...failedRequests],
    distinctColors,
  };
}

/** Capture a single screenshot on a fresh context (one-off `shot`, `shots:repeat`). */
export async function capture(browser, url, outPath, options = {}) {
  const session = await openPage(browser, url, options);
  try {
    await session.page.screenshot({
      path: outPath,
      animations: 'disabled',
      caret: 'hide',
      timeout: SCREENSHOT_TIMEOUT_MS,
    });
    const { distinctColors } = await measureFrame(session.page);
    return {
      consoleErrors: [...session.consoleErrors],
      failedRequests: [...session.failedRequests],
      distinctColors,
    };
  } finally {
    await session.context.close();
  }
}
