import { describe, expect, it } from 'vitest';
import type { ChunkCoord } from './contracts';
import { clearCityCache, generateCityPlan } from './city';
import { SETTLEMENT_CLASS_CITY, type RegionRoadField, type Settlement } from './roads';
import {
  GATE_CLEAR_M,
  MERLON_GAP,
  MERLON_WIDTH,
  TOWER_HALF_OUT,
  WALL_HALF_THICK,
  WALL_HEIGHT,
  buildWallSurface,
} from './wall-mesh';

const SEED = 0x151b7e57;
const CITY: Settlement = {
  cellX: 3,
  cellZ: -2,
  x: 256,
  y: 12,
  z: -128,
  score: 0.9,
  radius: 260,
  class: SETTLEMENT_CLASS_CITY,
  wallRadius: 260,
  farmRadius: 520,
};

function surfaceForPlan() {
  clearCityCache();
  const plan = generateCityPlan(CITY, SEED);
  // Pick a non-gate curtain segment mid and build the chunk that owns it.
  let segment = 0;
  while (Array.from(plan.gateIndex).includes(segment)) segment++;
  const midX = ((plan.wallX[segment] as number) + (plan.wallX[segment + 1] as number)) * 0.5;
  const midZ = ((plan.wallZ[segment] as number) + (plan.wallZ[segment + 1] as number)) * 0.5;
  const coord: ChunkCoord = { x: Math.floor(midX / 64), z: Math.floor(midZ / 64), lod: 0 };
  const network = { worldSeed: SEED, settlements: [CITY] };
  const roads = { networkAt: () => network } as unknown as RegionRoadField;
  const surface = buildWallSurface(coord, roads, () => CITY.y);
  return { plan, surface, segment, midX, midZ, coord };
}

describe('wall massing (C6)', () => {
  it('emits non-empty crenellated wall geometry', () => {
    const { surface } = surfaceForPlan();
    expect(surface.count).toBeGreaterThan(0);
    expect(surface.positions.length).toBeGreaterThan(0);
    expect(surface.indices.length).toBeGreaterThan(0);
  });

  it('places enough merlon gaps on a long curtain for the approach criterion', () => {
    clearCityCache();
    const plan = generateCityPlan(CITY, SEED);
    let segment = 0;
    while (Array.from(plan.gateIndex).includes(segment) || Array.from(plan.gateIndex).includes(segment + 1)) {
      segment++;
    }
    const ax = plan.wallX[segment] as number;
    const az = plan.wallZ[segment] as number;
    const bx = plan.wallX[segment + 1] as number;
    const bz = plan.wallZ[segment + 1] as number;
    const len = Math.hypot(bx - ax, bz - az);
    const period = MERLON_WIDTH + MERLON_GAP;
    // Same placement loop as addCrenellatedSegment.
    let t = MERLON_GAP * 0.5;
    let merlons = 0;
    while (t + MERLON_WIDTH <= len - 0.05) {
      merlons++;
      t += period;
    }
    // N merlons imply N gaps in the alternating rhythm on a continuous run.
    expect(merlons).toBeGreaterThanOrEqual(6);
    expect(len).toBeGreaterThan(6 * period);
  });

  it('towers project past both curtain faces', () => {
    expect(TOWER_HALF_OUT).toBeGreaterThan(WALL_HALF_THICK);
  });

  it('merlon verts rise above the walkway on emitted curtain', () => {
    const { surface } = surfaceForPlan();
    let above = 0;
    for (let i = 0; i < surface.positions.length; i += 3) {
      const y = surface.positions[i + 1] as number;
      if (y > CITY.y + WALL_HEIGHT + 0.5) above++;
    }
    expect(above).toBeGreaterThan(0);
  });

  it('tower mesh AABB projects past curtain half-thickness', () => {
    clearCityCache();
    const plan = generateCityPlan(CITY, SEED);
    const ti = plan.towerIndex[0] as number;
    const tx = plan.wallX[ti] as number;
    const tz = plan.wallZ[ti] as number;
    const coord: ChunkCoord = { x: Math.floor(tx / 64), z: Math.floor(tz / 64), lod: 0 };
    const network = { worldSeed: SEED, settlements: [CITY] };
    const roads = { networkAt: () => network } as unknown as RegionRoadField;
    const surface = buildWallSurface(coord, roads, () => CITY.y);
    let maxRadial = 0;
    // Approximate radial extent from tower station using wall tangent normal.
    const prev = ti === 0 ? plan.wallCount - 2 : ti - 1;
    const next = ti + 1;
    let ux = (plan.wallX[next] as number) - (plan.wallX[prev] as number);
    let uz = (plan.wallZ[next] as number) - (plan.wallZ[prev] as number);
    const ulen = Math.hypot(ux, uz) || 1;
    ux /= ulen; uz /= ulen;
    const px = -uz; const pz = ux;
    for (let i = 0; i < surface.positions.length; i += 3) {
      const wx = (surface.positions[i] as number) + coord.x * 64;
      const wz = (surface.positions[i + 2] as number) + coord.z * 64;
      const dx = wx - tx;
      const dz = wz - tz;
      if (Math.hypot(dx, dz) > 20) continue;
      const radial = Math.abs(dx * px + dz * pz);
      if (radial > maxRadial) maxRadial = radial;
    }
    expect(maxRadial).toBeGreaterThan(WALL_HALF_THICK + 0.5);
  });

  it('leaves a clear opening at each gate vertex (no curtain through the gatehouse)', () => {
    clearCityCache();
    const plan = generateCityPlan(CITY, SEED);
    const gi = plan.gateIndex[0] as number;
    const gx = plan.wallX[gi] as number;
    const gz = plan.wallZ[gi] as number;
    const coord: ChunkCoord = { x: Math.floor(gx / 64), z: Math.floor(gz / 64), lod: 0 };
    const network = { worldSeed: SEED, settlements: [CITY] };
    const roads = { networkAt: () => network } as unknown as RegionRoadField;
    const surface = buildWallSurface(coord, roads, () => CITY.y);
    // No vertex should sit inside the gate clear radius of the gate point.
    let nearGate = 0;
    for (let i = 0; i < surface.positions.length; i += 3) {
      const x = (surface.positions[i] as number) + coord.x * 64;
      const z = (surface.positions[i + 2] as number) + coord.z * 64;
      const d = Math.hypot(x - gx, z - gz);
      if (d < GATE_CLEAR_M * 0.85) nearGate++;
    }
    expect(nearGate).toBe(0);
  });

  it('miters non-gate corners so the outer face is continuous (no open wedge)', () => {
    clearCityCache();
    const plan = generateCityPlan(CITY, SEED);
    const ringN = plan.wallCount - 1;
    let corner = -1;
    for (let i = 1; i < ringN; i++) {
      if (Array.from(plan.gateIndex).includes(i)) continue;
      if (Array.from(plan.gateIndex).includes(i - 1)) continue;
      if (Array.from(plan.gateIndex).includes((i + 1) % ringN)) continue;
      corner = i;
      break;
    }
    expect(corner).toBeGreaterThanOrEqual(0);
    const vx = plan.wallX[corner] as number;
    const vz = plan.wallZ[corner] as number;
    const ax = plan.wallX[corner - 1] as number;
    const az = plan.wallZ[corner - 1] as number;
    const bx = plan.wallX[corner + 1] as number;
    const bz = plan.wallZ[corner + 1] as number;
    const lenIn = Math.hypot(vx - ax, vz - az) || 1;
    const lenOut = Math.hypot(bx - vx, bz - vz) || 1;
    const uxIn = (vx - ax) / lenIn;
    const uzIn = (vz - az) / lenIn;
    const uxOut = (bx - vx) / lenOut;
    const uzOut = (bz - vz) / lenOut;
    const pInX = -uzIn;
    const pInZ = uxIn;
    const pOutX = -uzOut;
    const pOutZ = uxOut;
    let mx = pInX + pOutX;
    let mz = pInZ + pOutZ;
    const mlen = Math.hypot(mx, mz) || 1;
    mx /= mlen;
    mz /= mlen;
    const cos = mx * pInX + mz * pInZ;
    const scale = WALL_HALF_THICK / Math.max(0.35, cos);
    const ox = vx + mx * scale;
    const oz = vz + mz * scale;

    const network = { worldSeed: SEED, settlements: [CITY] };
    const roads = { networkAt: () => network } as unknown as RegionRoadField;
    const chunks = new Set<string>();
    for (const [sx, sz] of [
      [(ax + vx) * 0.5, (az + vz) * 0.5],
      [(vx + bx) * 0.5, (vz + bz) * 0.5],
    ] as const) {
      chunks.add(`${Math.floor(sx / 64)},${Math.floor(sz / 64)}`);
    }
    let closest = Infinity;
    for (const key of chunks) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      const coord: ChunkCoord = { x: cx, z: cz, lod: 0 };
      const surface = buildWallSurface(coord, roads, () => CITY.y);
      for (let i = 0; i < surface.positions.length; i += 3) {
        const wx = (surface.positions[i] as number) + cx * 64;
        const wz = (surface.positions[i + 2] as number) + cz * 64;
        const d = Math.hypot(wx - ox, wz - oz);
        if (d < closest) closest = d;
      }
    }
    // Pre-miter open boxes left a multi-metre outer wedge; a continuous
    // curtain must place a vertex on the shared miter corner.
    expect(closest).toBeLessThan(0.05);
  });
});
