/**
 * World generation contracts.
 *
 * This file is load-bearing from Phase 2 onwards: every generator, worker and
 * streamer talks in these types. It is deliberately free of Three.js and of
 * anything DOM-specific so that it can be imported from a Web Worker, from a
 * unit test in Node, and from the main thread without dragging a renderer along.
 *
 * Two architectural rules are encoded here rather than left to convention:
 *
 *  - RULE 1 (determinism). Everything a generator receives arrives through
 *    `TierContext`: a world seed and read-only coarser-tier data. There is no
 *    ambient state, no clock, and no way to observe visit order, so the same
 *    `(worldSeed, coord)` can only ever produce the same bytes.
 *
 *  - RULE 3 (tier direction). `Region (4km) -> Sector (512m) -> Chunk (64m)`.
 *    A finer tier may read coarser tiers; a coarser tier may never read a finer
 *    one. `TierContext.coarser()` throws rather than returning undefined when
 *    that rule is broken, because a silently-undefined read would surface much
 *    later as a mysterious non-determinism bug.
 *
 * Phase 1 only implements the Chunk tier. Region and Sector are declared here so
 * that Phases 2-4 add generators rather than reshaping this file.
 *
 * ---------------------------------------------------------------------------
 * ONE AUTHORISED RESHAPE, PHASE 2a
 *
 * `ChunkCoord` gained `lod`, and `chunkKey` gained it as a third component.
 * This was reviewed and approved once, at the phase that forced it, and is now
 * settled. The reason it happened here rather than in Phase 2b (which is what
 * actually needs it) is that a chunk key is a persisted, cached, cross-thread
 * identity: adding a component to it later would silently alias a lod-0 chunk
 * with a lod-2 node covering the same square, and the symptom would be a
 * corrupted cache rather than a compile error.
 *
 * Throughout Phase 2a `lod` is always 0. It exists so that Phase 2b adds
 * behaviour without touching this file again. Do not treat it as licence for
 * further reshaping: RULE 4 still stands.
 */

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** Metres along one axis of one cell, per tier. */
export const REGION_SIZE = 4096;
export const SECTOR_SIZE = 512;
export const CHUNK_SIZE = 64;

/** Coarse to fine. Index in this array is the tier's depth. */
export const TIER_NAMES = ['region', 'sector', 'chunk'] as const;

export type TierName = (typeof TIER_NAMES)[number];

export const TIER_SIZE: Readonly<Record<TierName, number>> = {
  region: REGION_SIZE,
  sector: SECTOR_SIZE,
  chunk: CHUNK_SIZE,
};

/** 0 for the coarsest tier, increasing as tiers get finer. */
export function tierDepth(tier: TierName): number {
  return TIER_NAMES.indexOf(tier);
}

/** True when `candidate` is strictly coarser than `tier` (RULE 3). */
export function isCoarserThan(candidate: TierName, tier: TierName): boolean {
  return tierDepth(candidate) < tierDepth(tier);
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/**
 * Integer cell coordinates on the horizontal plane. The three are structurally
 * identical on purpose -- they are separate names so that function signatures
 * document which tier they mean, not so the compiler can police it.
 *
 * Y is absent: the world is a heightfield, and chunks are columns.
 */
export interface ChunkCoord {
  readonly x: number;
  readonly z: number;
  /**
   * Quadtree level. `0` is the finest tier -- one 64 m cell -- and a node at
   * `lod` covers `CHUNK_SIZE << lod` metres, so `x` and `z` are indices in that
   * node's own grid, not in the lod-0 grid.
   *
   * Phase 2a always passes 0. Phase 2b is what makes it vary.
   */
  readonly lod: number;
}

export interface SectorCoord {
  readonly x: number;
  readonly z: number;
}

export interface RegionCoord {
  readonly x: number;
  readonly z: number;
}

/** Metres along one axis of a quadtree node at `lod`. `lod` 0 is `CHUNK_SIZE`. */
export function chunkSizeAt(lod: number): number {
  return CHUNK_SIZE * 2 ** lod;
}

/**
 * Map key for a chunk. Stable, sortable, and cheap to parse back.
 *
 * `lod` is part of the key, not an afterthought: two nodes at different levels
 * can share `(x, z)` while covering completely different squares, so leaving it
 * out would let them collide in the streamer's maps and in the worker pool's
 * job table.
 */
export function chunkKey(coord: ChunkCoord): string {
  return `${coord.x},${coord.z},${coord.lod}`;
}

/** Inverse of `chunkKey`. Throws on anything it did not produce. */
export function parseChunkKey(key: string): ChunkCoord {
  const parts = key.split(',');
  if (parts.length !== 3) throw new Error(`Not a chunk key: ${JSON.stringify(key)}`);
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  const lod = Number(parts[2]);
  if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(lod) || lod < 0) {
    throw new Error(`Not a chunk key: ${JSON.stringify(key)}`);
  }
  return { x, z, lod };
}

/** Floor division that behaves correctly for negative coordinates. */
function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/** Which node at `lod` contains a world-space point. */
export function worldToChunk(worldX: number, worldZ: number, lod = 0): ChunkCoord {
  const size = chunkSizeAt(lod);
  return { x: floorDiv(worldX, size), z: floorDiv(worldZ, size), lod };
}

/**
 * World-space position of a node's minimum (-X, -Z) corner, in metres.
 *
 * The `lod` parameter defaults to the coordinate's own level rather than to a
 * literal 0. A separate default would be a second source of truth for a value
 * the coordinate already carries, and in Phase 2b that is precisely how a
 * coarse node ends up drawn at a fine node's origin. Passing it explicitly is
 * still available for callers that hold a bare `(x, z)` pair.
 */
export function chunkOrigin(coord: ChunkCoord, lod: number = coord.lod): { x: number; z: number } {
  const size = chunkSizeAt(lod);
  return { x: coord.x * size, z: coord.z * size };
}

/** World-space position of a node's centre, in metres. See `chunkOrigin` on `lod`. */
export function chunkCenter(coord: ChunkCoord, lod: number = coord.lod): { x: number; z: number } {
  const size = chunkSizeAt(lod);
  return { x: coord.x * size + size / 2, z: coord.z * size + size / 2 };
}

/**
 * The sector containing a chunk (RULE 3: fine reads coarse, never the reverse).
 *
 * Defined for `lod` 0 coordinates. A coarser quadtree node can span several
 * sectors, so there is no single answer for one; Phase 2b should ask this of
 * the node's corners, not of the node.
 */
export function chunkToSector(coord: ChunkCoord): SectorCoord {
  const ratio = SECTOR_SIZE / CHUNK_SIZE;
  return { x: floorDiv(coord.x, ratio), z: floorDiv(coord.z, ratio) };
}

/** The region containing a sector. */
export function sectorToRegion(coord: SectorCoord): RegionCoord {
  const ratio = REGION_SIZE / SECTOR_SIZE;
  return { x: floorDiv(coord.x, ratio), z: floorDiv(coord.z, ratio) };
}

// ---------------------------------------------------------------------------
// Tier context
// ---------------------------------------------------------------------------

/**
 * Everything a generator at one tier is permitted to see.
 *
 * Phase 1 constructs these with no coarse data at all. Phases 2-4 pass the
 * already-generated region and sector records in, and chunk generators read
 * them through `coarser()`. The shape does not change when they do.
 */
export interface TierContext {
  /** uint32 world seed. The only entropy any generator is allowed to use. */
  readonly worldSeed: number;
  /** Which tier is being generated. */
  readonly tier: TierName;
  /** Metres along one axis of a cell at `tier`. */
  readonly cellSize: number;
  /**
   * Read data produced by a strictly coarser tier.
   *
   * Throws when asked for the current tier or a finer one -- that is a RULE 3
   * violation and must fail loudly at the call site rather than quietly
   * returning undefined. Returns undefined when the tier is legal but no data
   * was supplied (the normal Phase 1 case).
   */
  coarser<T>(tier: TierName): T | undefined;
}

export type CoarseData = Partial<Record<TierName, unknown>>;

export function createTierContext(
  worldSeed: number,
  tier: TierName,
  coarse: CoarseData = {},
): TierContext {
  return {
    worldSeed: worldSeed >>> 0,
    tier,
    cellSize: TIER_SIZE[tier],
    coarser<T>(requested: TierName): T | undefined {
      if (!isCoarserThan(requested, tier)) {
        throw new Error(
          `Tier rule violation: a '${tier}' generator may not read '${requested}'. ` +
            'Coarse tiers must never depend on finer ones.',
        );
      }
      return coarse[requested] as T | undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Chunk payload
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the binary layout of `ChunkData` changes, so a cached or
 * in-flight payload from an older build can be rejected instead of
 * misinterpreted.
 */
export const CHUNK_DATA_VERSION = 9;

/**
 * The result of generating one chunk.
 *
 * Everything bulk is a typed array so the payload can cross a `postMessage`
 * boundary as a transfer rather than a copy. Keep it that way: adding a plain
 * JS array of per-vertex data here would silently reintroduce structured
 * cloning of the whole mesh.
 */
export interface ChunkData {
  readonly version: number;
  readonly coord: ChunkCoord;
  /** The seed this was generated with. Guards against a stale cache after `?seed=` changes. */
  readonly worldSeed: number;
  /**
   * Vertex positions, xyz triples. X and Z are node-local metres
   * (`0..chunkSizeAt(coord.lod)`) so precision stays usable far from the
   * origin; Y is absolute world height, because the mesh is placed at y = 0.
   */
  readonly positions: Float32Array;
  /** Triangle indices into `positions`. */
  readonly indices: Uint32Array;
  /** Unit surface normals, xyz triples, one per vertex. */
  readonly normals: Float32Array;
  /** Per-vertex colour, rgb triples, LINEAR (not sRGB) in [0, 1]. */
  readonly colors: Float32Array;
  /**
   * Water surface vertex positions, xyz triples, in the same node-local frame
   * as `positions`. Y is always exactly `SEA_LEVEL`.
   *
   * ZERO-LENGTH ON A NODE WITH NO WATER, which is most of them. An inland node
   * must cost no water draw call and no water bytes -- that discipline is what
   * keeps a whole-world water surface off the draw-call budget, and it is the
   * reason these are separate arrays rather than a flag on the terrain mesh.
   */
  readonly waterPositions: Float32Array;
  /**
   * Water vertex colour, rgbA quadruples: linear rgb plus an alpha derived from
   * depth. FOUR components, not three -- Three.js only takes opacity from a
   * vertex colour attribute whose `itemSize` is 4.
   */
  readonly waterColors: Float32Array;
  /** Triangle indices into `waterPositions`. */
  readonly waterIndices: Uint32Array;
  /**
   * Surface vertices this node's terrain was measurably LOWERED at by a Phase
   * 3b river channel. Zero on a node no river passes near, which is most.
   *
   * A scalar, not a buffer, so it changes nothing about the transfer list. It
   * exists because rivers are carved into the same terrain mesh as everything
   * else: without a count there is no way to tell "no river here" from "river
   * carving silently stopped working", and every river check in the soak and in
   * the screenshot harness would keep passing while proving nothing. That trap
   * has caught this project five times; see PROGRESS.md.
   */
  readonly riverVertices: number;
  /**
   * Surface vertices this node's terrain was measurably MOVED at by Phase 4a
   * road or settlement grading, in either direction. Zero on a node no road
   * passes near, which is most.
   *
   * A scalar, for exactly the reason `riverVertices` is one: grading is applied
   * to the terrain mesh every node already had, so there is no submesh whose
   * presence answers "did this happen". Without a count, "the flight never went
   * near a road" and "grading silently returns zero" produce identical evidence.
   */
  readonly roadVertices: number;
  /**
   * Surface vertices covered by a Phase 4b SECTOR-tier street, as opposed to a
   * Region-tier road or settlement pad. Zero on a node no village reaches.
   *
   * A THIRD scalar rather than a wider definition of `roadVertices`, and that is
   * the whole point of it. A village pad already surfaces its own ground, so
   * `roadVertices` is non-zero across an entire settlement before a single
   * street exists -- "the flight passed a village" and "street layout silently
   * returns nothing" would produce identical evidence, which is exactly the
   * quietly-passing check this project has been caught by five times. This
   * counts only the street corridors themselves.
   */
  readonly streetVertices: number;
  /**
   * The Phase 5 road and street DECK: the made carriageway surface, as its own
   * submesh, in the same node-local frame as `positions`.
   *
   * ZERO-LENGTH ON A NODE NO ROAD OR STREET REACHES, which is most of them, and
   * that discipline is what keeps a deck off the draw-call budget everywhere it
   * is not needed -- exactly the rule `waterPositions` follows. Everything
   * before this phase modified the terrain mesh the node already had; a deck is
   * the first thing since Phase 3a's water that costs a draw call of its own.
   *
   * See `road-mesh.ts` for why a deck is per-chunk geometry rather than one mesh
   * per road: a node's rendered ground is the interpolation of its OWN lattice,
   * so a lod-independent deck sinks into a coarse hillside and floats over a
   * coarse valley.
   */
  readonly deckPositions: Float32Array;
  /** Unit deck normals, xyz triples, one per deck vertex. */
  readonly deckNormals: Float32Array;
  /** Per-deck-vertex colour, rgb triples, LINEAR in [0, 1]. */
  readonly deckColors: Float32Array;
  /** Triangle indices into `deckPositions`. */
  readonly deckIndices: Uint32Array;
  /**
   * Deck stations standing clear of the ground by more than
   * `BRIDGE_CLEARANCE` -- i.e. vertices that are on a bridge. Counted at lod 0
   * only; see `BRIDGE_COUNT_LOD` for why a coarse node would report a number
   * about its own lattice rather than about the world.
   *
   * A scalar, for the reason `riverVertices` is one, and the sharpest example of
   * it yet. A bridge exists only where a road crosses a carved channel, which is
   * a handful of places in a region; without a count, "the flight never crossed a
   * bridge" and "the deck stopped spanning channels" produce identical evidence,
   * and every bridge check ever written would pass on either. It counts what the
   * GEOMETRY did, not what `RoadNetwork.segCrossing` predicted -- a regression in
   * the deck's `max` rule leaves `segCrossing` perfectly intact.
   */
  readonly bridgeVertices: number;
  /**
   * The Phase 6 BUILDINGS of this node, batched into one submesh, in the same
   * node-local frame as `positions`.
   *
   * ZERO-LENGTH ON A NODE WITH NO BUILDING CENTRE IN IT, which is all but a
   * handful in the world -- `waterPositions`' rule again, and the reason this
   * phase costs one draw call in a village and none anywhere else.
   *
   * One buffer for EVERY building in the node rather than one per building: see
   * `building-mesh.ts`. A village node holds dozens, and a mesh each would put
   * fifty draw calls on a node that currently costs three.
   */
  readonly buildingPositions: Float32Array;
  /** Unit building normals, xyz triples, one per building vertex. */
  readonly buildingNormals: Float32Array;
  /** Per-building-vertex colour, rgb triples, LINEAR in [0, 1]. */
  readonly buildingColors: Float32Array;
  /** Triangle indices into `buildingPositions`. */
  readonly buildingIndices: Uint32Array;
  /**
   * Buildings this node owns -- i.e. whose centre lies in its square.
   *
   * Not derivable from the buffers: every building has the same 30 vertices, so
   * a vertex count cannot distinguish "forty houses" from "one enormous one",
   * and the streamer's HUD and the soak both want the object count.
   */
  readonly buildings: number;
  /**
   * Of those, how many stand on ground THIS node renders within
   * `BUILDING_LEVEL_TOLERANCE` of their own floor. Counted at lod 0 only; see
   * `BUILDING_LEVEL_LOD` for why a coarse node would report a number about its
   * own lattice rather than about the world.
   *
   * A scalar, for the reason `riverVertices` and `bridgeVertices` are ones, and
   * it is the anti-vacuity counter of Phase 6. `buildings` says houses were
   * placed; this says they were placed on ground a village actually levelled. A
   * regression in the grading, in `gradeTarget` or in the lot acceptance tests
   * leaves `buildings` untouched and drives this to zero.
   */
  readonly buildingsLevel: number;
  /**
   * The Phase 7a PROPS of this node -- world vegetation and sparse yard clutter
   * -- batched into one submesh, in the same node-local frame as `positions`.
   *
   * ZERO-LENGTH ON A NODE WITH NO PROP CENTRE IN IT, which is most of the world
   * away from forest and settlement. One buffer for EVERY prop in the node
   * rather than one per prop: see `prop-mesh.ts`. A forest lod-0 node holds
   * tens to low hundreds, and a mesh each would put the draw-call budget
   * through the floor.
   */
  readonly propPositions: Float32Array;
  /** Unit prop normals, xyz triples, one per prop vertex. */
  readonly propNormals: Float32Array;
  /** Per-prop-vertex colour, rgb triples, LINEAR in [0, 1]. */
  readonly propColors: Float32Array;
  /** Triangle indices into `propPositions`. */
  readonly propIndices: Uint32Array;
  /**
   * Props this node owns -- i.e. whose centre lies in its square.
   *
   * Not derivable from the buffers: trees and bushes cost different vertex
   * counts, so an object count is what the HUD and the soak want.
   */
  readonly props: number;
  /**
   * Of those, how many stand on ground THIS node renders within
   * `PROP_SEAT_TOLERANCE` of their own base. Counted at lod 0 only; see
   * `PROP_SEAT_LOD`.
   *
   * The anti-vacuity counter of Phase 7a. `props` says vegetation was placed;
   * this says it sits on ground the world actually made. A regression in the
   * stump / seating path leaves `props` untouched and drives this to zero.
   */
  readonly propsSeated: number;
  /**
   * One representative sRGB colour for the whole chunk, derived from the
   * coordinate hash.
   *
   * Nothing renders this since Phase 2a -- the surface uses `colors` -- but it
   * is a stable per-chunk identity that debug readouts and the streamer's
   * colour sampler still use. Cheap, and independent of the terrain, which is
   * what makes it useful for spotting "this is a different chunk" at a glance.
   */
  readonly color: readonly [number, number, number];
  /** Vertical extent in absolute world metres, for bounds and culling. */
  readonly minY: number;
  readonly maxY: number;
}

/** Total transferable bytes in a payload. Used for cache accounting and the HUD. */
export function chunkDataBytes(data: ChunkData): number {
  return (
    data.positions.byteLength +
    data.indices.byteLength +
    data.normals.byteLength +
    data.colors.byteLength +
    data.waterPositions.byteLength +
    data.waterColors.byteLength +
    data.waterIndices.byteLength +
    data.deckPositions.byteLength +
    data.deckNormals.byteLength +
    data.deckColors.byteLength +
    data.deckIndices.byteLength +
    data.buildingPositions.byteLength +
    data.buildingNormals.byteLength +
    data.buildingColors.byteLength +
    data.buildingIndices.byteLength +
    data.propPositions.byteLength +
    data.propNormals.byteLength +
    data.propColors.byteLength +
    data.propIndices.byteLength
  );
}

/**
 * The buffers to hand to `postMessage`'s transfer list.
 *
 * Every bulk array in `ChunkData` must appear here. A buffer that is left out
 * is not an optimisation that was missed -- it is structured-cloned instead,
 * which copies the whole mesh on the worker thread and again on the main
 * thread, every chunk, forever.
 *
 * The empty water buffers of an inland node belong here too. A zero-length
 * `ArrayBuffer` transfers fine, and listing them unconditionally means there is
 * one rule ("every bulk array, always") rather than a conditional that a later
 * phase can get subtly wrong.
 */
export function chunkDataTransferables(data: ChunkData): Transferable[] {
  return [
    data.positions.buffer as ArrayBuffer,
    data.indices.buffer as ArrayBuffer,
    data.normals.buffer as ArrayBuffer,
    data.colors.buffer as ArrayBuffer,
    data.waterPositions.buffer as ArrayBuffer,
    data.waterColors.buffer as ArrayBuffer,
    data.waterIndices.buffer as ArrayBuffer,
    data.deckPositions.buffer as ArrayBuffer,
    data.deckNormals.buffer as ArrayBuffer,
    data.deckColors.buffer as ArrayBuffer,
    data.deckIndices.buffer as ArrayBuffer,
    data.buildingPositions.buffer as ArrayBuffer,
    data.buildingNormals.buffer as ArrayBuffer,
    data.buildingColors.buffer as ArrayBuffer,
    data.buildingIndices.buffer as ArrayBuffer,
    data.propPositions.buffer as ArrayBuffer,
    data.propNormals.buffer as ArrayBuffer,
    data.propColors.buffer as ArrayBuffer,
    data.propIndices.buffer as ArrayBuffer,
  ];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ChunkProviderStats {
  /** Requests accepted but not yet handed to a worker. */
  queued: number;
  /** Requests currently executing on a worker. */
  inFlight: number;
  /** Payloads successfully delivered since construction. */
  completed: number;
  /** Requests dropped before their result was used. */
  cancelled: number;
  /** Size of the worker pool. */
  workers: number;
}

/**
 * Asynchronous source of chunk payloads.
 *
 * The streamer talks to this and nothing else, so a worker pool, a synchronous
 * test double, or a future prebaked-asset reader are interchangeable.
 *
 * Contract:
 *  - `request` for a coord already outstanding returns the *same* promise and
 *    updates its priority; it never starts a second job.
 *  - every promise settles exactly once: with a payload, or with `null` if the
 *    request was cancelled or the provider was disposed.
 *  - lower `priority` runs first. The streamer passes distance to the camera in
 *    metres.
 */
export interface ChunkProvider {
  request(coord: ChunkCoord, priority: number): Promise<ChunkData | null>;
  /** Re-rank a queued request. No-op if it is already running or unknown. */
  reprioritize(coord: ChunkCoord, priority: number): void;
  /** Drop a request. A job already on a worker finishes and its result is discarded. */
  cancel(coord: ChunkCoord): void;
  readonly stats: ChunkProviderStats;
  dispose(): void;
}
