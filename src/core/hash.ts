/**
 * Counter-based integer hashing.
 *
 * ARCHITECTURAL RULE 1 (determinism): every piece of world content must be a
 * pure function of `(worldSeed, coordinate)`. That rules out any sequential
 * PRNG whose internal state depends on how many times it was called earlier in
 * the program, because chunks get generated in whatever order the camera
 * happens to visit them.
 *
 * Everything here is therefore stateless: a hash takes coordinates in and
 * returns a uint32 out. `rngFromHash` looks stateful but its only state is a
 * private counter that starts at zero, so two streams built from the same hash
 * always produce the same sequence regardless of what else the program did.
 *
 * All arithmetic is uint32. `Math.imul` gives us exact 32-bit multiplication
 * (plain `*` would silently lose precision past 2^53) and every step ends in
 * `>>> 0` to stay unsigned.
 */

/** Odd primes, one per coordinate axis, so axes cannot alias each other. */
const PRIME_X = 0x27d4eb2d;
const PRIME_Y = 0x165667b1;
const PRIME_Z = 0x9e3779b1;
const PRIME_W = 0x85ebca6b;

/**
 * 32-bit avalanche finalizer (the "lowbias32" constants). A single bit flip in
 * the input changes roughly half the output bits, which is what stops
 * neighbouring chunk coordinates from producing visibly correlated worlds.
 */
export function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Fold one more integer into an accumulated hash. Order-dependent by design. */
export function hashCombine(acc: number, value: number): number {
  return mix32((acc ^ Math.imul(value | 0, PRIME_W)) >>> 0);
}

/** Hash a 2D integer coordinate. Inputs are truncated to int32. */
export function hash2i(x: number, y: number, seed = 0): number {
  let h = seed >>> 0;
  h = mix32((h ^ Math.imul(x | 0, PRIME_X)) >>> 0);
  h = mix32((h ^ Math.imul(y | 0, PRIME_Y)) >>> 0);
  return h;
}

/** Hash a 3D integer coordinate. Inputs are truncated to int32. */
export function hash3i(x: number, y: number, z: number, seed = 0): number {
  let h = seed >>> 0;
  h = mix32((h ^ Math.imul(x | 0, PRIME_X)) >>> 0);
  h = mix32((h ^ Math.imul(y | 0, PRIME_Y)) >>> 0);
  h = mix32((h ^ Math.imul(z | 0, PRIME_Z)) >>> 0);
  return h;
}

/**
 * Turn a human-readable seed string into a uint32 world seed, so `?seed=hello`
 * and `?seed=1234` both work.
 */
export function hashString(text: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = hashCombine(h, text.charCodeAt(i));
  }
  return h;
}

/**
 * A deterministic random stream derived from a hash.
 *
 * The stream's only state is `counter`, which starts at 0 for every stream, so
 * `rngFromHash(h)` called anywhere at any time yields the same values.
 */
export interface Rng {
  /** Next value in [0, 2^32). */
  nextU32(): number;
  /** Next value in [0, 1). */
  float(): number;
  /** Next value in [min, max). */
  range(min: number, max: number): number;
  /** Next integer in [0, maxExclusive). Returns 0 when maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** True with the given probability in [0, 1]. */
  chance(probability: number): boolean;
  /** How many values have been drawn. Useful when debugging determinism bugs. */
  readonly drawn: number;
}

/** 1 / 2^32, for mapping a uint32 into [0, 1) without ever reaching 1. */
const INV_U32 = 1 / 4294967296;

export function rngFromHash(hash: number): Rng {
  const base = hash >>> 0;
  let counter = 0;

  const nextU32 = (): number => mix32((base ^ Math.imul(counter++ | 0, PRIME_Z)) >>> 0);
  const float = (): number => nextU32() * INV_U32;

  return {
    nextU32,
    float,
    range: (min, max) => min + float() * (max - min),
    int: (maxExclusive) => (maxExclusive > 0 ? Math.floor(float() * maxExclusive) : 0),
    chance: (probability) => float() < probability,
    get drawn() {
      return counter;
    },
  };
}

/** Convenience: a stream for a 2D coordinate. */
export function rngAt2i(x: number, y: number, seed = 0): Rng {
  return rngFromHash(hash2i(x, y, seed));
}

/** Convenience: a stream for a 3D coordinate. */
export function rngAt3i(x: number, y: number, z: number, seed = 0): Rng {
  return rngFromHash(hash3i(x, y, z, seed));
}
