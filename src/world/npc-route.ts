/**
 * The walkable graph an NPC routes over, at the SECTOR tier.
 *
 * Phase 9a. `SectorStreets` is a set of CSR polylines meant for grading and for
 * walking a ribbon of deck stations -- it is not a graph, and the same world
 * point is pushed into `nodeX`/`nodeZ` once per street that touches it (a ring
 * closure repeats its first node; a spoke repeats the settlement centre). An
 * NPC needs a graph: one vertex per distinct point, edges where two streets
 * actually meet, so `shortestPath` can route from a house to the market square
 * instead of only ever walking the one polyline it started on.
 *
 * Deliberately pure and Three-free, like every other `world/` module: this
 * makes `birthCrowd`/`stepCrowd` Node-testable, and keeps a later worker-side
 * use (if NPC routing ever needs to run off the main thread) free.
 */

import type { SectorStreets } from './streets';

export interface StreetGraph {
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  readonly nodeY: Float64Array;
  readonly count: number;
  /** CSR adjacency: neighbours of node `n` are `adjTo[adjStart[n] .. adjStart[n+1])`. */
  readonly adjStart: Int32Array;
  readonly adjTo: Int32Array;
  readonly adjWeight: Float64Array;
  /** Graph node nearest the settlement centre, or -1 on an empty graph. */
  readonly centerNode: number;
}

/**
 * Positions are deduplicated on a 1 cm grid rather than compared by exact
 * float equality. Every repeat this module needs to merge (a ring's closing
 * node, a spoke's shared centre) is the SAME computed expression evaluated
 * twice, so exact equality would already work -- the grid exists so two
 * genuinely distinct street plans can never accidentally alias, and reads
 * as intent rather than relying on IEEE-754 giving two identical expressions
 * identical bits (which it does, but that is not the point being made here).
 */
const DEDUPE_GRID = 100;

const EMPTY_GRAPH: StreetGraph = {
  nodeX: new Float64Array(0),
  nodeZ: new Float64Array(0),
  nodeY: new Float64Array(0),
  count: 0,
  adjStart: new Int32Array(1),
  adjTo: new Int32Array(0),
  adjWeight: new Float64Array(0),
  centerNode: -1,
};

/**
 * Build the CSR adjacency arrays for `count` nodes from a flat undirected
 * edge list (both directions already present, as every caller below produces
 * -- see `dedupedIndex`'s and `appendGraphNodes`'s edge pushes).
 *
 * Factored out because `buildStreetGraph` and `appendGraphNodes` both need
 * it: a graph is rebuilt whole rather than mutated (immutable typed arrays,
 * same discipline the rest of `world/` uses), so appending a guard's beat to
 * an existing graph re-derives the CSR the same way building it from streets
 * does, and one implementation is what keeps the two from drifting.
 */
function buildCsr(
  count: number,
  edgeFrom: readonly number[],
  edgeTo: readonly number[],
  x: ArrayLike<number>,
  z: ArrayLike<number>,
): { adjStart: Int32Array; adjTo: Int32Array; adjWeight: Float64Array } {
  const degree = new Int32Array(count);
  for (let e = 0; e < edgeFrom.length; e++) {
    const from = edgeFrom[e] as number;
    degree[from] = (degree[from] as number) + 1;
  }
  const adjStart = new Int32Array(count + 1);
  for (let n = 0; n < count; n++) adjStart[n + 1] = (adjStart[n] as number) + (degree[n] as number);
  const adjTo = new Int32Array(edgeFrom.length);
  const adjWeight = new Float64Array(edgeFrom.length);
  const cursor = Int32Array.from(adjStart.subarray(0, count));
  for (let e = 0; e < edgeFrom.length; e++) {
    const from = edgeFrom[e] as number;
    const to = edgeTo[e] as number;
    const pos = cursor[from] as number;
    cursor[from] = pos + 1;
    adjTo[pos] = to;
    const dx = (x[to] as number) - (x[from] as number);
    const dz = (z[to] as number) - (z[from] as number);
    adjWeight[pos] = Math.sqrt(dx * dx + dz * dz);
  }
  return { adjStart, adjTo, adjWeight };
}

/** Build the walkable graph of one sector's streets. Pure function of the record. */
export function buildStreetGraph(streets: SectorStreets): StreetGraph {
  if (streets.streetCount === 0) return EMPTY_GRAPH;

  const index = new Map<string, number>();
  const x: number[] = [];
  const z: number[] = [];
  const y: number[] = [];
  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];

  const dedupedIndex = (i: number): number => {
    const px = streets.nodeX[i] as number;
    const pz = streets.nodeZ[i] as number;
    const key = `${Math.round(px * DEDUPE_GRID)},${Math.round(pz * DEDUPE_GRID)}`;
    let idx = index.get(key);
    if (idx === undefined) {
      idx = x.length;
      index.set(key, idx);
      x.push(px);
      z.push(pz);
      y.push(streets.nodeY[i] as number);
    }
    return idx;
  };

  for (let s = 0; s < streets.streetCount; s++) {
    const from = streets.streetStart[s] as number;
    const to = streets.streetStart[s + 1] as number;
    let prev = -1;
    for (let i = from; i < to; i++) {
      const gi = dedupedIndex(i);
      if (prev !== -1 && prev !== gi) {
        edgeFrom.push(prev, gi);
        edgeTo.push(gi, prev);
      }
      prev = gi;
    }
  }

  const count = x.length;
  const { adjStart, adjTo, adjWeight } = buildCsr(count, edgeFrom, edgeTo, x, z);

  let centerNode = -1;
  const site = streets.settlement;
  if (site !== undefined && count > 0) {
    let best = Infinity;
    for (let n = 0; n < count; n++) {
      const dx = (x[n] as number) - site.x;
      const dz = (z[n] as number) - site.z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        centerNode = n;
      }
    }
  }

  return {
    nodeX: Float64Array.from(x),
    nodeZ: Float64Array.from(z),
    nodeY: Float64Array.from(y),
    count,
    adjStart,
    adjTo,
    adjWeight,
    centerNode,
  };
}

/**
 * Append extra, disconnected-from-the-street-plan points and edges to a
 * graph, for content that walks somewhere a street never reaches -- Phase
 * 9b's wall guards, whose beat runs along the curtain, not along a lane.
 *
 * Existing node indices `0..graph.count-1` are unchanged, so every path
 * already computed against `graph` stays valid against the result; only new
 * indices `graph.count..` are added. `extraEdges` are pairs of indices INTO
 * `extraX`/`extraZ` (0-based), offset internally -- the caller never has to
 * know the base it is appending onto.
 */
export function appendGraphNodes(
  graph: StreetGraph,
  extraX: readonly number[],
  extraZ: readonly number[],
  extraEdges: readonly (readonly [number, number])[],
): StreetGraph {
  const base = graph.count;
  const k = extraX.length;
  if (k === 0) return graph;

  const nodeX = new Float64Array(base + k);
  const nodeZ = new Float64Array(base + k);
  const nodeY = new Float64Array(base + k);
  nodeX.set(graph.nodeX);
  nodeZ.set(graph.nodeZ);
  nodeY.set(graph.nodeY);
  for (let i = 0; i < k; i++) {
    const px = extraX[i] as number;
    const pz = extraZ[i] as number;
    nodeX[base + i] = px;
    nodeZ[base + i] = pz;
    nodeY[base + i] = base > 0 ? (graph.nodeY[nearestGraphNode(graph, px, pz)] as number) : 0;
  }

  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  for (let n = 0; n < base; n++) {
    const start = graph.adjStart[n] as number;
    const end = graph.adjStart[n + 1] as number;
    for (let e = start; e < end; e++) {
      edgeFrom.push(n);
      edgeTo.push(graph.adjTo[e] as number);
    }
  }
  for (const [a, b] of extraEdges) {
    const ga = base + a;
    const gb = base + b;
    edgeFrom.push(ga, gb);
    edgeTo.push(gb, ga);
  }

  const count = base + k;
  const { adjStart, adjTo, adjWeight } = buildCsr(count, edgeFrom, edgeTo, nodeX, nodeZ);

  return { nodeX, nodeZ, nodeY, count, adjStart, adjTo, adjWeight, centerNode: graph.centerNode };
}

/** The graph node nearest a world point. -1 on an empty graph. Ties keep the lowest index. */
export function nearestGraphNode(graph: StreetGraph, x: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < graph.count; n++) {
    const dx = (graph.nodeX[n] as number) - x;
    const dz = (graph.nodeZ[n] as number) - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * Cheapest path from `from` to `to`, as a node-index list including both ends.
 *
 * Plain O(nodes^2) Dijkstra rather than `CellHeap`-backed A*: a sector's
 * street graph is a few dozen nodes (a settlement's whole ring plus its
 * lanes and spokes), not the region-spanning lattice the road router
 * searches, so a heap buys nothing here and a linear scan is simpler to get
 * right. The frontier scan always breaks ties toward the lowest node index,
 * which is what keeps this a pure function of the graph rather than of
 * insertion order -- the same discipline `CellHeap`'s own tie-break exists
 * for, applied without needing the heap itself.
 *
 * Returns `[from]` when `from === to`, and also when `to` is unreachable --
 * an NPC with nowhere to go stands still rather than the caller having to
 * special-case an empty path.
 */
export function shortestPath(graph: StreetGraph, from: number, to: number): Int32Array {
  if (graph.count === 0 || from < 0) return new Int32Array(0);
  if (from === to) return Int32Array.from([from]);

  const dist = new Float64Array(graph.count).fill(Infinity);
  const prev = new Int32Array(graph.count).fill(-1);
  const visited = new Uint8Array(graph.count);
  dist[from] = 0;

  for (let iter = 0; iter < graph.count; iter++) {
    let u = -1;
    let best = Infinity;
    for (let n = 0; n < graph.count; n++) {
      if (visited[n] === 0 && (dist[n] as number) < best) {
        best = dist[n] as number;
        u = n;
      }
    }
    if (u === -1 || u === to) break;
    visited[u] = 1;
    const start = graph.adjStart[u] as number;
    const end = graph.adjStart[u + 1] as number;
    for (let e = start; e < end; e++) {
      const v = graph.adjTo[e] as number;
      if (visited[v] === 1) continue;
      const nd = best + (graph.adjWeight[e] as number);
      if (nd < (dist[v] as number)) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }

  if (!Number.isFinite(dist[to] as number)) return Int32Array.from([from]);

  const path: number[] = [];
  let cur = to;
  for (;;) {
    path.push(cur);
    if (cur === from) break;
    cur = prev[cur] as number;
  }
  path.reverse();
  return Int32Array.from(path);
}
