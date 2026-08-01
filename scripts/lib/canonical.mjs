/**
 * Shared logic for the canonical screenshot runs: build, serve, capture every
 * view in `shots/canonical.json`.
 *
 * Both `npm run shots` (write baselines) and `npm run shots:check` (compare
 * against baselines) go through here, so there is no way for the two to drift
 * apart in how they capture.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeUrl, capture, launchBrowser } from './browser.mjs';
import { startStaticServer } from './static-server.mjs';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SHOTS_DIR = join(PROJECT_ROOT, 'shots');
export const DIST_DIR = join(PROJECT_ROOT, 'dist');

export function loadCanonical() {
  const config = JSON.parse(readFileSync(join(SHOTS_DIR, 'canonical.json'), 'utf8'));
  if (!Array.isArray(config.views) || config.views.length === 0) {
    throw new Error('shots/canonical.json contains no views');
  }
  return config;
}

/**
 * Always rebuild before capturing. A stale `dist/` producing green baselines is
 * the single most expensive failure mode this harness could have.
 */
export function buildProject() {
  execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

/**
 * Capture every canonical view into `outDir`.
 *
 * @returns {Promise<Array<{ name: string, file: string, url: string, consoleErrors: string[], failedRequests: string[] }>>}
 */
export async function captureCanonicalViews(outDir, { build = true } = {}) {
  if (build) buildProject();
  mkdirSync(outDir, { recursive: true });

  const config = loadCanonical();
  const server = await startStaticServer(DIST_DIR);
  const browser = await launchBrowser();
  const results = [];

  try {
    for (const view of config.views) {
      const url = canonicalizeUrl(server.url, view.params ?? '');
      const file = join(outDir, `${view.name}.png`);
      const { consoleErrors, failedRequests, distinctColors } = await capture(browser, url, file, {
        viewport: config.viewport,
      });
      results.push({ name: view.name, file, url, consoleErrors, failedRequests, distinctColors });
    }
  } finally {
    await browser.close();
    await server.close();
  }

  return results;
}

/**
 * Minimum distinct colours a real frame must contain.
 *
 * A frame showing only the clear colour measures 1. Deliberately loose, because
 * this exists to catch "nothing rendered at all", not to judge composition -- a
 * legitimately distant subject can measure as few as 6.
 */
const MIN_DISTINCT_COLORS = 4;

/**
 * Print any console errors or failed requests; return true if the run was clean.
 *
 * Also guards the two ways a screenshot harness can pass while being broken:
 * rendering nothing at all (every frame a flat rectangle), and every view
 * collapsing to the same image. Both would sail through a byte comparison.
 */
export function reportPageProblems(results) {
  let clean = true;

  for (const result of results) {
    for (const error of result.consoleErrors) {
      console.error(`  console error in ${result.name}: ${error}`);
      clean = false;
    }
    for (const request of result.failedRequests) {
      console.error(`  failed request in ${result.name}: ${request}`);
      clean = false;
    }
    if (result.distinctColors < MIN_DISTINCT_COLORS) {
      console.error(
        `  ${result.name} looks blank: only ${result.distinctColors} distinct colours. ` +
          'Nothing rendered, so its screenshot proves nothing.',
      );
      clean = false;
    }
  }

  // The canonical views are chosen to differ from one another. If they stop
  // differing, the capture is broken rather than the world being stable.
  const signatures = new Set(results.map((r) => sha256File(r.file)));
  if (results.length > 1 && signatures.size === 1) {
    console.error(
      `  all ${results.length} canonical views produced an identical image. ` +
        'They are meant to differ, so the capture is broken.',
    );
    clean = false;
  }

  return clean;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
