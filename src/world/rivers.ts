/**
 * Rivers: flow accumulation at the REGION tier, and the carve it produces.
 *
 * This is the first content in the project that spans chunks, and therefore the
 * first real use of the tier system (RULE 3). A river is hundreds of chunks
 * long, so no chunk can decide where it goes; the routing is done once per
 * 4 km Region, from the pre-carve terrain only, and chunks read the answer.
 *
 * ---------------------------------------------------------------------------
 * THE LAYERING, AND WHY IT IS NOT OPTIONAL
 *
 * Rivers carve terrain, but river routing is computed FROM terrain. That is a
 * circular dependency, and it is resolved by splitting the height field in two:
 *
 *   baseHeight()   pure terrain, no rivers, no roads. The ONLY thing routing is
 *                  allowed to read.
 *   finalHeight()  baseHeight blended toward a carved channel profile.
 *   sampleHeight() the public name for finalHeight. Everything downstream --
 *                  chunk vertices, normals, the water surface, the cube's
 *                  seating, the camera's ground-relative default Y, Phase 8's
 *                  collision -- reads this and nothing else.
 *
 * NOTHING UPSTREAM MAY READ `finalHeight`. If routing read the carved surface
 * it would be reading its own output and the result would depend on evaluation
 * order, which is RULE 1 gone. Phase 4's roads slot into the same blend.
 *
 * This module never imports `height-field.ts`. It takes the base sampler as a
 * `RiverTerrain`, which keeps the dependency acyclic, makes the algorithm
 * testable against synthetic terrain (a cone, a tilted plane) with no noise in
 * the way, and states in the type system that routing sees the PRE-CARVE world.
 *
 * ---------------------------------------------------------------------------
 * THE ALGORITHM, IN ORDER
 *
 *  1. Sample `baseHeight` on a 64 m lattice over the region plus a margin.
 *  2. Priority-flood the window to a depression-less surface, so every cell
 *     drains somewhere and no river can terminate in a pit halfway up a
 *     mountain.
 *  3. D8 flow direction by steepest descent on the filled surface; flats fall
 *     back to the flood's own discovery edges, which are acyclic by
 *     construction.
 *  4. Flow accumulation: each cell contributes one cell of area to everything
 *     downstream of it.
 *  5. Threshold. Cells above `RIVER_HEAD_ACCUM` are channel nodes; the segments
 *     between them and their downstream cell are the routed network.
 *  6. A water-surface profile per node, monotonically non-increasing downstream
 *     and never above the terrain, so a channel always runs downhill and ends
 *     below `seaLevel` where it meets the sea.
 *
 * ---------------------------------------------------------------------------
 * THE MEMO
 *
 * Every chunk vertex needs to know whether it is in a river. A chunk is ~1,200
 * vertices and hundreds are resident, so a flow-accumulation pass per vertex
 * would stop generation dead -- a region window is 12,544 `baseHeight` calls,
 * about 56 ms. The network is therefore computed once per
 * `(terrain, worldSeed, region)` and cached.
 *
 * That does not violate RULE 2. The cache is DERIVED data, a pure function of
 * its key, and it can be dropped and rebuilt byte-identically at any moment --
 * there is a unit test that does exactly that. It is bounded at
 * `RIVER_CACHE_LIMIT` entries with move-to-front eviction, because an unbounded
 * memo is a leak with a friendly name and the soak's leak check has the
 * thinnest margin of any budget in this project.
 *
 * The lookup is deliberately a linear scan over an array rather than a `Map`
 * keyed by a template string: building a key string per call would allocate
 * ~1,200 short-lived strings per chunk, forever, on the one path that runs more
 * than any other.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Everything here uses exact IEEE-754 operations only -- see the note at the
 * top of `noise.ts`. The priority flood's heap breaks ties by cell index, and
 * the steepest-descent scan visits neighbours in a fixed order and uses a
 * strict `>`, so there is no dependence on insertion order anywhere.
 */

import { createTierContext, REGION_SIZE, type RegionCoord, type TierContext } from './contracts';
import { clamp, lerp, smoothstep } from './noise';

// ---------------------------------------------------------------------------
// The pre-carve terrain routing is allowed to see
// ---------------------------------------------------------------------------

/**
 * The uncarved world, as far as river routing is concerned.
 *
 * `height` MUST be the pre-carve terrain (`baseHeight`). Handing it the carved
 * surface would make routing read its own output; see the layering note above.
 *
 * `id` is for diagnostics and error messages only. The memo compares terrain
 * objects by REFERENCE, so hold one module-level constant per terrain rather
 * than building a fresh literal per call.
 */
export interface RiverTerrain {
  readonly id: string;
  /** Altitude the rivers drain to. Below it, the Phase 3a sea covers them. */
  readonly seaLevel: number;
  height(x: number, z: number, worldSeed: number): number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres per routing cell. 64 m is the chunk size, which is not a coincidence:
 * it makes the routing lattice a strict coarsening of the chunk grid, so the
 * cell a point falls in is the same arithmetic `worldToChunk` already does.
 *
 * The lattice is GLOBAL -- cell index is `floor(world / RIVER_CELL)`, not an
 * offset from a region origin. That is what makes two neighbouring regions
 * sample the identical points and therefore agree on flow direction exactly.
 * See the region-boundary note below.
 */
export const RIVER_CELL = 64;

/**
 * Cells of overlap each region routes beyond its own square, on every side.
 *
 * THE REGION-BOUNDARY PROBLEM. A river routed only inside one region stops dead
 * at its edge, and a 4 km seam is the single most likely visual failure of this
 * phase. Three things together stop it:
 *
 *  1. The lattice is global and `baseHeight` is pure, so two regions compute
 *     IDENTICAL flow directions for every cell they share. The PATH of a river
 *     is therefore continuous across a boundary by construction; only its size
 *     can disagree.
 *  2. Each region routes on a window of `region +/- RIVER_PAD`, so a cell on a
 *     region's own edge still sees 1.5 km of its upstream catchment.
 *  3. A query point takes the MAXIMUM influence over every region within
 *     `RIVER_BLEND` of it, each weighted by `regionWeight` -- which is exactly
 *     1 over the region's own square and falls smoothly to exactly 0 at the
 *     edge of its blend domain. A region therefore contributes nothing at the
 *     moment it stops being consulted, so the combined field is continuous
 *     everywhere, and inside the overlap band the better-informed region (the
 *     one with more of the catchment) wins.
 *
 * THE LIMIT, STATED. Accumulation is still truncated at the window edge, so a
 * river whose catchment extends more than `RIVER_PAD` beyond a region boundary
 * is under-measured by the downstream region. Because the field is continuous
 * and combined by max, that shows up as a channel that is slightly SHALLOWER
 * for a stretch, never as a channel that stops. The failure this cannot fix is
 * a river whose entire catchment lies more than 1.5 km outside the region it
 * flows into AND which is near the head threshold: the downstream region may
 * not see it as a channel at all, and the upstream region's contribution fades
 * out 1.5 km past the boundary. That is a channel tapering to nothing over
 * ~1.5 km, not a hard edge.
 */
export const RIVER_PAD_CELLS = 24;

/** Metres a region routes beyond its own square, on every side. */
export const RIVER_PAD = RIVER_CELL * RIVER_PAD_CELLS;

/**
 * Metres beyond its own square over which a region's influence fades to zero.
 *
 * SEPARATE FROM `RIVER_PAD`, AND SMALLER, FOR A REASON. The pad is how much
 * catchment a region gets to SEE; the blend is how far its answer is allowed to
 * REACH. Making them the same number -- the obvious first version -- meant a
 * point up to 1,536 m either side of a boundary had to consult its neighbour,
 * so 56% of the world consulted FOUR region networks per vertex and the carve
 * cost 7.1 us a call there against 1.6 us in the middle of a region.
 *
 * Halving the blend leaves every region routing on the full 1,536 m of context
 * -- nothing about the drainage it computes changes -- while dropping the
 * four-region case to about 14% of the world. Continuity is untouched: the
 * weight is still exactly 1 on a region's own square, exactly 1 for BOTH
 * regions on the shared boundary, and exactly 0 at the point a region stops
 * being consulted.
 */
export const RIVER_BLEND = RIVER_CELL * 12;

/** Routing cells along one edge of a region. */
export const REGION_CELLS = REGION_SIZE / RIVER_CELL;

/** Routing cells along one edge of a region's padded window. */
export const WINDOW_CELLS = REGION_CELLS + 2 * RIVER_PAD_CELLS;

/**
 * Upstream cells a cell must drain before it is a channel node at all.
 *
 * 150 cells is 0.6 km^2 of catchment. It is also the accumulation at which the
 * channel's strength is exactly ZERO (see `RIVER_FULL_ACCUM`), which is what
 * makes a stream head fade in rather than appear as a ditch that starts in the
 * middle of a hillside. A node right on this threshold carves nothing at all,
 * so excluding the cell just below it is invisible.
 */
export const RIVER_HEAD_ACCUM = 150;

/**
 * Accumulation at which a channel reaches full width and depth: 1,400 cells,
 * about 5.7 km^2.
 *
 * Strength is `sqrt((accum - head) / (full - head))` clamped to [0, 1]. The
 * square root is there because channel width in nature grows roughly with the
 * square root of discharge, and because `Math.sqrt` is IEEE-exact while
 * `Math.log` and `Math.pow` are only approximated -- and this value ends up in
 * a vertex buffer RULE 2 says must come back identical.
 */
export const RIVER_FULL_ACCUM = 1400;

/** Metres of influence either side of the channel centreline, at strength 0. */
export const RIVER_BANK_MIN = 12;
/** Metres of influence either side of the channel centreline, at strength 1. */
export const RIVER_BANK_MAX = 44;
/** Metres the channel bed sits below the river's own water surface, at strength 1. */
export const RIVER_DEPTH_MAX = 20;

/**
 * Hard cap on how much a single point may be lowered, in metres.
 *
 * Without it a channel running along the foot of a cliff would cut the cliff
 * down to the river bed, because the profile is "blend the terrain toward the
 * bed", and the terrain there is 200 m up. The cap keeps a river a river rather
 * than a canyon, and it is what bounds `MIN_HEIGHT` in `height-field.ts`.
 */
export const RIVER_MAX_CUT = 45;

/** Region networks held at once, per JS context. See the memo note above. */
export const RIVER_CACHE_LIMIT = 16;

/**
 * Metres per bucket in the per-network segment index.
 *
 * Segments are registered into every bucket their bank-inflated bounding box
 * touches, so a query reads exactly ONE bucket. The alternative -- storing a
 * segment once and scanning a neighbourhood of buckets at query time -- reads
 * 25 to 49 buckets per vertex, which is the wrong side of the trade when the
 * query runs 1,200 times per chunk and the build runs once per region.
 */
const BUCKET_METRES = 128;
const BUCKET_COLS = (WINDOW_CELLS * RIVER_CELL) / BUCKET_METRES;

// ---------------------------------------------------------------------------
// The routed network
// ---------------------------------------------------------------------------

/**
 * One region's routed river network.
 *
 * Node positions are absolute world metres. Everything is a typed array: this
 * lives in a bounded cache in every worker, so its footprint matters.
 */
export interface RiverNetwork {
  readonly terrain: RiverTerrain;
  readonly worldSeed: number;
  readonly regionX: number;
  readonly regionZ: number;
  /** World-space minimum corner of the PADDED routing window. */
  readonly minX: number;
  readonly minZ: number;
  /** Channel node positions, world metres. */
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  /** The river's own water-surface altitude at the node, world metres. */
  readonly nodeWaterY: Float64Array;
  /** 0 at a stream head, 1 at a full-size river. */
  readonly nodeStrength: Float64Array;
  /** Upstream cells draining through the node. Diagnostics and tests. */
  readonly nodeAccum: Float64Array;
  /** Downstream node of each node, or -1 where the chain leaves the window. */
  readonly nodeDown: Int32Array;
  /** Segment endpoints, as node indices. `segCount * 2` entries. */
  readonly segNode: Int32Array;
  /** CSR offsets into `bucketSeg`, length `BUCKET_COLS * BUCKET_COLS + 1`. */
  readonly bucketStart: Int32Array;
  /** Segment indices, grouped by bucket. */
  readonly bucketSeg: Int32Array;
  /** Nodes whose chain reaches `terrain.seaLevel` inside this window. */
  readonly nodesReachingSea: number;
}

// ---------------------------------------------------------------------------
// A deterministic min-heap over cell indices
// ---------------------------------------------------------------------------

/**
 * Binary min-heap ordered by `(key[i], i)`.
 *
 * The index tie-break is not tidiness: a flooded plateau produces thousands of
 * cells at exactly the same altitude, and without a total order the pop
 * sequence would depend on the heap's internal shuffling -- which is stable in
 * practice but is not a property anything guarantees. RULE 1 does not accept
 * "stable in practice".
 */
class CellHeap {
  private readonly items: Int32Array;
  private size = 0;

  constructor(
    capacity: number,
    private readonly key: Float64Array,
  ) {
    this.items = new Int32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  private before(a: number, b: number): boolean {
    const ka = this.key[a] as number;
    const kb = this.key[b] as number;
    return ka < kb || (ka === kb && a < b);
  }

  push(cell: number): void {
    let i = this.size++;
    this.items[i] = cell;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(this.items[i] as number, this.items[parent] as number)) break;
      const swap = this.items[i] as number;
      this.items[i] = this.items[parent] as number;
      this.items[parent] = swap;
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0] as number;
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size] as number;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < this.size && this.before(this.items[left] as number, this.items[best] as number)) {
          best = left;
        }
        if (right < this.size && this.before(this.items[right] as number, this.items[best] as number)) {
          best = right;
        }
        if (best === i) break;
        const swap = this.items[i] as number;
        this.items[i] = this.items[best] as number;
        this.items[best] = swap;
        i = best;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Region-tier generation
// ---------------------------------------------------------------------------

/** The eight D8 neighbours, in a fixed order so ties break deterministically. */
const NEIGHBOUR_DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const NEIGHBOUR_DZ = [0, 0, 1, -1, 1, -1, 1, -1] as const;
/** 1 / distance to each neighbour, in cells. `Math.SQRT1_2` is exact. */
const NEIGHBOUR_INV_DIST = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2] as const;

/**
 * Route the rivers of one region.
 *
 * RULE 3 IS ENFORCED BY THE ARGUMENT LIST. `context` is a REGION tier context,
 * so `context.coarser('sector')` and `context.coarser('chunk')` both throw --
 * this function could not read finer-tier data if it tried. Its only inputs are
 * the world seed, the region coordinate and `terrain.height`, which is the
 * pre-carve field.
 *
 * Prefer `regionRivers`, which memoises this. Exported directly so tests can
 * drive it with a synthetic terrain and assert on the routing itself.
 */
export function generateRegionRivers(
  coord: RegionCoord,
  context: TierContext,
  terrain: RiverTerrain,
): RiverNetwork {
  if (context.tier !== 'region') {
    throw new Error(`generateRegionRivers needs a 'region' TierContext, got '${context.tier}'`);
  }
  const worldSeed = context.worldSeed;

  const cols = WINDOW_CELLS;
  const cellCount = cols * cols;
  const cell0X = coord.x * REGION_CELLS - RIVER_PAD_CELLS;
  const cell0Z = coord.z * REGION_CELLS - RIVER_PAD_CELLS;
  const minX = cell0X * RIVER_CELL;
  const minZ = cell0Z * RIVER_CELL;

  // -- 1. sample the PRE-CARVE terrain on the global lattice -----------------
  const base = new Float64Array(cellCount);
  for (let row = 0; row < cols; row++) {
    const worldZ = (cell0Z + row) * RIVER_CELL + RIVER_CELL / 2;
    for (let col = 0; col < cols; col++) {
      const worldX = (cell0X + col) * RIVER_CELL + RIVER_CELL / 2;
      base[row * cols + col] = terrain.height(worldX, worldZ, worldSeed);
    }
  }

  // -- 2. priority flood: a depression-less surface ---------------------------
  //
  // Every cell ends up draining to the window boundary. Without this step a
  // river routed on raw fBm terminates in the first pit it finds, which on a
  // 64 m lattice is every few hundred metres -- a ditch that stops halfway up a
  // mountain, which is exactly the failure the acceptance criteria name.
  const filled = new Float64Array(cellCount);
  const floodDown = new Int32Array(cellCount).fill(-1);
  const visited = new Uint8Array(cellCount);
  const order = new Int32Array(cellCount);
  const heap = new CellHeap(cellCount, filled);

  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      if (row !== 0 && row !== cols - 1 && col !== 0 && col !== cols - 1) continue;
      const cell = row * cols + col;
      filled[cell] = base[cell] as number;
      visited[cell] = 1;
      heap.push(cell);
    }
  }

  let popped = 0;
  while (heap.length > 0) {
    const cell = heap.pop();
    order[popped++] = cell;
    const col = cell % cols;
    const row = (cell - col) / cols;
    for (let k = 0; k < 8; k++) {
      const nc = col + (NEIGHBOUR_DX[k] as number);
      const nr = row + (NEIGHBOUR_DZ[k] as number);
      if (nc < 0 || nr < 0 || nc >= cols || nr >= cols) continue;
      const n = nr * cols + nc;
      if (visited[n] === 1) continue;
      visited[n] = 1;
      const own = base[n] as number;
      const here = filled[cell] as number;
      filled[n] = own > here ? own : here;
      floodDown[n] = cell;
      heap.push(n);
    }
  }

  // -- 3. D8 flow direction on the filled surface -----------------------------
  //
  // The flood's own discovery edges are a valid drainage network but a biased
  // one -- a cell is pointed at whichever neighbour happened to reach it first,
  // which on an even slope is not the downhill one. Steepest descent on the
  // FILLED surface gives natural-looking networks; the flood edge is kept as
  // the fallback on flats, where there is no strictly lower neighbour.
  //
  // Both edge kinds strictly decrease `(filled, pop order)`, so the union is
  // acyclic and `order` is a valid downstream-first traversal.
  const down = new Int32Array(cellCount);
  for (let cell = 0; cell < cellCount; cell++) {
    const col = cell % cols;
    const row = (cell - col) / cols;
    if (row === 0 || col === 0 || row === cols - 1 || col === cols - 1) {
      down[cell] = -1;
      continue;
    }
    let best = -1;
    let bestSlope = 0;
    const here = filled[cell] as number;
    for (let k = 0; k < 8; k++) {
      const n = (row + (NEIGHBOUR_DZ[k] as number)) * cols + col + (NEIGHBOUR_DX[k] as number);
      const drop = here - (filled[n] as number);
      if (drop <= 0) continue;
      const slope = drop * (NEIGHBOUR_INV_DIST[k] as number);
      if (slope > bestSlope) {
        bestSlope = slope;
        best = n;
      }
    }
    down[cell] = best >= 0 ? best : (floodDown[cell] as number);
  }

  // -- 4. flow accumulation ---------------------------------------------------
  const accum = new Float64Array(cellCount).fill(1);
  for (let i = cellCount - 1; i >= 0; i--) {
    const cell = order[i] as number;
    const target = down[cell] as number;
    if (target >= 0) accum[target] = (accum[target] as number) + (accum[cell] as number);
  }

  // -- 5. the water-surface profile ------------------------------------------
  //
  // `waterY = max(waterY[downstream], base)`. Two properties fall out and both
  // are load-bearing:
  //
  //   - it is monotonically NON-INCREASING downstream, so a carved channel can
  //     never run uphill, and
  //   - a chain that reaches ground below sea level ends below sea level, so
  //     the Phase 3a water surface covers the river's last stretch for free and
  //     the river visibly meets the sea instead of stopping at the coast.
  //
  // `order` is downstream-first, so one forward pass is enough.
  const waterY = new Float64Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const cell = order[i] as number;
    const target = down[cell] as number;
    const own = base[cell] as number;
    if (target < 0) {
      waterY[cell] = own;
    } else {
      const below = waterY[target] as number;
      waterY[cell] = own > below ? own : below;
    }
  }

  // -- 6. threshold into channel nodes and segments ---------------------------
  const nodeOf = new Int32Array(cellCount).fill(-1);
  let nodeCount = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    if ((accum[cell] as number) >= RIVER_HEAD_ACCUM) nodeOf[cell] = nodeCount++;
  }

  const nodeX = new Float64Array(nodeCount);
  const nodeZ = new Float64Array(nodeCount);
  const nodeWaterY = new Float64Array(nodeCount);
  const nodeStrength = new Float64Array(nodeCount);
  const nodeAccum = new Float64Array(nodeCount);
  const nodeDown = new Int32Array(nodeCount).fill(-1);
  const nodeCell = new Int32Array(nodeCount);

  const strengthSpan = RIVER_FULL_ACCUM - RIVER_HEAD_ACCUM;
  for (let cell = 0; cell < cellCount; cell++) {
    const node = nodeOf[cell] as number;
    if (node < 0) continue;
    const col = cell % cols;
    const row = (cell - col) / cols;
    nodeX[node] = (cell0X + col) * RIVER_CELL + RIVER_CELL / 2;
    nodeZ[node] = (cell0Z + row) * RIVER_CELL + RIVER_CELL / 2;
    nodeWaterY[node] = waterY[cell] as number;
    nodeAccum[node] = accum[cell] as number;
    nodeCell[node] = cell;
    nodeStrength[node] = Math.sqrt(
      clamp(((accum[cell] as number) - RIVER_HEAD_ACCUM) / strengthSpan, 0, 1),
    );
    const target = down[cell] as number;
    // Accumulation is non-decreasing downstream, so a channel's downstream cell
    // is always a channel too -- unless the chain leaves the window.
    nodeDown[node] = target < 0 ? -1 : (nodeOf[target] as number);
  }

  // A light smoothing of node positions, toward the mean of the main upstream
  // node and the downstream one. D8 routing turns every bend into a 45 or 90
  // degree corner on a 64 m lattice, and a 30 m wide river inherits the
  // staircase. This is one pass, on positions only: it moves nothing else, and
  // it is applied identically in every region because the chain topology is.
  const mainUp = new Int32Array(nodeCount).fill(-1);
  for (let node = 0; node < nodeCount; node++) {
    const target = nodeDown[node] as number;
    if (target < 0) continue;
    const current = mainUp[target] as number;
    if (current < 0 || (nodeAccum[node] as number) > (nodeAccum[current] as number)) {
      mainUp[target] = node;
    }
  }
  const smoothX = new Float64Array(nodeCount);
  const smoothZ = new Float64Array(nodeCount);
  for (let node = 0; node < nodeCount; node++) {
    let sx = (nodeX[node] as number) * 2;
    let sz = (nodeZ[node] as number) * 2;
    let weight = 2;
    const target = nodeDown[node] as number;
    if (target >= 0) {
      sx += nodeX[target] as number;
      sz += nodeZ[target] as number;
      weight += 1;
    }
    const source = mainUp[node] as number;
    if (source >= 0) {
      sx += nodeX[source] as number;
      sz += nodeZ[source] as number;
      weight += 1;
    }
    smoothX[node] = sx / weight;
    smoothZ[node] = sz / weight;
  }
  nodeX.set(smoothX);
  nodeZ.set(smoothZ);

  // Did the chains actually get to the sea? Counted rather than asserted,
  // because a region wholly inland legitimately has none -- but a build where
  // NOTHING anywhere reaches the sea is a broken profile, and the tests say so.
  let nodesReachingSea = 0;
  const reaches = new Int8Array(nodeCount).fill(-1);
  for (let node = 0; node < nodeCount; node++) {
    // Walk downstream, marking as we go. Chains are short and shared, so this
    // is linear overall.
    let cursor = node;
    let steps = 0;
    while (cursor >= 0 && (reaches[cursor] as number) < 0 && steps <= nodeCount) {
      if ((base[nodeCell[cursor] as number] as number) < terrain.seaLevel) break;
      cursor = nodeDown[cursor] as number;
      steps++;
    }
    const verdict: number = cursor < 0 ? 0 : (reaches[cursor] as number) >= 0 ? (reaches[cursor] as number) : 1;
    let walk = node;
    while (walk >= 0 && (reaches[walk] as number) < 0) {
      reaches[walk] = verdict;
      if (walk === cursor) break;
      walk = nodeDown[walk] as number;
    }
    if (verdict === 1) nodesReachingSea++;
  }

  // -- 7. the segment index --------------------------------------------------
  const segNodeList: number[] = [];
  for (let node = 0; node < nodeCount; node++) {
    const target = nodeDown[node] as number;
    if (target < 0) continue;
    segNodeList.push(node, target);
  }
  const segNode = Int32Array.from(segNodeList);
  const segCount = segNode.length / 2;

  const bucketCount = BUCKET_COLS * BUCKET_COLS;
  const bucketCounts = new Int32Array(bucketCount);
  const bucketRange = new Int32Array(segCount * 4);

  for (let seg = 0; seg < segCount; seg++) {
    const a = segNode[seg * 2] as number;
    const b = segNode[seg * 2 + 1] as number;
    // Inflate by the widest bank either end can claim, so one bucket read at
    // query time is guaranteed to see every segment that could influence it.
    const reach =
      RIVER_BANK_MIN +
      Math.max(nodeStrength[a] as number, nodeStrength[b] as number) * (RIVER_BANK_MAX - RIVER_BANK_MIN);
    const lo = (v: number, origin: number): number =>
      Math.max(0, Math.min(BUCKET_COLS - 1, Math.floor((v - reach - origin) / BUCKET_METRES)));
    const hi = (v: number, origin: number): number =>
      Math.max(0, Math.min(BUCKET_COLS - 1, Math.floor((v + reach - origin) / BUCKET_METRES)));
    const x0 = Math.min(nodeX[a] as number, nodeX[b] as number);
    const x1 = Math.max(nodeX[a] as number, nodeX[b] as number);
    const z0 = Math.min(nodeZ[a] as number, nodeZ[b] as number);
    const z1 = Math.max(nodeZ[a] as number, nodeZ[b] as number);
    const bx0 = lo(x0, minX);
    const bx1 = hi(x1, minX);
    const bz0 = lo(z0, minZ);
    const bz1 = hi(z1, minZ);
    bucketRange[seg * 4] = bx0;
    bucketRange[seg * 4 + 1] = bx1;
    bucketRange[seg * 4 + 2] = bz0;
    bucketRange[seg * 4 + 3] = bz1;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        bucketCounts[bz * BUCKET_COLS + bx] = (bucketCounts[bz * BUCKET_COLS + bx] as number) + 1;
      }
    }
  }

  const bucketStart = new Int32Array(bucketCount + 1);
  for (let i = 0; i < bucketCount; i++) {
    bucketStart[i + 1] = (bucketStart[i] as number) + (bucketCounts[i] as number);
  }
  const bucketSeg = new Int32Array(bucketStart[bucketCount] as number);
  const cursor = Int32Array.from(bucketStart.subarray(0, bucketCount));
  for (let seg = 0; seg < segCount; seg++) {
    const bx0 = bucketRange[seg * 4] as number;
    const bx1 = bucketRange[seg * 4 + 1] as number;
    const bz0 = bucketRange[seg * 4 + 2] as number;
    const bz1 = bucketRange[seg * 4 + 3] as number;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const bucket = bz * BUCKET_COLS + bx;
        bucketSeg[cursor[bucket] as number] = seg;
        cursor[bucket] = (cursor[bucket] as number) + 1;
      }
    }
  }

  return {
    terrain,
    worldSeed,
    regionX: coord.x,
    regionZ: coord.z,
    minX,
    minZ,
    nodeX,
    nodeZ,
    nodeWaterY,
    nodeStrength,
    nodeAccum,
    nodeDown,
    segNode,
    bucketStart,
    bucketSeg,
    nodesReachingSea,
  };
}

// ---------------------------------------------------------------------------
// The bounded memo
// ---------------------------------------------------------------------------

const cache: RiverNetwork[] = [];
let cacheBuilds = 0;

/** Diagnostics for tests and the HUD. Not part of any determinism claim. */
export function riverCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: cache.length, limit: RIVER_CACHE_LIMIT, builds: cacheBuilds };
}

/**
 * Drop every cached network.
 *
 * Exists so tests can prove eviction is invisible: the network rebuilt after a
 * clear must be identical to the one that was thrown away, or the cache is not
 * derived data and RULE 2 does not hold.
 */
export function clearRiverCache(): void {
  cache.length = 0;
}

/**
 * The routed network of one region, memoised.
 *
 * Move-to-front on a hit, drop the last entry past the cap. Linear scan over at
 * most `RIVER_CACHE_LIMIT` entries with no key allocation -- see the memo note
 * at the top of the file.
 */
export function regionRivers(
  terrain: RiverTerrain,
  worldSeed: number,
  regionX: number,
  regionZ: number,
): RiverNetwork {
  const seed = worldSeed >>> 0;
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i] as RiverNetwork;
    if (
      entry.regionX === regionX &&
      entry.regionZ === regionZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain
    ) {
      // Promote by SWAPPING with the entry in front, not by splice+unshift.
      // This runs up to four times per vertex, i.e. ~5,000 times per chunk, and
      // `splice`/`unshift` move every element of the array and allocate; a swap
      // is two stores. Hot entries still drift to the front within a few
      // hundred hits, which is all the ordering has to achieve.
      if (i > 0) {
        cache[i] = cache[i - 1] as RiverNetwork;
        cache[i - 1] = entry;
      }
      return entry;
    }
  }

  // A REGION tier context, so this generator cannot read anything finer even by
  // accident: nothing is coarser than a region, so EVERY `coarser()` call from
  // here throws (RULE 3). That is the point -- the rule is enforced by the
  // context it is handed, not by reviewer discipline.
  const built = generateRegionRivers(
    { x: regionX, z: regionZ },
    createTierContext(seed, 'region'),
    terrain,
  );
  cacheBuilds++;
  cache.unshift(built);
  if (cache.length > RIVER_CACHE_LIMIT) cache.length = RIVER_CACHE_LIMIT;
  return built;
}

// ---------------------------------------------------------------------------
// The carve
// ---------------------------------------------------------------------------

/**
 * How much weight a region's network carries at a point: exactly 1 over the
 * region's own square, falling smoothly to exactly 0 at the edge of its padded
 * window.
 *
 * This is what makes combining regions by MAX continuous. A region stops being
 * consulted precisely where it has stopped contributing, so crossing out of a
 * padded window changes nothing.
 */
function regionWeight(net: RiverNetwork, x: number, z: number): number {
  const x0 = net.regionX * REGION_SIZE - RIVER_BLEND;
  const z0 = net.regionZ * REGION_SIZE - RIVER_BLEND;
  const span = REGION_SIZE + 2 * RIVER_BLEND;
  const insideX = Math.min(x - x0, x0 + span - x);
  const insideZ = Math.min(z - z0, z0 + span - z);
  const inside = insideX < insideZ ? insideX : insideZ;
  return smoothstep(0, RIVER_BLEND, inside);
}

/**
 * Metres to lower the terrain at `(x, z)`, according to one region's network.
 *
 * The profile is "blend the terrain toward the channel bed", capped at
 * `RIVER_MAX_CUT`, and it is exactly zero at and beyond the bank. Segments are
 * combined by max, which is continuous, so a confluence does not produce a
 * crease.
 */
function networkDrop(net: RiverNetwork, x: number, z: number, base: number): number {
  const bx = Math.floor((x - net.minX) / BUCKET_METRES);
  const bz = Math.floor((z - net.minZ) / BUCKET_METRES);
  if (bx < 0 || bz < 0 || bx >= BUCKET_COLS || bz >= BUCKET_COLS) return 0;
  const bucket = bz * BUCKET_COLS + bx;
  const from = net.bucketStart[bucket] as number;
  const to = net.bucketStart[bucket + 1] as number;

  let best = 0;
  for (let i = from; i < to; i++) {
    const seg = net.bucketSeg[i] as number;
    const a = net.segNode[seg * 2] as number;
    const b = net.segNode[seg * 2 + 1] as number;
    const ax = net.nodeX[a] as number;
    const az = net.nodeZ[a] as number;
    const ex = (net.nodeX[b] as number) - ax;
    const ez = (net.nodeZ[b] as number) - az;
    const lengthSquared = ex * ex + ez * ez;
    let t = lengthSquared > 0 ? ((x - ax) * ex + (z - az) * ez) / lengthSquared : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + ex * t);
    const dz = z - (az + ez * t);
    const distance = Math.sqrt(dx * dx + dz * dz);

    const strength = lerp(net.nodeStrength[a] as number, net.nodeStrength[b] as number, t);
    const bank = RIVER_BANK_MIN + strength * (RIVER_BANK_MAX - RIVER_BANK_MIN);
    if (distance >= bank) continue;

    const surface = lerp(net.nodeWaterY[a] as number, net.nodeWaterY[b] as number, t);
    const bed = surface - strength * RIVER_DEPTH_MAX;
    let above = base - bed;
    if (above <= 0) continue;
    if (above > RIVER_MAX_CUT) above = RIVER_MAX_CUT;

    const drop = above * (1 - smoothstep(0, bank, distance));
    if (drop > best) best = drop;
  }
  return best;
}

/**
 * Metres to lower `base` at `(x, z)` for rivers. Never negative: carving only
 * ever cuts down, so it can never lift ground out of the sea.
 *
 * Consults every region whose padded window contains the point -- one in the
 * middle of a region, two near an edge, four at a corner -- and takes the
 * maximum of the weighted contributions. See `RIVER_PAD_CELLS` for why that is
 * the whole region-boundary story.
 */
export function riverDrop(
  terrain: RiverTerrain,
  worldSeed: number,
  x: number,
  z: number,
  base: number,
): number {
  const regionLo = Math.floor((x - RIVER_BLEND) / REGION_SIZE);
  const regionHi = Math.floor((x + RIVER_BLEND) / REGION_SIZE);
  const rowLo = Math.floor((z - RIVER_BLEND) / REGION_SIZE);
  const rowHi = Math.floor((z + RIVER_BLEND) / REGION_SIZE);

  let best = 0;
  for (let rz = rowLo; rz <= rowHi; rz++) {
    for (let rx = regionLo; rx <= regionHi; rx++) {
      const net = regionRivers(terrain, worldSeed, rx, rz);
      const weight = regionWeight(net, x, z);
      if (weight <= 0) continue;
      const drop = weight * networkDrop(net, x, z, base);
      if (drop > best) best = drop;
    }
  }
  return best;
}

/**
 * Region-tier river data as a chunk generator is allowed to see it.
 *
 * This is what travels in `TierContext.coarser('region')`. It is an interface
 * rather than the raw `RiverNetwork` because a chunk overlaps up to four
 * regions and must not have to know that.
 */
export interface RegionRiverField {
  readonly terrain: RiverTerrain;
  readonly worldSeed: number;
  /** Metres to subtract from the pre-carve height at a point. Never negative. */
  drop(x: number, z: number, base: number): number;
  /** The carved ground height at a point: `baseHeight` minus `drop`. */
  finalHeight(x: number, z: number): number;
}

/** Build the record a chunk generator reads through `coarser('region')`. */
export function regionRiverField(terrain: RiverTerrain, worldSeed: number): RegionRiverField {
  const seed = worldSeed >>> 0;
  return {
    terrain,
    worldSeed: seed,
    drop(x: number, z: number, base: number): number {
      return riverDrop(terrain, seed, x, z, base);
    },
    finalHeight(x: number, z: number): number {
      const base = terrain.height(x, z, seed);
      return base - riverDrop(terrain, seed, x, z, base);
    },
  };
}
