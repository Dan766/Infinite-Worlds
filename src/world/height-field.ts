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
import { clamp, fbm2, hashUnit, lerp, ridged2, smoothstep, unitToZeroOne, warp2 } from './noise';
import {
  RIVER_MAX_CUT,
  regionRiverField,
  riverDrop,
  type RegionRiverField,
  type RiverTerrain,
} from './rivers';

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
 * deepest possible basin is the lowest ground the world can produce.
 */
export const MIN_HEIGHT = SHELF_FLOOR - HILL_AMPLITUDE - DETAIL_AMPLITUDE - RIVER_MAX_CUT;
export const MAX_HEIGHT = SHELF_CEILING + MOUNTAIN_AMPLITUDE + HILL_AMPLITUDE + DETAIL_AMPLITUDE;

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
const WORLD_TERRAIN: RiverTerrain = {
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

/**
 * Ground height in metres at a world-space point.
 *
 * THE single source of truth, and still the only name any caller needs: since
 * Phase 3b it is `baseHeight` with river channels carved into it, so every
 * existing caller -- chunk vertices, normals, the water surface, the cube's
 * seating, the camera's ground-relative default Y -- sees rivers without
 * changing a line.
 *
 * If this and the rendered mesh ever disagree, the bug is in whoever duplicated
 * it, not here.
 */
export function sampleHeight(x: number, z: number, worldSeed: number): number {
  const seed = worldSeed >>> 0;
  const base = baseHeight(x, z, seed);
  return base - riverDrop(WORLD_TERRAIN, seed, x, z, base);
}
