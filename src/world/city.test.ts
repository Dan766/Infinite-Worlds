import { describe, expect, it } from 'vitest';
import { type ChunkCoord } from './contracts';
import {
  clearCityCache,
  generateCityPlan,
  isCity,
  LANDMARK_GATEHOUSE,
  nearestCityGate,
  organicUnit,
  pickArchetype,
  type CityPlan,
} from './city';
import { ARCHETYPE_COUNT } from './culture';
import {
  SETTLEMENT_CLASS_CITY,
  SETTLEMENT_CLASS_HAMLET,
  SETTLEMENT_CLASS_TOWN,
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

/** Ray-casting point-in-polygon, over the plan's own closed wall centreline. */
function insideWall(plan: CityPlan, x: number, z: number): boolean {
  let inside = false;
  const n = plan.wallCount - 1; // last point duplicates the first
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = plan.wallX[i] as number;
    const zi = plan.wallZ[i] as number;
    const xj = plan.wallX[j] as number;
    const zj = plan.wallZ[j] as number;
    const crosses = zi > z !== zj > z;
    if (!crosses) continue;
    const xCross = xi + ((z - zi) / (zj - zi)) * (xj - xi);
    if (x < xCross) inside = !inside;
  }
  return inside;
}

function citySite(cellX: number, cellZ: number): Settlement {
  return {
    cellX,
    cellZ,
    x: cellX * 8192 + 4096,
    z: cellZ * 8192 + 4096,
    y: 20,
    score: 0.8,
    radius: 500,
    class: SETTLEMENT_CLASS_CITY,
    wallRadius: 500,
    farmRadius: 850,
  };
}

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
    // Phase Politics S1: hamlet/town were appended (2, 3) to the two existing
    // values (village 0, city 1) precisely so that a class value `isCity`
    // does not recognise stays exactly as unrecognised as a village always
    // was -- this is the regression guard for that.
    expect(isCity({ ...CITY, class: SETTLEMENT_CLASS_HAMLET })).toBe(false);
    expect(isCity({ ...CITY, class: SETTLEMENT_CLASS_TOWN })).toBe(false);
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

  // The old "rarity roll produces cities without making every settlement a
  // city" test lived here (`score >= 0.72 && hash % 7 === 0` on this file's
  // own settlement lattice). Phase Politics S1 deleted `cityRarityRoll`
  // itself -- cities are now sourced from `polity.ts`'s own coarse,
  // spacing-guaranteed lattice, injected into `roads.ts` rather than rolled
  // per-cell here. The equivalent coverage (cities exist, are not every
  // cell, and are never adjacent) lives in `polity.test.ts`'s "the 8 km
  // floor" and "containment" test groups.

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

describe('archetypes and the organic wall (Phase Politics C1)', () => {
  it('organicUnit stays in [0, 1) and is a pure function of its inputs', () => {
    for (let i = 0; i < 200; i++) {
      const t = i / 200;
      const u = organicUnit(7, -3, SEED, t);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(organicUnit(7, -3, SEED, t)).toBe(u);
    }
  });

  it('is continuous: adjacent samples never jump by more than one control-point step', () => {
    // Anti-vacuity for "smoothly interpolated": a generator that picked an
    // independent random value per sample would still satisfy [0, 1) above,
    // but would jump wildly between adjacent angles.
    let maxJump = 0;
    const steps = 400;
    let prev = organicUnit(11, 19, SEED, 0);
    for (let i = 1; i <= steps; i++) {
      const u = organicUnit(11, 19, SEED, i / steps);
      maxJump = Math.max(maxJump, Math.abs(u - prev));
      prev = u;
    }
    expect(maxJump).toBeLessThan(0.35);
  });

  it('pickArchetype is deterministic and every ARCH_* value appears over many cities', () => {
    const seen = new Set<number>();
    for (let cellX = 0; cellX < 60; cellX++) {
      const a = pickArchetype(cellX, 0, SEED);
      expect(pickArchetype(cellX, 0, SEED)).toBe(a);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(ARCHETYPE_COUNT);
      seen.add(a);
    }
    // Anti-vacuity: a `pickArchetype` that always returned 0 would pass every
    // assertion above perfectly.
    expect(seen.size).toBe(ARCHETYPE_COUNT);
  });

  it('two cities in different cells are not textbook-identical circles any more', () => {
    // The old wall was `R * (0.92..1.04)`, a near-perfect circle whose radius
    // barely varied. Compare the realised min/max wall radius spread across
    // several real cities and demand it is visibly wider than that.
    let anyWideSpread = false;
    for (let cellX = 0; cellX < 20; cellX++) {
      clearCityCache();
      const plan = generateCityPlan(citySite(cellX, cellX * 2 - 5), SEED);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < plan.wallCount - 1; i++) {
        const dx = (plan.wallX[i] as number) - plan.centerX;
        const dz = (plan.wallZ[i] as number) - plan.centerZ;
        const r = Math.sqrt(dx * dx + dz * dz);
        min = Math.min(min, r);
        max = Math.max(max, r);
      }
      if (max / min > 1.15) {
        anyWideSpread = true;
        break;
      }
    }
    expect(anyWideSpread).toBe(true);
  });

  it('every district and landmark stays strictly inside the wall polygon, across archetypes', () => {
    const archetypesSeen = new Set<number>();
    for (let cellX = 0; cellX < 40; cellX++) {
      const cellZ = cellX * 3 - 17;
      clearCityCache();
      const plan = generateCityPlan(citySite(cellX, cellZ), SEED);
      archetypesSeen.add(plan.archetype);
      for (let i = 0; i < plan.districtCount; i++) {
        const x = plan.districtX[i] as number;
        const z = plan.districtZ[i] as number;
        expect(insideWall(plan, x, z)).toBe(true);
      }
      for (let i = 0; i < plan.landmarkCount; i++) {
        // Gatehouses are deliberately placed AT the wall (`wallX[gateIndex]`
        // exactly), not inside it -- the one landmark kind this claim
        // doesn't apply to.
        if ((plan.landmarkKind[i] as number) === LANDMARK_GATEHOUSE) continue;
        const x = plan.landmarkX[i] as number;
        const z = plan.landmarkZ[i] as number;
        expect(insideWall(plan, x, z)).toBe(true);
      }
    }
    // Anti-vacuity: the containment claim is only interesting if it was
    // actually checked against more than one archetype's wall shape.
    expect(archetypesSeen.size).toBeGreaterThan(1);
  });

  it('street network total length is comparable across archetypes, not dramatically sparser for any one', () => {
    // city-density.test.ts's floors are calibrated against WHICHEVER city a
    // seed's citiesInBox finds first -- so no archetype's street network may
    // be dramatically sparser than another's, or that test would flake
    // depending on which archetype happened to be "first" on a given seed.
    const totalByArchetype = new Map<number, number>();
    for (let cellX = 0; cellX < 60; cellX++) {
      const cellZ = cellX * 7 - 29;
      clearCityCache();
      const plan = generateCityPlan(citySite(cellX, cellZ), SEED);
      let length = 0;
      for (let s = 0; s < plan.streetCount; s++) {
        const from = plan.streetStart[s] as number;
        const to = plan.streetStart[s + 1] as number;
        for (let i = from; i + 1 < to; i++) {
          const dx = (plan.nodeX[i + 1] as number) - (plan.nodeX[i] as number);
          const dz = (plan.nodeZ[i + 1] as number) - (plan.nodeZ[i] as number);
          length += Math.sqrt(dx * dx + dz * dz);
        }
      }
      const prior = totalByArchetype.get(plan.archetype);
      if (prior === undefined || length > prior) totalByArchetype.set(plan.archetype, length);
    }
    expect(totalByArchetype.size).toBeGreaterThan(1);
    const totals = Array.from(totalByArchetype.values());
    const min = Math.min(...totals);
    const max = Math.max(...totals);
    // Anti-vacuity: this ratio is only meaningful if more than one archetype
    // was actually sampled, asserted above.
    expect(min / max).toBeGreaterThan(0.4);
  });

  it('the wall stays closed and has no degenerate (NaN/non-finite) vertex, across archetypes', () => {
    for (let cellX = 0; cellX < 40; cellX++) {
      const cellZ = cellX * 5 - 11;
      clearCityCache();
      const plan = generateCityPlan(citySite(cellX, cellZ), SEED);
      expect(plan.wallX[plan.wallCount - 1]).toBe(plan.wallX[0]);
      expect(plan.wallZ[plan.wallCount - 1]).toBe(plan.wallZ[0]);
      for (let i = 0; i < plan.wallCount; i++) {
        expect(Number.isFinite(plan.wallX[i] as number)).toBe(true);
        expect(Number.isFinite(plan.wallZ[i] as number)).toBe(true);
      }
    }
  });
});
