#!/usr/bin/env node
/**
 * Capture the canonical viewpoints into `shots/`, overwriting the baselines.
 *
 *   npm run shots
 *
 * Run this when a change is *supposed* to alter what the world looks like. To
 * check that nothing changed, use `npm run shots:check` instead -- it compares
 * against these baselines without touching them.
 */

import { captureCanonicalViews, reportPageProblems, SHOTS_DIR } from './lib/canonical.mjs';

const results = await captureCanonicalViews(SHOTS_DIR);

console.log(`\ncaptured ${results.length} canonical views into shots/`);
for (const result of results) {
  console.log(`  ${result.name}.png  (${result.distinctColors} distinct colours)`);
}

if (!reportPageProblems(results)) {
  console.error('\nsome views reported page errors -- baselines written anyway, but fix these');
  process.exit(1);
}

console.log('\nno console errors, no failed requests');
console.log('review the PNGs, then commit them so later phases diff against a known-good state');
