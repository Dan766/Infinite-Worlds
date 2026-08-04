/**
 * Tests for Phase 4a: settlement siting, the road graph, and the grading.
 *
 * Three kinds of test live here, deliberately separate.
 *
 * SYNTHETIC TERRAIN. A ridge with a notch in it has exactly one right answer for
 * "where does the road cross", so the router can be asserted rather than
 * described. Nothing about `height-field.ts` is involved: if these fail, the
 * algorithm is wrong, not the noise.
 *
 * PURE GEOMETRY. The Gabriel graph is decided by arithmetic on a point set, so
 * its locality -- the property chosen over an MST's optimality -- is assertable
 * directly, with no terrain at all.
 *
 * THE REAL WORLD. Determinism, the memo, region-boundary agreement and "roads
 * yield to rivers" are claims about the world this project ships, so they are
 * asserted against the actual height field.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { createTierContext, REGION_SIZE } from './contracts';
import { ROAD_MAX_CUT, ROAD_MAX_FILL, ROAD_RIVER_YIELD } from './grading';
import { baseHeight, SEA_LEVEL, sampleHeight, worldRegionField } from './height-field';
import { regionRiverField } from './rivers';
import {
  clearRoadCache,
  gabrielEdges,
  generateRegionRoads,
  regionRoadField,
  regionRoads,
  roadCacheStats,
  routeRoadBetween,
  settlementScore,
  ROAD_CACHE_LIMIT,
  ROAD_CELL,
  ROAD_HALF_WIDTH_MAX,
  ROAD_MAX_EDGE,
  ROAD_MAX_GRADE,
  ROAD_SHOULDER,
  SETTLEMENT_CELL,
  SETTLEMENT_MIN_ALTITUDE,
  type RoadNetwork,
  type RoadRivers,
  type RoadTerrain,
  type Settlement,
} from './roads';

const SEED = hashString('roads-test');

/** The real world, as routing sees it. Matches the constant in `height-field.ts`. */
const WORLD: RoadTerrain = { id: 'test-world', seaLevel: SEA_LEVEL, height: baseHeight };
const WORLD_RIVERS: RoadRivers = regionRiverField(WORLD, SEED);

/** No rivers anywhere: isolates the router from the crossing penalty. */
const NO_RIVERS: RoadRivers = { drop: () => 0 };

const regionContext = (seed = SEED): ReturnType<typeof createTierContext> =>
  createTierContext(seed, 'region');

function site(x: number, z: number, y = 0, score = 0.7): Settlement {
  return {
    cellX: Math.floor(x / SETTLEMENT_CELL),
    cellZ: Math.floor(z / SETTLEMENT_CELL),
    x,
    z,
    y,
    score,
    radius: 100,
    class: 0,
    wallRadius: 0,
    farmRadius: 0,
  };
}

// ---------------------------------------------------------------------------
// RULE 3: nothing coarse reads anything fine, and nothing reads its own tier
// ---------------------------------------------------------------------------

describe('RULE 3', () => {
  it('refuses to run on anything but a region context', () => {
    for (const tier of ['chunk', 'sector'] as const) {
      expect(() =>
        generateRegionRoads({ x: 0, z: 0 }, createTierContext(SEED, tier), WORLD, NO_RIVERS),
      ).toThrow(/needs a 'region' TierContext/);
    }
  });

  it('cannot read any finer tier, or its own', () => {
    // Enforced by the context rather than by review: nothing is coarser than a
    // region, so EVERY `coarser()` call from inside the generator throws. This
    // is also why rivers arrive as an argument -- they are the same tier, and
    // `coarser('region')` would throw for them too.
    const context = createTierContext(SEED, 'region');
    for (const tier of ['region', 'sector', 'chunk'] as const) {
      expect(() => context.coarser(tier)).toThrow(/Tier rule violation/);
    }
  });

  it('routes from the PRE-CARVE surface only', () => {
    // The circular-dependency guard, in the same form `rivers.test.ts` uses:
    // hand routing a terrain that counts its calls, evaluate the GRADED field
    // hundreds of times in between, and demand both the same call count and the
    // same network back. If the router read `sampleHeight` it would be reading
    // its own output and the answer would depend on how often it had been
    // evaluated.
    let calls = 0;
    const counted: RoadTerrain = {
      id: 'counted',
      seaLevel: SEA_LEVEL,
      height: (x, z, seed) => {
        calls++;
        return baseHeight(x, z, seed);
      },
    };
    const first = generateRegionRoads({ x: 0, z: 0 }, regionContext(), counted, NO_RIVERS);
    const callsForOne = calls;
    for (let i = 0; i < 200; i++) sampleHeight(i * 13.7, i * -9.1, SEED);
    const second = generateRegionRoads({ x: 0, z: 0 }, regionContext(), counted, NO_RIVERS);
    expect(calls - callsForOne).toBe(callsForOne);
    expect(Array.from(second.nodeX)).toEqual(Array.from(first.nodeX));
    expect(Array.from(second.nodeY)).toEqual(Array.from(first.nodeY));
  });
});

// ---------------------------------------------------------------------------
// The router, on terrain whose right answer is known
// ---------------------------------------------------------------------------

/**
 * A wall 300 m tall running along x = 0, with a saddle at z = 0.
 *
 * `across` is 1 on the ridge line and 0 more than 400 m from it; `notch` is 0 at
 * z = 0 and 1 beyond 600 m. So the only cheap way over the wall is through the
 * notch, and a router that ignores slope will go straight instead.
 */
const RIDGE: RoadTerrain = {
  id: 'ridge',
  seaLevel: -5000,
  height: (x, z) => {
    const across = Math.max(0, 1 - Math.abs(x) / 400);
    const notch = Math.min(1, Math.abs(z) / 600);
    return 300 * across * notch;
  },
};

/** Dead flat. A road here has no reason to be anything but straight. */
const PLAIN: RoadTerrain = { id: 'plain', seaLevel: -5000, height: () => 10 };

function pathLength(path: { x: number[]; z: number[] }): number {
  let total = 0;
  for (let i = 1; i < path.x.length; i++) {
    const dx = (path.x[i] as number) - (path.x[i - 1] as number);
    const dz = (path.z[i] as number) - (path.z[i - 1] as number);
    total += Math.sqrt(dx * dx + dz * dz);
  }
  return total;
}

describe('routing on synthetic terrain', () => {
  it('crosses a ridge at its saddle rather than straight over the top', () => {
    const a = site(-1200, 500, 0);
    const b = site(1200, 500, 0);
    const path = routeRoadBetween(a, b, SEED, RIDGE, NO_RIVERS);
    expect(path).toBeDefined();

    // Where the road crosses the ridge line, it should have moved toward the
    // notch. Straight over would cross at z = 500, where the wall is 250 m tall.
    let crossingZ = Infinity;
    for (let i = 0; i < path!.x.length; i++) {
      if (Math.abs(path!.x[i] as number) <= ROAD_CELL) {
        crossingZ = Math.min(crossingZ, Math.abs(path!.z[i] as number));
      }
    }
    expect(crossingZ).toBeLessThan(300);
  });

  it('runs nearly straight where the ground is flat', () => {
    const a = site(-1000, 0, 10);
    const b = site(1000, 400, 10);
    const path = routeRoadBetween(a, b, SEED, PLAIN, NO_RIVERS)!;
    const straight = Math.sqrt(2000 * 2000 + 400 * 400);
    // Some slack for the 128 m lattice and the smoothing pass, but a wandering
    // router would be far worse than 12%.
    expect(pathLength(path)).toBeLessThan(straight * 1.12);
  });

  it('starts and ends exactly at the settlements it serves', () => {
    const a = site(-900, 120, 10);
    const b = site(760, -430, 10);
    const path = routeRoadBetween(a, b, SEED, PLAIN, NO_RIVERS)!;
    expect(path.x[0]).toBe(a.x);
    expect(path.z[0]).toBe(a.z);
    expect(path.x[path.x.length - 1]).toBe(b.x);
    expect(path.z[path.z.length - 1]).toBe(b.z);
  });

  it('refuses to route across open sea', () => {
    const island: RoadTerrain = {
      id: 'island',
      seaLevel: 0,
      // Land only within 300 m of each settlement; deep water in between.
      height: (x) => (Math.abs(x + 1000) < 300 || Math.abs(x - 1000) < 300 ? 20 : -40),
    };
    expect(routeRoadBetween(site(-1000, 0, 20), site(1000, 0, 20), SEED, island, NO_RIVERS)).toBe(
      undefined,
    );
  });

  it('is a pure function of its endpoints and terrain', () => {
    const a = site(-1100, 260, 0);
    const b = site(900, -180, 0);
    const once = routeRoadBetween(a, b, SEED, RIDGE, NO_RIVERS)!;
    const twice = routeRoadBetween(a, b, SEED, RIDGE, NO_RIVERS)!;
    expect(twice.x).toEqual(once.x);
    expect(twice.z).toEqual(once.z);
  });
});

// ---------------------------------------------------------------------------
// The Gabriel graph: the property an MST does not have
// ---------------------------------------------------------------------------

describe('the road graph', () => {
  it('joins two settlements with nothing between them', () => {
    expect(gabrielEdges([site(0, 0), site(800, 0)])).toEqual([[0, 1]]);
  });

  it('drops the long edge of a collinear triple, keeping the two short ones', () => {
    // c sits inside the disc on (a, b), so a-b is not a Gabriel edge.
    const edges = gabrielEdges([site(0, 0), site(1200, 0), site(600, 0)]);
    expect(edges).toContainEqual([0, 2]);
    expect(edges).toContainEqual([1, 2]);
    expect(edges).not.toContainEqual([0, 1]);
  });

  it('never joins settlements further apart than ROAD_MAX_EDGE', () => {
    const edges = gabrielEdges([site(0, 0), site(ROAD_MAX_EDGE + 10, 0)]);
    expect(edges).toEqual([]);
  });

  it('is LOCAL: a distant settlement cannot change a nearby edge', () => {
    // THE WHOLE REASON GABRIEL WAS CHOSEN OVER A MINIMUM SPANNING TREE. Two
    // regions see overlapping but different settlement sets, so an edge near
    // their shared boundary must be decidable without knowing about settlements
    // far away. An MST fails this by construction: adding one distant point can
    // re-route edges arbitrarily far off, and no amount of padding fixes it.
    const near = [site(0, 0), site(700, 100), site(200, 900)];
    const before = gabrielEdges(near);
    const after = gabrielEdges([...near, site(9000, 9000), site(-8000, 7000)]);
    for (const edge of before) expect(after).toContainEqual(edge);
    expect(after.filter(([i, j]) => i < 3 && j < 3)).toEqual(before);
  });

  it('is symmetric in the order settlements are listed', () => {
    const points = [site(0, 0), site(900, 120), site(300, 800), site(1100, 900)];
    const forward = gabrielEdges(points).length;
    const backward = gabrielEdges([...points].reverse()).length;
    expect(backward).toBe(forward);
  });
});

// ---------------------------------------------------------------------------
// Settlement siting
// ---------------------------------------------------------------------------

describe('settlement siting', () => {
  it('scores nothing below sea level, or barely above it', () => {
    const sea: RoadTerrain = { id: 'sea', seaLevel: 0, height: () => -12 };
    expect(settlementScore(0, 0, SEED, sea, NO_RIVERS, 1)).toBe(0);
    const shallow: RoadTerrain = {
      id: 'shallow',
      seaLevel: 0,
      height: () => SETTLEMENT_MIN_ALTITUDE - 0.5,
    };
    expect(settlementScore(0, 0, SEED, shallow, NO_RIVERS, 1)).toBe(0);
  });

  it('prefers flat ground to a hillside', () => {
    const flat: RoadTerrain = { id: 'flat', seaLevel: 0, height: () => 40 };
    const steep: RoadTerrain = { id: 'steep', seaLevel: 0, height: (x) => 40 + x * 0.5 };
    expect(settlementScore(0, 0, SEED, flat, NO_RIVERS, 1)).toBeGreaterThan(
      settlementScore(0, 0, SEED, steep, NO_RIVERS, 1),
    );
  });

  it('scores nothing inside a river channel', () => {
    const flat: RoadTerrain = { id: 'flat', seaLevel: 0, height: () => 40 };
    const inChannel: RoadRivers = { drop: () => ROAD_RIVER_YIELD + 5 };
    expect(settlementScore(0, 0, SEED, flat, inChannel, 1)).toBe(0);
  });

  it('prefers a habitable climate', () => {
    const flat: RoadTerrain = { id: 'flat', seaLevel: 0, height: () => 40 };
    expect(settlementScore(0, 0, SEED, flat, NO_RIVERS, 1)).toBeGreaterThan(
      settlementScore(0, 0, SEED, flat, NO_RIVERS, 0),
    );
  });

  it('puts real settlements in the real world, above water and off the peaks', () => {
    // ANTI-VACUITY, and the most important assertion in this file. Every road
    // check here, in the soak and in the screenshot harness is worthless if the
    // world contains no settlements, and zero looks exactly like "none near
    // this region".
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    expect(net.settlements.length).toBeGreaterThan(2);
    for (const s of net.settlements) {
      expect(s.y).toBeGreaterThanOrEqual(SEA_LEVEL + SETTLEMENT_MIN_ALTITUDE);
      expect(s.radius).toBeGreaterThan(0);
      expect(baseHeight(s.x, s.z, SEED)).toBe(s.y);
    }
  });

  it('keeps settlements at least a lattice cell apart', () => {
    // The 3x3 local-maximum rule is what guarantees spacing, with no global
    // pass and therefore no dependence on which region is asking.
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    for (let i = 0; i < net.settlements.length; i++) {
      for (let j = i + 1; j < net.settlements.length; j++) {
        const a = net.settlements[i] as Settlement;
        const b = net.settlements[j] as Settlement;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(SETTLEMENT_CELL / 2);
      }
    }
  });

  it('builds actual roads between them', () => {
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    expect(net.edgeCount).toBeGreaterThan(2);
    expect(net.nodeX.length).toBeGreaterThan(20);
    expect(net.segNode.length / 2).toBeGreaterThan(15);
  });
});

// ---------------------------------------------------------------------------
// Determinism and the memo
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces an identical network from a cold cache (RULE 2)', () => {
    clearRoadCache();
    const first = regionRoads(WORLD, WORLD_RIVERS, () => 0.5, SEED, 0, 0);
    const snapshot = {
      x: Array.from(first.nodeX),
      z: Array.from(first.nodeZ),
      y: Array.from(first.nodeY),
      seg: Array.from(first.segNode),
      cross: Array.from(first.segCrossing),
    };
    clearRoadCache();
    const again = regionRoads(WORLD, WORLD_RIVERS, () => 0.5, SEED, 0, 0);
    expect(Array.from(again.nodeX)).toEqual(snapshot.x);
    expect(Array.from(again.nodeZ)).toEqual(snapshot.z);
    expect(Array.from(again.nodeY)).toEqual(snapshot.y);
    expect(Array.from(again.segNode)).toEqual(snapshot.seg);
    expect(Array.from(again.segCrossing)).toEqual(snapshot.cross);
  });

  it('is unaffected by eviction: the memo is invisible', () => {
    clearRoadCache();
    const before = Array.from(regionRoads(WORLD, WORLD_RIVERS, () => 0.5, SEED, 0, 0).nodeY);
    // Push the entry out several times over with unrelated regions.
    for (let i = 1; i <= ROAD_CACHE_LIMIT + 4; i++) {
      regionRoads(WORLD, WORLD_RIVERS, () => 0.5, SEED, i, -i);
    }
    expect(Array.from(regionRoads(WORLD, WORLD_RIVERS, () => 0.5, SEED, 0, 0).nodeY)).toEqual(
      before,
    );
  });

  it('never holds more than ROAD_CACHE_LIMIT entries', () => {
    clearRoadCache();
    for (let i = 0; i < ROAD_CACHE_LIMIT + 6; i++) {
      regionRoads(WORLD, WORLD_RIVERS, () => 0.5, SEED, i, 0);
      expect(roadCacheStats().entries).toBeLessThanOrEqual(ROAD_CACHE_LIMIT);
    }
  });

  it('produces different networks for different seeds', () => {
    const a = generateRegionRoads({ x: 0, z: 0 }, regionContext(SEED), WORLD, WORLD_RIVERS);
    const b = generateRegionRoads({ x: 0, z: 0 }, regionContext(SEED + 1), WORLD, WORLD_RIVERS);
    expect(Array.from(a.nodeX)).not.toEqual(Array.from(b.nodeX));
  });

  it('routes an edge identically standalone and inside a region', () => {
    // The claim the single-region query rests on. If a path depended on which
    // lattice it was searched in, two regions could disagree about a road and
    // the boundary would step.
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    const settlements = net.settlements;
    expect(settlements.length).toBeGreaterThan(1);
    const edges = gabrielEdges(settlements as Settlement[]);
    expect(edges.length).toBeGreaterThan(0);
    const [i, j] = edges[0] as [number, number];
    const standalone = routeRoadBetween(
      settlements[i] as Settlement,
      settlements[j] as Settlement,
      SEED,
      WORLD,
      WORLD_RIVERS,
    );
    expect(standalone).toBeDefined();
    // The region's own copy of that path must appear in its node list.
    const first = standalone!.x[0] as number;
    let found = false;
    for (let n = 0; n < net.nodeX.length; n++) {
      if (net.nodeX[n] === first && net.nodeZ[n] === (standalone!.z[0] as number)) found = true;
    }
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The grading
// ---------------------------------------------------------------------------

/** A point on a road in the real world, with the region it belongs to. */
function roadPoint(net: RoadNetwork): { x: number; z: number } {
  // A node well inside the region square, so the owning region is unambiguous.
  for (let n = 0; n < net.nodeX.length; n++) {
    const x = net.nodeX[n] as number;
    const z = net.nodeZ[n] as number;
    if (
      x > net.regionX * REGION_SIZE + 400 &&
      x < (net.regionX + 1) * REGION_SIZE - 400 &&
      z > net.regionZ * REGION_SIZE + 400 &&
      z < (net.regionZ + 1) * REGION_SIZE - 400
    ) {
      return { x, z };
    }
  }
  throw new Error('no interior road node: the fixture region has no roads in it');
}

describe('grading', () => {
  const field = () => regionRoadField(WORLD, WORLD_RIVERS, () => 0.5, SEED);

  it('moves the ground somewhere -- otherwise every grading test is vacuous', () => {
    // SCANNED, NOT SAMPLED AT ONE POINT, and the reason is a real property of
    // the design rather than test convenience: a road across flat ground needs
    // no earthwork, so its lift there is legitimately EXACTLY zero. Measured on
    // this seed the median road node moves the ground 0.00 m and the ninetieth
    // percentile moves 11 m. What must be true is that some of the network
    // benches the terrain, and that surfacing is present everywhere a road is.
    const roads = field();
    const net = roads.networkAt(1000, 1000);
    let moved = 0;
    let surfaced = 0;
    let checked = 0;
    for (let n = 0; n < net.nodeX.length; n++) {
      const x = net.nodeX[n] as number;
      const z = net.nodeZ[n] as number;
      if (x < 300 || x > REGION_SIZE - 300 || z < 300 || z > REGION_SIZE - 300) continue;
      const base = baseHeight(x, z, SEED);
      const drop = WORLD_RIVERS.drop(x, z, base);
      checked++;
      if (Math.abs(roads.lift(x, z, base - drop, drop)) > 0.25) moved++;
      if (roads.surface(x, z, drop) > 0.5) surfaced++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(moved).toBeGreaterThan(2);
    expect(surfaced).toBeGreaterThan(checked * 0.8);
  });

  it('never cuts deeper than ROAD_MAX_CUT or fills higher than ROAD_MAX_FILL', () => {
    const roads = field();
    for (let i = 0; i < 2000; i++) {
      const x = i * 3.1 - 2000;
      const z = i * 1.9 - 1500;
      const base = baseHeight(x, z, SEED);
      const drop = WORLD_RIVERS.drop(x, z, base);
      const lift = roads.lift(x, z, base - drop, drop);
      expect(lift).toBeGreaterThanOrEqual(-ROAD_MAX_CUT);
      expect(lift).toBeLessThanOrEqual(ROAD_MAX_FILL);
    }
  });

  it('is exactly zero inside a river channel: rivers win', () => {
    // THE COMPOSITION RULE, AND THE BRIDGE DEFERRAL, AS AN ASSERTION. A road
    // that filled a channel would raise the bed above the Phase 3a water
    // surface -- built from this very height grid -- and the river would run
    // over the top of the dam.
    const roads = field();
    for (let i = 0; i < 2000; i++) {
      const x = i * 5.3 - 4000;
      const z = i * -3.7 + 2500;
      const base = baseHeight(x, z, SEED);
      const drop = WORLD_RIVERS.drop(x, z, base);
      if (drop < ROAD_RIVER_YIELD) continue;
      expect(roads.lift(x, z, base - drop, drop)).toBe(0);
      expect(roads.surface(x, z, drop)).toBe(0);
    }
  });

  it('is exactly zero well away from any road', () => {
    // The taper must reach zero, not merely become small: a grading field that
    // never quite stops would move every vertex in the world by a hair and make
    // the whole terrain depend on the road memo.
    const roads = field();
    const net = roads.networkAt(1000, 1000);
    const p = roadPoint(net);
    let far = 0;
    for (const d of [500, 900, 1400]) {
      const x = p.x + d;
      const z = p.z + d;
      const base = baseHeight(x, z, SEED);
      const drop = WORLD_RIVERS.drop(x, z, base);
      if (roads.lift(x, z, base - drop, drop) === 0) far++;
    }
    expect(far).toBeGreaterThan(0);
  });

  it('holds a bounded gradient along a road', () => {
    // What makes a road read as an engineered bench rather than a stripe draped
    // over the terrain. The two end steps are excluded: the profile is pinned to
    // the settlements it serves, because a road has to meet the village.
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    let checked = 0;
    for (let path = 0; path + 1 < net.pathStart.length; path++) {
      const from = net.pathStart[path] as number;
      const to = net.pathStart[path + 1] as number;
      // Skip the first and last step of each road: the profile is pinned to the
      // settlements at its ends, because a road has to meet the village it
      // serves, and that pin can outrun the limiter over one 128 m step.
      for (let a = from + 1; a + 2 < to; a++) {
        const b = a + 1;
        const run = Math.hypot(
          (net.nodeX[b] as number) - (net.nodeX[a] as number),
          (net.nodeZ[b] as number) - (net.nodeZ[a] as number),
        );
        if (run < 1) continue;
        const rise = Math.abs((net.nodeY[b] as number) - (net.nodeY[a] as number));
        expect(rise / run).toBeLessThanOrEqual(ROAD_MAX_GRADE + 1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('records river crossings for Phase 5 to bridge', () => {
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    expect(net.segCrossing.length).toBe(net.segNode.length / 2);
    expect(net.crossingCount).toBe(net.segCrossing.reduce((a, b) => a + b, 0));
  });

  it('grades the ground toward the settlement it sits on', () => {
    const net = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    const s = net.settlements.find(
      (c) =>
        c.x > 400 && c.x < REGION_SIZE - 400 && c.z > 400 && c.z < REGION_SIZE - 400,
    );
    if (s === undefined) return;
    // At the centre of a settlement the ground is graded to the site altitude.
    expect(sampleHeight(s.x, s.z, SEED)).toBeCloseTo(s.y, 6);
  });
});

// ---------------------------------------------------------------------------
// Region boundaries
// ---------------------------------------------------------------------------

describe('region boundaries', () => {
  it('agrees exactly about a road either side of a shared edge', () => {
    // Roads need no cross-region blend BECAUSE of this: a path is a pure
    // function of its endpoints, and both regions route every edge that can
    // reach their shared boundary. If this fails, the single-region query in
    // `regionRoadField` is unsound and there IS a 4 km seam.
    const left = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    const right = generateRegionRoads({ x: 1, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);

    // Every node either region places near the shared boundary must exist, at
    // exactly the same position, in the other.
    const boundary = REGION_SIZE;
    const nodesNear = (net: RoadNetwork): string[] => {
      const out: string[] = [];
      for (let n = 0; n < net.nodeX.length; n++) {
        const x = net.nodeX[n] as number;
        if (Math.abs(x - boundary) > 200) continue;
        out.push(`${x},${net.nodeZ[n] as number},${net.nodeY[n] as number}`);
      }
      return out.sort();
    };
    const fromLeft = nodesNear(left);
    const fromRight = nodesNear(right);
    expect(fromLeft.length).toBeGreaterThan(0);
    for (const node of fromLeft) expect(fromRight).toContain(node);
  });

  it('is continuous across a region boundary', () => {
    // A 2 m step is the chunk vertex spacing. A discontinuity here is a cliff
    // along a 4 km line in the world.
    const roads = worldRegionField(SEED).roads;
    let worst = 0;
    for (let i = 0; i < 900; i++) {
      const z = i * 4.3 - 1000;
      const before = REGION_SIZE - 1;
      const after = REGION_SIZE + 1;
      const hb = sampleHeight(before, z, SEED);
      const ha = sampleHeight(after, z, SEED);
      worst = Math.max(worst, Math.abs(ha - hb));
      // And the road field itself, isolated from the terrain's own slope.
      const bb = baseHeight(before, z, SEED);
      const ba = baseHeight(after, z, SEED);
      const lb = roads.lift(before, z, bb, 0);
      const la = roads.lift(after, z, ba, 0);
      expect(Math.abs(la - lb)).toBeLessThan(1.5);
    }
    expect(worst).toBeLessThan(4);
  });

  it('sites the same settlement whichever region looks at it', () => {
    // The global lattice plus the 3x3 local-maximum rule. If siting depended on
    // the region, a village would appear twice or vanish at a boundary.
    const left = generateRegionRoads({ x: 0, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    const right = generateRegionRoads({ x: 1, z: 0 }, regionContext(), WORLD, WORLD_RIVERS);
    // Compared only inside the band BOTH regions keep. Each network prunes its
    // settlements to what can influence its own square (`ROAD_REACH` beyond it),
    // so a wider comparison would be asserting that two differently-pruned lists
    // are equal, which they are not meant to be.
    const near = (net: RoadNetwork): string[] =>
      net.settlements
        .filter((s) => Math.abs(s.x - REGION_SIZE) < 400)
        .map((s) => `${s.cellX},${s.cellZ},${s.x},${s.z},${s.radius}`)
        .sort();
    expect(near(left).length).toBeGreaterThan(0);
    expect(near(right)).toEqual(near(left));
  });
});

// ---------------------------------------------------------------------------
// The record chunks read
// ---------------------------------------------------------------------------

describe('the region record', () => {
  it('carries the seed it was built for', () => {
    expect(regionRoadField(WORLD, WORLD_RIVERS, () => 0.5, 12345).worldSeed).toBe(12345);
    expect(worldRegionField(SEED).worldSeed).toBe(SEED);
  });

  it('exposes rivers and roads in one region slot', () => {
    const region = worldRegionField(SEED);
    expect(region.rivers).toBeDefined();
    expect(region.roads).toBeDefined();
    expect(region.rivers.worldSeed).toBe(SEED);
    expect(region.roads.worldSeed).toBe(SEED);
  });

  it('writes lift and surface into a caller-owned pair', () => {
    // The hot path allocates nothing per vertex. If `grade` ever starts
    // returning an object, a chunk pays ~1,200 short-lived allocations.
    const roads = regionRoadField(WORLD, WORLD_RIVERS, () => 0.5, SEED);
    const net = roads.networkAt(1000, 1000);
    const p = roadPoint(net);
    const base = baseHeight(p.x, p.z, SEED);
    const drop = WORLD_RIVERS.drop(p.x, p.z, base);
    const out = new Float64Array(2);
    roads.grade(p.x, p.z, base - drop, drop, out);
    expect(out[0]).toBe(roads.lift(p.x, p.z, base - drop, drop));
    expect(out[1]).toBe(roads.surface(p.x, p.z, drop));
  });

  it('keeps the surfaced band narrower than the graded one', () => {
    // Surfacing is the roadbed; grading includes the shoulder that blends it
    // back into the terrain. If they were the same width the road would have a
    // hard edge where the ground is still moving.
    // Driven off a node where the road actually moves the ground, since on flat
    // ground the lift is legitimately zero everywhere and there would be nothing
    // to compare the surfaced band against.
    const roads = regionRoadField(WORLD, WORLD_RIVERS, () => 0.5, SEED);
    const net = roads.networkAt(1000, 1000);
    const edge = ROAD_HALF_WIDTH_MAX + ROAD_SHOULDER;
    let sawNarrower = false;
    for (let n = 0; n < net.nodeX.length && !sawNarrower; n++) {
      const x = net.nodeX[n] as number;
      const z = net.nodeZ[n] as number;
      if (x < 300 || x > REGION_SIZE - 300 || z < 300 || z > REGION_SIZE - 300) continue;
      const base = baseHeight(x, z, SEED);
      if (Math.abs(roads.lift(x, z, base, 0)) < 1) continue;
      for (let d = 0; d < edge; d += 0.5) {
        if (roads.surface(x + d, z, 0) === 0 && roads.lift(x + d, z, base, 0) !== 0) {
          sawNarrower = true;
          break;
        }
      }
    }
    expect(sawNarrower).toBe(true);
  });
});
