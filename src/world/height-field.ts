/**
 * The height field: the single source of truth for the shape of the world.
 *
 * `sampleHeight(x, z, worldSeed)` is the whole terrain. The chunk generator
 * calls it once per vertex, the main thread calls it to seat the placeholder
 * cube, and Phase 8's collision will call it too. There is deliberately no
 * second, "cheaper" copy of this maths anywhere: the moment two implementations
 * exist they drift, and the symptom is objects floating above or sinking into
 * ground that renders correctly.
 *
 * Pure, synchronous, no Three.js, no DOM -- importable from a Web Worker and
 * from a Node test, exactly like `noise.ts` and `contracts.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS
 *
 * Four low-frequency scalar fields describe the world before any relief is
 * added. Phase 4 onward reads them to choose biomes, settlement sites and
 * vegetation; nothing about them is chunk-aware, so a biome decided at the
 * Region tier and one sampled per-vertex at the Chunk tier agree by
 * construction (RULE 3 is satisfied trivially -- there is no tier here at all,
 * only position).
 *
 *   continentalness  [-1, 1]  ocean basin ... deep inland
 *   erosion          [-1, 1]  jagged young relief ... worn-flat old relief
 *   temperature      [ 0, 1]  polar ... tropical
 *   humidity         [ 0, 1]  desert ... rainforest
 *
 * ---------------------------------------------------------------------------
 * THE ELEVATION MODEL
 *
 *   base       continent shelf: a smooth ramp driven by continentalness, warped
 *              so coastlines meander instead of running statistically straight
 *   mountains  ridged multifractal, masked by continentalness (no mountains in
 *              the sea) and by erosion (no mountains on worn-down ground)
 *   hills      mid-frequency fBm, damped by erosion
 *   detail     high-frequency fBm, small amplitude, everywhere
 *
 * Heights are absolute metres, measured from `SEA_LEVEL`. Ground below it is
 * sea floor: Phase 3a puts a water surface over exactly that ground.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Everything here uses exact IEEE-754 operations only -- see the note at the
 * top of `noise.ts` for why `Math.pow` and the trigonometric functions are
 * avoided on this path.
 */

import { hash2i, hashCombine } from '../core/hash';
import {
  GradeBlend,
  GRADE_LIFT,
  GRADE_OUT_LENGTH,
  ROAD_MAX_CUT,
  ROAD_MAX_FILL,
} from './grading';
import { clamp, fbm2, hashUnit, lerp, ridged2, smoothstep, unitToZeroOne, warp2 } from './noise';
import {
  RIVER_MAX_CUT,
  regionRiverField,
  riverDrop,
  type RegionRiverField,
  type RiverTerrain,
} from './rivers';
import {
  regionRoadField,
  type CityCandidateSource,
  type HinterlandDistance,
  type RegionRoadField,
  type RoadRivers,
  type RoadTerrain,
} from './roads';
import { sectorLotField, type LotGround, type SectorLotField } from './lots';
import { sectorStreetField, type SectorStreetField } from './streets';
import {
  citiesInBox,
  nearestCityDistance,
  polityAt,
  type Polity,
  type PolityClimate,
} from './polity';
import { cultureIdAt } from './culture';

// ---------------------------------------------------------------------------
// Sea level
// ---------------------------------------------------------------------------

/**
 * The altitude of the sea, in absolute world metres. THE definition of where
 * the coastline is.
 *
 * Until Phase 3a this was implicit: `sampleHeight` returned negative values in
 * basins, `surfaceColor` faded silt into sand somewhere around zero, and
 * nothing else knew. Two independent hardcoded zeros is exactly how a shoreline
 * ends up with the water surface and the sand band in different places, so
 * there is now one constant and both read it.
 *
 * It lives here rather than in `chunk-gen.ts` because it is a property of the
 * WORLD, not of how a chunk is meshed: the elevation model's `SHELF_FLOOR` and
 * `SHELF_CEILING` are quoted relative to it, Phase 3b's rivers will drain to
 * it, and Phase 8's swimming test will be against it.
 *
 * Changing it moves the coastline coherently -- the water surface, the sand
 * band and the snow line all shift together -- but it moves every committed
 * screenshot baseline with it, so treat it as a world-defining constant rather
 * than a tuning knob.
 */
export const SEA_LEVEL = 0;

// ---------------------------------------------------------------------------
// Per-field seeds
// ---------------------------------------------------------------------------

/**
 * Distinct salts so the four fields are independent. Folding the salt through
 * `hashCombine` rather than adding it avoids the near-identical streams that
 * `seed + 1`, `seed + 2` would produce.
 */
const SALT = {
  continent: 0x436f_6e74,
  continentWarp: 0x4357_7270,
  erosion: 0x4572_6f73,
  temperature: 0x5465_6d70,
  humidity: 0x4875_6d69,
  mountain: 0x4d6f_756e,
  mountainWarp: 0x4d57_7270,
  hills: 0x4869_6c6c,
  detail: 0x4465_7461,
} as const;

function fieldSeed(worldSeed: number, salt: number): number {
  return hashCombine(worldSeed >>> 0, salt);
}

/**
 * Metres each field's noise lattice is shifted by, derived from the seed.
 *
 * WHY THIS EXISTS. Gradient noise is exactly zero at every lattice point, and
 * the world origin is a lattice point of every frequency. Without a shift,
 * `sampleHeight(0, 0, seed)` returned the identical value for every seed --
 * the terrain at the origin was seed-independent, which is both an obvious
 * artefact and a silent hole in the `?seed=` verification story (two seeds
 * would agree exactly where the default camera looks). Offsetting the lattice
 * by a seed-derived amount fixes both, and costs one hash per field.
 *
 * Split into two functions rather than returning a point, because these are on
 * the per-vertex path and an object per call is millions of allocations per
 * soak run.
 */
const OFFSET_SPAN = 16384;

function offsetX(worldSeed: number, salt: number): number {
  return hashUnit(hash2i(0x4f, 0x58, fieldSeed(worldSeed, salt))) * OFFSET_SPAN;
}

function offsetZ(worldSeed: number, salt: number): number {
  return hashUnit(hash2i(0x4f, 0x5a, fieldSeed(worldSeed, salt))) * OFFSET_SPAN;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres of warp applied to the continent field, and the scale it varies over.
 * Large amplitude at low frequency is what turns a blobby fBm coastline into
 * one with peninsulas and bays.
 */
const CONTINENT_WARP_METRES = 900;
const CONTINENT_WARP_FREQUENCY = 1 / 2600;

/** ~6 km continents. */
const CONTINENT_FREQUENCY = 1 / 6200;
const CONTINENT_OCTAVES = 5;

const EROSION_FREQUENCY = 1 / 3300;
const EROSION_OCTAVES = 3;

const TEMPERATURE_FREQUENCY = 1 / 9000;
const HUMIDITY_FREQUENCY = 1 / 4600;
const CLIMATE_OCTAVES = 3;

/** Mountain ranges: ~1.5 km between ridges, warped so they are not radially symmetric. */
const MOUNTAIN_FREQUENCY = 1 / 1500;
const MOUNTAIN_OCTAVES = 6;
const MOUNTAIN_WARP_METRES = 260;
const MOUNTAIN_WARP_FREQUENCY = 1 / 2100;

const HILL_FREQUENCY = 1 / 520;
const HILL_OCTAVES = 4;

const DETAIL_FREQUENCY = 1 / 110;
const DETAIL_OCTAVES = 5;

/** Vertical scale of each contribution, in metres. */
const SHELF_FLOOR = -48;
const SHELF_CEILING = 92;
const MOUNTAIN_AMPLITUDE = 210;
const HILL_AMPLITUDE = 46;
const DETAIL_AMPLITUDE = 13;

/**
 * Advisory bounds on `sampleHeight`, for camera placement and for tests.
 * The extremes require several independent fields to peak together, so real
 * terrain sits well inside them; they are a guarantee, not a description.
 *
 * The floor drops by `RIVER_MAX_CUT` from Phase 3b: a channel carved into the
 * deepest possible basin is the lowest ground the world can produce. Phase 4a
 * adds `ROAD_MAX_CUT` below and `ROAD_MAX_FILL` above, because road grading is
 * the first thing in the project that can RAISE the ground -- a river only ever
 * cuts, so until then nothing pushed the ceiling. Phase 4b's streets add
 * nothing here: they share the same caps, because they share the same blend.
 */
export const MIN_HEIGHT =
  SHELF_FLOOR - HILL_AMPLITUDE - DETAIL_AMPLITUDE - RIVER_MAX_CUT - ROAD_MAX_CUT;
export const MAX_HEIGHT =
  SHELF_CEILING + MOUNTAIN_AMPLITUDE + HILL_AMPLITUDE + DETAIL_AMPLITUDE + ROAD_MAX_FILL;

// ---------------------------------------------------------------------------
// The biome fields
// ---------------------------------------------------------------------------

/**
 * Continent mass in [-1, 1]. Negative is ocean basin, positive is land; the
 * transition around zero is the coastline.
 *
 * Domain-warped so the coast meanders. This is the field everything else is
 * masked by, so it is deliberately the lowest frequency of the four.
 */
export function continentalness(x: number, z: number, worldSeed: number): number {
  const px = x + offsetX(worldSeed, SALT.continent);
  const pz = z + offsetZ(worldSeed, SALT.continent);
  const w = warp2(
    px,
    pz,
    fieldSeed(worldSeed, SALT.continentWarp),
    CONTINENT_WARP_METRES,
    CONTINENT_WARP_FREQUENCY,
  );
  return clamp(
    fbm2(w.x, w.z, fieldSeed(worldSeed, SALT.continent), CONTINENT_OCTAVES, CONTINENT_FREQUENCY),
    -1,
    1,
  );
}

/**
 * How worn down the relief is, in [-1, 1]. Low values are young, jagged ground
 * that grows mountains; high values are old, flat ground that does not.
 */
export function erosion(x: number, z: number, worldSeed: number): number {
  const px = x + offsetX(worldSeed, SALT.erosion);
  const pz = z + offsetZ(worldSeed, SALT.erosion);
  return clamp(
    fbm2(px, pz, fieldSeed(worldSeed, SALT.erosion), EROSION_OCTAVES, EROSION_FREQUENCY),
    -1,
    1,
  );
}

/** Climate temperature in [0, 1]: 0 polar, 1 tropical. */
export function temperature(x: number, z: number, worldSeed: number): number {
  const px = x + offsetX(worldSeed, SALT.temperature);
  const pz = z + offsetZ(worldSeed, SALT.temperature);
  return unitToZeroOne(
    fbm2(px, pz, fieldSeed(worldSeed, SALT.temperature), CLIMATE_OCTAVES, TEMPERATURE_FREQUENCY),
  );
}

/** Climate humidity in [0, 1]: 0 desert, 1 rainforest. */
export function humidity(x: number, z: number, worldSeed: number): number {
  const px = x + offsetX(worldSeed, SALT.humidity);
  const pz = z + offsetZ(worldSeed, SALT.humidity);
  return unitToZeroOne(
    fbm2(px, pz, fieldSeed(worldSeed, SALT.humidity), CLIMATE_OCTAVES, HUMIDITY_FREQUENCY),
  );
}

export interface BiomeFields {
  readonly continentalness: number;
  readonly erosion: number;
  readonly temperature: number;
  readonly humidity: number;
}

/** All four fields at one point. Convenience only; each is independently pure. */
export function biomeFields(x: number, z: number, worldSeed: number): BiomeFields {
  return {
    continentalness: continentalness(x, z, worldSeed),
    erosion: erosion(x, z, worldSeed),
    temperature: temperature(x, z, worldSeed),
    humidity: humidity(x, z, worldSeed),
  };
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * How much of the mountain field applies at a point, in [0, 1].
 *
 * Exported because the chunk colourer and, later, the settlement placer both
 * want "is this mountainous ground" without recomputing the whole stack.
 */
export function reliefMask(continent: number, erosionValue: number): number {
  // Young ground (low erosion) keeps its relief; old ground is worn flat.
  const youth = smoothstep(-0.5, 0.4, -erosionValue);
  // No mountains at sea, and none on the coastal plain either.
  const inland = smoothstep(-0.05, 0.5, continent);
  return inland * (0.2 + 0.8 * youth);
}

/**
 * Ground height in metres at a world-space point, BEFORE rivers.
 *
 * This is exactly the body `sampleHeight` had through Phase 3a. It was split
 * out in Phase 3b, and the split is the whole architecture of everything that
 * modifies terrain from here on:
 *
 *   baseHeight   pure terrain. The only thing river routing -- and Phase 4's
 *                road routing -- is allowed to read.
 *   sampleHeight baseHeight blended toward the carved channel profile.
 *
 * Rivers carve terrain but are routed FROM terrain, which is circular unless
 * the two are separated. NOTHING UPSTREAM OF THE CARVE MAY READ `sampleHeight`:
 * if routing saw its own output the result would depend on evaluation order,
 * and RULE 1 would be gone. See `rivers.ts`.
 *
 * Almost nothing should call this directly. If you want "the height of the
 * ground", you want `sampleHeight`.
 */
export function baseHeight(x: number, z: number, worldSeed: number): number {
  const seed = worldSeed >>> 0;

  const continent = continentalness(x, z, seed);
  const erosionValue = erosion(x, z, seed);

  // Continent shelf. `land` is 0 out at sea and 1 well inland.
  const land = smoothstep(-0.42, 0.25, continent);
  const base = lerp(SHELF_FLOOR, SHELF_CEILING, land);

  // Mountains: ridged multifractal, warped, masked to young inland ground.
  const mask = reliefMask(continent, erosionValue);
  let mountains = 0;
  if (mask > 0) {
    const mx = x + offsetX(seed, SALT.mountain);
    const mz = z + offsetZ(seed, SALT.mountain);
    const w = warp2(
      mx,
      mz,
      fieldSeed(seed, SALT.mountainWarp),
      MOUNTAIN_WARP_METRES,
      MOUNTAIN_WARP_FREQUENCY,
    );
    const ridge = ridged2(
      w.x,
      w.z,
      fieldSeed(seed, SALT.mountain),
      MOUNTAIN_OCTAVES,
      MOUNTAIN_FREQUENCY,
      2.03,
      0.52,
    );
    // Squared: lifts the peaks and keeps the feet of the range flat, which is
    // what stops ridged noise reading as uniform corrugation.
    mountains = MOUNTAIN_AMPLITUDE * mask * ridge * ridge;
  }

  // Hills everywhere, damped where erosion has worn the ground down and
  // reduced but NOT removed below the shoreline -- a basin floor with no relief
  // at all reads as a featureless smear from any altitude, and Phase 3's water
  // needs a lake bed with shape to sit in.
  const hills =
    HILL_AMPLITUDE *
    (0.3 + 0.7 * land) *
    (0.35 + 0.65 * smoothstep(-0.6, 0.5, -erosionValue)) *
    fbm2(
      x + offsetX(seed, SALT.hills),
      z + offsetZ(seed, SALT.hills),
      fieldSeed(seed, SALT.hills),
      HILL_OCTAVES,
      HILL_FREQUENCY,
    );

  // Fine detail, slightly reduced under water so basins stay readable.
  const detail =
    DETAIL_AMPLITUDE *
    (0.4 + 0.6 * land) *
    fbm2(
      x + offsetX(seed, SALT.detail),
      z + offsetZ(seed, SALT.detail),
      fieldSeed(seed, SALT.detail),
      DETAIL_OCTAVES,
      DETAIL_FREQUENCY,
    );

  return base + mountains + hills + detail;
}

// ---------------------------------------------------------------------------
// Rivers
// ---------------------------------------------------------------------------

/**
 * The pre-carve world, as river routing sees it.
 *
 * One module-level constant, deliberately: `rivers.ts` compares terrains by
 * REFERENCE when it looks in its memo, so a fresh object literal per call would
 * turn every cache hit into a 56 ms miss.
 */
const WORLD_TERRAIN: RiverTerrain & RoadTerrain = {
  id: 'height-field',
  seaLevel: SEA_LEVEL,
  height: baseHeight,
};

/**
 * The region-tier river record for this world, for a chunk generator to read
 * through `TierContext.coarser('region')`.
 *
 * Both this and `sampleHeight` route through the same memo in `rivers.ts`, so
 * the ground a worker meshes and the ground the main thread seats the cube on
 * are the same arithmetic, not two implementations that agree today.
 */
export function worldRiverField(worldSeed: number): RegionRiverField {
  return regionRiverField(WORLD_TERRAIN, worldSeed);
}

// ---------------------------------------------------------------------------
// Roads and settlements
// ---------------------------------------------------------------------------

/**
 * How habitable the climate is at a point, in [0, 1].
 *
 * Passed into the road generator rather than imported by it, because
 * `roads.ts` must not depend on this module -- see the layering note there.
 * Wet temperate ground scores highest; a desert and a tundra both score low,
 * which is what keeps settlements out of the extremes without a biome table.
 *
 * Exported (Phase Politics P1) so `polity.ts`'s siting and `src/debug/world-
 * map.ts` can inject the SAME formula `roads.ts` already grades settlements
 * with, through the same by-reference-injection discipline, rather than each
 * hand-duplicating it and risking drift.
 */
export function habitability(x: number, z: number, worldSeed: number): number {
  const warmth = 1 - Math.abs(temperature(x, z, worldSeed) - 0.62) * 2.4;
  const wet = smoothstep(0.25, 0.62, humidity(x, z, worldSeed));
  return clamp(warmth, 0, 1) * (0.35 + 0.65 * wet);
}

/**
 * The climate `polity.ts`'s siting is allowed to see. One module-level
 * constant, for the same reference-identity reason `WORLD_TERRAIN` is:
 * `polity.ts`'s `cityAt`/`neighbourhoodAt` memos compare it by reference.
 */
const WORLD_CLIMATE: PolityClimate = { continentalness, habitability };

/**
 * `roads.ts`'s view of `polity.ts`'s cities -- injected, not imported, the
 * same discipline `habitability` above already uses. `roads.ts` never learns
 * that `polity.ts` exists; it only sees a function of this shape.
 */
const politicalCityCandidates: CityCandidateSource = (x0, z0, x1, z1, worldSeed) =>
  citiesInBox(x0, z0, x1, z1, WORLD_TERRAIN, WORLD_CLIMATE, worldSeed);

/** Same injection discipline, for the hinterland-aware acceptance threshold. */
const politicalHinterlandDistance: HinterlandDistance = (x, z, worldSeed) =>
  nearestCityDistance(x, z, WORLD_TERRAIN, WORLD_CLIMATE, worldSeed);

/**
 * The road generator's view of the rivers, bound to one seed.
 *
 * A module-level factory per seed, held by `worldRegionField`, so the object
 * identity is stable for the life of a region record. `roads.ts` only ever asks
 * for the carve depth -- where a crossing is expensive, and where grading must
 * stand down.
 */
function roadRivers(rivers: RegionRiverField): RoadRivers {
  return { drop: (x, z, base) => rivers.drop(x, z, base) };
}

/**
 * Everything the Region tier produces, in the single slot `TierContext` gives it.
 *
 * `CoarseData` is keyed by tier NAME, so there is exactly one `'region'` entry
 * however many generators live at that tier. Rivers and roads therefore travel
 * together in one record rather than as two coarse reads -- which is also the
 * right shape, since a chunk vertex needs both at the same point and would
 * otherwise pay two lookups to say so.
 */
export interface RegionField {
  readonly worldSeed: number;
  readonly rivers: RegionRiverField;
  readonly roads: RegionRoadField;
  readonly politics: RegionPolitics;
}

/**
 * The political query surface a chunk generator gets through `RegionField`.
 *
 * A thin, chunk-facing wrapper over `polity.ts`, bound to this world's
 * terrain/climate/seed the same way `roads`/`rivers` already are -- so
 * `chunk-gen.ts` never imports `polity.ts` or `culture.ts` directly, matching
 * every other Region-tier consumer in this project.
 */
export interface RegionPolitics {
  /** The polity owning a point, or `undefined` if sea or beyond every frontier. */
  polityAt(x: number, z: number): Polity | undefined;
  /** The culture id a polity's capital belongs to. */
  cultureOf(polity: Polity): number;
}

/**
 * The Region-tier record for this world, for a chunk generator to read through
 * `TierContext.coarser('region')`.
 *
 * The road field is handed the SAME `WORLD_TERRAIN` constant the river field
 * uses, for the same reason: both memos compare terrain by reference, so a
 * fresh literal per call would turn every cache hit into a rebuild.
 */
export function worldRegionField(worldSeed: number): RegionField {
  const seed = worldSeed >>> 0;
  const rivers = regionRiverField(WORLD_TERRAIN, seed);
  return {
    worldSeed: seed,
    rivers,
    roads: regionRoadField(
      WORLD_TERRAIN,
      roadRivers(rivers),
      habitability,
      seed,
      politicalCityCandidates,
      politicalHinterlandDistance,
    ),
    politics: {
      polityAt: (x, z) => polityAt(x, z, WORLD_TERRAIN, WORLD_CLIMATE, seed),
      cultureOf: (polity) =>
        cultureIdAt(
          polity.capitalCellX,
          polity.capitalCellZ,
          seed,
          temperature(polity.capitalX, polity.capitalZ, seed),
          humidity(polity.capitalX, polity.capitalZ, seed),
        ),
    },
  };
}

/**
 * Everything the SECTOR tier produces, in the second slot `TierContext` gives it.
 *
 * Phase 4b, and the first time `CoarseData` holds two entries at once. A sector
 * record is not one sector's data any more than the region record is one
 * region's: it is a whole-world accessor that memoises per sector behind
 * `streets.ts` and `lots.ts`, exactly as `RegionRoadField` does per region. That
 * is what lets a single object serve a chunk whose padded sample grid straddles
 * a sector boundary, and a coarse quadtree node that spans sixteen of them.
 *
 * Phase 6 made it a record of TWO fields rather than an alias for the street
 * one. `RegionField` has held rivers and roads together since Phase 4a for the
 * same reason: `CoarseData` has one slot per tier NAME, so every generator at a
 * tier travels in one object however many of them there are.
 *
 * THE TWO ARE NOT SYMMETRIC, AND THE ORDER THEY ARE BUILT IN IS THE REASON.
 * Streets GRADE the ground, so they are part of the composition below and every
 * height in the world depends on them. Lots READ the finished ground to decide
 * where a building can stand, so they depend on the composition. Building the
 * lot field from an already-built street field is what keeps that one-way; a
 * combined generator that did both at once would have to evaluate the ground
 * while still deciding what the ground is.
 */
export interface SectorField {
  readonly worldSeed: number;
  readonly streets: SectorStreetField;
  readonly lots: SectorLotField;
}

/**
 * The Region- and Sector-tier records this module's own `sampleHeight` grades
 * with, built once per seed and held.
 *
 * Rebuilding them per call would be a correctness problem, not just a slow one:
 * both memos are keyed on the terrain by REFERENCE, and the sector field closes
 * over the region record, so a fresh object per call would re-route a region on
 * the main thread every time anything asked for the height of the ground.
 */
let mainSeed = -1;
let mainRegion: RegionField | undefined;
let mainSectors: SectorField | undefined;

function mainFields(worldSeed: number): { region: RegionField; sectors: SectorField } {
  if (mainRegion === undefined || mainSectors === undefined || mainSeed !== worldSeed) {
    mainSeed = worldSeed;
    mainRegion = worldRegionField(worldSeed);
    mainSectors = worldSectorField(mainRegion, worldSeed);
  }
  return { region: mainRegion, sectors: mainSectors };
}

/**
 * The ground, as `lots.ts` is allowed to see it: the finished surface, and the
 * altitude everything grading a point agreed on before the caps and the river
 * yield were applied.
 *
 * INJECTED RATHER THAN IMPORTED, and this is the reason the injection exists at
 * all. `lots.ts` cannot import this module -- this one imports it -- and, far
 * more importantly, a lot decided against a second implementation of "where is
 * the ground" is a building sunk a metre into the grass. Both methods here are
 * the same two functions every other caller uses.
 *
 * Its own scratch pair, not `mainBlend`: a lot query can run inside a worker's
 * chunk generation, where `sampleHeight` may be on the stack, and two callers
 * sharing one `GradeBlend` is the one way to make this composition non-pure.
 */
function lotGround(region: RegionField, streets: SectorStreetField, worldSeed: number): LotGround {
  const blend = new GradeBlend();
  const out = new Float64Array(GRADE_OUT_LENGTH);
  return {
    height: (x, z) => composeHeight(region, streets, x, z, worldSeed, blend, out),
    target: (x, z) => gradeTarget(region, streets, x, z, blend),
  };
}

/**
 * The Sector-tier record for this world: street plans, then the lots that front
 * onto them.
 *
 * The lot field is handed the SAME street field the grading uses, so the ground
 * a lot was accepted on and the ground a chunk meshes are the same arithmetic
 * through the same memo, rather than two agreeing implementations.
 */
export function worldSectorField(region: RegionField, worldSeed: number): SectorField {
  const seed = worldSeed >>> 0;
  const streets = sectorStreetField(region, seed);
  return {
    worldSeed: seed,
    streets,
    lots: sectorLotField(region, streets, lotGround(region, streets, seed), seed),
  };
}

/**
 * THE COMPOSITION, IN ONE PLACE. Everything that grades the ground contributes
 * to one blend, which is then resolved once.
 *
 * There is deliberately no second copy of this: `sampleHeight` below calls it on
 * the main thread and `chunk-gen.ts` calls it per vertex inside the worker, and
 * `chunk-gen.test.ts` asserts the two agree with `===`. The moment a caller
 * resolves roads and streets separately and adds the results, a street stops
 * meeting the road it joins -- the weighted average is not distributive, which
 * is the whole reason it is a weighted average.
 *
 * `blend` and `out` are caller-owned so the per-vertex path allocates nothing.
 */
export function gradeSurface(
  region: RegionField,
  streets: SectorStreetField,
  x: number,
  z: number,
  carved: number,
  riverDrop: number,
  blend: GradeBlend,
  out: Float64Array,
): void {
  blend.reset();
  region.roads.accumulate(x, z, blend);
  streets.accumulate(x, z, blend);
  blend.resolve(carved, riverDrop, out);
}

/**
 * The whole stack at one point: terrain, the river carved into it, and the
 * grading blended over that.
 *
 * `sampleHeight` is this bound to the main thread's own records, and the lot
 * generator's `LotGround.height` is this bound to a worker's. It exists as a
 * named function precisely so that those two cannot drift: a building is
 * accepted at a floor altitude decided here and drawn against ground meshed
 * from the same arithmetic, and the failure mode of two copies is a house half
 * a metre under the grass.
 *
 * `chunk-gen.ts` deliberately does NOT call it. It needs the carve depth and the
 * surfacing coverage per vertex for its statistics and its palette, so it spells
 * the three steps out and shares the part that actually composes -- which is
 * `gradeSurface`, above, and which is where a divergence would matter.
 */
export function composeHeight(
  region: RegionField,
  streets: SectorStreetField,
  x: number,
  z: number,
  worldSeed: number,
  blend: GradeBlend,
  out: Float64Array,
): number {
  const base = baseHeight(x, z, worldSeed);
  const drop = riverDrop(WORLD_TERRAIN, worldSeed, x, z, base);
  const carved = base - drop;
  gradeSurface(region, streets, x, z, carved, drop, blend, out);
  return carved + (out[GRADE_LIFT] as number);
}

/**
 * The blended TARGET altitude at a point: the same accumulation `gradeSurface`
 * performs, stopped one step short of resolving it.
 *
 * Phase 5's deck is placed AT this altitude rather than moved toward it, so it
 * has to be the identical composition -- both tiers, one weighted average. A
 * deck that accumulated only the Region tier would float above the ground at
 * every village edge, and one that used a road's own profile instead of the
 * average would do the same. Sharing this function is what makes "the deck lies
 * flush wherever the grading succeeded" true by construction rather than by
 * tuning.
 *
 * `-Infinity` where nothing grades the point, so `max(ground, target)` needs no
 * special case. See `GradeBlend.target`.
 */
export function gradeTarget(
  region: RegionField,
  streets: SectorStreetField,
  x: number,
  z: number,
  blend: GradeBlend,
): number {
  blend.reset();
  region.roads.accumulate(x, z, blend);
  streets.accumulate(x, z, blend);
  return blend.target;
}

/** One scratch pair for the main thread's own `sampleHeight`. Never re-entered. */
const mainBlend = new GradeBlend();
const mainOut = new Float64Array(GRADE_OUT_LENGTH);

/**
 * Ground height in metres at a world-space point.
 *
 * THE single source of truth, and still the only name any caller needs: since
 * Phase 3b it is `baseHeight` with river channels carved into it, since Phase 4a
 * with road and settlement grading on top of that, and since Phase 4b with
 * Sector-tier streets in the same blend -- so every existing caller (chunk
 * vertices, normals, the water surface, the cube's seating, the camera's
 * ground-relative default Y) sees all three without changing a line.
 *
 * THE ORDER IS THE COMPOSITION RULE, AND IT IS DELIBERATE. Rivers are applied
 * first and everything else yields to them (`ROAD_RIVER_YIELD` in `grading.ts`),
 * so a road can never fill a channel and dam the river running through it. The
 * Phase 3b handoff guessed the two would combine as a `max` or a sum of drops;
 * neither works, because both assume the road's effect is a downward cut, and a
 * road that can only cut cannot cross a dip. Grading is a signed blend toward a
 * target altitude, so it composes rather than accumulates.
 *
 * ROADS AND STREETS ARE ONE BLEND, NOT TWO STEPS. They are different tiers, but
 * `gradeSurface` above accumulates both before resolving once, because a
 * weighted average is not distributive: resolving each and adding the lifts
 * would put a step exactly where a street meets the road it joins.
 *
 * If this and the rendered mesh ever disagree, the bug is in whoever duplicated
 * it, not here.
 */
export function sampleHeight(x: number, z: number, worldSeed: number): number {
  const seed = worldSeed >>> 0;
  const fields = mainFields(seed);
  return composeHeight(fields.region, fields.sectors.streets, x, z, seed, mainBlend, mainOut);
}
