/**
 * Determinism tests for chunk generation.
 *
 * RULE 1 says the same `(worldSeed, coord)` must produce byte-identical output
 * forever, regardless of visit order. These tests are the cheapest place to
 * catch a violation: they need no browser, no workers, and no renderer.
 */

import { describe, expect, it } from 'vitest';
import { chunkColor, generateChunk, hslToRgb } from './chunk-gen';
import { CHUNK_DATA_VERSION, CHUNK_SIZE, createTierContext, type ChunkCoord } from './contracts';

const SEED = 0xc0ffee;
const context = (seed = SEED): ReturnType<typeof createTierContext> =>
  createTierContext(seed, 'chunk');

const COORDS: ChunkCoord[] = [
  { x: 0, z: 0 },
  { x: 1, z: 0 },
  { x: -1, z: -1 },
  { x: 37, z: -998 },
  { x: -2147483, z: 2147483 },
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
    const before = chunkColor({ x: 4, z: 4 }, SEED);
    for (let i = 0; i < 500; i++) chunkColor({ x: i, z: -i }, SEED ^ i);
    expect(chunkColor({ x: 4, z: 4 }, SEED)).toEqual(before);
  });

  it('distinguishes transposed coordinates', () => {
    expect(chunkColor({ x: 3, z: 8 }, SEED)).not.toEqual(chunkColor({ x: 8, z: 3 }, SEED));
  });

  it('changes with the seed', () => {
    expect(chunkColor({ x: 0, z: 0 }, SEED)).not.toEqual(chunkColor({ x: 0, z: 0 }, SEED + 1));
  });

  it('stays inside the [0, 1] channel range', () => {
    for (let i = 0; i < 2000; i++) {
      for (const channel of chunkColor({ x: i, z: 7 - i }, SEED)) {
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
      const [r, g, b] = chunkColor({ x, z: 0 }, SEED);
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

describe('generateChunk', () => {
  it('produces byte-identical payloads for the same coordinate and seed', () => {
    for (const coord of COORDS) {
      const a = generateChunk(coord, context());
      const b = generateChunk(coord, context());
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
      expect(a.color).toEqual(b.color);
      expect(a.worldSeed).toBe(b.worldSeed);
    }
  });

  it('regenerates identically after an interleaved run over other chunks', () => {
    const first = generateChunk({ x: 9, z: -9 }, context());
    for (let i = 0; i < 200; i++) generateChunk({ x: i, z: i }, context(SEED + i));
    const again = generateChunk({ x: 9, z: -9 }, context());
    expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
    expect(again.color).toEqual(first.color);
  });

  it('emits chunk-local positions spanning exactly one chunk', () => {
    const data = generateChunk({ x: 5, z: -2 }, context());
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < data.positions.length; i += 3) {
      xs.push(data.positions[i] as number);
      expect(data.positions[i + 1]).toBe(0);
      zs.push(data.positions[i + 2] as number);
    }
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(CHUNK_SIZE);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(CHUNK_SIZE);
    expect(data.minY).toBe(0);
    expect(data.maxY).toBe(0);
  });

  it('emits transferable typed arrays and a version stamp', () => {
    const data = generateChunk({ x: 0, z: 0 }, context());
    expect(data.version).toBe(CHUNK_DATA_VERSION);
    expect(data.positions).toBeInstanceOf(Float32Array);
    expect(data.indices).toBeInstanceOf(Uint32Array);
    expect(data.indices.length % 3).toBe(0);
    for (const index of data.indices) {
      expect(index).toBeLessThan(data.positions.length / 3);
    }
  });

  it('refuses a context from the wrong tier', () => {
    expect(() => generateChunk({ x: 0, z: 0 }, createTierContext(1, 'sector'))).toThrow(/tier/i);
  });
});
