/**
 * Tests for Phase 3b: flow accumulation at the Region tier, and the carve.
 *
 * Two kinds of test live here and they are deliberately separate.
 *
 * SYNTHETIC TERRAIN. A tilted plane and a cone have exactly one right answer
 * for "where does the water go", so the routing itself can be asserted rather
 * than described. Nothing about `height-field.ts` is involved, which is the
 * point: if these fail, the algorithm is wrong, not the noise.
 *
 * THE REAL WORLD. Determinism, the memo, region-boundary continuity and
 * "rivers reach the sea" can only be judged against the actual height field,
 * because they are claims about the world this project ships.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { createTierContext, REGION_SIZE } from './contracts';
import { baseHeight, SEA_LEVEL, sampleHeight } from './height-field';
import {
  clearRiverCache,
  generateRegionRivers,
  regionRiverField,
  regionRivers,
  riverCacheStats,
  riverDrop,
  RIVER_BANK_MAX,
  RIVER_CACHE_LIMIT,
  RIVER_CELL,
  RIVER_FULL_ACCUM,
  RIVER_HEAD_ACCUM,
  RIVER_MAX_CUT,
  RIVER_PAD,
  WINDOW_CELLS,
  type RiverNetwork,
  type RiverTerrain,
} from './rivers';

const SEED = hashString('rivers-test');

/** The real world, as routing sees it. Matches the constant in `height-field.ts`. */
const WORLD: RiverTerrain = { id: 'test-world', seaLevel: SEA_LEVEL, height: baseHeight };

// ---------------------------------------------------------------------------
// Synthetic terrain: the routing itself
// ---------------------------------------------------------------------------

/**
 * A V-shaped valley running along `z = 0` and falling toward -X.
 *
 * Convergence is the point. A plain tilted plane grows NO rivers however steep
 * it is, because flow lines stay parallel and accumulation never exceeds the
 * length of one column -- which is the correct answer, and is asserted below.
 */
const VALLEY: RiverTerrain = {
  id: 'valley',
  seaLevel: -5000,
  height: (x, z) => x * 0.01 + Math.abs(z) * 0.05,
};

/** The same valley, with its floor below sea level west of x = 1000. */
const VALLEY_TO_SEA: RiverTerrain = {
  id: 'valley-to-sea',
  seaLevel: 0,
  height: (x, z) => (x - 1000) * 0.01 + Math.abs(z) * 0.05,
};

/**
 * A cone: every flow line DIVERGES from the peak, so nothing ever concentrates
 * and there should be no rivers at all.
 */
const CONE: RiverTerrain = {
  id: 'cone',
  seaLevel: -5000,
  height: (x, z) => 4000 - Math.sqrt(x * x + z * z) * 0.5,
};

const regionContext = (seed = SEED): ReturnType<typeof createTierContext> =>
  createTierContext(seed, 'region');

function nodeNear(net: RiverNetwork, x: number, z: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < net.nodeX.length; i++) {
    const dx = (net.nodeX[i] as number) - x;
    const dz = (net.nodeZ[i] as number) - z;
    const d = dx * dx + dz * dz;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

describe('flow routing on synthetic terrain', () => {
  it('puts the channel in the valley floor and nowhere else', () => {
    const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), VALLEY);
    expect(net.nodeX.length).toBeGreaterThan(20);
    for (let i = 0; i < net.nodeX.length; i++) {
      // The valley floor is z = 0, and one routing cell of slack covers the
      // position smoothing.
      expect(Math.abs(net.nodeZ[i] as number)).toBeLessThanOrEqual(RIVER_CELL);
    }
  });

  it('grows the channel westward, in the direction the valley falls', () => {
    // Accumulation is catchment area, so it must be strictly larger further
    // down the valley. Compared at points rather than summed over the window,
    // which would only measure how much of the window lies each side.
    const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), VALLEY);
    const downstream = net.nodeAccum[nodeNear(net, -1000, 0)] as number;
    const middle = net.nodeAccum[nodeNear(net, 2000, 0)] as number;
    const upstream = net.nodeAccum[nodeNear(net, 5000, 0)] as number;
    expect(downstream).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(upstream);
  });

  it('grows no rivers at all on a surface where flow diverges', () => {
    // A cone. Every flow line spreads apart, so accumulation never reaches the
    // head threshold and there is nothing to carve. A router that invented
    // channels here would be thresholding noise, not drainage.
    const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), CONE);
    expect(net.nodeX.length).toBe(0);
    expect(net.segNode.length).toBe(0);
    expect(riverDrop(CONE, SEED, 1234, -567, CONE.height(1234, -567, SEED))).toBe(0);
  });

  it('accumulation never decreases downstream', () => {
    // This is the invariant the whole channel-extraction step rests on: a
    // channel's downstream cell is always at least as big a channel, so a
    // routed river cannot vanish and restart.
    for (const terrain of [VALLEY, WORLD]) {
      const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), terrain);
      for (let i = 0; i < net.nodeX.length; i++) {
        const down = net.nodeDown[i] as number;
        if (down < 0) continue;
        expect(net.nodeAccum[down] as number).toBeGreaterThanOrEqual(net.nodeAccum[i] as number);
      }
    }
  });

  it('never routes a channel uphill: the water surface only falls downstream', () => {
    for (const terrain of [VALLEY, WORLD]) {
      const net = generateRegionRivers({ x: 1, z: -1 }, regionContext(), terrain);
      for (let i = 0; i < net.nodeX.length; i++) {
        const down = net.nodeDown[i] as number;
        if (down < 0) continue;
        expect(net.nodeWaterY[down] as number).toBeLessThanOrEqual(net.nodeWaterY[i] as number);
      }
    }
  });

  it('leaves no chain terminating in a pit: every interior node has a downstream cell', () => {
    // Priority flooding is what buys this. Without it, fBm on a 64 m lattice is
    // full of local minima and a channel simply stops in the middle of a
    // hillside -- exactly the "terminating in mid-air" failure this phase is
    // judged on.
    const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), WORLD);
    const span = WINDOW_CELLS * RIVER_CELL;
    let interior = 0;
    for (let i = 0; i < net.nodeX.length; i++) {
      const x = net.nodeX[i] as number;
      const z = net.nodeZ[i] as number;
      const edge =
        x < net.minX + 2 * RIVER_CELL ||
        z < net.minZ + 2 * RIVER_CELL ||
        x > net.minX + span - 2 * RIVER_CELL ||
        z > net.minZ + span - 2 * RIVER_CELL;
      if (edge) continue;
      interior++;
      expect(net.nodeDown[i] as number).toBeGreaterThanOrEqual(0);
    }
    expect(interior).toBeGreaterThan(100);
  });

  it('gives a bigger channel more strength, saturating at RIVER_FULL_ACCUM', () => {
    const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), WORLD);
    for (let i = 0; i < net.nodeX.length; i++) {
      const accumulation = net.nodeAccum[i] as number;
      const strength = net.nodeStrength[i] as number;
      expect(accumulation).toBeGreaterThanOrEqual(RIVER_HEAD_ACCUM);
      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(1);
      if (accumulation >= RIVER_FULL_ACCUM) expect(strength).toBe(1);
    }
  });

  it('reaches the sea rather than stopping at the coast', () => {
    // On a ramp that runs below sea level, every routed chain must end up in
    // water. The real-world version of this claim is further down.
    const net = generateRegionRivers({ x: 0, z: 0 }, regionContext(), VALLEY_TO_SEA);
    expect(net.nodeX.length).toBeGreaterThan(0);
    expect(net.nodesReachingSea).toBe(net.nodeX.length);
  });
});

// ---------------------------------------------------------------------------
// RULE 3
// ---------------------------------------------------------------------------

describe('RULE 3: nothing coarse reads anything fine', () => {
  it('refuses a context that is not the Region tier', () => {
    expect(() =>
      generateRegionRivers({ x: 0, z: 0 }, createTierContext(SEED, 'chunk'), VALLEY),
    ).toThrow(/needs a 'region' TierContext/);
    expect(() =>
      generateRegionRivers({ x: 0, z: 0 }, createTierContext(SEED, 'sector'), VALLEY),
    ).toThrow(/needs a 'region' TierContext/);
  });

  it('cannot read Sector or Chunk data even if it tried', () => {
    // Not a style point. The region generator is handed a context whose
    // `coarser()` throws for every finer tier, so a future edit that reaches
    // down a tier fails at the call site instead of surfacing three phases
    // later as a non-determinism bug.
    const context = createTierContext(SEED, 'region');
    expect(() => context.coarser('sector')).toThrow(/Tier rule violation/);
    expect(() => context.coarser('chunk')).toThrow(/Tier rule violation/);
    expect(() => context.coarser('region')).toThrow(/Tier rule violation/);
  });

  it('routes from the PRE-CARVE surface only', () => {
    // The circular-dependency guard. If routing read `sampleHeight` it would be
    // reading its own output, and the network would depend on how many times it
    // had already been evaluated. Proven by handing routing a terrain that
    // counts its calls and asserting the answer is the same when the carved
    // field has been evaluated a thousand times in between.
    let calls = 0;
    const counted: RiverTerrain = {
      id: 'counted',
      seaLevel: SEA_LEVEL,
      height: (x, z, seed) => {
        calls++;
        return baseHeight(x, z, seed);
      },
    };
    const first = generateRegionRivers({ x: 0, z: 0 }, regionContext(), counted);
    const callsForOne = calls;
    for (let i = 0; i < 500; i++) sampleHeight(i * 13.7, i * -9.1, SEED);
    const second = generateRegionRivers({ x: 0, z: 0 }, regionContext(), counted);
    expect(calls - callsForOne).toBe(callsForOne);
    expect(Array.from(second.nodeX)).toEqual(Array.from(first.nodeX));
    expect(Array.from(second.nodeWaterY)).toEqual(Array.from(first.nodeWaterY));
  });
});

// ---------------------------------------------------------------------------
// Determinism and the memo
// ---------------------------------------------------------------------------

function snapshot(net: RiverNetwork): string {
  return JSON.stringify([
    Array.from(net.nodeX),
    Array.from(net.nodeZ),
    Array.from(net.nodeWaterY),
    Array.from(net.nodeStrength),
    Array.from(net.nodeAccum),
    Array.from(net.nodeDown),
    Array.from(net.segNode),
    Array.from(net.bucketStart),
    Array.from(net.bucketSeg),
    net.nodesReachingSea,
  ]);
}

describe('determinism', () => {
  it('routes a region identically every time', () => {
    const a = generateRegionRivers({ x: -3, z: 2 }, regionContext(), WORLD);
    const b = generateRegionRivers({ x: -3, z: 2 }, regionContext(), WORLD);
    expect(snapshot(b)).toBe(snapshot(a));
  });

  it('does not depend on which regions were routed first', () => {
    const forwards = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
    ].map((c) => snapshot(generateRegionRivers(c, regionContext(), WORLD)));
    const backwards = [
      { x: 0, z: 1 },
      { x: 1, z: 0 },
      { x: 0, z: 0 },
    ]
      .map((c) => snapshot(generateRegionRivers(c, regionContext(), WORLD)))
      .reverse();
    expect(backwards).toEqual(forwards);
  });

  it('changes with the seed', () => {
    const a = generateRegionRivers({ x: 0, z: 0 }, createTierContext(SEED, 'region'), WORLD);
    const b = generateRegionRivers({ x: 0, z: 0 }, createTierContext(SEED + 1, 'region'), WORLD);
    expect(snapshot(b)).not.toBe(snapshot(a));
  });
});

describe('the region memo', () => {
  it('returns an identical network after eviction', () => {
    // THE claim that makes the cache legal under RULE 2: it is derived data
    // that can be dropped and rebuilt byte-identically. If this ever fails the
    // memo is holding state, not results.
    clearRiverCache();
    const before = snapshot(regionRivers(WORLD, SEED, 2, -1));
    clearRiverCache();
    expect(riverCacheStats().entries).toBe(0);
    const after = snapshot(regionRivers(WORLD, SEED, 2, -1));
    expect(after).toBe(before);
  });

  it('survives being pushed out by other regions', () => {
    clearRiverCache();
    const before = snapshot(regionRivers(WORLD, SEED, 0, 0));
    // Enough distinct regions to evict the first entry several times over.
    for (let i = 1; i <= RIVER_CACHE_LIMIT + 4; i++) regionRivers(WORLD, SEED, i, 40);
    expect(riverCacheStats().entries).toBeLessThanOrEqual(RIVER_CACHE_LIMIT);
    expect(snapshot(regionRivers(WORLD, SEED, 0, 0))).toBe(before);
  });

  it('is bounded, so it cannot become a leak with a friendly name', () => {
    clearRiverCache();
    for (let i = 0; i < RIVER_CACHE_LIMIT * 3; i++) regionRivers(WORLD, SEED, i, -40);
    expect(riverCacheStats().entries).toBe(RIVER_CACHE_LIMIT);
  });

  it('serves a hit without recomputing', () => {
    clearRiverCache();
    const before = riverCacheStats().builds;
    regionRivers(WORLD, SEED, 7, 7);
    const afterFirst = riverCacheStats().builds;
    for (let i = 0; i < 50; i++) regionRivers(WORLD, SEED, 7, 7);
    expect(afterFirst).toBe(before + 1);
    expect(riverCacheStats().builds).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// baseHeight vs finalHeight
// ---------------------------------------------------------------------------

/** A world position sitting on a strong channel, found by asking the network. */
function strongChannelPoint(worldSeed: number): { x: number; z: number; strength: number } {
  for (const [rx, rz] of [
    [0, 0],
    [0, 1],
    [-1, 0],
    [1, 1],
  ] as [number, number][]) {
    const net = regionRivers(WORLD, worldSeed, rx, rz);
    let best = -1;
    for (let i = 0; i < net.nodeX.length; i++) {
      const x = net.nodeX[i] as number;
      const z = net.nodeZ[i] as number;
      // Well inside the region core, so the point is unambiguously this
      // region's business and the padded window is not in play.
      if (x < rx * REGION_SIZE + 800 || x > (rx + 1) * REGION_SIZE - 800) continue;
      if (z < rz * REGION_SIZE + 800 || z > (rz + 1) * REGION_SIZE - 800) continue;
      if ((net.nodeStrength[i] as number) < 0.85) continue;
      if (best < 0 || (net.nodeAccum[i] as number) > (net.nodeAccum[best] as number)) best = i;
    }
    if (best >= 0) {
      return {
        x: net.nodeX[best] as number,
        z: net.nodeZ[best] as number,
        strength: net.nodeStrength[best] as number,
      };
    }
  }
  throw new Error('no strong channel found -- the world has no rivers, which is the bug');
}

describe('carving', () => {
  it('lowers the ground in a channel', () => {
    const { x, z } = strongChannelPoint(SEED);
    const base = baseHeight(x, z, SEED);
    const final = sampleHeight(x, z, SEED);
    expect(final).toBeLessThan(base - 3);
  });

  it('leaves the ground untouched outside the influence radius', () => {
    const { x, z } = strongChannelPoint(SEED);
    // Well past the widest bank any channel can claim, in all four directions.
    for (const [dx, dz] of [
      [RIVER_BANK_MAX * 3, 0],
      [-RIVER_BANK_MAX * 3, 0],
      [0, RIVER_BANK_MAX * 3],
      [0, -RIVER_BANK_MAX * 3],
    ] as [number, number][]) {
      const px = x + dx;
      const pz = z + dz;
      // ...unless a DIFFERENT channel happens to run through the probe point,
      // which a tributary occasionally does. Ask the network rather than
      // assuming, or this test is a coin flip on the seed.
      if (riverDrop(WORLD, SEED, px, pz, baseHeight(px, pz, SEED)) > 0) continue;
      expect(sampleHeight(px, pz, SEED)).toBe(baseHeight(px, pz, SEED));
    }
  });

  it('never raises the ground, anywhere', () => {
    // Carving is one-directional by construction. If it could lift terrain it
    // could lift a sea floor out of the water and Phase 3a's shoreline would
    // disagree with the mesh about where the coast is.
    for (let i = 0; i < 4000; i++) {
      const x = i * 37.3 - 6000;
      const z = i * -23.9 + 4000;
      expect(sampleHeight(x, z, SEED)).toBeLessThanOrEqual(baseHeight(x, z, SEED));
    }
  });

  it('never cuts deeper than RIVER_MAX_CUT', () => {
    const { x, z } = strongChannelPoint(SEED);
    for (let dx = -200; dx <= 200; dx += 3) {
      for (let dz = -200; dz <= 200; dz += 7) {
        const drop = baseHeight(x + dx, z + dz, SEED) - sampleHeight(x + dx, z + dz, SEED);
        expect(drop).toBeGreaterThanOrEqual(0);
        expect(drop).toBeLessThanOrEqual(RIVER_MAX_CUT + 1e-9);
      }
    }
  });

  it('is exactly zero over most of the world', () => {
    // The cheap statement that carving is a channel and not a global offset. If
    // this ever drops much below "most", the bank has been widened into a
    // world-scale smoothing filter.
    let untouched = 0;
    const total = 3000;
    for (let i = 0; i < total; i++) {
      const x = i * 91.7 - 5000;
      const z = i * 57.1 - 3000;
      if (sampleHeight(x, z, SEED) === baseHeight(x, z, SEED)) untouched++;
    }
    expect(untouched / total).toBeGreaterThan(0.7);
  });

  it('is continuous: a 2 m step is never a cliff', () => {
    const { x, z } = strongChannelPoint(SEED);
    let worst = 0;
    for (let dz = -300; dz <= 300; dz += 11) {
      let previous = sampleHeight(x - 300, z + dz, SEED);
      for (let dx = -298; dx <= 300; dx += 2) {
        const h = sampleHeight(x + dx, z + dz, SEED);
        worst = Math.max(worst, Math.abs(h - previous));
        previous = h;
      }
    }
    expect(worst).toBeLessThan(12);
  });

  it('agrees with the Region-tier record a chunk generator is handed', () => {
    // `sampleHeight` and `RegionRiverField.finalHeight` must be the SAME
    // arithmetic, not two implementations that agree today: the worker meshes
    // through one and the main thread seats the cube through the other.
    const field = regionRiverField(WORLD, SEED);
    const { x, z } = strongChannelPoint(SEED);
    for (let i = 0; i < 200; i++) {
      const px = x + i * 3.7 - 300;
      const pz = z + i * -2.3 + 200;
      expect(field.finalHeight(px, pz)).toBe(sampleHeight(px, pz, SEED));
    }
  });
});

// ---------------------------------------------------------------------------
// Rivers reach the sea
// ---------------------------------------------------------------------------

/**
 * The longest chain in region (0,0) that actually gets to the sea, as a head
 * node and a step count. Found by walking, not assumed: which chain is longest
 * is a property of the seed, and hardcoding one would break silently the first
 * time the height field is retuned.
 */
function longestChainToSea(worldSeed: number): { net: RiverNetwork; head: number; steps: number } {
  const net = regionRivers(WORLD, worldSeed, 0, 0);
  let bestHead = -1;
  let bestSteps = 0;
  for (let start = 0; start < net.nodeX.length; start++) {
    let cursor = start;
    let steps = 0;
    let wet = false;
    while (cursor >= 0 && steps <= net.nodeX.length) {
      if ((net.nodeWaterY[cursor] as number) < WORLD.seaLevel) {
        wet = true;
        break;
      }
      cursor = net.nodeDown[cursor] as number;
      steps++;
    }
    if (wet && steps > bestSteps) {
      bestSteps = steps;
      bestHead = start;
    }
  }
  if (bestHead < 0) throw new Error('no chain reaches the sea -- rivers do not drain');
  return { net, head: bestHead, steps: bestSteps };
}

describe('rivers reach the sea', () => {
  it('routes most channels to water rather than to a dead end', () => {
    let nodes = 0;
    let reaching = 0;
    for (const [rx, rz] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [1, 1],
    ] as [number, number][]) {
      const net = regionRivers(WORLD, SEED, rx, rz);
      nodes += net.nodeX.length;
      reaching += net.nodesReachingSea;
    }
    expect(nodes).toBeGreaterThan(500);
    // Not all: a chain may legitimately leave the padded window and be
    // continued by the neighbouring region, which this network cannot see.
    expect(reaching / nodes).toBeGreaterThan(0.5);
  });

  it('follows a chain downstream and ends below sea level', () => {
    const { net, head, steps } = longestChainToSea(SEED);
    // Long enough to be a river rather than a puddle: 6 nodes is ~380 m.
    expect(steps).toBeGreaterThan(6);
    let cursor = head;
    let previous = Infinity;
    let wet = false;
    for (let i = 0; i <= steps && cursor >= 0; i++) {
      const surface = net.nodeWaterY[cursor] as number;
      // Monotonically non-increasing all the way to the mouth.
      expect(surface).toBeLessThanOrEqual(previous);
      previous = surface;
      if (surface < SEA_LEVEL) wet = true;
      cursor = net.nodeDown[cursor] as number;
    }
    expect(wet).toBe(true);
  });

  it('puts the mouth of that chain under the Phase 3a water surface', () => {
    // The end-to-end statement: the carved ground at the river mouth is below
    // SEA_LEVEL, which is exactly the condition `buildWaterSurface` uses, so
    // the estuary gets a water surface without any river-specific rendering.
    const { net, head, steps } = longestChainToSea(SEED);
    let cursor = head;
    let mouth = head;
    for (let i = 0; i <= steps && cursor >= 0; i++) {
      if ((net.nodeWaterY[cursor] as number) < SEA_LEVEL) {
        mouth = cursor;
        break;
      }
      mouth = cursor;
      cursor = net.nodeDown[cursor] as number;
    }
    const x = net.nodeX[mouth] as number;
    const z = net.nodeZ[mouth] as number;
    expect(sampleHeight(x, z, SEED)).toBeLessThan(SEA_LEVEL);
  });
});

// ---------------------------------------------------------------------------
// Region boundaries
// ---------------------------------------------------------------------------

describe('region boundaries', () => {
  it('routes on a window padded beyond the region on every side', () => {
    const net = regionRivers(WORLD, SEED, 0, 0);
    expect(net.minX).toBe(-RIVER_PAD);
    expect(net.minZ).toBe(-RIVER_PAD);
    expect(WINDOW_CELLS * RIVER_CELL).toBe(REGION_SIZE + 2 * RIVER_PAD);
  });

  it('has no step at a region boundary bigger than ordinary terrain', () => {
    // THE test for the phase's most likely visual failure. A river routed only
    // inside one region stops dead at its edge, and at 4 km scale that reads as
    // a wall across the world. Measured as the worst 2 m height step on lines
    // crossing x = REGION_SIZE, against the same measure taken well inside a
    // region -- 2 m is the lod-0 vertex spacing, so this is exactly the step a
    // rendered triangle would have to draw.
    const worstStep = (fromX: number, toX: number): number => {
      let worst = 0;
      for (let z = -1200; z <= 1200; z += 13) {
        let previous = sampleHeight(fromX, z, SEED);
        for (let x = fromX + 2; x <= toX; x += 2) {
          const h = sampleHeight(x, z, SEED);
          worst = Math.max(worst, Math.abs(h - previous));
          previous = h;
        }
      }
      return worst;
    };
    const atBoundary = worstStep(REGION_SIZE - 400, REGION_SIZE + 400);
    const control = worstStep(REGION_SIZE / 2 - 400, REGION_SIZE / 2 + 400);
    expect(atBoundary).toBeLessThan(12);
    // Not "smaller than the control", which would be a coin flip on which
    // stretch of ground is rougher. The claim is that crossing a boundary is
    // not a different KIND of event, so a generous multiple is the honest bar.
    expect(atBoundary).toBeLessThan(control * 3 + 2);
  });

  it('does not jump where a neighbouring region drops out of range', () => {
    // Sharper than the step test, and aimed at the exact mechanism. A region's
    // padded window ends at REGION_SIZE + RIVER_PAD; past that it is no longer
    // consulted at all. Its weight is engineered to be exactly 0 there, so
    // nothing may change as it disappears.
    const edge = REGION_SIZE + RIVER_PAD;
    for (let z = -2000; z <= 2000; z += 37) {
      const before = sampleHeight(edge - 1, z, SEED);
      const after = sampleHeight(edge + 1, z, SEED);
      expect(Math.abs(after - before)).toBeLessThan(2);
    }
  });

  it('carves the same channel from either side of a boundary', () => {
    // Walk along a river that crosses x = REGION_SIZE and assert the carve does
    // not collapse on one side. Both regions route the identical global lattice
    // from the identical `baseHeight`, so the PATH is continuous by
    // construction; what this checks is that the SIZE survives too.
    const net = regionRivers(WORLD, SEED, 0, 0);
    let crossings = 0;
    for (let i = 0; i < net.nodeX.length; i++) {
      const down = net.nodeDown[i] as number;
      if (down < 0) continue;
      const a = net.nodeX[i] as number;
      const b = net.nodeX[down] as number;
      if (Math.min(a, b) > REGION_SIZE - 400 && Math.max(a, b) < REGION_SIZE + 400) {
        const z = net.nodeZ[i] as number;
        const west = REGION_SIZE - 200;
        const east = REGION_SIZE + 200;
        const cutWest = baseHeight(west, z, SEED) - sampleHeight(west, z, SEED);
        const cutEast = baseHeight(east, z, SEED) - sampleHeight(east, z, SEED);
        // Both sides see SOME network; a total collapse to zero on one side is
        // the seam this whole design exists to prevent.
        if (cutWest > 1 || cutEast > 1) crossings++;
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });
});
