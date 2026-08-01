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
import { humidity, SEA_LEVEL, sampleHeight, temperature } from './height-field';
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
 * Cells per node edge. 32 cells is 2 m resolution at lod 0.
 *
 * Every level of the Phase 2b quadtree uses the same segment count, which is
 * what makes a coarse node cheaper to draw than the four fine nodes it
 * replaces. Do not make this depend on lod.
 *
 * It also stays 32 because the Phase 2a profile on real hardware said so: 1.46
 * ms median GPU render for the whole scene at 1080p is ~11x headroom, while
 * draw calls and heap were the things over budget. Lowering `SEGMENTS` would be
 * optimising against the dev container's software rasteriser, which is a
 * measurement artifact and not a machine anyone runs this on.
 */
export const SEGMENTS = 32;

/** Vertices along one node edge. */
export const VERTS_PER_EDGE = SEGMENTS + 1;

/** Vertices in the terrain surface grid itself, before the skirt. */
export const SURFACE_VERTEX_COUNT = VERTS_PER_EDGE * VERTS_PER_EDGE;

/** Triangles in the terrain surface grid itself, before the skirt. */
export const SURFACE_TRIANGLE_COUNT = SEGMENTS * SEGMENTS * 2;

/**
 * Vertices in the skirt apron: one duplicate of each border vertex, per edge.
 * Corners are duplicated once per edge they belong to, which is what closes the
 * apron at the corners without any special case.
 */
export const SKIRT_VERTEX_COUNT = 4 * VERTS_PER_EDGE;

/**
 * Triangles in the skirt apron: two per cell along each of the four edges, and
 * then the same two again wound the other way.
 *
 * THE DUPLICATE WINDING IS NOT WASTE, IT IS THE FIX FOR A VISIBLE BUG. A crack
 * at a level boundary is a vertical slot, and you can see into it from BOTH
 * sides -- from above the low node looking at the high one, and from above the
 * high node looking down at the low one. So the apron has to be opaque from
 * both, and there are only two ways to get that:
 *
 *  - a double-sided material, which Three.js implements by flipping the normal
 *    on back faces. The apron copies the surface normal, so the flipped copy
 *    points into the ground and shades almost black. Worse, two same-level
 *    neighbours put IDENTICAL aprons in the same plane, so a lit front face and
 *    a black back face z-fight along every node boundary in the world. That is
 *    not theoretical: it was the first thing visible in the Phase 2b screenshots.
 *  - emitting both windings and keeping the material single-sided, which is
 *    this. Whichever copy faces the camera is drawn with the surface's own
 *    normal, the other is culled before rasterising, and the coincident aprons
 *    of two same-level neighbours are then bit-identical -- so the z-fight
 *    between them is invisible by construction.
 *
 * It costs 256 triangles a node, about 11%, against a seam on every edge.
 */
export const SKIRT_TRIANGLE_COUNT = 4 * SEGMENTS * 4;

export const VERTEX_COUNT = SURFACE_VERTEX_COUNT + SKIRT_VERTEX_COUNT;
export const TRIANGLE_COUNT = SURFACE_TRIANGLE_COUNT + SKIRT_TRIANGLE_COUNT;

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
 * MARGIN around the node to compute seamless normals. That margin is unrelated
 * to the Phase 2b skirt below -- it is sampling, not geometry.
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

/** Metres ABOVE SEA LEVEL at which snow starts, before the temperature shift. */
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
 * Metres BELOW `SEA_LEVEL` at which the sea floor is fully silt, and metres
 * ABOVE it at which the beach has finished turning into vegetation.
 *
 * These four numbers were bare literals (-14, 1, 2, 16) until Phase 3a, which
 * is how a shoreline gets a sand band in one place and a water surface in
 * another. They are offsets from `SEA_LEVEL` now, so moving sea level moves the
 * beach with it.
 */
const SILT_DEPTH = 14;
const SAND_TOP = 1;
const VEGETATION_START = 2;
const VEGETATION_FULL = 16;

/**
 * The colour of the ground at one point, in sRGB.
 *
 * Kept as a pure function of five scalars so it can be unit-tested directly:
 * "a steep face is rock", "a high cold peak is snow", "a wet lowland is green".
 * That is the check that would actually fail if the height field broke, which a
 * byte-comparison of a screenshot cannot tell you.
 *
 * Every altitude band here is anchored to `SEA_LEVEL`, which is the same
 * constant the water surface is built at. That shared anchor IS the shoreline:
 * if the two ever read different zeros, the sand would sit somewhere the sea
 * does not.
 */
export function surfaceColor(inputs: SurfaceInputs): [number, number, number] {
  const { height, slope, variation } = inputs;

  // Wet lowland green through to dry scrub.
  const grass: [number, number, number] = [
    lerp(GRASS_DRY[0], GRASS_LUSH[0], inputs.humidity),
    lerp(GRASS_DRY[1], GRASS_LUSH[1], inputs.humidity),
    lerp(GRASS_DRY[2], GRASS_LUSH[2], inputs.humidity),
  ];

  // Basin silt -> shore sand -> vegetation, by altitude above sea level.
  const shore = smoothstep(SEA_LEVEL - SILT_DEPTH, SEA_LEVEL + SAND_TOP, height);
  const inland = smoothstep(SEA_LEVEL + VEGETATION_START, SEA_LEVEL + VEGETATION_FULL, height);
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
  const line =
    SEA_LEVEL + SNOW_LINE + SNOW_LINE_TEMPERATURE_SWING * (inputs.temperature - 0.5) * 2;
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
// Water
// ---------------------------------------------------------------------------

/**
 * WHY WATER IS PER-CHUNK GEOMETRY AND NOT ONE BIG PLANE.
 *
 * A single quad the size of the view distance is the obvious first idea and it
 * is wrong in three ways here: it has to be clipped to whatever the quadtree
 * currently covers or it hangs over the edge of the world; it cannot carry
 * per-vertex depth shading, so the sea is a flat sheet of one colour; and it is
 * a main-thread object whose extent depends on camera position, which is the
 * one kind of state RULE 2 keeps out of chunk content.
 *
 * Generating it per node in the worker gets all three for free. "Clipped to the
 * visible region" is automatic -- water exists exactly where chunks do. Depth
 * shading is a per-vertex colour like the terrain's. And it is a pure function
 * of `(worldSeed, coord)` like everything else, so it regenerates
 * byte-identically and the soak's round-trip check covers it.
 *
 * TWO THINGS TERRAIN NEEDS AND WATER DOES NOT:
 *
 *  - No skirt. The crack between two nodes exists because they sample the same
 *    edge of a CURVED surface at different rates. The water surface is the
 *    plane y = SEA_LEVEL at every level, so two neighbours agree on it exactly
 *    and there is nothing to crack.
 *  - No normals in the payload. It is flat, so a normal buffer would be the
 *    same +Y vector repeated 1,089 times. `chunk-mesh.ts` fills the attribute
 *    in on the main thread, which keeps the redundancy out of the one budget
 *    this project is actually near.
 *
 * THE ONE DISCIPLINE THAT KEEPS THIS INSIDE BUDGET: a node with no ground below
 * sea level emits ZERO water vertices, zero indices and no mesh at all, so it
 * costs no draw call and no bytes. Inland is most of the world. Emitting an
 * empty water plane everywhere would roughly double the project's draw calls
 * for nothing.
 */

/** Opacity of water deep enough to hide the bottom. Never fully opaque. */
export const WATER_ALPHA_MAX = 0.88;

/**
 * Depth in metres at which opacity reaches `WATER_ALPHA_MAX`.
 *
 * Alpha is `WATER_ALPHA_MAX * sqrt(depth / this)`, which is exactly 0 at zero
 * depth. THAT is what stops the shoreline being a hard line: the water does not
 * meet the sand at some minimum opacity and stop, it fades out as the sea floor
 * rises to meet it, so the intersection is a gradient several metres wide
 * rather than an edge. The square root is chosen over a linear or smoothstep
 * ramp because real shallow water darkens fast in the first metre or two and
 * then hardly at all; `Math.sqrt` is IEEE-exact, unlike `Math.exp`, so it is
 * allowed on the path to a stored vertex (see `noise.ts`).
 */
export const WATER_ALPHA_FULL_DEPTH = 12;

/** Depth in metres at which the colour has finished going from shallow to deep. */
export const WATER_COLOR_FULL_DEPTH = 26;

/** Palette in sRGB, like the terrain's. */
const WATER_SHALLOW: readonly [number, number, number] = [0.32, 0.62, 0.6];
const WATER_DEEP: readonly [number, number, number] = [0.02, 0.09, 0.21];

/**
 * The colour of water of a given depth: sRGB red, green, blue, and alpha.
 *
 * Pure function of one scalar, for the same reason `surfaceColor` is a pure
 * function of five: "deeper water is darker and more opaque" and "water of zero
 * depth is invisible" are directly assertable properties, and no screenshot
 * comparison would tell you if they broke.
 *
 * `depth` is `SEA_LEVEL - groundHeight`, so it is negative on dry land; that
 * clamps to zero, which is what makes the water grid harmless where it overlaps
 * the beach.
 */
export function waterColor(depth: number): [number, number, number, number] {
  const d = depth > 0 ? depth : 0;

  const shade = smoothstep(0, WATER_COLOR_FULL_DEPTH, d);
  const r = lerp(WATER_SHALLOW[0], WATER_DEEP[0], shade);
  const g = lerp(WATER_SHALLOW[1], WATER_DEEP[1], shade);
  const b = lerp(WATER_SHALLOW[2], WATER_DEEP[2], shade);

  const alpha = WATER_ALPHA_MAX * Math.sqrt(clamp(d / WATER_ALPHA_FULL_DEPTH, 0, 1));
  return [r, g, b, alpha];
}

/**
 * Water vertices carry rgbA, not rgb. Four components is what makes Three.js
 * define `USE_COLOR_ALPHA` and take the fragment's opacity from the attribute,
 * which is the whole depth-fade mechanism; three components would silently
 * ignore the alpha and give a uniformly opaque sea.
 */
export const WATER_COLOR_COMPONENTS = 4;

/** Upper bounds, for tests and for reasoning about the payload budget. */
export const MAX_WATER_VERTEX_COUNT = SURFACE_VERTEX_COUNT;
export const MAX_WATER_TRIANGLE_COUNT = SURFACE_TRIANGLE_COUNT;

// ---------------------------------------------------------------------------
// Skirts
// ---------------------------------------------------------------------------

/**
 * WHY SKIRTS AND NOT STITCHED EDGES.
 *
 * Two neighbouring quadtree nodes at different levels sample the shared edge at
 * different rates: the coarse one draws a straight line between samples 2n
 * metres apart while the fine one follows the terrain, so a thin crack opens
 * between them and you see sky through the ground.
 *
 * The textbook fix is to stitch -- degenerate the fine node's edge down to the
 * coarse node's sample rate. It is rejected here for two concrete reasons, not
 * on taste:
 *
 *  1. It makes a node's index buffer a function of its NEIGHBOURS' levels. That
 *     breaks RULE 2 outright: the soak asserts a node regenerates byte-identical
 *     after an unload, and a stitched node would come back different depending
 *     on who happened to be next to it.
 *  2. It forces a mesh rebuild every time any neighbour changes level, which is
 *     constantly, on the main thread, for the node count this phase is trying
 *     to bound.
 *
 * A skirt is an apron of geometry hanging straight down from every border
 * vertex. It depends on nothing but `(seed, coord)`, it is built once in the
 * worker, and it plugs the crack from whichever side is short. It costs 132
 * vertices and 256 triangles per node -- about 12% -- which is a bargain
 * compared to giving up deterministic regeneration.
 */

/** Minimum apron depth in metres, so a perfectly flat node still has one. */
export const MIN_SKIRT_DEPTH = 1;

/**
 * Multiple of the largest step between adjacent border vertices.
 *
 * The gap to close is the coarse neighbour's linear-interpolation error across
 * one of ITS cells, which spans two of this node's cells. Bounding that by the
 * largest single-cell step and tripling it is comfortably conservative while
 * staying proportional to the local terrain -- a flat plain gets a 1 m apron and
 * a cliff edge gets one deep enough to matter. A fixed fraction of the node's
 * total relief was the obvious alternative and is far worse: it hangs a 200 m
 * curtain off every node in a mountain range, most of which sits in mid-air at
 * the outer edge of the view distance.
 */
export const SKIRT_DEPTH_FACTOR = 3;

/**
 * How far the apron hangs below the surface, read back out of a payload.
 *
 * The depth is a function of the terrain, so it cannot be recomputed on the
 * main thread without a second copy of the rule. Reading it from the buffer
 * that was actually uploaded keeps one source of truth: skirt vertex 0 is the
 * duplicate of surface vertex 0, so their Y difference IS the depth.
 * `chunk-mesh.ts` uses this to extend the bounding box, which frustum culling
 * needs or the apron gets clipped away exactly when it is doing its job.
 */
export function skirtDepthOf(positions: Float32Array): number {
  const top = positions[SKIRT_ANCHOR_INDEX * 3 + 1] as number;
  const bottom = positions[SURFACE_VERTEX_COUNT * 3 + 1] as number;
  return top - bottom;
}

/**
 * The four borders, each as an ordered walk plus the direction that is "out of
 * the node".
 *
 * The walk direction is not arbitrary: winding the apron quads consistently
 * needs `walk = (outward.z, -outward.x)`, which is what makes the generated
 * triangle normals point away from the node rather than into it.
 */
const SKIRT_EDGES = [
  { outX: 0, outZ: -1, startCol: SEGMENTS, startRow: 0, stepCol: -1, stepRow: 0 },
  { outX: 0, outZ: 1, startCol: 0, startRow: SEGMENTS, stepCol: 1, stepRow: 0 },
  { outX: -1, outZ: 0, startCol: 0, startRow: 0, stepCol: 0, stepRow: 1 },
  { outX: 1, outZ: 0, startCol: SEGMENTS, startRow: SEGMENTS, stepCol: 0, stepRow: -1 },
] as const;

/**
 * The surface vertex that skirt vertex 0 hangs from -- the start of the first
 * edge's walk, which is NOT surface vertex 0. Derived from the table rather
 * than written out, so reordering `SKIRT_EDGES` cannot silently make
 * `skirtDepthOf` read an unrelated pair of vertices.
 */
const SKIRT_ANCHOR_INDEX = SKIRT_EDGES[0].startRow * VERTS_PER_EDGE + SKIRT_EDGES[0].startCol;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** What `buildWaterSurface` returns. Empty arrays when a node has no water. */
export interface WaterSurface {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const NO_WATER: () => WaterSurface = () => ({
  positions: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
});

/**
 * The water surface of one node: a flat submesh at `SEA_LEVEL` covering the
 * part of the node whose ground is below it.
 *
 * WHY IT USES THE TERRAIN'S OWN VERTEX LATTICE. A coarser water grid is
 * tempting -- the surface is flat, so most of the resolution buys nothing --
 * and it was rejected because of what "covers the part below sea level" has to
 * mean to be artefact-free. A quad is emitted when ANY of its four corners is
 * below sea level, and because the rendered terrain inside a quad is the linear
 * interpolation of those same four corners, that condition is exactly
 * "rendered ground dips below the sea here". Two properties fall out and both
 * matter:
 *
 *  - no holes: every square metre of ground that renders below sea level has
 *    water over it, and
 *  - no invisible water: a quad is only emitted when a corner is genuinely
 *    submerged, so at least one of its vertices has non-zero depth and
 *    therefore non-zero alpha.
 *
 * A grid coarser than the terrain's breaks the second one -- a wet cell whose
 * four corners all sit on dry land shades to alpha 0 and leaves a patch of bare
 * sea floor -- and every fix for that (a minimum depth, a minimum-over-window
 * depth) either reintroduces a hard edge or makes a vertex's colour depend on
 * which side of a chunk border you compute it from, which is a visible seam
 * along every boundary in the world. Full resolution is the boring option and
 * the only exact one.
 *
 * It costs about 30 kB and 2,048 triangles on a node that is entirely at sea,
 * and nothing at all on a node that is entirely inland.
 *
 * Vertices are COMPACTED: only those touching an emitted quad are written, so a
 * node with one submerged corner pays for one corner, not for 1,089 vertices.
 */
function buildWaterSurface(
  heightAt: (col: number, row: number) => number,
  step: number,
): WaterSurface {
  const side = VERTS_PER_EDGE;

  // Which cells have water over them.
  const cellWet = new Uint8Array(SEGMENTS * SEGMENTS);
  let wetCells = 0;
  for (let row = 0; row < SEGMENTS; row++) {
    for (let col = 0; col < SEGMENTS; col++) {
      const wet =
        heightAt(col, row) < SEA_LEVEL ||
        heightAt(col + 1, row) < SEA_LEVEL ||
        heightAt(col, row + 1) < SEA_LEVEL ||
        heightAt(col + 1, row + 1) < SEA_LEVEL;
      if (wet) {
        cellWet[row * SEGMENTS + col] = 1;
        wetCells++;
      }
    }
  }
  // The whole point: an inland node returns nothing, so it builds no mesh and
  // costs no draw call.
  if (wetCells === 0) return NO_WATER();

  // Which lattice vertices those cells actually use. -1 means "not used".
  const waterIndexOf = new Int32Array(SURFACE_VERTEX_COUNT).fill(-1);
  let vertexCount = 0;
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      let used = false;
      for (let cellRow = row - 1; cellRow <= row && !used; cellRow++) {
        if (cellRow < 0 || cellRow >= SEGMENTS) continue;
        for (let cellCol = col - 1; cellCol <= col && !used; cellCol++) {
          if (cellCol < 0 || cellCol >= SEGMENTS) continue;
          if (cellWet[cellRow * SEGMENTS + cellCol] === 1) used = true;
        }
      }
      if (used) waterIndexOf[row * side + col] = vertexCount++;
    }
  }

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * WATER_COLOR_COMPONENTS);
  const indices = new Uint32Array(wetCells * 6);

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const vertex = waterIndexOf[row * side + col] as number;
      if (vertex < 0) continue;

      const at = vertex * 3;
      positions[at] = col * step;
      // Absolutely flat, at exactly SEA_LEVEL. This is why water needs no
      // skirt: two neighbouring nodes, at any pair of levels, put their edge
      // vertices at the identical height, so there is no crack to plug.
      positions[at + 1] = SEA_LEVEL;
      positions[at + 2] = row * step;

      const [r, g, b, a] = waterColor(SEA_LEVEL - heightAt(col, row));
      const to = vertex * WATER_COLOR_COMPONENTS;
      colors[to] = srgbToLinear(r);
      colors[to + 1] = srgbToLinear(g);
      colors[to + 2] = srgbToLinear(b);
      // Alpha is a blend weight, not a colour: it must NOT go through the
      // sRGB transfer function.
      colors[to + 3] = a;
    }
  }

  let write = 0;
  for (let row = 0; row < SEGMENTS; row++) {
    for (let col = 0; col < SEGMENTS; col++) {
      if (cellWet[row * SEGMENTS + col] !== 1) continue;
      const a = waterIndexOf[row * side + col] as number;
      const b = waterIndexOf[row * side + col + 1] as number;
      const c = waterIndexOf[(row + 1) * side + col] as number;
      const d = waterIndexOf[(row + 1) * side + col + 1] as number;
      // Same winding as the terrain surface: counter-clockwise from +Y.
      indices[write++] = a;
      indices[write++] = c;
      indices[write++] = b;
      indices[write++] = b;
      indices[write++] = c;
      indices[write++] = d;
    }
  }

  return { positions, colors, indices };
}

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

  const positions = new Float32Array(VERTEX_COUNT * 3);
  const normals = new Float32Array(VERTEX_COUNT * 3);
  const colors = new Float32Array(VERTEX_COUNT * 3);
  const indices = new Uint32Array(TRIANGLE_COUNT * 3);

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

  // -- skirt ---------------------------------------------------------------
  //
  // One apron vertex per border vertex, hanging straight down. Position X and Z
  // are copied exactly from the top vertex rather than recomputed, so the apron
  // can never be a hair off the edge it is sealing. Normals and colours are
  // copied too: the apron is only ever seen edge-on through a crack, and giving
  // it the surface's own shading is what makes it read as the ground continuing
  // rather than as a dark band.

  let depth = MIN_SKIRT_DEPTH;
  for (const edge of SKIRT_EDGES) {
    let col = edge.startCol;
    let row = edge.startRow;
    let previous = positions[(row * side + col) * 3 + 1] as number;
    for (let i = 1; i < side; i++) {
      col += edge.stepCol;
      row += edge.stepRow;
      const y = positions[(row * side + col) * 3 + 1] as number;
      const delta = Math.abs(y - previous) * SKIRT_DEPTH_FACTOR;
      if (delta > depth) depth = delta;
      previous = y;
    }
  }

  let vertex = SURFACE_VERTEX_COUNT;
  for (const edge of SKIRT_EDGES) {
    let col = edge.startCol;
    let row = edge.startRow;
    for (let i = 0; i < side; i++) {
      const from = (row * side + col) * 3;
      const to = vertex * 3;
      positions[to] = positions[from] as number;
      positions[to + 1] = (positions[from + 1] as number) - depth;
      positions[to + 2] = positions[from + 2] as number;
      normals[to] = normals[from] as number;
      normals[to + 1] = normals[from + 1] as number;
      normals[to + 2] = normals[from + 2] as number;
      colors[to] = colors[from] as number;
      colors[to + 1] = colors[from + 1] as number;
      colors[to + 2] = colors[from + 2] as number;

      if (i > 0) {
        const topPrevious = (row - edge.stepRow) * side + (col - edge.stepCol);
        const top = row * side + col;
        const bottomPrevious = vertex - 1;
        const bottom = vertex;
        // Outward-facing, per the walk direction in SKIRT_EDGES...
        indices[write++] = topPrevious;
        indices[write++] = bottomPrevious;
        indices[write++] = bottom;
        indices[write++] = topPrevious;
        indices[write++] = bottom;
        indices[write++] = top;
        // ...and the same two triangles facing back into the node.
        indices[write++] = bottom;
        indices[write++] = bottomPrevious;
        indices[write++] = topPrevious;
        indices[write++] = top;
        indices[write++] = bottom;
        indices[write++] = topPrevious;
      }

      vertex++;
      col += edge.stepCol;
      row += edge.stepRow;
    }
  }

  // -- water ---------------------------------------------------------------
  //
  // Built from the same padded height grid, so it cannot disagree with the
  // terrain about where the shoreline is. Empty for a node with no ground
  // below sea level, which is most of them.
  const water = buildWaterSurface(heightAt, step);

  return {
    version: CHUNK_DATA_VERSION,
    coord: { x: coord.x, z: coord.z, lod: coord.lod },
    worldSeed,
    positions,
    indices,
    normals,
    colors,
    waterPositions: water.positions,
    waterColors: water.colors,
    waterIndices: water.indices,
    color: chunkColor(coord, worldSeed),
    minY,
    maxY,
  };
}
