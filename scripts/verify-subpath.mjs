#!/usr/bin/env node
/**
 * Verify that the production build runs from an arbitrary nested static path.
 *
 *   npm run verify:subpath
 *
 * This is what `base: './'` in vite.config.ts actually buys: the build works
 * from any static host at any path depth, not just a domain root. A build that
 * emits absolute `/assets/...` URLs passes every local test and then 404s the
 * moment it is deployed under a subdirectory, so this check is worth keeping
 * through every phase.
 *
 * Note: a literal `file://` open cannot work with this stack -- Chrome blocks
 * ES module scripts over `file://` for CORS reasons, and Phase 1's Web Workers
 * hit the same wall. Serving over HTTP from a nested path is the real property.
 */

import { buildProject, DIST_DIR } from './lib/canonical.mjs';
import { launchBrowser, openPage } from './lib/browser.mjs';
import { startStaticServer } from './lib/static-server.mjs';

const MOUNT_PATH = '/some/deeply/nested/deploy/path/';

buildProject();

const server = await startStaticServer(DIST_DIR, { mountPath: MOUNT_PATH });
const browser = await launchBrowser();
let exitCode = 0;

console.log(`\nserving dist/ at ${server.url}`);

try {
  const url = `${server.url}?seed=subpath&freeze=1&time=3`;
  const { context, page, consoleErrors, failedRequests } = await openPage(browser, url);

  const report = await page.evaluate(() => ({
    ready: window.__worldReady === true,
    canvasWidth: document.querySelector('canvas')?.width ?? 0,
    scriptSources: [...document.querySelectorAll('script[src]')].map((s) =>
      s.getAttribute('src'),
    ),
  }));

  await context.close();

  console.log(`  app ready:      ${report.ready}`);
  console.log(`  canvas width:   ${report.canvasWidth}`);
  console.log(`  script sources: ${report.scriptSources.join(', ')}`);

  const absoluteSources = report.scriptSources.filter((src) => src?.startsWith('/'));
  if (absoluteSources.length > 0) {
    console.error(`  script src is absolute, which breaks subpath deploys: ${absoluteSources.join(', ')}`);
    exitCode = 1;
  }

  for (const request of failedRequests) {
    console.error(`  failed request: ${request}`);
    exitCode = 1;
  }
  for (const error of consoleErrors) {
    console.error(`  console error: ${error}`);
    exitCode = 1;
  }

  if (!report.ready || report.canvasWidth === 0) {
    console.error('  app did not reach a rendered state');
    exitCode = 1;
  }
} catch (error) {
  console.error('  failed to load the build from a nested path');
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

console.log(exitCode === 0 ? '\nsubpath deploy OK\n' : '\nsubpath deploy FAILED\n');
process.exit(exitCode);
