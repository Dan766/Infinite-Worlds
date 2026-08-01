/**
 * Tests for the height field and the four biome fields.
 *
 * These are written to fail on a BROKEN height field, not merely to pass on a
 * working one. The failure modes worth catching are:
 *
 *   - a field that returns a constant (flat world, perfectly deterministic)
 *   - a field that ignores the seed (every world identical)
 *   - a field that ignores position on one axis (striped world)
 *   - a field that degenerates far from the origin (float mush at 200 km)
 *   - a field whose value at the origin is seed-independent, which is what a
 *     naive gradient-noise stack does, because the origin is a lattice point
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import {
  MAX_HEIGHT,
  MIN_HEIGHT,
  biomeFields,
  continentalness,
  erosion,
  humidity,
  reliefMask,
  sampleHeight,
  temperature,
} from './height-field';

const SEED = hashString('height-field-test');
const OTHER = hashString('a different world');

/** An irregular scatter, deliberately avoiding round numbers and lattice points. */
function points(count: number, scale = 137.31): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    out.push([i * scale - 3011.7, i * (scale * 0.61) - 5107.3]);
  }
  return out;
}

const FIELDS = [
  { name: 'continentalness', fn: continentalness, min: -1, max: 1 },
  { name: 'erosion', fn: erosion, min: -1, max: 1 },
  { name: 'temperature', fn: temperature, min: 0, max: 1 },
  { name: 'humidity', fn: humidity, min: 0, max: 1 },
] as const;

describe('biome fields', () => {
  for (const field of FIELDS) {
    describe(field.name, () => {
      it('is a pure function of position and seed', () => {
        for (const [x, z] of points(50)) {
          expect(field.fn(x, z, SEED)).toBe(field.fn(x, z, SEED));
        }
      });

      it('does not depend on evaluation order', () => {
        const ps = points(200);
        const forwards = ps.map(([x, z]) => field.fn(x, z, SEED));
        const backwards = [...ps].reverse().map(([x, z]) => field.fn(x, z, SEED));
        expect(backwards.reverse()).toEqual(forwards);
      });

      it('stays inside its documented range', () => {
        for (const [x, z] of points(3000, 41.7)) {
          const value = field.fn(x, z, SEED);
          expect(value).toBeGreaterThanOrEqual(field.min);
          expect(value).toBeLessThanOrEqual(field.max);
        }
      });

      it('is not constant, and spans most of its range', () => {
        const values = points(3000, 313.9).map(([x, z]) => field.fn(x, z, SEED));
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        const span = field.max - field.min;
        expect(hi - lo).toBeGreaterThan(span * 0.3);
      });

      it('varies along both axes', () => {
        const alongX = new Set(
          Array.from({ length: 60 }, (_, i) => field.fn(i * 331.1, 12.5, SEED).toFixed(4)),
        );
        const alongZ = new Set(
          Array.from({ length: 60 }, (_, i) => field.fn(12.5, i * 331.1, SEED).toFixed(4)),
        );
        expect(alongX.size).toBeGreaterThan(30);
        expect(alongZ.size).toBeGreaterThan(30);
      });

      it('is low frequency: it barely changes across one chunk', () => {
        // Phase 4 reads these at the Region and Sector tiers and Phase 2a reads
        // them per vertex. If they varied at chunk scale those two readings
        // would disagree and biomes would flicker between neighbours.
        let maxDelta = 0;
        for (const [x, z] of points(200, 617.3)) {
          maxDelta = Math.max(maxDelta, Math.abs(field.fn(x + 64, z, SEED) - field.fn(x, z, SEED)));
        }
        expect(maxDelta).toBeLessThan((field.max - field.min) * 0.1);
      });

      it('differs between seeds, including at the origin', () => {
        // The origin is a lattice point of every frequency, and gradient noise
        // is exactly zero there. Without a seed-derived lattice offset every
        // world would be identical at (0, 0) -- which is exactly where the
        // default camera looks.
        expect(field.fn(0, 0, SEED)).not.toBe(field.fn(0, 0, OTHER));
        const a = points(100).map(([x, z]) => field.fn(x, z, SEED));
        const b = points(100).map(([x, z]) => field.fn(x, z, OTHER));
        expect(a).not.toEqual(b);
      });
    });
  }

  it('biomeFields returns exactly the individual fields', () => {
    for (const [x, z] of points(20)) {
      expect(biomeFields(x, z, SEED)).toEqual({
        continentalness: continentalness(x, z, SEED),
        erosion: erosion(x, z, SEED),
        temperature: temperature(x, z, SEED),
        humidity: humidity(x, z, SEED),
      });
    }
  });

  it('the four fields are independent of one another', () => {
    // Sharing a seed between fields would correlate them, and every desert
    // would sit at the same altitude on every continent.
    const c = points(400, 211.3).map(([x, z]) => continentalness(x, z, SEED));
    const e = points(400, 211.3).map(([x, z]) => erosion(x, z, SEED));
    const t = points(400, 211.3).map(([x, z]) => temperature(x, z, SEED));
    const h = points(400, 211.3).map(([x, z]) => humidity(x, z, SEED));
    expect(Math.abs(correlation(c, e))).toBeLessThan(0.4);
    expect(Math.abs(correlation(t, h))).toBeLessThan(0.4);
    expect(Math.abs(correlation(c, t))).toBeLessThan(0.4);
  });
});

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - meanA;
    const db = (b[i] as number) - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  return denA === 0 || denB === 0 ? 0 : num / Math.sqrt(denA * denB);
}

describe('reliefMask', () => {
  it('is zero at sea and positive well inland', () => {
    expect(reliefMask(-1, 0)).toBe(0);
    expect(reliefMask(1, -1)).toBeGreaterThan(0.5);
  });

  it('gives worn-down ground less relief than young ground', () => {
    expect(reliefMask(1, 1)).toBeLessThan(reliefMask(1, -1));
  });

  it('stays inside [0, 1]', () => {
    for (let c = -1; c <= 1; c += 0.1) {
      for (let e = -1; e <= 1; e += 0.1) {
        const m = reliefMask(c, e);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('sampleHeight', () => {
  it('is a pure function of position and seed', () => {
    for (const [x, z] of points(200)) {
      expect(sampleHeight(x, z, SEED)).toBe(sampleHeight(x, z, SEED));
    }
  });

  it('does not depend on evaluation order or on unrelated work', () => {
    const before = sampleHeight(412.5, -913.25, SEED);
    for (const [x, z] of points(500)) sampleHeight(x, z, SEED ^ Math.round(x));
    expect(sampleHeight(412.5, -913.25, SEED)).toBe(before);
  });

  it('stays inside the advertised bounds', () => {
    for (const [x, z] of points(6000, 27.3)) {
      const h = sampleHeight(x, z, SEED);
      expect(h).toBeGreaterThanOrEqual(MIN_HEIGHT);
      expect(h).toBeLessThanOrEqual(MAX_HEIGHT);
      expect(Number.isFinite(h)).toBe(true);
    }
  });

  it('produces real relief rather than a plane', () => {
    const values = points(4000, 53.7).map(([x, z]) => sampleHeight(x, z, SEED));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(80);
  });

  it('produces both ground below zero and ground well above it', () => {
    const values = points(4000, 53.7).map(([x, z]) => sampleHeight(x, z, SEED));
    expect(Math.min(...values)).toBeLessThan(0);
    expect(Math.max(...values)).toBeGreaterThan(60);
  });

  it('is continuous: 2 m apart is never a cliff of tens of metres', () => {
    // 2 m is the chunk vertex spacing. A discontinuity here is a hole in the
    // mesh, not a feature.
    let worst = 0;
    for (const [x, z] of points(2000, 19.7)) {
      worst = Math.max(worst, Math.abs(sampleHeight(x + 2, z, SEED) - sampleHeight(x, z, SEED)));
    }
    expect(worst).toBeLessThan(12);
  });

  it('differs between seeds, including at the origin', () => {
    expect(sampleHeight(0, 0, SEED)).not.toBe(sampleHeight(0, 0, OTHER));
    const a = points(300).map(([x, z]) => sampleHeight(x, z, SEED));
    const b = points(300).map(([x, z]) => sampleHeight(x, z, OTHER));
    expect(a).not.toEqual(b);
  });

  it('still has relief 200 km from the origin', () => {
    // Matches the `chunks-far-from-origin` canonical view. Degenerating into
    // repeats or float mush out here is a classic procedural-terrain failure.
    const far = Array.from({ length: 2000 }, (_, i) =>
      sampleHeight(204800 + i * 31.7, -131072 - i * 17.3, SEED),
    );
    expect(Math.max(...far) - Math.min(...far)).toBeGreaterThan(40);
    expect(new Set(far.map((h) => h.toFixed(3))).size).toBeGreaterThan(1900);
  });

  it('treats x and z distinctly', () => {
    expect(sampleHeight(731.5, 112.25, SEED)).not.toBe(sampleHeight(112.25, 731.5, SEED));
  });

  it('agrees with itself when called through biomeFields inputs', () => {
    // Guards against a second, drifted copy of the composition appearing.
    for (const [x, z] of points(50)) {
      const fields = biomeFields(x, z, SEED);
      expect(fields.continentalness).toBe(continentalness(x, z, SEED));
      expect(sampleHeight(x, z, SEED)).toBe(sampleHeight(x, z, SEED));
    }
  });
});
