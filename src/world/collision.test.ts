import { describe, expect, it } from 'vitest';
import { generateCityPlan } from './city';
import {
  circleIntersectsAabb,
  collidesWithCityWall,
  collidesWithLots,
  pointSegmentDistanceSq,
} from './collision';
import { SETTLEMENT_CLASS_CITY, type Settlement } from './roads';
import type { SectorLots } from './lots';

describe('pure collision proxies', () => {
  it('tests a player circle against synthetic building AABBs', () => {
    expect(circleIntersectsAabb(0, 0, 1, { minX: 0.5, minZ: -1, maxX: 2, maxZ: 1 })).toBe(true);
    expect(circleIntersectsAabb(0, 0, 1, { minX: 2, minZ: 2, maxX: 3, maxZ: 3 })).toBe(false);
  });

  it('uses building footprint dimensions from SectorLots', () => {
    const lots = {
      count: 1,
      centerX: Float64Array.of(10),
      centerZ: Float64Array.of(20),
      halfWidth: Float64Array.of(3),
      halfDepth: Float64Array.of(4),
    } as unknown as SectorLots;
    expect(collidesWithLots(15.5, 20, 1, lots)).toBe(true);
    expect(collidesWithLots(17, 20, 1, lots)).toBe(false);
  });

  it('computes clamped segment distance', () => {
    expect(pointSegmentDistanceSq(5, 3, 0, 0, 10, 0)).toBe(9);
    expect(pointSegmentDistanceSq(-2, 0, 0, 0, 10, 0)).toBe(4);
  });

  it('blocks curtain segments while leaving gates open', () => {
    const city: Settlement = {
      cellX: 0, cellZ: 0, x: 0, y: 20, z: 0, score: 1, radius: 450,
      class: SETTLEMENT_CLASS_CITY, wallRadius: 450, farmRadius: 720,
    };
    const plan = generateCityPlan(city, 123);
    const gateIndex = plan.gateIndex[0] as number;
    const gateX = plan.wallX[gateIndex] as number;
    const gateZ = plan.wallZ[gateIndex] as number;
    expect(collidesWithCityWall(gateX, gateZ, 0.5, plan)).toBe(false);
    let segment = 0;
    while (Array.from(plan.gateIndex).includes(segment)) segment++;
    const x = ((plan.wallX[segment] as number) + (plan.wallX[segment + 1] as number)) * 0.5;
    const z = ((plan.wallZ[segment] as number) + (plan.wallZ[segment + 1] as number)) * 0.5;
    expect(collidesWithCityWall(x, z, 0.5, plan)).toBe(true);
  });
});
