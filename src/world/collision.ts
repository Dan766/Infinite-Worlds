import { GradeBlend } from './grading';
import { cityPlanAt, isCity } from './city';
import { SECTOR_SIZE } from './contracts';
import { gradeTarget, sampleHeight, worldRegionField, worldSectorField } from './height-field';
import type { CityPlan } from './city';
import type { SectorLots } from './lots';

export interface Aabb2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface WorldCollision {
  groundHeight(x: number, z: number): number;
  blocked(x: number, z: number, radius: number): boolean;
  move(x: number, z: number, nextX: number, nextZ: number, radius: number): { x: number; z: number };
}

export function circleIntersectsAabb(x: number, z: number, radius: number, box: Aabb2): boolean {
  const nearestX = Math.max(box.minX, Math.min(x, box.maxX));
  const nearestZ = Math.max(box.minZ, Math.min(z, box.maxZ));
  const dx = x - nearestX;
  const dz = z - nearestZ;
  return dx * dx + dz * dz < radius * radius;
}

export function pointSegmentDistanceSq(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const denom = dx * dx + dz * dz;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / denom));
  const px = ax + dx * t;
  const pz = az + dz * t;
  return (x - px) * (x - px) + (z - pz) * (z - pz);
}

export function collidesWithLots(x: number, z: number, radius: number, lots: SectorLots): boolean {
  for (let i = 0; i < lots.count; i++) {
    // Conservative world-axis proxy. It deliberately includes rotated corners.
    const extent = Math.sqrt(
      (lots.halfWidth[i] as number) ** 2 + (lots.halfDepth[i] as number) ** 2,
    );
    const cx = lots.centerX[i] as number;
    const cz = lots.centerZ[i] as number;
    if (
      circleIntersectsAabb(x, z, radius, {
        minX: cx - extent,
        minZ: cz - extent,
        maxX: cx + extent,
        maxZ: cz + extent,
      })
    ) return true;
  }
  return false;
}

export function collidesWithCityWall(
  x: number,
  z: number,
  radius: number,
  plan: CityPlan,
  wallHalfThickness = 1.6,
): boolean {
  for (let i = 0; i + 1 < plan.wallCount; i++) {
    let gate = false;
    for (let g = 0; g < plan.gateCount; g++) {
      if ((plan.gateIndex[g] as number) === i) gate = true;
    }
    if (gate) continue;
    const distanceSq = pointSegmentDistanceSq(
      x,
      z,
      plan.wallX[i] as number,
      plan.wallZ[i] as number,
      plan.wallX[i + 1] as number,
      plan.wallZ[i + 1] as number,
    );
    const clearance = radius + wallHalfThickness;
    if (distanceSq < clearance * clearance) return true;
  }
  return false;
}

export function createWorldCollision(worldSeed: number): WorldCollision {
  const seed = worldSeed >>> 0;
  const region = worldRegionField(seed);
  const sectors = worldSectorField(region, seed);
  const blend = new GradeBlend();

  const blocked = (x: number, z: number, radius: number): boolean => {
    const sx = Math.floor(x / SECTOR_SIZE);
    const sz = Math.floor(z / SECTOR_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (collidesWithLots(x, z, radius, sectors.lots.lotsAt(sx + dx, sz + dz))) return true;
      }
    }
    const net = region.roads.networkAt(x, z);
    const seen = new Set<string>();
    for (const site of net.settlements) {
      if (!isCity(site)) continue;
      const key = `${site.cellX},${site.cellZ}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const plan = cityPlanAt(site, seed);
      if (plan !== undefined && collidesWithCityWall(x, z, radius, plan)) return true;
    }
    return false;
  };

  return {
    groundHeight(x, z) {
      const ground = sampleHeight(x, z, seed);
      return Math.max(ground, gradeTarget(region, sectors.streets, x, z, blend));
    },
    blocked,
    move(x, z, nextX, nextZ, radius) {
      if (!blocked(nextX, nextZ, radius)) return { x: nextX, z: nextZ };
      // Axis-separated fallback gives smooth wall sliding without mutable state.
      if (!blocked(nextX, z, radius)) return { x: nextX, z };
      if (!blocked(x, nextZ, radius)) return { x, z: nextZ };
      return { x, z };
    },
  };
}
