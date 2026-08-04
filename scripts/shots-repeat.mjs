#!/usr/bin/env node
/**
 * Capture the same canonical views repeatedly and report which ones came back
 * with a different hash.
 *
 *   npm run shots:repeat -- --repeat=2 cube-default cube-t0 chunks-wireframe
 *   npm run shots:repeat -- --repeat=3 --no-build road-bridge-wireframe
 *
 * THIS ASKS A QUESTION `shots:check` CANNOT. `shots:check` compares a view
 * against its committed baseline, so a view that is not reproducible AT ALL and
 * a view that legitimately changed are the same red line. This compares a view
 * against ITSELF, which is the only way to tell those apart -- and it is a
 * prerequisite for trusting a baseline, because committing one capture of an
 * unstable view bakes a coin flip into the repository.
 *
 * The whole sequence is captured inside ONE browser process, in order, which is
 * what `shots:check` does and is load-bearing. The Phase 5 wireframe instability
 * was invisible to a view captured on its own: `cube-wireframe` was byte-stable
 * over three fresh processes, and came back different on every run as soon as any
 * shaded view had been captured before it in the same process. A reproducibility
 * check that opened a new browser per view would have reported everything green.
 * See PROGRESS.md, Phase 6a.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeUrl, capture, launchBrowser } from './lib/browser.mjs';
import { buildProject, DIST_DIR, loadCanonical, SHOTS_DIR } from './lib/canonical.mjs';
import { startStaticServer } from './lib/static-server.mjs';

const args = process.argv.slice(2);
const repeat = Number(args.find((a) => a.startsWith('--repeat='))?.slice('--repeat='.length) ?? 2);
const names = args.filter((a) => !a.startsWith('--'));

if (!Number.isInteger(repeat) || repeat < 2) {
  console.error('--repeat must be an integer of at least 2; one pass proves nothing');
  process.exit(2);
}

const config = loadCanonical();
const views = names.length > 0 ? names.map(findView) : config.views.map((v) => v.name);

function findView(name) {
  const view = config.views.find((v) => v.name === name);
  if (view === undefined) throw new Error(`no canonical view named ${JSON.stringify(name)}`);
  return name;
}

if (!args.includes('--no-build')) buildProject();

const OUT_DIR = join(SHOTS_DIR, '.repeat');
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const server = await startStaticServer(DIST_DIR);
const browser = await launchBrowser();
/** @type {Map<string, string[]>} */
const hashes = new Map();

try {
  for (let pass = 0; pass < repeat; pass++) {
    for (const [index, name] of views.entries()) {
      const view = config.views.find((v) => v.name === name);
      const url = canonicalizeUrl(server.url, view.params ?? '');
      const file = join(OUT_DIR, `pass${pass}-${String(index).padStart(2, '0')}-${name}.png`);
      await capture(browser, url, file, { viewport: config.viewport });
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
      console.log(`pass ${pass}  ${name.padEnd(30)} ${hash}`);
      const list = hashes.get(name) ?? [];
      list.push(hash);
      hashes.set(name, list);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log('');
let unstable = 0;
for (const [name, list] of hashes) {
  const distinct = new Set(list).size;
  if (distinct === 1) {
    console.log(`STABLE     ${name.padEnd(30)} ${list[0]}`);
    continue;
  }
  unstable++;
  console.error(`UNSTABLE   ${name.padEnd(30)} ${distinct} distinct hashes: ${list.join(' ')}`);
}

console.log('');
if (unstable > 0) {
  console.error(`${unstable} of ${hashes.size} views are not reproducible over ${repeat} passes.`);
  console.error('Their baselines are one capture of a coin flip. Fix the view before committing it.');
} else {
  console.log(`all ${hashes.size} views reproduced identically over ${repeat} passes`);
  rmSync(OUT_DIR, { recursive: true, force: true });
}

process.exit(unstable > 0 ? 1 : 0);
