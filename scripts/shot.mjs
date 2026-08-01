#!/usr/bin/env node
/**
 * Capture one screenshot of an arbitrary URL.
 *
 *   npm run shot -- <url> <name> [--raw]
 *
 * Writes `shots/<name>.png`. Works against a dev server, a preview server, or
 * anything else reachable; the URL is canonicalised first so the HUD and debug
 * panel are hidden and the simulation is frozen.
 *
 * `--raw` skips that canonicalisation, keeping the URL exactly as given. Use it
 * to capture the HUD or debug panel while diagnosing something -- such a shot
 * is not reproducible (fps and heap vary run to run), so never use it for a
 * baseline.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeUrl, capture, launchBrowser, VIEWPORT } from './lib/browser.mjs';
import { SHOTS_DIR } from './lib/canonical.mjs';

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const [rawUrl, name] = args.filter((arg) => arg !== '--raw');

if (rawUrl === undefined || name === undefined) {
  console.error('usage: npm run shot -- <url> <name> [--raw]');
  console.error('example: npm run shot -- "http://localhost:5173/?seed=alpha&time=3" alpha');
  process.exit(2);
}

const url = raw ? rawUrl : canonicalizeUrl(rawUrl);
const outPath = join(SHOTS_DIR, `${name}.png`);
mkdirSync(SHOTS_DIR, { recursive: true });

const browser = await launchBrowser();
let exitCode = 0;
try {
  const { consoleErrors, failedRequests } = await capture(browser, url, outPath, {
    viewport: VIEWPORT,
  });
  console.log(`captured ${outPath}`);
  console.log(`  from ${url}`);
  for (const error of consoleErrors) {
    console.error(`  console error: ${error}`);
    exitCode = 1;
  }
  for (const request of failedRequests) {
    console.error(`  failed request: ${request}`);
    exitCode = 1;
  }
} catch (error) {
  console.error(`failed to capture ${url}`);
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await browser.close();
}

process.exit(exitCode);
