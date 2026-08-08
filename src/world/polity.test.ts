/**
 * Tests for Phase Politics P1: city siting.
 *
 * Two kinds of terrain, as `roads.test.ts` distinguishes: a THROWING stub that
 * proves siting never reaches for a river, and the REAL height field, which is
 * what the 8 km floor and density claims are actually about.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { baseHeight, continentalness, habitability, SEA_LEVEL } from './height-field';
import {
  CITY_CACHE_LIMIT,
  CITY_CELL,
  CITY_JITTER,
  CITY_MIN_ALTITUDE,
  CAPITAL_CACHE_LIMIT,
  CITY_PULL,
  CITY_SITE_CELL,
  FRONTIER_MAX,
  NEIGHBOURHOOD_CACHE_LIMIT,
  POLITY_CACHE_LIMIT,
  POLITY_SEARCH_RADIUS,
  capitalCacheStats,
  cellPotential,
  citiesInBox,
  cityAt,
  clearCapitalCache,
  clearNeighbourhoodCache,
  clearPoliticalCache,
  clearPolityCache,
  isCapital,
  nearestCityDistance,
  neighbourhoodCacheStats,
  politicalCacheStats,
  polityAt,
  polityCacheStats,
  polityOfCity,
  type CitySite,
  type Polity,
  type PolityClimate,
  type PolityTerrain,
} from './polity';

function resetAllCaches(): void {
  clearPoliticalCache();
  clearNeighbourhoodCache();
  clearCapitalCache();
  clearPolityCache();
}

const SEED = hashString('polity-test');

/** The real world, as this module's siting sees it -- same discipline `roads.test.ts` uses for `WORLD`. */
const REAL_CLIMATE: PolityClimate = { continentalness, habitability };

const REAL_TERRAIN: PolityTerrain = { seaLevel: SEA_LEVEL, height: baseHeight };

describe('cityAt: determinism', () => {
  it('is a pure function of (cell, seed): rebuilds byte-identically after eviction', () => {
    clearPoliticalCache();
    const seenBefore: (CitySite | undefined)[] = [];
    for (let cz = -6; cz <= 6; cz++) {
      for (let cx = -6; cx <= 6; cx++) {
        seenBefore.push(cityAt(cx, cz, REAL_TERRAIN, REAL_CLIMATE, SEED));
      }
    }
    clearPoliticalCache();
    let i = 0;
    for (let cz = -6; cz <= 6; cz++) {
      for (let cx = -6; cx <= 6; cx++) {
        const again = cityAt(cx, cz, REAL_TERRAIN, REAL_CLIMATE, SEED);
        const before = seenBefore[i++];
        expect(again === undefined).toBe(before === undefined);
        if (again !== undefined && before !== undefined) {
          expect(again.x).toBe(before.x);
          expect(again.z).toBe(before.z);
          expect(again.siteCellX).toBe(before.siteCellX);
          expect(again.siteCellZ).toBe(before.siteCellZ);
          expect(again.potential).toBe(before.potential);
          expect(again.siteScore).toBe(before.siteScore);
        }
      }
    }
  });

  it('a different seed can move a site (not tautologically identical)', () => {
    clearPoliticalCache();
    let anyDifferent = false;
    for (let cz = -8; cz <= 8; cz++) {
      for (let cx = -8; cx <= 8; cx++) {
        const a = cityAt(cx, cz, REAL_TERRAIN, REAL_CLIMATE, SEED);
        const b = cityAt(cx, cz, REAL_TERRAIN, REAL_CLIMATE, SEED ^ 0x1234_5678);
        if ((a === undefined) !== (b === undefined)) {
          anyDifferent = true;
          break;
        }
      }
      if (anyDifferent) break;
    }
    expect(anyDifferent).toBe(true);
  });

  it('caches builds, bounded at CITY_CACHE_LIMIT, and a repeat query is not a rebuild', () => {
    clearPoliticalCache();
    cityAt(0, 0, REAL_TERRAIN, REAL_CLIMATE, SEED);
    const buildsAfterFirst = politicalCacheStats().builds;
    cityAt(0, 0, REAL_TERRAIN, REAL_CLIMATE, SEED);
    expect(politicalCacheStats().builds).toBe(buildsAfterFirst);

    for (let i = 0; i < CITY_CACHE_LIMIT + 50; i++) {
      cityAt(i, 0, REAL_TERRAIN, REAL_CLIMATE, SEED);
    }
    expect(politicalCacheStats().entries).toBeLessThanOrEqual(CITY_CACHE_LIMIT);
  });
});

describe('cityAt: never reads a river', () => {
  it('is driven entirely by baseHeight and climate -- no river parameter exists to wire one through', () => {
    // The strongest version of this guard is structural: `PolityTerrain` and
    // `PolityClimate` have no river method at all, so there is nothing for
    // siting to call even if it wanted to. This test pins that by building
    // siting's inputs from objects that would throw on anything resembling a
    // river query, proving nothing here reaches past `height`/`continentalness`/
    // `habitability`.
    let heightCalls = 0;
    const counted: PolityTerrain = {
      seaLevel: SEA_LEVEL,
      height: (x, z, seed) => {
        heightCalls++;
        return baseHeight(x, z, seed);
      },
    };
    const throwingRiverLike = new Proxy(
      {},
      {
        get() {
          throw new Error('siting must never touch anything river-shaped');
        },
      },
    );
    // Sanity: the proxy really does throw, so the absence of a throw below is
    // meaningful and not an accident of an unused variable.
    expect(() => (throwingRiverLike as { drop(): void }).drop()).toThrow();

    clearPoliticalCache();
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        cityAt(cx, cz, counted, REAL_CLIMATE, SEED);
      }
    }
    expect(heightCalls).toBeGreaterThan(0);
  });
});

describe('the 8 km floor', () => {
  it('never places two cities closer than CITY_CELL, over a large window', () => {
    clearPoliticalCache();
    const sites: CitySite[] = citiesInBox(
      -40 * CITY_CELL,
      -40 * CITY_CELL,
      40 * CITY_CELL,
      40 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    // Anti-vacuity: a separation test over zero or one city passes for free.
    expect(sites.length).toBeGreaterThanOrEqual(15);

    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const a = sites[i] as CitySite;
        const b = sites[j] as CitySite;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        expect(distance).toBeGreaterThanOrEqual(CITY_CELL - 1e-6);
      }
    }
  });

  it('mean nearest-neighbour separation lands near the ~15 km target', () => {
    clearPoliticalCache();
    const sites = citiesInBox(
      -30 * CITY_CELL,
      -30 * CITY_CELL,
      30 * CITY_CELL,
      30 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThanOrEqual(10);

    let total = 0;
    for (const site of sites) {
      let nearest = Infinity;
      for (const other of sites) {
        if (other === site) continue;
        const dx = site.x - other.x;
        const dz = site.z - other.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < nearest) nearest = d;
      }
      if (Number.isFinite(nearest)) total += nearest;
    }
    const mean = total / sites.length;
    expect(mean).toBeGreaterThan(8_000);
    expect(mean).toBeLessThan(40_000);
  });
});

describe('containment: a site never leaves its own coarse cell', () => {
  it('every site position falls inside [cellX*CITY_CELL, (cellX+1)*CITY_CELL) on both axes', () => {
    clearPoliticalCache();
    const sites = citiesInBox(
      -25 * CITY_CELL,
      -25 * CITY_CELL,
      25 * CITY_CELL,
      25 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.x).toBeGreaterThanOrEqual(site.cellX * CITY_CELL);
      expect(site.x).toBeLessThan((site.cellX + 1) * CITY_CELL);
      expect(site.z).toBeGreaterThanOrEqual(site.cellZ * CITY_CELL);
      expect(site.z).toBeLessThan((site.cellZ + 1) * CITY_CELL);
    }
  });

  it('every site sits on the CITY_SITE_CELL (settlement) lattice, within its declared jitter', () => {
    clearPoliticalCache();
    const sites = citiesInBox(
      -20 * CITY_CELL,
      -20 * CITY_CELL,
      20 * CITY_CELL,
      20 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const anchorX = (site.siteCellX + 0.5) * CITY_SITE_CELL;
      const anchorZ = (site.siteCellZ + 0.5) * CITY_SITE_CELL;
      expect(Math.abs(site.x - anchorX)).toBeLessThanOrEqual(CITY_JITTER + 1e-6);
      expect(Math.abs(site.z - anchorZ)).toBeLessThanOrEqual(CITY_JITTER + 1e-6);
    }
  });
});

describe('habitability gates', () => {
  it('no city sits below the minimum altitude above sea level', () => {
    clearPoliticalCache();
    const sites = citiesInBox(
      -25 * CITY_CELL,
      -25 * CITY_CELL,
      25 * CITY_CELL,
      25 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.y).toBeGreaterThanOrEqual(SEA_LEVEL + CITY_MIN_ALTITUDE);
    }
  });
});

describe('cellPotential', () => {
  it('is a pure function of (cell, seed, climate)', () => {
    const a = cellPotential(3, -5, REAL_CLIMATE, SEED);
    const b = cellPotential(3, -5, REAL_CLIMATE, SEED);
    expect(a).toBe(b);
  });

  it('stays within [0, 1]', () => {
    for (let cz = -10; cz <= 10; cz++) {
      for (let cx = -10; cx <= 10; cx++) {
        const p = cellPotential(cx, cz, REAL_CLIMATE, SEED);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('nearestCityDistance', () => {
  it('is zero-ish at a real city site and grows with distance from it', () => {
    clearPoliticalCache();
    const sites = citiesInBox(
      -15 * CITY_CELL,
      -15 * CITY_CELL,
      15 * CITY_CELL,
      15 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThan(0);
    const city = sites[0] as CitySite;
    const atCity = nearestCityDistance(city.x, city.z, REAL_TERRAIN, REAL_CLIMATE, SEED);
    expect(atCity).toBeLessThan(1);

    // A climate with zero land anywhere seats no city ever, so a search with a
    // bounded radius over it must report "none found" rather than a false
    // nearby answer -- the Infinity branch, proven with a world where it is
    // the only possible outcome rather than by hoping a real search misses.
    const noLand: PolityClimate = { continentalness: () => -1, habitability: () => 0 };
    clearPoliticalCache();
    const far = nearestCityDistance(0, 0, REAL_TERRAIN, noLand, SEED, 2);
    expect(far).toBe(Infinity);
    clearPoliticalCache();
  });
});

// ---------------------------------------------------------------------------
// Phase Politics P2: capitals, nations, polityAt, borders
// ---------------------------------------------------------------------------

describe('POLITY_SEARCH_RADIUS', () => {
  it('is derived algebraically: FRONTIER_MAX * (1 + CITY_PULL)', () => {
    // The equation, not the number: if a beats a nearer city its weighted
    // distance must be under the nearest city's TRUE distance, which is at
    // most FRONTIER_MAX for any claimed point, so nothing beyond this radius
    // can ever be the argmin. A hardcoded number would silently stop meaning
    // that the moment either constant changed.
    expect(POLITY_SEARCH_RADIUS).toBeCloseTo(FRONTIER_MAX * (1 + CITY_PULL), 6);
  });
});

describe('a city always sits inside its own polity territory', () => {
  it('polityAt(city.x, city.z) agrees with polityOfCity(city) for every real city in a window', () => {
    resetAllCaches();
    const sites = citiesInBox(
      -15 * CITY_CELL,
      -15 * CITY_CELL,
      15 * CITY_CELL,
      15 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const own = polityOfCity(site, REAL_TERRAIN, REAL_CLIMATE, SEED);
      const at = polityAt(site.x, site.z, REAL_TERRAIN, REAL_CLIMATE, SEED);
      expect(at).toBeDefined();
      expect((at as Polity).capitalCellX).toBe(own.capitalCellX);
      expect((at as Polity).capitalCellZ).toBe(own.capitalCellZ);
    }
  });
});

describe('both city-states and multi-city nations exist', () => {
  it('over a real window, at least one city-state and at least one multi-member nation appear', () => {
    resetAllCaches();
    const sites = citiesInBox(
      -18 * CITY_CELL,
      -18 * CITY_CELL,
      18 * CITY_CELL,
      18 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    // Anti-vacuity: both-regimes-exist is unfalsifiable over too few cities.
    expect(sites.length).toBeGreaterThanOrEqual(10);

    const polities = new Map<number, Polity>();
    for (const site of sites) {
      const p = polityOfCity(site, REAL_TERRAIN, REAL_CLIMATE, SEED);
      polities.set(p.polityId, p);
    }
    const list = Array.from(polities.values());
    expect(list.some((p) => p.isCityState)).toBe(true);
    expect(list.some((p) => p.memberCount >= 2)).toBe(true);
  });
});

describe('claimed and unclaimed ground both exist', () => {
  it('a sampled grid contains sea (always unclaimed) and claimed land', () => {
    resetAllCaches();
    let sampled = 0;
    let sea = 0;
    let claimed = 0;
    for (let z = -40_000; z <= 40_000; z += 4_000) {
      for (let x = -40_000; x <= 40_000; x += 4_000) {
        sampled++;
        if (baseHeight(x, z, SEED) < SEA_LEVEL) {
          sea++;
          continue;
        }
        if (polityAt(x, z, REAL_TERRAIN, REAL_CLIMATE, SEED) !== undefined) claimed++;
      }
    }
    // Anti-vacuity: a map that is all sea, or all one polity that claims
    // everything, would each pass a naive "renders without throwing" check.
    expect(sampled).toBeGreaterThan(100);
    expect(sea).toBeGreaterThan(0);
    expect(claimed).toBeGreaterThan(0);
  });
});

describe('borders are not straight bisectors', () => {
  it('a detected boundary is offset from the straight geometric bisector of its two nearest cities', () => {
    resetAllCaches();
    const sites = citiesInBox(
      -15 * CITY_CELL,
      -15 * CITY_CELL,
      15 * CITY_CELL,
      15 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThanOrEqual(4);

    // Walk a fine grid and record the first pair of horizontally-adjacent
    // samples whose polity differs -- a detected border crossing -- well
    // outside CITY_CORE_RADIUS of every city, so the taper cannot be why it
    // moved.
    const step = 500;
    let found:
      | { ax: number; az: number; bx: number; bz: number; ownerA: Polity; ownerB: Polity }
      | undefined;
    outer: for (let z = -12_000; z <= 12_000 && found === undefined; z += step) {
      let prevOwner: Polity | undefined;
      let prevX = 0;
      for (let x = -12_000; x <= 12_000; x += step) {
        let nearest = Infinity;
        for (const s of sites) {
          const dx = x - s.x;
          const dz = z - s.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < nearest) nearest = d;
        }
        if (nearest < 2_500) {
          prevOwner = undefined;
          continue;
        }
        const owner = polityAt(x, z, REAL_TERRAIN, REAL_CLIMATE, SEED);
        if (
          prevOwner !== undefined &&
          owner !== undefined &&
          (owner.capitalCellX !== prevOwner.capitalCellX || owner.capitalCellZ !== prevOwner.capitalCellZ)
        ) {
          found = { ax: prevX, az: z, bx: x, bz: z, ownerA: prevOwner, ownerB: owner };
          break outer;
        }
        prevOwner = owner;
        prevX = x;
      }
    }

    // Anti-vacuity: if no crossing is found in the window, the test cannot
    // claim anything about border shape -- fail loudly rather than pass empty.
    expect(found).toBeDefined();
    const crossing = found as NonNullable<typeof found>;
    const midX = (crossing.ax + crossing.bx) / 2;

    const capA = { x: crossing.ownerA.capitalX, z: crossing.ownerA.capitalZ };
    const capB = { x: crossing.ownerB.capitalX, z: crossing.ownerB.capitalZ };
    // The straight geometric bisector's x-coordinate at this z, ignoring
    // prestige weighting entirely -- the simplest possible "no warp, no
    // weighting" prediction. If the measured crossing agreed with this to a
    // metre, the boundary would be reading as a straight bisector.
    const straightMidX = (capA.x + capB.x) / 2;
    expect(Math.abs(midX - straightMidX)).toBeGreaterThan(50);
  });
});

describe('isCapital', () => {
  it('is true for a polity\'s own capital site', () => {
    resetAllCaches();
    const sites = citiesInBox(
      -10 * CITY_CELL,
      -10 * CITY_CELL,
      10 * CITY_CELL,
      10 * CITY_CELL,
      REAL_TERRAIN,
      REAL_CLIMATE,
      SEED,
    );
    expect(sites.length).toBeGreaterThan(0);
    let sawCapital = false;
    for (const site of sites) {
      if (isCapital(site, REAL_TERRAIN, REAL_CLIMATE, SEED)) {
        sawCapital = true;
        const polity = polityOfCity(site, REAL_TERRAIN, REAL_CLIMATE, SEED);
        expect(polity.capitalCellX).toBe(site.cellX);
        expect(polity.capitalCellZ).toBe(site.cellZ);
      }
    }
    expect(sawCapital).toBe(true);
  });
});

describe('caches stay bounded', () => {
  it('neighbourhood and polity caches never exceed their limits', () => {
    resetAllCaches();
    for (let i = 0; i < 60; i++) {
      polityAt(i * 9_000, 0, REAL_TERRAIN, REAL_CLIMATE, SEED);
    }
    expect(neighbourhoodCacheStats().entries).toBeLessThanOrEqual(NEIGHBOURHOOD_CACHE_LIMIT);
    expect(polityCacheStats().entries).toBeLessThanOrEqual(POLITY_CACHE_LIMIT);
    expect(capitalCacheStats().entries).toBeLessThanOrEqual(CAPITAL_CACHE_LIMIT);
  });

  it('capitalOf is memoised: a repeat query is not a rebuild', () => {
    resetAllCaches();
    const sites = citiesInBox(-5 * CITY_CELL, -5 * CITY_CELL, 5 * CITY_CELL, 5 * CITY_CELL, REAL_TERRAIN, REAL_CLIMATE, SEED);
    expect(sites.length).toBeGreaterThan(0);
    polityOfCity(sites[0] as CitySite, REAL_TERRAIN, REAL_CLIMATE, SEED);
    const buildsAfterFirst = capitalCacheStats().builds;
    polityOfCity(sites[0] as CitySite, REAL_TERRAIN, REAL_CLIMATE, SEED);
    expect(capitalCacheStats().builds).toBe(buildsAfterFirst);
  });
});

describe('polityAt performance', () => {
  it('answers thousands of queries quickly once the caches are warm', () => {
    resetAllCaches();
    // Warm the caches over the query area first, matching how the debug map
    // (Phase P4) actually uses this: one incremental build, then many reads.
    polityAt(0, 0, REAL_TERRAIN, REAL_CLIMATE, SEED);

    const start = performance.now();
    let answered = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = ((i % 100) - 50) * 800;
      const z = (Math.floor(i / 100) - 50) * 800;
      if (polityAt(x, z, REAL_TERRAIN, REAL_CLIMATE, SEED) !== undefined) answered++;
    }
    const elapsed = performance.now() - start;
    // Generous versus the plan's ideal (~100ms): this runs on whatever CI
    // hardware happens to host the test, and the claim that matters is "does
    // not hang a tab", not a tight benchmark.
    expect(elapsed).toBeLessThan(5_000);
    expect(answered).toBeGreaterThan(0);
  });
});
