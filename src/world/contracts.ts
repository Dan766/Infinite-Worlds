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
}

export interface SectorCoord {
  readonly x: number;
  readonly z: number;
}

export interface RegionCoord {
  readonly x: number;
  readonly z: number;
}

/** Map key for a chunk. Stable, sortable, and cheap to parse back. */
export function chunkKey(coord: ChunkCoord): string {
  return `${coord.x},${coord.z}`;
}

/** Inverse of `chunkKey`. Throws on anything it did not produce. */
export function parseChunkKey(key: string): ChunkCoord {
  const comma = key.indexOf(',');
  const x = Number(key.slice(0, comma));
  const z = Number(key.slice(comma + 1));
  if (comma < 0 || !Number.isInteger(x) || !Number.isInteger(z)) {
    throw new Error(`Not a chunk key: ${JSON.stringify(key)}`);
  }
  return { x, z };
}

/** Floor division that behaves correctly for negative coordinates. */
function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/** Which chunk contains a world-space point. */
export function worldToChunk(worldX: number, worldZ: number): ChunkCoord {
  return { x: floorDiv(worldX, CHUNK_SIZE), z: floorDiv(worldZ, CHUNK_SIZE) };
}

/** World-space position of a chunk's minimum (-X, -Z) corner, in metres. */
export function chunkOrigin(coord: ChunkCoord): { x: number; z: number } {
  return { x: coord.x * CHUNK_SIZE, z: coord.z * CHUNK_SIZE };
}

/** World-space position of a chunk's centre, in metres. */
export function chunkCenter(coord: ChunkCoord): { x: number; z: number } {
  return {
    x: coord.x * CHUNK_SIZE + CHUNK_SIZE / 2,
    z: coord.z * CHUNK_SIZE + CHUNK_SIZE / 2,
  };
}

/** The sector containing a chunk (RULE 3: fine reads coarse, never the reverse). */
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
export const CHUNK_DATA_VERSION = 1;

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
  /** Vertex positions, xyz triples, in chunk-local metres (0..CHUNK_SIZE on x/z). */
  readonly positions: Float32Array;
  /** Triangle indices into `positions`. */
  readonly indices: Uint32Array;
  /** Flat surface colour, sRGB-encoded RGB in [0, 1]. Derived from the coordinate hash. */
  readonly color: readonly [number, number, number];
  /** Vertical extent in chunk-local metres, for bounds and culling. */
  readonly minY: number;
  readonly maxY: number;
}

/** Total transferable bytes in a payload. Used for cache accounting and the HUD. */
export function chunkDataBytes(data: ChunkData): number {
  return data.positions.byteLength + data.indices.byteLength;
}

/** The buffers to hand to `postMessage`'s transfer list. */
export function chunkDataTransferables(data: ChunkData): Transferable[] {
  return [data.positions.buffer as ArrayBuffer, data.indices.buffer as ArrayBuffer];
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
