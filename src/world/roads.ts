/**
 * Settlements and the road network between them, at the REGION tier.
 *
 * Phase 4a. The second piece of content in the project that spans chunks, after
 * Phase 3b's rivers, and it follows the same shape for the same reasons: a road
 * is kilometres long, so no chunk can decide where it goes.
 *
 * ---------------------------------------------------------------------------
 * THE LAYERING (unchanged from `rivers.ts`, and not optional)
 *
 *   baseHeight()   pure terrain. The ONLY thing routing may read.
 *   sampleHeight() baseHeight, carved by rivers, then graded by roads.
 *
 * Roads move terrain but are routed FROM terrain, exactly the circularity
 * rivers had. This module therefore never imports `height-field.ts`: the base
 * sampler arrives as a `RoadTerrain`, which keeps the dependency graph acyclic,
 * states in the type system that routing sees the PRE-CARVE world, and lets the
 * router be tested against a synthetic ridge where the right answer is known.
 *
 * ---------------------------------------------------------------------------
 * RIVERS REACH ROADS BY INJECTION, NOT BY `coarser()`
 *
 * Rivers and roads are both Region tier, so `context.coarser('region')` throws
 * from inside either of them -- RULE 3 is enforced by the context, and a
 * same-tier read is exactly what it forbids. The river field is therefore an
 * argument, the same discipline `RoadTerrain` already uses. Roads read rivers;
 * rivers never read roads; `height-field.ts` wires the two together. Acyclic by
 * construction, and `roads.ts` imports nothing from `rivers.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE ALGORITHM, IN ORDER
 *
 *  1. Score a settlement candidate in every cell of a GLOBAL 512 m lattice, from
 *     position-pure fields only. A candidate becomes a settlement iff it is a
 *     strict local maximum of that score over its 3x3 neighbourhood.
 *  2. Connect the settlements with a GABRIEL graph capped at `ROAD_MAX_EDGE`.
 *  3. Route each edge with A* on a global 128 m lattice, inside a window derived
 *     from that edge's own endpoints.
 *  4. Smooth the path, then give it a gradient-limited elevation profile.
 *  5. Index the segments into buckets, and record where a road crosses a channel
 *     so Phase 5 can put a bridge there.
 *
 * ---------------------------------------------------------------------------
 * WHY GABRIEL AND NOT A MINIMUM SPANNING TREE
 *
 * The graph has to be decidable from local information, because two neighbouring
 * regions must agree about every road near their shared boundary or there is a
 * 4 km seam through the world.
 *
 * AN MST IS NOT LOCAL. Adding one settlement at the far edge of a region's view
 * can re-route edges arbitrarily far away, so two regions with different views
 * would disagree, and no amount of padding fixes it -- the dependency is global
 * by definition. A Gabriel edge (a, b) exists iff no third settlement lies in
 * the disc having ab as its diameter, which is decided entirely by settlements
 * near a and b. Pad far enough to contain that disc and the answer is exact.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO CROSS-REGION BLEND, UNLIKE RIVERS
 *
 * `rivers.ts` consults up to four region networks per query and combines them by
 * a weighted maximum, because a region's flow ACCUMULATION is truncated at its
 * window edge -- neighbouring regions genuinely disagree about how big a river
 * is, and the blend is what stops that disagreement being a step.
 *
 * Roads have no such quantity. A road's geometry is a pure function of its two
 * endpoints, and both are settlements decided by a global lattice. So:
 *
 *   - every region routes every edge whose corridor comes within `ROAD_REACH`
 *     of its own square, from complete Gabriel information;
 *   - each edge is routed inside a window derived from the EDGE, never from the
 *     region, so its path is identical whichever region computes it.
 *
 * A query point is inside exactly one region square, and that region has routed
 * every edge that can possibly reach the point. So ONE region answers each
 * query -- a quarter of the lookup cost rivers pay in its overlap bands -- and
 * continuity across a boundary is exact rather than blended: two regions sharing
 * an edge produce bit-identical answers for it.
 *
 * ---------------------------------------------------------------------------
 * THE MEMO
 *
 * Identical in shape to `rivers.ts`, and for the identical reason: every chunk
 * vertex needs to know whether it is on a road, a chunk is ~1,200 vertices, and
 * routing a region costs tens of milliseconds. Bounded at `ROAD_CACHE_LIMIT`
 * with move-to-front eviction, because an unbounded memo is a leak with a
 * friendly name. It is derived data -- a pure function of its key, droppable and
 * rebuildable byte-identically -- so it is not global mutable world state under
 * RULE 2, and a unit test drops it and demands the same network back.
 *
 * The lookup is a linear scan over an array rather than a `Map` keyed by a
 * template string, because a key string per call is ~1,200 short-lived strings
 * per chunk on the hottest path in the codebase.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Exact IEEE-754 operations only -- no `pow`, `sin`, `cos` or `exp` anywhere on
 * the path to a stored vertex; see the note at the top of `noise.ts`. The A*
 * frontier is the shared `CellHeap`, ordered by `(key, index)`, because a flat
 * plain produces thousands of equal f-scores and RULE 1 does not accept "stable
 * in practice". Jitter comes from `hash2i`, never from a sequential PRNG.
 */

import { CellHeap } from './cell-heap';
import { hash2i } from '../core/hash';
import {
  createTierContext,
  REGION_SIZE,
  SECTOR_SIZE,
  type RegionCoord,
  type TierContext,
} from './contracts';
import {
  closestOnSegment,
  GradeBlend,
  GRADE_LIFT,
  GRADE_OUT_LENGTH,
  GRADE_STREET_SURFACE,
  GRADE_SURFACE,
  ROAD_RIVER_YIELD,
  SURFACE_ROAD,
} from './grading';
import { clamp, lerp, smoothstep } from './noise';

// ---------------------------------------------------------------------------
// The pre-carve terrain routing is allowed to see
// ---------------------------------------------------------------------------

/**
 * The uncarved world, as far as road routing is concerned.
 *
 * `height` MUST be the pre-carve terrain (`baseHeight`). Handing it the graded
 * surface would make routing read its own output; see the layering note above.
 *
 * `id` is for diagnostics only. The memo compares terrain objects by REFERENCE,
 * so hold one module-level constant per terrain rather than building a literal
 * per call.
 */
export interface RoadTerrain {
  readonly id: string;
  /** Altitude the sea reaches. Ground below it is not buildable. */
  readonly seaLevel: number;
  height(x: number, z: number, worldSeed: number): number;
}

/**
 * The river field, injected rather than imported.
 *
 * Only the carve depth is needed: it tells the router where a crossing will be
 * expensive, and it tells the grading where to stand down. Rivers and roads are
 * the same tier, so this cannot arrive through `TierContext.coarser`.
 */
export interface RoadRivers {
  /** Metres a channel lowers the ground at a point. 0 where there is none. */
  drop(x: number, z: number, base: number): number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres per settlement lattice cell.
 *
 * `SECTOR_SIZE`, deliberately, and Phase 4b cashed that in. Aligning the siting
 * lattice to the sector grid makes `streets.ts` a strict refinement of this
 * rather than a second, differently-aligned grid -- and because the jitter is
 * less than half a cell, it also means a sector contains AT MOST ONE settlement
 * centre, which is the whole basis of how street plans are owned.
 *
 * The lattice is GLOBAL -- cell index is `floor(world / SETTLEMENT_CELL)`, never
 * an offset from a region origin. That is what makes two regions agree about
 * which settlements exist in the ground they share.
 */
export const SETTLEMENT_CELL = SECTOR_SIZE;

/**
 * Metres per routing cell for the A* path search.
 *
 * 128 m is two chunks, so the lattice is still a strict coarsening of the chunk
 * grid. It is deliberately coarser than the 64 m rivers route on, and the reason
 * is cost rather than taste: A* explores an area, so halving the cell size
 * quadruples the search. A channel needs 64 m fidelity because its carve is
 * 24-88 m wide and its shape IS the feature; a road's centreline is smoothed and
 * then graded into a ~12 m corridor, so the lattice only has to find the right
 * saddle, not the exact metre.
 */
export const ROAD_CELL = 128;

/** The eight neighbours of a routing cell, in a fixed order. */
const NEIGHBOUR_DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const NEIGHBOUR_DZ = [0, 0, 1, -1, 1, -1, 1, -1] as const;
/** Distance to each neighbour, in cells. `Math.SQRT2` is exact. */
const NEIGHBOUR_DIST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2] as const;

/**
 * Longest road, in metres, between two settlements.
 *
 * Caps both the Gabriel graph and the A* search. It also sets how far a region
 * has to see settlements: an edge influencing a region can reach `ROAD_REACH +
 * ROAD_MAX_EDGE` away, and deciding it needs the disc on that edge, another
 * `ROAD_MAX_EDGE / 2`. `SETTLEMENT_PAD` covers the sum with room to spare.
 */
export const ROAD_MAX_EDGE = 1600;

/**
 * Metres beyond its own square within which a region routes an edge.
 *
 * Must exceed the widest thing a road can put on the ground -- a corridor is
 * about 16 m and the largest settlement pad is `SETTLEMENT_RADIUS_MAX` -- so
 * that every edge able to reach a point inside the square is routed by the
 * region that owns it. 512 m is several times the requirement, and the cost of
 * the margin is a handful of extra edges per region.
 */
export const ROAD_REACH = 512;

/**
 * Metres beyond its own square over which a region scores settlement candidates.
 *
 * Must contain `ROAD_REACH + ROAD_MAX_EDGE + ROAD_MAX_EDGE / 2 = 2,912 m`,
 * which is the furthest away a settlement can be and still decide an edge that
 * influences this region. That exactness is what removes the need for a
 * cross-region blend entirely.
 *
 * IT IS ALSO A COST, AND THE MOST EXPENSIVE NUMBER IN THIS FILE. The window is
 * where road generation reads rivers, and river data is memoised per 4 km river
 * region -- so every extra metre here risks pulling in another ring of river
 * regions at ~56 ms each. At 4,096 m (the obvious choice, one region) the window
 * spanned 4x4 river regions plus their blend margins, overflowed the river
 * memo, and cost 24-28 REBUILDS per road region: 1.4 s, ten times the budget.
 * 3,072 m spans 3x3, which fits. Raising `ROAD_MAX_EDGE` without re-checking
 * this is the way to make generation slow again.
 */
export const SETTLEMENT_PAD = 3072;

/** Settlement lattice cells along one edge of a region. */
export const REGION_SETTLEMENT_CELLS = REGION_SIZE / SETTLEMENT_CELL;
/** Settlement lattice cells along one edge of a region's padded window. */
export const SETTLEMENT_WINDOW_CELLS =
  REGION_SETTLEMENT_CELLS + 2 * (SETTLEMENT_PAD / SETTLEMENT_CELL);

/**
 * Metres a candidate may be jittered from its lattice cell centre, each axis.
 *
 * Without it every settlement in the world sits on a 512 m grid, which reads as
 * a grid from any altitude. Kept below half the cell so a candidate stays inside
 * its own cell and the local-maximum rule keeps its spacing guarantee.
 */
export const SETTLEMENT_JITTER = 190;

/**
 * Score a candidate must reach to be a settlement at all, in [0, 1].
 *
 * This is the density knob. Raising it empties the world; lowering it puts a
 * hamlet in every valley. The local-maximum rule already guarantees spacing, so
 * this controls how much of the world is habitable rather than how close two
 * settlements can be.
 */
export const SETTLEMENT_MIN_SCORE = 0.42;

/** Footprint radius in metres at the threshold score, and at a perfect one. */
export const SETTLEMENT_RADIUS_MIN = 58;
export const SETTLEMENT_RADIUS_MAX = 186;

/** Metres above sea level a settlement site must stand. */
export const SETTLEMENT_MIN_ALTITUDE = 4;

/** Slope, as metres of rise per metre, at which a site scores nothing. */
const SETTLEMENT_MAX_SLOPE = 0.28;

/** Metres from fresh water at which the water bonus has fully decayed. */
const SETTLEMENT_WATER_RANGE = 900;

/**
 * Steepest road the grading will build, as rise over run.
 *
 * The profile pass clamps every step to this, which is what makes a road read as
 * an engineered bench rather than a stripe painted over the terrain. 8% is about
 * the limit of a comfortable rural road.
 */
export const ROAD_MAX_GRADE = 0.08;

/** Half-width in metres of the flat roadbed, at the smallest and largest road. */
export const ROAD_HALF_WIDTH_MIN = 3.5;
export const ROAD_HALF_WIDTH_MAX = 6;

/** Metres beyond the roadbed over which the grading tapers back to the terrain. */
export const ROAD_SHOULDER = 11;

/** Extra A* cost, in metres, for stepping across a metre of river carve. */
const RIVER_CROSSING_COST = 900;

/** River carve, in metres, above which a segment is recorded as a crossing. */
const CROSSING_DROP = 1;

/**
 * How much a metre of rise per metre of travel costs, as a multiple of distance.
 *
 * This is what makes a road contour a hillside instead of running straight up
 * it. Squared so that a gentle grade is nearly free and a steep one is
 * prohibitive, rather than a linear trade that averages the two.
 */
const SLOPE_COST = 34;

/** Metres of margin around an edge's bounding box that A* may route within. */
const ROAD_DETOUR_MARGIN = 768;

/**
 * How much the A* heuristic is inflated, and why it is inflated at all.
 *
 * The heuristic is straight-line distance, which is admissible -- every cost
 * multiplier is at least 1 -- but on real terrain it is a very WEAK bound: the
 * slope penalty routinely makes the true remaining cost several times the
 * straight-line distance, so plain A* stops discriminating and degenerates
 * toward Dijkstra, sweeping the entire search rectangle. Measured at 1.5 s per
 * region, ten times the budget this can afford on the main thread.
 *
 * Inflating the heuristic gives up the guarantee that the path found is the
 * globally cheapest one, and buys back roughly an order of magnitude. That is
 * the right trade HERE and would not be everywhere: a road's cost function is a
 * statement of preference, not of correctness, and nothing downstream can tell
 * the cheapest route from one a few percent worse. What IS still guaranteed is
 * what RULE 1 needs -- the search is a deterministic function of its inputs, so
 * the same edge yields the same path every time and from every region.
 */
const HEURISTIC_WEIGHT = 4;

/**
 * Region networks held at once, per JS context.
 *
 * RAISED FROM 8 TO 16 IN PHASE 5, AND THE OLD VALUE WAS ONE SHORT OF THE
 * WORKING SET. A quadtree node at the root level covers a whole 4 km region, and
 * both the per-vertex grading (through its padded sample grid) and the deck
 * builder need every region within a margin of it -- a 3x3 block, NINE, against
 * a cache of eight. One short of the working set is the worst possible size: the
 * entry evicted is always the one wanted next, so a full sweep rebuilds every
 * region it touches instead of building each once.
 *
 * It went unmeasured until Phase 5 because grading sweeps row-major, so its
 * working set within one row of vertices is three rather than nine, and eight
 * absorbed it. The deck builder sweeps the 3x3 block in one go and cannot.
 * Measured on a root node: 10.5 s with the old limit against 3.6 s with the deck
 * disabled, and both figures collapse together at 16.
 *
 * The cost of the larger cache is small and bounded: a network is a few hundred
 * path nodes plus a bucket index, well under 100 kB, so sixteen of them is a
 * megabyte or two against a 400 MB heap budget. The lookup is a linear scan, but
 * over ENTRIES not sectors -- one scan per query point, not four -- and a region
 * query happens once per vertex, so the scan is nowhere near the cost of the
 * `baseHeight` evaluation next to it.
 */
export const ROAD_CACHE_LIMIT = 16;

/** Metres per bucket in the per-network segment index. */
const BUCKET_METRES = 128;
/** The bucket grid covers the region plus `ROAD_REACH` on every side. */
const BUCKET_SPAN = REGION_SIZE + 2 * ROAD_REACH;
const BUCKET_COLS = BUCKET_SPAN / BUCKET_METRES;

/**
 * Ground coverage a settlement pad contributes to the surface palette.
 *
 * Below 1 deliberately: a village is trampled ground with the biome still
 * showing through, where a roadbed is bare surfacing. Phase 4b's streets lay a
 * made surface over parts of it, and Phase 6's lots are what will make a
 * settlement read as built rather than as cleared.
 */
const SETTLEMENT_SURFACE = 0.55;

// ---------------------------------------------------------------------------
// The routed network
// ---------------------------------------------------------------------------

/** One settlement. Positions are absolute world metres. */
export interface Settlement {
  /** The global lattice cell that owns it. Its identity. */
  readonly cellX: number;
  readonly cellZ: number;
  readonly x: number;
  readonly z: number;
  /** `baseHeight` at the site: the altitude its pad is graded to. */
  readonly y: number;
  /** Site quality in [0, 1]. Sets the footprint and the road width. */
  readonly score: number;
  /** Footprint radius in metres. */
  readonly radius: number;
}

/**
 * One region's routed road network.
 *
 * Everything bulk is a typed array: this lives in a bounded cache in every
 * worker, so its footprint matters.
 */
export interface RoadNetwork {
  readonly terrain: RoadTerrain;
  readonly worldSeed: number;
  readonly regionX: number;
  readonly regionZ: number;
  /** World-space minimum corner of the bucket grid. */
  readonly minX: number;
  readonly minZ: number;
  /** Settlements that can influence this region. */
  readonly settlements: readonly Settlement[];
  /** Path node positions, world metres. */
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  /** The graded road surface altitude at the node, world metres. */
  readonly nodeY: Float64Array;
  /** Half-width of the flat roadbed at the node, metres. */
  readonly nodeHalfWidth: Float64Array;
  /**
   * CSR offsets into the node arrays, one entry per road plus a final total.
   * Road `i` owns nodes `[pathStart[i], pathStart[i + 1])`.
   *
   * Phase 5 needs this to build one mesh per road rather than one per segment,
   * and the grading tests need it to tell an interior step from the two end
   * steps, which are pinned to the settlements the road serves.
   */
  readonly pathStart: Int32Array;
  /** Segment endpoints, as node indices. `segCount * 2` entries. */
  readonly segNode: Int32Array;
  /** 1 where the segment crosses a river channel: a bridge site for Phase 5. */
  readonly segCrossing: Uint8Array;
  /** CSR offsets into `bucketSeg`, length `BUCKET_COLS * BUCKET_COLS + 1`. */
  readonly bucketStart: Int32Array;
  /** Segment indices, grouped by bucket. */
  readonly bucketSeg: Int32Array;
  /** Edges the region routed. Diagnostics and anti-vacuity tests. */
  readonly edgeCount: number;
  /** Segments recorded as river crossings. */
  readonly crossingCount: number;
}

// ---------------------------------------------------------------------------
// Settlement siting
// ---------------------------------------------------------------------------

/** Salts, so two uses of `hash2i` on the same cell cannot correlate. */
const JITTER_SALT = 0x52_6f_61_64;

/**
 * Where in its cell a candidate sits. A pure function of the GLOBAL cell index,
 * so every region that looks at this cell gets the same point.
 */
function candidatePoint(cellX: number, cellZ: number, worldSeed: number): { x: number; z: number } {
  const h = hash2i(cellX, cellZ, (worldSeed ^ JITTER_SALT) >>> 0);
  // Two independent 16-bit fields of one hash, mapped to [-1, 1].
  const jx = ((h & 0xffff) / 0xffff) * 2 - 1;
  const jz = ((h >>> 16) / 0xffff) * 2 - 1;
  return {
    x: (cellX + 0.5) * SETTLEMENT_CELL + jx * SETTLEMENT_JITTER,
    z: (cellZ + 0.5) * SETTLEMENT_CELL + jz * SETTLEMENT_JITTER,
  };
}

/**
 * How good a settlement site a point is, in [0, 1]. 0 means uninhabitable.
 *
 * Every input is a pure function of position, so a candidate scores identically
 * from any region -- which is what the local-maximum rule needs to be consistent
 * across a boundary. Exported so the test suite can assert the shape of the
 * preference (flat beats steep, inland beats surf) rather than only its output.
 */
export function settlementScore(
  x: number,
  z: number,
  worldSeed: number,
  terrain: RoadTerrain,
  rivers: RoadRivers,
  habitability: number,
): number {
  const y = terrain.height(x, z, worldSeed);
  if (y < terrain.seaLevel + SETTLEMENT_MIN_ALTITUDE) return 0;

  // Slope from central differences over one routing cell. A settlement is a
  // patch of ground, not a point, so the probe spacing is deliberately wide.
  const step = ROAD_CELL / 2;
  const hx = terrain.height(x + step, z, worldSeed) - terrain.height(x - step, z, worldSeed);
  const hz = terrain.height(x, z + step, worldSeed) - terrain.height(x, z - step, worldSeed);
  const slope = Math.sqrt(hx * hx + hz * hz) / (2 * step);
  const flat = 1 - smoothstep(0, SETTLEMENT_MAX_SLOPE, slope);
  if (flat <= 0) return 0;

  // Nobody builds in the river itself, but everybody builds near one. The carve
  // depth doubles as a distance proxy: it is large in the channel and zero
  // outside the banks, so a ring of probes says "there is water nearby".
  const inChannel = rivers.drop(x, z, y);
  if (inChannel > ROAD_RIVER_YIELD) return 0;
  let nearWater = terrain.seaLevel + SETTLEMENT_WATER_RANGE > y ? 0.35 : 0;
  const probe = SETTLEMENT_WATER_RANGE / 2;
  for (let k = 0; k < 4; k++) {
    const px = x + (NEIGHBOUR_DX[k] as number) * probe;
    const pz = z + (NEIGHBOUR_DZ[k] as number) * probe;
    if (rivers.drop(px, pz, terrain.height(px, pz, worldSeed)) > 0) {
      nearWater = 1;
      break;
    }
  }

  // Altitude: the coastal plain and the low hills, not the peaks.
  const height = 1 - smoothstep(120, 320, y - terrain.seaLevel);

  return clamp(flat * (0.45 + 0.25 * nearWater + 0.3 * habitability) * (0.35 + 0.65 * height), 0, 1);
}

/**
 * Every settlement whose disc can influence the region, on the global lattice.
 *
 * Scores are computed over the padded window plus one ring, because the
 * local-maximum test reads a 3x3 neighbourhood and a candidate on the window
 * edge still needs all eight of its neighbours.
 */
function siteSettlements(
  regionX: number,
  regionZ: number,
  worldSeed: number,
  terrain: RoadTerrain,
  rivers: RoadRivers,
  habitability: (x: number, z: number, worldSeed: number) => number,
): Settlement[] {
  const padCells = SETTLEMENT_PAD / SETTLEMENT_CELL;
  const cell0X = regionX * REGION_SETTLEMENT_CELLS - padCells;
  const cell0Z = regionZ * REGION_SETTLEMENT_CELLS - padCells;
  // One extra ring on every side, for the 3x3 local-maximum test.
  const cols = SETTLEMENT_WINDOW_CELLS + 2;

  const scores = new Float64Array(cols * cols);
  const pointX = new Float64Array(cols * cols);
  const pointZ = new Float64Array(cols * cols);
  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      const cellX = cell0X - 1 + col;
      const cellZ = cell0Z - 1 + row;
      const p = candidatePoint(cellX, cellZ, worldSeed);
      const at = row * cols + col;
      pointX[at] = p.x;
      pointZ[at] = p.z;
      scores[at] = settlementScore(
        p.x,
        p.z,
        worldSeed,
        terrain,
        rivers,
        habitability(p.x, p.z, worldSeed),
      );
    }
  }

  const out: Settlement[] = [];
  for (let row = 1; row < cols - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      const at = row * cols + col;
      const score = scores[at] as number;
      if (score < SETTLEMENT_MIN_SCORE) continue;

      // Strict local maximum over the 3x3 neighbourhood. Decided by nine cells,
      // so two regions that both see this cell reach the same verdict. Ties are
      // broken by cell index, which is a total order, so two equal candidates
      // can never both survive.
      let best = true;
      for (let dr = -1; dr <= 1 && best; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const other = (row + dr) * cols + (col + dc);
          const otherScore = scores[other] as number;
          if (otherScore > score || (otherScore === score && other < at)) {
            best = false;
            break;
          }
        }
      }
      if (!best) continue;

      const x = pointX[at] as number;
      const z = pointZ[at] as number;
      const quality = clamp((score - SETTLEMENT_MIN_SCORE) / (1 - SETTLEMENT_MIN_SCORE), 0, 1);
      out.push({
        cellX: cell0X - 1 + col,
        cellZ: cell0Z - 1 + row,
        x,
        z,
        y: terrain.height(x, z, worldSeed),
        score,
        radius: lerp(SETTLEMENT_RADIUS_MIN, SETTLEMENT_RADIUS_MAX, quality),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Gabriel graph
// ---------------------------------------------------------------------------

/**
 * Which settlement pairs are joined by a road.
 *
 * An edge (a, b) survives iff it is no longer than `ROAD_MAX_EDGE` and no third
 * settlement lies strictly inside the disc having ab as its diameter. See the
 * header for why this and not a minimum spanning tree.
 *
 * Exported so the locality property -- a distant settlement cannot change a
 * nearby edge -- can be asserted directly, since that is the whole reason for
 * the choice.
 */
export function gabrielEdges(settlements: readonly Settlement[]): [number, number][] {
  const edges: [number, number][] = [];
  const n = settlements.length;
  for (let i = 0; i < n; i++) {
    const a = settlements[i] as Settlement;
    for (let j = i + 1; j < n; j++) {
      const b = settlements[j] as Settlement;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      if (lengthSq > ROAD_MAX_EDGE * ROAD_MAX_EDGE) continue;

      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      const radiusSq = lengthSq / 4;
      let blocked = false;
      for (let k = 0; k < n && !blocked; k++) {
        if (k === i || k === j) continue;
        const c = settlements[k] as Settlement;
        const cx = c.x - midX;
        const cz = c.z - midZ;
        if (cx * cx + cz * cz < radiusSq) blocked = true;
      }
      if (!blocked) edges.push([i, j]);
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// A lazily sampled view of the pre-carve terrain on the routing lattice
// ---------------------------------------------------------------------------

/**
 * Heights and carve depths on the global routing lattice, sampled on demand.
 *
 * A* explores a fraction of any window it is given, so sampling the whole thing
 * up front would pay for ground no road ever considers. Laziness cannot affect
 * the answer -- `terrain.height` is pure -- and the lattice being global means
 * the value for a cell is the same whichever edge or region asked for it.
 *
 * Discarded once the region is routed. It is a build-time accelerator, not part
 * of the network, so it never enters the memo's footprint.
 */
class RoutingLattice {
  readonly cols: number;
  private readonly height: Float64Array;
  private readonly drop: Float64Array;
  private readonly sampled: Uint8Array;

  constructor(
    readonly cell0X: number,
    readonly cell0Z: number,
    cols: number,
    private readonly worldSeed: number,
    private readonly terrain: RoadTerrain,
    private readonly rivers: RoadRivers,
  ) {
    this.cols = cols;
    const count = cols * cols;
    this.height = new Float64Array(count);
    this.drop = new Float64Array(count);
    this.sampled = new Uint8Array(count);
  }

  worldX(col: number): number {
    return (this.cell0X + col) * ROAD_CELL + ROAD_CELL / 2;
  }

  worldZ(row: number): number {
    return (this.cell0Z + row) * ROAD_CELL + ROAD_CELL / 2;
  }

  private ensure(index: number, col: number, row: number): void {
    if (this.sampled[index] === 1) return;
    const x = this.worldX(col);
    const z = this.worldZ(row);
    const h = this.terrain.height(x, z, this.worldSeed);
    this.height[index] = h;
    this.drop[index] = this.rivers.drop(x, z, h);
    this.sampled[index] = 1;
    profile.samples++;
  }

  heightAt(col: number, row: number): number {
    const index = row * this.cols + col;
    this.ensure(index, col, row);
    return this.height[index] as number;
  }

  dropAt(col: number, row: number): number {
    const index = row * this.cols + col;
    this.ensure(index, col, row);
    return this.drop[index] as number;
  }
}

// ---------------------------------------------------------------------------
// Path routing
// ---------------------------------------------------------------------------

/** A routed path: world-space points, nearest-first from a to b. */
interface RoutedPath {
  readonly x: number[];
  readonly z: number[];
}

/**
 * The A* working set, allocated ONCE per region and reset per edge.
 *
 * A region routes tens of edges, and these arrays are sized by the lattice
 * rather than by the edge -- about 700 kB together. Allocating them inside
 * `routeEdge` cost ~23 MB of garbage per region, which is a measurable share of
 * generation time and lands squarely in the heap budget the soak watches. The
 * three `fill`s that reset them are a few hundred thousand writes per edge and
 * do not show up at all.
 */
interface SearchScratch {
  readonly gScore: Float64Array;
  readonly cameFrom: Int32Array;
  readonly closed: Uint8Array;
  readonly entryScore: Float64Array;
  readonly entryCell: Int32Array;
}

function createScratch(cellCount: number): SearchScratch {
  // Every cell can be improved at most once per incoming direction, so eight
  // entries a cell bounds the frontier for a complete sweep of the lattice.
  const capacity = cellCount * 8 + 1;
  return {
    gScore: new Float64Array(cellCount),
    cameFrom: new Int32Array(cellCount),
    closed: new Uint8Array(cellCount),
    entryScore: new Float64Array(capacity),
    entryCell: new Int32Array(capacity),
  };
}

/** Global lattice cell index containing a world coordinate. */
function cellOf(world: number): number {
  return Math.floor(world / ROAD_CELL);
}

/** Counters for profiling only. Not part of any determinism claim. */
const profile = { samples: 0, expanded: 0, pushes: 0 };
export function roadProfile(): { samples: number; expanded: number; pushes: number } {
  return { ...profile };
}

/**
 * Route one edge with A*.
 *
 * THE WINDOW COMES FROM THE EDGE, NOT FROM THE REGION. That is what makes a
 * path a pure function of `(a, b, terrain, seed)` and therefore identical from
 * every region that routes it -- which in turn is what lets a query consult one
 * region instead of blending four. A region-sized window would make the search
 * space depend on which region asked, and two regions could then return
 * different centrelines for the same road.
 *
 * Cost is metres travelled, multiplied by a squared slope penalty and charged
 * extra for crossing a channel. The heuristic is straight-line distance, which
 * is admissible because every multiplier is at least 1.
 *
 * Returns `undefined` when no route exists inside the window -- an edge blocked
 * by a lake or the sea. The edge is then simply not built.
 */
function routeEdge(
  a: Settlement,
  b: Settlement,
  terrain: RoadTerrain,
  grid: RoutingLattice,
  scratch: SearchScratch,
): RoutedPath | undefined {
  const cols = grid.cols;

  // The search rectangle is derived from the EDGE. The lattice merely has to
  // contain it, and is sized so that it always does for any edge the region
  // routes; clamping here is belt and braces rather than a behaviour.
  const boundC0 = Math.max(0, cellOf(Math.min(a.x, b.x) - ROAD_DETOUR_MARGIN) - grid.cell0X);
  const boundC1 = Math.min(cols - 1, cellOf(Math.max(a.x, b.x) + ROAD_DETOUR_MARGIN) - grid.cell0X);
  const boundR0 = Math.max(0, cellOf(Math.min(a.z, b.z) - ROAD_DETOUR_MARGIN) - grid.cell0Z);
  const boundR1 = Math.min(cols - 1, cellOf(Math.max(a.z, b.z) + ROAD_DETOUR_MARGIN) - grid.cell0Z);

  const startCol = cellOf(a.x) - grid.cell0X;
  const startRow = cellOf(a.z) - grid.cell0Z;
  const goalCol = cellOf(b.x) - grid.cell0X;
  const goalRow = cellOf(b.z) - grid.cell0Z;
  if (startCol < boundC0 || startCol > boundC1 || startRow < boundR0 || startRow > boundR1) {
    return undefined;
  }
  if (goalCol < boundC0 || goalCol > boundC1 || goalRow < boundR0 || goalRow > boundR1) {
    return undefined;
  }

  const goal = goalRow * cols + goalCol;
  const start = startRow * cols + startCol;
  const { gScore, cameFrom, closed, entryScore, entryCell } = scratch;
  gScore.fill(Infinity);
  cameFrom.fill(-1);
  closed.fill(0);

  const heuristic = (col: number, row: number): number => {
    const dx = (col - goalCol) * ROAD_CELL;
    const dz = (row - goalRow) * ROAD_CELL;
    return Math.sqrt(dx * dx + dz * dz) * HEURISTIC_WEIGHT;
  };

  // THE FRONTIER IS KEYED ON ENTRIES, NOT ON CELLS, and that is a correctness
  // requirement rather than a style. `CellHeap` reads its key array at
  // comparison time, so lowering the f-score of a cell already in the heap
  // would silently reorder an entry the heap has already placed and break the
  // heap property. Lazy deletion instead: every improvement pushes a NEW entry
  // carrying its own score, and a cell is skipped once it has been closed. The
  // entry index also gives the tie-break a total order -- insertion order --
  // which is what a flat plain full of equal f-scores needs.
  const capacity = entryScore.length;
  let entries = 0;
  const open = new CellHeap(capacity, entryScore);
  // The frontier is bounded by the scratch buffers, which are sized for the
  // worst case a full sweep of the lattice can produce. Running out means the
  // search rectangle is larger than anything this region should be routing, so
  // the edge is abandoned rather than the buffer grown -- an unbounded frontier
  // here is an unbounded allocation on the hottest path in generation.
  const push = (cell: number, score: number): boolean => {
    if (entries >= capacity) return false;
    entryScore[entries] = score;
    entryCell[entries] = cell;
    open.push(entries);
    entries++;
    profile.pushes++;
    return true;
  };

  gScore[start] = 0;
  push(start, heuristic(startCol, startRow));

  let found = false;
  while (open.length > 0) {
    const current = entryCell[open.pop()] as number;
    if (closed[current] === 1) continue;
    if (current === goal) {
      found = true;
      break;
    }
    closed[current] = 1;
    profile.expanded++;

    const col = current % cols;
    const row = (current - col) / cols;
    const here = grid.heightAt(col, row);

    for (let k = 0; k < 8; k++) {
      const nc = col + (NEIGHBOUR_DX[k] as number);
      const nr = row + (NEIGHBOUR_DZ[k] as number);
      if (nc < boundC0 || nc > boundC1 || nr < boundR0 || nr > boundR1) continue;
      const next = nr * cols + nc;
      if (closed[next] === 1) continue;

      const there = grid.heightAt(nc, nr);
      // The sea is not a road surface. The goal itself is always allowed, so a
      // coastal settlement whose cell centre dips below the line is reachable.
      if (there < terrain.seaLevel && next !== goal) continue;

      const run = (NEIGHBOUR_DIST[k] as number) * ROAD_CELL;
      const rise = Math.abs(there - here);
      const grade = rise / run;
      const cost =
        run * (1 + SLOPE_COST * grade * grade) + grid.dropAt(nc, nr) * RIVER_CROSSING_COST;
      const tentative = (gScore[current] as number) + cost;
      if (tentative >= (gScore[next] as number)) continue;

      cameFrom[next] = current;
      gScore[next] = tentative;
      if (!push(next, tentative + heuristic(nc, nr))) return undefined;
    }
  }
  if (!found) return undefined;

  // Walk the chain back, then reverse, so the path runs a -> b.
  const cells: number[] = [];
  for (let cell = goal; cell !== -1; cell = cameFrom[cell] as number) {
    cells.push(cell);
    if (cell === start) break;
  }
  cells.reverse();

  const x: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as number;
    const col = cell % cols;
    const row = (cell - col) / cols;
    x.push(grid.worldX(col));
    z.push(grid.worldZ(row));
  }
  // The endpoints are the settlements themselves, not the cell centres nearest
  // to them: a road has to arrive at the village, not near it.
  x[0] = a.x;
  z[0] = a.z;
  x[x.length - 1] = b.x;
  z[z.length - 1] = b.z;
  return { x, z };
}

/**
 * Route a single edge, standalone.
 *
 * The same code path `generateRegionRoads` uses, with a lattice sized to the
 * edge rather than to a region. That is not a second implementation: the search
 * rectangle is derived from the edge either way, and the lattice is given a
 * cell of slack so the rectangle is never clamped, so the traversal -- and
 * therefore the path -- is identical to the one a region produces. A unit test
 * asserts exactly that, because the claim is the whole basis for consulting one
 * region per query instead of blending four.
 *
 * Exists for the tests, which need to drive the router over synthetic terrain
 * where the right answer is known, and for Phase 5, which will want a road's
 * centreline without a region around it.
 */
export function routeRoadBetween(
  a: Settlement,
  b: Settlement,
  worldSeed: number,
  terrain: RoadTerrain,
  rivers: RoadRivers,
): { x: number[]; z: number[] } | undefined {
  const cell0X = cellOf(Math.min(a.x, b.x) - ROAD_DETOUR_MARGIN) - 1;
  const cell0Z = cellOf(Math.min(a.z, b.z) - ROAD_DETOUR_MARGIN) - 1;
  const cols =
    Math.max(
      cellOf(Math.max(a.x, b.x) + ROAD_DETOUR_MARGIN) - cell0X,
      cellOf(Math.max(a.z, b.z) + ROAD_DETOUR_MARGIN) - cell0Z,
    ) + 2;
  const grid = new RoutingLattice(cell0X, cell0Z, cols, worldSeed >>> 0, terrain, rivers);
  const raw = routeEdge(a, b, terrain, grid, createScratch(cols * cols));
  return raw === undefined ? undefined : smoothPath(raw);
}

/**
 * Pull each interior point toward the midpoint of its neighbours.
 *
 * The A* path is a chain of 8-direction steps on a 128 m lattice, so its raw
 * form has 45-degree corners. One pass, weighted toward the point's own
 * position, rounds those off without letting the path drift off the saddle it
 * found. The same one-pass approach `rivers.ts` uses on channel nodes.
 */
function smoothPath(path: RoutedPath): RoutedPath {
  const n = path.x.length;
  if (n < 3) return path;
  const x = path.x.slice();
  const z = path.z.slice();
  for (let i = 1; i < n - 1; i++) {
    x[i] = ((path.x[i - 1] as number) + 2 * (path.x[i] as number) + (path.x[i + 1] as number)) / 4;
    z[i] = ((path.z[i - 1] as number) + 2 * (path.z[i] as number) + (path.z[i + 1] as number)) / 4;
  }
  return { x, z };
}

/**
 * The altitude the road surface holds along a path.
 *
 * Starts from the terrain under the path, then runs a forward and a backward
 * pass clamping the change between adjacent points to `ROAD_MAX_GRADE`. Two
 * passes are needed because one only bounds the climb in the direction it
 * sweeps; running both and taking the tighter of the two bounds the descent as
 * well, and the result is independent of which end the path was routed from.
 *
 * The ends are pinned to the settlements' own altitudes, so a road meets the
 * ground it serves exactly.
 */
function gradeProfile(path: RoutedPath, a: Settlement, b: Settlement, terrain: RoadTerrain, worldSeed: number): Float64Array {
  const n = path.x.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = terrain.height(path.x[i] as number, path.z[i] as number, worldSeed);
  }
  y[0] = a.y;
  y[n - 1] = b.y;
  if (n < 3) return y;

  // Smooth the profile BEFORE limiting its gradient. Without this the road is
  // the terrain: it follows every hump and hollow under it, the grading has
  // nothing to move, and the only thing left that says "road" is the colour.
  // Three [1,2,1] passes average over roughly +/-3 nodes, which at 128 m
  // spacing is a few hundred metres -- enough to cut the humps and fill the
  // hollows, short enough that a road still follows the shape of a valley.
  for (let pass = 0; pass < 3; pass++) {
    const source = new Float64Array(y);
    for (let i = 1; i < n - 1; i++) {
      y[i] =
        ((source[i - 1] as number) + 2 * (source[i] as number) + (source[i + 1] as number)) / 4;
    }
  }

  const spanTo = (i: number): number => {
    const dx = (path.x[i] as number) - (path.x[i - 1] as number);
    const dz = (path.z[i] as number) - (path.z[i - 1] as number);
    return Math.sqrt(dx * dx + dz * dz);
  };

  const up = new Float64Array(y);
  for (let i = 1; i < n; i++) {
    const limit = (up[i - 1] as number) + ROAD_MAX_GRADE * spanTo(i);
    if ((up[i] as number) > limit) up[i] = limit;
  }
  const down = new Float64Array(y);
  for (let i = n - 2; i >= 0; i--) {
    const limit = (down[i + 1] as number) + ROAD_MAX_GRADE * spanTo(i + 1);
    if ((down[i] as number) > limit) down[i] = limit;
  }
  for (let i = 0; i < n; i++) {
    y[i] = Math.min(up[i] as number, down[i] as number);
  }
  y[0] = a.y;
  y[n - 1] = b.y;
  return y;
}

// ---------------------------------------------------------------------------
// Region-tier generation
// ---------------------------------------------------------------------------

/**
 * Route the settlements and roads of one region.
 *
 * RULE 3 IS ENFORCED BY THE ARGUMENT LIST. `context` is a REGION tier context,
 * so `context.coarser('sector')` and `context.coarser('chunk')` both throw --
 * this function could not read finer-tier data if it tried. Rivers arrive as an
 * argument rather than through `coarser('region')`, which would also throw,
 * because they are the same tier.
 *
 * Prefer `regionRoads`, which memoises this. Exported directly so tests can
 * drive it with synthetic terrain and assert on the routing itself.
 */
export function generateRegionRoads(
  coord: RegionCoord,
  context: TierContext,
  terrain: RoadTerrain,
  rivers: RoadRivers,
  habitability: (x: number, z: number, worldSeed: number) => number = () => 0.5,
): RoadNetwork {
  if (context.tier !== 'region') {
    throw new Error(`generateRegionRoads needs a 'region' TierContext, got '${context.tier}'`);
  }
  const worldSeed = context.worldSeed;

  const minX = coord.x * REGION_SIZE - ROAD_REACH;
  const minZ = coord.z * REGION_SIZE - ROAD_REACH;

  // -- 1. site the settlements on the global lattice --------------------------
  const settlements = siteSettlements(coord.x, coord.z, worldSeed, terrain, rivers, habitability);

  // -- 2. the Gabriel graph, pruned to what can reach this region -------------
  //
  // Deciding the graph over the WHOLE padded set and pruning afterwards is the
  // order that matters: pruning first would hide a settlement whose presence
  // blocks an edge, and the two regions either side of a boundary would then
  // disagree about that edge.
  const allEdges = gabrielEdges(settlements);
  const reachMinX = coord.x * REGION_SIZE - ROAD_REACH;
  const reachMaxX = (coord.x + 1) * REGION_SIZE + ROAD_REACH;
  const reachMinZ = coord.z * REGION_SIZE - ROAD_REACH;
  const reachMaxZ = (coord.z + 1) * REGION_SIZE + ROAD_REACH;
  const edges = allEdges.filter(([i, j]) => {
    const a = settlements[i] as Settlement;
    const b = settlements[j] as Settlement;
    // The routed path stays inside the edge's bounding box plus its detour
    // margin, so that box is what has to meet the region's reach.
    return (
      Math.min(a.x, b.x) - ROAD_DETOUR_MARGIN <= reachMaxX &&
      Math.max(a.x, b.x) + ROAD_DETOUR_MARGIN >= reachMinX &&
      Math.min(a.z, b.z) - ROAD_DETOUR_MARGIN <= reachMaxZ &&
      Math.max(a.z, b.z) + ROAD_DETOUR_MARGIN >= reachMinZ
    );
  });

  // -- 3-4. route, smooth and grade each edge ---------------------------------
  //
  // ONE lattice, shared by every edge of the region, indexed on the GLOBAL cell
  // index so a cell sampled for one edge is reused by the next. It is a
  // build-time accelerator only: what bounds each search is the EDGE's own
  // rectangle, which is what keeps a path identical whichever region routes it.
  //
  // Its extent is `ROAD_REACH + ROAD_MAX_EDGE + ROAD_DETOUR_MARGIN` beyond the
  // region on every side, which is exactly the furthest an edge this region
  // routes can put its search rectangle. Lazy sampling means the untouched
  // majority of it costs nothing but address space, and it is discarded once the
  // region is routed rather than entering the memo.
  const latticeReach = ROAD_REACH + ROAD_MAX_EDGE + ROAD_DETOUR_MARGIN;
  const latticeCell0X = cellOf(coord.x * REGION_SIZE - latticeReach);
  const latticeCell0Z = cellOf(coord.z * REGION_SIZE - latticeReach);
  const latticeCols =
    cellOf((coord.x + 1) * REGION_SIZE + latticeReach) - latticeCell0X + 1;
  const grid = new RoutingLattice(
    latticeCell0X,
    latticeCell0Z,
    latticeCols,
    worldSeed,
    terrain,
    rivers,
  );
  const scratch = createScratch(latticeCols * latticeCols);

  const nodeX: number[] = [];
  const nodeZ: number[] = [];
  const nodeY: number[] = [];
  const nodeHalfWidth: number[] = [];
  const pathStart: number[] = [];
  const segA: number[] = [];
  const segB: number[] = [];
  const segCross: number[] = [];
  let crossingCount = 0;
  let routed = 0;

  for (const [i, j] of edges) {
    const a = settlements[i] as Settlement;
    const b = settlements[j] as Settlement;
    const raw = routeEdge(a, b, terrain, grid, scratch);
    if (raw === undefined) continue;
    routed++;
    const path = smoothPath(raw);
    const profile = gradeProfile(path, a, b, terrain, worldSeed);
    const halfWidth = lerp(ROAD_HALF_WIDTH_MIN, ROAD_HALF_WIDTH_MAX, Math.max(a.score, b.score));

    const first = nodeX.length;
    pathStart.push(first);
    for (let n = 0; n < path.x.length; n++) {
      nodeX.push(path.x[n] as number);
      nodeZ.push(path.z[n] as number);
      nodeY.push(profile[n] as number);
      nodeHalfWidth.push(halfWidth);
    }
    for (let n = 0; n + 1 < path.x.length; n++) {
      const px = (path.x[n] as number) + (path.x[n + 1] as number);
      const pz = (path.z[n] as number) + (path.z[n + 1] as number);
      const midX = px / 2;
      const midZ = pz / 2;
      const midBase = terrain.height(midX, midZ, worldSeed);
      const crossing = rivers.drop(midX, midZ, midBase) >= CROSSING_DROP ? 1 : 0;
      if (crossing === 1) crossingCount++;
      segA.push(first + n);
      segB.push(first + n + 1);
      segCross.push(crossing);
    }
  }

  // -- 5. bucket index over the region plus its reach -------------------------
  //
  // Segments are registered into every bucket their corridor-inflated bounding
  // box touches, so a query reads exactly ONE bucket. The build runs once per
  // region; the query runs ~1,200 times per chunk.
  const bucketCount = BUCKET_COLS * BUCKET_COLS;
  const segCount = segA.length;
  const counts = new Int32Array(bucketCount);

  const bucketRange = (
    index: number,
  ): { c0: number; c1: number; r0: number; r1: number } | undefined => {
    const ax = nodeX[segA[index] as number] as number;
    const az = nodeZ[segA[index] as number] as number;
    const bx = nodeX[segB[index] as number] as number;
    const bz = nodeZ[segB[index] as number] as number;
    const pad = (nodeHalfWidth[segA[index] as number] as number) + ROAD_SHOULDER;
    const c0 = Math.floor((Math.min(ax, bx) - pad - minX) / BUCKET_METRES);
    const c1 = Math.floor((Math.max(ax, bx) + pad - minX) / BUCKET_METRES);
    const r0 = Math.floor((Math.min(az, bz) - pad - minZ) / BUCKET_METRES);
    const r1 = Math.floor((Math.max(az, bz) + pad - minZ) / BUCKET_METRES);
    if (c1 < 0 || r1 < 0 || c0 >= BUCKET_COLS || r0 >= BUCKET_COLS) return undefined;
    return {
      c0: Math.max(0, c0),
      c1: Math.min(BUCKET_COLS - 1, c1),
      r0: Math.max(0, r0),
      r1: Math.min(BUCKET_COLS - 1, r1),
    };
  };

  for (let s = 0; s < segCount; s++) {
    const range = bucketRange(s);
    if (range === undefined) continue;
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const bucket = r * BUCKET_COLS + c;
        counts[bucket] = (counts[bucket] as number) + 1;
      }
    }
  }
  const bucketStart = new Int32Array(bucketCount + 1);
  for (let i = 0; i < bucketCount; i++) {
    bucketStart[i + 1] = (bucketStart[i] as number) + (counts[i] as number);
  }
  const bucketSeg = new Int32Array(bucketStart[bucketCount] as number);
  const cursor = Int32Array.from(bucketStart.subarray(0, bucketCount));
  for (let s = 0; s < segCount; s++) {
    const range = bucketRange(s);
    if (range === undefined) continue;
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const bucket = r * BUCKET_COLS + c;
        bucketSeg[cursor[bucket] as number] = s;
        cursor[bucket] = (cursor[bucket] as number) + 1;
      }
    }
  }

  const segNode = new Int32Array(segCount * 2);
  for (let s = 0; s < segCount; s++) {
    segNode[s * 2] = segA[s] as number;
    segNode[s * 2 + 1] = segB[s] as number;
  }

  // Settlements are kept only where they can influence this region, so the
  // network does not carry a padded window's worth of them into the memo.
  const kept = settlements.filter(
    (s) =>
      s.x + s.radius >= reachMinX &&
      s.x - s.radius <= reachMaxX &&
      s.z + s.radius >= reachMinZ &&
      s.z - s.radius <= reachMaxZ,
  );

  return {
    terrain,
    worldSeed,
    regionX: coord.x,
    regionZ: coord.z,
    minX,
    minZ,
    settlements: kept,
    nodeX: Float64Array.from(nodeX),
    nodeZ: Float64Array.from(nodeZ),
    nodeY: Float64Array.from(nodeY),
    nodeHalfWidth: Float64Array.from(nodeHalfWidth),
    pathStart: Int32Array.from([...pathStart, nodeX.length]),
    segNode,
    segCrossing: Uint8Array.from(segCross),
    bucketStart,
    bucketSeg,
    edgeCount: routed,
    crossingCount,
  };
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

const cache: RoadNetwork[] = [];
let cacheBuilds = 0;

/** Diagnostics for tests and the HUD. Not part of any determinism claim. */
export function roadCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: cache.length, limit: ROAD_CACHE_LIMIT, builds: cacheBuilds };
}

export function clearRoadCache(): void {
  cache.length = 0;
}

/**
 * The routed network for one region, memoised.
 *
 * Same shape as `regionRivers`: a linear scan over an array, four fields
 * compared with `terrain` by REFERENCE, promotion by SWAPPING with the entry in
 * front rather than splice-and-unshift. This runs once per chunk vertex, so a
 * hit must not move memory.
 */
export function regionRoads(
  terrain: RoadTerrain,
  rivers: RoadRivers,
  habitability: (x: number, z: number, worldSeed: number) => number,
  worldSeed: number,
  regionX: number,
  regionZ: number,
): RoadNetwork {
  const seed = worldSeed >>> 0;
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i] as RoadNetwork;
    if (
      entry.regionX === regionX &&
      entry.regionZ === regionZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain
    ) {
      if (i > 0) {
        cache[i] = cache[i - 1] as RoadNetwork;
        cache[i - 1] = entry;
      }
      return entry;
    }
  }

  const built = generateRegionRoads(
    { x: regionX, z: regionZ },
    createTierContext(seed, 'region'),
    terrain,
    rivers,
    habitability,
  );
  cacheBuilds++;
  cache.unshift(built);
  if (cache.length > ROAD_CACHE_LIMIT) cache.length = ROAD_CACHE_LIMIT;
  return built;
}

// ---------------------------------------------------------------------------
// The grading
// ---------------------------------------------------------------------------

const scratch = new Float64Array(2);

/**
 * Add one region network's influence at a point to a blend.
 *
 * ACCUMULATE, DO NOT RESOLVE. Phase 4a resolved here, because roads were the
 * only grader; Phase 4b's streets are a second grader at the Sector tier, and
 * the whole point of `GradeBlend` is that both land in one weighted average
 * rather than in two independent passes. A street that resolved separately would
 * step against the road it joins wherever their weights differed.
 *
 * The river yield is deliberately NOT applied here either -- `resolve` applies
 * it once, to everything, so a street and its road stand down by exactly the
 * same amount inside a channel.
 */
function accumulateNetwork(net: RoadNetwork, x: number, z: number, blend: GradeBlend): void {
  const col = Math.floor((x - net.minX) / BUCKET_METRES);
  const row = Math.floor((z - net.minZ) / BUCKET_METRES);
  if (col >= 0 && row >= 0 && col < BUCKET_COLS && row < BUCKET_COLS) {
    const bucket = row * BUCKET_COLS + col;
    const from = net.bucketStart[bucket] as number;
    const to = net.bucketStart[bucket + 1] as number;
    for (let s = from; s < to; s++) {
      const seg = net.bucketSeg[s] as number;
      const ai = net.segNode[seg * 2] as number;
      const bi = net.segNode[seg * 2 + 1] as number;
      const ax = net.nodeX[ai] as number;
      const az = net.nodeZ[ai] as number;
      const bx = net.nodeX[bi] as number;
      const bz = net.nodeZ[bi] as number;
      closestOnSegment(x, z, ax, az, bx, bz, scratch);
      const distance = Math.sqrt(scratch[0] as number);
      const t = scratch[1] as number;
      const half = net.nodeHalfWidth[ai] as number;
      const reach = half + ROAD_SHOULDER;
      if (distance >= reach) continue;

      // 1 across the flat bed, tapering to exactly 0 at the shoulder's edge.
      const weight = 1 - smoothstep(half, reach, distance);
      if (weight <= 0) continue;
      const target = lerp(net.nodeY[ai] as number, net.nodeY[bi] as number, t);
      // The surfacing is the bed itself, not the shoulder that blends into it.
      blend.add(weight, target, 1 - smoothstep(half * 0.6, half * 1.35, distance), SURFACE_ROAD);
    }
  }

  for (let i = 0; i < net.settlements.length; i++) {
    const s = net.settlements[i] as Settlement;
    const dx = x - s.x;
    const dz = z - s.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance >= s.radius) continue;
    const weight = 1 - smoothstep(s.radius * 0.55, s.radius, distance);
    if (weight <= 0) continue;
    blend.add(weight, s.y, weight * SETTLEMENT_SURFACE, SURFACE_ROAD);
  }
}

/**
 * The distance beyond which `roadClearance` stops being able to see a road.
 *
 * A segment is registered in every bucket its corridor-inflated box touches,
 * where the inflation is `halfWidth + ROAD_SHOULDER` -- so a one-bucket lookup
 * finds every road whose GRADING reaches the point and nothing about roads
 * further away. That is the exact range over which the answer means anything.
 */
export const ROAD_CLEARANCE_RANGE = ROAD_SHOULDER;

/**
 * Metres of clear ground between a point and the nearest ROADBED EDGE, or
 * `Infinity` when no road's corridor reaches it.
 *
 * Phase 6 needs it and nothing before it did: a lot has to be kept off the
 * carriageway, and "is a road within n metres" is not answerable from
 * `RegionRoadField.surface`, which is non-zero across an entire settlement
 * because a village pad surfaces its own ground.
 *
 * It reads the same one bucket `accumulateNetwork` does, so it costs the same as
 * one grading query -- and carries the same limit, stated in
 * `ROAD_CLEARANCE_RANGE`: an answer larger than that means "no road inside the
 * corridor", not a measured distance. Callers must compare against a threshold
 * below the range rather than treating the value as a distance to a far road.
 */
export function roadClearance(net: RoadNetwork, x: number, z: number): number {
  const col = Math.floor((x - net.minX) / BUCKET_METRES);
  const row = Math.floor((z - net.minZ) / BUCKET_METRES);
  if (col < 0 || row < 0 || col >= BUCKET_COLS || row >= BUCKET_COLS) return Infinity;

  const bucket = row * BUCKET_COLS + col;
  const from = net.bucketStart[bucket] as number;
  const to = net.bucketStart[bucket + 1] as number;
  let best = Infinity;
  for (let s = from; s < to; s++) {
    const seg = net.bucketSeg[s] as number;
    const ai = net.segNode[seg * 2] as number;
    const bi = net.segNode[seg * 2 + 1] as number;
    closestOnSegment(
      x,
      z,
      net.nodeX[ai] as number,
      net.nodeZ[ai] as number,
      net.nodeX[bi] as number,
      net.nodeZ[bi] as number,
      scratch,
    );
    const clear = Math.sqrt(scratch[0] as number) - (net.nodeHalfWidth[ai] as number);
    if (clear < best) best = clear;
  }
  return best;
}

/**
 * The road record a chunk generator reads through `TierContext.coarser`.
 *
 * `grade` is the hot path and writes into a caller-owned pair so a per-vertex
 * object allocation never happens. `lift` and `surface` are convenience wrappers
 * for tests and for the main thread, where one allocation per call is nothing.
 */
export interface RegionRoadField {
  readonly terrain: RoadTerrain;
  readonly worldSeed: number;
  /**
   * Add this tier's influence at a point to a blend. THE COMPOSABLE ONE, and
   * the only one anything downstream of Phase 4b should call: `streets.ts` adds
   * to the same blend before it is resolved, so a street and the road it joins
   * share one weighted average instead of grading the ground twice.
   */
  accumulate(x: number, z: number, blend: GradeBlend): void;
  /**
   * Roads and settlement pads ALONE, resolved. Writes `[lift, surface,
   * streetSurface]` into `out`, with the last always 0.
   *
   * Kept for the tests, which assert the Region tier's own behaviour, and for
   * anything that legitimately wants the road network without the streets on it.
   * It is NOT what decides the height of the ground -- see `gradeSurface` in
   * `height-field.ts`, which is the one composition every renderer and every
   * collision query goes through.
   */
  grade(x: number, z: number, carved: number, riverDrop: number, out: Float64Array): void;
  /** Signed metres to add to the river-carved height, roads alone. */
  lift(x: number, z: number, carved: number, riverDrop: number): number;
  /** Roadbed and settlement-ground coverage at a point, in [0, 1]. */
  surface(x: number, z: number, riverDrop: number): number;
  /** The network covering a point. Exposed for tests and for `streets.ts`. */
  networkAt(x: number, z: number): RoadNetwork;
}

/**
 * Bind a terrain, a river field and a seed into the record chunks read.
 *
 * ONE region answers each query -- `floor(world / REGION_SIZE)` -- because that
 * region has routed every edge whose corridor can reach the point, from complete
 * Gabriel information, along paths that do not depend on which region asked. See
 * the header for why that is exact rather than approximate, and why roads need
 * none of the cross-region blending rivers do.
 */
export function regionRoadField(
  terrain: RoadTerrain,
  rivers: RoadRivers,
  habitability: (x: number, z: number, worldSeed: number) => number,
  worldSeed: number,
): RegionRoadField {
  const seed = worldSeed >>> 0;
  const networkAt = (x: number, z: number): RoadNetwork =>
    regionRoads(
      terrain,
      rivers,
      habitability,
      seed,
      Math.floor(x / REGION_SIZE),
      Math.floor(z / REGION_SIZE),
    );

  // One blend for the convenience wrappers below. They are off the hot path --
  // tests and the odd main-thread query -- so a shared instance is enough, and
  // it keeps them provably identical to what `accumulate` + `resolve` produces.
  const solo = new GradeBlend();
  const soloOut = new Float64Array(GRADE_OUT_LENGTH);
  const accumulate = (x: number, z: number, blend: GradeBlend): void => {
    accumulateNetwork(networkAt(x, z), x, z, blend);
  };
  const resolveSolo = (x: number, z: number, carved: number, riverDrop: number): void => {
    solo.reset();
    accumulate(x, z, solo);
    solo.resolve(carved, riverDrop, soloOut);
  };

  return {
    terrain,
    worldSeed: seed,
    networkAt,
    accumulate,
    grade(x, z, carved, riverDrop, out) {
      resolveSolo(x, z, carved, riverDrop);
      out[GRADE_LIFT] = soloOut[GRADE_LIFT] as number;
      out[GRADE_SURFACE] = soloOut[GRADE_SURFACE] as number;
      out[GRADE_STREET_SURFACE] = soloOut[GRADE_STREET_SURFACE] as number;
    },
    lift(x, z, carved, riverDrop) {
      resolveSolo(x, z, carved, riverDrop);
      return soloOut[GRADE_LIFT] as number;
    },
    surface(x, z, riverDrop) {
      resolveSolo(x, z, 0, riverDrop);
      return soloOut[GRADE_SURFACE] as number;
    },
  };
}
