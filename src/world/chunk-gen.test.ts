/**
 * Determinism tests for chunk generation.
 *
 * RULE 1 says the same `(worldSeed, coord)` must produce byte-identical output
 * forever, regardless of visit order. These tests are the cheapest place to
 * catch a violation: they need no browser, no workers, and no renderer.
 */

import { describe, expect, it } from 'vitest';
import {
  CULTURE_BUILDING_PALETTES,
  MAX_WATER_TRIANGLE_COUNT,
  MAX_WATER_VERTEX_COUNT,
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
  chunkTierContext,
  generateChunk,
  hslToRgb,
  skirtDepthOf,
  surfaceColor,
  vertexHeight,
  vertexWorldX,
  vertexWorldZ,
  WATER_ALPHA_FULL_DEPTH,
  WATER_ALPHA_MAX,
  waterColor,
} from './chunk-gen';
import { baseHeight, continentalness, habitability, SEA_LEVEL, sampleHeight, worldRegionField } from './height-field';
import {
  CHUNK_DATA_VERSION,
  CHUNK_SIZE,
  chunkDataBytes,
  chunkDataTransferables,
  createTierContext,
  worldToChunk,
  type ChunkCoord,
} from './contracts';
import { citiesInBox, type PolityClimate, type PolityTerrain } from './polity';

const SEED = 0xc0ffee;
/**
 * A chunk context WITH its Region-tier river data, which is what
 * `generateChunk` now requires (RULE 3: rivers span chunks, so they are decided
 * at the tier that contains them and arrive as coarse data).
 */
const context = (seed = SEED): ReturnType<typeof createTierContext> => chunkTierContext(seed);

/**
 * Seed 99 and three nodes on it, one of each kind. They are shared with
 * `chunk-mesh.test.ts`, which needs the same three cases at the Three.js
 * boundary, and the first test in the water block asserts they really ARE dry,
 * part-submerged and fully submerged -- so a later phase that retunes the
 * height field gets one clear failure here rather than a dozen puzzling ones.
 */
const WATER_SEED = 99;
const DRY_CHUNK: ChunkCoord = { x: 2, z: 5, lod: 0 };
const SHORE_CHUNK: ChunkCoord = { x: 0, z: 3, lod: 0 };
const SUBMERGED_CHUNK: ChunkCoord = { x: 0, z: 0, lod: 0 };

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
// Rivers (Phase 3b)
// ---------------------------------------------------------------------------

describe('rivers reach chunk generation through the tier context', () => {
  it('refuses a chunk context with no Region-tier river data (RULE 3)', () => {
    // The plumbing is load-bearing, not decorative: without the region record
    // this generator would have to reach around the tier system and ask
    // `rivers.ts` itself, and the day a chunk did that for something that is
    // NOT globally memoised, two neighbours would disagree about the ground.
    expect(() =>
      generateChunk({ x: 0, z: 0, lod: 0 }, createTierContext(SEED, 'chunk')),
    ).toThrow(/Region-tier river and road data/);
  });

  it('refuses region data belonging to a different seed', () => {
    const wrong = createTierContext(SEED, 'chunk', { region: worldRegionField(SEED + 1) });
    expect(() => generateChunk({ x: 0, z: 0, lod: 0 }, wrong)).toThrow(/but this chunk is seed/);
  });

  it('refuses a chunk context with no Sector-tier street data (RULE 3)', () => {
    // Phase 4b. The Sector tier is a SECOND coarse entry, and a chunk built
    // without it would grade roads but not the streets inside a settlement --
    // ungraded ground next to graded ground, i.e. a step at every village that
    // straddles a chunk boundary. Missing is an error, exactly as for the
    // region record.
    const regionOnly = createTierContext(SEED, 'chunk', { region: worldRegionField(SEED) });
    expect(() => generateChunk({ x: 0, z: 0, lod: 0 }, regionOnly)).toThrow(
      /Sector-tier street data/,
    );
  });

  it('refuses a region record carrying rivers but no roads (RULE 3)', () => {
    // Phase 4a put a second Region-tier generator in the single 'region' slot.
    // A half-built record is the new way to get a chunk that disagrees with its
    // neighbours, so it fails exactly as a missing one does rather than
    // generating ungraded ground.
    const half = createTierContext(SEED, 'chunk', {
      region: { worldSeed: SEED, rivers: worldRegionField(SEED).rivers },
    });
    expect(() => generateChunk({ x: 0, z: 0, lod: 0 }, half)).toThrow(
      /Region-tier river and road data/,
    );
  });

  it('carves some nodes and leaves others completely alone', () => {
    // ANTI-VACUITY. Every river check in this suite, in the soak and in the
    // screenshot harness is worthless if the world contains no rivers, and a
    // count of zero looks exactly like "no river near this chunk". So: prove
    // both kinds of node exist, by looking.
    let carved = 0;
    let untouched = 0;
    let carvedVertices = 0;
    for (let i = 0; i < 60; i++) {
      const data = generateChunk({ x: 40 + i, z: 12 + i, lod: 0 }, context());
      if (data.riverVertices > 0) {
        carved++;
        carvedVertices += data.riverVertices;
      } else {
        untouched++;
      }
    }
    expect(carved).toBeGreaterThan(0);
    expect(untouched).toBeGreaterThan(0);
    expect(carvedVertices).toBeGreaterThan(100);
  });

  it('counts exactly the vertices baseHeight and sampleHeight disagree about', () => {
    const coord: ChunkCoord = { x: 54, z: 20, lod: 0 };
    const data = generateChunk(coord, context());
    let expected = 0;
    for (let row = 0; row <= SEGMENTS; row++) {
      for (let col = 0; col <= SEGMENTS; col++) {
        const x = vertexWorldX(coord, col);
        const z = vertexWorldZ(coord, row);
        if (baseHeight(x, z, SEED) - sampleHeight(x, z, SEED) >= 0.25) expected++;
      }
    }
    expect(data.riverVertices).toBe(expected);
  });

  it('lowers the ground it says it carved, and only that', () => {
    const coord: ChunkCoord = { x: 54, z: 20, lod: 0 };
    const data = generateChunk(coord, context());
    expect(data.riverVertices).toBeGreaterThan(0);
    const side = VERTS_PER_EDGE;
    let lowered = 0;
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const stored = data.positions[(row * side + col) * 3 + 1] as number;
        const base = baseHeight(vertexWorldX(coord, col), vertexWorldZ(coord, row), SEED);
        expect(stored).toBeLessThanOrEqual(base + 1e-3);
        if (base - stored > 0.25) lowered++;
      }
    }
    expect(lowered).toBe(data.riverVertices);
  });

  it('regenerates a carved node byte-identically', () => {
    const coord: ChunkCoord = { x: 54, z: 20, lod: 0 };
    const first = generateChunk(coord, context());
    // Unrelated work in between, including on another seed, which evicts the
    // region memo -- the cache must be invisible (RULE 2).
    generateChunk({ x: 3, z: 3, lod: 2 }, context());
    generateChunk({ x: 54, z: 20, lod: 0 }, context(SEED + 7));
    const again = generateChunk(coord, context());
    expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
    expect(again.riverVertices).toBe(first.riverVertices);
  });
});

// ---------------------------------------------------------------------------
// Roads reach chunk generation through the same tier context
// ---------------------------------------------------------------------------

describe('roads reach chunk generation through the tier context', () => {
  /**
   * Chunks that a road actually passes through, found from the network rather
   * than guessed.
   *
   * Rivers are dense enough that a diagonal sweep of sixty chunks is certain to
   * cross one; roads are not. A region carries about twenty of them, each a ~34 m
   * corridor, so sampling blindly finds nothing and the test would fail for a
   * reason that has nothing to do with the code. Asking the network where its
   * nodes are is both reliable and a statement of what is being tested.
   */
  function chunksOnRoads(count: number): ChunkCoord[] {
    const net = worldRegionField(SEED).roads.networkAt(1000, 1000);
    const out: ChunkCoord[] = [];
    const seen = new Set<string>();
    for (let n = 0; n < net.nodeX.length && out.length < count; n++) {
      const x = Math.floor((net.nodeX[n] as number) / CHUNK_SIZE);
      const z = Math.floor((net.nodeZ[n] as number) / CHUNK_SIZE);
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, z, lod: 0 });
    }
    return out;
  }

  it('grades some nodes and leaves others completely alone', () => {
    // ANTI-VACUITY, and the road half of it. Every road check in this suite, in
    // the soak and in the screenshot harness is worthless if the world contains
    // no roads, and a count of zero looks exactly like "no road near this
    // chunk". So: prove both kinds of node exist, by looking.
    let surfaced = 0;
    let surfacedVertices = 0;
    for (const coord of chunksOnRoads(12)) {
      const data = generateChunk(coord, context());
      if (data.roadVertices > 0) {
        surfaced++;
        surfacedVertices += data.roadVertices;
      }
    }
    expect(surfaced).toBeGreaterThan(3);
    expect(surfacedVertices).toBeGreaterThan(20);

    // And the other half: most of the world has no road in it at all. A grading
    // field that quietly touched every vertex would be far worse than one that
    // touched none, because nothing downstream would ever notice.
    let untouched = 0;
    for (let i = 0; i < 20; i++) {
      if (generateChunk({ x: 900 + i * 13, z: -700 - i * 11, lod: 0 }, context()).roadVertices === 0) {
        untouched++;
      }
    }
    expect(untouched).toBeGreaterThan(10);
  });

  it('regenerates a graded node byte-identically (RULE 2)', () => {
    const coord = chunksOnRoads(12).find((c) => generateChunk(c, context()).roadVertices > 0);
    expect(coord).toBeDefined();
    const first = generateChunk(coord as ChunkCoord, context());
    // Unrelated work on other seeds and regions, which evicts both region memos.
    for (let i = 0; i < 10; i++) generateChunk({ x: i * 9, z: i * 6, lod: 0 }, context(SEED + i));
    const again = generateChunk(coord as ChunkCoord, context());
    expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
    expect(Array.from(again.colors)).toEqual(Array.from(first.colors));
    expect(again.roadVertices).toBe(first.roadVertices);
  });

  it('counts STREET vertices separately from road ones (Phase 4b)', () => {
    // THE ANTI-VACUITY THAT MATTERS MOST IN 4b, and the reason `streetVertices`
    // is a third scalar rather than a wider `roadVertices`. A settlement pad
    // surfaces its whole disc, so every vertex in a village already passes the
    // road test before a single street exists: "the chunk is in a village" and
    // "street layout works" would otherwise be the same observation.
    const settlement = worldRegionField(SEED)
      .roads.networkAt(1000, 1000)
      .settlements.slice()
      .sort((a, b) => b.radius - a.radius)[0];
    expect(settlement).toBeDefined();
    const cx = Math.floor((settlement as { x: number }).x / CHUNK_SIZE);
    const cz = Math.floor((settlement as { z: number }).z / CHUNK_SIZE);

    let streeted = 0;
    let streetVertices = 0;
    let roadOnly = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const data = generateChunk({ x: cx + dx, z: cz + dz, lod: 0 }, context());
        expect(data.streetVertices).toBeLessThanOrEqual(data.roadVertices);
        if (data.streetVertices > 0) {
          streeted++;
          streetVertices += data.streetVertices;
        } else if (data.roadVertices > 0) {
          roadOnly++;
        }
      }
    }
    expect(streeted).toBeGreaterThan(2);
    expect(streetVertices).toBeGreaterThan(50);
    // The pad reaches further than the streets do, so the village edge is
    // road-surfaced without being street-surfaced. If that never happened, the
    // two counters would be measuring the same thing.
    expect(roadOnly).toBeGreaterThan(0);

    // Most of the world is not a village at all.
    let untouched = 0;
    for (let i = 0; i < 20; i++) {
      const data = generateChunk({ x: 900 + i * 13, z: -700 - i * 11, lod: 0 }, context());
      if (data.streetVertices === 0) untouched++;
    }
    expect(untouched).toBe(20);
  });

  it('puts BUILDINGS in the payload of a village node and nowhere else (Phase 6)', () => {
    // The chunk-tier half of Phase 6. `building-mesh.test.ts` asserts the
    // geometry; this asserts that the generator actually wires it into the
    // payload, that a building submesh costs zero bytes on the nodes that have
    // none, and that the levelness counter is not stuck at zero.
    const settlement = worldRegionField(SEED)
      .roads.networkAt(1000, 1000)
      .settlements.slice()
      .sort((a, b) => b.radius - a.radius)[0];
    expect(settlement).toBeDefined();
    const cx = Math.floor((settlement as { x: number }).x / CHUNK_SIZE);
    const cz = Math.floor((settlement as { z: number }).z / CHUNK_SIZE);

    let nodes = 0;
    let buildings = 0;
    let level = 0;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const data = generateChunk({ x: cx + dx, z: cz + dz, lod: 0 }, context());
        expect(data.buildingsLevel).toBeLessThanOrEqual(data.buildings);
        if (data.buildings === 0) {
          expect(data.buildingIndices).toHaveLength(0);
          expect(data.buildingPositions).toHaveLength(0);
          continue;
        }
        nodes++;
        buildings += data.buildings;
        level += data.buildingsLevel;
        // Every building must stand on street-surfaced ground -- a lot is sited
        // off a street, so a node with houses and no streets would mean the two
        // tiers disagree about where the village is.
        expect(data.streetVertices).toBeGreaterThan(0);
      }
    }
    expect(nodes).toBeGreaterThan(2);
    expect(buildings).toBeGreaterThan(10);
    // THE ANTI-VACUITY COUNTER OF THE PHASE. `buildings` says houses were
    // placed; this says they were placed on ground the village levelled, which
    // is what breaks if the grading, `gradeTarget` or the lot tests regress.
    expect(level).toBeGreaterThan(buildings * 0.8);

    // ...and the rest of the world costs nothing for them.
    for (let i = 0; i < 20; i++) {
      const data = generateChunk({ x: 900 + i * 13, z: -700 - i * 11, lod: 0 }, context());
      expect(data.buildings).toBe(0);
      expect(data.buildingIndices).toHaveLength(0);
    }
  });

  it('places props on growable ground and seats them at lod 0', () => {
    // Anti-vacuity for Phase 7a: find a block that owns vegetation, then assert
    // seating. Hard-coding a square around the origin fails on seeds whose
    // origin is ocean or desert.
    let anchor: { x: number; z: number } | null = null;
    for (let z = -60; z <= 60 && anchor === null; z++) {
      for (let x = -60; x <= 60; x++) {
        const data = generateChunk({ x, z, lod: 0 }, context());
        if (data.props >= 5) {
          anchor = { x, z };
          break;
        }
      }
    }
    expect(anchor).not.toBeNull();

    let nodes = 0;
    let props = 0;
    let seated = 0;
    const ax = (anchor as { x: number; z: number }).x;
    const az = (anchor as { x: number; z: number }).z;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const data = generateChunk({ x: ax + dx, z: az + dz, lod: 0 }, context());
        expect(data.propsSeated).toBeLessThanOrEqual(data.props);
        if (data.props === 0) {
          expect(data.propIndices).toHaveLength(0);
          expect(data.propPositions).toHaveLength(0);
          continue;
        }
        nodes++;
        props += data.props;
        seated += data.propsSeated;
      }
    }
    expect(nodes).toBeGreaterThan(2);
    expect(props).toBeGreaterThan(20);
    // THE ANTI-VACUITY COUNTER OF THE PHASE.
    expect(seated).toBeGreaterThan(props * 0.5);
  });
});

// ---------------------------------------------------------------------------
// Surface colour
// ---------------------------------------------------------------------------

describe('surfaceColor', () => {
  // `road: 0` throughout: every assertion below is about the natural ground, and
  // Phase 4a's surfacing is applied last and would override all of them. The
  // road band has its own block further down.
  const base = { height: 40, slope: 0, temperature: 0.5, humidity: 0.5, variation: 0, road: 0 };

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

  it('paints a roadbed as surfacing, in every biome', () => {
    // The road band is applied LAST, over whatever the ground would otherwise
    // have been, because a road replaces the surface rather than tinting it.
    // Asserted across the extremes -- a snowy peak, a wet lowland, a desert, a
    // sea floor -- so a road through a pass reads as a cleared road and not as
    // slightly grubby snow.
    const road = surfaceColor({ ...base, road: 1 });
    for (const height of [-30, 0, 60, 400]) {
      for (const t of [0, 1]) {
        for (const h of [0, 1]) {
          const surfaced = surfaceColor({ ...base, height, temperature: t, humidity: h, road: 1 });
          for (let c = 0; c < 3; c++) {
            expect(surfaced[c] as number).toBeCloseTo(road[c] as number, 10);
          }
        }
      }
    }
  });

  it('leaves the ground untouched where there is no road', () => {
    // `road: 0` must be exactly the pre-Phase-4a colour, or every existing
    // palette assertion in this file is testing something else now.
    for (const height of [-30, 0, 60, 400]) {
      const plain = surfaceColor({ ...base, height, road: 0 });
      const lerped = surfaceColor({ ...base, height, road: 0 });
      expect(plain).toEqual(lerped);
    }
    // And a partial band sits strictly between bare ground and full surfacing.
    const bare = surfaceColor({ ...base, road: 0 });
    const half = surfaceColor({ ...base, road: 0.5 });
    const full = surfaceColor({ ...base, road: 1 });
    for (let c = 0; c < 3; c++) {
      const lo = Math.min(bare[c] as number, full[c] as number);
      const hi = Math.max(bare[c] as number, full[c] as number);
      expect(half[c] as number).toBeGreaterThanOrEqual(lo);
      expect(half[c] as number).toBeLessThanOrEqual(hi);
    }
  });

  it('stays inside [0, 1] across the whole input space', () => {
    for (const height of [-120, -1, 0, 30, 150, 400]) {
      for (const slope of [0, 0.3, 0.7, 1]) {
        for (const t of [0, 0.5, 1]) {
          for (const h of [0, 1]) {
            for (const variation of [-1, 0, 1]) {
              for (const road of [0, 0.5, 1]) {
                for (const channel of surfaceColor({
                  height,
                  slope,
                  temperature: t,
                  humidity: h,
                  variation,
                  road,
                })) {
                  expect(channel).toBeGreaterThanOrEqual(0);
                  expect(channel).toBeLessThanOrEqual(1);
                }
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
    // Twelve interleaved seeds, not forty. The road memo holds eight networks,
    // so twelve evicts it half again over -- which is the property being tested
    // -- while forty spent fifty seconds routing thirty-eight regions nobody
    // asserts anything about. Phase 3b trimmed the seed counts here for the
    // same reason when rivers made a fresh seed expensive; Phase 4a makes a
    // fresh REGION expensive too. Both memos are tested for eviction directly,
    // and much harder, in `rivers.test.ts` and `roads.test.ts`.
    const first = generateChunk({ x: 9, z: -9, lod: 0 }, context());
    for (let i = 0; i < 12; i++) generateChunk({ x: i * 7, z: i * 5, lod: 0 }, context(SEED + i));
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
    // Phase Politics S2 bumped this 14 -> 15 for the new polityId/cultureId
    // scalars; Phase Politics B1 bumped it again, 15 -> 16, for
    // `buildingStart` (roof-type variety means buildings no longer share a
    // fixed vertex count); Phase Politics B4 bumped it again, 16 -> 17, for
    // the new `buildingsSimplified` scalar (its own LOD anti-vacuity
    // counter). Pinned here (rather than left to drift) so a future payload
    // change is a deliberate edit to this number, not a silent one.
    expect(CHUNK_DATA_VERSION).toBe(17);
    expect(data.positions).toBeInstanceOf(Float32Array);
    expect(data.indices).toBeInstanceOf(Uint32Array);
    expect(data.normals).toBeInstanceOf(Float32Array);
    expect(data.colors).toBeInstanceOf(Float32Array);
    expect(data.waterPositions).toBeInstanceOf(Float32Array);
    expect(data.waterColors).toBeInstanceOf(Float32Array);
    expect(data.waterIndices).toBeInstanceOf(Uint32Array);
    expect(data.deckPositions).toBeInstanceOf(Float32Array);
    expect(data.deckNormals).toBeInstanceOf(Float32Array);
    expect(data.deckColors).toBeInstanceOf(Float32Array);
    expect(data.deckIndices).toBeInstanceOf(Uint32Array);
    expect(data.buildingPositions).toBeInstanceOf(Float32Array);
    expect(data.buildingNormals).toBeInstanceOf(Float32Array);
    expect(data.buildingColors).toBeInstanceOf(Float32Array);
    expect(data.buildingIndices).toBeInstanceOf(Uint32Array);
    expect(data.wallPositions).toBeInstanceOf(Float32Array);
    expect(data.wallNormals).toBeInstanceOf(Float32Array);
    expect(data.wallColors).toBeInstanceOf(Float32Array);
    expect(data.wallIndices).toBeInstanceOf(Uint32Array);
    expect(data.propPositions).toBeInstanceOf(Float32Array);
    expect(data.propNormals).toBeInstanceOf(Float32Array);
    expect(data.propColors).toBeInstanceOf(Float32Array);
    expect(data.propIndices).toBeInstanceOf(Uint32Array);
    expect(data.indices.length % 3).toBe(0);
    for (const index of data.indices) {
      expect(index).toBeLessThan(data.positions.length / 3);
    }
  });

  it('polityId/cultureId: deterministic, and both claimed and unclaimed nodes exist', () => {
    // Phase Politics S2. A node's polityId/cultureId are one query at its
    // centre, not per-vertex data -- deterministic like everything else, and
    // `-1` for sea or ground beyond every polity's frontier.
    const a = generateChunk({ x: 40, z: 40, lod: 4 }, context());
    const b = generateChunk({ x: 40, z: 40, lod: 4 }, context());
    expect(a.polityId).toBe(b.polityId);
    expect(a.cultureId).toBe(b.cultureId);
    if (a.polityId === -1) expect(a.cultureId).toBe(-1);

    // Anti-vacuity: a world where every node reports -1 (politics never
    // wired in) and a world where every node reports the same claimed id
    // would each pass a single spot check -- both regimes must be seen.
    // `generateChunk` itself is expensive (full terrain/street/lot/building
    // generation per call), so rather than a broad grid of full chunk
    // generations, locate one claimed point and one sea point CHEAPLY with
    // `polity.ts`/`baseHeight` directly first, then generate exactly the two
    // chunks that matter.
    const terrain: PolityTerrain = { seaLevel: SEA_LEVEL, height: baseHeight };
    const climate: PolityClimate = { continentalness, habitability };
    const sites = citiesInBox(-100_000, -100_000, 100_000, 100_000, terrain, climate, SEED);
    expect(sites.length).toBeGreaterThan(0);
    const city = sites[0] as (typeof sites)[number];

    const claimedCoord = worldToChunk(city.x, city.z, 6);
    const claimedData = generateChunk(claimedCoord, context());
    expect(claimedData.polityId).toBeGreaterThanOrEqual(0);

    let seaX = city.x;
    for (let i = 0; i < 4_000 && baseHeight(seaX, city.z, SEED) >= SEA_LEVEL; i++) seaX += 500;
    expect(baseHeight(seaX, city.z, SEED)).toBeLessThan(SEA_LEVEL);
    const seaCoord = worldToChunk(seaX, city.z, 6);
    const seaData = generateChunk(seaCoord, context());
    expect(seaData.polityId).toBe(-1);
    expect(seaData.cultureId).toBe(-1);
  });

  it('paints a claimed city\'s buildings from its own CULTURE_BUILDING_PALETTES entry', () => {
    // Phase Politics B3. Every culture's own palette is measurably distinct
    // from every other's (otherwise a "wrong culture id" bug could hide
    // behind two coincidentally similar palettes)...
    expect(CULTURE_BUILDING_PALETTES.length).toBe(6);
    for (let i = 0; i < CULTURE_BUILDING_PALETTES.length; i++) {
      for (let j = i + 1; j < CULTURE_BUILDING_PALETTES.length; j++) {
        const a = CULTURE_BUILDING_PALETTES[i] as (typeof CULTURE_BUILDING_PALETTES)[number];
        const b = CULTURE_BUILDING_PALETTES[j] as (typeof CULTURE_BUILDING_PALETTES)[number];
        const dist = Math.abs(a.wallA[0] - b.wallA[0]) + Math.abs(a.wallA[1] - b.wallA[1]) + Math.abs(a.wallA[2] - b.wallA[2]);
        expect(dist).toBeGreaterThan(0.01);
      }
    }

    // ...and a real claimed VILLAGE's building vertex colours actually land
    // inside ITS culture's own palette range, not some other one. `face()`
    // never blends across two different palettes' colours -- every wall
    // vertex is `wallA` LERP `wallB` (via `wallTint`) and every roof vertex
    // is `roofA` LERP `roofB`, so every channel is bounded exactly by
    // [min(A, B), max(A, B)] for THIS culture, with the plinth colour itself
    // also always exactly `palette.plinth`. A VILLAGE, not the city itself,
    // because a landmark's stone/timber colours (`building-mesh.ts`'s
    // `LANDMARK_RECIPES`) are outside any culture palette by design -- B2
    // didn't touch them -- and the city centre this test would otherwise
    // pick almost always has at least one in frame.
    const terrain: PolityTerrain = { seaLevel: SEA_LEVEL, height: baseHeight };
    const climate: PolityClimate = { continentalness, habitability };
    const sites = citiesInBox(-100_000, -100_000, 100_000, 100_000, terrain, climate, SEED);
    expect(sites.length).toBeGreaterThan(0);
    const city = sites[0] as (typeof sites)[number];

    let claimedData: ReturnType<typeof generateChunk> | undefined;
    for (let ring = 1; ring <= 8 && claimedData === undefined; ring++) {
      for (const [dx, dz] of [
        [ring, 0],
        [-ring, 0],
        [0, ring],
        [0, -ring],
      ] as const) {
        const coord = worldToChunk(city.x + dx * 600, city.z + dz * 600, 0);
        const data = generateChunk(coord, context());
        const landmarks =
          data.buildingsKeep + data.buildingsCathedral + data.buildingsTownhall + data.buildingsGuildhall + data.buildingsGatehouse;
        if (data.cultureId >= 0 && data.buildings > 0 && landmarks === 0) {
          claimedData = data;
          break;
        }
      }
    }
    expect(claimedData).toBeDefined();
    const found = claimedData as ReturnType<typeof generateChunk>;
    const palette = CULTURE_BUILDING_PALETTES[found.cultureId] as (typeof CULTURE_BUILDING_PALETTES)[number];
    // Facade detail (door/window/chimney) uses its own small set of
    // culture-independent constants -- `building-mesh.ts`'s `wood`/`glass`/
    // cottage `stone` -- not the palette. They're folded into the expected
    // range here rather than the check being widened to "most vertices",
    // since they're few, fixed, and already known exactly.
    const wood: readonly number[] = [0.18, 0.11, 0.07];
    const glass: readonly number[] = [0.22, 0.28, 0.34];
    const facadeStone: readonly number[] = [0.22, 0.2, 0.18];
    const EPS = 1e-4;
    const lo = [0, 1, 2].map(
      (c) =>
        Math.min(
          palette.wallA[c] as number, palette.wallB[c] as number, palette.roofA[c] as number,
          palette.roofB[c] as number, palette.plinth[c] as number,
          wood[c] as number, glass[c] as number, facadeStone[c] as number,
        ) - EPS,
    );
    const hi = [0, 1, 2].map(
      (c) =>
        Math.max(
          palette.wallA[c] as number, palette.wallB[c] as number, palette.roofA[c] as number,
          palette.roofB[c] as number, palette.plinth[c] as number,
          wood[c] as number, glass[c] as number, facadeStone[c] as number,
        ) + EPS,
    );
    let checked = 0;
    for (let v = 0; v < found.buildingColors.length; v += 3) {
      for (let c = 0; c < 3; c++) {
        const value = found.buildingColors[v + c] as number;
        expect(value).toBeGreaterThanOrEqual(lo[c] as number);
        expect(value).toBeLessThanOrEqual(hi[c] as number);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
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
    expect(transferables).toContain(data.waterPositions.buffer);
    expect(transferables).toContain(data.waterColors.buffer);
    expect(transferables).toContain(data.waterIndices.buffer);
    expect(transferables).toContain(data.deckPositions.buffer);
    expect(transferables).toContain(data.deckNormals.buffer);
    expect(transferables).toContain(data.deckColors.buffer);
    expect(transferables).toContain(data.deckIndices.buffer);
    expect(transferables).toContain(data.buildingPositions.buffer);
    expect(transferables).toContain(data.buildingNormals.buffer);
    expect(transferables).toContain(data.buildingColors.buffer);
    expect(transferables).toContain(data.buildingIndices.buffer);
    expect(transferables).toContain(data.buildingStart.buffer);
    expect(transferables).toContain(data.wallPositions.buffer);
    expect(transferables).toContain(data.wallNormals.buffer);
    expect(transferables).toContain(data.wallColors.buffer);
    expect(transferables).toContain(data.wallIndices.buffer);
    expect(transferables).toContain(data.propPositions.buffer);
    expect(transferables).toContain(data.propNormals.buffer);
    expect(transferables).toContain(data.propColors.buffer);
    expect(transferables).toContain(data.propIndices.buffer);
    expect(transferables).toHaveLength(24);
    expect(chunkDataBytes(data)).toBe(
      data.positions.byteLength +
        data.indices.byteLength +
        data.normals.byteLength +
        data.colors.byteLength +
        data.waterPositions.byteLength +
        data.waterColors.byteLength +
        data.waterIndices.byteLength +
        data.deckPositions.byteLength +
        data.deckNormals.byteLength +
        data.deckColors.byteLength +
        data.deckIndices.byteLength +
        data.buildingPositions.byteLength +
        data.buildingNormals.byteLength +
        data.buildingColors.byteLength +
        data.buildingIndices.byteLength +
        data.buildingStart.byteLength +
        data.wallPositions.byteLength +
        data.wallNormals.byteLength +
        data.wallColors.byteLength +
        data.wallIndices.byteLength +
        data.propPositions.byteLength +
        data.propNormals.byteLength +
        data.propColors.byteLength +
        data.propIndices.byteLength,
    );
  });

  it('lists the EMPTY water, deck, building and prop buffers of a bare inland node as transferable too', () => {
    // A conditional transfer list is a rule with an exception, and the
    // exception is what a later phase forgets. Zero-length ArrayBuffers
    // transfer fine, so there is no exception: every bulk array, always.
    const data = generateChunk(DRY_CHUNK, context(WATER_SEED));
    expect(data.waterIndices).toHaveLength(0);
    const transferables = chunkDataTransferables(data);
    expect(transferables).toHaveLength(24);
    expect(new Set(transferables).size).toBe(24);
    expect(transferables).toContain(data.waterPositions.buffer);
    expect(transferables).toContain(data.deckPositions.buffer);
    expect(transferables).toContain(data.buildingPositions.buffer);
    expect(transferables).toContain(data.wallPositions.buffer);
    expect(transferables).toContain(data.propPositions.buffer);
    // ...and an empty water surface, an empty deck, no buildings AND no props
    // must add exactly nothing to the payload. That discipline is the whole
    // reason either can exist inside the draw-call and payload budgets: roads
    // are sparse and settlements sparser, so most nodes must cost nothing for
    // them -- and a desert node must cost nothing for vegetation either.
    expect(data.deckIndices).toHaveLength(0);
    expect(data.buildingIndices).toHaveLength(0);
    expect(data.buildings).toBe(0);
    expect(data.propIndices).toHaveLength(0);
    expect(data.props).toBe(0);
    expect(chunkDataBytes(data)).toBe(74676);
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

// ---------------------------------------------------------------------------
// Phase 3a: sea level and the water surface
// ---------------------------------------------------------------------------

describe('SEA_LEVEL', () => {
  it('anchors every altitude band in the surface palette', () => {
    // THE POINT OF THE CONSTANT. Until Phase 3a the shore fade was the literal
    // -14 and the vegetation fade the literal 2, while the sea was an implicit
    // zero somewhere else entirely. Two hardcoded zeros is how a coastline ends
    // up with the sand band and the water surface in different places.
    //
    // With `variation` at 0 the tint is exactly 1, so these are equalities
    // rather than approximations: at 14 m below sea level the ground is pure
    // silt, and at 1 m above it is pure sand.
    const flat = { slope: 0, temperature: 0.5, humidity: 0.5, variation: 0, road: 0 };
    const silt = surfaceColor({ ...flat, height: SEA_LEVEL - 14 });
    const sand = surfaceColor({ ...flat, height: SEA_LEVEL + 1 });
    expect(silt).toEqual([0.33, 0.35, 0.29]);
    expect(sand).toEqual([0.78, 0.71, 0.52]);
    // ...and at sea level itself the ground is part way between the two, which
    // is what makes the water's edge sit on a beach rather than on a hard band
    // boundary.
    const shoreline = surfaceColor({ ...flat, height: SEA_LEVEL });
    for (let c = 0; c < 3; c++) {
      const low = Math.min(silt[c] as number, sand[c] as number);
      const high = Math.max(silt[c] as number, sand[c] as number);
      expect(shoreline[c] as number).toBeGreaterThan(low);
      expect(shoreline[c] as number).toBeLessThan(high);
    }
  });

  it('is the same constant the water surface is built at', () => {
    // The two halves of "shared": the palette above is anchored to SEA_LEVEL,
    // and every water vertex in the world is at exactly SEA_LEVEL with an alpha
    // that is exactly zero there. If either side ever read a different zero,
    // one of these two assertions has to move.
    expect(waterColor(0)[3]).toBe(0);
    const data = generateChunk(SUBMERGED_CHUNK, context(WATER_SEED));
    expect(data.waterPositions.length).toBeGreaterThan(0);
    for (let i = 1; i < data.waterPositions.length; i += 3) {
      expect(data.waterPositions[i]).toBe(SEA_LEVEL);
    }
  });
});

describe('waterColor', () => {
  it('is a pure function of depth', () => {
    for (const depth of [-3, 0, 0.5, 4, 12, 40]) {
      expect(waterColor(depth)).toEqual(waterColor(depth));
    }
    // Order-independence, for the same reason `chunkColor` is tested for it:
    // anything that remembered a previous call would break RULE 1.
    const forwards = [0, 3, 9, 30].map(waterColor);
    const backwards = [30, 9, 3, 0].map(waterColor).reverse();
    expect(backwards).toEqual(forwards);
  });

  it('is invisible at zero depth and never quite opaque', () => {
    // Alpha 0 exactly at the waterline is what makes the shoreline a gradient
    // instead of an edge: the sea fades out as the floor rises to meet it, so
    // there is no line for the eye to catch.
    expect(waterColor(0)[3]).toBe(0);
    expect(waterColor(-9)[3]).toBe(0);
    expect(waterColor(1e6)[3]).toBe(WATER_ALPHA_MAX);
    expect(WATER_ALPHA_MAX).toBeLessThan(1);
  });

  it('gets steadily more opaque and steadily darker with depth', () => {
    let previousAlpha = -1;
    let previousLuma = 2;
    for (let depth = 0; depth <= 40; depth += 0.5) {
      const [r, g, b, a] = waterColor(depth);
      const luma = r + g + b;
      expect(a).toBeGreaterThanOrEqual(previousAlpha);
      expect(luma).toBeLessThanOrEqual(previousLuma + 1e-12);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      for (const c of [r, g, b]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      previousAlpha = a;
      previousLuma = luma;
    }
    // ...and the two ends are genuinely different, or "steadily" would be
    // satisfied by a constant.
    expect(waterColor(40)[3] - waterColor(0.25)[3]).toBeGreaterThan(0.5);
    expect(waterColor(0.25)[2] - waterColor(40)[2]).toBeGreaterThan(0.2);
  });

  it('is fully determined by the depth, not by the alpha ramp constants alone', () => {
    // Guards the ramp against being flattened to a constant by a future edit:
    // half of the full depth must be visibly less opaque than all of it.
    expect(waterColor(WATER_ALPHA_FULL_DEPTH / 2)[3]).toBeLessThan(WATER_ALPHA_MAX * 0.85);
    expect(waterColor(WATER_ALPHA_FULL_DEPTH / 2)[3]).toBeGreaterThan(WATER_ALPHA_MAX * 0.5);
  });
});

describe('the water surface', () => {
  const ctx = (): ReturnType<typeof createTierContext> => context(WATER_SEED);

  const lowestHeight = (coord: ChunkCoord): number => {
    let lowest = Infinity;
    for (let row = 0; row <= SEGMENTS; row++) {
      for (let col = 0; col <= SEGMENTS; col++) {
        lowest = Math.min(lowest, vertexHeight(coord, col, row, WATER_SEED));
      }
    }
    return lowest;
  };

  it('has one node of each kind to test against on this seed', () => {
    // Pins the three fixtures the rest of this block -- and `chunk-mesh.test.ts`
    // -- are written against. Retune the height field and this fails first, with
    // an obvious reason, instead of scattering confusing failures downstream.
    expect(generateChunk(DRY_CHUNK, ctx()).waterIndices).toHaveLength(0);
    const shore = generateChunk(SHORE_CHUNK, ctx()).waterIndices.length / 3;
    expect(shore).toBeGreaterThan(0);
    expect(shore).toBeLessThan(MAX_WATER_TRIANGLE_COUNT);
    expect(generateChunk(SUBMERGED_CHUNK, ctx()).waterIndices.length / 3).toBe(
      MAX_WATER_TRIANGLE_COUNT,
    );
  });

  it('exists exactly on the nodes whose ground goes below sea level', () => {
    // Both halves matter. "Water where there is sea" is the feature; "NO water
    // where there is none" is the entire draw-call budget of this phase, and it
    // is the half a screenshot cannot check.
    let withWater = 0;
    let withoutWater = 0;
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) {
        const coord = { x, z, lod: 0 };
        const data = generateChunk(coord, ctx());
        const wet = lowestHeight(coord) < SEA_LEVEL;
        expect(data.waterIndices.length > 0).toBe(wet);
        expect(data.waterPositions.length > 0).toBe(wet);
        expect(data.waterColors.length > 0).toBe(wet);
        if (wet) withWater++;
        else withoutWater++;
      }
    }
    // Anti-vacuity: this seed must actually contain both kinds of node, or the
    // assertion above is being made about one case only.
    expect(withWater).toBeGreaterThan(20);
    expect(withoutWater).toBeGreaterThan(5);
  });

  it('covers every quad whose ground dips below sea level, and no others', () => {
    // The rendered ground inside a quad is the linear interpolation of its four
    // corners, so "any corner below sea level" is exactly "rendered ground dips
    // below the sea here". Anything less leaves a hole in the sea; anything
    // more is hidden under the beach but costs bytes.
    const coord = SHORE_CHUNK;
    const data = generateChunk(coord, ctx());
    let expectedQuads = 0;
    for (let row = 0; row < SEGMENTS; row++) {
      for (let col = 0; col < SEGMENTS; col++) {
        const wet =
          vertexHeight(coord, col, row, WATER_SEED) < SEA_LEVEL ||
          vertexHeight(coord, col + 1, row, WATER_SEED) < SEA_LEVEL ||
          vertexHeight(coord, col, row + 1, WATER_SEED) < SEA_LEVEL ||
          vertexHeight(coord, col + 1, row + 1, WATER_SEED) < SEA_LEVEL;
        if (wet) expectedQuads++;
      }
    }
    expect(expectedQuads).toBeGreaterThan(0);
    expect(expectedQuads).toBeLessThan(SEGMENTS * SEGMENTS);
    expect(data.waterIndices.length).toBe(expectedQuads * 6);
  });

  it('emits at most one visible-alpha-free quad: every quad has a submerged corner', () => {
    // The reason the water grid is the terrain grid and not something coarser.
    // A quad whose four corners are all dry shades to alpha 0 at every corner
    // and renders as a hole in the sea over ground that IS below water.
    const data = generateChunk(SHORE_CHUNK, ctx());
    const alphaOf = (vertex: number): number => data.waterColors[vertex * 4 + 3] as number;
    for (let i = 0; i < data.waterIndices.length; i += 6) {
      const corners = [
        data.waterIndices[i] as number,
        data.waterIndices[i + 1] as number,
        data.waterIndices[i + 2] as number,
        data.waterIndices[i + 5] as number,
      ];
      expect(Math.max(...corners.map(alphaOf))).toBeGreaterThan(0);
    }
  });

  it('compacts its vertices instead of emitting the whole lattice', () => {
    const shore = generateChunk(SHORE_CHUNK, ctx());
    const submerged = generateChunk(SUBMERGED_CHUNK, ctx());
    expect(submerged.waterPositions.length / 3).toBe(MAX_WATER_VERTEX_COUNT);
    expect(submerged.waterIndices.length / 3).toBe(MAX_WATER_TRIANGLE_COUNT);
    expect(shore.waterPositions.length / 3).toBeLessThan(MAX_WATER_VERTEX_COUNT);
    expect(shore.waterPositions.length / 3).toBeGreaterThan(0);
    // Colours are rgbA, four per vertex, or Three throws the opacity away.
    expect(shore.waterColors.length).toBe((shore.waterPositions.length / 3) * 4);
    // Every index must point at a vertex that was actually emitted.
    for (const index of shore.waterIndices) {
      expect(index).toBeLessThan(shore.waterPositions.length / 3);
    }
  });

  it('shades each vertex by the depth of the ground beneath it', () => {
    const coord = SHORE_CHUNK;
    const data = generateChunk(coord, ctx());
    const side = SEGMENTS + 1;
    // Rebuild the compaction the same way the generator does, then check every
    // vertex against `waterColor` evaluated at an independently sampled depth.
    let checked = 0;
    let vertex = 0;
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const x = vertexWorldX(coord, col);
        const z = vertexWorldZ(coord, row);
        if (
          Math.abs((data.waterPositions[vertex * 3] as number) - (x - coord.x * CHUNK_SIZE)) > 1e-3 ||
          Math.abs((data.waterPositions[vertex * 3 + 2] as number) - (z - coord.z * CHUNK_SIZE)) > 1e-3
        ) {
          continue;
        }
        const depth = SEA_LEVEL - sampleHeight(x, z, WATER_SEED);
        expect(data.waterColors[vertex * 4 + 3] as number).toBeCloseTo(waterColor(depth)[3], 5);
        vertex++;
        checked++;
      }
    }
    expect(checked).toBe(data.waterPositions.length / 3);
    // ...and the depths on this node actually vary, or the check is vacuous.
    const alphas = new Set<number>();
    for (let i = 3; i < data.waterColors.length; i += 4) alphas.add(data.waterColors[i] as number);
    expect(alphas.size).toBeGreaterThan(20);
  });

  it('regenerates byte-identically, water included (RULE 2)', () => {
    const first = generateChunk(SHORE_CHUNK, ctx());
    // Unrelated work in between, at other levels and other coordinates.
    generateChunk({ x: 1, z: 1, lod: 2 }, ctx());
    generateChunk(DRY_CHUNK, ctx());
    generateChunk(SUBMERGED_CHUNK, context(WATER_SEED + 1));
    const again = generateChunk(SHORE_CHUNK, ctx());
    expect(Array.from(again.waterPositions)).toEqual(Array.from(first.waterPositions));
    expect(Array.from(again.waterColors)).toEqual(Array.from(first.waterColors));
    expect(Array.from(again.waterIndices)).toEqual(Array.from(first.waterIndices));
  });

  it('meets its neighbour exactly, at every level, so it can never crack', () => {
    // Terrain needs a skirt because two nodes sample a curved surface at
    // different rates. Water is the plane y = SEA_LEVEL at every level, so the
    // shared edge agrees by construction -- this is the assertion that says the
    // missing skirt is a consequence and not an omission.
    let checked = 0;
    for (const lod of [0, 1, 3]) {
      for (let x = -2; x <= 2; x++) {
        const data = generateChunk({ x, z: 0, lod }, ctx());
        if (data.waterPositions.length === 0) continue;
        for (let i = 1; i < data.waterPositions.length; i += 3) {
          expect(data.waterPositions[i]).toBe(SEA_LEVEL);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('costs a coastal node a fraction of what the terrain costs', () => {
    // The payload budget in `scripts/soak.mjs` is derived from these numbers.
    const submerged = generateChunk(SUBMERGED_CHUNK, ctx());
    const terrainBytes = 74676;
    const waterBytes =
      submerged.waterPositions.byteLength +
      submerged.waterColors.byteLength +
      submerged.waterIndices.byteLength;
    expect(waterBytes).toBe(1089 * 3 * 4 + 1089 * 4 * 4 + 2048 * 3 * 4);
    expect(waterBytes).toBe(55068);
    expect(chunkDataBytes(submerged)).toBe(terrainBytes + waterBytes);
    // Worst case, on a node entirely at sea: under 75% on top of the terrain.
    expect(waterBytes / terrainBytes).toBeLessThan(0.75);
  });

  it('scales with the node rather than with the world, at every level', () => {
    // Like `SEGMENTS`, the water grid is per NODE, so a lod-6 node covering
    // 4 km of sea costs no more than a lod-0 node covering 64 m of it. That is
    // what keeps water on the same "bound the node count" footing as terrain.
    for (const lod of [0, 2, 4, 6]) {
      const data = generateChunk({ x: 0, z: 0, lod }, ctx());
      expect(data.waterIndices.length / 3).toBeLessThanOrEqual(MAX_WATER_TRIANGLE_COUNT);
      expect(data.waterPositions.length / 3).toBeLessThanOrEqual(MAX_WATER_VERTEX_COUNT);
      expect(data.waterIndices.length).toBeGreaterThan(0);
    }
    // ...and the bound is reachable, or "no more than" would be satisfied by
    // never emitting anything.
    const full = generateChunk(SUBMERGED_CHUNK, ctx());
    expect(full.waterIndices.length / 3).toBe(MAX_WATER_TRIANGLE_COUNT);
    expect(full.waterPositions.length / 3).toBe(MAX_WATER_VERTEX_COUNT);
  });
});
