/**
 * Chunk generation. Pure, synchronous, and free of Three.js and the DOM, so the
 * same code runs inside the Web Worker and inside a Node unit test.
 *
 * Phase 2a turns the Phase 1 placeholder quad into a real heightfield patch:
 * 32x32 cells (2 m resolution), vertex Y from `sampleHeight`, normals from the
 * height field rather than from the triangles, and per-vertex colours chosen by
 * slope, altitude and climate.
 *
 * WHY VERTEX COLOURS AND NOT A SHADER. The roadmap's triplanar splat material
 * belongs to Phase 11. Computing the surface colour here keeps this module the
 * single testable source of truth for what the world looks like -- a Node test
 * can assert that a cliff is grey and a plain is green without a GPU -- and
 * leaves the material dumb enough that Phase 11 can replace it outright.
 *
 * RULE 1: the only inputs are the coordinate and `TierContext`. No clock, no
 * counters, no ambient state.
 */

import { rngAt2i } from '../core/hash';
import { humidity, sampleHeight, temperature } from './height-field';
import { clamp, gradientNoise2, lerp, smoothstep } from './noise';
import {
  CHUNK_DATA_VERSION,
  chunkSizeAt,
  type ChunkCoord,
  type ChunkData,
  type TierContext,
} from './contracts';

/**
 * Convert HSL to RGB. Hand-rolled rather than borrowed from Three.js because
 * this module must stay importable from a worker and from Node.
 *
 * Inputs and outputs are in [0, 1].
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) return [l, l, l];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const channel = (t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

/**
 * A stable identity colour for a chunk: a pure function of `(worldSeed, coord)`.
 *
 * Since Phase 2a nothing renders this -- the surface uses per-vertex terrain
 * colours -- but it remains the cheapest "is this the same chunk" handle there
 * is, and the streamer still samples it for debug readouts.
 */
export function chunkColor(coord: ChunkCoord, worldSeed: number): [number, number, number] {
  const rng = rngAt2i(coord.x, coord.z, worldSeed);
  const hue = rng.float();
  const saturation = 0.35 + rng.float() * 0.3;
  const lightness = 0.32 + rng.float() * 0.26;
  return hslToRgb(hue, saturation, lightness);
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/**
 * Cells per node edge. 32 cells is 2 m resolution at lod 0: 1089 vertices and
 * 2048 triangles per chunk.
 *
 * Every level of the Phase 2b quadtree uses the same segment count, which is
 * what makes a coarse node cheaper to draw than the four fine nodes it
 * replaces. Do not make this depend on lod.
 */
export const SEGMENTS = 32;

/** Vertices along one node edge. */
export const VERTS_PER_EDGE = SEGMENTS + 1;

/**
 * World-space X of the vertex at column `col`.
 *
 * Exported, and used by `generateChunk` itself, so a test can assert that the
 * height under a rendered vertex is the height `sampleHeight` reports at that
 * exact world position. Computed from the node origin every time rather than
 * accumulated across the loop: `origin + col * step` is exact for these values,
 * whereas `x += step` drifts, and a drifting vertex grid is precisely the bug
 * that makes a player fall through the floor.
 */
export function vertexWorldX(coord: ChunkCoord, col: number): number {
  const size = chunkSizeAt(coord.lod);
  // Spelled out rather than via `chunkOrigin`, which would allocate a point per
  // call on a path that runs ~1200 times per chunk. Identical arithmetic.
  return coord.x * size + (col * size) / SEGMENTS;
}

/** World-space Z of the vertex at row `row`. See `vertexWorldX`. */
export function vertexWorldZ(coord: ChunkCoord, row: number): number {
  const size = chunkSizeAt(coord.lod);
  return coord.z * size + (row * size) / SEGMENTS;
}

/**
 * Ground height at a node's `(col, row)` vertex.
 *
 * This is the exact call `generateChunk` makes, exported so the parity test can
 * compare it against `sampleHeight` at independently derived world coordinates.
 * `col` and `row` may be -1 or `SEGMENTS + 1`: the generator samples a one-cell
 * skirt around the node to compute seamless normals.
 */
export function vertexHeight(coord: ChunkCoord, col: number, row: number, worldSeed: number): number {
  return sampleHeight(vertexWorldX(coord, col), vertexWorldZ(coord, row), worldSeed);
}

// ---------------------------------------------------------------------------
// Surface colour
// ---------------------------------------------------------------------------

/**
 * sRGB -> linear, without `Math.pow`.
 *
 * Three.js colour management expects vertex colours in linear space. The exact
 * transfer function needs `x^2.4`, but `Math.pow` is only *approximated* by the
 * ECMAScript spec, so two engines may disagree in the last bits -- and this
 * value ends up in a transferred buffer that RULE 2 says must come back
 * identical. This polynomial is accurate to about 0.001 across [0, 1] and uses
 * nothing but exact IEEE multiplies and adds.
 */
function srgbToLinear(c: number): number {
  const x = clamp(c, 0, 1);
  return x * (x * (x * 0.305306011 + 0.682171111) + 0.012522878);
}

/** Palette entries are authored in sRGB, because that is how eyes read them. */
const SAND: readonly [number, number, number] = [0.78, 0.71, 0.52];
const GRASS_DRY: readonly [number, number, number] = [0.55, 0.53, 0.29];
const GRASS_LUSH: readonly [number, number, number] = [0.19, 0.4, 0.16];
const ROCK: readonly [number, number, number] = [0.44, 0.42, 0.4];
const SNOW: readonly [number, number, number] = [0.92, 0.93, 0.95];
const SILT: readonly [number, number, number] = [0.33, 0.35, 0.29];

/** Metres of altitude at which snow starts, before the temperature shift. */
const SNOW_LINE = 195;
/** Metres the snow line moves between a polar and a tropical climate. */
const SNOW_LINE_TEMPERATURE_SWING = 70;

export interface SurfaceInputs {
  /** Absolute world height in metres. */
  height: number;
  /** 0 on flat ground, 1 on a vertical face. Derived from the surface normal. */
  slope: number;
  /** Climate temperature in [0, 1]. */
  temperature: number;
  /** Climate humidity in [0, 1]. */
  humidity: number;
  /** Small per-point variation in [-1, 1] that breaks up flat bands. */
  variation: number;
}

/**
 * The colour of the ground at one point, in sRGB.
 *
 * Kept as a pure function of five scalars so it can be unit-tested directly:
 * "a steep face is rock", "a high cold peak is snow", "a wet lowland is green".
 * That is the check that would actually fail if the height field broke, which a
 * byte-comparison of a screenshot cannot tell you.
 */
export function surfaceColor(inputs: SurfaceInputs): [number, number, number] {
  const { height, slope, variation } = inputs;

  // Wet lowland green through to dry scrub.
  const grass: [number, number, number] = [
    lerp(GRASS_DRY[0], GRASS_LUSH[0], inputs.humidity),
    lerp(GRASS_DRY[1], GRASS_LUSH[1], inputs.humidity),
    lerp(GRASS_DRY[2], GRASS_LUSH[2], inputs.humidity),
  ];

  // Basin silt -> shore sand -> vegetation, by altitude.
  const shore = smoothstep(-14, 1, height);
  const inland = smoothstep(2, 16, height);
  let r = lerp(lerp(SILT[0], SAND[0], shore), grass[0], inland);
  let g = lerp(lerp(SILT[1], SAND[1], shore), grass[1], inland);
  let b = lerp(lerp(SILT[2], SAND[2], shore), grass[2], inland);

  // Anything steep is bare rock, whatever else it would have been.
  const rocky = smoothstep(0.1, 0.36, slope);
  r = lerp(r, ROCK[0], rocky);
  g = lerp(g, ROCK[1], rocky);
  b = lerp(b, ROCK[2], rocky);

  // Snow above the line, but not on faces too steep to hold it. A warm climate
  // pushes the line UP; a polar one brings it down to the coast.
  const line = SNOW_LINE + SNOW_LINE_TEMPERATURE_SWING * (inputs.temperature - 0.5) * 2;
  const snowy = smoothstep(line, line + 42, height) * (1 - smoothstep(0.55, 0.8, slope));
  r = lerp(r, SNOW[0], snowy);
  g = lerp(g, SNOW[1], snowy);
  b = lerp(b, SNOW[2], snowy);

  // A few percent of lightness variation, so large flat areas do not read as a
  // single printed swatch.
  const tint = 1 + variation * 0.07;
  return [clamp(r * tint, 0, 1), clamp(g * tint, 0, 1), clamp(b * tint, 0, 1)];
}

/** Frequency of the per-point colour variation, in cycles per metre. */
const TINT_FREQUENCY = 1 / 47;
const TINT_SALT = 0x54_69_6e_74;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate one chunk.
 *
 * X and Z positions are node-local (0..`chunkSizeAt(lod)`) so the mesh can be
 * placed by translating its parent object, which keeps float precision usable
 * far from the origin. Y is absolute world height.
 *
 * Normals come from central differences of the height field, sampled one cell
 * beyond the node on every side, NOT from the triangles of this mesh. Triangle
 * normals would be discontinuous at every chunk border, and the seam would be a
 * visible lighting crease running along every 64 m boundary in the world.
 * Sampling the field instead means neighbouring chunks compute the same normal
 * at a shared vertex, because they evaluate the same function at the same
 * world position.
 */
export function generateChunk(coord: ChunkCoord, context: TierContext): ChunkData {
  if (context.tier !== 'chunk') {
    throw new Error(`generateChunk needs a 'chunk' TierContext, got '${context.tier}'`);
  }

  const worldSeed = context.worldSeed;
  const side = VERTS_PER_EDGE;
  const size = chunkSizeAt(coord.lod);
  const step = size / SEGMENTS;

  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const colors = new Float32Array(side * side * 3);
  const indices = new Uint32Array(SEGMENTS * SEGMENTS * 6);

  // Heights on a grid padded by one cell, so every interior normal has both
  // neighbours available and border normals match the adjacent chunk exactly.
  const padded = side + 2;
  const heights = new Float64Array(padded * padded);
  for (let row = -1; row <= SEGMENTS + 1; row++) {
    for (let col = -1; col <= SEGMENTS + 1; col++) {
      heights[(row + 1) * padded + (col + 1)] = vertexHeight(coord, col, row, worldSeed);
    }
  }
  const heightAt = (col: number, row: number): number =>
    heights[(row + 1) * padded + (col + 1)] as number;

  let minY = Infinity;
  let maxY = -Infinity;

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const at = (row * side + col) * 3;
      const height = heightAt(col, row);

      positions[at] = col * step;
      positions[at + 1] = height;
      positions[at + 2] = row * step;

      if (height < minY) minY = height;
      if (height > maxY) maxY = height;

      // Central difference of the height field. The surface is y = h(x, z), so
      // its normal is proportional to (-dh/dx, 1, -dh/dz).
      const dhdx = (heightAt(col + 1, row) - heightAt(col - 1, row)) / (2 * step);
      const dhdz = (heightAt(col, row + 1) - heightAt(col, row - 1)) / (2 * step);
      const inverseLength = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
      const nx = -dhdx * inverseLength;
      const ny = inverseLength;
      const nz = -dhdz * inverseLength;
      normals[at] = nx;
      normals[at + 1] = ny;
      normals[at + 2] = nz;

      const worldX = vertexWorldX(coord, col);
      const worldZ = vertexWorldZ(coord, row);
      const [r, g, b] = surfaceColor({
        height,
        // ny is cos(angle from vertical), so 1 - ny is 0 flat and 1 vertical.
        slope: 1 - ny,
        temperature: temperature(worldX, worldZ, worldSeed),
        humidity: humidity(worldX, worldZ, worldSeed),
        variation: gradientNoise2(
          worldX * TINT_FREQUENCY,
          worldZ * TINT_FREQUENCY,
          (worldSeed ^ TINT_SALT) >>> 0,
        ),
      });
      colors[at] = srgbToLinear(r);
      colors[at + 1] = srgbToLinear(g);
      colors[at + 2] = srgbToLinear(b);
    }
  }

  let write = 0;
  for (let row = 0; row < SEGMENTS; row++) {
    for (let col = 0; col < SEGMENTS; col++) {
      const a = row * side + col;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      // Counter-clockwise when viewed from +Y, so the surface faces up.
      indices[write++] = a;
      indices[write++] = c;
      indices[write++] = b;
      indices[write++] = b;
      indices[write++] = c;
      indices[write++] = d;
    }
  }

  return {
    version: CHUNK_DATA_VERSION,
    coord: { x: coord.x, z: coord.z, lod: coord.lod },
    worldSeed,
    positions,
    indices,
    normals,
    colors,
    color: chunkColor(coord, worldSeed),
    minY,
    maxY,
  };
}
