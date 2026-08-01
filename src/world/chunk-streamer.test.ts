/**
 * Streaming behaviour, with a fake provider standing in for the worker pool.
 *
 * Phase 1's two acceptance properties are still checked here at unit speed:
 * nodes unload and come back identical, and requests that fall out of range are
 * cancelled rather than piling up.
 *
 * Phase 2b adds the properties a QUADTREE streamer has to hold and a flat disc
 * never had to: the resident set is a function of position and not of route,
 * the ground under the camera is never covered by zero nodes while a split is
 * in flight, and once settled it is never covered by more than one.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateChunk } from './chunk-gen';
import { ChunkStreamer, type ChunkStreamerOptions } from './chunk-streamer';
import {
  chunkKey,
  createTierContext,
  worldToChunk,
  type ChunkCoord,
  type ChunkData,
  type ChunkProvider,
  type ChunkProviderStats,
} from './contracts';
import { selectQuadtree } from './quadtree';

const SEED = 0x5eed;

/**
 * A small world for unit speed. 512 m of view distance is four levels
 * (64/128/256/512) -- enough that splits, merges and coarse leaves all happen,
 * and few enough nodes that a test settles in milliseconds.
 */
const VIEW = 512;
const SPLIT = 2.5;

class FakeProvider implements ChunkProvider {
  /** Every key ever requested, in request order. */
  readonly requestOrder: string[] = [];
  readonly cancelled: string[] = [];
  readonly priorities = new Map<string, number>();

  private readonly pending = new Map<string, { coord: ChunkCoord; settle: (d: ChunkData | null) => void }>();
  private completedCount = 0;
  private cancelledCount = 0;
  disposed = false;

  get stats(): ChunkProviderStats {
    return {
      queued: this.pending.size,
      inFlight: 0,
      completed: this.completedCount,
      cancelled: this.cancelledCount,
      workers: 1,
    };
  }

  request(coord: ChunkCoord, priority: number): Promise<ChunkData | null> {
    const key = chunkKey(coord);
    this.requestOrder.push(key);
    this.priorities.set(key, priority);
    return new Promise((resolve) => {
      this.pending.set(key, { coord, settle: resolve });
    });
  }

  reprioritize(coord: ChunkCoord, priority: number): void {
    this.priorities.set(chunkKey(coord), priority);
  }

  cancel(coord: ChunkCoord): void {
    const key = chunkKey(coord);
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    this.pending.delete(key);
    this.cancelled.push(key);
    this.cancelledCount++;
    entry.settle(null);
  }

  /** Deliver every outstanding request, as a pool of workers eventually would. */
  deliverAll(): void {
    this.deliver(this.pending.size);
  }

  /** Deliver only the first `count` outstanding requests, so a split can be caught mid-flight. */
  deliver(count: number): void {
    let delivered = 0;
    for (const [key, entry] of [...this.pending]) {
      if (delivered >= count) break;
      this.pending.delete(key);
      this.completedCount++;
      delivered++;
      entry.settle(generateChunk(entry.coord, createTierContext(SEED, 'chunk')));
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const [, entry] of this.pending) entry.settle(null);
    this.pending.clear();
  }
}

interface Harness {
  streamer: ChunkStreamer;
  provider: FakeProvider;
  /** Move the camera and pump update/deliver until the streamer reports settled. */
  flyTo(x: number, z: number): Promise<void>;
  /** One frame: update, deliver at most `count`, update again. */
  step(x: number, z: number, count?: number): Promise<void>;
}

function makeStreamer(options: Partial<ChunkStreamerOptions> = {}): Harness {
  const provider = new FakeProvider();
  const streamer = new ChunkStreamer({
    worldSeed: SEED,
    viewDistance: VIEW,
    splitFactor: SPLIT,
    maxCachedChunks: 512,
    maxBuildsPerFrame: 1000,
    provider,
    onSceneChanged: () => {},
    ...options,
  });

  const step = async (x: number, z: number, count = Number.MAX_SAFE_INTEGER): Promise<void> => {
    const position = new THREE.Vector3(x, 0, z);
    streamer.update(position);
    provider.deliver(count);
    await Promise.resolve();
    await Promise.resolve();
    streamer.update(position);
  };

  const flyTo = async (x: number, z: number): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      await step(x, z);
      if (streamer.settled) return;
    }
    throw new Error('streamer never settled');
  };

  return { streamer, provider, flyTo, step };
}

/** How many resident nodes cover a world-space point. 1 is correct; 0 is a hole. */
function coverage(coords: readonly ChunkCoord[], x: number, z: number): number {
  const keys = new Set(coords.map(chunkKey));
  let hits = 0;
  for (let lod = 0; lod <= 12; lod++) if (keys.has(chunkKey(worldToChunk(x, z, lod)))) hits++;
  return hits;
}

/** The leaf set the quadtree would choose, as keys. The streamer must match it once settled. */
function expectedKeys(x: number, z: number): string[] {
  return selectQuadtree(x, z, { viewDistance: VIEW, splitFactor: SPLIT }).leaves.map((leaf) =>
    chunkKey(leaf.coord),
  );
}

describe('ChunkStreamer', () => {
  it('makes the selected quadtree leaves resident, and nothing else', async () => {
    const { streamer, flyTo } = makeStreamer();
    await flyTo(0, 0);

    const expected = expectedKeys(0, 0);
    expect(expected.length).toBeGreaterThan(40);
    expect(new Set(streamer.liveCoords().map(chunkKey))).toEqual(new Set(expected));
    expect(streamer.root.children).toHaveLength(expected.length);
    expect(streamer.settled).toBe(true);
    streamer.dispose();
  });

  it('resides at several levels at once, fine near the camera', async () => {
    const { streamer, flyTo } = makeStreamer();
    await flyTo(0, 0);

    const counts = streamer.stats().lodCounts;
    // A flat disc would put everything in bucket 0. If this ever collapses to a
    // single level the quadtree has stopped selecting.
    expect(counts.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(counts[0]).toBeGreaterThan(0);

    // The node under the camera is the finest one there is.
    const under = streamer.liveCoords().filter((c) => coverage([c], 1, 1) === 1);
    expect(under).toHaveLength(1);
    expect(under[0]?.lod).toBe(0);
    streamer.dispose();
  });

  it('requests the nearest node first, priced in metres', async () => {
    const { streamer, provider, flyTo } = makeStreamer();
    // Inside node (0,0) rather than on its corner, where four nodes tie at
    // distance 0 and the winner is decided by the tie-break rather than by
    // being nearest.
    await flyTo(32, 32);

    expect(provider.requestOrder[0]).toBe('0,0,0');
    expect(provider.priorities.get('0,0,0')).toBe(0);
    // Priority is the distance to the node's NEAREST POINT, not to its centre:
    // a 512 m node the camera is standing in is urgent, and its centre is not
    // where it needs detail.
    expect(provider.priorities.get('2,0,0')).toBeCloseTo(96);
    streamer.dispose();
  });

  it('is not fooled by negative world coordinates', async () => {
    const { streamer, flyTo } = makeStreamer();
    await flyTo(-224.5, -480.5);
    expect(streamer.stats().centre).toEqual({ x: -4, z: -8, lod: 0 });
    expect(new Set(streamer.liveCoords().map(chunkKey))).toEqual(
      new Set(expectedKeys(-224.5, -480.5)),
    );
    streamer.dispose();
  });

  it('covers the ground exactly once when settled -- no holes, no overlaps', async () => {
    const { streamer, flyTo } = makeStreamer();
    await flyTo(700.5, -300.25);

    const coords = streamer.liveCoords();
    expect(coords.length).toBeGreaterThan(40);
    // Offsets stay inside the view disc: a point beyond it is legitimately
    // covered by nothing, and asserting on one would test the sampler.
    for (const [dx, dz] of [
      [0, 0],
      [10, 10],
      [-200, 130],
      [300, -300],
      [-250, -250],
      [340, 90],
    ] as const) {
      expect(coverage(coords, 700.5 + dx, -300.25 + dz)).toBe(1);
    }
    streamer.dispose();
  });

  it('holds exactly the selected set once settled, with nothing lingering', async () => {
    // The unload margin is conditioned on residency, not on distance, so once
    // nothing is streaming the resident set IS the selection -- no ring of
    // stale nodes whose contents depend on where the camera has been.
    const { streamer, flyTo } = makeStreamer();
    await flyTo(0, 0);
    await flyTo(300.5, 120.25);
    expect(streamer.liveCoords().map(chunkKey).sort()).toEqual(
      expectedKeys(300.5, 120.25).sort(),
    );
    streamer.dispose();
  });

  it('never loses ground it already had while levels change under it', async () => {
    // The invariant: once a point of the world is covered, it stays covered for
    // as long as it is inside the view distance. Nodes may change level under
    // it as often as they like.
    //
    // The failure this catches is retiring a parent the instant it stops being
    // a leaf. That looks perfect in a settled screenshot and flashes sky
    // through the ground for every frame the four children take to arrive --
    // exactly the bug a settled-state test cannot see.
    const { streamer, flyTo, step } = makeStreamer();
    await flyTo(-900, 0);

    const probes = [-900, -700, -500, -300, -100, 100];
    const wasCovered = new Map<number, boolean>();
    const levelsSeen = new Map<number, Set<number>>(probes.map((p) => [p, new Set<number>()]));
    let checks = 0;
    let unsettledFrames = 0;

    for (let x = -900; x <= 200; x += 11) {
      // A trickle of deliveries, so the resident set is genuinely
      // mid-transition rather than snapping straight to the new selection.
      await step(x, 0, 6);
      if (!streamer.settled) unsettledFrames++;
      const coords = streamer.liveCoords();

      for (const probe of probes) {
        const covered = coverage(coords, probe, 0);
        if (wasCovered.get(probe) === true && Math.abs(probe - x) < VIEW * 0.8) {
          expect(covered).toBeGreaterThanOrEqual(1);
          checks++;
        }
        if (covered > 0) wasCovered.set(probe, true);
        for (const coord of coords) {
          if (coverage([coord], probe, 0) === 1) levelsSeen.get(probe)?.add(coord.lod);
        }
      }
    }

    // Anti-vacuity: the run must actually have been in transition, and the
    // probes must actually have changed level, or "no hole" is a statement
    // about a world that never moved.
    expect(checks).toBeGreaterThan(100);
    expect(unsettledFrames).toBeGreaterThan(10);
    expect([...levelsSeen.values()].filter((s) => s.size > 1).length).toBeGreaterThanOrEqual(3);

    await flyTo(200, 0);
    expect(coverage(streamer.liveCoords(), 200, 0)).toBe(1);
    streamer.dispose();
  });

  it('resolves every overlap once it settles, wherever it came from', async () => {
    const { streamer, flyTo } = makeStreamer();
    for (const [x, z] of [
      [0, 0],
      [400, 0],
      [400, 400],
      [-900, 250],
      [0, 0],
    ] as const) {
      await flyTo(x, z);
    }
    const coords = streamer.liveCoords();
    for (const [dx, dz] of [
      [0, 0],
      [130, -70],
      [-380, 380],
    ] as const) {
      expect(coverage(coords, dx, dz)).toBe(1);
    }
    streamer.dispose();
  });

  it('ends with the same resident set however the camera got there', async () => {
    // The quadtree split test has NO hysteresis precisely so that this holds.
    // If it did, the resident set would depend on the direction of approach and
    // every settled screenshot would become path-dependent.
    const target: [number, number] = [255.5, -129.25];

    const west = makeStreamer();
    await west.flyTo(-3000, 0);
    await west.flyTo(...target);

    const east = makeStreamer();
    await east.flyTo(4000, 4000);
    await east.flyTo(0, 0);
    await east.flyTo(...target);

    const fresh = makeStreamer();
    await fresh.flyTo(...target);

    const keysOf = (h: Harness): string[] => h.streamer.liveCoords().map(chunkKey).sort();
    expect(keysOf(west).length).toBeGreaterThan(40);
    expect(keysOf(west)).toEqual(keysOf(fresh));
    expect(keysOf(east)).toEqual(keysOf(fresh));

    west.streamer.dispose();
    east.streamer.dispose();
    fresh.streamer.dispose();
  });

  it('retires distant nodes to the cache and reuses them without regenerating', async () => {
    const { streamer, provider, flyTo } = makeStreamer();
    await flyTo(0, 0);
    const firstPass = provider.requestOrder.length;

    await flyTo(6000, 0);
    expect(streamer.stats().cached).toBeGreaterThan(0);

    const afterLeaving = provider.requestOrder.length;
    await flyTo(0, 0);
    // Coming home hit the cache: some nodes needed no new request at all.
    expect(provider.requestOrder.length - afterLeaving).toBeLessThan(firstPass);
    streamer.dispose();
  });

  it('returns identical geometry after nodes were destroyed and regenerated', async () => {
    // A cache too small to hold anything forces real destruction and rebuild,
    // which is the case that must come back byte-identical (RULE 2).
    const { streamer, flyTo } = makeStreamer({ maxCachedChunks: 1 });
    const coords = ChunkStreamer.coordsAround(0, 0, 2);

    await flyTo(0, 0);
    const before = streamer.sampleColors(coords);
    const geometryBefore = streamer.samplePositionHashes(coords);
    expect(before.every((c) => c !== null)).toBe(true);
    expect(geometryBefore.every((h) => h !== null)).toBe(true);

    await flyTo(9000, 0);
    expect(streamer.stats().evicted).toBeGreaterThan(0);

    await flyTo(0, 0);
    expect(streamer.sampleColors(coords)).toEqual(before);
    // The stronger statement: the vertex bits themselves came back identical.
    expect(streamer.samplePositionHashes(coords)).toEqual(geometryBefore);
    streamer.dispose();
  });

  it('cancels requests the camera invalidated before they were delivered', async () => {
    const { streamer, provider } = makeStreamer();
    const position = new THREE.Vector3(0, 0, 0);

    streamer.update(position);
    const issued = provider.pendingCount;
    expect(issued).toBeGreaterThan(40);

    // Camera jumps away before a single node came back.
    streamer.update(new THREE.Vector3(50000, 0, 0));
    expect(provider.cancelled.length).toBe(issued);
    expect(provider.cancelled).toContain('0,0,0');
    streamer.dispose();
  });

  it('cancels work a split invalidated, not just work that went out of range', async () => {
    // Phase 1 and 2a never exercised the cancellation path in a live run: a
    // uniform disc only invalidates work at its rim. A quadtree invalidates it
    // everywhere, every time a node changes level.
    const { streamer, provider, step } = makeStreamer();
    for (let x = -900; x <= 900; x += 60) await step(x, 0, 3);
    expect(provider.cancelled.length).toBeGreaterThan(0);
    expect(streamer.stats().cancelledRequests).toBeGreaterThan(0);
    streamer.dispose();
  });

  it('parks a payload that arrives after the camera has already left', async () => {
    const { streamer, provider } = makeStreamer();
    streamer.update(new THREE.Vector3(0, 0, 0));
    provider.deliverAll();
    // Payloads are in flight on the microtask queue; move before they land.
    streamer.update(new THREE.Vector3(50000, 0, 0));
    await Promise.resolve();
    await Promise.resolve();
    streamer.update(new THREE.Vector3(50000, 0, 0));

    // Nothing from the old location is in the scene, and nothing was lost.
    for (const child of streamer.root.children) {
      expect(child.position.x).toBeGreaterThan(40000);
    }
    streamer.dispose();
  });

  it('never exceeds the cache cap', async () => {
    const { streamer, flyTo } = makeStreamer({ maxCachedChunks: 4 });
    for (let i = 0; i < 6; i++) await flyTo(1500 * i, 0);
    expect(streamer.stats().cached).toBeLessThanOrEqual(4);
    streamer.dispose();
  });

  it('spreads mesh building over frames rather than uploading in one hitch', async () => {
    const { streamer, provider } = makeStreamer({ maxBuildsPerFrame: 3 });
    const position = new THREE.Vector3(0, 0, 0);
    streamer.update(position);
    provider.deliverAll();
    await Promise.resolve();
    await Promise.resolve();

    streamer.update(position);
    expect(streamer.liveCount).toBe(3);
    streamer.update(position);
    expect(streamer.liveCount).toBe(6);
    streamer.dispose();
  });

  it('never requests the same node twice while its payload waits to be meshed', async () => {
    // Regression: a delivered-but-unmeshed node is neither live, nor cached,
    // nor still requested, so a naive scan re-generates it.
    const { streamer, provider } = makeStreamer({ maxBuildsPerFrame: 2 });
    const position = new THREE.Vector3(0, 0, 0);
    streamer.update(position);
    provider.deliverAll();
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < 200; i++) streamer.update(position);

    expect(streamer.settled).toBe(true);
    expect(new Set(provider.requestOrder).size).toBe(provider.requestOrder.length);
    expect(streamer.stats().generated).toBe(expectedKeys(0, 0).length);
    streamer.dispose();
  });

  it('reports geometry as null for nodes that are not resident', async () => {
    const { streamer, flyTo } = makeStreamer({ viewDistance: 128 });
    await flyTo(0, 0);
    const hashes = streamer.samplePositionHashes([
      { x: 0, z: 0, lod: 0 },
      { x: 500, z: 500, lod: 0 },
    ]);
    expect(hashes[0]).toBeTypeOf('number');
    expect(hashes[1]).toBeNull();
    streamer.dispose();
  });

  it('reports unsettled until every selected node is in the scene', async () => {
    const { streamer, provider } = makeStreamer();
    expect(streamer.settled).toBe(false);
    streamer.update(new THREE.Vector3(0, 0, 0));
    expect(streamer.settled).toBe(false);

    // Half the payloads is still not a settled world.
    provider.deliver(5);
    await Promise.resolve();
    await Promise.resolve();
    streamer.update(new THREE.Vector3(0, 0, 0));
    expect(streamer.settled).toBe(false);

    provider.deliverAll();
    await Promise.resolve();
    await Promise.resolve();
    streamer.update(new THREE.Vector3(0, 0, 0));
    expect(streamer.settled).toBe(true);
    streamer.dispose();
  });

  it('reports settled and stops touching the provider when streaming is disabled', () => {
    const { streamer, provider } = makeStreamer();
    streamer.setEnabled(false);
    streamer.update(new THREE.Vector3(0, 0, 0));
    expect(provider.requestOrder).toHaveLength(0);
    expect(streamer.settled).toBe(true);
    streamer.dispose();
  });

  it('reselects when the view distance changes, without leaving stale coarse nodes', async () => {
    const { streamer, flyTo } = makeStreamer({ viewDistance: 2048 });
    await flyTo(0, 0);
    const wide = streamer.liveCoords().length;

    streamer.setViewDistance(512);
    await flyTo(0, 0);
    expect(streamer.liveCoords().length).toBeLessThan(wide);
    // The shallower tree must not leave a 2 km node sitting on top of the new
    // fine ones.
    expect(coverage(streamer.liveCoords(), 0, 0)).toBe(1);
    expect(coverage(streamer.liveCoords(), 300, -200)).toBe(1);
    streamer.dispose();
  });

  it('releases everything on dispose', async () => {
    const { streamer, provider, flyTo } = makeStreamer();
    await flyTo(0, 0);

    const geometries = streamer.root.children.map((child) => (child as THREE.Mesh).geometry);
    let disposed = 0;
    for (const geometry of geometries) geometry.addEventListener('dispose', () => disposed++);

    streamer.dispose();
    expect(disposed).toBe(geometries.length);
    expect(streamer.liveCount).toBe(0);
    expect(provider.disposed).toBe(false); // injected providers are not owned
  });

  it('disposes a provider it created itself', () => {
    expect(() => {
      const streamer = new ChunkStreamer({
        worldSeed: 1,
        viewDistance: 128,
        provider: new FakeProvider(),
      });
      streamer.dispose();
    }).not.toThrow();
  });

  it('reload destroys everything and regenerates it identically', async () => {
    const { streamer, flyTo } = makeStreamer();
    const coords = ChunkStreamer.coordsAround(0, 0, 1);
    await flyTo(0, 0);
    const before = streamer.sampleColors(coords);
    const geometryBefore = streamer.samplePositionHashes(coords);

    streamer.reload();
    expect(streamer.liveCount).toBe(0);

    await flyTo(0, 0);
    expect(streamer.sampleColors(coords)).toEqual(before);
    expect(streamer.samplePositionHashes(coords)).toEqual(geometryBefore);
    streamer.dispose();
  });

  it('keeps the soak sample square entirely at the finest level', async () => {
    // The soak compares a 5x5 lod-0 square before and after a round trip. If
    // the finest level did not reach the corners of that square the comparison
    // would flip level with a couple of metres of camera drift and go flaky for
    // reasons that have nothing to do with determinism.
    const { streamer, flyTo } = makeStreamer({ viewDistance: 4096 });
    await flyTo(0, 0);
    const hashes = streamer.samplePositionHashes(ChunkStreamer.coordsAround(0, 0, 2));
    expect(hashes).toHaveLength(25);
    expect(hashes.every((h) => h !== null)).toBe(true);
    streamer.dispose();
  });
});
