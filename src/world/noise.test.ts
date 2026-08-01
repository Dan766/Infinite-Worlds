/**
 * Tests for the noise primitives.
 *
 * The bar these have to clear: they must FAIL on a broken noise field, not
 * merely pass on a working one. A test that only asserts "returns a number" or
 * "is repeatable" would sail through a field that returned a constant, and a
 * constant field produces a perfectly flat, perfectly deterministic, completely
 * broken world. So range, variation and spatial correlation are all asserted.
 */

import { describe, expect, it } from 'vitest';
import { hashCombine } from '../core/hash';
import { fbm2, gradientNoise2, hashUnit, lerp, ridged2, smoothstep, warp2 } from './noise';

const SEED = 0x51de;

/** Sample a field over an irregular scatter of points, avoiding lattice points. */
function scatter(fn: (x: number, z: number) => number, count = 4000): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(fn(i * 0.37 - 500.11, i * 0.61 - 300.03));
  }
  return values;
}

describe('gradientNoise2', () => {
  it('is a pure function of position and seed', () => {
    for (const [x, z] of [
      [0.25, 0.75],
      [-13.5, 41.125],
      [1e5 + 0.5, -1e5 - 0.5],
    ] as [number, number][]) {
      expect(gradientNoise2(x, z, SEED)).toBe(gradientNoise2(x, z, SEED));
    }
  });

  it('does not depend on evaluation order', () => {
    const points: [number, number][] = [];
    for (let i = 0; i < 200; i++) points.push([i * 0.31, -i * 0.73]);
    const forwards = points.map(([x, z]) => gradientNoise2(x, z, SEED));
    const backwards = [...points].reverse().map(([x, z]) => gradientNoise2(x, z, SEED));
    expect(backwards.reverse()).toEqual(forwards);
  });

  it('stays inside [-1, 1]', () => {
    for (const value of scatter((x, z) => gradientNoise2(x, z, SEED), 20000)) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('actually varies, and uses most of its range', () => {
    const values = scatter((x, z) => gradientNoise2(x, z, SEED), 20000);
    expect(Math.min(...values)).toBeLessThan(-0.5);
    expect(Math.max(...values)).toBeGreaterThan(0.5);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // Roughly zero-centred; a biased field would push the whole world up or down.
    expect(Math.abs(mean)).toBeLessThan(0.08);
  });

  it('is coherent: nearby points are similar, distant points are not', () => {
    // This is what separates noise from a hash. A hash would pass every test
    // above and produce unwalkable static.
    let nearDelta = 0;
    let farDelta = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 0.53 + 0.17;
      const z = -i * 0.29 + 0.11;
      const here = gradientNoise2(x, z, SEED);
      nearDelta += Math.abs(gradientNoise2(x + 0.02, z, SEED) - here);
      farDelta += Math.abs(gradientNoise2(x + 7.5, z, SEED) - here);
    }
    expect(nearDelta * 10).toBeLessThan(farDelta);
  });

  it('changes with the seed', () => {
    const a = scatter((x, z) => gradientNoise2(x, z, SEED), 200);
    const b = scatter((x, z) => gradientNoise2(x, z, SEED + 1), 200);
    expect(a).not.toEqual(b);
  });

  it('survives large coordinates without collapsing into repeats', () => {
    const near = scatter((x, z) => gradientNoise2(x, z, SEED), 300);
    const far = scatter((x, z) => gradientNoise2(x + 1e6, z - 1e6, SEED), 300);
    expect(far).not.toEqual(near);
    expect(Math.max(...far) - Math.min(...far)).toBeGreaterThan(0.5);
  });
});

describe('fbm2', () => {
  it('stays inside [-1, 1] for any octave count', () => {
    for (const octaves of [1, 2, 4, 8]) {
      for (const value of scatter((x, z) => fbm2(x, z, SEED, octaves, 0.05), 3000)) {
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic and order-independent', () => {
    const a = scatter((x, z) => fbm2(x, z, SEED, 5, 0.02), 500);
    const b = scatter((x, z) => fbm2(x, z, SEED, 5, 0.02), 500);
    expect(a).toEqual(b);
  });

  it('one octave is exactly the underlying noise, reseeded per octave', () => {
    // Octaves are reseeded rather than sampled from one field at different
    // scales; sharing a seed makes them coincide at their common lattice points
    // and shows up as a faint grid in the terrain.
    for (const [x, z] of [
      [0.3, 0.7],
      [-9.25, 4.5],
    ] as [number, number][]) {
      expect(fbm2(x, z, SEED, 1, 1)).toBe(gradientNoise2(x, z, hashCombine(SEED, 0)));
      expect(fbm2(x, z, SEED, 1, 1)).not.toBe(gradientNoise2(x, z, SEED));
    }
  });

  it('adds detail: more octaves means many more features along a line', () => {
    // Counting turning points is the direct measure. Amplitude is NOT: fBm
    // normalises by total amplitude, so adding octaves shrinks the base one and
    // the overall range barely moves. A test on range would look like it worked
    // and would pass on a stack whose extra octaves were silently dropped.
    const turningPoints = (octaves: number): number => {
      let count = 0;
      let previous = 0;
      for (let i = 1; i < 8000; i++) {
        const x = i * 0.05;
        const delta = fbm2(x, 0.37, SEED, octaves, 0.02) - fbm2(x - 0.05, 0.37, SEED, octaves, 0.02);
        if (previous !== 0 && Math.sign(delta) !== Math.sign(previous)) count++;
        previous = delta;
      }
      return count;
    };
    const one = turningPoints(1);
    const eight = turningPoints(8);
    expect(one).toBeGreaterThan(0);
    expect(eight).toBeGreaterThan(one * 10);
  });
});

describe('ridged2', () => {
  it('stays inside [0, 1]', () => {
    for (const value of scatter((x, z) => ridged2(x, z, SEED, 6, 0.03), 8000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const a = scatter((x, z) => ridged2(x, z, SEED, 6, 0.03), 400);
    const b = scatter((x, z) => ridged2(x, z, SEED, 6, 0.03), 400);
    expect(a).toEqual(b);
  });

  it('has broad high ground cut by narrow deep creases', () => {
    // The signature of `1 - |noise|`: most of the domain sits high, and the
    // zero-set of the underlying noise carves a sparse network of sharp
    // valleys. A symmetric distribution here would mean the fold was lost and
    // the terrain would render as uniform corrugation.
    const values = scatter((x, z) => ridged2(x, z, SEED, 6, 0.03), 8000).sort((a, b) => a - b);
    const at = (p: number): number => values[Math.floor(p * (values.length - 1))] as number;
    expect(at(0.5)).toBeGreaterThan(0.45);
    expect(at(0.05)).toBeLessThan(0.3);
    expect(at(0)).toBeLessThan(0.1);
    expect(at(1)).toBeGreaterThan(0.9);
  });

  it('never goes negative, unlike the fBm it is folded from', () => {
    const ridges = scatter((x, z) => ridged2(x, z, SEED, 6, 0.03), 2000);
    const plain = scatter((x, z) => fbm2(x, z, SEED, 6, 0.03), 2000);
    expect(Math.min(...ridges)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...plain)).toBeLessThan(0);
  });
});

describe('warp2', () => {
  it('displaces by no more than the requested amplitude', () => {
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.91 - 400;
      const z = i * 0.37 + 90;
      const w = warp2(x, z, SEED, 50, 0.004);
      expect(Math.abs(w.x - x)).toBeLessThanOrEqual(50);
      expect(Math.abs(w.z - z)).toBeLessThanOrEqual(50);
    }
  });

  it('actually moves the point, and not by a constant', () => {
    const offsets = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const w = warp2(i * 13.7, i * 5.1, SEED, 100, 0.004);
      offsets.add(Math.round((w.x - i * 13.7) * 100));
    }
    expect(offsets.size).toBeGreaterThan(50);
  });

  it('displaces x and z independently', () => {
    const w = warp2(3.5, -7.25, SEED, 100, 0.004);
    expect(w.x - 3.5).not.toBe(w.z + 7.25);
  });
});

describe('shaping helpers', () => {
  it('smoothstep is flat outside its band and monotonic inside', () => {
    expect(smoothstep(2, 6, 1)).toBe(0);
    expect(smoothstep(2, 6, 7)).toBe(1);
    expect(smoothstep(2, 6, 4)).toBeCloseTo(0.5, 12);
    let previous = -1;
    for (let v = 2; v <= 6; v += 0.25) {
      const s = smoothstep(2, 6, v);
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
    }
    // Degenerate band must not divide by zero.
    expect(smoothstep(3, 3, 2)).toBe(0);
    expect(smoothstep(3, 3, 4)).toBe(1);
  });

  it('lerp is exact at the ends', () => {
    expect(lerp(-3, 9, 0)).toBe(-3);
    expect(lerp(-3, 9, 1)).toBe(9);
  });

  it('hashUnit maps uint32 into [0, 1)', () => {
    expect(hashUnit(0)).toBe(0);
    expect(hashUnit(0xffffffff)).toBeLessThan(1);
    expect(hashUnit(-1)).toBeLessThan(1);
    expect(hashUnit(-1)).toBeGreaterThan(0.99);
  });
});
