/**
 * The star field, as vertices.
 *
 * Phase 10. Pure: it emits two `Float32Array`s and knows nothing about Three.js.
 * `sky-dome.ts` wraps them in a `THREE.Points`.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE IS HELD TO A STRICTER RULE THAN `celestial.ts`
 *
 * `celestial.ts` may use trig freely, because a sun direction is per-frame
 * render state that never lands in a buffer. THIS module's output IS a vertex
 * buffer, which puts it squarely under the convention that bans `Math.sin`,
 * `cos`, `pow` and `exp` on any path ending in a stored vertex: those are the
 * operations whose last bit is permitted to differ between JavaScript engines,
 * and a one-ulp difference here is a screenshot that fails a byte comparison on
 * someone else's machine.
 *
 * So the directions come from MARSAGLIA'S METHOD, which reaches a uniform point
 * on the unit sphere using nothing but multiplication, subtraction and one
 * `Math.sqrt` -- and `sqrt` is the one non-trivial float operation IEEE 754
 * requires to be correctly rounded, so it is exact everywhere. The obvious
 * alternative (pick a random azimuth and a random `acos` of a random height)
 * needs two transcendentals per star and is the thing being avoided.
 *
 * `star-field.test.ts` asserts the source text of this file contains no `sin`,
 * `cos`, `tan`, `pow`, `exp` or `log`, so the rule is enforced rather than
 * merely documented -- the same technique `world-map.test.ts` uses to prove
 * that file never reaches `sampleHeight`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STARS ARE GENERATED AND NOT AUTHORED
 *
 * A catalogue would be an asset to fetch, and RULE "no runtime asset fetching"
 * rules that out. Generating them from `hash3i` costs nothing, gives the same
 * sky on every machine forever, and means the count is a tuning knob rather
 * than a download.
 */

import { hash3i, rngFromHash } from '../core/hash';

/**
 * How many stars.
 *
 * One `Points` object is one draw call regardless of the count, so this is
 * bounded by how much a 1400-vertex buffer costs to upload (nothing, once) and
 * by how busy the sky should look, not by performance. Below about 800 the sky
 * reads as sparse; above about 3000 it reads as noise.
 */
export const STAR_COUNT = 1400;

/**
 * Seed for the star field.
 *
 * Deliberately NOT the world seed. Two worlds share a sky: the stars are not
 * world content, they are set dressing that has no coordinate, so making them
 * vary per seed would mean 68 baselines that depend on `?seed=` for no gain.
 */
export const STAR_SEED = 0x5741b2;

/**
 * Cap on rejection-sampling attempts per star.
 *
 * Marsaglia rejects a draw when it lands outside the unit disc, which happens
 * with probability `1 - pi/4`, about 21.5%. Sixteen consecutive rejections has
 * probability near 1e-11, so this branch is unreachable in practice -- but an
 * unbounded loop driven by hashed input is a hang waiting for an unlucky seed,
 * and the fallback below keeps the function total.
 */
const MAX_SAMPLE_ATTEMPTS = 16;

export interface StarField {
  /** Unit directions, three floats per star. */
  readonly directions: Float32Array;
  /** Linear RGB, three floats per star. Brightness is baked in. */
  readonly colors: Float32Array;
  readonly count: number;
}

/**
 * Star brightness range.
 *
 * The dim end is not zero: a star that renders as black is a vertex that costs
 * the same as a visible one and shows nothing, so the faintest star is still
 * faintly there. The bright end is below 1 so the brightest star is not the
 * same white as the moon.
 */
const BRIGHTNESS_MIN = 0.18;
const BRIGHTNESS_MAX = 0.92;

/**
 * How far a star's colour may drift from white, toward blue (hot) or amber
 * (cool). Real stellar colours are far more saturated than this reads at one
 * pixel; kept subtle so the sky is not a christmas light display.
 */
const TINT_STRENGTH = 0.16;

/**
 * Build the star field.
 *
 * A pure function of `(count, seed)`. Each star draws from its OWN counter-based
 * stream (`rngFromHash(hash3i(i, 0, 0, seed))`) rather than from one shared
 * sequential stream, so star `i` is the same star regardless of how many were
 * generated before it -- the same discipline RULE 1 imposes on chunk content,
 * and what lets the count change without reshuffling the whole sky.
 */
export function buildStarField(count: number = STAR_COUNT, seed: number = STAR_SEED): StarField {
  const n = Math.max(0, Math.floor(count));
  const directions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const rng = rngFromHash(hash3i(i, 0, 0, seed));

    // Marsaglia (1972): draw (u, v) in the unit disc, then
    //   x = 2u sqrt(1 - s),  y = 2v sqrt(1 - s),  z = 1 - 2s,  s = u^2 + v^2
    // is uniform on the unit sphere. Only sqrt -- see the module header.
    let u = 0;
    let v = 0;
    let s = 1;
    for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
      u = rng.float() * 2 - 1;
      v = rng.float() * 2 - 1;
      s = u * u + v * v;
      if (s > 0 && s < 1) break;
    }
    if (s <= 0 || s >= 1) {
      // Unreachable in practice; keeps the function total for every input.
      u = 0.5;
      v = 0;
      s = 0.25;
    }

    const root = Math.sqrt(1 - s);
    const i3 = i * 3;
    directions[i3] = 2 * u * root;
    directions[i3 + 1] = 1 - 2 * s;
    directions[i3 + 2] = 2 * v * root;

    // Brightness is skewed toward the dim end by squaring: a sky where most
    // stars are faint and a few are bright reads as a sky, and a uniform draw
    // reads as a texture.
    const t = rng.float();
    const brightness = BRIGHTNESS_MIN + (BRIGHTNESS_MAX - BRIGHTNESS_MIN) * t * t;
    const tint = (rng.float() * 2 - 1) * TINT_STRENGTH;

    // Tint by REMOVING from one channel rather than adding to another, so a
    // star's colour never exceeds its own brightness and the range stays in
    // [0, 1]. Positive tint reads blue-white, negative reads amber.
    colors[i3] = brightness * (1 - Math.max(0, tint));
    colors[i3 + 1] = brightness;
    colors[i3 + 2] = brightness * (1 - Math.max(0, -tint));
  }

  return { directions, colors, count: n };
}
