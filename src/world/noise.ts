/**
 * Coherent noise primitives for world generation.
 *
 * Pure, synchronous, and free of Three.js and the DOM, so the same code runs
 * inside a Web Worker and inside a Node unit test. Everything here is built on
 * `hash2i` from `src/core/hash.ts`, which means RULE 1 holds by construction:
 * the value at a point is a function of `(seed, x, z)` and of nothing else --
 * no lattice cache, no permutation table built at start-up, no call counter.
 *
 * DETERMINISM AND FLOATING POINT
 *
 * ECMAScript only *approximates* `Math.pow`, `Math.sin`, `Math.cos` and friends:
 * two engines are permitted to disagree in the last bits. Anything on the path
 * to a stored vertex therefore uses exact IEEE-754 operations only -- `+`, `-`,
 * `*`, `/`, `Math.abs`, `Math.floor`, `Math.min`, `Math.max`, `Math.sqrt` (which
 * IS correctly rounded by the standard) and the spec-mandated constants
 * `Math.SQRT2` / `Math.SQRT1_2`. That is why the gradient table below is eight
 * fixed directions rather than `cos(h)` / `sin(h)` of a hashed angle: the cheap
 * version would be a cross-engine determinism bug waiting to happen.
 *
 * Integer inputs to `hash2i` are truncated to int32, so lattice coordinates must
 * stay inside +/-2^31. At the frequencies the height field uses (the highest is
 * 1/100 m) that is 200 billion metres of usable world, which is plenty.
 */

import { hash2i, hashCombine } from '../core/hash';

// ---------------------------------------------------------------------------
// Gradient noise
// ---------------------------------------------------------------------------

/**
 * Eight unit gradients: four axis-aligned, four diagonal.
 *
 * `Math.SQRT1_2` is a spec-mandated constant (the double nearest 1/sqrt(2)), so
 * every entry is bit-identical on every engine. Eight directions is the classic
 * Perlin 2D set; it is enough to hide the lattice once several octaves and a
 * domain warp are stacked on top.
 */
const D = Math.SQRT1_2;
const GRAD_X = [1, -1, 0, 0, D, -D, D, -D] as const;
const GRAD_Z = [0, 0, 1, -1, D, D, -D, -D] as const;

/** Quintic fade: zero first and second derivatives at both ends, so octaves do not crease. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradDot(ix: number, iz: number, dx: number, dz: number, seed: number): number {
  const g = hash2i(ix, iz, seed) & 7;
  // `as number` rather than `!`: noUncheckedIndexedAccess is on and the mask
  // already guarantees the index is in range.
  return (GRAD_X[g] as number) * dx + (GRAD_Z[g] as number) * dz;
}

/**
 * Perlin-style gradient noise in approximately [-1, 1].
 *
 * The theoretical extreme of 2D gradient noise with unit gradients is
 * `sqrt(2)/2`, so the result is scaled by `Math.SQRT2` to fill [-1, 1] without
 * ever exceeding it.
 */
export function gradientNoise2(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;

  const n00 = gradDot(x0, z0, fx, fz, seed);
  const n10 = gradDot(x0 + 1, z0, fx - 1, fz, seed);
  const n01 = gradDot(x0, z0 + 1, fx, fz - 1, seed);
  const n11 = gradDot(x0 + 1, z0 + 1, fx - 1, fz - 1, seed);

  const u = fade(fx);
  const v = fade(fz);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * Math.SQRT2;
}

// ---------------------------------------------------------------------------
// Fractal stacks
// ---------------------------------------------------------------------------

/**
 * The fractal functions take positional parameters rather than an options
 * object on purpose. They are called five or six times per height sample, and a
 * height sample happens ~1200 times per chunk and millions of times over a soak
 * run; an options literal per call is a few million short-lived objects for the
 * young generation to sweep, which shows up as GC spikes in exactly the frame
 * budget this project is trying to hold.
 *
 * @param octaves     how many octaves to sum; detail scales linearly with cost
 * @param frequency   cycles per metre of the first octave
 * @param lacunarity  frequency multiplier between octaves
 * @param gain        amplitude multiplier between octaves
 */

/**
 * Each octave gets its own seed rather than sampling one noise field at
 * different scales. Sharing a seed makes octaves line up at the lattice points
 * they have in common, which shows up as a faint grid in the terrain.
 */
function octaveSeed(seed: number, octave: number): number {
  return hashCombine(seed >>> 0, octave);
}

/**
 * Fractional Brownian motion: summed octaves, normalised to [-1, 1].
 *
 * The normalisation by total amplitude is what makes the range independent of
 * the octave count, so tuning detail does not silently rescale the terrain.
 */
export function fbm2(
  x: number,
  z: number,
  seed: number,
  octaves = 4,
  frequency = 1,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let norm = 0;
  let amplitude = 1;
  let freq = frequency;

  for (let octave = 0; octave < octaves; octave++) {
    sum += gradientNoise2(x * freq, z * freq, octaveSeed(seed, octave)) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    freq *= lacunarity;
  }

  return norm === 0 ? 0 : sum / norm;
}

/**
 * Ridged multifractal in [0, 1]. This is what makes mountains look like
 * mountains rather than like lumpy hills.
 *
 * `1 - |noise|` folds the field about zero, turning the smooth minima of fBm
 * into sharp creases; squaring sharpens them further. The running `weight`
 * suppresses fine detail in the valleys, which is the "multifractal" part: high
 * ground gets rugged, low ground stays smooth, exactly as erosion leaves it.
 */
export function ridged2(
  x: number,
  z: number,
  seed: number,
  octaves = 4,
  frequency = 1,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let norm = 0;
  let amplitude = 1;
  let freq = frequency;
  let weight = 1;

  for (let octave = 0; octave < octaves; octave++) {
    let signal = 1 - Math.abs(gradientNoise2(x * freq, z * freq, octaveSeed(seed, octave)));
    signal *= signal;
    signal *= weight;
    // Clamped so an octave can never amplify the next one past the [0,1] range.
    weight = Math.min(1, Math.max(0, signal * 2));

    sum += signal * amplitude;
    norm += amplitude;
    amplitude *= gain;
    freq *= lacunarity;
  }

  return norm === 0 ? 0 : Math.min(1, Math.max(0, sum / norm));
}

// ---------------------------------------------------------------------------
// Domain warp
// ---------------------------------------------------------------------------

export interface Warped {
  readonly x: number;
  readonly z: number;
}

/**
 * Push the sample point around with another noise field before evaluating.
 *
 * This is the single cheapest way to stop fBm reading as "noise mush": it bends
 * the isolines so coastlines meander and ridges curve instead of running in
 * statistically straight lines. Two independent offset fields, one per axis.
 *
 * `amplitude` is in metres, `frequency` in cycles per metre.
 */
export function warp2(
  x: number,
  z: number,
  seed: number,
  amplitude: number,
  frequency: number,
  octaves = 2,
): Warped {
  const seedX = hashCombine(seed >>> 0, 0x5741_5250);
  const seedZ = hashCombine(seed >>> 0, 0x5a57_5250);
  return {
    x: x + fbm2(x, z, seedX, octaves, frequency) * amplitude,
    z: z + fbm2(x, z, seedZ, octaves, frequency) * amplitude,
  };
}

/** Map a uint32 hash into [0, 1). Never reaches 1. */
export function hashUnit(hash: number): number {
  return (hash >>> 0) * (1 / 4294967296);
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------

/** Clamp to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Hermite step from 0 at `edge0` to 1 at `edge1`. Flat outside the band. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Linear interpolation. Exact at both ends. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map a value in [-1, 1] onto [0, 1]. */
export function unitToZeroOne(value: number): number {
  return clamp(value * 0.5 + 0.5, 0, 1);
}
