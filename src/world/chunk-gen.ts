/**
 * Chunk generation. Pure, synchronous, and free of Three.js and the DOM, so the
 * same code runs inside the Web Worker and inside a Node unit test.
 *
 * Phase 1 deliberately generates nothing but a flat coloured quad. The point of
 * this phase is the streaming machinery, and a generator with no interesting
 * output makes it obvious when a bug is in the plumbing rather than the terrain.
 * Phase 2 replaces the body of `generateChunk` with a heightfield; its signature
 * and the `ChunkData` layout are meant to survive that.
 *
 * RULE 1: the only inputs are the coordinate and `TierContext`. No clock, no
 * counters, no ambient state.
 */

import { rngAt2i } from '../core/hash';
import {
  CHUNK_DATA_VERSION,
  CHUNK_SIZE,
  type ChunkCoord,
  type ChunkData,
  type TierContext,
} from './contracts';

/**
 * Convert HSL to RGB. Hand-rolled rather than borrowed from Three.js because
 * this module must stay importable from a worker and from Node.
 *
 * Inputs and outputs are in [0, 1].
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) return [l, l, l];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const channel = (t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

/**
 * The flat colour of a chunk: a pure function of `(worldSeed, coord)`.
 *
 * Hue is unconstrained so neighbouring chunks are obviously distinct -- the
 * whole point is that a screenshot shows at a glance whether the same chunk
 * came back the same after being unloaded. Saturation and lightness are kept in
 * a narrow band so the result is a readable patchwork rather than noise.
 */
export function chunkColor(coord: ChunkCoord, worldSeed: number): [number, number, number] {
  const rng = rngAt2i(coord.x, coord.z, worldSeed);
  const hue = rng.float();
  const saturation = 0.35 + rng.float() * 0.3;
  const lightness = 0.32 + rng.float() * 0.26;
  return hslToRgb(hue, saturation, lightness);
}

/**
 * Vertices per chunk edge, minus one. Phase 1 needs a single quad; the code is
 * written as a grid so Phase 2 can raise this without restructuring anything.
 */
const SEGMENTS = 1;

/**
 * Generate one chunk.
 *
 * Positions are chunk-local (0..CHUNK_SIZE on x and z) so the mesh can be
 * placed by translating its parent object, which keeps float precision usable
 * far from the origin.
 */
export function generateChunk(coord: ChunkCoord, context: TierContext): ChunkData {
  if (context.tier !== 'chunk') {
    throw new Error(`generateChunk needs a 'chunk' TierContext, got '${context.tier}'`);
  }

  const side = SEGMENTS + 1;
  const positions = new Float32Array(side * side * 3);
  const indices = new Uint32Array(SEGMENTS * SEGMENTS * 6);

  const step = CHUNK_SIZE / SEGMENTS;

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const at = (row * side + col) * 3;
      positions[at] = col * step;
      positions[at + 1] = 0;
      positions[at + 2] = row * step;
    }
  }

  let write = 0;
  for (let row = 0; row < SEGMENTS; row++) {
    for (let col = 0; col < SEGMENTS; col++) {
      const a = row * side + col;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      // Counter-clockwise when viewed from +Y, so the surface faces up.
      indices[write++] = a;
      indices[write++] = c;
      indices[write++] = b;
      indices[write++] = b;
      indices[write++] = c;
      indices[write++] = d;
    }
  }

  return {
    version: CHUNK_DATA_VERSION,
    coord: { x: coord.x, z: coord.z },
    worldSeed: context.worldSeed,
    positions,
    indices,
    color: chunkColor(coord, context.worldSeed),
    minY: 0,
    maxY: 0,
  };
}
