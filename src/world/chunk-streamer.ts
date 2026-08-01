/**
 * Chunk streaming: what is resident, what is queued, and what gets destroyed.
 *
 * The shape of the thing:
 *
 *   camera position -> centre chunk -> desired disc of chunks
 *     resident already?           -> nothing to do
 *     in the LRU cache?           -> re-add to the scene, no worker needed
 *     otherwise                   -> request from the provider, priority = distance
 *
 *   chunks past the unload radius leave the scene and enter the LRU cache
 *   the cache's hard entry cap destroys the rest
 *
 * Two radii rather than one. With a single radius a camera sitting exactly on a
 * chunk boundary would load and unload the same ring every frame; the gap
 * between `loadRadius` and `unloadRadius` is the hysteresis that stops that.
 *
 * Nothing here is world state in the sense of RULE 2. Every entry can be thrown
 * away and rebuilt from `(worldSeed, coord)`, which is exactly what the LRU cap
 * does all day.
 */

import * as THREE from 'three';
import { HudOrder, type Hud } from '../debug/hud';
import type { DebugPanel } from '../debug/panel';
import {
  CHUNK_SIZE,
  chunkKey,
  parseChunkKey,
  worldToChunk,
  type ChunkCoord,
  type ChunkData,
  type ChunkProvider,
} from './contracts';
import { createChunkMesh, disposeChunkMesh, type ChunkMesh } from './chunk-mesh';
import { LruCache } from './lru-cache';
import { WorkerPool } from './worker-pool';

export interface ChunkStreamerOptions {
  /** uint32 world seed. */
  worldSeed: number;
  /** Radius in chunks of the disc kept resident around the camera. */
  loadRadius: number;
  /** Radius in chunks at which a resident chunk is retired. Must exceed `loadRadius`. */
  unloadRadius: number;
  /** Hard cap on retired-but-retained chunks. */
  maxCachedChunks: number;
  /**
   * Meshes built per frame. Uploading a hundred geometries in one frame is a
   * visible hitch, so arrivals are drained over several frames instead.
   */
  maxBuildsPerFrame: number;
  /** Injectable for tests. Defaults to a real worker pool. */
  provider: ChunkProvider;
  /** Called after meshes were added or removed, so wireframe mode reaches them. */
  onSceneChanged: () => void;
}

const DEFAULTS = {
  loadRadius: 8,
  unloadRadius: 10,
  maxCachedChunks: 384,
  maxBuildsPerFrame: 12,
} as const;

interface Offset {
  dx: number;
  dz: number;
  /** Distance from the centre chunk, in chunks. */
  distance: number;
}

export interface ChunkStreamerStats {
  live: number;
  cached: number;
  queued: number;
  inFlight: number;
  generated: number;
  cancelledRequests: number;
  evicted: number;
  workers: number;
  /** Vertex bytes held by live plus cached chunks. */
  bytes: number;
  centre: ChunkCoord;
  settled: boolean;
}

export class ChunkStreamer {
  readonly root = new THREE.Group();

  private readonly provider: ChunkProvider;
  private readonly ownsProvider: boolean;
  private readonly onSceneChanged: () => void;
  private readonly live = new Map<string, ChunkMesh>();
  private readonly cache: LruCache<ChunkMesh>;
  /** Keys requested from the provider and not yet delivered or cancelled. */
  private readonly requested = new Set<string>();
  /** Payloads that arrived but have not been turned into meshes yet. */
  private readonly arrived: ChunkData[] = [];
  /**
   * Keys in `arrived`. Without this, a chunk that has been delivered but not
   * yet meshed looks absent to `scan()` -- neither live, nor cached, nor
   * requested -- and gets generated a second time.
   */
  private readonly arrivedKeys = new Set<string>();

  private loadOffsets: Offset[] = [];
  private loadRadius: number;
  private unloadRadius: number;
  private centre: ChunkCoord = { x: 0, z: 0 };
  private maxBuildsPerFrame: number;
  private generatedCount = 0;
  private cancelledCount = 0;
  private hasUpdated = false;
  private enabled = true;
  private disposed = false;

  constructor(options: Partial<ChunkStreamerOptions> = {}) {
    const worldSeed = (options.worldSeed ?? 0) >>> 0;
    this.loadRadius = Math.max(1, Math.floor(options.loadRadius ?? DEFAULTS.loadRadius));
    this.unloadRadius = Math.max(
      this.loadRadius + 1,
      Math.floor(options.unloadRadius ?? DEFAULTS.unloadRadius),
    );
    this.maxBuildsPerFrame = Math.max(1, options.maxBuildsPerFrame ?? DEFAULTS.maxBuildsPerFrame);
    this.onSceneChanged = options.onSceneChanged ?? ((): void => {});

    this.ownsProvider = options.provider === undefined;
    this.provider = options.provider ?? new WorkerPool({ worldSeed });

    this.cache = new LruCache<ChunkMesh>({
      maxEntries: options.maxCachedChunks ?? DEFAULTS.maxCachedChunks,
      onEvict: (_key, entry) => disposeChunkMesh(entry),
    });

    this.root.name = 'chunks';
    this.rebuildOffsets();
  }

  // -- streaming ------------------------------------------------------------

  /** Call once per rendered frame with the camera's world position. */
  update(cameraPosition: THREE.Vector3): void {
    if (this.disposed) return;

    if (!this.enabled) {
      // Streaming off is a debug state, not a world state: keep what is
      // resident and stop touching the provider.
      this.hasUpdated = true;
      return;
    }

    const centre = worldToChunk(cameraPosition.x, cameraPosition.z);
    const centreMoved = centre.x !== this.centre.x || centre.z !== this.centre.z;
    this.centre = centre;

    // In the steady state (camera inside the same chunk, nothing outstanding)
    // there is genuinely nothing to do, and doing nothing is the cheapest way
    // to keep the frame budget and the GC quiet.
    const needsScan = centreMoved || !this.hasUpdated || this.requested.size > 0;
    if (needsScan) {
      this.scan();
      this.retire();
    }

    this.drainArrivals();
    this.hasUpdated = true;
  }

  /** Walk the desired disc, nearest first, filling it from cache or provider. */
  private scan(): void {
    let sceneChanged = false;

    for (const offset of this.loadOffsets) {
      const coord = { x: this.centre.x + offset.dx, z: this.centre.z + offset.dz };
      const key = chunkKey(coord);
      if (this.live.has(key) || this.arrivedKeys.has(key)) continue;

      const cached = this.cache.delete(key);
      if (cached !== undefined) {
        this.live.set(key, cached);
        this.root.add(cached.mesh);
        sceneChanged = true;
        continue;
      }

      const priority = offset.distance * CHUNK_SIZE;
      if (this.requested.has(key)) {
        this.provider.reprioritize(coord, priority);
        continue;
      }
      this.requestChunk(coord, key, priority);
    }

    if (sceneChanged) this.onSceneChanged();
  }

  private requestChunk(coord: ChunkCoord, key: string, priority: number): void {
    this.requested.add(key);
    void this.provider.request(coord, priority).then((data) => {
      if (this.disposed) return;
      this.requested.delete(key);
      if (data === null) {
        this.cancelledCount++;
        return;
      }
      this.generatedCount++;
      this.arrived.push(data);
      this.arrivedKeys.add(key);
    });
  }

  /** Cancel far-away requests and retire far-away resident chunks. */
  private retire(): void {
    for (const key of [...this.requested]) {
      const coord = parseChunkKey(key);
      if (this.chunkDistance(coord) <= this.unloadRadius) continue;
      // Fell out of range before a worker got to it. Dropping it here is what
      // stops the queue growing without bound behind a fast camera.
      this.requested.delete(key);
      this.provider.cancel(coord);
    }

    let sceneChanged = false;
    for (const [key, entry] of [...this.live]) {
      if (this.chunkDistance(parseChunkKey(key)) <= this.unloadRadius) continue;
      this.live.delete(key);
      this.root.remove(entry.mesh);
      // Retained, not destroyed: turning around should not re-run a worker.
      // The cache's hard cap is what bounds this.
      this.cache.set(key, entry);
      sceneChanged = true;
    }
    if (sceneChanged) this.onSceneChanged();
  }

  /** Turn a bounded number of arrived payloads into meshes. */
  private drainArrivals(): void {
    if (this.arrived.length === 0) return;

    let built = 0;
    let sceneChanged = false;
    while (this.arrived.length > 0 && built < this.maxBuildsPerFrame) {
      const data = this.arrived.shift() as ChunkData;
      const key = chunkKey(data.coord);
      this.arrivedKeys.delete(key);
      if (this.live.has(key) || this.cache.has(key)) continue;

      const entry = createChunkMesh(data);
      if (this.chunkDistance(data.coord) > this.unloadRadius) {
        // Arrived after the camera left. Park it rather than show it.
        this.cache.set(key, entry);
      } else {
        this.live.set(key, entry);
        this.root.add(entry.mesh);
        sceneChanged = true;
      }
      built++;
    }

    // New meshes will not pick up wireframe mode unless the renderer is told.
    if (sceneChanged) this.onSceneChanged();
  }

  private chunkDistance(coord: ChunkCoord): number {
    const dx = coord.x - this.centre.x;
    const dz = coord.z - this.centre.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Precompute the disc of offsets once, sorted nearest first, so the per-frame
   * scan allocates nothing and issues the most urgent requests first.
   */
  private rebuildOffsets(): void {
    const offsets: Offset[] = [];
    const r = this.loadRadius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance > r) continue;
        offsets.push({ dx, dz, distance });
      }
    }
    // Ties broken by coordinate so the request order is fully deterministic.
    offsets.sort((a, b) => a.distance - b.distance || a.dz - b.dz || a.dx - b.dx);
    this.loadOffsets = offsets;
  }

  // -- state ----------------------------------------------------------------

  /**
   * True when the world around the camera is fully resident: nothing queued,
   * nothing in flight, nothing waiting to be meshed.
   *
   * `window.__worldReady` waits on this, which is what keeps canonical
   * screenshots byte-comparable now that content arrives asynchronously.
   */
  get settled(): boolean {
    if (!this.enabled) return true;
    return this.hasUpdated && this.requested.size === 0 && this.arrived.length === 0;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get streamingEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  setLoadRadius(radius: number): void {
    const next = Math.max(1, Math.round(radius));
    if (next === this.loadRadius) return;
    this.loadRadius = next;
    this.unloadRadius = next + 2;
    this.rebuildOffsets();
    this.hasUpdated = false;
  }

  get radius(): number {
    return this.loadRadius;
  }

  stats(): ChunkStreamerStats {
    const providerStats = this.provider.stats;
    let bytes = 0;
    for (const entry of this.live.values()) bytes += entry.bytes;
    for (const key of this.cache.keys()) bytes += this.cache.peek(key)?.bytes ?? 0;

    return {
      live: this.live.size,
      cached: this.cache.size,
      queued: providerStats.queued,
      inFlight: providerStats.inFlight,
      generated: this.generatedCount,
      cancelledRequests: this.cancelledCount,
      evicted: this.cache.evictions,
      workers: providerStats.workers,
      bytes,
      centre: this.centre,
      settled: this.settled,
    };
  }

  /**
   * Colours of specific chunks as they are actually resident, or null where the
   * chunk is not loaded.
   *
   * This exists for the soak test's round-trip check: fly away, fly back, and
   * assert the same coordinates came back the same colour. Reading the resident
   * mesh rather than recomputing the hash is the point -- recomputing would
   * prove only that the hash is pure, not that streaming preserved it.
   */
  sampleColors(coords: readonly ChunkCoord[]): (readonly number[] | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : [...entry.color];
    });
  }

  /** Chunk coordinates in a square around a world position. For the soak test. */
  static coordsAround(worldX: number, worldZ: number, radius: number): ChunkCoord[] {
    const centre = worldToChunk(worldX, worldZ);
    const coords: ChunkCoord[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        coords.push({ x: centre.x + dx, z: centre.z + dz });
      }
    }
    return coords;
  }

  /** Destroy every resident and cached chunk. They regenerate identically. */
  reload(): void {
    for (const entry of this.live.values()) disposeChunkMesh(entry);
    this.live.clear();
    this.cache.clear();
    this.arrived.length = 0;
    this.arrivedKeys.clear();
    this.hasUpdated = false;
    this.onSceneChanged();
  }

  // -- debug ----------------------------------------------------------------

  /**
   * Supplies the real values for the `chunks` and `worker queue` HUD lines that
   * `app.ts` registers as placeholders. Registering the same label replaces the
   * provider, so `app.ts` needs no edit.
   */
  registerDebug(hud: Hud, panel: DebugPanel): void {
    hud.register(
      'chunks',
      () => {
        const s = this.stats();
        return `${s.live} live / ${s.cached} cached / ${s.evicted} evicted`;
      },
      HudOrder.world,
    );
    hud.register(
      'worker queue',
      () => {
        const s = this.stats();
        return `${s.queued} queued / ${s.inFlight} busy / ${s.workers} workers`;
      },
      HudOrder.workers,
    );
    hud.register(
      'chunk gen',
      () => {
        const s = this.stats();
        return `${s.generated} built / ${s.cancelledRequests} cancelled`;
      },
      HudOrder.workers,
    );
    hud.register(
      'chunk mem',
      () => `${(this.stats().bytes / 1024).toFixed(1)} kB vertex data`,
      HudOrder.memory,
    );

    const folder = panel.folder('Streaming');
    folder.addToggle(
      'enabled',
      () => this.streamingEnabled,
      (value) => this.setEnabled(value),
    );
    folder.addToggle(
      'visible',
      () => this.visible,
      (value) => this.setVisible(value),
    );
    folder.addNumber(
      'load radius',
      () => this.radius,
      (value) => this.setLoadRadius(value),
      { min: 1, max: 16, step: 1 },
    );
    folder.addButton('reload all chunks', () => this.reload());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownsProvider) this.provider.dispose();
    for (const entry of this.live.values()) disposeChunkMesh(entry);
    this.live.clear();
    this.cache.clear();
    this.arrived.length = 0;
    this.arrivedKeys.clear();
    this.requested.clear();
    this.root.removeFromParent();
  }
}
