/**
 * Determinism tests for chunk generation.
 *
 * RULE 1 says the same `(worldSeed, coord)` must produce byte-identical output
 * forever, regardless of visit order. These tests are the cheapest place to
 * catch a violation: they need no browser, no workers, and no renderer.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_SKIRT_DEPTH,
  SEGMENTS,
  SKIRT_TRIANGLE_COUNT,
  SKIRT_VERTEX_COUNT,
  SURFACE_TRIANGLE_COUNT,
  SURFACE_VERTEX_COUNT,
  TRIANGLE_COUNT,
  VERTEX_COUNT,
  VERTS_PER_EDGE,
  chunkColor,
  generateChunk,
  hslToRgb,
  skirtDepthOf,
  surfaceColor,
  vertexHeight,
  vertexWorldX,
  vertexWorldZ,
} from './chunk-gen';
import { sampleHeight } from './height-field';
import {
  CHUNK_DATA_VERSION,
  CHUNK_SIZE,
  chunkDataBytes,
  chunkDataTransferables,
  createTierContext,
  type ChunkCoord,
} from './contracts';

const SEED = 0xc0ffee;
const context = (seed = SEED): ReturnType<typeof createTierContext> =>
  createTierContext(seed, 'chunk');

const COORDS: ChunkCoord[] = [
  { x: 0, z: 0, lod: 0 },
  { x: 1, z: 0, lod: 0 },
  { x: -1, z: -1, lod: 0 },
  { x: 37, z: -998, lod: 0 },
  { x: -2147483, z: 2147483, lod: 0 },
];

describe('chunkColor', () => {
  it('is a pure function of coordinate and seed', () => {
    for (const coord of COORDS) {
      expect(chunkColor(coord, SEED)).toEqual(chunkColor(coord, SEED));
    }
  });

  it('does not depend on the order chunks are visited', () => {
    // Generate the list forwards, then backwards, and demand the same answers.
    // A sequential PRNG would fail this, which is exactly why it is here.
    const forwards = COORDS.map((c) => chunkColor(c, SEED));
    const backwards = [...COORDS].reverse().map((c) => chunkColor(c, SEED));
    expect(backwards.reverse()).toEqual(forwards);
  });

  it('survives being regenerated after unrelated work', () => {
    const before = chunkColor({ x: 4, z: 4, lod: 0 }, SEED);
    for (let i = 0; i < 500; i++) chunkColor({ x: i, z: -i, lod: 0 }, SEED ^ i);
    expect(chunkColor({ x: 4, z: 4, lod: 0 }, SEED)).toEqual(before);
  });

  it('distinguishes transposed coordinates', () => {
    expect(chunkColor({ x: 3, z: 8, lod: 0 }, SEED)).not.toEqual(
      chunkColor({ x: 8, z: 3, lod: 0 }, SEED),
    );
  });

  it('changes with the seed', () => {
    expect(chunkColor({ x: 0, z: 0, lod: 0 }, SEED)).not.toEqual(
      chunkColor({ x: 0, z: 0, lod: 0 }, SEED + 1),
    );
  });

  it('stays inside the [0, 1] channel range', () => {
    for (let i = 0; i < 2000; i++) {
      for (const channel of chunkColor({ x: i, z: 7 - i, lod: 0 }, SEED)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('spreads hues rather than clustering', () => {
    // Six buckets across the hue circle; every one should see some traffic, or
    // the world is a single colour and the visual determinism check is useless.
    const buckets = new Array<number>(6).fill(0);
    for (let x = 0; x < 600; x++) {
      const [r, g, b] = chunkColor({ x, z: 0, lod: 0 }, SEED);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let hue = 0;
      if (max !== min) {
        if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) hue = (b - r) / (max - min) + 2;
        else hue = (r - g) / (max - min) + 4;
      }
      const index = Math.min(5, Math.floor(hue));
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(20);
  });
});

describe('hslToRgb', () => {
  it('matches known values', () => {
    const expectClose = (actual: [number, number, number], expected: number[]): void => {
      actual.forEach((channel, i) => expect(channel).toBeCloseTo(expected[i] as number, 12));
    };
    expectClose(hslToRgb(0, 1, 0.5), [1, 0, 0]);
    expectClose(hslToRgb(1 / 3, 1, 0.5), [0, 1, 0]);
    expectClose(hslToRgb(2 / 3, 1, 0.5), [0, 0, 1]);
    expectClose(hslToRgb(0.42, 0, 0.25), [0.25, 0.25, 0.25]);
  });

  it('wraps hue', () => {
    expect(hslToRgb(1.25, 0.6, 0.4)).toEqual(hslToRgb(0.25, 0.6, 0.4));
  });
});

// ---------------------------------------------------------------------------
// sampleHeight parity -- the two assertions that must be kept separate
// ---------------------------------------------------------------------------

describe('sampleHeight parity with generated vertices', () => {
  /**
   * ASSERTION ONE: function to function, EXACT.
   *
   * This is the real determinism property. `vertexHeight` is literally the call
   * `generateChunk` makes for every vertex; `sampleHeight` at independently
   * derived world coordinates is what the main thread (and Phase 8's collision)
   * will ask. Both compute in float64, so anything short of `===` here is a
   * bug being tolerated.
   *
   * What it actually catches: a generator that accumulates `x += step` across
   * the row instead of recomputing `origin + col * step`. That drifts by a few
   * ULP per column, which is invisible in a screenshot and lethal to a player
   * standing on the ground.
   */
  it('agrees exactly with the call the worker makes', () => {
    for (const coord of COORDS) {
      const step = CHUNK_SIZE / SEGMENTS;
      for (let row = 0; row <= SEGMENTS; row += 7) {
        for (let col = 0; col <= SEGMENTS; col += 5) {
          const worldX = coord.x * CHUNK_SIZE + col * step;
          const worldZ = coord.z * CHUNK_SIZE + row * step;
          expect(vertexWorldX(coord, col)).toBe(worldX);
          expect(vertexWorldZ(coord, row)).toBe(worldZ);
          expect(vertexHeight(coord, col, row, SEED)).toBe(sampleHeight(worldX, worldZ, SEED));
        }
      }
    }
  });

  /**
   * ASSERTION TWO: function to STORED VERTEX, float32-aware.
   *
   * Vertices are stored in a `Float32Array`; `sampleHeight` computes in
   * float64. For heights in the hundreds of metres, float32 carries about 1e-5
   * of absolute precision, so demanding 1e-6 agreement against stored data
   * cannot pass no matter how correct the code is. The tolerance below is the
   * float32 quantum with a floor for near-zero heights -- it is a statement
   * about the storage format, not a knob to widen until green.
   */
  it('agrees with the stored vertex data to float32 precision', () => {
    for (const coord of COORDS) {
      const data = generateChunk(coord, context());
      const side = VERTS_PER_EDGE;
      for (let row = 0; row < side; row++) {
        for (let col = 0; col < side; col++) {
          const stored = data.positions[(row * side + col) * 3 + 1] as number;
          const exact = sampleHeight(vertexWorldX(coord, col), vertexWorldZ(coord, row), SEED);
          expect(Math.abs(stored - exact)).toBeLessThanOrEqual(Math.abs(exact) * 1e-6 + 1e-4);
        }
      }
    }
  });

  it('would fail if the ground moved: the tolerance is far below real relief', () => {
    // Guards the check above from being vacuous. A tolerance that swallowed a
    // real terrain change would prove nothing, so assert that neighbouring
    // vertices differ by orders of magnitude more than the tolerance allows.
    const coord: ChunkCoord = { x: 12, z: -7, lod: 0 };
    const a = vertexHeight(coord, 0, 0, SEED);
    const b = vertexHeight(coord, SEGMENTS, SEGMENTS, SEED);
    expect(Math.abs(a - b)).toBeGreaterThan(0.1);
  });

  it('seats the cube on the same ground the chunk mesh renders', () => {
    // The origin vertex of chunk (0,0) is world (0,0), which is where
    // `CubeScene` reads its height. If these ever diverge the cube floats or
    // sinks in `shots/cube-default.png`.
    const coord: ChunkCoord = { x: 0, z: 0, lod: 0 };
    expect(vertexHeight(coord, 0, 0, SEED)).toBe(sampleHeight(0, 0, SEED));
  });
});

// ---------------------------------------------------------------------------
// Surface colour
// ---------------------------------------------------------------------------

describe('surfaceColor', () => {
  const base = { height: 40, slope: 0, temperature: 0.5, humidity: 0.5, variation: 0 };

  it('paints steep ground as grey rock, whatever it would otherwise have been', () => {
    const spread = (c: number[]): number => Math.max(...c) - Math.min(...c);
    expect(spread(surfaceColor({ ...base, slope: 0.95 }))).toBeLessThan(0.06);

    // A vertical face is the same rock at every altitude and every humidity:
    // the slope term wins outright. Flat ground at the same points is not.
    const steep = new Set<string>();
    const flat = new Set<string>();
    for (const height of [-40, 0, 40, 300]) {
      for (const h of [0, 1]) {
        steep.add(surfaceColor({ ...base, height, humidity: h, slope: 0.95 }).join());
        flat.add(surfaceColor({ ...base, height, humidity: h }).join());
      }
    }
    expect(steep.size).toBe(1);
    expect(flat.size).toBeGreaterThan(4);
  });

  it('puts the snow line higher in a warm climate than a cold one', () => {
    // Sign matters and is easy to get backwards: this caught exactly that.
    const brightness = (c: number[]): number =>
      (c[0] as number) + (c[1] as number) + (c[2] as number);
    const cold = surfaceColor({ ...base, height: 200, temperature: 0 });
    const hot = surfaceColor({ ...base, height: 200, temperature: 1 });
    expect(brightness(cold)).toBeGreaterThan(2.4);
    expect(brightness(hot)).toBeLessThan(1.6);
  });

  it('keeps snow off faces too steep to hold it', () => {
    const brightness = (c: number[]): number =>
      (c[0] as number) + (c[1] as number) + (c[2] as number);
    const peak = surfaceColor({ ...base, height: 300, temperature: 0, slope: 0 });
    const face = surfaceColor({ ...base, height: 300, temperature: 0, slope: 0.95 });
    expect(brightness(peak)).toBeGreaterThan(brightness(face) + 0.8);
  });

  it('paints wet lowland greener than dry lowland', () => {
    const wet = surfaceColor({ ...base, humidity: 1 });
    const dry = surfaceColor({ ...base, humidity: 0 });
    const greenness = (c: number[]): number => (c[1] as number) - (c[0] as number);
    expect(greenness(wet)).toBeGreaterThan(greenness(dry));
  });

  it('paints a basin floor darker than a shoreline', () => {
    const basin = surfaceColor({ ...base, height: -40 });
    const shore = surfaceColor({ ...base, height: 0 });
    const brightness = (c: number[]): number => (c[0] as number) + (c[1] as number) + (c[2] as number);
    expect(brightness(basin)).toBeLessThan(brightness(shore));
  });

  it('stays inside [0, 1] across the whole input space', () => {
    for (const height of [-120, -1, 0, 30, 150, 400]) {
      for (const slope of [0, 0.3, 0.7, 1]) {
        for (const t of [0, 0.5, 1]) {
          for (const h of [0, 1]) {
            for (const variation of [-1, 0, 1]) {
              for (const channel of surfaceColor({ height, slope, temperature: t, humidity: h, variation })) {
                expect(channel).toBeGreaterThanOrEqual(0);
                expect(channel).toBeLessThanOrEqual(1);
              }
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// generateChunk
// ---------------------------------------------------------------------------

describe('generateChunk', () => {
  it('produces byte-identical payloads for the same coordinate and seed', () => {
    for (const coord of COORDS) {
      const a = generateChunk(coord, context());
      const b = generateChunk(coord, context());
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
      expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
      expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
      expect(a.color).toEqual(b.color);
      expect(a.minY).toBe(b.minY);
      expect(a.maxY).toBe(b.maxY);
      expect(a.worldSeed).toBe(b.worldSeed);
    }
  });

  it('regenerates identically after an interleaved run over other chunks', () => {
    const first = generateChunk({ x: 9, z: -9, lod: 0 }, context());
    for (let i = 0; i < 40; i++) generateChunk({ x: i, z: i, lod: 0 }, context(SEED + i));
    const again = generateChunk({ x: 9, z: -9, lod: 0 }, context());
    expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
    expect(Array.from(again.colors)).toEqual(Array.from(first.colors));
    expect(again.color).toEqual(first.color);
  });

  it('emits node-local x/z spanning exactly one chunk, and absolute y', () => {
    const coord: ChunkCoord = { x: 5, z: -2, lod: 0 };
    const data = generateChunk(coord, context());
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < data.positions.length; i += 3) {
      xs.push(data.positions[i] as number);
      zs.push(data.positions[i + 2] as number);
    }
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(CHUNK_SIZE);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(CHUNK_SIZE);
    expect(data.coord).toEqual(coord);
  });

  it('reports a real vertical extent that contains every surface vertex', () => {
    const data = generateChunk({ x: 5, z: -2, lod: 0 }, context());
    let lo = Infinity;
    let hi = -Infinity;
    // Surface vertices only: `minY`/`maxY` describe the terrain, and the skirt
    // deliberately hangs below it. `chunk-mesh.ts` is what widens the bounding
    // box to include the apron.
    for (let i = 1; i < SURFACE_VERTEX_COUNT * 3; i += 3) {
      const y = data.positions[i] as number;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    // Float32 storage rounds, so the reported extent bounds the stored data to
    // within the storage quantum rather than exactly.
    const slack = Math.max(Math.abs(data.minY), Math.abs(data.maxY)) * 1e-6 + 1e-4;
    expect(data.minY).toBeLessThanOrEqual(lo + slack);
    expect(data.maxY).toBeGreaterThanOrEqual(hi - slack);
    // Terrain, not a plane.
    expect(data.maxY - data.minY).toBeGreaterThan(0.05);
  });

  it('emits unit-length normals that point upwards', () => {
    const data = generateChunk({ x: 3, z: 3, lod: 0 }, context());
    for (let i = 0; i < data.normals.length; i += 3) {
      const x = data.normals[i] as number;
      const y = data.normals[i + 1] as number;
      const z = data.normals[i + 2] as number;
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
      // A heightfield can never overhang, so +Y is always positive.
      expect(y).toBeGreaterThan(0);
    }
  });

  it('computes normals that match across a chunk boundary', () => {
    // The reason normals come from the height field and not from the triangles:
    // the shared edge of two chunks must get the same normal from both, or a
    // lighting crease runs along every 64 m boundary in the world.
    const left = generateChunk({ x: 0, z: 0, lod: 0 }, context());
    const right = generateChunk({ x: 1, z: 0, lod: 0 }, context());
    const side = VERTS_PER_EDGE;
    for (let row = 0; row < side; row++) {
      const leftEdge = (row * side + (side - 1)) * 3;
      const rightEdge = row * side * 3;
      for (let c = 0; c < 3; c++) {
        expect(left.normals[leftEdge + c]).toBe(right.normals[rightEdge + c]);
      }
      expect(left.positions[leftEdge + 1]).toBe(right.positions[rightEdge + 1]);
    }
  });

  it('emits transferable typed arrays and a version stamp', () => {
    const data = generateChunk({ x: 0, z: 0, lod: 0 }, context());
    expect(data.version).toBe(CHUNK_DATA_VERSION);
    expect(CHUNK_DATA_VERSION).toBe(2);
    expect(data.positions).toBeInstanceOf(Float32Array);
    expect(data.indices).toBeInstanceOf(Uint32Array);
    expect(data.normals).toBeInstanceOf(Float32Array);
    expect(data.colors).toBeInstanceOf(Float32Array);
    expect(data.indices.length % 3).toBe(0);
    for (const index of data.indices) {
      expect(index).toBeLessThan(data.positions.length / 3);
    }
  });

  it('lists every bulk buffer as transferable', () => {
    // A buffer left off this list is not a missed optimisation: it gets
    // structured-cloned instead, copying the whole mesh twice per chunk.
    const data = generateChunk({ x: 0, z: 0, lod: 0 }, context());
    const transferables = chunkDataTransferables(data);
    expect(transferables).toContain(data.positions.buffer);
    expect(transferables).toContain(data.indices.buffer);
    expect(transferables).toContain(data.normals.buffer);
    expect(transferables).toContain(data.colors.buffer);
    expect(transferables).toHaveLength(4);
    expect(chunkDataBytes(data)).toBe(
      data.positions.byteLength +
        data.indices.byteLength +
        data.normals.byteLength +
        data.colors.byteLength,
    );
  });

  it('has the grid size Phase 2a specifies, plus the Phase 2b skirt', () => {
    const data = generateChunk({ x: 0, z: 0, lod: 0 }, context());
    // `SEGMENTS` stays 32 at every level. That is what makes a coarse node
    // cheaper than the four fine ones it replaces, and it is what makes node
    // count -- not triangle count -- the thing the quadtree has to bound.
    expect(SEGMENTS).toBe(32);
    expect(SURFACE_VERTEX_COUNT).toBe(1089);
    expect(SURFACE_TRIANGLE_COUNT).toBe(2048);
    expect(SKIRT_VERTEX_COUNT).toBe(132);
    expect(SKIRT_TRIANGLE_COUNT).toBe(512);
    expect(data.positions.length / 3).toBe(VERTEX_COUNT);
    expect(data.positions.length / 3).toBe(1221);
    expect(data.indices.length / 3).toBe(TRIANGLE_COUNT);
    expect(data.indices.length / 3).toBe(2560);
    expect(VERTS_PER_EDGE).toBe(33);
  });

  it('changes with the seed', () => {
    const a = generateChunk({ x: 2, z: 2, lod: 0 }, context(SEED));
    const b = generateChunk({ x: 2, z: 2, lod: 0 }, context(SEED + 1));
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('refuses a context from the wrong tier', () => {
    expect(() => generateChunk({ x: 0, z: 0, lod: 0 }, createTierContext(1, 'sector'))).toThrow(
      /tier/i,
    );
  });
});

/**
 * Skirts, and the crack they exist to close.
 *
 * A level boundary is the one place a quadtree can show you the sky through the
 * ground: the coarse side draws a straight line between samples that the fine
 * side follows the terrain between. These tests measure that gap directly and
 * assert the apron is deep enough to plug it, rather than trusting a screenshot
 * to notice a two-pixel sliver.
 */
describe('skirts', () => {
  const SIDE = VERTS_PER_EDGE;
  const surfaceY = (data: { positions: Float32Array }, col: number, row: number): number =>
    data.positions[(row * SIDE + col) * 3 + 1] as number;

  it('hangs one apron vertex directly below every border vertex', () => {
    const data = generateChunk({ x: 3, z: -4, lod: 2 }, context());
    const depth = skirtDepthOf(data.positions);
    expect(depth).toBeGreaterThanOrEqual(MIN_SKIRT_DEPTH);

    // Every apron vertex must sit at the same depth under SOME border vertex,
    // sharing its exact x and z. A shifted apron leaves a gap of its own.
    const border = new Map<string, number>();
    for (let i = 0; i < SURFACE_VERTEX_COUNT; i++) {
      const row = Math.floor(i / SIDE);
      const col = i % SIDE;
      if (row !== 0 && row !== SEGMENTS && col !== 0 && col !== SEGMENTS) continue;
      const at = i * 3;
      border.set(`${data.positions[at]},${data.positions[at + 2]}`, data.positions[at + 1] as number);
    }

    let matched = 0;
    for (let i = SURFACE_VERTEX_COUNT; i < VERTEX_COUNT; i++) {
      const at = i * 3;
      const top = border.get(`${data.positions[at]},${data.positions[at + 2]}`);
      expect(top).toBeTypeOf('number');
      expect((top as number) - (data.positions[at + 1] as number)).toBeCloseTo(depth, 2);
      matched++;
    }
    expect(matched).toBe(SKIRT_VERTEX_COUNT);
  });

  it('copies the surface normal and colour, so the apron is not a dark band', () => {
    const data = generateChunk({ x: 1, z: 1, lod: 0 }, context());
    // Skirt vertex 0 mirrors the start of the first edge's walk.
    const top = (0 * SIDE + SEGMENTS) * 3;
    const bottom = SURFACE_VERTEX_COUNT * 3;
    for (let c = 0; c < 3; c++) {
      expect(data.normals[bottom + c]).toBe(data.normals[top + c]);
      expect(data.colors[bottom + c]).toBe(data.colors[top + c]);
    }
  });

  it('gets deeper where the terrain is rougher', () => {
    // A lod-4 node spans 1024 m and samples every 32 m, so adjacent border
    // vertices differ by far more than a lod-0 node's do over 2 m. If the depth
    // were a constant, a 1 km node would show cracks a screenshot could not miss.
    const fine = generateChunk({ x: 0, z: 0, lod: 0 }, context());
    const coarse = generateChunk({ x: 0, z: 0, lod: 4 }, context());
    expect(skirtDepthOf(coarse.positions)).toBeGreaterThan(skirtDepthOf(fine.positions));
  });

  it('closes the crack at a lod-0 / lod-1 boundary from whichever side is short', () => {
    // Geometry: the coarse node covers [0,128] and the fine one [128,192], so
    // they share the line x = 128 for z in [0, 64]. The coarse node samples that
    // line every 4 m and the fine one every 2 m, and the crack is the difference
    // between the coarse node's straight line and the terrain in between.
    const coarse = generateChunk({ x: 0, z: 0, lod: 1 }, context());
    const fine = generateChunk({ x: 2, z: 0, lod: 0 }, context());
    const coarseDepth = skirtDepthOf(coarse.positions);
    const fineDepth = skirtDepthOf(fine.positions);

    let worstGap = 0;
    let compared = 0;
    for (let fineRow = 0; fineRow <= SEGMENTS; fineRow++) {
      // The fine node's z step is 2 m, the coarse node's is 4 m.
      const coarseRow = fineRow / 2;
      const lo = Math.floor(coarseRow);
      const t = coarseRow - lo;
      const a = surfaceY(coarse, SEGMENTS, lo);
      const b = surfaceY(coarse, SEGMENTS, Math.min(lo + 1, SEGMENTS));
      const coarseY = a + (b - a) * t;
      const fineY = surfaceY(fine, 0, fineRow);

      const gap = fineY - coarseY;
      worstGap = Math.max(worstGap, Math.abs(gap));
      if (gap > 0) {
        // Fine side is higher: its apron must reach down past the coarse surface.
        expect(fineY - fineDepth).toBeLessThanOrEqual(coarseY);
      } else if (gap < 0) {
        // Coarse side is higher: its apron must reach down past the fine surface.
        expect(coarseY - coarseDepth).toBeLessThanOrEqual(fineY);
      }
      compared++;
    }

    expect(compared).toBe(SEGMENTS + 1);
    // Anti-vacuity: if the two edges agreed everywhere there would be no crack
    // to close and the assertions above would pass on any apron at all,
    // including one of zero depth.
    expect(worstGap).toBeGreaterThan(0.01);
    expect(fineDepth).toBeGreaterThan(worstGap);
  });

  it('closes the crack on the perpendicular boundary too', () => {
    // The same check across z = 128, so a skirt that only covers two of the
    // four edges cannot pass.
    const coarse = generateChunk({ x: 0, z: 1, lod: 1 }, context());
    const fine = generateChunk({ x: 0, z: 1, lod: 0 }, context());
    const coarseDepth = skirtDepthOf(coarse.positions);
    const fineDepth = skirtDepthOf(fine.positions);

    let worstGap = 0;
    for (let fineCol = 0; fineCol <= SEGMENTS; fineCol++) {
      const coarseCol = fineCol / 2;
      const lo = Math.floor(coarseCol);
      const t = coarseCol - lo;
      const a = surfaceY(coarse, lo, 0);
      const b = surfaceY(coarse, Math.min(lo + 1, SEGMENTS), 0);
      const coarseY = a + (b - a) * t;
      // The fine node lies on the -Z side of the seam, so its shared edge is
      // its LAST row, not its first.
      const fineY = surfaceY(fine, fineCol, SEGMENTS);
      const gap = fineY - coarseY;
      worstGap = Math.max(worstGap, Math.abs(gap));
      if (gap > 0) expect(fineY - fineDepth).toBeLessThanOrEqual(coarseY);
      else if (gap < 0) expect(coarseY - coarseDepth).toBeLessThanOrEqual(fineY);
    }
    expect(worstGap).toBeGreaterThan(0.01);
  });

  it('closes the crack at every boundary along a busy stretch of terrain', () => {
    // One pair of nodes could get lucky. Walk a kilometre of the world and
    // check every lod-0 / lod-1 seam along it.
    let checked = 0;
    let deepest = 0;
    for (let i = -8; i < 8; i++) {
      const coarse = generateChunk({ x: i, z: 3, lod: 1 }, context());
      const fine = generateChunk({ x: i * 2 + 2, z: 6, lod: 0 }, context());
      const coarseDepth = skirtDepthOf(coarse.positions);
      const fineDepth = skirtDepthOf(fine.positions);
      deepest = Math.max(deepest, coarseDepth, fineDepth);
      for (let fineRow = 0; fineRow <= SEGMENTS; fineRow++) {
        const coarseRow = fineRow / 2;
        const lo = Math.floor(coarseRow);
        const a = surfaceY(coarse, SEGMENTS, lo);
        const b = surfaceY(coarse, SEGMENTS, Math.min(lo + 1, SEGMENTS));
        const coarseY = a + (b - a) * (coarseRow - lo);
        const fineY = surfaceY(fine, 0, fineRow);
        if (fineY > coarseY) expect(fineY - fineDepth).toBeLessThanOrEqual(coarseY);
        else expect(coarseY - coarseDepth).toBeLessThanOrEqual(fineY);
        checked++;
      }
    }
    expect(checked).toBe(16 * (SEGMENTS + 1));
    // Aprons stay proportional to the terrain rather than growing without
    // bound: a lod-1 node is 128 m across and its apron should be metres, not
    // hundreds of metres, or it becomes a visible curtain at the world's edge.
    expect(deepest).toBeLessThan(64);
  });

  it('does not depend on the neighbours, which is the whole reason it is a skirt', () => {
    // A stitched edge would need to know the adjacent nodes' levels, and the
    // same node would then come back with different bytes depending on who was
    // next to it -- a direct RULE 2 violation. Generating the same node twice,
    // with entirely different neighbours generated in between, must be
    // bit-identical including the apron.
    const first = generateChunk({ x: 4, z: -7, lod: 1 }, context());
    generateChunk({ x: 8, z: -14, lod: 0 }, context());
    generateChunk({ x: 2, z: -4, lod: 2 }, context());
    generateChunk({ x: 1, z: -2, lod: 3 }, context());
    const again = generateChunk({ x: 4, z: -7, lod: 1 }, context());
    expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
    expect(Array.from(again.indices)).toEqual(Array.from(first.indices));
  });
});
