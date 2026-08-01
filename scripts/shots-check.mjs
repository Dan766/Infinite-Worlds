#!/usr/bin/env node
/**
 * Re-capture the canonical viewpoints and byte-compare them against the
 * committed baselines in `shots/`.
 *
 *   npm run shots:check
 *
 * This is the Phase 0 acceptance criterion turned into a command, and the
 * reason every later phase is cheap to verify: if this exits 0, nothing about
 * what the world looks like has changed.
 *
 * Exits non-zero on any mismatch, leaving the fresh captures in `shots/.check/`
 * so the two can be opened side by side.
 */

import { existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  captureCanonicalViews,
  PROJECT_ROOT,
  reportPageProblems,
  sha256File,
  SHOTS_DIR,
} from './lib/canonical.mjs';

const CHECK_DIR = join(SHOTS_DIR, '.check');

rmSync(CHECK_DIR, { recursive: true, force: true });

const results = await captureCanonicalViews(CHECK_DIR);
const pageProblemsClean = reportPageProblems(results);

let mismatches = 0;
let missing = 0;

console.log('');
for (const result of results) {
  const baseline = join(SHOTS_DIR, `${result.name}.png`);

  if (!existsSync(baseline)) {
    console.error(`MISSING  ${result.name}  (no baseline; run \`npm run shots\`)`);
    missing++;
    continue;
  }

  const baselineHash = sha256File(baseline);
  const freshHash = sha256File(result.file);

  if (baselineHash === freshHash) {
    console.log(
      `OK       ${result.name}  ${baselineHash.slice(0, 12)}  ${result.distinctColors} colours`,
    );
    continue;
  }

  console.error(`CHANGED  ${result.name}`);
  console.error(`           baseline ${baselineHash.slice(0, 12)}  ${relative(PROJECT_ROOT, baseline)}`);
  console.error(`           captured ${freshHash.slice(0, 12)}  ${relative(PROJECT_ROOT, result.file)}`);
  mismatches++;
}

const failed = mismatches > 0 || missing > 0 || !pageProblemsClean;

console.log('');
if (mismatches > 0 || missing > 0) {
  console.error(
    `${mismatches} changed, ${missing} missing, ${results.length - mismatches - missing} identical`,
  );
  console.error('If the change was intended, re-run `npm run shots` and commit the new baselines.');
} else if (!pageProblemsClean) {
  console.error('all screenshots identical, but the page reported errors (see above)');
} else {
  console.log(`all ${results.length} canonical views are byte-identical to their baselines`);
  rmSync(CHECK_DIR, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
