import { describe, expect, it } from 'vitest';
import { hash2i, hash3i, hashString, mix32, rngAt2i, rngFromHash } from './hash';

const isU32 = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

describe('mix32', () => {
  it('returns a uint32 for any int32 input', () => {
    for (const v of [0, 1, -1, 2 ** 31 - 1, -(2 ** 31), 123456789]) {
      expect(isU32(mix32(v))).toBe(true);
    }
  });

  it('avalanches: flipping one input bit changes many output bits', () => {
    for (let bit = 0; bit < 32; bit++) {
      const a = mix32(0x12345678);
      const b = mix32(0x12345678 ^ (1 << bit));
      const changed = popcount(a ^ b);
      // A healthy 32-bit mixer changes ~16 bits. Anything under 8 means the
      // mixer is broken in a way that would show up as visible banding.
      expect(changed).toBeGreaterThan(8);
    }
  });
});

describe('hash2i / hash3i', () => {
  it('is a pure function: same inputs always give the same output', () => {
    expect(hash2i(17, -42, 99)).toBe(hash2i(17, -42, 99));
    expect(hash3i(17, -42, 8, 99)).toBe(hash3i(17, -42, 8, 99));
  });

  it('returns uint32 for negative and extreme coordinates', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [-1, -1],
      [-2147483648, 2147483647],
      [999999, -999999],
    ];
    for (const [x, y] of cases) {
      expect(isU32(hash2i(x, y, 7))).toBe(true);
      expect(isU32(hash3i(x, y, x - y, 7))).toBe(true);
    }
  });

  it('separates axes: (a,b) does not collide with (b,a)', () => {
    expect(hash2i(3, 9, 0)).not.toBe(hash2i(9, 3, 0));
    expect(hash3i(1, 2, 3, 0)).not.toBe(hash3i(3, 2, 1, 0));
  });

  it('separates seeds: the same coordinate differs between worlds', () => {
    expect(hash2i(5, 5, 1)).not.toBe(hash2i(5, 5, 2));
  });

  it('is order-independent: interleaved calls do not perturb each other', () => {
    const direct = [hash2i(0, 0, 1), hash2i(1, 0, 1), hash2i(0, 1, 1)];
    hash2i(999, 999, 1);
    hash3i(4, 5, 6, 77);
    const afterNoise = [hash2i(0, 0, 1), hash2i(1, 0, 1), hash2i(0, 1, 1)];
    expect(afterNoise).toEqual(direct);
  });

  it('spreads uniformly across buckets over a coordinate grid', () => {
    const buckets = new Array<number>(16).fill(0);
    let n = 0;
    for (let x = -32; x < 32; x++) {
      for (let y = -32; y < 32; y++) {
        const b = hash2i(x, y, 1234) % 16;
        buckets[b] = (buckets[b] ?? 0) + 1;
        n++;
      }
    }
    const expected = n / 16;
    for (const count of buckets) {
      // Loose bound; this catches a mixer that bands, not one that is merely
      // imperfect.
      expect(count).toBeGreaterThan(expected * 0.6);
      expect(count).toBeLessThan(expected * 1.4);
    }
  });
});

describe('hashString', () => {
  it('is stable and distinguishes similar strings', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
    expect(hashString('hello')).not.toBe(hashString('hellp'));
    expect(hashString('')).toBe(hashString(''));
    expect(isU32(hashString('infinite-world'))).toBe(true);
  });
});

describe('rngFromHash', () => {
  it('produces the same sequence for independent streams from the same hash', () => {
    const a = rngFromHash(0xdeadbeef);
    const b = rngFromHash(0xdeadbeef);
    const seqA = Array.from({ length: 32 }, () => a.nextU32());
    const seqB = Array.from({ length: 32 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('is unaffected by unrelated streams drawn in between', () => {
    const reference = rngFromHash(42);
    const expected = Array.from({ length: 8 }, () => reference.float());

    const interleaved = rngFromHash(42);
    const noise = rngFromHash(43);
    const actual: number[] = [];
    for (let i = 0; i < 8; i++) {
      noise.nextU32();
      noise.nextU32();
      actual.push(interleaved.float());
    }
    expect(actual).toEqual(expected);
  });

  it('keeps float() inside [0, 1)', () => {
    const rng = rngFromHash(hashString('bounds'));
    for (let i = 0; i < 10000; i++) {
      const v = rng.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('keeps int() inside [0, n) and handles degenerate bounds', () => {
    const rng = rngFromHash(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(rng.int(0)).toBe(0);
    expect(rng.int(-3)).toBe(0);
  });

  it('keeps range() inside [min, max)', () => {
    const rng = rngFromHash(2);
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });

  it('counts draws', () => {
    const rng = rngFromHash(3);
    expect(rng.drawn).toBe(0);
    rng.float();
    rng.int(4);
    expect(rng.drawn).toBe(2);
  });
});

describe('rngAt2i', () => {
  it('reproduces a coordinate stream after arbitrary other work', () => {
    const before = rngAt2i(12, -3, 5);
    const first = Array.from({ length: 4 }, () => before.nextU32());

    // Simulate other chunks being generated in between, in arbitrary order --
    // the Phase 1 "fly away and come back to identical colours" property.
    for (let i = 0; i < 100; i++) rngAt2i(i, -i, 5).nextU32();

    const after = rngAt2i(12, -3, 5);
    const again = Array.from({ length: 4 }, () => after.nextU32());
    expect(again).toEqual(first);
  });
});

function popcount(v: number): number {
  let x = v >>> 0;
  let count = 0;
  while (x !== 0) {
    count += x & 1;
    x >>>= 1;
  }
  return count;
}
