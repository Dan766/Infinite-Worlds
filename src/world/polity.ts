/**
 * Political geography: where cities are, what nation (if any) owns them, and
 * where the borders fall.
 *
 * Phase Politics P1-P2. This module is pure and position-only -- there is no
 * tier here at all, in the same sense `height-field.ts`'s biome fields have no
 * tier: a query at any point is answered without reference to any chunk,
 * sector or region ever having been generated. It is injected into
 * `regionRoadField` from `height-field.ts`, exactly the way `habitability` is
 * today. See the header note in `height-field.ts` for why this is not a new
 * tier: a nation's extent is EMERGENT from city positions, not decided inside
 * a fixed box, and prepending a coarser tier to `contracts.ts` would make
 * `coarser()` legal from inside a region generator -- the one guarantee
 * `ARCHITECTURE.md` calls load-bearing.
 *
 * This module never imports `roads.ts`. It exports `CitySite`, and `roads.ts`
 * maps `CitySite -> Settlement`. Keeping the edge one-directional is what lets
 * `roads.ts` stay decoupled from a discipline (nations, culture, prestige) it
 * has no reason to know about.
 *
 * ---------------------------------------------------------------------------
 * WHY CITY SITING NEVER TOUCHES RIVERS
 *
 * The obvious design -- scan `settlementScore`-style candidates, which read
 * `rivers.drop`, over every point in an 8 km cell -- blows the 24-entry river
 * region memo the same way an earlier `SETTLEMENT_PAD` experiment already did
 * (see PROGRESS.md: a 4096 m pad cost 24-28 river-region rebuilds per road
 * region, 1.4 s, ten times budget). A city-siting scan covering the window a
 * region needs touches 6-8 river-region columns on each axis -- 36-64 regions
 * against a 24-slot cache, the textbook "one short of the working set"
 * thrashing pattern.
 *
 * The fix is staged scoring: a coarse pass reads only `continentalness` and
 * `habitability` (both position-pure, no memo at all); a fine pass reads only
 * `baseHeight` (also memo-free -- see `height-field.ts`'s own note that
 * `baseHeight` is "µs-scale, no caching, no memo"). Rivers are consulted
 * nowhere in this module. `polity.test.ts` asserts that directly: siting is
 * driven with a `PolityTerrain` whose `height` counts calls and a synthetic
 * climate, and the test simply never gives this module a way to reach a
 * river at all -- there is no river parameter to wire one through.
 *
 * ---------------------------------------------------------------------------
 * THE 8 KM FLOOR
 *
 * `CITY_CELL = 8192` m (two regions). A city site is chosen only inside a
 * strict local maximum of `cellPotential` over the cell's 3x3 neighbourhood
 * (the same rule `roads.ts`'s `siteSettlements` uses for settlements, at a
 * coarser lattice), so two winning cells can never be adjacent. The chosen
 * site is always contained inside its own cell -- the sub-cell and
 * settlement-lattice tiling below exactly partitions `CITY_CELL` with no
 * overlap, and the site jitter is bounded well under half a tile -- so the
 * worst case (two cities pinned to the far edges of cells two apart) gives a
 * separation of exactly `CITY_CELL`. That is the hard floor the design calls
 * for, not an approximation of one.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Every quantity is `hash2i`/`hash3i`/`hashUnit` of `(worldSeed, cell, ...)`.
 * No `Math.pow`, `sin`, `cos` or `exp` on any path to a stored value -- see
 * `noise.ts`'s header for why.
 */

import { hash2i, hash3i } from '../core/hash';
import { SECTOR_SIZE } from './contracts';
import { clamp, hashUnit, smoothstep, warp2 } from './noise';

// ---------------------------------------------------------------------------
// Terrain and climate this module is allowed to see
// ---------------------------------------------------------------------------

/**
 * The pre-carve world, as siting sees it. MUST be `baseHeight` -- never
 * `sampleHeight` -- for the same circular-dependency reason `RiverTerrain`
 * and `RoadTerrain` state: siting decides the ground, so it cannot read
 * anything the ground's own grading has already touched.
 */
export interface PolityTerrain {
  readonly seaLevel: number;
  height(x: number, z: number, worldSeed: number): number;
}

/**
 * The climate fields siting reads, injected rather than imported so this
 * module never depends on `height-field.ts` (which will import THIS module).
 * `continentalness` is `height-field.ts`'s own field, unchanged; `habitability`
 * matches the private function of the same name at `height-field.ts:433`.
 */
export interface PolityClimate {
  continentalness(x: number, z: number, worldSeed: number): number;
  habitability(x: number, z: number, worldSeed: number): number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Metres along one axis of the coarse city lattice. Two regions. The 8 km floor IS this. */
export const CITY_CELL = 8192;

/** Sub-cells of `CITY_CELL` scored in the fine argmax's first pass. */
const CITY_SUBCELL_DIV = 4;
const CITY_SUBCELL = CITY_CELL / CITY_SUBCELL_DIV;

/**
 * Metres per settlement-lattice cell a city site finally lands on.
 *
 * `SECTOR_SIZE`, matching `roads.ts`'s `SETTLEMENT_CELL` -- a city site must
 * sit on this lattice so `Settlement.cellX/cellZ` (the settlement identity
 * `streets.ts` keys sector ownership on) means the same thing for a city as
 * for a village.
 */
export const CITY_SITE_CELL = SECTOR_SIZE;

/** Settlement-lattice cells spanning one sub-cell. `CITY_SUBCELL_DIV * this === CITY_CELL / CITY_SITE_CELL`. */
const CITY_SITE_DIV = CITY_SUBCELL / CITY_SITE_CELL;

/**
 * Metres a chosen site may be jittered from its settlement-lattice cell
 * centre, each axis. Below half `CITY_SITE_CELL` for the same reason
 * `roads.ts`'s `SETTLEMENT_JITTER` is: it keeps the site inside its own
 * settlement cell, which is what keeps it inside its own `CITY_CELL` too,
 * since the sub-cell/site-cell tiling exactly partitions the coarse cell.
 */
export const CITY_JITTER = 190;

/** Coarse-pass gate. Below this a cell cannot host a city regardless of local terrain. */
export const CITY_POTENTIAL_MIN = 0.3;

/** Metres above sea level a city site must clear. Matches `SETTLEMENT_MIN_ALTITUDE`. */
export const CITY_MIN_ALTITUDE = 4;

/** Slope, as rise over run, at which a candidate scores nothing. Matches `roads.ts`'s private `SETTLEMENT_MAX_SLOPE`. */
const CITY_MAX_SLOPE = 0.28;

/**
 * Metres between the central-difference slope probes. 128, matching
 * `roads.ts`'s `ROAD_CELL` by value (not by import -- this module must not
 * depend on `roads.ts`) so a city and a village agree about what "flat"
 * means. `polity.test.ts` cross-checks the value.
 */
const CITY_PROBE_STEP = 128;

/**
 * Cities held at once. One entry is a few dozen bytes, unlike a river or road
 * network, so this can afford to be generous -- and it has to be: a single
 * `neighbourhoodAt` build (Part 2) scans up to `(2 * POLITY_SEARCH_CELLS +
 * 1)^2` cells in one call, which alone can exceed a couple of hundred. Sized
 * so one neighbourhood build cannot thrash this cache against itself.
 */
export const CITY_CACHE_LIMIT = 1024;

const SALT = {
  jitter: 0x4369_7479, // 'City'
  prestige: 0x5072_6573, // 'Pres'
  polity: 0x506f_6c79, // 'Poly'
  borderWarp: 0x42_6f_72_64, // 'Bord'
} as const;

// ---------------------------------------------------------------------------
// Total order over coarse cells, for a tie-break every window agrees on
// ---------------------------------------------------------------------------

/**
 * Negative when `(ax, az)` sorts before `(bx, bz)`. Row-major: z first, then
 * x -- the same order `roads.ts`'s `siteSettlements` uses (`row * cols + col`
 * is exactly this comparison once you drop the shared window origin). A
 * total order over an UNBOUNDED domain, so two windows that both see a pair
 * of cells always agree which one wins a tie, with no dependence on where
 * either window started.
 */
function cellOrder(ax: number, az: number, bx: number, bz: number): number {
  return az !== bz ? az - bz : ax - bx;
}

// ---------------------------------------------------------------------------
// Site anchor: the fixed point a settlement-lattice cell offers a city
// ---------------------------------------------------------------------------

function siteAnchor(cellX: number, cellZ: number, worldSeed: number): { x: number; z: number } {
  const h = hash2i(cellX, cellZ, (worldSeed ^ SALT.jitter) >>> 0);
  const jx = ((h & 0xffff) / 0xffff) * 2 - 1;
  const jz = ((h >>> 16) / 0xffff) * 2 - 1;
  return {
    x: (cellX + 0.5) * CITY_SITE_CELL + jx * CITY_JITTER,
    z: (cellZ + 0.5) * CITY_SITE_CELL + jz * CITY_JITTER,
  };
}

// ---------------------------------------------------------------------------
// Stage 1: coarse potential. Climate only -- no `baseHeight`, no rivers.
// ---------------------------------------------------------------------------

/** Centre plus four quarter-points, so one bad corner cannot hide a mountain core. */
const SUBPROBE: readonly (readonly [number, number])[] = [
  [0, 0],
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

/**
 * How promising a coarse cell is, in [0, 1], from climate alone.
 *
 * Exported so the siting tests can assert its shape directly, the way
 * `settlementScore` is exported from `roads.ts` for the same reason.
 */
export function cellPotential(
  cellX: number,
  cellZ: number,
  climate: PolityClimate,
  worldSeed: number,
): number {
  let sum = 0;
  for (let i = 0; i < SUBPROBE.length; i++) {
    const probe = SUBPROBE[i] as readonly [number, number];
    const x = (cellX + 0.5 + probe[0]) * CITY_CELL;
    const z = (cellZ + 0.5 + probe[1]) * CITY_CELL;
    const land = smoothstep(-0.05, 0.3, climate.continentalness(x, z, worldSeed));
    const hab = climate.habitability(x, z, worldSeed);
    sum += land * (0.3 + 0.7 * hab);
  }
  return clamp(sum / SUBPROBE.length, 0, 1);
}

/**
 * True iff `(cellX, cellZ)` is a strict local maximum of `cellPotential` over
 * its 3x3 neighbourhood, ties broken by `cellOrder`. A pure function of the
 * 3x3 block around the cell -- no window, no scan order -- which is what
 * makes it agree from every caller and keeps two winning cells always
 * non-adjacent.
 */
function isPotentialPeak(
  cellX: number,
  cellZ: number,
  potential: number,
  climate: PolityClimate,
  worldSeed: number,
): boolean {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = cellX + dx;
      const nz = cellZ + dz;
      const np = cellPotential(nx, nz, climate, worldSeed);
      if (np > potential || (np === potential && cellOrder(nx, nz, cellX, cellZ) < 0)) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stage 2: fine argmax. `baseHeight` only -- still no rivers.
// ---------------------------------------------------------------------------

/**
 * How good a building pad one point is, in [0, 1] -- flatness and altitude
 * only. Deliberately narrower than `roads.ts`'s `settlementScore`: no river
 * or sea-proximity term, because that would require a river read. The
 * archetype pass in `city.ts` (Phase C) is where a city's relationship to a
 * river or coast actually gets decided, from the ONE river region the region
 * generator already has resident at that point.
 */
function sitePadScore(
  x: number,
  z: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): number {
  const y = terrain.height(x, z, worldSeed);
  if (y < terrain.seaLevel + CITY_MIN_ALTITUDE) return 0;

  const step = CITY_PROBE_STEP / 2;
  const hx = terrain.height(x + step, z, worldSeed) - terrain.height(x - step, z, worldSeed);
  const hz = terrain.height(x, z + step, worldSeed) - terrain.height(x, z - step, worldSeed);
  const slope = Math.sqrt(hx * hx + hz * hz) / (2 * step);
  const flat = 1 - smoothstep(0, CITY_MAX_SLOPE, slope);
  if (flat <= 0) return 0;

  const heightFactor = 1 - smoothstep(120, 320, y - terrain.seaLevel);
  const hab = climate.habitability(x, z, worldSeed);
  return clamp(flat * heightFactor * (0.5 + 0.5 * hab), 0, 1);
}

/** One resolved city site, or `undefined` when no pad in the cell clears the bar. */
interface FineSite {
  readonly siteCellX: number;
  readonly siteCellZ: number;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly siteScore: number;
}

/**
 * The best building pad inside one coarse cell.
 *
 * Two passes, both cheap and both memo-free (`baseHeight` is µs-scale with no
 * cache of its own): pass A scores the 4x4 sub-cells' centres, pass B scores
 * the 4x4 settlement-lattice candidates inside the winning sub-cell. Their
 * tiling is exact -- `CITY_SUBCELL_DIV * CITY_SITE_DIV * CITY_SITE_CELL ===
 * CITY_CELL` -- so the result is always contained in `(cellX, cellZ)`.
 */
function siteWithinCell(
  cellX: number,
  cellZ: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): FineSite | undefined {
  const baseX = cellX * CITY_CELL;
  const baseZ = cellZ * CITY_CELL;

  let bestSubRow = -1;
  let bestSubCol = -1;
  let bestSubScore = 0;
  for (let row = 0; row < CITY_SUBCELL_DIV; row++) {
    for (let col = 0; col < CITY_SUBCELL_DIV; col++) {
      const x = baseX + (col + 0.5) * CITY_SUBCELL;
      const z = baseZ + (row + 0.5) * CITY_SUBCELL;
      const s = sitePadScore(x, z, terrain, climate, worldSeed);
      if (s > bestSubScore) {
        bestSubScore = s;
        bestSubRow = row;
        bestSubCol = col;
      }
    }
  }
  if (bestSubScore <= 0) return undefined;

  const subBaseX = baseX + bestSubCol * CITY_SUBCELL;
  const subBaseZ = baseZ + bestSubRow * CITY_SUBCELL;
  const siteCell0X = Math.floor(subBaseX / CITY_SITE_CELL);
  const siteCell0Z = Math.floor(subBaseZ / CITY_SITE_CELL);

  let best: FineSite | undefined;
  let bestScore = 0;
  for (let row = 0; row < CITY_SITE_DIV; row++) {
    for (let col = 0; col < CITY_SITE_DIV; col++) {
      const siteCellX = siteCell0X + col;
      const siteCellZ = siteCell0Z + row;
      const p = siteAnchor(siteCellX, siteCellZ, worldSeed);
      const s = sitePadScore(p.x, p.z, terrain, climate, worldSeed);
      if (s > bestScore) {
        bestScore = s;
        best = {
          siteCellX,
          siteCellZ,
          x: p.x,
          z: p.z,
          y: terrain.height(p.x, p.z, worldSeed),
          siteScore: s,
        };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The city record
// ---------------------------------------------------------------------------

/**
 * One city site. Positions are absolute world metres.
 *
 * `roads.ts` maps this to a `Settlement` (Phase S); everything past siting --
 * walls, districts, culture, name -- reads from this record or from a
 * `Polity` (Part 2), never re-derives it.
 */
export interface CitySite {
  /** The `CITY_CELL` lattice cell. Its coarse identity, and the prestige/capital search key. */
  readonly cellX: number;
  readonly cellZ: number;
  /** The `CITY_SITE_CELL` (settlement) lattice cell the site landed on. Matches `Settlement.cellX/cellZ`. */
  readonly siteCellX: number;
  readonly siteCellZ: number;
  readonly x: number;
  readonly z: number;
  /** `baseHeight` at the site. */
  readonly y: number;
  /** Coarse cell potential in [0, 1]. Drives prestige (Part 2). */
  readonly potential: number;
  /** Fine pad quality in [0, 1]. Plays the role `Settlement.score`'s `quality` derivative does for villages. */
  readonly siteScore: number;
}

/** A cache entry adds nothing beyond the site itself plus the key it was found under. */
interface CacheEntry {
  readonly cellX: number;
  readonly cellZ: number;
  readonly worldSeed: number;
  readonly terrain: PolityTerrain;
  readonly climate: PolityClimate;
  readonly site: CitySite | undefined;
}

const cache: CacheEntry[] = [];
let cacheBuilds = 0;

/** Diagnostics for tests and the HUD. Not part of any determinism claim. */
export function politicalCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: cache.length, limit: CITY_CACHE_LIMIT, builds: cacheBuilds };
}

export function clearPoliticalCache(): void {
  cache.length = 0;
}

/**
 * The city (or lack of one) owning one `CITY_CELL` lattice cell.
 *
 * Memoised the same shape `rivers.ts`/`roads.ts` use: linear scan, four-field
 * key compared with `terrain`/`climate` by REFERENCE, promote-by-swap so a
 * hit never moves memory. `undefined` is cached too -- most cells are not
 * cities, and re-deciding that on every query would be the expensive case
 * running the most often.
 */
export function cityAt(
  cellX: number,
  cellZ: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): CitySite | undefined {
  const seed = worldSeed >>> 0;
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i] as CacheEntry;
    if (
      entry.cellX === cellX &&
      entry.cellZ === cellZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain &&
      entry.climate === climate
    ) {
      if (i > 0) {
        cache[i] = cache[i - 1] as CacheEntry;
        cache[i - 1] = entry;
      }
      return entry.site;
    }
  }

  const potential = cellPotential(cellX, cellZ, climate, seed);
  let site: CitySite | undefined;
  if (potential >= CITY_POTENTIAL_MIN && isPotentialPeak(cellX, cellZ, potential, climate, seed)) {
    const fine = siteWithinCell(cellX, cellZ, terrain, climate, seed);
    if (fine !== undefined) {
      site = {
        cellX,
        cellZ,
        siteCellX: fine.siteCellX,
        siteCellZ: fine.siteCellZ,
        x: fine.x,
        z: fine.z,
        y: fine.y,
        potential,
        siteScore: fine.siteScore,
      };
    }
  }

  cacheBuilds++;
  cache.unshift({ cellX, cellZ, worldSeed: seed, terrain, climate, site });
  if (cache.length > CITY_CACHE_LIMIT) cache.length = CITY_CACHE_LIMIT;
  return site;
}

/** Every city whose coarse cell overlaps `[x0, x1] x [z0, z1]`, world metres. */
export function citiesInBox(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): CitySite[] {
  const cell0X = Math.floor(x0 / CITY_CELL);
  const cell0Z = Math.floor(z0 / CITY_CELL);
  const cell1X = Math.floor(x1 / CITY_CELL);
  const cell1Z = Math.floor(z1 / CITY_CELL);
  const out: CitySite[] = [];
  for (let cz = cell0Z; cz <= cell1Z; cz++) {
    for (let cx = cell0X; cx <= cell1X; cx++) {
      const site = cityAt(cx, cz, terrain, climate, worldSeed);
      if (site !== undefined) out.push(site);
    }
  }
  return out;
}

/**
 * Straight-line distance to the nearest city, or `Infinity` if none is found
 * within `searchCells` coarse cells (default 6, i.e. a 13x13 block).
 *
 * Used by `roads.ts` (Phase S) to make village acceptance hinterland-aware:
 * the THRESHOLD a settlement score must clear becomes a function of this
 * distance, while the score itself -- and the local-maximum test on it --
 * stays untouched. See the module header of `roads.ts` for why that is the
 * safe axis to tune.
 */
export function nearestCityDistance(
  x: number,
  z: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
  searchCells = 6,
): number {
  const cellX = Math.floor(x / CITY_CELL);
  const cellZ = Math.floor(z / CITY_CELL);
  let best = Infinity;
  for (let dz = -searchCells; dz <= searchCells; dz++) {
    for (let dx = -searchCells; dx <= searchCells; dx++) {
      const site = cityAt(cellX + dx, cellZ + dz, terrain, climate, worldSeed);
      if (site === undefined) continue;
      const ddx = site.x - x;
      const ddz = site.z - z;
      const d = Math.sqrt(ddx * ddx + ddz * ddz);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Part 2: capitals, nations, and territory
// ---------------------------------------------------------------------------

/**
 * How much a city site is inherently worth, in [0, 1] -- the input to capital
 * selection and, through it, to how far a nation's pull and its territory
 * reach. A pure function of the site's own siting numbers plus one
 * independent hash term, so two cities with identical siting can still end up
 * with different prestige (an "accident of history", not a second siting
 * pass).
 */
function prestige(site: CitySite, worldSeed: number): number {
  const roll = hashUnit(hash3i(site.cellX, site.cellZ, 0, (worldSeed ^ SALT.prestige) >>> 0));
  return clamp(0.45 * site.siteScore + 0.35 * site.potential + 0.2 * roll, 0, 1);
}

/** Coarse cells within which a city competes to be a capital. 24,576 m: a 7x7 block. */
const CAPITAL_REACH_CELLS = 3;

/**
 * Metres a capital's nation can reach, at the weakest and the widest prestige.
 *
 * This number does double duty -- it bounds which distant cities a capital
 * can absorb as members (`capitalOf`) AND it bounds how far that capital's
 * territory can extend (`polityAt`'s frontier test). Unifying them is a
 * deliberate simplification over treating "nation" and "territory" reach as
 * two independently tuned numbers: a polity should not be able to claim
 * ground further than the distance at which it could ever absorb a city, so
 * a second, larger frontier constant would only be a second knob for the same
 * idea. Recorded as a judgment call in PROGRESS.md.
 */
export const NATION_REACH_MIN = 18_000;
export const NATION_REACH_SPAN = 26_000;

/** Furthest any polity's reach can extend, at prestige 1. */
export const FRONTIER_MAX = NATION_REACH_MIN + NATION_REACH_SPAN;

/**
 * How strongly a city's own prestige shortens the effective distance to it in
 * a weighted comparison. `weight = distance / (1 + CITY_PULL * prestige)`, so
 * a prestige-1 city reaches `1 + CITY_PULL` times as far as a prestige-0 one
 * for the same true distance.
 */
export const CITY_PULL = 0.35;

/**
 * The territory search radius, DERIVED rather than guessed.
 *
 * If `c0` is the geometrically nearest city at distance `d0`, its weighted
 * distance is at most `d0` (weight only ever shrinks a distance). A city at
 * true distance `d` can only beat it if `d / (1 + CITY_PULL) < d0`, i.e.
 * `d < d0 * (1 + CITY_PULL)`. Since unclaimed ground means `d0` itself
 * exceeds `FRONTIER_MAX`, no city beyond `FRONTIER_MAX * (1 + CITY_PULL)` can
 * ever be the argmin. `polity.test.ts` asserts this equation directly rather
 * than trusting the arithmetic in prose.
 */
export const POLITY_SEARCH_RADIUS = FRONTIER_MAX * (1 + CITY_PULL);

const CAPITAL_SEARCH_CELLS = Math.ceil(FRONTIER_MAX / CITY_CELL) + 1;
const POLITY_SEARCH_CELLS = Math.ceil(POLITY_SEARCH_RADIUS / CITY_CELL) + 1;
/** The wider of the two searches: `neighbourhoodAt` is a superset for both callers. */
const NEIGHBOURHOOD_RADIUS_CELLS = Math.max(CAPITAL_SEARCH_CELLS, POLITY_SEARCH_CELLS);

/** Metres and cycle length of the point-warp that keeps borders from reading as straight bisectors. */
export const BORDER_WARP_METRES = 900;
const BORDER_WARP_FREQUENCY = 1 / 3000;

/**
 * Metres within which the border warp is suppressed, so a city can never be
 * warped outside its own territory. Ramped by `smoothstep` on the UNWARPED
 * distance to the nearest city -- a value every `polityAt` call already
 * computes for its own argmin, so tapering costs one multiply, not a second
 * pass.
 */
export const CITY_CORE_RADIUS = 1500;

// ---------------------------------------------------------------------------
// The neighbourhood snapshot: the second memo that makes a map affordable
// ---------------------------------------------------------------------------

interface NeighbourhoodEntry {
  readonly cellX: number;
  readonly cellZ: number;
  readonly worldSeed: number;
  readonly terrain: PolityTerrain;
  readonly climate: PolityClimate;
  readonly cities: readonly CitySite[];
}

const neighbourhoodCache: NeighbourhoodEntry[] = [];
let neighbourhoodBuilds = 0;

/**
 * Sized to hold a whole visible map's worth of blocks AND the working set
 * `capitalOf` pulls in while it is still warming up `capitalCache`: every
 * distinct city a query's own neighbourhood contains needs one more
 * neighbourhood snapshot -- centred on THAT city's cell -- the first time its
 * capital is resolved. Measured against the P2 test suite (which sweeps
 * several thousand points across ~20 real cities): 32 thrashed badly enough
 * to turn a should-be-instant sweep into minutes; 128 does not.
 */
export const NEIGHBOURHOOD_CACHE_LIMIT = 128;

export function neighbourhoodCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: neighbourhoodCache.length, limit: NEIGHBOURHOOD_CACHE_LIMIT, builds: neighbourhoodBuilds };
}

/**
 * Every city within `NEIGHBOURHOOD_RADIUS_CELLS` of `(cellX, cellZ)`.
 *
 * Without this, `polityAt` costs `(2 * POLITY_SEARCH_CELLS + 1)^2` `cityAt`
 * lookups PER QUERY -- fine for one point, ruinous for 65,536 map pixels.
 * With it, every pixel sharing a coarse cell (roughly `(CITY_CELL /
 * metresPerPixel)^2` of them) pays for the scan once. The underlying
 * `cityAt` calls are themselves memoised, so even a cache miss here is cheap
 * once the city cache has warmed up over a region.
 */
function neighbourhoodAt(
  cellX: number,
  cellZ: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): readonly CitySite[] {
  const seed = worldSeed >>> 0;
  for (let i = 0; i < neighbourhoodCache.length; i++) {
    const entry = neighbourhoodCache[i] as NeighbourhoodEntry;
    if (
      entry.cellX === cellX &&
      entry.cellZ === cellZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain &&
      entry.climate === climate
    ) {
      if (i > 0) {
        neighbourhoodCache[i] = neighbourhoodCache[i - 1] as NeighbourhoodEntry;
        neighbourhoodCache[i - 1] = entry;
      }
      return entry.cities;
    }
  }

  const cities: CitySite[] = [];
  for (let dz = -NEIGHBOURHOOD_RADIUS_CELLS; dz <= NEIGHBOURHOOD_RADIUS_CELLS; dz++) {
    for (let dx = -NEIGHBOURHOOD_RADIUS_CELLS; dx <= NEIGHBOURHOOD_RADIUS_CELLS; dx++) {
      const site = cityAt(cellX + dx, cellZ + dz, terrain, climate, seed);
      if (site !== undefined) cities.push(site);
    }
  }

  neighbourhoodBuilds++;
  neighbourhoodCache.unshift({ cellX, cellZ, worldSeed: seed, terrain, climate, cities });
  if (neighbourhoodCache.length > NEIGHBOURHOOD_CACHE_LIMIT) {
    neighbourhoodCache.length = NEIGHBOURHOOD_CACHE_LIMIT;
  }
  return cities;
}

export function clearNeighbourhoodCache(): void {
  neighbourhoodCache.length = 0;
}

// ---------------------------------------------------------------------------
// Capitals and membership
// ---------------------------------------------------------------------------

/** True iff `(cellX, cellZ)`'s city is a strict prestige local-maximum among cities within `CAPITAL_REACH_CELLS`. */
function isCapitalCell(
  cellX: number,
  cellZ: number,
  ownPrestige: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): boolean {
  const cities = neighbourhoodAt(cellX, cellZ, terrain, climate, worldSeed);
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i] as CitySite;
    if (c.cellX === cellX && c.cellZ === cellZ) continue;
    if (Math.max(Math.abs(c.cellX - cellX), Math.abs(c.cellZ - cellZ)) > CAPITAL_REACH_CELLS) continue;
    const cp = prestige(c, worldSeed);
    if (cp > ownPrestige || (cp === ownPrestige && cellOrder(c.cellX, c.cellZ, cellX, cellZ) < 0)) {
      return false;
    }
  }
  return true;
}

/**
 * True iff `site` is itself a capital -- either a genuine prestige local
 * maximum, or (see `capitalOf`) a city no capital's reach extends to, which
 * makes it a city-state and therefore its own capital by definition.
 */
export function isCapital(
  site: CitySite,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): boolean {
  const capital = capitalOf(site, terrain, climate, worldSeed);
  return capital.cellX === site.cellX && capital.cellZ === site.cellZ;
}

/**
 * Cell-to-capital-cell memo.
 *
 * WITHOUT THIS, `capitalOf` IS THE ONE UNBOUNDED COST IN THIS MODULE. Every
 * `polityAt` query calls it once per city in the query's own neighbourhood,
 * and each of those calls builds `neighbourhoodAt` centred on THAT city's own
 * cell -- a different centre from the query's, and from every other
 * candidate's. A single query can therefore demand a dozen-plus DISTINCT
 * neighbourhood snapshots, each up to `(2 * POLITY_SEARCH_CELLS + 1)^2`
 * `cityAt` calls, and the next query a few hundred metres away demands a
 * near-identical dozen again. `NEIGHBOURHOOD_CACHE_LIMIT = 32` cannot hold
 * enough of that working set, so without this memo the neighbourhood cache
 * thrashes on itself query after query -- measured, this hung a 15,000-point
 * sweep for minutes. A city's owning capital is a pure function of the city
 * alone, so memoising it here turns "recomputed by every query that happens
 * to see this city" into "computed once, ever, per city".
 */
interface CapitalCacheEntry {
  readonly cellX: number;
  readonly cellZ: number;
  readonly worldSeed: number;
  readonly terrain: PolityTerrain;
  readonly climate: PolityClimate;
  readonly capitalCellX: number;
  readonly capitalCellZ: number;
}

const capitalCache: CapitalCacheEntry[] = [];
let capitalCacheBuilds = 0;

/** One entry per city ever asked about. Cheap: two integers plus the shared key fields. */
export const CAPITAL_CACHE_LIMIT = 1024;

export function capitalCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: capitalCache.length, limit: CAPITAL_CACHE_LIMIT, builds: capitalCacheBuilds };
}

export function clearCapitalCache(): void {
  capitalCache.length = 0;
}

/**
 * The capital that owns `site` -- itself, if it qualifies as a capital, else
 * the nearest (prestige-weighted) capital whose reach contains it, else
 * itself again: a city inside no capital's reach is a city-state, its own
 * capital, exactly as `PROGRESS.md`'s design note states.
 */
function capitalOf(
  site: CitySite,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): CitySite {
  const seed = worldSeed >>> 0;
  for (let i = 0; i < capitalCache.length; i++) {
    const entry = capitalCache[i] as CapitalCacheEntry;
    if (
      entry.cellX === site.cellX &&
      entry.cellZ === site.cellZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain &&
      entry.climate === climate
    ) {
      if (i > 0) {
        capitalCache[i] = capitalCache[i - 1] as CapitalCacheEntry;
        capitalCache[i - 1] = entry;
      }
      if (entry.capitalCellX === site.cellX && entry.capitalCellZ === site.cellZ) return site;
      // The capital cell is itself always resident (it was resolved via
      // `cityAt` the first time this entry was built), so this is a cheap
      // array scan, never a rebuild.
      return cityAt(entry.capitalCellX, entry.capitalCellZ, terrain, climate, seed) ?? site;
    }
  }

  const ownPrestige = prestige(site, seed);
  let capital = site;
  if (!isCapitalCell(site.cellX, site.cellZ, ownPrestige, terrain, climate, seed)) {
    const cities = neighbourhoodAt(site.cellX, site.cellZ, terrain, climate, seed);
    let best: CitySite | undefined;
    let bestWeighted = Infinity;
    for (let i = 0; i < cities.length; i++) {
      const c = cities[i] as CitySite;
      if (c.cellX === site.cellX && c.cellZ === site.cellZ) continue;
      const cp = prestige(c, seed);
      if (!isCapitalCell(c.cellX, c.cellZ, cp, terrain, climate, seed)) continue;
      const capReach = NATION_REACH_MIN + NATION_REACH_SPAN * cp;
      const dx = site.x - c.x;
      const dz = site.z - c.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > capReach) continue;
      const weighted = d / (1 + CITY_PULL * cp);
      if (weighted < bestWeighted) {
        bestWeighted = weighted;
        best = c;
      }
    }
    capital = best ?? site;
  }

  capitalCacheBuilds++;
  capitalCache.unshift({
    cellX: site.cellX,
    cellZ: site.cellZ,
    worldSeed: seed,
    terrain,
    climate,
    capitalCellX: capital.cellX,
    capitalCellZ: capital.cellZ,
  });
  if (capitalCache.length > CAPITAL_CACHE_LIMIT) capitalCache.length = CAPITAL_CACHE_LIMIT;
  return capital;
}

// ---------------------------------------------------------------------------
// Polities
// ---------------------------------------------------------------------------

/**
 * One nation, or one city-state (a nation of one).
 *
 * Identified by its capital's coarse cell -- stable, and computable by anyone
 * who can find the capital, so a member city and a map pixel that both land
 * on the same capital always agree on `polityId` without comparing anything
 * but two integers.
 */
export interface Polity {
  readonly polityId: number;
  readonly capitalCellX: number;
  readonly capitalCellZ: number;
  readonly capitalX: number;
  readonly capitalZ: number;
  /** [0, 1]. Drives `reach` and the weighted-Voronoi pull in `polityAt`. */
  readonly prestige: number;
  /** Metres. Both the nation-membership radius and the territorial frontier. */
  readonly reach: number;
  /** Includes the capital itself, so this is always >= 1. */
  readonly memberCount: number;
  readonly isCityState: boolean;
}

interface PolityCacheEntry {
  readonly capitalCellX: number;
  readonly capitalCellZ: number;
  readonly worldSeed: number;
  readonly terrain: PolityTerrain;
  readonly climate: PolityClimate;
  readonly polity: Polity;
}

const polityCache: PolityCacheEntry[] = [];
let polityCacheBuilds = 0;

/** Held down: one entry per capital, and a query touches only the capitals its neighbourhood found. */
export const POLITY_CACHE_LIMIT = 128;

export function polityCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: polityCache.length, limit: POLITY_CACHE_LIMIT, builds: polityCacheBuilds };
}

export function clearPolityCache(): void {
  polityCache.length = 0;
}

function computePolity(
  capital: CitySite,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): Polity {
  const seed = worldSeed >>> 0;
  for (let i = 0; i < polityCache.length; i++) {
    const entry = polityCache[i] as PolityCacheEntry;
    if (
      entry.capitalCellX === capital.cellX &&
      entry.capitalCellZ === capital.cellZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain &&
      entry.climate === climate
    ) {
      if (i > 0) {
        polityCache[i] = polityCache[i - 1] as PolityCacheEntry;
        polityCache[i - 1] = entry;
      }
      return entry.polity;
    }
  }

  const pr = prestige(capital, seed);
  const reach = NATION_REACH_MIN + NATION_REACH_SPAN * pr;
  const cities = neighbourhoodAt(capital.cellX, capital.cellZ, terrain, climate, seed);
  let memberCount = 0;
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i] as CitySite;
    const owner = capitalOf(c, terrain, climate, seed);
    if (owner.cellX === capital.cellX && owner.cellZ === capital.cellZ) memberCount++;
  }

  const polity: Polity = {
    polityId: hash2i(capital.cellX, capital.cellZ, (seed ^ SALT.polity) >>> 0) >>> 0,
    capitalCellX: capital.cellX,
    capitalCellZ: capital.cellZ,
    capitalX: capital.x,
    capitalZ: capital.z,
    prestige: pr,
    reach,
    memberCount,
    isCityState: memberCount <= 1,
  };

  polityCacheBuilds++;
  polityCache.unshift({ capitalCellX: capital.cellX, capitalCellZ: capital.cellZ, worldSeed: seed, terrain, climate, polity });
  if (polityCache.length > POLITY_CACHE_LIMIT) polityCache.length = POLITY_CACHE_LIMIT;
  return polity;
}

/** The polity `site` belongs to -- its own, if it is a capital, else the capital that claimed it. */
export function polityOfCity(
  site: CitySite,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): Polity {
  return computePolity(capitalOf(site, terrain, climate, worldSeed), terrain, climate, worldSeed);
}

/**
 * Push a point toward the border warp field, tapered to zero within
 * `CITY_CORE_RADIUS` of the nearest known city so a city can never be warped
 * outside its own territory.
 */
function warpQueryPoint(
  x: number,
  z: number,
  nearestUnwarpedDistance: number,
  worldSeed: number,
): { x: number; z: number } {
  const taper = smoothstep(0, CITY_CORE_RADIUS, nearestUnwarpedDistance);
  if (taper <= 0) return { x, z };
  const w = warp2(x, z, (worldSeed ^ SALT.borderWarp) >>> 0, BORDER_WARP_METRES, BORDER_WARP_FREQUENCY);
  return { x: x + (w.x - x) * taper, z: z + (w.z - z) * taper };
}

/**
 * The polity owning a point, or `undefined` when the point is sea or beyond
 * every polity's frontier.
 *
 * Territory is multiplicatively weighted Voronoi over MEMBER CITIES (not
 * capitals): every city in reach pulls territory toward it in proportion to
 * its OWN polity's prestige, `weight = distance / (1 + CITY_PULL *
 * prestige)`. That is what makes intra-nation borders vanish (every member
 * city of the same polity pulls for the same owner) while inter-nation
 * borders stay sharp, and it is also what makes an enclave possible: a
 * strong nation's member city can out-pull a weak neighbour's own capital
 * near that capital's own doorstep. `polity.test.ts` records this as a
 * feature, with a test that one exists on the default seed.
 */
export function polityAt(
  x: number,
  z: number,
  terrain: PolityTerrain,
  climate: PolityClimate,
  worldSeed: number,
): Polity | undefined {
  if (terrain.height(x, z, worldSeed) < terrain.seaLevel) return undefined;

  const cellX = Math.floor(x / CITY_CELL);
  const cellZ = Math.floor(z / CITY_CELL);
  const cities = neighbourhoodAt(cellX, cellZ, terrain, climate, worldSeed);
  if (cities.length === 0) return undefined;

  let nearestUnwarped = Infinity;
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i] as CitySite;
    const dx = x - c.x;
    const dz = z - c.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < nearestUnwarped) nearestUnwarped = d;
  }
  const q = warpQueryPoint(x, z, nearestUnwarped, worldSeed);

  let bestCapital: CitySite | undefined;
  let bestWeighted = Infinity;
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i] as CitySite;
    const capital = capitalOf(c, terrain, climate, worldSeed);
    const pr = prestige(capital, worldSeed);
    const dx = q.x - c.x;
    const dz = q.z - c.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const weighted = d / (1 + CITY_PULL * pr);
    if (weighted < bestWeighted) {
      bestWeighted = weighted;
      bestCapital = capital;
    }
  }
  if (bestCapital === undefined) return undefined;

  const polity = computePolity(bestCapital, terrain, climate, worldSeed);
  if (bestWeighted > polity.reach) return undefined;
  return polity;
}
