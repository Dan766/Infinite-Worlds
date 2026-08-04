/**
 * Medieval cities: Region-tier CityPlan.
 *
 * Phase City C0-C2. A rare Settlement class owns a plan that spans multiple
 * sectors: walls, gates, districts, arteries, landmarks and a farmland belt.
 * Villages keep the Sector-tier street generators; cities do not invent
 * themselves at the Sector tier -- they only CLIP this plan.
 *
 * Determinism: every quantity is hash3i/hashUnit of (worldSeed, cell, index).
 * Wall rings use ringDirection (piecewise unit octagon) -- no sin/cos on the
 * path to a stored vertex.
 */

import { hash3i } from '../core/hash';
import { hashUnit } from './noise';
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

export interface CityPlan {
  readonly worldSeed: number;
  readonly cellX: number;
  readonly cellZ: number;
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

  const dir = new Float64Array(2);
  const wallN = CITY_WALL_SEGMENTS;
  const wallX = new Float64Array(wallN + 1);
  const wallZ = new Float64Array(wallN + 1);
  for (let i = 0; i < wallN; i++) {
    const t = i / wallN + (unitAt(cellX, cellZ, i, worldSeed, PLAN_SALT) - 0.5) * 0.02;
    ringDirection(t, dir);
    const rr = R * (0.92 + 0.12 * unitAt(cellX, cellZ, i + 40, worldSeed, PLAN_SALT));
    wallX[i] = cx + (dir[0] as number) * rr;
    wallZ[i] = cz + (dir[1] as number) * rr;
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
  pushD(DISTRICT_KEEP, 0, 0.08, 0.18);
  pushD(DISTRICT_MARKET, 0.12 + unitAt(cellX, cellZ, 1, worldSeed, DIST_SALT) * 0.1, 0.28, 0.16);
  pushD(DISTRICT_CIVIC, 0.35, 0.32, 0.12);
  pushD(DISTRICT_RELIGIOUS, 0.55, 0.3, 0.14);
  pushD(DISTRICT_GUILD, 0.75, 0.4, 0.15);
  pushD(DISTRICT_RESIDENTIAL, 0.2, 0.55, 0.35);
  pushD(DISTRICT_RESIDENTIAL, 0.7, 0.58, 0.32);

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
  // Polar street grid: dense rings + radials so lot frontage can pack the wall
  // annulus. Arteries above still provide gate→market→keep spines.
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
