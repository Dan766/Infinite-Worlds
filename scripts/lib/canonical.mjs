/**
 * Shared logic for the canonical screenshot runs: build, serve, capture every
 * view in `shots/canonical.json`.
 *
 * Both `npm run shots` (write baselines) and `npm run shots:check` (compare
 * against baselines) go through here, so there is no way for the two to drift
 * apart in how they capture.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeUrl,
  captureOnPage,
  launchBrowser,
  openCaptureSession,
  reseatAndCapture,
} from './browser.mjs';
import { startStaticServer } from './static-server.mjs';
import { clusterViews, filterViews, inPageCamera } from './shots-select.mjs';

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
 *
 * Callers may pass `{ build: false }` (`--no-build`) when `dist/` is already
 * current -- useful while iterating on the harness itself.
 *
 * `execSync` rather than `execFileSync`, and that is a portability fix rather
 * than a preference. `npm` is `npm.cmd` on Windows: `execFileSync('npm', ...)`
 * cannot resolve the extension (ENOENT), and since Node 20.12 it refuses to
 * spawn a `.cmd` at all without a shell (EINVAL, part of the fix for argument
 * injection on Windows). Either way the whole capture died before a single view
 * was taken, which is how `npm run shots` came to be unrunnable outside the dev
 * container. The command is a compile-time constant, so nothing a caller
 * controls reaches the interpreter.
 */
export function buildProject() {
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

/**
 * Capture every canonical view into `outDir`.
 *
 * One Chromium process, one browser context, one page. Views that share seed
 * and sim time (and other non-camera params) form a cluster: the first is a
 * `page.goto` + `__worldReady` wait; later ones call `App.seekCamera` and wait
 * on `worldSettled()` so the streamer cache survives. Clusters stay in
 * canonical order -- Phase 6a showed unordered capture flakes on wireframes.
 *
 * Pass `only: ['city-*']` (from `--only`) to capture a subset.
 *
 * @returns {Promise<Array<{ name: string, file: string, url: string, consoleErrors: string[], failedRequests: string[], distinctColors: number }>>}
 */
export async function captureCanonicalViews(outDir, { build = true, only = [] } = {}) {
  if (build) buildProject();
  mkdirSync(outDir, { recursive: true });

  const config = loadCanonical();
  const views = filterViews(config.views, only);
  const clusters = clusterViews(views);
  const onlyNote = only.length > 0 ? ` filtered by --only=${only.join(',')}` : '';
  console.log(
    `capturing ${views.length}/${config.views.length} views` +
      ` (${clusters.length} load clusters, single browser)${onlyNote}`,
  );

  const server = await startStaticServer(DIST_DIR);
  const browser = await launchBrowser();
  let session = await openCaptureSession(browser, { viewport: config.viewport });
  const results = [];

  async function replaceSession() {
    try {
      await session.context.close();
    } catch {
      // Context may already be dead after a renderer crash.
    }
    session = await openCaptureSession(browser, { viewport: config.viewport });
  }

  let viewIndex = 0;
  try {
    for (const cluster of clusters) {
      for (let j = 0; j < cluster.views.length; j++) {
        const view = cluster.views[j];
        const url = canonicalizeUrl(server.url, view.params ?? '');
        const file = join(outDir, `${view.name}.png`);
        const started = Date.now();
        const mode = j === 0 ? 'load' : 'seek';
        process.stdout.write(
          `${viewIndex + 1}/${views.length} ${view.name} [${mode}] ... `,
        );
        viewIndex += 1;
        try {
          let shot;
          try {
            if (j === 0) {
              shot = await captureOnPage(session, url, file);
            } else {
              shot = await reseatAndCapture(session, inPageCamera(view.params ?? ''), file);
            }
          } catch (error) {
            // SwiftShader sometimes kills the renderer after several navigations
            // on one page (seen on the first wireframe after shaded views). One
            // fresh context+retry keeps the reused-page fast path without failing
            // the whole run. Seek failures fall back to a full load.
            const message = error instanceof Error ? error.message : String(error);
            if (!/Target crashed|has been closed|crash|Timeout/i.test(message)) throw error;
            process.stdout.write(`retry after crash ... `);
            await replaceSession();
            shot = await captureOnPage(session, url, file);
          }
          console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
          results.push({
            name: view.name,
            file,
            url,
            consoleErrors: shot.consoleErrors,
            failedRequests: shot.failedRequests,
            distinctColors: shot.distinctColors,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s`);
          throw new Error(`${view.name}: ${message}`, { cause: error });
        }
      }
    }
  } finally {
    try {
      await session.context.close();
    } catch {
      // ignore
    }
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
