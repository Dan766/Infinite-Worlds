/**
 * Quadtree selection.
 *
 * The properties asserted here are the ones the whole phase rests on: the leaf
 * set covers the view disc exactly once, it gets coarser with distance, and it
 * is a pure function of the camera position rather than of how the camera got
 * there. Each test is written so that it fails on an EMPTY selection too --
 * "no nodes were selected" must never look like a pass.
 */

import { describe, expect, it } from 'vitest';
import { chunkKey, chunkSizeAt, worldToChunk, type ChunkCoord } from './contracts';
import { SEGMENTS } from './chunk-gen';
import { sampleHeight } from './height-field';
import {
  DEFAULT_SPLIT_FACTOR,
  DEFAULT_VIEW_DISTANCE,
  distanceToNode,
  distanceToNodeCenter,
  isDescendantOrSelf,
  lodHistogram,
  nodeChildren,
  nodeParent,
  rootLodFor,
  selectQuadtree,
} from './quadtree';

const OPTIONS = { viewDistance: DEFAULT_VIEW_DISTANCE, splitFactor: DEFAULT_SPLIT_FACTOR };

/** Deterministic sampler, so a failure is reproducible rather than a rumour. */
function* samplePoints(count: number, radius: number): Generator<[number, number]> {
  let state = 0x2f6e2b1 >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const angle = next() * Math.PI * 2;
    // sqrt for a uniform disc rather than a bullseye.
    const r = Math.sqrt(next()) * radius;
    yield [Math.cos(angle) * r, Math.sin(angle) * r];
  }
}

describe('coordinate helpers', () => {
  it('parents and children round-trip, including across the origin', () => {
    for (const coord of [
      { x: 0, z: 0, lod: 0 },
      { x: 7, z: 3, lod: 2 },
      { x: -1, z: -1, lod: 0 },
      { x: -9, z: 14, lod: 4 },
    ]) {
      const parent = nodeParent(coord);
      expect(parent.lod).toBe(coord.lod + 1);
      expect(nodeChildren(parent).map(chunkKey)).toContain(chunkKey(coord));
      // The parent's square really does contain the child's square.
      const size = chunkSizeAt(coord.lod);
      const parentSize = chunkSizeAt(parent.lod);
      expect(coord.x * size).toBeGreaterThanOrEqual(parent.x * parentSize);
      expect((coord.x + 1) * size).toBeLessThanOrEqual((parent.x + 1) * parentSize);
    }
  });

  it('knows containment at any depth, including negative coordinates', () => {
    const root: ChunkCoord = { x: -2, z: 3, lod: 4 };
    let descendant = root;
    for (let i = 0; i < 4; i++) descendant = nodeChildren(descendant)[3];
    expect(isDescendantOrSelf(descendant, root)).toBe(true);
    expect(isDescendantOrSelf(root, root)).toBe(true);
    expect(isDescendantOrSelf(root, descendant)).toBe(false);
    expect(isDescendantOrSelf({ x: 0, z: 0, lod: 0 }, root)).toBe(false);
  });

  it('measures distance to the nearest point of a square, not to its centre', () => {
    const coord: ChunkCoord = { x: 0, z: 0, lod: 0 };
    // Inside the square.
    expect(distanceToNode(32, 32, coord)).toBe(0);
    // 10 m past the +X face.
    expect(distanceToNode(74, 32, coord)).toBeCloseTo(10);
    expect(distanceToNodeCenter(32, 32, coord)).toBe(0);
    expect(distanceToNodeCenter(96, 32, coord)).toBeCloseTo(64);
  });

  it('picks the smallest root that covers the view distance', () => {
    expect(chunkSizeAt(rootLodFor(4096))).toBe(4096);
    expect(chunkSizeAt(rootLodFor(4097))).toBe(8192);
    expect(chunkSizeAt(rootLodFor(64))).toBe(64);
    expect(rootLodFor(1e12)).toBe(10);
  });
});

describe('selectQuadtree', () => {
  it('selects a plausible number of nodes at the 4 km acceptance distance', () => {
    const { leaves, rootLod } = selectQuadtree(0, 0, OPTIONS);
    expect(rootLod).toBe(6);
    // The whole point of the phase: 4 km of terrain for a few hundred nodes.
    // A flat lod-0 disc of the same radius would be ~12,000.
    expect(leaves.length).toBeGreaterThan(150);
    expect(leaves.length).toBeLessThan(600);
  });

  it('covers every point of the view disc exactly once', () => {
    const { leaves } = selectQuadtree(1234.5, -678.25, OPTIONS);
    expect(leaves.length).toBeGreaterThan(0);
    const keys = new Set(leaves.map((leaf) => chunkKey(leaf.coord)));

    let checked = 0;
    for (const [dx, dz] of samplePoints(600, OPTIONS.viewDistance * 0.98)) {
      const x = 1234.5 + dx;
      const z = -678.25 + dz;
      let hits = 0;
      for (let lod = 0; lod <= 6; lod++) {
        if (keys.has(chunkKey(worldToChunk(x, z, lod)))) hits++;
      }
      expect(hits).toBe(1);
      checked++;
    }
    expect(checked).toBe(600);
  });

  it('never selects a node twice, nor a node inside another', () => {
    const { leaves } = selectQuadtree(-2048.5, 512.25, OPTIONS);
    expect(leaves.length).toBeGreaterThan(150);

    const keys = leaves.map((leaf) => chunkKey(leaf.coord));
    expect(new Set(keys).size).toBe(keys.length);

    // A duplicate at a DIFFERENT level would pass the key check above and still
    // be two draw calls painting the same ground, so check nesting too.
    for (const leaf of leaves) {
      let ancestor = leaf.coord;
      for (let lod = leaf.coord.lod; lod < 6; lod++) {
        ancestor = nodeParent(ancestor);
        expect(keys).not.toContain(chunkKey(ancestor));
      }
    }
  });

  it('obeys the split rule at every leaf, in both directions', () => {
    const { leaves, rootLod } = selectQuadtree(300.5, -900.5, OPTIONS);
    expect(leaves.length).toBeGreaterThan(150);

    for (const leaf of leaves) {
      const size = chunkSizeAt(leaf.coord.lod);
      const centre = distanceToNodeCenter(300.5, -900.5, leaf.coord);
      // It is a leaf, so it was NOT split.
      if (leaf.coord.lod > 0) {
        expect(centre).toBeGreaterThanOrEqual(OPTIONS.splitFactor * size);
      }
      // ...and its parent WAS split, or it would never have been reached.
      if (leaf.coord.lod < rootLod) {
        const parent = nodeParent(leaf.coord);
        expect(distanceToNodeCenter(300.5, -900.5, parent)).toBeLessThan(
          OPTIONS.splitFactor * chunkSizeAt(parent.lod),
        );
      }
      // And it is inside the view distance.
      expect(leaf.distance).toBeLessThanOrEqual(OPTIONS.viewDistance);
    }
  });

  it('puts fine levels near the camera and coarse ones far away', () => {
    const { leaves } = selectQuadtree(0, 0, OPTIONS);
    const counts = lodHistogram(leaves, 6);
    // Every level from 0 to 4 is in play at 4 km. Level 5 appears only as a
    // handful of nodes that graze the view circle at a single point, and level
    // 6 -- the roots -- can never be a leaf, because a root is always closer to
    // the camera than `splitFactor` root-widths.
    for (let lod = 0; lod <= 4; lod++) expect(counts[lod]).toBeGreaterThan(0);
    expect(counts[5]).toBeLessThan(10);
    expect(counts[6]).toBe(0);

    // Mean distance must rise strictly with level. This is the property that
    // actually breaks if the split test is inverted, and a histogram alone
    // would not catch that.
    const means: number[] = [];
    for (let lod = 0; lod <= 4; lod++) {
      const atLevel = leaves.filter((leaf) => leaf.coord.lod === lod);
      means.push(atLevel.reduce((sum, leaf) => sum + leaf.distance, 0) / atLevel.length);
    }
    for (let lod = 1; lod <= 4; lod++) {
      expect(means[lod] as number).toBeGreaterThan(means[lod - 1] as number);
    }

    // The nearest node is the finest one, and the ground under the camera is
    // always at full detail.
    expect(leaves[0]?.coord.lod).toBe(0);
    expect(leaves[0]?.distance).toBe(0);
  });

  it('is a pure function of camera position, whatever the call history', () => {
    const here = (): string[] =>
      selectQuadtree(511.75, -63.5, OPTIONS).leaves.map((leaf) => chunkKey(leaf.coord));

    const first = here();
    expect(first.length).toBeGreaterThan(150);

    // Arrive from every direction, at every scale, then come back.
    for (const [x, z] of [
      [0, 0],
      [40000, -40000],
      [511.75 - 1, -63.5],
      [511.75 + 1, -63.5],
      [-1e6, 1e6],
    ] as const) {
      selectQuadtree(x, z, OPTIONS);
    }
    expect(here()).toEqual(first);

    // ...and the ORDER is stable too, because it becomes the worker pool's
    // request order and therefore the order chunks appear on screen.
    expect(here().join('|')).toBe(first.join('|'));
  });

  it('is translation-invariant across a root boundary', () => {
    // A camera at the corner of four roots must not be a special case: the
    // selection is the same shape, just moved. This is what would break if root
    // enumeration were off by one.
    const rootSize = chunkSizeAt(rootLodFor(OPTIONS.viewDistance));
    const a = selectQuadtree(rootSize, rootSize, OPTIONS);
    const b = selectQuadtree(rootSize * 3, rootSize * 3, OPTIONS);
    expect(a.leaves.length).toBe(b.leaves.length);
    expect(lodHistogram(a.leaves, 6)).toEqual(lodHistogram(b.leaves, 6));
  });

  it('trades node count against fidelity through splitFactor', () => {
    const coarse = selectQuadtree(0, 0, { ...OPTIONS, splitFactor: 1.5 });
    const chosen = selectQuadtree(0, 0, OPTIONS);
    const fine = selectQuadtree(0, 0, { ...OPTIONS, splitFactor: 4 });
    expect(coarse.leaves.length).toBeLessThan(chosen.leaves.length);
    expect(chosen.leaves.length).toBeLessThan(fine.leaves.length);
  });

  it('scales the view distance without exploding the node count', () => {
    const near = selectQuadtree(0, 0, { ...OPTIONS, viewDistance: 1024 });
    const far = selectQuadtree(0, 0, { ...OPTIONS, viewDistance: 8192 });
    expect(near.leaves.length).toBeGreaterThan(50);
    // Eight times the radius is 64x the area, but only about twice the nodes.
    // If this ratio ever exceeds 4 the quadtree has stopped doing its job.
    expect(far.leaves.length).toBeLessThan(near.leaves.length * 4);
  });

  it('lists split nodes in preorder, ancestors before descendants', () => {
    const { internal } = selectQuadtree(0, 0, OPTIONS);
    expect(internal.length).toBeGreaterThan(20);
    const indexOf = new Map<string, number>();
    internal.forEach((coord, index) => indexOf.set(chunkKey(coord), index));
    internal.forEach((coord, index) => {
      for (const child of nodeChildren(coord)) {
        const childIndex = indexOf.get(chunkKey(child));
        if (childIndex !== undefined) expect(childIndex).toBeGreaterThan(index);
      }
    });
  });

  it('degrades sanely when the view distance is one chunk', () => {
    const { leaves, rootLod } = selectQuadtree(0, 0, { ...OPTIONS, viewDistance: 64 });
    expect(rootLod).toBe(0);
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) expect(leaf.coord.lod).toBe(0);
  });
});

/**
 * How big is a level switch, in pixels?
 *
 * This is the only honest way to tune `splitFactor`. Popping is handled by
 * threshold placement alone -- no geomorphing, no custom shader, so that Phase
 * 11 is free to replace the material outright -- which means the whole
 * mitigation is "switch where the error is small enough not to notice".
 *
 * The error at a switch is the difference between the terrain and the coarse
 * node's bilinear interpolation of it, since that is literally what the coarse
 * node draws. Converted to pixels at 1080p with the project's 60-degree
 * vertical fov, and measured over five separate places in the world so one
 * gentle valley cannot flatter it.
 *
 * The measured answer -- documented in PROGRESS.md -- is that "about a pixel"
 * is NOT reachable by moving this knob: error falls as 1/splitFactor while node
 * count grows as its square, so a pixel would cost roughly forty times the
 * nodes. The lever that actually governs it is `SEGMENTS`, which is fixed.
 */
describe('screen-space error at a level switch', () => {
  const SEED = 1741772537; // hash of the default 'infinite-world' seed
  const PIXELS_PER_RADIAN = 1080 / (2 * Math.tan((60 * Math.PI) / 360));
  const PLACES = [
    [-3300, 420],
    [-1400, 420],
    [0, 0],
    [2600, -1800],
    [-800, 1400],
  ] as const;

  /**
   * Worst |terrain - parent's bilinear interpolation| over one node, in metres.
   * The parent samples at twice this node's spacing, which is exactly the
   * approximation the camera swaps to when the node merges.
   */
  function worstDeviation(lod: number, originX: number, originZ: number): number {
    const size = chunkSizeAt(lod);
    const step = size / SEGMENTS;
    const coarseStep = step * 2;
    let worst = 0;
    for (let row = 0; row <= SEGMENTS; row++) {
      for (let col = 0; col <= SEGMENTS; col++) {
        const x = originX + col * step;
        const z = originZ + row * step;
        const cx = Math.floor(x / coarseStep) * coarseStep;
        const cz = Math.floor(z / coarseStep) * coarseStep;
        const tx = (x - cx) / coarseStep;
        const tz = (z - cz) / coarseStep;
        const coarse =
          sampleHeight(cx, cz, SEED) * (1 - tx) * (1 - tz) +
          sampleHeight(cx + coarseStep, cz, SEED) * tx * (1 - tz) +
          sampleHeight(cx, cz + coarseStep, SEED) * (1 - tx) * tz +
          sampleHeight(cx + coarseStep, cz + coarseStep, SEED) * tx * tz;
        worst = Math.max(worst, Math.abs(sampleHeight(x, z, SEED) - coarse));
      }
    }
    return worst;
  }

  /** Worst switch error at `lod`, in pixels, for a given splitFactor. */
  function worstPixels(lod: number, splitFactor: number): number {
    const size = chunkSizeAt(lod);
    let worst = 0;
    for (const [px, pz] of PLACES) {
      const originX = Math.floor(px / size) * size;
      const originZ = Math.floor(pz / size) * size;
      worst = Math.max(worst, worstDeviation(lod, originX, originZ));
    }
    return (worst / (splitFactor * size)) * PIXELS_PER_RADIAN;
  }

  it('stays inside the band Phase 2b measured and documented', () => {
    for (let lod = 0; lod <= 4; lod++) {
      const pixels = worstPixels(lod, DEFAULT_SPLIT_FACTOR);
      // Anti-vacuity: a metric reading zero would pass any upper bound.
      expect(pixels).toBeGreaterThan(0.5);
      // Measured 2.1 px at lod 0 rising to 8.0 px at lod 4. If this ever
      // exceeds 12, either the terrain got much rougher or the knob moved, and
      // popping will be obvious on screen.
      expect(pixels).toBeLessThan(12);
    }
  });

  it('shrinks when splitFactor grows, which is why it is the knob', () => {
    for (let lod = 0; lod <= 4; lod++) {
      expect(worstPixels(lod, 4)).toBeLessThan(worstPixels(lod, 2));
    }
  });

  it('is dominated by node size, not by the split threshold', () => {
    // Doubling splitFactor halves the error; the error at lod 4 is nearly four
    // times the error at lod 0 whatever the threshold. That asymmetry is the
    // reason "about a pixel" is not reachable from this knob, and it is worth
    // asserting rather than leaving as a claim in a document.
    expect(worstPixels(4, DEFAULT_SPLIT_FACTOR)).toBeGreaterThan(
      2 * worstPixels(0, DEFAULT_SPLIT_FACTOR),
    );
    expect(worstPixels(0, 5)).toBeGreaterThan(worstPixels(0, 10) * 1.5);
  });
});
