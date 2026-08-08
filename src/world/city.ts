/**
 * Medieval cities: Region-tier CityPlan.
 *
 * Phase City C0-C2, reshaped in Phase Politics C1. A rare Settlement class
 * owns a plan that spans multiple sectors: walls, gates, districts, arteries,
 * landmarks and a farmland belt. Villages keep the Sector-tier street
 * generators; cities do not invent themselves at the Sector tier -- they only
 * CLIP this plan.
 *
 * Determinism: every quantity is hash3i/hashUnit of (worldSeed, cell, index).
 * Wall rings use ringDirection (piecewise unit octagon) -- no sin/cos on the
 * path to a stored vertex.
 *
 * ---------------------------------------------------------------------------
 * ARCHETYPES AND THE ORGANIC WALL (Phase Politics C1)
 *
 * Every city used to be the same 28-gon at `R * (0.92..1.04)` -- a near-perfect
 * circle whose only per-instance variety was its overall scale. This phase
 * replaces the wall's radius profile with one of `ARCHETYPE_COUNT` (from
 * `culture.ts`) hash-selected shape families, each built from the SAME hashed
 * "control radii around the ring, smoothly interpolated" primitive
 * (`organicUnit`) that every other city already needed for its silhouette to
 * stop reading as a circle -- an archetype only decides how that base organic
 * profile gets bent (toward a square for `ARCH_GRID`, elongated for
 * `ARCH_RIVERPORT`, tightened for `ARCH_HILL_CITADEL`, flattened on one side
 * for `ARCH_HARBOR`).
 *
 * DELIBERATELY NOT TERRAIN-FITTED YET. The stress-tested design this project
 * worked from called for marching each wall direction outward until it hit a
 * slope/river/sea threshold, which needs `baseHeight`/river-drop injected all
 * the way through `city.ts`'s ~7 call sites (`roads.ts`, `streets.ts`,
 * `lots.ts`, `wall-mesh.ts`, `road-mesh.ts`, `building-mesh.ts`,
 * `interior-overlay.ts`) and every one of their test files. That is a large,
 * separate blast radius from "cities look different from each other", so
 * this slice buys the archetype/silhouette variety WITHOUT it:
 * `generateCityPlan(site, worldSeed)`'s signature is completely unchanged,
 * and every existing caller needed zero edits. Terrain-fitting the wall is
 * left as a clearly-scoped future slice -- see PROGRESS.md.
 *
 * SAFETY MARGIN. District placement reaches at most `0.90 * R` from centre --
 * true before this slice and kept true by construction after it (Phase
 * Politics C4 changes WHERE around the ring each district sits per
 * archetype, never `distFrac`/`radFrac`, i.e. never how far out or how big).
 * Every archetype's wall radius factor is clamped to `[0.95, 1.5]` before it
 * multiplies `R`, so the wall never dips inside that reach: `city.test.ts`
 * asserts every district and landmark stays strictly inside the generated
 * wall polygon, on every archetype, rather than trusting the arithmetic.
 *
 * ---------------------------------------------------------------------------
 * DISTRICT ARRANGEMENT PER ARCHETYPE (Phase Politics C4)
 *
 * The same 7 districts in the same fixed order (keep, market, civic,
 * religious, guild, two residential) -- landmark placement still indexes
 * `dX[0]`, `dX[1]` etc. by that order, so the COUNT and ORDER never change,
 * only each one's bearing. `ARCH_GRID` spreads them at quadrant angles
 * aligned to the grid's own bearing; `ARCH_RIVERPORT` clusters them along the
 * wall's elongation axis (`cityAxisBearing`), reading as a linear waterfront
 * town; `ARCH_HARBOR` pulls the keep to the side AWAY from the flattened
 * (waterfront) edge for defensibility while clustering market/guild toward
 * it; `ARCH_RADIAL`/`ARCH_HILL_CITADEL` keep the original ring arrangement --
 * a citadel's compactness already comes from its tighter street rings
 * (Phase Politics C2), not a different district layout.
 */

import { hash3i } from '../core/hash';
import { hashUnit, smoothstep } from './noise';
import {
  ARCH_GRID,
  ARCH_HARBOR,
  ARCH_HILL_CITADEL,
  ARCH_RADIAL,
  ARCH_RIVERPORT,
  ARCHETYPE_COUNT,
} from './culture';
import type { Settlement } from './roads';

/**
 * Piecewise unit direction on a diamond/octagon ring. Same contract as
 * `streets.ringDirection` -- inlined so `city.ts` does not import `streets.ts`
 * (sectors import city to clip plans).
 */
function ringDirection(t: number, out: Float64Array): void {
  const wrapped = t - Math.floor(t);
  const s = wrapped * 4;
  const q = Math.floor(s);
  const f = s - q;
  let u: number;
  let v: number;
  if (q <= 0) {
    u = 1 - f;
    v = f;
  } else if (q === 1) {
    u = -f;
    v = 1 - f;
  } else if (q === 2) {
    u = f - 1;
    v = -f;
  } else {
    u = f;
    v = f - 1;
  }
  const inverse = 1 / Math.sqrt(u * u + v * v);
  out[0] = u * inverse;
  out[1] = v * inverse;
}

export const CITY_WALL_SEGMENTS = 28;
export const CITY_GATE_MIN = 3;
export const CITY_GATE_MAX = 5;

export const DISTRICT_KEEP = 0;
export const DISTRICT_MARKET = 1;
export const DISTRICT_GUILD = 2;
export const DISTRICT_CIVIC = 3;
export const DISTRICT_RELIGIOUS = 4;
export const DISTRICT_RESIDENTIAL = 5;

export const LANDMARK_KEEP = 0;
export const LANDMARK_CATHEDRAL = 1;
export const LANDMARK_TOWNHALL = 2;
export const LANDMARK_MARKET = 3;
export const LANDMARK_GUILD = 4;
export const LANDMARK_GATEHOUSE = 5;

const PLAN_SALT = 0x4349_5479;
const GATE_SALT = 0x4741_5465;
const DIST_SALT = 0x4453_5474;
const ARTERY_SALT = 0x4152_5479;
const BLOCK_SALT = 0x424c_4b73;
const FARM_SALT = 0x4641_526d;
const ARCH_SALT = 0x41726368;
const WALL_SHAPE_SALT = 0x53686170;

/**
 * Control radii spaced around the ring, smoothly interpolated between, so the
 * wall reads as organic rather than a jittered circle. 8 is enough bumps to
 * be visible at city scale without the interpolation itself creasing.
 */
const WALL_CONTROL_POINTS = 8;

/** Which `ARCH_*` (from `culture.ts`) this city belongs to. Hash-picked per cell -- see the module header. */
export function pickArchetype(cellX: number, cellZ: number, worldSeed: number): number {
  return (hash3i(cellX, cellZ, 0, (worldSeed ^ ARCH_SALT) >>> 0) >>> 0) % ARCHETYPE_COUNT;
}

/**
 * The one hash-chosen bearing (a `ringDirection` `t` parameter) every
 * elongated/asymmetric archetype orients around -- the wall's stretch axis
 * (`ARCH_RIVERPORT`) or flattened side (`ARCH_HARBOR`), the street spine or
 * fan direction, and (Phase Politics C4) the district arrangement. One shared
 * function rather than the same `unitAt(..., 99, ..., WALL_SHAPE_SALT)`
 * expression repeated at each call site, so the wall, the streets and the
 * districts of one riverport city are guaranteed to agree about which way
 * "along the river" points.
 */
function cityAxisBearing(cellX: number, cellZ: number, worldSeed: number): number {
  return unitAt(cellX, cellZ, 99, worldSeed, WALL_SHAPE_SALT);
}

/**
 * The base organic radius shape, in [0, 1), BEFORE any archetype bends it.
 * `t` is the same ring parameter `ringDirection` takes. Exported so
 * `city.test.ts` can assert its own shape claims (smoothness, range)
 * directly, the way `roads.ts` exports `settlementScore` for the same reason.
 */
export function organicUnit(cellX: number, cellZ: number, worldSeed: number, t: number): number {
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * WALL_CONTROL_POINTS;
  const i0 = Math.floor(scaled) % WALL_CONTROL_POINTS;
  const i1 = (i0 + 1) % WALL_CONTROL_POINTS;
  const frac = scaled - Math.floor(scaled);
  const smooth = frac * frac * (3 - 2 * frac);
  const r0 = unitAt(cellX, cellZ, i0, worldSeed, WALL_SHAPE_SALT);
  const r1 = unitAt(cellX, cellZ, i1, worldSeed, WALL_SHAPE_SALT);
  return lerp(r0, r1, smooth);
}

/**
 * The wall radius factor at ring parameter `t`, direction `(dirX, dirZ)` (a
 * unit vector from `ringDirection(t)`), for one archetype. Multiplies
 * `site.wallRadius`. Clamped to `[0.95, 1.5]` -- see the module header's
 * safety-margin note; every branch stays inside that range by construction,
 * the clamp is the guarantee, not a correction for a bug.
 */
function archetypeRadiusFactor(
  archetype: number,
  cellX: number,
  cellZ: number,
  worldSeed: number,
  t: number,
  dirX: number,
  dirZ: number,
): number {
  const organic = lerp(0.9, 1.15, organicUnit(cellX, cellZ, worldSeed, t));
  let factor: number;
  if (archetype === ARCH_RADIAL) {
    factor = organic;
  } else if (archetype === ARCH_GRID) {
    // Blend toward the inscribed square (Chebyshev distance): a point on a
    // square of half-width W at direction (dirX, dirZ) sits at distance
    // W / max(|dirX|, |dirZ|) -- 1 at the flat sides, up to sqrt(2) at a
    // corner -- which is exactly what makes a grid-planned city read as
    // boxy rather than circular.
    const cheby = 1 / Math.max(Math.abs(dirX), Math.abs(dirZ));
    factor = lerp(organic, organic * cheby, 0.5);
  } else if (archetype === ARCH_RIVERPORT) {
    // Elongated along one hash-chosen bearing per city -- a river-port reads
    // as a long waterfront rather than a compact ring.
    const bearingT = cityAxisBearing(cellX, cellZ, worldSeed);
    const bearing = new Float64Array(2);
    ringDirection(bearingT, bearing);
    const dot = dirX * (bearing[0] as number) + dirZ * (bearing[1] as number);
    factor = organic * (1 + 0.25 * dot * dot);
  } else if (archetype === ARCH_HILL_CITADEL) {
    // Compact and slightly more irregular -- a citadel hugging a summit
    // reads as tighter than a lowland city of the same wall-radius budget.
    factor = organic * 0.94;
  } else if (archetype === ARCH_HARBOR) {
    // Flattened along one hash-chosen bearing -- a harbour reads as a
    // straight quay front rather than a curved shore.
    const bearingT = cityAxisBearing(cellX, cellZ, worldSeed);
    const bearing = new Float64Array(2);
    ringDirection(bearingT, bearing);
    const dot = dirX * (bearing[0] as number) + dirZ * (bearing[1] as number);
    const flatten = smoothstep(0.2, 0.75, dot);
    factor = lerp(organic, 0.95, flatten);
  } else {
    // Unrecognised archetype id: degrade to the plain organic profile rather
    // than throw, the same defensive default `names.ts`'s `nameSetFor` uses.
    factor = organic;
  }
  return Math.max(0.95, Math.min(1.5, factor));
}

export interface CityPlan {
  readonly worldSeed: number;
  readonly cellX: number;
  readonly cellZ: number;
  /** One of `ARCH_*` from `culture.ts`. Decides how the wall's organic radius profile is bent. */
  readonly archetype: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly centerY: number;
  readonly wallRadius: number;
  readonly farmRadius: number;
  /** Closed wall centreline, world metres. Last point equals first. */
  readonly wallX: Float64Array;
  readonly wallZ: Float64Array;
  readonly wallCount: number;
  /** Indices into wall polyline (excluding the closing duplicate). */
  readonly gateIndex: Uint16Array;
  readonly gateCount: number;
  readonly towerIndex: Uint16Array;
  readonly towerCount: number;
  readonly districtKind: Uint8Array;
  readonly districtX: Float64Array;
  readonly districtZ: Float64Array;
  readonly districtRadius: Float64Array;
  readonly districtCount: number;
  readonly landmarkKind: Uint8Array;
  readonly landmarkX: Float64Array;
  readonly landmarkZ: Float64Array;
  readonly landmarkHalfW: Float64Array;
  readonly landmarkHalfD: Float64Array;
  readonly landmarkCount: number;
  /** Arteries + block lanes as CSR polylines. */
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  readonly streetStart: Uint32Array;
  readonly streetCount: number;
  readonly farmX: Float64Array;
  readonly farmZ: Float64Array;
  readonly farmRadiusArr: Float64Array;
  readonly farmCount: number;
}

const cache: CityPlan[] = [];
const CACHE_LIMIT = 32;
let cacheBuilds = 0;

export function cityCacheStats(): { entries: number; builds: number } {
  return { entries: cache.length, builds: cacheBuilds };
}

export function clearCityCache(): void {
  cache.length = 0;
}

export function isCity(site: Settlement): boolean {
  return site.class === 1;
}

export function cityInfluenceRadius(site: Settlement): number {
  return site.farmRadius > 0 ? site.farmRadius : site.radius;
}

function unitAt(cellX: number, cellZ: number, index: number, worldSeed: number, salt: number): number {
  return hashUnit(hash3i(cellX, cellZ, index, (worldSeed ^ salt) >>> 0));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Generate the Region-tier plan for one city settlement.
 * Prefer cityPlanAt, which memoises.
 */
export function generateCityPlan(site: Settlement, worldSeed: number): CityPlan {
  if (!isCity(site)) {
    throw new Error('generateCityPlan requires SETTLEMENT_CLASS_CITY');
  }
  const cellX = site.cellX;
  const cellZ = site.cellZ;
  const cx = site.x;
  const cz = site.z;
  const cy = site.y;
  const R = site.wallRadius;
  const farmR = site.farmRadius;
  const archetype = pickArchetype(cellX, cellZ, worldSeed);
  const axisBearing = cityAxisBearing(cellX, cellZ, worldSeed);

  const dir = new Float64Array(2);
  const wallN = CITY_WALL_SEGMENTS;
  const wallX = new Float64Array(wallN + 1);
  const wallZ = new Float64Array(wallN + 1);
  for (let i = 0; i < wallN; i++) {
    const t = i / wallN + (unitAt(cellX, cellZ, i, worldSeed, PLAN_SALT) - 0.5) * 0.02;
    ringDirection(t, dir);
    const dirX = dir[0] as number;
    const dirZ = dir[1] as number;
    const rr = R * archetypeRadiusFactor(archetype, cellX, cellZ, worldSeed, t, dirX, dirZ);
    wallX[i] = cx + dirX * rr;
    wallZ[i] = cz + dirZ * rr;
  }
  wallX[wallN] = wallX[0] as number;
  wallZ[wallN] = wallZ[0] as number;

  const gateCount =
    CITY_GATE_MIN +
    Math.floor(unitAt(cellX, cellZ, 0, worldSeed, GATE_SALT) * (CITY_GATE_MAX - CITY_GATE_MIN + 1));
  const gateIndex = new Uint16Array(gateCount);
  const used = new Set<number>();
  for (let g = 0; g < gateCount; g++) {
    let idx = Math.floor(unitAt(cellX, cellZ, g + 1, worldSeed, GATE_SALT) * wallN);
    let guard = 0;
    while (used.has(idx) && guard++ < wallN) idx = (idx + 3) % wallN;
    used.add(idx);
    gateIndex[g] = idx;
  }

  const towerCount = Math.floor(wallN / 3);
  const towerIndex = new Uint16Array(towerCount);
  for (let t = 0; t < towerCount; t++) {
    towerIndex[t] = Math.floor(((t + 0.5) * wallN) / towerCount) % wallN;
  }

  const dKinds: number[] = [];
  const dX: number[] = [];
  const dZ: number[] = [];
  const dR: number[] = [];
  const pushD = (kind: number, angT: number, distFrac: number, radFrac: number): void => {
    ringDirection(angT, dir);
    dKinds.push(kind);
    dX.push(cx + (dir[0] as number) * R * distFrac);
    dZ.push(cz + (dir[1] as number) * R * distFrac);
    dR.push(R * radFrac);
  };
  // Bearings for [keep, market, civic, religious, guild, residential x2], in
  // that fixed order -- `distFrac`/`radFrac` below are UNCHANGED from before
  // this slice regardless of archetype, which is what keeps the "every
  // district stays inside the wall" safety margin (see the module header)
  // intact without re-deriving it: only WHERE around the ring each district
  // sits moves, never how far out or how big.
  const districtBearings: readonly number[] =
    archetype === ARCH_GRID
      ? [axisBearing, axisBearing + 0.25, axisBearing + 0.5, axisBearing + 0.75, axisBearing + 0.125, axisBearing + 0.375, axisBearing + 0.625]
      : archetype === ARCH_RIVERPORT
        ? [axisBearing, axisBearing + 0.05, axisBearing - 0.08, axisBearing + 0.1, axisBearing - 0.12, axisBearing + 0.18, axisBearing - 0.18]
        : archetype === ARCH_HARBOR
          ? [axisBearing + 0.5, axisBearing, axisBearing + 0.15, axisBearing - 0.15, axisBearing + 0.08, axisBearing + 0.3, axisBearing - 0.3]
          : // ARCH_RADIAL and ARCH_HILL_CITADEL: the original ring arrangement --
            // a citadel's compactness already comes from its tighter street
            // rings (Phase Politics C2), not from a different district layout.
            [0, 0.12, 0.35, 0.55, 0.75, 0.2, 0.7];
  const marketJitter = unitAt(cellX, cellZ, 1, worldSeed, DIST_SALT) * 0.1;
  pushD(DISTRICT_KEEP, districtBearings[0] as number, 0.08, 0.18);
  pushD(DISTRICT_MARKET, (districtBearings[1] as number) + marketJitter, 0.28, 0.16);
  pushD(DISTRICT_CIVIC, districtBearings[2] as number, 0.32, 0.12);
  pushD(DISTRICT_RELIGIOUS, districtBearings[3] as number, 0.3, 0.14);
  pushD(DISTRICT_GUILD, districtBearings[4] as number, 0.4, 0.15);
  pushD(DISTRICT_RESIDENTIAL, districtBearings[5] as number, 0.55, 0.35);
  pushD(DISTRICT_RESIDENTIAL, districtBearings[6] as number, 0.58, 0.32);

  const lK: number[] = [];
  const lX: number[] = [];
  const lZ: number[] = [];
  const lW: number[] = [];
  const lD: number[] = [];
  const pushL = (kind: number, x: number, z: number, hw: number, hd: number): void => {
    lK.push(kind);
    lX.push(x);
    lZ.push(z);
    lW.push(hw);
    lD.push(hd);
  };
  pushL(LANDMARK_KEEP, dX[0] as number, dZ[0] as number, 22, 22);
  pushL(LANDMARK_MARKET, dX[1] as number, dZ[1] as number, 22, 22);
  pushL(LANDMARK_TOWNHALL, dX[2] as number, dZ[2] as number, 16, 12);
  pushL(LANDMARK_CATHEDRAL, dX[3] as number, dZ[3] as number, 16, 28);
  pushL(LANDMARK_GUILD, dX[4] as number, dZ[4] as number, 12, 10);
  pushL(LANDMARK_GUILD, (dX[4] as number) + 22, (dZ[4] as number) - 10, 8, 6);
  for (let g = 0; g < gateCount; g++) {
    const gi = gateIndex[g] as number;
    pushL(LANDMARK_GATEHOUSE, wallX[gi] as number, wallZ[gi] as number, 10, 12);
  }

  const nodeX: number[] = [];
  const nodeZ: number[] = [];
  const streetStart: number[] = [0];
  const addStreet = (pts: { x: number; z: number }[]): void => {
    for (const p of pts) {
      nodeX.push(p.x);
      nodeZ.push(p.z);
    }
    streetStart.push(nodeX.length);
  };
  const market = { x: dX[1] as number, z: dZ[1] as number };
  const keep = { x: dX[0] as number, z: dZ[0] as number };
  for (let g = 0; g < gateCount; g++) {
    const gi = gateIndex[g] as number;
    const gx = wallX[gi] as number;
    const gz = wallZ[gi] as number;
    const mx =
      (gx + market.x) * 0.5 + (unitAt(cellX, cellZ, g + 90, worldSeed, ARTERY_SALT) - 0.5) * 40;
    const mz =
      (gz + market.z) * 0.5 + (unitAt(cellX, cellZ, g + 190, worldSeed, ARTERY_SALT) - 0.5) * 40;
    addStreet([
      { x: gx, z: gz },
      { x: mx, z: mz },
      { x: market.x, z: market.z },
      { x: keep.x, z: keep.z },
    ]);
  }
  // -- the main street network, one shape per archetype (Phase Politics C2) --
  //
  // Every archetype's network is built from the SAME `addStreet` CSR sink the
  // gate arteries above already write into, so `streets.ts`'s clip,
  // `lots.ts`'s station walk, `wall-mesh.ts` and `road-mesh.ts` need no
  // changes at all -- they only ever walk `nodeX`/`nodeZ`/`streetStart`
  // generically. Each network is sized to a comparable total polyline length
  // to the others (`city-density.test.ts`'s floors are calibrated against
  // WHICHEVER city a seed's `citiesInBox` finds first, so no archetype may be
  // dramatically sparser than another).
  if (archetype === ARCH_GRID) {
    // Two perpendicular lane families along a hash-chosen bearing.
    const bearingT = unitAt(cellX, cellZ, 199, worldSeed, WALL_SHAPE_SALT);
    ringDirection(bearingT, dir);
    const ax = dir[0] as number;
    const az = dir[1] as number;
    const bx = -az;
    const bz = ax;
    const LANES = 9;
    const SPAN = R * 1.05;
    for (let i = -Math.floor(LANES / 2); i <= Math.floor(LANES / 2); i++) {
      const offset = i * ((R * 2) / LANES);
      addStreet([
        { x: cx + ax * -SPAN + bx * offset, z: cz + az * -SPAN + bz * offset },
        { x: cx + ax * SPAN + bx * offset, z: cz + az * SPAN + bz * offset },
      ]);
      addStreet([
        { x: cx + bx * -SPAN + ax * offset, z: cz + bz * -SPAN + az * offset },
        { x: cx + bx * SPAN + ax * offset, z: cz + bz * SPAN + az * offset },
      ]);
    }
  } else if (archetype === ARCH_RIVERPORT) {
    // One long spine along the same bearing the wall was elongated on, plus
    // perpendicular cross-lanes -- a waterfront reads as a spine, not a ring.
    const bearingT = cityAxisBearing(cellX, cellZ, worldSeed);
    ringDirection(bearingT, dir);
    const ax = dir[0] as number;
    const az = dir[1] as number;
    const bx = -az;
    const bz = ax;
    addStreet([
      { x: cx - ax * R * 1.05, z: cz - az * R * 1.05 },
      { x: cx, z: cz },
      { x: cx + ax * R * 1.05, z: cz + az * R * 1.05 },
    ]);
    const CROSS_LANES = 11;
    for (let i = 0; i < CROSS_LANES; i++) {
      const t = (i / (CROSS_LANES - 1) - 0.5) * 2 * R * 0.92;
      const px = cx + ax * t;
      const pz = cz + az * t;
      addStreet([
        { x: px - bx * R * 0.55, z: pz - bz * R * 0.55 },
        { x: px + bx * R * 0.55, z: pz + bz * R * 0.55 },
      ]);
    }
  } else if (archetype === ARCH_HILL_CITADEL) {
    // Tighter, closer-packed rings (a citadel switchbacking up a summit)
    // rather than the radial city's evenly spread annulus.
    const HILL_GRID_N = 20;
    for (const frac of [0.42, 0.55, 0.68, 0.79, 0.88, 0.95] as const) {
      const ringPts: { x: number; z: number }[] = [];
      for (let i = 0; i <= HILL_GRID_N; i++) {
        ringDirection(i / HILL_GRID_N, dir);
        ringPts.push({
          x: cx + (dir[0] as number) * R * frac,
          z: cz + (dir[1] as number) * R * frac,
        });
      }
      addStreet(ringPts);
    }
    for (let a = 0; a < HILL_GRID_N; a++) {
      ringDirection(a / HILL_GRID_N, dir);
      addStreet([
        { x: cx + (dir[0] as number) * R * 0.42, z: cz + (dir[1] as number) * R * 0.42 },
        { x: cx + (dir[0] as number) * R * 0.68, z: cz + (dir[1] as number) * R * 0.68 },
        { x: cx + (dir[0] as number) * R * 0.95, z: cz + (dir[1] as number) * R * 0.95 },
      ]);
    }
  } else if (archetype === ARCH_HARBOR) {
    // A fan converging on the flattened waterfront bearing, plus a waterfront
    // arc near the flattened edge itself.
    const bearingT = cityAxisBearing(cellX, cellZ, worldSeed);
    const FAN_N = 22;
    const frontPts: { x: number; z: number }[] = [];
    for (let i = 0; i <= FAN_N; i++) {
      const spread = (i / FAN_N - 0.5) * 0.5;
      ringDirection(bearingT + spread, dir);
      const fx = cx + (dir[0] as number) * R * 0.85;
      const fz = cz + (dir[1] as number) * R * 0.85;
      frontPts.push({ x: fx, z: fz });
      addStreet([
        { x: cx, z: cz },
        { x: fx, z: fz },
      ]);
    }
    addStreet(frontPts);
    // A second, inner arc for cross-connectivity.
    const innerPts: { x: number; z: number }[] = [];
    for (let i = 0; i <= FAN_N; i++) {
      const spread = (i / FAN_N - 0.5) * 0.5;
      ringDirection(bearingT + spread, dir);
      innerPts.push({
        x: cx + (dir[0] as number) * R * 0.45,
        z: cz + (dir[1] as number) * R * 0.45,
      });
    }
    addStreet(innerPts);
  } else {
    // ARCH_RADIAL: dense rings + radials so lot frontage can pack the wall
    // annulus. This is the original C0 network, kept as the default shape.
    const GRID_N = 24;
    for (const frac of [0.3, 0.42, 0.54, 0.66, 0.78, 0.9] as const) {
      const ringPts: { x: number; z: number }[] = [];
      for (let i = 0; i <= GRID_N; i++) {
        ringDirection(i / GRID_N, dir);
        ringPts.push({
          x: cx + (dir[0] as number) * R * frac,
          z: cz + (dir[1] as number) * R * frac,
        });
      }
      addStreet(ringPts);
    }
    for (let a = 0; a < GRID_N; a++) {
      ringDirection(a / GRID_N, dir);
      addStreet([
        { x: cx + (dir[0] as number) * R * 0.3, z: cz + (dir[1] as number) * R * 0.3 },
        { x: cx + (dir[0] as number) * R * 0.54, z: cz + (dir[1] as number) * R * 0.54 },
        { x: cx + (dir[0] as number) * R * 0.78, z: cz + (dir[1] as number) * R * 0.78 },
        { x: cx + (dir[0] as number) * R * 0.92, z: cz + (dir[1] as number) * R * 0.92 },
      ]);
    }
  }

  // Local block fabric around every district except the keep core.
  for (let d = 1; d < dKinds.length; d++) {
    const dx0 = dX[d] as number;
    const dz0 = dZ[d] as number;
    const rr = (dR[d] as number) * 0.9;
    for (let lane = 0; lane < 4; lane++) {
      const t0 = unitAt(cellX, cellZ, d * 10 + lane, worldSeed, BLOCK_SALT);
      ringDirection(t0, dir);
      const ox = -(dir[1] as number);
      const oz = dir[0] as number;
      const along = rr * (0.5 + (0.4 * lane) / 4);
      const lateral = rr * 0.28;
      addStreet([
        {
          x: dx0 - (dir[0] as number) * along - ox * lateral,
          z: dz0 - (dir[1] as number) * along - oz * lateral,
        },
        {
          x: dx0 + (dir[0] as number) * along - ox * lateral,
          z: dz0 + (dir[1] as number) * along - oz * lateral,
        },
        {
          x: dx0 + (dir[0] as number) * along + ox * lateral,
          z: dz0 + (dir[1] as number) * along + oz * lateral,
        },
      ]);
    }
  }
  const fX: number[] = [];
  const fZ: number[] = [];
  const fRad: number[] = [];
  const farmN = 12 + Math.floor(unitAt(cellX, cellZ, 0, worldSeed, FARM_SALT) * 8);
  for (let i = 0; i < farmN; i++) {
    ringDirection(i / farmN + unitAt(cellX, cellZ, i, worldSeed, FARM_SALT) * 0.05, dir);
    const dist = lerp(R + 40, farmR - 20, unitAt(cellX, cellZ, i + 50, worldSeed, FARM_SALT));
    fX.push(cx + (dir[0] as number) * dist);
    fZ.push(cz + (dir[1] as number) * dist);
    fRad.push(lerp(28, 55, unitAt(cellX, cellZ, i + 80, worldSeed, FARM_SALT)));
  }

  return {
    worldSeed,
    cellX,
    cellZ,
    archetype,
    centerX: cx,
    centerZ: cz,
    centerY: cy,
    wallRadius: R,
    farmRadius: farmR,
    wallX,
    wallZ,
    wallCount: wallN + 1,
    gateIndex,
    gateCount,
    towerIndex,
    towerCount,
    districtKind: Uint8Array.from(dKinds),
    districtX: Float64Array.from(dX),
    districtZ: Float64Array.from(dZ),
    districtRadius: Float64Array.from(dR),
    districtCount: dKinds.length,
    landmarkKind: Uint8Array.from(lK),
    landmarkX: Float64Array.from(lX),
    landmarkZ: Float64Array.from(lZ),
    landmarkHalfW: Float64Array.from(lW),
    landmarkHalfD: Float64Array.from(lD),
    landmarkCount: lK.length,
    nodeX: Float64Array.from(nodeX),
    nodeZ: Float64Array.from(nodeZ),
    streetStart: Uint32Array.from(streetStart),
    streetCount: streetStart.length - 1,
    farmX: Float64Array.from(fX),
    farmZ: Float64Array.from(fZ),
    farmRadiusArr: Float64Array.from(fRad),
    farmCount: fX.length,
  };
}

export function cityPlanAt(site: Settlement, worldSeed: number): CityPlan | undefined {
  if (!isCity(site)) return undefined;
  for (let i = 0; i < cache.length; i++) {
    const p = cache[i] as CityPlan;
    if (p.cellX === site.cellX && p.cellZ === site.cellZ && p.worldSeed === worldSeed) {
      if (i > 0) {
        cache.splice(i, 1);
        cache.unshift(p);
      }
      return p;
    }
  }
  const plan = generateCityPlan(site, worldSeed);
  cacheBuilds++;
  cache.unshift(plan);
  if (cache.length > CACHE_LIMIT) cache.length = CACHE_LIMIT;
  return plan;
}

/** Nearest gate world position for road attachment. */
export function nearestCityGate(plan: CityPlan, fromX: number, fromZ: number): { x: number; z: number } {
  let best = Infinity;
  let bx = plan.centerX;
  let bz = plan.centerZ;
  for (let g = 0; g < plan.gateCount; g++) {
    const gi = plan.gateIndex[g] as number;
    const x = plan.wallX[gi] as number;
    const z = plan.wallZ[gi] as number;
    const dx = x - fromX;
    const dz = z - fromZ;
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      bx = x;
      bz = z;
    }
  }
  return { x: bx, z: bz };
}
