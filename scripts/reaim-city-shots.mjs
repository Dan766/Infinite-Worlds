#!/usr/bin/env node
/**
 * One-time re-aim of the 26 `city-*` canonical views after Phase Politics S1
 * moved every city on every seed (cities now come from `polity.ts`'s own
 * 8192 m lattice instead of a rarity roll on the old 512 m one).
 *
 * RIGID TRANSLATION, not a fresh design pass: each view keeps the exact same
 * relative camera geometry (offset and `look`) it always had to its anchor
 * (the city centre, a specific landmark, or a specific gate) -- only the
 * anchor's world position changes. The five per-landmark deltas below were
 * derived once by reading the new default-seed city's real `CityPlan` (via a
 * throwaway vitest probe -- `polity.ts`/`city.ts` are pure and Node-testable,
 * so no browser was needed to locate it) and comparing each landmark's exact
 * position to the OLD topdown view's `pos` for the same landmark kind (a
 * topdown view looks straight down, `look=0,-90`, so its `pos.x/z` is the
 * closest thing the old baselines have to a recorded landmark coordinate).
 *
 * Recorded for PROGRESS.md: new city centre (59127.0, -101255.3), wall
 * radius 556.0 m, farm radius 895.0 m, 3 gates.
 *
 * This is a MECHANICAL re-aim, not a substitute for the eye review
 * `docs/settlement-visual-acceptance.md` requires before calling any of this
 * epic's slices done -- see PROGRESS.md's Phase S entry.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../shots/canonical.json', import.meta.url);
const data = JSON.parse(readFileSync(path, 'utf8'));

// old topdown pos -> new landmark pos, both [x, z]. See the header.
const DELTAS = {
  center: { dx: 91739.01, dz: -72775.3 }, // old (-32612, -28480) -> new (59127.01, -101255.3)
  keep: { dx: 91741.49, dz: -72775.3 }, // old (-32570, -28480) -> new (59171.49, -101255.3)
  cathedral: { dx: 91731.19, dz: -72777.75 }, // old (-32766, -28518) -> new (58965.19, -101295.75)
  townhall: { dx: 91734.32, dz: -72768.26 }, // old (-32706, -28339) -> new (59028.32, -101107.26)
  guildhall: { dx: 91739.01, dz: -72786.7 }, // old (-32612, -28691) -> new (59127.01, -101477.7)
  gatehouse: { dx: 91637.16, dz: -72480.9 }, // old (-32074, -28416) -> new (59563.16, -100896.9), the gate nearest due east of centre
};

/** Which delta a view name uses. Longest/most specific prefix wins. */
function deltaFor(name) {
  if (name.startsWith('city-keep')) return DELTAS.keep;
  if (name.startsWith('city-cathedral')) return DELTAS.cathedral;
  if (name.startsWith('city-townhall')) return DELTAS.townhall;
  if (name.startsWith('city-guildhall')) return DELTAS.guildhall;
  if (name.startsWith('city-gatehouse') || name.startsWith('city-gate-approach')) {
    return DELTAS.gatehouse;
  }
  if (name.startsWith('city-aerial') || name.startsWith('city-market') || name.startsWith('city-farmland')) {
    return DELTAS.center;
  }
  return undefined;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

let changed = 0;
for (const view of data.views) {
  const delta = deltaFor(view.name);
  if (delta === undefined) continue;
  // Plain string substitution on the `pos=` segment only, rather than a
  // round trip through `URLSearchParams` -- which percent-encodes the comma
  // (`,` -> `%2C`) and would make every re-aimed line an encoding-only diff
  // against the rest of this hand-authored file's unencoded `pos=x,y,z`
  // style. Functionally identical either way (`parseParams` decodes both),
  // this just keeps the diff about the numbers that actually changed.
  const match = view.params.match(/pos=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/);
  if (match === null) continue;
  const [full, xs, ys, zs] = match;
  const newX = round(Number(xs) + delta.dx);
  const newZ = round(Number(zs) + delta.dz);
  view.params = view.params.replace(full, `pos=${newX},${ys},${newZ}`);
  changed++;
  console.log(`${view.name}: pos=${xs},${ys},${zs} -> pos=${newX},${ys},${newZ}`);
}

writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
console.log(`\n${changed} view(s) re-aimed. Baselines NOT regenerated -- run`);
console.log('  npm run shots -- --only=city-*');
console.log('and review the results before committing.');
