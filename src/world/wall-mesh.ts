/**
 * City walls: batched crenellated curtain and projecting towers per chunk.
 *
 * Pure geometry. Ownership: a wall SEGMENT is emitted by the node that contains
 * its midpoint (same centre-ownership rule as buildings). Adjacent segments
 * share miter points computed from the CityPlan polyline, so corners meet
 * without depending on neighbouring chunks.
 *
 * C6 massing: continuous mitered curtain (no open corner wedges), merlons on
 * the walkway, towers that project past both faces, and a clear opening at
 * each gate index so the C5 gatehouse owns the silhouette.
 */

import { chunkSizeAt, REGION_SIZE, type ChunkCoord } from './contracts';
import { cityPlanAt, isCity, type CityPlan } from './city';
import { type RegionRoadField } from './roads';

export const WALL_HEIGHT = 14;
export const WALL_HALF_THICK = 2.8;
/** Sink the curtain base into the ground so slope never opens a light gap. */
export const WALL_BURY = 2.5;
/** Merlon solid height above the walkway top. */
export const MERLON_HEIGHT = 2.2;
/** Merlon width along the curtain (solid tooth). */
export const MERLON_WIDTH = 2.4;
/** Empty gap between merlons (the embrasure). */
export const MERLON_GAP = 2.0;
/** How far merlons overhang the outer face. */
export const MERLON_OUTSET = 0.35;
/**
 * Sharpest miter cos(half-turn) we allow before clamping. Below this, a spike
 * would shoot past the tower footprint on a near-180° fold.
 */
const MITER_COS_MIN = 0.35;

/**
 * Half-extent cleared along the wall polyline at each gate vertex so the C5
 * gatehouse (landmarkHalfW = 10) sits in an open curtain gap.
 */
export const GATE_CLEAR_M = 12;

/** Tower half-size along the wall tangent. */
export const TOWER_HALF_ALONG = 5.2;
/** Tower half-size through the wall (projects past both faces). */
export const TOWER_HALF_OUT = 5.5;
export const TOWER_HEIGHT = 22;
/** Upper stage inset so the tower silhouette is not a single cube. */
export const TOWER_CAP_HALF_ALONG = 4.0;
export const TOWER_CAP_HALF_OUT = 4.2;
export const TOWER_CAP_EXTRA = 4.5;

/** @deprecated Curtain cut is open; C5 owns the gatehouse shell. Kept for tests. */
export const GATE_HALF_W = 5;
/** @deprecated */
export const GATE_HALF_D = 4;
/** @deprecated */
export const GATE_HEIGHT = 12;
/** @deprecated Use TOWER_HALF_ALONG / TOWER_HALF_OUT. */
export const TOWER_HALF = TOWER_HALF_OUT;

export interface WallSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Wall / tower pieces this node owns. */
  count: number;
}

const EMPTY: () => WallSurface = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  count: 0,
});

class WallBuilder {
  readonly px: number[] = [];
  readonly py: number[] = [];
  readonly pz: number[] = [];
  readonly nx: number[] = [];
  readonly ny: number[] = [];
  readonly nz: number[] = [];
  readonly cr: number[] = [];
  readonly cg: number[] = [];
  readonly cb: number[] = [];
  readonly indices: number[] = [];
  count = 0;

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: readonly [number, number, number]): number {
    const at = this.px.length;
    this.px.push(x); this.py.push(y); this.pz.push(z);
    this.nx.push(nx); this.ny.push(ny); this.nz.push(nz);
    this.cr.push(c[0]); this.cg.push(c[1]); this.cb.push(c[2]);
    return at;
  }

  finish(): WallSurface {
    const n = this.px.length;
    if (n === 0) return EMPTY();
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const at = i * 3;
      positions[at] = this.px[i] as number;
      positions[at + 1] = this.py[i] as number;
      positions[at + 2] = this.pz[i] as number;
      normals[at] = this.nx[i] as number;
      normals[at + 1] = this.ny[i] as number;
      normals[at + 2] = this.nz[i] as number;
      colors[at] = this.cr[i] as number;
      colors[at + 1] = this.cg[i] as number;
      colors[at + 2] = this.cb[i] as number;
    }
    return {
      positions,
      normals,
      colors,
      indices: Uint32Array.from(this.indices),
      count: this.count,
    };
  }
}

type Rgb = readonly [number, number, number];
const STONE: Rgb = [0.45, 0.43, 0.4];
const STONE_DARK: Rgb = [0.32, 0.3, 0.28];
const STONE_LIGHT: Rgb = [0.52, 0.5, 0.46];

function face(
  b: WallBuilder,
  corners: { x: number; y: number; z: number }[],
  color: Rgb,
  hintX: number,
  hintY: number,
  hintZ: number,
): void {
  const a = corners[0]!;
  const c1 = corners[1]!;
  const c2 = corners[2]!;
  const ux = c1.x - a.x, uy = c1.y - a.y, uz = c1.z - a.z;
  const vx = c2.x - a.x, vy = c2.y - a.y, vz = c2.z - a.z;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len <= 0) return;
  nx /= len; ny /= len; nz /= len;
  let flip = nx * hintX + ny * hintY + nz * hintZ < 0;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  const first = b.px.length;
  const total = corners.length;
  for (let i = 0; i < total; i++) {
    const pick = flip ? total - 1 - i : i;
    const c = corners[pick]!;
    b.vertex(c.x, c.y, c.z, nx, ny, nz, color);
  }
  for (let i = 2; i < total; i++) b.indices.push(first, first + i - 1, first + i);
}

function boxAt(
  b: WallBuilder,
  x: number, y0: number, z: number,
  hx: number, hy: number, hz: number,
  color: Rgb,
): void {
  const y1 = y0 + hy * 2;
  face(b, [{x:x-hx,y:y0,z:z-hz},{x:x+hx,y:y0,z:z-hz},{x:x+hx,y:y1,z:z-hz},{x:x-hx,y:y1,z:z-hz}], color, 0, 0, -1);
  face(b, [{x:x+hx,y:y0,z:z+hz},{x:x-hx,y:y0,z:z+hz},{x:x-hx,y:y1,z:z+hz},{x:x+hx,y:y1,z:z+hz}], color, 0, 0, 1);
  face(b, [{x:x-hx,y:y0,z:z+hz},{x:x-hx,y:y0,z:z-hz},{x:x-hx,y:y1,z:z-hz},{x:x-hx,y:y1,z:z+hz}], color, -1, 0, 0);
  face(b, [{x:x+hx,y:y0,z:z-hz},{x:x+hx,y:y0,z:z+hz},{x:x+hx,y:y1,z:z+hz},{x:x+hx,y:y1,z:z-hz}], color, 1, 0, 0);
  face(b, [{x:x-hx,y:y1,z:z-hz},{x:x+hx,y:y1,z:z-hz},{x:x+hx,y:y1,z:z+hz},{x:x-hx,y:y1,z:z+hz}], color, 0, 1, 0);
  face(b, [{x:x-hx,y:y0,z:z+hz},{x:x+hx,y:y0,z:z+hz},{x:x+hx,y:y0,z:z-hz},{x:x-hx,y:y0,z:z-hz}], color, 0, -1, 0);
  b.count++;
}

function isGateVertex(plan: CityPlan, index: number): boolean {
  // Closed ring: last polyline sample duplicates vertex 0.
  const idx = index === plan.wallCount - 1 ? 0 : index;
  for (let g = 0; g < plan.gateCount; g++) {
    if ((plan.gateIndex[g] as number) === idx) return true;
  }
  return false;
}

function trimGateEnds(
  ax: number, az: number, bx: number, bz: number,
  aIsGate: boolean, bIsGate: boolean,
): { ax: number; az: number; bx: number; bz: number } | undefined {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len <= 0.01) return undefined;
  let t0 = 0;
  let t1 = 1;
  const clear = GATE_CLEAR_M / len;
  if (aIsGate) t0 = clear;
  if (bIsGate) t1 = 1 - clear;
  if (t1 - t0 < 0.05) return undefined;
  return {
    ax: ax + dx * t0,
    az: az + dz * t0,
    bx: ax + dx * t1,
    bz: az + dz * t1,
  };
}

/** Unit direction; returns false if the segment is degenerate. */
function unitDir(
  ax: number, az: number, bx: number, bz: number,
  out: { x: number; z: number },
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len <= 0.01) return false;
  out.x = dx / len;
  out.z = dz / len;
  return true;
}

/** Left-hand perpendicular of a unit direction — the curtain's "outer" side. */
function outward(ux: number, uz: number): { x: number; z: number } {
  return { x: -uz, z: ux };
}

/**
 * Offset from a polyline vertex to the outer (or inner) miter corner.
 * Both adjacent segments that share the vertex must call this with the same
 * (uIn, uOut, half, outer) so their faces meet byte-exactly.
 */
function miterOffset(
  uxIn: number, uzIn: number,
  uxOut: number, uzOut: number,
  half: number,
  outer: boolean,
): { x: number; z: number } {
  const sign = outer ? 1 : -1;
  const pIn = outward(uxIn, uzIn);
  const pOut = outward(uxOut, uzOut);
  const nInX = pIn.x * sign;
  const nInZ = pIn.z * sign;
  const nOutX = pOut.x * sign;
  const nOutZ = pOut.z * sign;
  let mx = nInX + nOutX;
  let mz = nInZ + nOutZ;
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len <= 1e-8) {
    return { x: nInX * half, z: nInZ * half };
  }
  mx /= len;
  mz /= len;
  const cos = mx * nInX + mz * nInZ;
  const scale = half / (cos < MITER_COS_MIN ? MITER_COS_MIN : cos);
  return { x: mx * scale, z: mz * scale };
}

function buttOffset(
  ux: number, uz: number, half: number, outer: boolean,
): { x: number; z: number } {
  const p = outward(ux, uz);
  const s = outer ? 1 : -1;
  return { x: p.x * half * s, z: p.z * half * s };
}

/**
 * Solid curtain body plus alternating merlons along the outer walkway.
 * Ends are either square butts (gates) or miters shared with the neighbouring
 * segment so the ring reads as one continuous fortification.
 */
function addCrenellatedSegment(
  b: WallBuilder,
  ax: number, az: number, bx: number, bz: number,
  yA: number, yB: number,
  uxInA: number, uzInA: number,
  uxOutB: number, uzOutB: number,
  buttA: boolean, buttB: boolean,
  originX: number, originZ: number,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len <= 0.01) return;
  const ux = dx / len;
  const uz = dz / len;
  const h = WALL_HALF_THICK;
  const ox = originX;
  const oz = originZ;

  const offAOut = buttA
    ? buttOffset(ux, uz, h, true)
    : miterOffset(uxInA, uzInA, ux, uz, h, true);
  const offAIn = buttA
    ? buttOffset(ux, uz, h, false)
    : miterOffset(uxInA, uzInA, ux, uz, h, false);
  const offBOut = buttB
    ? buttOffset(ux, uz, h, true)
    : miterOffset(ux, uz, uxOutB, uzOutB, h, true);
  const offBIn = buttB
    ? buttOffset(ux, uz, h, false)
    : miterOffset(ux, uz, uxOutB, uzOutB, h, false);

  const aOut = { x: ax + offAOut.x - ox, y: yA, z: az + offAOut.z - oz };
  const aIn = { x: ax + offAIn.x - ox, y: yA, z: az + offAIn.z - oz };
  const bOut = { x: bx + offBOut.x - ox, y: yB, z: bz + offBOut.z - oz };
  const bIn = { x: bx + offBIn.x - ox, y: yB, z: bz + offBIn.z - oz };
  const walkA = yA + WALL_HEIGHT + WALL_BURY;
  const walkB = yB + WALL_HEIGHT + WALL_BURY;
  const aOutTop = { x: aOut.x, y: walkA, z: aOut.z };
  const aInTop = { x: aIn.x, y: walkA, z: aIn.z };
  const bOutTop = { x: bOut.x, y: walkB, z: bOut.z };
  const bInTop = { x: bIn.x, y: walkB, z: bIn.z };

  const p = outward(ux, uz);
  // Outer / inner / top of the curtain body.
  face(b, [aOut, bOut, bOutTop, aOutTop], STONE, p.x, 0, p.z);
  face(b, [bIn, aIn, aInTop, bInTop], STONE, -p.x, 0, -p.z);
  face(b, [aOutTop, bOutTop, bInTop, aInTop], STONE_DARK, 0, 1, 0);
  // End caps only at gate butts — miters are sealed by the neighbour segment.
  if (buttA) {
    face(b, [aIn, aOut, aOutTop, aInTop], STONE_DARK, -ux, 0, -uz);
  }
  if (buttB) {
    face(b, [bOut, bIn, bInTop, bOutTop], STONE_DARK, ux, 0, uz);
  }
  b.count++;

  // Merlons along centreline arc length (flat period — silhouette, not CAD).
  const period = MERLON_WIDTH + MERLON_GAP;
  const merlonHalfAlong = MERLON_WIDTH * 0.5;
  const merlonHalfOut = h + MERLON_OUTSET;
  const merlonHalfIn = h * 0.35;
  let t = MERLON_GAP * 0.5;
  while (t + MERLON_WIDTH <= len - 0.05) {
    const mid = t + merlonHalfAlong;
    const frac = mid / len;
    const cx = ax + ux * mid - ox;
    const cz = az + uz * mid - oz;
    const walkY = yA + (yB - yA) * frac + WALL_HEIGHT + WALL_BURY;
    const alongHx = ux * merlonHalfAlong;
    const alongHz = uz * merlonHalfAlong;
    const outHx = p.x * merlonHalfOut;
    const outHz = p.z * merlonHalfOut;
    const inHx = p.x * merlonHalfIn;
    const inHz = p.z * merlonHalfIn;
    const y1 = walkY;
    const y2 = walkY + MERLON_HEIGHT;
    const c0x = cx - alongHx + outHx, c0z = cz - alongHz + outHz;
    const c1x = cx + alongHx + outHx, c1z = cz + alongHz + outHz;
    const c2x = cx + alongHx - inHx, c2z = cz + alongHz - inHz;
    const c3x = cx - alongHx - inHx, c3z = cz - alongHz - inHz;
    face(b, [
      { x: c0x, y: y1, z: c0z }, { x: c1x, y: y1, z: c1z },
      { x: c1x, y: y2, z: c1z }, { x: c0x, y: y2, z: c0z },
    ], STONE_LIGHT, p.x, 0, p.z);
    face(b, [
      { x: c2x, y: y1, z: c2z }, { x: c3x, y: y1, z: c3z },
      { x: c3x, y: y2, z: c3z }, { x: c2x, y: y2, z: c2z },
    ], STONE_LIGHT, -p.x, 0, -p.z);
    face(b, [
      { x: c3x, y: y1, z: c3z }, { x: c0x, y: y1, z: c0z },
      { x: c0x, y: y2, z: c0z }, { x: c3x, y: y2, z: c3z },
    ], STONE_DARK, -ux, 0, -uz);
    face(b, [
      { x: c1x, y: y1, z: c1z }, { x: c2x, y: y1, z: c2z },
      { x: c2x, y: y2, z: c2z }, { x: c1x, y: y2, z: c1z },
    ], STONE_DARK, ux, 0, uz);
    face(b, [
      { x: c0x, y: y2, z: c0z }, { x: c1x, y: y2, z: c1z },
      { x: c2x, y: y2, z: c2z }, { x: c3x, y: y2, z: c3z },
    ], STONE_DARK, 0, 1, 0);
    b.count++;
    t += period;
  }
}

/**
 * Multi-volume tower: large base projecting past both curtain faces, inset
 * upper stage, and a four-tooth merlon crown. Not a single cube matching the
 * curtain section.
 */
function addTower(
  b: WallBuilder,
  worldX: number, worldZ: number,
  y0: number, originX: number, originZ: number,
  ux: number, uz: number,
): void {
  const px = -uz;
  const pz = ux;
  const x = worldX - originX;
  const z = worldZ - originZ;

  const placeOriented = (
    halfAlong: number, halfOut: number,
    yBot: number, yTop: number,
    color: Rgb,
  ): void => {
    const ax = ux * halfAlong, az = uz * halfAlong;
    const ox = px * halfOut, oz = pz * halfOut;
    const c = [
      { x: x - ax + ox, y: yBot, z: z - az + oz },
      { x: x + ax + ox, y: yBot, z: z + az + oz },
      { x: x + ax - ox, y: yBot, z: z + az - oz },
      { x: x - ax - ox, y: yBot, z: z - az - oz },
    ];
    const t = c.map((p) => ({ x: p.x, y: yTop, z: p.z }));
    face(b, [c[0]!, c[1]!, t[1]!, t[0]!], color, px, 0, pz);
    face(b, [c[2]!, c[3]!, t[3]!, t[2]!], color, -px, 0, -pz);
    face(b, [c[3]!, c[0]!, t[0]!, t[3]!], color, -ux, 0, -uz);
    face(b, [c[1]!, c[2]!, t[2]!, t[1]!], color, ux, 0, uz);
    face(b, [t[0]!, t[1]!, t[2]!, t[3]!], STONE_DARK, 0, 1, 0);
    face(b, [c[0]!, c[3]!, c[2]!, c[1]!], STONE_DARK, 0, -1, 0);
    b.count++;
  };

  const bodyTop = y0 + TOWER_HEIGHT + WALL_BURY;
  const capTop = bodyTop + TOWER_CAP_EXTRA;
  placeOriented(TOWER_HALF_ALONG, TOWER_HALF_OUT, y0, bodyTop, STONE_DARK);
  placeOriented(TOWER_CAP_HALF_ALONG, TOWER_CAP_HALF_OUT, bodyTop - 0.5, capTop, STONE);

  // Four corner merlon teeth on the cap — distinct from curtain merlon rhythm.
  const tooth = 1.35;
  const toothH = MERLON_HEIGHT * 1.15;
  for (const su of [-1, 1] as const) {
    for (const sv of [-1, 1] as const) {
      const cx = x + ux * (TOWER_CAP_HALF_ALONG - tooth) * su + px * (TOWER_CAP_HALF_OUT - tooth) * sv;
      const cz = z + uz * (TOWER_CAP_HALF_ALONG - tooth) * su + pz * (TOWER_CAP_HALF_OUT - tooth) * sv;
      boxAt(b, cx, capTop, cz, tooth, toothH / 2, tooth, STONE_LIGHT);
    }
  }
}

export function buildWallSurface(
  coord: ChunkCoord,
  roads: RegionRoadField,
  groundY: (localX: number, localZ: number) => number,
): WallSurface {
  const size = chunkSizeAt(coord.lod);
  const minX = coord.x * size;
  const minZ = coord.z * size;
  const maxX = minX + size;
  const maxZ = minZ + size;
  const b = new WallBuilder();

  const pad = 700;
  const rx0 = Math.floor((minX - pad) / REGION_SIZE);
  const rx1 = Math.floor((maxX + pad) / REGION_SIZE);
  const rz0 = Math.floor((minZ - pad) / REGION_SIZE);
  const rz1 = Math.floor((maxZ + pad) / REGION_SIZE);
  const seen = new Set<string>();

  for (let rz = rz0; rz <= rz1; rz++) {
    for (let rx = rx0; rx <= rx1; rx++) {
      const net = roads.networkAt(rx * REGION_SIZE + REGION_SIZE / 2, rz * REGION_SIZE + REGION_SIZE / 2);
      for (let i = 0; i < net.settlements.length; i++) {
        const s = net.settlements[i]!;
        if (!isCity(s)) continue;
        const key = s.cellX + ',' + s.cellZ;
        if (seen.has(key)) continue;
        seen.add(key);
        const plan = cityPlanAt(s, net.worldSeed);
        if (plan === undefined) continue;
        emitPlan(b, plan, minX, minZ, maxX, maxZ, groundY);
      }
    }
  }
  return b.finish();
}

function emitPlan(
  b: WallBuilder,
  plan: CityPlan,
  minX: number, minZ: number, maxX: number, maxZ: number,
  groundY: (lx: number, lz: number) => number,
): void {
  const originX = minX;
  const originZ = minZ;
  const ringN = plan.wallCount - 1; // last sample duplicates vertex 0
  const scratch = { x: 0, z: 0 };

  const segDir = (i: number): { x: number; z: number } => {
    // Segment i runs wall[i] → wall[i+1]; wrap with the closed ring.
    if (!unitDir(
      plan.wallX[i] as number, plan.wallZ[i] as number,
      plan.wallX[i + 1] as number, plan.wallZ[i + 1] as number,
      scratch,
    )) {
      return { x: 1, z: 0 };
    }
    return { x: scratch.x, z: scratch.z };
  };

  for (let i = 0; i + 1 < plan.wallCount; i++) {
    const ax0 = plan.wallX[i] as number;
    const az0 = plan.wallZ[i] as number;
    const bx0 = plan.wallX[i + 1] as number;
    const bz0 = plan.wallZ[i + 1] as number;
    const aGate = isGateVertex(plan, i);
    const bGate = isGateVertex(plan, i + 1);
    // Pull curtain ends back from every gate vertex so the C5 gatehouse
    // (halfW ≈ 10) sits in a clear opening — not a missing ~100 m segment.
    const trimmed = trimGateEnds(ax0, az0, bx0, bz0, aGate, bGate);
    if (trimmed === undefined) continue;

    const mx = (trimmed.ax + trimmed.bx) * 0.5;
    const mz = (trimmed.az + trimmed.bz) * 0.5;
    if (mx < minX || mx >= maxX || mz < minZ || mz >= maxZ) continue;

    const prevI = i === 0 ? ringN - 1 : i - 1;
    const nextI = i + 1 >= ringN ? 0 : i + 1;
    const uPrev = segDir(prevI);
    const uNext = segDir(nextI);

    // Square butt at gate clearances; miter at every other joint (including
    // tower stations — the tower volume overlaps the continuous curtain).
    const yA = groundY(trimmed.ax - originX, trimmed.az - originZ) - WALL_BURY;
    const yB = groundY(trimmed.bx - originX, trimmed.bz - originZ) - WALL_BURY;

    addCrenellatedSegment(
      b,
      trimmed.ax, trimmed.az, trimmed.bx, trimmed.bz,
      yA, yB,
      uPrev.x, uPrev.z,
      uNext.x, uNext.z,
      aGate, bGate,
      originX, originZ,
    );
  }

  for (let t = 0; t < plan.towerCount; t++) {
    const ti = plan.towerIndex[t] as number;
    if (isGateVertex(plan, ti)) continue;
    const x = plan.wallX[ti] as number;
    const z = plan.wallZ[ti] as number;
    if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;

    // Tangent from neighbouring wall vertices (closed ring: last == first).
    const prev = ti === 0 ? plan.wallCount - 2 : ti - 1;
    const next = ti + 1;
    const pax = plan.wallX[prev] as number;
    const paz = plan.wallZ[prev] as number;
    const nbx = plan.wallX[next] as number;
    const nbz = plan.wallZ[next] as number;
    let tx = nbx - pax;
    let tz = nbz - paz;
    const tlen = Math.sqrt(tx * tx + tz * tz);
    if (tlen <= 0.01) { tx = 1; tz = 0; } else { tx /= tlen; tz /= tlen; }

    const y0 = groundY(x - originX, z - originZ) - WALL_BURY;
    addTower(b, x, z, y0, originX, originZ, tx, tz);
  }
  // No wall-mesh gatehouse: C5 landmark owns twin towers + opening.
}
