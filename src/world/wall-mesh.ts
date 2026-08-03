/**
 * City walls: batched curtain, towers and gatehouses per chunk.
 *
 * Pure geometry. Ownership: a wall SEGMENT is emitted by the node that contains
 * its midpoint (same centre-ownership rule as buildings).
 */

import { chunkSizeAt, REGION_SIZE, type ChunkCoord } from './contracts';
import { cityPlanAt, isCity, type CityPlan } from './city';
import { type RegionRoadField } from './roads';

export const WALL_HEIGHT = 9;
export const WALL_HALF_THICK = 1.6;
export const TOWER_HALF = 3.2;
export const TOWER_HEIGHT = 14;
export const GATE_HALF_W = 5;
export const GATE_HALF_D = 4;
export const GATE_HEIGHT = 12;

export interface WallSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Wall / tower / gatehouse pieces this node owns. */
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
  // 6 faces
  face(b, [{x:x-hx,y:y0,z:z-hz},{x:x+hx,y:y0,z:z-hz},{x:x+hx,y:y1,z:z-hz},{x:x-hx,y:y1,z:z-hz}], color, 0, 0, -1);
  face(b, [{x:x+hx,y:y0,z:z+hz},{x:x-hx,y:y0,z:z+hz},{x:x-hx,y:y1,z:z+hz},{x:x+hx,y:y1,z:z+hz}], color, 0, 0, 1);
  face(b, [{x:x-hx,y:y0,z:z+hz},{x:x-hx,y:y0,z:z-hz},{x:x-hx,y:y1,z:z-hz},{x:x-hx,y:y1,z:z+hz}], color, -1, 0, 0);
  face(b, [{x:x+hx,y:y0,z:z-hz},{x:x+hx,y:y0,z:z+hz},{x:x+hx,y:y1,z:z+hz},{x:x+hx,y:y1,z:z-hz}], color, 1, 0, 0);
  face(b, [{x:x-hx,y:y1,z:z-hz},{x:x+hx,y:y1,z:z-hz},{x:x+hx,y:y1,z:z+hz},{x:x-hx,y:y1,z:z+hz}], color, 0, 1, 0);
  face(b, [{x:x-hx,y:y0,z:z+hz},{x:x+hx,y:y0,z:z+hz},{x:x+hx,y:y0,z:z-hz},{x:x-hx,y:y0,z:z-hz}], color, 0, -1, 0);
  b.count++;
}

function addSegment(
  b: WallBuilder,
  ax: number, az: number, bx: number, bz: number,
  y0: number, originX: number, originZ: number,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len <= 0.01) return;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz;
  const pz = ux;
  const h = WALL_HALF_THICK;
  const y1 = y0 + WALL_HEIGHT;
  const corners = [
    { x: ax + px * h - originX, y: y0, z: az + pz * h - originZ },
    { x: bx + px * h - originX, y: y0, z: bz + pz * h - originZ },
    { x: bx + px * h - originX, y: y1, z: bz + pz * h - originZ },
    { x: ax + px * h - originX, y: y1, z: az + pz * h - originZ },
  ];
  face(b, corners, STONE, px, 0, pz);
  const back = [
    { x: bx - px * h - originX, y: y0, z: bz - pz * h - originZ },
    { x: ax - px * h - originX, y: y0, z: az - pz * h - originZ },
    { x: ax - px * h - originX, y: y1, z: az - pz * h - originZ },
    { x: bx - px * h - originX, y: y1, z: bz - pz * h - originZ },
  ];
  face(b, back, STONE, -px, 0, -pz);
  // top
  face(b, [
    { x: ax + px * h - originX, y: y1, z: az + pz * h - originZ },
    { x: bx + px * h - originX, y: y1, z: bz + pz * h - originZ },
    { x: bx - px * h - originX, y: y1, z: bz - pz * h - originZ },
    { x: ax - px * h - originX, y: y1, z: az - pz * h - originZ },
  ], STONE_DARK, 0, 1, 0);
  b.count++;
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

  // Search nearby regions for city settlements
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
  for (let i = 0; i + 1 < plan.wallCount; i++) {
    const ax = plan.wallX[i] as number;
    const az = plan.wallZ[i] as number;
    const bx = plan.wallX[i + 1] as number;
    const bz = plan.wallZ[i + 1] as number;
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    if (mx < minX || mx >= maxX || mz < minZ || mz >= maxZ) continue;
    // Skip segments that are gate openings (gate index segment)
    let isGate = false;
    for (let g = 0; g < plan.gateCount; g++) {
      if ((plan.gateIndex[g] as number) === i) { isGate = true; break; }
    }
    const y0 = groundY(mx - originX, mz - originZ);
    if (!isGate) addSegment(b, ax, az, bx, bz, y0, originX, originZ);
  }
  for (let t = 0; t < plan.towerCount; t++) {
    const ti = plan.towerIndex[t] as number;
    const x = plan.wallX[ti] as number;
    const z = plan.wallZ[ti] as number;
    if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;
    const y0 = groundY(x - originX, z - originZ);
    boxAt(b, x - originX, y0, z - originZ, TOWER_HALF, TOWER_HEIGHT / 2, TOWER_HALF, STONE_DARK);
  }
  for (let g = 0; g < plan.gateCount; g++) {
    const gi = plan.gateIndex[g] as number;
    const x = plan.wallX[gi] as number;
    const z = plan.wallZ[gi] as number;
    if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;
    const y0 = groundY(x - originX, z - originZ);
    boxAt(b, x - originX, y0, z - originZ, GATE_HALF_W, GATE_HEIGHT / 2, GATE_HALF_D, STONE);
  }
}