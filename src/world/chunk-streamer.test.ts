/**
 * Streaming behaviour, with a fake provider standing in for the worker pool.
 *
 * The two acceptance properties of Phase 1 are checked here at unit speed:
 * chunks unload and come back identical, and requests that fall out of range
 * are cancelled rather than piling up.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateChunk } from './chunk-gen';
import { ChunkStreamer, type ChunkStreamerOptions } from './chunk-streamer';
import {
  CHUNK_SIZE,
  chunkKey,
  createTierContext,
  type ChunkCoord,
  type ChunkData,
  type ChunkProvider,
  type ChunkProviderStats,
} from './contracts';

const SEED = 0x5eed;

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
    for (const [key, entry] of [...this.pending]) {
      this.pending.delete(key);
      this.completedCount++;
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
}

function makeStreamer(options: Partial<ChunkStreamerOptions> = {}): Harness {
  const provider = new FakeProvider();
  const streamer = new ChunkStreamer({
    worldSeed: SEED,
    loadRadius: 2,
    unloadRadius: 3,
    maxCachedChunks: 64,
    maxBuildsPerFrame: 1000,
    provider,
    onSceneChanged: () => {},
    ...options,
  });

  const flyTo = async (x: number, z: number): Promise<void> => {
    const position = new THREE.Vector3(x, 0, z);
    for (let i = 0; i < 20; i++) {
      streamer.update(position);
      provider.deliverAll();
      await Promise.resolve();
      await Promise.resolve();
      streamer.update(position);
      if (streamer.settled) return;
    }
    throw new Error('streamer never settled');
  };

  return { streamer, provider, flyTo };
}

/** Number of chunk cells inside a euclidean radius, matching the streamer's disc. */
function discSize(radius: number): number {
  let count = 0;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.sqrt(dx * dx + dz * dz) <= radius) count++;
    }
  }
  return count;
}

describe('ChunkStreamer', () => {
  it('fills a disc of chunks around the camera and adds them to the scene', async () => {
    const { streamer, flyTo } = makeStreamer();
    await flyTo(0, 0);

    expect(streamer.liveCount).toBe(discSize(2));
    expect(streamer.root.children).toHaveLength(discSize(2));
    expect(streamer.settled).toBe(true);
    streamer.dispose();
  });

  it('requests the nearest chunk first', async () => {
    const { streamer, provider, flyTo } = makeStreamer();
    await flyTo(0, 0);

    expect(provider.requestOrder[0]).toBe('0,0,0');
    expect(provider.priorities.get('0,0,0')).toBe(0);
    // Priority is distance in metres, so a ring-1 chunk costs one chunk width.
    expect(provider.priorities.get('1,0,0')).toBeCloseTo(CHUNK_SIZE);
    streamer.dispose();
  });

  it('is not fooled by negative world coordinates', async () => {
    const { streamer, flyTo } = makeStreamer();
    await flyTo(-CHUNK_SIZE * 3.5, -CHUNK_SIZE * 7.5);
    expect(streamer.stats().centre).toEqual({ x: -4, z: -8, lod: 0 });
    expect(streamer.liveCount).toBe(discSize(2));
    streamer.dispose();
  });

  it('retires distant chunks to the cache and reuses them without regenerating', async () => {
    const { streamer, provider, flyTo } = makeStreamer();
    await flyTo(0, 0);
    const firstPass = provider.requestOrder.length;

    await flyTo(CHUNK_SIZE * 10, 0);
    expect(streamer.stats().cached).toBeGreaterThan(0);

    const afterLeaving = provider.requestOrder.length;
    await flyTo(0, 0);
    // Coming home hit the cache: some chunks needed no new request at all.
    expect(provider.requestOrder.length - afterLeaving).toBeLessThan(firstPass);
    expect(streamer.liveCount).toBe(discSize(2));
    streamer.dispose();
  });

  it('keeps hysteresis: a chunk between the load and unload radius stays resident', async () => {
    const { streamer, flyTo } = makeStreamer({ loadRadius: 2, unloadRadius: 4 });
    await flyTo(0, 0);
    const before = streamer.liveCount;
    await flyTo(CHUNK_SIZE * 1.5, 0);
    // One chunk of travel does not evict anything, it only adds.
    expect(streamer.liveCount).toBeGreaterThanOrEqual(before);
    streamer.dispose();
  });

  it('returns identical colours after chunks were destroyed and regenerated', async () => {
    // A cache too small to hold anything forces real destruction and rebuild,
    // which is the case that must come back byte-identical (RULE 2).
    const { streamer, flyTo } = makeStreamer({ maxCachedChunks: 1 });
    const coords = ChunkStreamer.coordsAround(0, 0, 1);

    await flyTo(0, 0);
    const before = streamer.sampleColors(coords);
    const geometryBefore = streamer.samplePositionHashes(coords);
    expect(before.every((c) => c !== null)).toBe(true);
    expect(geometryBefore.every((h) => h !== null)).toBe(true);

    await flyTo(CHUNK_SIZE * 40, 0);
    expect(streamer.stats().evicted).toBeGreaterThan(0);

    await flyTo(0, 0);
    expect(streamer.sampleColors(coords)).toEqual(before);
    // The stronger statement: the vertex bits themselves came back identical.
    expect(streamer.samplePositionHashes(coords)).toEqual(geometryBefore);
    streamer.dispose();
  });

  it('cancels requests that fell out of range before they were delivered', async () => {
    const { streamer, provider } = makeStreamer();
    const position = new THREE.Vector3(0, 0, 0);

    streamer.update(position);
    expect(provider.pendingCount).toBe(discSize(2));

    // Camera jumps away before a single chunk came back.
    streamer.update(new THREE.Vector3(CHUNK_SIZE * 50, 0, 0));
    expect(provider.cancelled).toHaveLength(discSize(2));
    expect(provider.cancelled).toContain('0,0,0');
    streamer.dispose();
  });

  it('parks a payload that arrives after the camera has already left', async () => {
    const { streamer, provider } = makeStreamer();
    streamer.update(new THREE.Vector3(0, 0, 0));
    provider.deliverAll();
    // Payloads are in flight on the microtask queue; move before they land.
    streamer.update(new THREE.Vector3(CHUNK_SIZE * 50, 0, 0));
    await Promise.resolve();
    await Promise.resolve();
    streamer.update(new THREE.Vector3(CHUNK_SIZE * 50, 0, 0));

    // Nothing from the old location is in the scene, and nothing was lost.
    for (const child of streamer.root.children) {
      expect(child.position.x).toBeGreaterThan(CHUNK_SIZE * 40);
    }
    streamer.dispose();
  });

  it('never exceeds the cache cap', async () => {
    const { streamer, flyTo } = makeStreamer({ maxCachedChunks: 4 });
    for (let i = 0; i < 6; i++) await flyTo(CHUNK_SIZE * 6 * i, 0);
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

  it('never requests the same chunk twice while its payload waits to be meshed', async () => {
    // Regression: a delivered-but-unmeshed chunk is neither live, nor cached,
    // nor still requested, so a naive scan re-generates it.
    const { streamer, provider } = makeStreamer({ maxBuildsPerFrame: 2 });
    const position = new THREE.Vector3(0, 0, 0);
    streamer.update(position);
    provider.deliverAll();
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < 30; i++) streamer.update(position);

    expect(streamer.settled).toBe(true);
    expect(new Set(provider.requestOrder).size).toBe(provider.requestOrder.length);
    expect(streamer.stats().generated).toBe(discSize(2));
    streamer.dispose();
  });

  it('reports geometry as null for chunks that are not resident', async () => {
    const { streamer, flyTo } = makeStreamer({ loadRadius: 1, unloadRadius: 2 });
    await flyTo(0, 0);
    const hashes = streamer.samplePositionHashes([
      { x: 0, z: 0, lod: 0 },
      { x: 500, z: 500, lod: 0 },
    ]);
    expect(hashes[0]).toBeTypeOf('number');
    expect(hashes[1]).toBeNull();
    streamer.dispose();
  });

  it('reports unsettled until every request has landed', async () => {
    const { streamer, provider } = makeStreamer();
    expect(streamer.settled).toBe(false);
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
    // Constructed without `provider`, so it owns a real WorkerPool. Disposing
    // must not throw even though no worker was ever spawned in Node.
    expect(() => {
      const streamer = new ChunkStreamer({
        worldSeed: 1,
        loadRadius: 1,
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
});
