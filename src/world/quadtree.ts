/**
 * Quadtree node selection: which nodes, at which level, should be resident.
 *
 * Pure arithmetic on coordinates. No Three.js, no DOM, no state -- so it runs in
 * a Node unit test exactly as it runs in the browser, and so the whole thing can
 * be asserted as a function rather than observed as a behaviour.
 *
 * WHAT THIS IS FOR. Profiling Phase 2a on real hardware (Intel Arc 140V,
 * 1080p) found frame time was never the problem: 1.46 ms median GPU render for
 * the full scene. What broke were DRAW CALLS and HEAP -- 1,834 calls and 504 MB
 * at a 3 km flat-LOD radius. So this quadtree exists to bound NODE COUNT, not
 * triangle throughput. `SEGMENTS` is deliberately constant across levels
 * (`chunk-gen.ts`), which means every node costs the same bytes and the same
 * triangles whatever area it covers, which in turn means node count is the only
 * quantity worth bounding. A quadtree tuned for triangle reduction would look
 * different; this one is not that.
 *
 * THE RULE. From roots covering the view distance, split a node while
 *
 *     distance(camera, nodeCentre) < splitFactor * nodeSize   and   lod > 0
 *
 * and keep any node whose square comes within `viewDistance` of the camera.
 *
 * DETERMINISM, AND WHY THE SPLIT TEST HAS NO HYSTERESIS. The result is a pure
 * function of `(cameraX, cameraZ, viewDistance, splitFactor)` and nothing else
 * -- not of call history, not of what is currently resident, not of the
 * direction the camera arrived from. That matters beyond tidiness: if the split
 * test were hysteretic, the set of resident nodes would depend on the path
 * taken to a position, and both the soak's round-trip check and every settled
 * screenshot would become path-dependent. Per-node CONTENT would still be
 * deterministic (RULE 1 lives in `chunk-gen.ts`), but the resident SET would
 * drift, and that is enough to make the harness unreliable.
 *
 * Hysteresis therefore lives entirely in the streamer, and only on the unload
 * side: a node may outlive its selection, but nothing may be selected because
 * of where the camera has been.
 *
 * DISTANCE IS HORIZONTAL. Splitting uses the camera's XZ distance to the node
 * centre, ignoring altitude. Using 3D distance to a node centre placed at y=0
 * looks more principled and behaves worse: standing on a 300 m peak would push
 * the ground under your own feet to lod 2, because the camera is 300 m from a
 * point that is nowhere near the surface. Node count is bounded identically
 * either way -- the selected disc has the same radius at any altitude -- so the
 * horizontal form costs nothing and avoids the artifact.
 */

import { CHUNK_SIZE, chunkSizeAt, type ChunkCoord } from './contracts';

/**
 * Hard ceiling on quadtree depth, i.e. on how coarse a root may be.
 * `CHUNK_SIZE << 10` is 65 km, far past any plausible view distance; it exists
 * so a nonsense `viewDistance` produces a clamp rather than an infinite loop.
 */
export const MAX_LOD = 10;

/**
 * Default view distance in metres. Seven levels: 64, 128, 256, 512, 1024, 2048,
 * 4096 -- so the roots are exactly one level above the view distance.
 */
export const DEFAULT_VIEW_DISTANCE = 4096;

/**
 * Default split aggressiveness. A node splits while the camera is inside
 * `splitFactor * nodeSize` of its centre.
 *
 * 2.5 was chosen by measurement, not taste: it is the smallest value at which a
 * level switch is not obviously visible at 1080p (see PROGRESS.md), and it
 * lands the resident set around 300-350 nodes at 4 km. Raising it improves
 * fidelity and multiplies node count by roughly its square; lowering it saves
 * nodes the budget does not need and starts to pop.
 */
export const DEFAULT_SPLIT_FACTOR = 2.5;

export interface QuadtreeNode {
  readonly coord: ChunkCoord;
  /**
   * Metres from the camera to the NEAREST POINT of the node's square, not to
   * its centre. This is the streaming priority: it is what "how urgently do I
   * need this" means for a node whose area may be 4 km across.
   */
  readonly distance: number;
}

export interface QuadtreeSelection {
  /** The leaves: a gapless, non-overlapping cover of the view disc. Nearest first. */
  readonly leaves: QuadtreeNode[];
  /**
   * Nodes that were split, in depth-first PREORDER (a parent always precedes
   * its descendants).
   *
   * The streamer walks this in reverse to decide when a node that has been
   * split may be released: reverse preorder visits every descendant before its
   * ancestor, which is exactly the order a "is my whole subtree resident yet"
   * roll-up needs.
   */
  readonly internal: ChunkCoord[];
  /** Level of the roots the descent started from. */
  readonly rootLod: number;
}

export interface QuadtreeOptions {
  viewDistance: number;
  splitFactor: number;
}

/** The coarsest level in play: the smallest node that covers the view distance. */
export function rootLodFor(viewDistance: number): number {
  let lod = 0;
  while (lod < MAX_LOD && chunkSizeAt(lod) < viewDistance) lod++;
  return lod;
}

/** The node one level coarser that contains `coord`. */
export function nodeParent(coord: ChunkCoord): ChunkCoord {
  return { x: Math.floor(coord.x / 2), z: Math.floor(coord.z / 2), lod: coord.lod + 1 };
}

/**
 * The four nodes one level finer that tile `coord`, in a fixed order.
 *
 * The order is part of the contract: it is what makes the selection's traversal
 * order, and therefore the request order handed to the worker pool, reproduce
 * exactly between runs.
 */
export function nodeChildren(coord: ChunkCoord): [ChunkCoord, ChunkCoord, ChunkCoord, ChunkCoord] {
  const x = coord.x * 2;
  const z = coord.z * 2;
  const lod = coord.lod - 1;
  return [
    { x, z, lod },
    { x: x + 1, z, lod },
    { x, z: z + 1, lod },
    { x: x + 1, z: z + 1, lod },
  ];
}

/** True when `candidate` is `coord` or lies inside it. */
export function isDescendantOrSelf(candidate: ChunkCoord, coord: ChunkCoord): boolean {
  if (candidate.lod > coord.lod) return false;
  const shift = coord.lod - candidate.lod;
  return (candidate.x >> shift) === coord.x && (candidate.z >> shift) === coord.z;
}

/** Metres from a world-space XZ point to the nearest point of a node's square. */
export function distanceToNode(worldX: number, worldZ: number, coord: ChunkCoord): number {
  const size = chunkSizeAt(coord.lod);
  const minX = coord.x * size;
  const minZ = coord.z * size;
  const dx = Math.max(minX - worldX, 0, worldX - (minX + size));
  const dz = Math.max(minZ - worldZ, 0, worldZ - (minZ + size));
  return Math.sqrt(dx * dx + dz * dz);
}

/** Metres from a world-space XZ point to a node's centre. */
export function distanceToNodeCenter(worldX: number, worldZ: number, coord: ChunkCoord): number {
  const size = chunkSizeAt(coord.lod);
  const dx = coord.x * size + size / 2 - worldX;
  const dz = coord.z * size + size / 2 - worldZ;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Select the resident node set for a camera position.
 *
 * Deliberately allocates fresh arrays and coordinate objects rather than
 * recycling a buffer. It runs once per frame over roughly 300 leaves and 100
 * internal nodes, which is a few microseconds and a few hundred short-lived
 * objects -- and recycled mutable coordinates handed out to a caller is exactly
 * the kind of cleverness that produces a bug nobody can reproduce.
 */
export function selectQuadtree(
  cameraX: number,
  cameraZ: number,
  options: QuadtreeOptions,
): QuadtreeSelection {
  const viewDistance = Math.max(CHUNK_SIZE, options.viewDistance);
  const splitFactor = Math.max(0.5, options.splitFactor);
  const root = rootLodFor(viewDistance);
  const rootSize = chunkSizeAt(root);

  const leaves: QuadtreeNode[] = [];
  const internal: ChunkCoord[] = [];

  const visit = (coord: ChunkCoord): void => {
    const distance = distanceToNode(cameraX, cameraZ, coord);
    // Culled by the nearest point of the square, so a node is dropped only when
    // the whole of it is outside the view disc. Culling by the centre would
    // punch holes in the cover at the boundary.
    if (distance > viewDistance) return;

    if (coord.lod > 0) {
      const size = chunkSizeAt(coord.lod);
      if (distanceToNodeCenter(cameraX, cameraZ, coord) < splitFactor * size) {
        internal.push(coord);
        for (const child of nodeChildren(coord)) visit(child);
        return;
      }
    }
    leaves.push({ coord, distance });
  };

  const minRootX = Math.floor((cameraX - viewDistance) / rootSize);
  const maxRootX = Math.floor((cameraX + viewDistance) / rootSize);
  const minRootZ = Math.floor((cameraZ - viewDistance) / rootSize);
  const maxRootZ = Math.floor((cameraZ + viewDistance) / rootSize);
  for (let z = minRootZ; z <= maxRootZ; z++) {
    for (let x = minRootX; x <= maxRootX; x++) visit({ x, z, lod: root });
  }

  // Nearest first, so the most urgent requests reach the worker pool first.
  // Ties are broken by coordinate, never by traversal accident, so the request
  // order is reproducible run to run.
  leaves.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.coord.lod - b.coord.lod ||
      a.coord.z - b.coord.z ||
      a.coord.x - b.coord.x,
  );

  return { leaves, internal, rootLod: root };
}

/** Count of leaves per level, index = lod. For the HUD and the soak. */
export function lodHistogram(leaves: readonly QuadtreeNode[], levels: number): number[] {
  const counts = new Array<number>(levels + 1).fill(0);
  for (const leaf of leaves) {
    const lod = Math.min(leaf.coord.lod, levels);
    counts[lod] = (counts[lod] as number) + 1;
  }
  return counts;
}
