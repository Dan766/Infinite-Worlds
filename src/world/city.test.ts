import { describe, expect, it } from 'vitest';
import { type ChunkCoord } from './contracts';
import {
  clearCityCache,
  generateCityPlan,
  isCity,
  nearestCityGate,
} from './city';
import {
  cityRarityRoll,
  SETTLEMENT_CLASS_CITY,
  SETTLEMENT_CLASS_VILLAGE,
  type RegionRoadField,
  type Settlement,
} from './roads';
import { buildWallSurface } from './wall-mesh';

const SEED = 0x51c1_7e57;
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

describe('CityPlan', () => {
  it('is byte-deterministic after cache eviction', () => {
    clearCityCache();
    const first = generateCityPlan(CITY, SEED);
    clearCityCache();
    const again = generateCityPlan({ ...CITY }, SEED);
    expect(Array.from(again.wallX)).toEqual(Array.from(first.wallX));
    expect(Array.from(again.wallZ)).toEqual(Array.from(first.wallZ));
    expect(Array.from(again.gateIndex)).toEqual(Array.from(first.gateIndex));
    expect(Array.from(again.nodeX)).toEqual(Array.from(first.nodeX));
    expect(Array.from(again.landmarkKind)).toEqual(Array.from(first.landmarkKind));
  });

  it('classifies only city settlements', () => {
    expect(isCity(CITY)).toBe(true);
    expect(isCity({ ...CITY, class: SETTLEMENT_CLASS_VILLAGE })).toBe(false);
  });

  it('returns the nearest gate to a road approach', () => {
    const plan = generateCityPlan(CITY, SEED);
    const targetX = CITY.x + 2_000;
    const targetZ = CITY.z;
    const nearest = nearestCityGate(plan, targetX, targetZ);
    const distances = Array.from(plan.gateIndex, (index) => {
      const dx = (plan.wallX[index] as number) - targetX;
      const dz = (plan.wallZ[index] as number) - targetZ;
      return dx * dx + dz * dz;
    });
    const chosen = (nearest.x - targetX) ** 2 + (nearest.z - targetZ) ** 2;
    expect(chosen).toBe(Math.min(...distances));
  });

  it('the rarity roll produces cities without making every settlement a city', () => {
    let cities = 0;
    let candidates = 0;
    for (let cellX = -50; cellX <= 50; cellX++) {
      for (let cellZ = -50; cellZ <= 50; cellZ++) {
        candidates++;
        if (cityRarityRoll(cellX, cellZ, SEED, 1)) cities++;
      }
    }
    expect(cities).toBeGreaterThan(0);
    expect(cities).toBeLessThan(candidates);
    expect(cityRarityRoll(0, 0, SEED, 0)).toBe(false);
  });

  it('emits non-empty wall geometry in a city wall chunk', () => {
    const plan = generateCityPlan(CITY, SEED);
    const segment = 1;
    const midX = ((plan.wallX[segment] as number) + (plan.wallX[segment + 1] as number)) * 0.5;
    const midZ = ((plan.wallZ[segment] as number) + (plan.wallZ[segment + 1] as number)) * 0.5;
    const coord: ChunkCoord = { x: Math.floor(midX / 64), z: Math.floor(midZ / 64), lod: 0 };
    const network = {
      worldSeed: SEED,
      settlements: [CITY],
    };
    const roads = {
      networkAt: () => network,
    } as unknown as RegionRoadField;
    const surface = buildWallSurface(coord, roads, () => CITY.y);
    expect(surface.count).toBeGreaterThan(0);
    expect(surface.positions.length).toBeGreaterThan(0);
    expect(surface.indices.length).toBeGreaterThan(0);
  });
});
