import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildStarField, STAR_COUNT, STAR_SEED } from './star-field';

describe('buildStarField', () => {
  it('emits three floats per star in both buffers', () => {
    const field = buildStarField(64, 1);
    expect(field.count).toBe(64);
    expect(field.directions.length).toBe(64 * 3);
    expect(field.colors.length).toBe(64 * 3);
  });

  it('every direction is a unit vector', () => {
    const field = buildStarField(STAR_COUNT, STAR_SEED);
    for (let i = 0; i < field.count; i++) {
      const x = field.directions[i * 3] as number;
      const y = field.directions[i * 3 + 1] as number;
      const z = field.directions[i * 3 + 2] as number;
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
    }
  });

  it('is deterministic: two builds are byte-identical', () => {
    const a = buildStarField(256, 7);
    const b = buildStarField(256, 7);
    expect(Array.from(a.directions)).toEqual(Array.from(b.directions));
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
  });

  it('a star keeps its identity when the count changes', () => {
    // Each star draws from its own counter-based stream, so growing the field
    // must append rather than reshuffle. This is the same property RULE 1
    // demands of chunk content, applied to the sky.
    const small = buildStarField(32, 7);
    const large = buildStarField(512, 7);
    for (let i = 0; i < small.directions.length; i++) {
      expect(large.directions[i]).toBe(small.directions[i]);
    }
  });

  it('different seeds give different skies', () => {
    const a = buildStarField(128, 1);
    const b = buildStarField(128, 2);
    expect(Array.from(a.directions)).not.toEqual(Array.from(b.directions));
  });

  it('covers the whole sphere rather than one hemisphere', () => {
    const field = buildStarField(STAR_COUNT, STAR_SEED);
    let above = 0;
    let below = 0;
    for (let i = 0; i < field.count; i++) {
      if ((field.directions[i * 3 + 1] as number) > 0) above++;
      else below++;
    }
    // Uniform on the sphere means an even split; allow a generous margin so
    // this asserts "not one-sided" rather than re-testing the RNG.
    expect(above).toBeGreaterThan(field.count * 0.4);
    expect(below).toBeGreaterThan(field.count * 0.4);
  });

  it('distributes stars over all four horizontal quadrants', () => {
    const field = buildStarField(STAR_COUNT, STAR_SEED);
    const quadrants = [0, 0, 0, 0];
    for (let i = 0; i < field.count; i++) {
      const x = field.directions[i * 3] as number;
      const z = field.directions[i * 3 + 2] as number;
      const q = (x >= 0 ? 0 : 1) + (z >= 0 ? 0 : 2);
      quadrants[q] = (quadrants[q] as number) + 1;
    }
    for (const n of quadrants) expect(n).toBeGreaterThan(field.count * 0.15);
  });

  it('every colour channel is a visible value in [0, 1]', () => {
    const field = buildStarField(STAR_COUNT, STAR_SEED);
    for (let i = 0; i < field.colors.length; i++) {
      const c = field.colors[i] as number;
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('handles degenerate counts without throwing', () => {
    expect(buildStarField(0, 1).count).toBe(0);
    expect(buildStarField(-5, 1).count).toBe(0);
    expect(buildStarField(1.9, 1).count).toBe(1);
  });
});

/**
 * The star buffer is stored geometry, so it falls under the convention banning
 * transcendentals on any path that ends in a vertex -- those are the operations
 * whose last bit may differ between JavaScript engines, and a one-ulp
 * difference here is a screenshot that fails a byte comparison on somebody
 * else's machine. `buildStarField` reaches a uniform point on the sphere with
 * Marsaglia's method, which needs only `sqrt`, and `sqrt` is the one non-trivial
 * float operation IEEE 754 requires to be correctly rounded.
 *
 * Asserting the source text is the only way to keep that true: a future edit
 * that reaches for `Math.cos` would pass every numeric test above and quietly
 * make the sky machine-dependent. Same technique as `world-map.test.ts`'s
 * assertion that the file never mentions `sampleHeight`.
 */
describe('the source obeys the no-transcendentals rule', () => {
  // Comments are stripped first, so this is a claim about the CODE. The module
  // header necessarily names the banned calls in order to explain the rule, and
  // a check that could not tell prose from a call site would either fail on
  // that explanation or force the explanation to be deleted.
  const source = readFileSync(new URL('./star-field.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it.each([
    'Math.sin',
    'Math.cos',
    'Math.tan',
    'Math.asin',
    'Math.acos',
    'Math.atan',
    'Math.atan2',
    'Math.pow',
    'Math.exp',
    'Math.log',
    'Math.cbrt',
    'Math.hypot',
  ])('does not call %s', (banned) => {
    expect(source).not.toContain(banned);
  });

  it('does not use the ** exponent operator', () => {
    // Operand-shaped, so a JSDoc opener is not mistaken for an exponent.
    expect(source).not.toMatch(/[\w)\]]\s*\*\*\s*[\w(]/);
  });

  it('does use Math.sqrt, so the test above is not vacuous', () => {
    expect(source).toContain('Math.sqrt');
  });
});
