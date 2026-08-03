/**
 * Chunk streaming: what is resident, at what level, and what gets destroyed.
 *
 * The shape of the thing since Phase 2b:
 *
 *   camera position -> quadtree descent -> the LEAF set that should be resident
 *     resident already?           -> nothing to do
 *     in the LRU cache?           -> re-add to the scene, no worker needed
 *     otherwise                   -> request from the provider, priority = distance
 *
 *   a node that is no longer a leaf leaves the scene as soon as whatever
 *   replaced it is resident; a node that nothing replaced -- because it left
 *   the view distance -- leaves immediately. Retired nodes enter the LRU cache,
 *   whose hard entry cap destroys the rest.
 *
 * WHY A QUADTREE, AND WHAT IT IS ACTUALLY FOR. Phase 2a's flat disc was
 * profiled on real hardware: at a 3 km radius it cost 1,834 draw calls and
 * 504 MB of heap while the GPU rendered the whole scene in 1.46 ms. Frame time
 * was never the problem. `SEGMENTS` is constant across levels, so every node
 * costs the same bytes and the same triangles whatever area it covers -- which
 * makes NODE COUNT the single quantity worth bounding, and bounding node count
 * is all this quadtree does. See `quadtree.ts`.
 *
 * WHERE HYSTERESIS LIVES, AND WHY IT IS THE SHAPE IT IS. The selection in
 * `quadtree.ts` is a pure function of camera position: no memory, no direction
 * of travel, no dependence on what is already loaded. All the hysteresis is on
 * this side, applies to UNLOADING only, and is conditioned on RESIDENCY rather
 * than on distance: a node that stopped being selected survives exactly until
 * whatever replaced it is in the scene.
 *
 * That last detail is what makes the settled resident set path-INDEPENDENT.
 * A distance-based unload margin -- the obvious design, and the one Phase 1 and
 * 2a used -- leaves nodes lingering in a ring whose contents depend on where
 * the camera has been, so two cameras that arrive at the same place from
 * different directions render different worlds. Per-node content stays
 * deterministic either way; it is the resident SET that drifts, and a
 * screenshot harness cannot tell the difference. Conditioning on residency
 * instead gives a margin that is transient by construction: once nothing is
 * streaming, live == selected, exactly.
 *
 * The LRU cache is what makes that affordable. A node that crosses a level
 * boundary and immediately comes back is a map lookup, not a worker round trip,
 * so there is nothing left for a distance margin to buy.
 *
 * Nothing here is world state in the sense of RULE 2. Every entry can be thrown
 * away and rebuilt from `(worldSeed, coord)`, which is exactly what the LRU cap
 * does all day.
 */

import * as THREE from 'three';
import { HudOrder, type Hud } from '../debug/hud';
import type { DebugPanel } from '../debug/panel';
import {
  chunkKey,
  parseChunkKey,
  worldToChunk,
  type ChunkCoord,
  type ChunkData,
  type ChunkProvider,
} from './contracts';
import { createChunkMesh, disposeChunkMesh, type ChunkMesh } from './chunk-mesh';
import { LruCache } from './lru-cache';
import {
  DEFAULT_SPLIT_FACTOR,
  DEFAULT_VIEW_DISTANCE,
  isDescendantOrSelf,
  lodHistogram,
  nodeParent,
  selectQuadtree,
  type QuadtreeSelection,
} from './quadtree';
import { WorkerPool } from './worker-pool';

export interface ChunkStreamerOptions {
  /** uint32 world seed. */
  worldSeed: number;
  /** Metres of terrain kept resident around the camera. */
  viewDistance: number;
  /** A node splits while the camera is within `splitFactor * nodeSize` of its centre. */
  splitFactor: number;
  /** Hard cap on retired-but-retained nodes. */
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
  viewDistance: DEFAULT_VIEW_DISTANCE,
  splitFactor: DEFAULT_SPLIT_FACTOR,
  /**
   * Comfortably above the ~300 nodes a 4 km selection holds, so a node that
   * crosses a level boundary and comes straight back is an LRU hit rather than
   * a worker round trip. That cache is what makes distance hysteresis
   * unnecessary -- see the header.
   */
  maxCachedChunks: 512,
  maxBuildsPerFrame: 12,
} as const;

export interface ChunkStreamerStats {
  live: number;
  cached: number;
  queued: number;
  inFlight: number;
  generated: number;
  cancelledRequests: number;
  evicted: number;
  workers: number;
  /** Vertex bytes held by live plus cached nodes. */
  bytes: number;
  /** Triangles in the live (in-scene) nodes. GPU-independent, so it is budgetable. */
  triangles: number;
  /** Vertices in the live (in-scene) nodes. */
  vertices: number;
  /** Live nodes carrying a water submesh. Zero everywhere inland. */
  waterNodes: number;
  /** Triangles of water surface in the live nodes. */
  waterTriangles: number;
  /** Live nodes a Phase 3b river channel carved. Zero away from any river. */
  riverNodes: number;
  /** Surface vertices lowered by river carving, across the live nodes. */
  riverVertices: number;
  /** Live nodes a Phase 4a road or settlement surfaces. Zero away from any road. */
  roadNodes: number;
  /** Surface vertices covered by road surfacing, across the live nodes. */
  roadVertices: number;
  /** Live nodes a Phase 4b street surfaces. Zero away from any settlement. */
  streetNodes: number;
  /** Surface vertices covered by street surfacing, across the live nodes. */
  streetVertices: number;
  /** Live nodes carrying a Phase 5 deck submesh. One extra draw call each. */
  deckNodes: number;
  /** Triangles of road and street deck in the live nodes. */
  deckTriangles: number;
  /** Deck vertices standing clear of the ground -- bridges -- in the live nodes. */
  bridgeVertices: number;
  /**
   * Nodes carrying bridge geometry generated since construction. CUMULATIVE, so
   * a flight that crossed one bridge cannot be missed between two samples.
   */
  bridgeNodes: number;
  /** Live nodes carrying a Phase 6 building submesh. One extra draw call each. */
  buildingNodes: number;
  /** Buildings standing in the live nodes, at every level. */
  buildings: number;
  /** Of those, the ones on a lod-0 node -- the denominator of `buildingsLevel`. */
  buildingsMeasured: number;
  /** Of THOSE, how many stand level on their own node's ground. */
  buildingsLevel: number;
  /** Triangles of building geometry in the live nodes. */
  buildingTriangles: number;
  /**
   * Buildings generated since construction. CUMULATIVE, for the reason
   * `bridgeNodes` is: a village is a few hundred metres across in a 4 km region,
   * so a five-second sampling interval can step straight over one.
   */
  buildingsSeen: number;
  /** Nodes the quadtree currently wants resident. */
  selected: number;
  /** Selected nodes per level, index = lod. */
  lodCounts: number[];
  viewDistance: number;
  splitFactor: number;
  /** Coarsest level in play. */
  rootLod: number;
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
   * Keys in `arrived`. Without this, a node that has been delivered but not
   * yet meshed looks absent to `scan()` -- neither live, nor cached, nor
   * requested -- and gets generated a second time.
   */
  private readonly arrivedKeys = new Set<string>();

  /** The current leaf set, keyed. Value is metres to the node's nearest point. */
  private readonly desired = new Map<string, number>();
  /**
   * For every node the descent SPLIT: is its whole subtree resident yet?
   *
   * This is what lets a parent survive exactly as long as it is needed. Drop it
   * the instant it stops being a leaf and a hole opens in the ground until four
   * children arrive; keep it on a distance margin instead and it z-fights with
   * its own children for as long as the camera stays put.
   */
  private readonly subtreeReady = new Map<string, boolean>();

  private selection: QuadtreeSelection = { leaves: [], internal: [], rootLod: 0 };
  private viewDistance: number;
  private splitFactor: number;
  private cameraX = Number.NaN;
  private cameraZ = Number.NaN;
  private centre: ChunkCoord = { x: 0, z: 0, lod: 0 };
  private maxBuildsPerFrame: number;
  private generatedCount = 0;
  private cancelledCount = 0;
  /** Nodes ever generated carrying bridge geometry. Monotone; see `requestChunk`. */
  private bridgeNodeCount = 0;
  /** Buildings ever generated. Monotone, for `bridgeNodeCount`'s reason. */
  private buildingsSeenCount = 0;
  private hasUpdated = false;
  private enabled = true;
  private disposed = false;

  constructor(options: Partial<ChunkStreamerOptions> = {}) {
    const worldSeed = (options.worldSeed ?? 0) >>> 0;
    this.viewDistance = Math.max(64, options.viewDistance ?? DEFAULTS.viewDistance);
    this.splitFactor = Math.max(0.5, options.splitFactor ?? DEFAULTS.splitFactor);
    this.maxBuildsPerFrame = Math.max(1, options.maxBuildsPerFrame ?? DEFAULTS.maxBuildsPerFrame);
    this.onSceneChanged = options.onSceneChanged ?? ((): void => {});

    this.ownsProvider = options.provider === undefined;
    this.provider = options.provider ?? new WorkerPool({ worldSeed });

    this.cache = new LruCache<ChunkMesh>({
      maxEntries: options.maxCachedChunks ?? DEFAULTS.maxCachedChunks,
      onEvict: (_key, entry) => disposeChunkMesh(entry),
    });

    this.root.name = 'chunks';
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

    // Arrivals first, so a freshly built child counts as resident when the
    // retirement pass decides whether its parent may go. Doing it the other way
    // round leaves every split parent alive for one extra frame, overlapping
    // its own children.
    //
    // Note that "was there work" is captured BEFORE the drain: the frame that
    // builds the last outstanding mesh is precisely the frame that must then
    // run the retirement pass, and testing `arrived.length` afterwards skips it
    // -- leaving every superseded node resident until the camera happens to
    // move again.
    const hadArrivals = this.arrived.length > 0;
    this.drainArrivals();

    const moved = cameraPosition.x !== this.cameraX || cameraPosition.z !== this.cameraZ;
    // In the steady state (camera still, nothing outstanding) the selection is
    // by definition unchanged -- it is a pure function of the position -- so
    // there is genuinely nothing to do, and doing nothing is the cheapest way
    // to keep the frame budget and the GC quiet.
    if (moved || !this.hasUpdated || hadArrivals || this.requested.size > 0) {
      this.cameraX = cameraPosition.x;
      this.cameraZ = cameraPosition.z;
      this.centre = worldToChunk(cameraPosition.x, cameraPosition.z);
      this.reselect();
      this.scan();
      this.computeSubtreeReady();
      this.retire();
    }

    this.hasUpdated = true;
  }

  /** Run the quadtree descent for the current camera position. */
  private reselect(): void {
    this.selection = selectQuadtree(this.cameraX, this.cameraZ, {
      viewDistance: this.viewDistance,
      splitFactor: this.splitFactor,
    });
    this.desired.clear();
    for (const leaf of this.selection.leaves) {
      this.desired.set(chunkKey(leaf.coord), leaf.distance);
    }
  }

  /** Walk the selected leaves, nearest first, filling them from cache or provider. */
  private scan(): void {
    let sceneChanged = false;

    for (const leaf of this.selection.leaves) {
      const key = chunkKey(leaf.coord);
      if (this.live.has(key) || this.arrivedKeys.has(key)) continue;

      const cached = this.cache.delete(key);
      if (cached !== undefined) {
        this.live.set(key, cached);
        this.root.add(cached.mesh);
        sceneChanged = true;
        continue;
      }

      if (this.requested.has(key)) {
        this.provider.reprioritize(leaf.coord, leaf.distance);
        continue;
      }
      this.requestChunk(leaf.coord, key, leaf.distance);
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
      // CUMULATIVE, not instantaneous, and that is the point. A bridge is a
      // handful of lod-0 nodes in 6.75 km of flight, resident for about seven
      // seconds as the camera passes; the soak samples every five, so an
      // instantaneous count is a coin flip and a floor built on it would go
      // intermittently red for a run that flew perfectly. This only ever rises,
      // so "the flight generated ground with a bridge on it" cannot be missed
      // between samples.
      if (data.bridgeVertices > 0) this.bridgeNodeCount++;
      this.buildingsSeenCount += data.buildings;
      this.arrived.push(data);
      this.arrivedKeys.add(key);
    });
  }

  /**
   * Roll "is my whole subtree resident" up the split nodes.
   *
   * `selection.internal` is depth-first preorder, so walking it BACKWARDS
   * visits every descendant before its ancestor -- which is exactly the order
   * this roll-up needs and the reason the traversal order is part of
   * `quadtree.ts`'s contract.
   */
  private computeSubtreeReady(): void {
    this.subtreeReady.clear();
    const internal = this.selection.internal;
    for (let i = internal.length - 1; i >= 0; i--) {
      const coord = internal[i] as ChunkCoord;
      const childLod = coord.lod - 1;
      let ready = true;
      for (let corner = 0; corner < 4; corner++) {
        const child = {
          x: coord.x * 2 + (corner & 1),
          z: coord.z * 2 + (corner >> 1),
          lod: childLod,
        };
        const childKey = chunkKey(child);
        const sub = this.subtreeReady.get(childKey);
        if (sub !== undefined) {
          if (!sub) ready = false;
          continue;
        }
        // A selected leaf must be resident. A child the descent culled for
        // being out of range is not something to wait for.
        if (this.desired.has(childKey) && !this.live.has(childKey)) ready = false;
      }
      this.subtreeReady.set(chunkKey(coord), ready);
    }
  }

  /**
   * Whether whatever replaced a no-longer-selected node is resident yet.
   *
   * `true`  -- covered and the replacement is up; release it now.
   * `false` -- covered but the replacement is still streaming; hold on.
   * `null`  -- nothing replaced it, because it left the view distance entirely.
   *            Also release: there is nothing to wait for. Distinguished from
   *            `true` only so the reason a node was let go stays readable here.
   */
  private coverageReady(coord: ChunkCoord): boolean | null {
    const key = chunkKey(coord);
    const split = this.subtreeReady.get(key);
    if (split !== undefined) return split;

    // Merged away: some ancestor is now a leaf.
    let ancestor = coord;
    for (let lod = coord.lod; lod < this.selection.rootLod; lod++) {
      ancestor = nodeParent(ancestor);
      const ancestorKey = chunkKey(ancestor);
      if (this.desired.has(ancestorKey)) return this.live.has(ancestorKey);
    }

    // Not under any selected leaf, but it may still CONTAIN some -- which is
    // what happens to a stale coarse node when the view distance is turned down
    // and the whole tree gets shallower. It must not be released until they are
    // all resident, or the panel's slider punches a hole in the world.
    if (coord.lod === 0) return null;
    let contains = false;
    let allResident = true;
    for (const leaf of this.selection.leaves) {
      if (!isDescendantOrSelf(leaf.coord, coord)) continue;
      contains = true;
      if (!this.live.has(chunkKey(leaf.coord))) allResident = false;
    }
    return contains ? allResident : null;
  }

  /** Cancel unwanted requests and retire nodes that are no longer selected. */
  private retire(): void {
    for (const key of [...this.requested]) {
      if (this.desired.has(key)) continue;
      // No longer wanted. Dropping it here is what stops the queue growing
      // without bound behind a fast camera, and unlike Phase 2a's radius test
      // it fires constantly, because every split and merge invalidates work.
      this.requested.delete(key);
      this.provider.cancel(parseChunkKey(key));
    }

    let sceneChanged = false;
    for (const [key, entry] of [...this.live]) {
      if (this.desired.has(key)) continue;
      // `false` -- and only `false` -- means something selected is still
      // streaming in over this node's ground. Everything else goes now.
      if (this.coverageReady(parseChunkKey(key)) === false) continue;

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
      if (this.desired.size > 0 && !this.desired.has(key)) {
        // Arrived after the camera left, or after a split invalidated it. Park
        // it rather than show it.
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

  // -- state ----------------------------------------------------------------

  /**
   * True when the world around the camera is fully resident: nothing queued,
   * nothing in flight, nothing waiting to be meshed, and every selected node
   * actually in the scene.
   *
   * `window.__worldReady` waits on this, which is what keeps canonical
   * screenshots byte-comparable now that content arrives asynchronously and at
   * several levels of detail.
   */
  get settled(): boolean {
    if (!this.enabled) return true;
    if (!this.hasUpdated || this.requested.size > 0 || this.arrived.length > 0) return false;
    for (const key of this.desired.keys()) if (!this.live.has(key)) return false;
    return true;
  }

  get liveCount(): number {
    return this.live.size;
  }

  /** Nodes the quadtree currently wants resident. */
  get selectedCount(): number {
    return this.desired.size;
  }

  /**
   * Coordinates of every node currently in the scene.
   *
   * Exists so tests can assert the two properties a quadtree streamer has to
   * hold at all times and which nothing else can observe: no point of ground
   * under the camera is ever covered by zero nodes (a hole), and once settled
   * no point is covered by more than one (an overlap).
   */
  liveCoords(): ChunkCoord[] {
    return [...this.live.keys()].map(parseChunkKey);
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

  /** Metres of terrain kept resident around the camera. */
  get view(): number {
    return this.viewDistance;
  }

  setViewDistance(metres: number): void {
    const next = Math.max(64, Math.round(metres));
    if (next === this.viewDistance) return;
    this.viewDistance = next;
    this.hasUpdated = false;
  }

  get split(): number {
    return this.splitFactor;
  }

  setSplitFactor(factor: number): void {
    const next = Math.max(0.5, factor);
    if (next === this.splitFactor) return;
    this.splitFactor = next;
    this.hasUpdated = false;
  }

  stats(): ChunkStreamerStats {
    const providerStats = this.provider.stats;
    let bytes = 0;
    let triangles = 0;
    let vertices = 0;
    let waterNodes = 0;
    let waterTriangles = 0;
    let riverNodes = 0;
    let riverVertices = 0;
    let roadNodes = 0;
    let roadVertices = 0;
    let streetNodes = 0;
    let streetVertices = 0;
    let deckNodes = 0;
    let deckTriangles = 0;
    let bridgeVertices = 0;
    let buildingNodes = 0;
    let buildings = 0;
    let buildingsMeasured = 0;
    let buildingsLevel = 0;
    let buildingTriangles = 0;
    for (const entry of this.live.values()) {
      bytes += entry.bytes;
      triangles += entry.triangles;
      vertices += entry.vertices;
      if (entry.waterTriangles > 0) {
        waterNodes++;
        waterTriangles += entry.waterTriangles;
      }
      if (entry.riverVertices > 0) {
        riverNodes++;
        riverVertices += entry.riverVertices;
      }
      if (entry.roadVertices > 0) {
        roadNodes++;
        roadVertices += entry.roadVertices;
      }
      if (entry.streetVertices > 0) {
        streetNodes++;
        streetVertices += entry.streetVertices;
      }
      if (entry.deckTriangles > 0) {
        deckNodes++;
        deckTriangles += entry.deckTriangles;
        bridgeVertices += entry.bridgeVertices;
      }
      if (entry.buildings > 0) {
        buildingNodes++;
        buildings += entry.buildings;
        buildingsMeasured += entry.buildingsMeasured;
        buildingsLevel += entry.buildingsLevel;
        buildingTriangles += entry.buildingTriangles;
      }
    }
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
      triangles,
      vertices,
      waterNodes,
      waterTriangles,
      riverNodes,
      riverVertices,
      roadNodes,
      roadVertices,
      streetNodes,
      streetVertices,
      deckNodes,
      deckTriangles,
      bridgeVertices,
      bridgeNodes: this.bridgeNodeCount,
      buildingNodes,
      buildings,
      buildingsMeasured,
      buildingsLevel,
      buildingTriangles,
      buildingsSeen: this.buildingsSeenCount,
      selected: this.desired.size,
      lodCounts: lodHistogram(this.selection.leaves, this.selection.rootLod),
      viewDistance: this.viewDistance,
      splitFactor: this.splitFactor,
      rootLod: this.selection.rootLod,
      centre: this.centre,
      settled: this.settled,
    };
  }

  /**
   * Colours of specific nodes as they are actually resident, or null where the
   * node is not loaded.
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

  /**
   * Hashes of specific nodes' uploaded geometry as it is actually resident, or
   * null where the node is not loaded. Terrain vertices, water vertices and the
   * water's depth shading, in one number -- see `hashChunkGeometry`.
   *
   * This is the RULE 2 round-trip check the soak test runs: fly away, fly back,
   * and assert the geometry came back with the same bits. It supersedes the
   * Phase 1 colour comparison, which could only ever prove that the coordinate
   * hash was pure -- geometry is the thing that is expensive to reproduce and
   * therefore the thing worth proving reproducible.
   */
  sampleGeometryHashes(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.geometryHash;
    });
  }

  /**
   * Water triangles in specific nodes as they are actually resident, or null
   * where the node is not loaded.
   *
   * THE ANTI-VACUITY HALF OF THE ROUND-TRIP CHECK. `sampleGeometryHashes` folds
   * the water buffers into its hash, so it proves water regenerates identically
   * -- but only if there was any water there to begin with. Over dry ground the
   * water half of every hash is the hash of an empty array and the check passes
   * while proving nothing about water at all. The soak reads this and fails if
   * the chunks it round-tripped had no sea in them.
   */
  sampleWaterTriangles(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.waterTriangles;
    });
  }

  /**
   * Road-surfaced vertices in specific nodes as they are actually resident, or
   * null where the node is not loaded.
   *
   * The same anti-vacuity role `sampleWaterTriangles` plays for the sea. The
   * geometry hash covers graded ground automatically -- grading moves the very
   * vertices it hashes -- but only if the round-tripped square had a road in it,
   * and over ordinary hillside it does not. The soak fails if none of the chunks
   * it round-tripped carried one.
   */
  sampleRoadVertices(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.roadVertices;
    });
  }

  /**
   * Street-surfaced vertices in specific nodes, as above. Phase 4b's Sector-tier
   * equivalent of `sampleRoadVertices`, and the one with the weakest signal --
   * a settlement is a couple of hundred metres across in a 4 km region, so a
   * flight can cross several roads without touching a village.
   */
  sampleStreetVertices(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.streetVertices;
    });
  }

  /**
   * Deck triangles in specific nodes, as above. Phase 5's equivalent of
   * `sampleWaterTriangles`, and it is the water one rather than the road one for
   * a reason: a deck is separate geometry, so this is a claim about a submesh
   * that exists, not about vertices somebody moved.
   *
   * The geometry hash folds `deckPositions` in, so this is what says that hash
   * was a claim about the carriageway and not only about the ground under it.
   */
  sampleDeckTriangles(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.deckTriangles;
    });
  }

  /**
   * Buildings in specific nodes, as above. Phase 6's equivalent of
   * `sampleDeckTriangles`, and the one with the weakest signal of the lot.
   *
   * `sampleGeometryHashes` folds `buildingPositions` in, so a round trip proves
   * a village comes back identical -- but over ground with no village in it the
   * building half of every hash is the hash of an empty array, and the check
   * passes having said nothing about buildings. This is what the soak reads to
   * refuse that.
   */
  sampleBuildings(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.buildings;
    });
  }

  /**
   * River-carved vertices in specific nodes, as above. Phase 4a's road
   * equivalent is `sampleRoadVertices`, immediately before this.
   */
  sampleRiverVertices(coords: readonly ChunkCoord[]): (number | null)[] {
    return coords.map((coord) => {
      const key = chunkKey(coord);
      const entry = this.live.get(key) ?? this.cache.peek(key);
      return entry === undefined ? null : entry.riverVertices;
    });
  }

  /**
   * lod-0 coordinates in a square around a world position. For the soak test.
   *
   * Deliberately lod 0 and deliberately small: with `splitFactor` 2.5 the
   * finest level extends about 320 m from the camera, so a two-node radius is
   * comfortably inside it and the sampled set does not flip level when the
   * camera lands a couple of metres from where it started. A wider square would
   * straddle the lod-0/lod-1 boundary and the round-trip comparison would go
   * flaky for reasons that have nothing to do with determinism.
   */
  static coordsAround(worldX: number, worldZ: number, radius: number): ChunkCoord[] {
    const centre = worldToChunk(worldX, worldZ);
    const coords: ChunkCoord[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        coords.push({ x: centre.x + dx, z: centre.z + dz, lod: 0 });
      }
    }
    return coords;
  }

  /** Destroy every resident and cached node. They regenerate identically. */
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
      'lod',
      () => {
        const s = this.stats();
        return `${s.selected} nodes  [${s.lodCounts.join(' ')}]  ${s.viewDistance} m`;
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
      'chunk geo',
      () => {
        const s = this.stats();
        return `${s.triangles} tris / ${s.vertices} verts live`;
      },
      HudOrder.world,
    );
    hud.register(
      'water',
      () => {
        const s = this.stats();
        return `${s.waterNodes} nodes / ${s.waterTriangles} tris live`;
      },
      HudOrder.world,
    );
    hud.register(
      'roads',
      () => {
        const s = this.stats();
        return `${s.roadNodes} nodes / ${s.roadVertices} surfaced verts live`;
      },
      HudOrder.world,
    );
    hud.register(
      'streets',
      () => {
        const s = this.stats();
        return `${s.streetNodes} nodes / ${s.streetVertices} surfaced verts live`;
      },
      HudOrder.world,
    );
    hud.register(
      'decks',
      () => {
        const s = this.stats();
        return `${s.deckNodes} nodes / ${s.deckTriangles} tris / ${s.bridgeVertices} bridge verts live / ${s.bridgeNodes} bridge nodes seen`;
      },
      HudOrder.world,
    );
    hud.register(
      'buildings',
      () => {
        const s = this.stats();
        return `${s.buildingNodes} nodes / ${s.buildings} live (${s.buildingsLevel} of ${s.buildingsMeasured} level) / ${s.buildingTriangles} tris / ${s.buildingsSeen} seen`;
      },
      HudOrder.world,
    );
    hud.register(
      'rivers',
      () => {
        const s = this.stats();
        return `${s.riverNodes} nodes / ${s.riverVertices} carved verts live`;
      },
      HudOrder.world,
    );
    hud.register(
      'chunk mem',
      () => `${(this.stats().bytes / 1048576).toFixed(1)} MB vertex data`,
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
      'view distance (m)',
      () => this.view,
      (value) => this.setViewDistance(value),
      { min: 256, max: 8192, step: 128 },
    );
    folder.addNumber(
      'split factor',
      () => this.split,
      (value) => this.setSplitFactor(value),
      { min: 1, max: 6, step: 0.1 },
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
