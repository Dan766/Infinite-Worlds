/**
 * Tests for Phase 9a/9b: NPC crowds.
 *
 * Two kinds, following `lots.test.ts`'s split: DETERMINISM (birth purity,
 * step purity, replay identity -- none of which need the real height field)
 * and THE REAL WORLD (a crowd born over an actual village or city, where the
 * claims worth checking -- "every agent stays near a real street", "nobody
 * ends up inside a building" -- cannot be checked against a synthetic plan).
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { worldRegionField, worldSectorField, type RegionField } from './height-field';
import { generateCityPlan, isCity, type CityPlan } from './city';
import { collidesWithLots, pointSegmentDistanceSq } from './collision';
import { SECTOR_SIZE } from './contracts';
import type { SectorLots } from './lots';
import type { Settlement } from './roads';
import type { SectorStreets } from './streets';
import {
  birthCrowd,
  NO_COLLISION,
  NPC_ARRIVE_EPS,
  NPC_RADIUS,
  ROLE_CHILD,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_VILLAGER,
  stepCrowd,
  type NpcCollision,
} from './npcs';

const SEED = hashString('npcs-test');

const region = (seed = SEED): RegionField => worldRegionField(seed);
function sectors(seed = SEED): ReturnType<typeof worldSectorField> {
  return worldSectorField(region(seed), seed);
}

/** A real village sector: streets + lots, both non-empty, not a city. */
function findVillage(seed = SEED, x0 = -6, z0 = -6, count = 14): { streets: SectorStreets; lots: SectorLots } | undefined {
  const field = sectors(seed);
  for (let z = z0; z < z0 + count; z++) {
    for (let x = x0; x < x0 + count; x++) {
      const lots = field.lots.lotsAt(x, z);
      if (lots.count === 0 || lots.settlement === undefined || isCity(lots.settlement)) continue;
      const streets = field.streets.streetsAt(x, z);
      return { streets, lots };
    }
  }
  return undefined;
}

/**
 * A synthetic city site and its real, generated `CityPlan` -- the same
 * approach `city.test.ts`'s own `citySite` helper uses, rather than
 * searching for one of the rare real-sited cities. `generateCityPlan` is the
 * real, pure generator; what is fabricated is only which `Settlement` it is
 * asked to build a plan for.
 */
function syntheticCitySite(): { site: Settlement; plan: CityPlan } {
  const site: Settlement = {
    cellX: 3,
    cellZ: -2,
    x: 3 * 8192 + 4096,
    z: -2 * 8192 + 4096,
    y: 20,
    score: 0.8,
    radius: 500,
    class: 1,
    wallRadius: 500,
    farmRadius: 850,
  };
  return { site, plan: generateCityPlan(site, SEED) };
}

const TERRAIN = { id: 'npcs-test', seaLevel: 0, height: () => 0 } as const;

const village = findVillage();

describe('birthCrowd -- determinism', () => {
  it('is a pure function of its inputs', () => {
    if (village === undefined) throw new Error('fixture: no village found in the searched block');
    const a = birthCrowd(SEED, village.streets.sectorX, village.streets.sectorZ, village.streets, village.lots, 100);
    const b = birthCrowd(SEED, village.streets.sectorX, village.streets.sectorZ, village.streets, village.lots, 100);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.posX)).toEqual(Array.from(b.posX));
    expect(Array.from(a.role)).toEqual(Array.from(b.role));
    expect(Array.from(a.speed)).toEqual(Array.from(b.speed));
  });

  it('produces a non-vacuous roster over a real village', () => {
    if (village === undefined) throw new Error('fixture: no village found in the searched block');
    const state = birthCrowd(SEED, village.streets.sectorX, village.streets.sectorZ, village.streets, village.lots, 0);
    expect(state.count).toBeGreaterThan(0);
    expect(state.count).toBeLessThanOrEqual(village.lots.count);
  });

  it('places every agent within eps of a real street node', () => {
    if (village === undefined) throw new Error('fixture: no village found in the searched block');
    const state = birthCrowd(SEED, village.streets.sectorX, village.streets.sectorZ, village.streets, village.lots, 0);
    for (let i = 0; i < state.count; i++) {
      let best = Infinity;
      for (let s = 0; s < village.streets.streetCount; s++) {
        const from = village.streets.streetStart[s] as number;
        const to = village.streets.streetStart[s + 1] as number;
        for (let j = from; j + 1 < to; j++) {
          const d = pointSegmentDistanceSq(
            state.posX[i] as number,
            state.posZ[i] as number,
            village.streets.nodeX[j] as number,
            village.streets.nodeZ[j] as number,
            village.streets.nodeX[j + 1] as number,
            village.streets.nodeZ[j + 1] as number,
          );
          if (d < best) best = d;
        }
      }
      expect(Math.sqrt(best)).toBeLessThan(1);
    }
  });

  it('rolls children but no guards in a village (guards are city-only)', () => {
    if (village === undefined) throw new Error('fixture: no village found in the searched block');
    const state = birthCrowd(SEED, village.streets.sectorX, village.streets.sectorZ, village.streets, village.lots, 0);
    expect(Array.from(state.role)).not.toContain(ROLE_GUARD);
  });

  it('births a guard at every gate its owning sector contains', () => {
    const { site, plan } = syntheticCitySite();
    expect(plan.gateCount).toBeGreaterThan(0); // anti-vacuity: this city really has gates

    // Two gates can land in the same sector (a curtain often spans more than
    // one 512 m square), so the sectors actually worth birthing are the
    // DISTINCT ones -- birthing the same sector twice would double-count its
    // guards, which is a test bug, not a `birthCrowd` one.
    const uniqueSectors = new Map<string, { sectorX: number; sectorZ: number; gateX: number; gateZ: number }>();
    for (let g = 0; g < plan.gateCount; g++) {
      const wi = plan.gateIndex[g] as number;
      const gx = plan.wallX[wi] as number;
      const gz = plan.wallZ[wi] as number;
      const sectorX = Math.floor(gx / SECTOR_SIZE);
      const sectorZ = Math.floor(gz / SECTOR_SIZE);
      uniqueSectors.set(`${sectorX},${sectorZ}`, { sectorX, sectorZ, gateX: gx, gateZ: gz });
    }

    let guardsFound = 0;
    for (const { sectorX, sectorZ, gateX: gx, gateZ: gz } of uniqueSectors.values()) {
      // A minimal but non-empty synthetic street/lot record for the owning
      // sector -- only `settlement` and `count` need to be real; guards route
      // over their own ad hoc graph nodes, not the street CSR.
      const streets: SectorStreets = {
        terrain: TERRAIN,
        worldSeed: SEED,
        sectorX,
        sectorZ,
        settlement: site,
        nodeX: new Float64Array(0),
        nodeZ: new Float64Array(0),
        nodeY: new Float64Array(0),
        streetStart: new Int32Array(1),
        streetCount: 0,
        segCount: 0,
        halfWidth: 2.6,
        reachRadius: 0,
        layout: -1,
      };
      const lots: SectorLots = {
        terrain: TERRAIN,
        worldSeed: SEED,
        sectorX,
        sectorZ,
        settlement: site,
        centerX: Float64Array.from([gx]),
        centerZ: Float64Array.from([gz]),
        floorY: Float64Array.from([site.y]),
        alongX: Float64Array.from([1]),
        alongZ: Float64Array.from([0]),
        halfWidth: Float64Array.from([1]),
        halfDepth: Float64Array.from([1]),
        eaves: Float64Array.from([3]),
        ridge: Float64Array.from([1]),
        wallTint: Float64Array.from([0]),
        roofTint: Float64Array.from([0]),
        kind: Uint8Array.from([3]),
        count: 1,
        reachRadius: 0,
      };

      const state = birthCrowd(SEED, sectorX, sectorZ, streets, lots, 0, plan);
      guardsFound += Array.from(state.role).filter((r) => r === ROLE_GUARD).length;
    }
    expect(guardsFound).toBe(plan.gateCount);
  });

  it('empty inputs produce an empty, harmless crowd', () => {
    const empty = birthCrowd(SEED, 999, 999, {
      terrain: { id: 'x', seaLevel: 0, height: () => 0 },
      worldSeed: SEED,
      sectorX: 999,
      sectorZ: 999,
      settlement: undefined,
      nodeX: new Float64Array(0),
      nodeZ: new Float64Array(0),
      nodeY: new Float64Array(0),
      streetStart: new Int32Array(1),
      streetCount: 0,
      segCount: 0,
      halfWidth: 2.6,
      reachRadius: 0,
      layout: -1,
    }, {
      terrain: { id: 'x', seaLevel: 0, height: () => 0 },
      worldSeed: SEED,
      sectorX: 999,
      sectorZ: 999,
      settlement: undefined,
      centerX: new Float64Array(0),
      centerZ: new Float64Array(0),
      floorY: new Float64Array(0),
      alongX: new Float64Array(0),
      alongZ: new Float64Array(0),
      halfWidth: new Float64Array(0),
      halfDepth: new Float64Array(0),
      eaves: new Float64Array(0),
      ridge: new Float64Array(0),
      wallTint: new Float64Array(0),
      roofTint: new Float64Array(0),
      kind: new Uint8Array(0),
      count: 0,
      reachRadius: 0,
    }, 0);
    expect(empty.count).toBe(0);
    const stepped = stepCrowd(empty, 1, 0, 0, NO_COLLISION);
    expect(stepped.state.count).toBe(0);
    expect(stepped.arrived).toBe(0);
    expect(stepped.moved).toBe(0);
  });
});

describe('stepCrowd -- determinism', () => {
  if (village === undefined) throw new Error('fixture: no village found in the searched block');
  const streets = village.streets;
  const lots = village.lots;

  const collisionFor = (): NpcCollision => ({
    blocked: (x, z, r) => collidesWithLots(x, z, r, lots),
  });

  it('is a pure function of (state, tick, player position, collision)', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    const a = stepCrowd(birth, 1, 100, 100, collisionFor());
    const b = stepCrowd(birth, 1, 100, 100, collisionFor());
    expect(Array.from(a.state.posX)).toEqual(Array.from(b.state.posX));
    expect(a.arrived).toBe(b.arrived);
    expect(a.moved).toBe(b.moved);
  });

  it('does not mutate the input state', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    const posXBefore = Array.from(birth.posX);
    stepCrowd(birth, 1, 100, 100, collisionFor());
    expect(Array.from(birth.posX)).toEqual(posXBefore);
  });

  it('replays 500 ticks identically from the same birth', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    const collision = collisionFor();

    const replay = (): ReturnType<typeof stepCrowd>['state'] => {
      let state = birth;
      for (let t = 1; t <= 500; t++) {
        state = stepCrowd(state, t, 200, 200, collision).state;
      }
      return state;
    };

    const a = replay();
    const b = replay();
    expect(Array.from(a.posX)).toEqual(Array.from(b.posX));
    expect(Array.from(a.posZ)).toEqual(Array.from(b.posZ));
    expect(Array.from(a.headX)).toEqual(Array.from(b.headX));
  });

  it('produces real movement over 500 ticks -- a frozen crowd would fail this', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    const collision = collisionFor();
    let state = birth;
    let totalMoved = 0;
    let totalArrived = 0;
    for (let t = 1; t <= 500; t++) {
      const result = stepCrowd(state, t, -9999, -9999, collision);
      state = result.state;
      totalMoved += result.moved;
      totalArrived += result.arrived;
    }
    expect(totalMoved).toBeGreaterThan(0);
    // At >=1 m/s over 500 ticks (~8.3s), at least some agents should reach a goal.
    expect(totalArrived).toBeGreaterThan(0);
  });

  it('never steps an agent into a building it collides with', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    const collision = collisionFor();
    let state = birth;
    for (let t = 1; t <= 300; t++) {
      state = stepCrowd(state, t, -9999, -9999, collision).state;
      for (let i = 0; i < state.count; i++) {
        expect(
          collidesWithLots(state.posX[i] as number, state.posZ[i] as number, NPC_RADIUS - 0.01, lots),
        ).toBe(false);
      }
    }
  });

  it('keeps every agent within a sane radius of the settlement centre', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    const site = streets.settlement;
    if (site === undefined) throw new Error('fixture lost its settlement');
    const collision = collisionFor();
    let state = birth;
    for (let t = 1; t <= 300; t++) {
      state = stepCrowd(state, t, -9999, -9999, collision).state;
    }
    const bound = streets.reachRadius + NPC_ARRIVE_EPS + 5;
    for (let i = 0; i < state.count; i++) {
      const dx = (state.posX[i] as number) - site.x;
      const dz = (state.posZ[i] as number) - site.z;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThan(bound);
    }
  });

  it('role mix stays within villager/child/merchant for a village', () => {
    const birth = birthCrowd(SEED, streets.sectorX, streets.sectorZ, streets, lots, 0);
    for (let i = 0; i < birth.count; i++) {
      expect([ROLE_VILLAGER, ROLE_CHILD, ROLE_MERCHANT]).toContain(birth.role[i]);
    }
  });
});
