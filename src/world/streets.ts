/**
 * Streets inside a settlement, at the SECTOR tier.
 *
 * Phase 4b, and the first use of the middle tier. `Sector` has been declared in
 * `contracts.ts` since Phase 1 and read by nothing; `REGION -> SECTOR -> CHUNK`
 * has been an architecture diagram with a hole in the middle. This is the
 * content that fills it, and Phase 4a sized its settlement lattice
 * `SETTLEMENT_CELL = SECTOR_SIZE` precisely so that this would be a strict
 * REFINEMENT of that siting rather than a second, differently-aligned grid.
 *
 * ---------------------------------------------------------------------------
 * A SECTOR LAYS OUT THE SETTLEMENT WHOSE CENTRE IT CONTAINS -- AND THERE IS AT
 * MOST ONE
 *
 * The open question Phase 4a left was whether a sector should lay out the
 * settlements whose centres it contains, or clip whatever crosses its edges.
 * Containment wins, and the alignment makes it exact rather than merely simple:
 *
 *   - the settlement lattice cell size IS the sector size, and both are GLOBAL
 *     lattices anchored at the world origin, so cell `(i, j)` and sector
 *     `(i, j)` are the same 512 m square;
 *   - a cell holds exactly one candidate, jittered by at most
 *     `SETTLEMENT_JITTER` (190 m) from its centre, which is less than half the
 *     cell (256 m), so the candidate never leaves its own cell.
 *
 * Therefore a sector contains AT MOST ONE settlement centre, and it is the
 * candidate of the identically-indexed settlement cell. `generateSectorStreets`
 * throws if it ever finds two, because that would mean the alignment above had
 * been broken somewhere and everything below it is then wrong.
 *
 * CLIPPING WAS REJECTED for a concrete reason, not for taste. A street plan is a
 * whole-settlement structure -- the ring has to know where every road leaves the
 * village so it can avoid duplicating one -- so two sectors each owning half a
 * settlement would each need the other half's information to decide its own. That
 * is exactly the non-locality the Gabriel graph was chosen to avoid in Phase 4a.
 *
 * ---------------------------------------------------------------------------
 * THE CONSEQUENCE: A QUERY READS UP TO FOUR SECTORS, AND THERE IS NO BLEND
 *
 * A settlement's centre can sit `SETTLEMENT_JITTER` from its cell centre and its
 * streets reach `STREET_MAX_EXTENT` beyond that, so a sector's street plan
 * OVERHANGS its own square by up to `STREET_REACH`, which is derived from those
 * two and comes out well under half a sector. A point therefore has to consult
 * the sectors whose square, inflated by
 * `STREET_REACH`, contains it: one normally, up to four near a corner.
 *
 * That is the shape `rivers.ts` uses and NOT the shape `roads.ts` uses, and the
 * difference is worth being precise about. Rivers consult four regions and
 * combine them by a weighted MAXIMUM, because neighbouring regions genuinely
 * disagree about how big a river is and the blend is what stops the disagreement
 * being a step. Here there is nothing to disagree about: two sectors never both
 * own a settlement, so the sectors a query reads contribute DISJOINT sets of
 * streets and the union is exact. No blend, no weighting, no overlap band.
 *
 * ---------------------------------------------------------------------------
 * ONE REGION PER SECTOR, AND IT IS THE RIGHT ONE
 *
 * A sector is 512 m and a region is 4,096 m on the same global alignment, so a
 * sector lies entirely inside ONE region -- and so does the settlement whose
 * centre it contains. That matters more than it looks:
 *
 * The region containing a settlement `s` routes every Gabriel edge incident to
 * `s`. (An edge's bounding box contains `s`, which is inside the region, so the
 * box trivially meets the region's own reach box; and `SETTLEMENT_PAD` covers
 * `ROAD_MAX_EDGE + ROAD_MAX_EDGE / 2` around `s`, so the graph around `s` is
 * decided exactly.) Nothing else has to be true for this file to be correct: the
 * roads leaving a settlement are read from the one region that is guaranteed to
 * have all of them, and every sector that needs that settlement reads the same
 * region, because that sector IS in that region.
 *
 * ---------------------------------------------------------------------------
 * STREETS JOIN `GradeBlend`, THEY DO NOT ADD A SECOND PASS
 *
 * A street contributes weight and a target altitude to the SAME blend the roads
 * and the settlement pad contribute to, and the blend is resolved once. A street
 * that graded independently would step against the road it joins wherever their
 * weights differed, which is exactly the artefact Phase 4a's weighted average
 * exists to prevent. See `grading.ts`.
 *
 * Every street node targets the settlement's own altitude, the same target the
 * pad uses. That is what makes the composition trivially step-free, and it is
 * also the visible content of this phase: the pad grades a DISC flat, the
 * streets carry that same altitude out along a ring and its lanes, so a
 * settlement's graded footprint becomes a wheel rather than a circle.
 *
 * ---------------------------------------------------------------------------
 * NO TRIGONOMETRY. NONE.
 *
 * A street node's position decides a vertex's altitude, so it is on the path
 * from `(x, z)` to a stored vertex, and `Math.sin` / `Math.cos` are only
 * APPROXIMATED by the ECMAScript spec -- two engines may disagree in the last
 * bits and RULE 2 says the bytes must come back identical. So the ring is not
 * built from angles. `ringDirection` walks the L1 unit diamond (pure linear
 * arithmetic) and normalises each point onto the unit circle with one
 * `Math.sqrt`, which IEEE-754 requires to be correctly rounded. The result is
 * `n` exactly-unit directions in monotonic order around the circle, spaced
 * evenly enough that the radial jitter hides the rest.
 */

import { hash3i } from '../core/hash';
import {
  createTierContext,
  SECTOR_SIZE,
  type SectorCoord,
  type TierContext,
} from './contracts';
import { closestOnSegment, GradeBlend, SURFACE_STREET } from './grading';
import { hashUnit, lerp, smoothstep } from './noise';
import { cityPlanAt, isCity } from './city';
import {
  SETTLEMENT_JITTER,
  SETTLEMENT_RADIUS_MAX,
  SETTLEMENT_RADIUS_MIN,
  type RegionRoadField,
  type RoadNetwork,
  type RoadTerrain,
  type Settlement,
} from './roads';

// ---------------------------------------------------------------------------
// What a sector is allowed to read
// ---------------------------------------------------------------------------

/**
 * The Region-tier record, as a sector sees it.
 *
 * Declared structurally here rather than imported from `height-field.ts`,
 * because that module imports THIS one -- it is what wires the tiers together --
 * and the dependency has to run one way. `RegionField` satisfies this by shape,
 * which is all `coarser('region')` ever needed.
 */
export interface StreetRegion {
  readonly roads: RegionRoadField;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Ring radius and outer-lane radius, as fractions of the settlement's own
 * footprint radius.
 *
 * The ring sits inside the pad's flat core (which reaches `0.55 * radius` at
 * full weight) so a street always starts on ground the pad has already levelled,
 * and the lanes run out to just inside the footprint edge. Nothing here leaves
 * the settlement: a street that ran past the rim would grade ground the pad is
 * already tapering off, and the two would fight.
 */
export const STREET_RING_FRACTION = 0.58;
export const STREET_RIM_FRACTION = 0.78;

/**
 * How far a node is jittered off the regular figure: in or out as a fraction of
 * its radius, and around as a fraction of one ring-node spacing.
 *
 * BOTH ARE NEEDED AND THE ANGULAR ONE IS THE IMPORTANT ONE. With radial jitter
 * alone the ring is a regular polygon with slightly wobbly corners, and from the
 * air a settlement reads as a cartwheel stamped on the hillside -- which is what
 * the first capture of this phase showed. Moving the nodes AROUND as well is
 * what turns it into a village.
 *
 * The angular jitter is kept below half a spacing so the nodes cannot reorder;
 * a ring whose corners swapped places would cross over itself.
 */
export const STREET_RADIAL_JITTER = 0.18;
export const STREET_ANGULAR_JITTER = 0.3;

/** Ring nodes at the smallest and the largest settlement. */
export const STREET_RING_NODES_MIN = 7;
export const STREET_RING_NODES_MAX = 13;

/**
 * Half-width of the flat street bed, and the taper beyond it, in metres.
 *
 * Deliberately narrower than `ROAD_HALF_WIDTH_MIN` (3.5 m) and with a shorter
 * shoulder than `ROAD_SHOULDER` (11 m): a village lane is not a highway, and the
 * narrower bed is what keeps the street plan legible from the air instead of
 * merging into one graded blob.
 *
 * THE SHOULDER IS NOT AS NARROW AS IT COULD BE, AND THAT IS MEASURED RATHER
 * THAN GUESSED. A street holds the settlement's altitude out past the flat core
 * of the pad, so at its far end it can be holding ground a few metres off the
 * natural surface, and the shoulder is what that difference has to be spent
 * over. At 5 m the resulting bench was measurably steeper than anything the
 * roads and the pad produce on their own; at 8 m it is not. The taper is a
 * smoothstep, so the steepest slope grading can produce anywhere is
 * `1.5 * (ROAD_MAX_CUT + ROAD_MAX_FILL) / shoulder`, and a test asserts the
 * real world stays inside it.
 */
export const STREET_HALF_WIDTH = 2.6;
export const STREET_SHOULDER = 8;

/**
 * How close, as a dot product of unit directions, a candidate street may point
 * to a road leaving the settlement before it is dropped.
 *
 * 0.8 is about 37 degrees. THIS IS THE RULE THAT MAKES STREETS A REFINEMENT
 * RATHER THAN A DUPLICATE: a road already runs from the settlement centre
 * outward along its own bearing, so a lane on that bearing would be a second
 * graded corridor lying on top of the first. Dropping it leaves the ring
 * crossing the road, which is what a village looks like.
 */
export const STREET_ROAD_CLEARANCE_DOT = 0.8;

/** Roads leaving one settlement whose bearings are considered. Gabriel degree is small. */
const MAX_ROAD_BEARINGS = 8;

/**
 * The furthest any street geometry can be from its settlement's centre.
 *
 * Derived, never typed in by hand: a lane node at the rim, jittered outward, plus
 * the corridor it grades.
 */
export const STREET_MAX_EXTENT =
  SETTLEMENT_RADIUS_MAX * STREET_RIM_FRACTION * (1 + STREET_RADIAL_JITTER) +
  STREET_HALF_WIDTH +
  STREET_SHOULDER;

/**
 * Metres beyond its own square a sector's street plan can reach.
 *
 * A settlement centre is at most `SETTLEMENT_JITTER` from its cell centre, and
 * its streets reach `STREET_MAX_EXTENT` beyond that, against a half-sector of
 * 256 m. Staying under 256 m is what makes a query read at most two sectors per
 * axis; a unit test asserts that, and that no street node in the real world
 * exceeds the bound.
 */
export const STREET_REACH = Math.ceil(
  SETTLEMENT_JITTER + STREET_MAX_EXTENT - SECTOR_SIZE / 2,
);

/**
 * Sector records held at once, per JS context.
 *
 * RAISED FROM 64 TO 192 IN PHASE 5, AND PHASE 4b ASKED FOR EXACTLY THIS
 * MEASUREMENT. 64 was chosen because a query reads up to four sectors and a
 * coarse quadtree node can span a 4x4 block of them -- which is true of a
 * VERTEX and badly wrong for a NODE. A node at the root level covers 4,096 m,
 * and its padded sample grid plus `STREET_REACH` spans 11x11 = 121 sectors. One
 * short of the working set is bad; a third of it is catastrophic, because every
 * row of vertices evicts the plans the next row wants and each one is rebuilt
 * from scratch.
 *
 * It went unnoticed until now because nothing measured it. Phase 5 did, on one
 * canonical screenshot: 96 seconds to reach `__worldReady` against a 120 second
 * harness timeout, and 15 seconds with this number raised. The same view had
 * been quietly costing most of a `shots` run since Phase 4b.
 *
 * 192 covers the 121 a root node needs with room for the deck builder's own
 * lookups. The cost is a longer linear scan, which is the trade Phase 4b flagged
 * -- but move-to-front keeps the handful of sectors a fine node actually uses at
 * the front of the array, so the scan is short exactly where the vertex count is
 * high, and the entries are cheap: an empty sector is three zero-length arrays.
 */
export const STREET_CACHE_LIMIT = 192;

/** Salts, so two uses of a hash on the same cell cannot correlate. */
const RING_SALT = 0x53_74_52_67;
const LANE_SALT = 0x53_74_4c_6e;
const ANGLE_SALT = 0x53_74_41_6e;
/** Layout-family pick; must not collide with ring / lane / angle salts. */
const LAYOUT_SALT = 0x53_74_4c_79;

/** Village street-plan families. Selection is `(worldSeed, cell)` — never visit order. */
export const LAYOUT_RING = 0;
export const LAYOUT_LINEAR = 1;
export const LAYOUT_GRID = 2;
export const LAYOUT_HILLTOP = 3;
export const LAYOUT_CITY = 4;

/**
 * Which street plan a settlement gets.
 *
 * Bucketed so ring stays the majority (~52%) and the other three share the rest
 * evenly. Soak has to find each family without hunting forever; a uniform 25%
 * split would starve the canonical ring views that Phase 4b still screenshots.
 */
export function layoutFamily(worldSeed: number, cellX: number, cellZ: number): number {
  const bucket = (hash3i(cellX, cellZ, (worldSeed ^ LAYOUT_SALT) >>> 0) >>> 0) % 100;
  if (bucket < 52) return LAYOUT_RING;
  if (bucket < 68) return LAYOUT_LINEAR;
  if (bucket < 84) return LAYOUT_GRID;
  return LAYOUT_HILLTOP;
}

// ---------------------------------------------------------------------------
// The laid-out streets of one sector
// ---------------------------------------------------------------------------

/**
 * One sector's street plan.
 *
 * Empty on the overwhelming majority of sectors -- a settlement needs to be a
 * strict local maximum of the siting score over its 3x3 neighbourhood, so no two
 * adjacent cells can both hold one -- and an empty record costs three
 * zero-length arrays and one early return per query.
 *
 * Everything bulk is a typed array, like `RoadNetwork`, because this lives in a
 * bounded cache in every worker.
 */
export interface SectorStreets {
  readonly terrain: RoadTerrain;
  readonly worldSeed: number;
  readonly sectorX: number;
  readonly sectorZ: number;
  /** The settlement whose centre this sector contains, if there is one. */
  readonly settlement: Settlement | undefined;
  /** Street node positions, world metres. */
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  /** The altitude the street surface holds at the node, world metres. */
  readonly nodeY: Float64Array;
  /**
   * CSR offsets into the node arrays, one entry per street plus a final total.
   * Street `i` owns nodes `[streetStart[i], streetStart[i + 1])` and its
   * segments are the consecutive pairs inside that span.
   *
   * Phase 6 needs this to walk a street and place lots along it; the ring is
   * stored as an open polyline whose last node repeats the first position, so a
   * closed street needs no special case anywhere.
   */
  readonly streetStart: Int32Array;
  readonly streetCount: number;
  readonly segCount: number;
  /** Half-width of the flat street bed, metres. */
  readonly halfWidth: number;
  /**
   * Distance from the settlement centre beyond which no street can influence a
   * point. Zero on an empty sector. The first thing a query tests.
   */
  readonly reachRadius: number;
  /**
   * Layout family for this sector's settlement (`LAYOUT_*`), or `-1` when the
   * sector is empty. Additive field for soak / HUD anti-vacuity; CSR shape is
   * unchanged so lots, decks and grading keep walking the same polylines.
   */
  readonly layout: number;
}

const EMPTY_NODES = new Float64Array(0);

function emptyStreets(
  terrain: RoadTerrain,
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
): SectorStreets {
  return {
    terrain,
    worldSeed,
    sectorX,
    sectorZ,
    settlement: undefined,
    nodeX: EMPTY_NODES,
    nodeZ: EMPTY_NODES,
    nodeY: EMPTY_NODES,
    streetStart: new Int32Array(1),
    streetCount: 0,
    segCount: 0,
    halfWidth: STREET_HALF_WIDTH,
    reachRadius: 0,
    layout: -1,
  };
}

// ---------------------------------------------------------------------------
// Directions, without trigonometry
// ---------------------------------------------------------------------------

/**
 * A unit direction at parameter `t` in [0, 1) around the circle, into `out`.
 *
 * Walks the L1 unit diamond `|u| + |v| = 1` at constant speed -- four linear
 * segments, so every intermediate value is exact -- and projects each point onto
 * the unit circle by dividing by its length. Division and `Math.sqrt` are both
 * correctly rounded by IEEE-754, so this is bit-reproducible on every engine,
 * which `Math.cos` and `Math.sin` are not. See the header.
 *
 * The diamond-to-circle map is not quite arc-length uniform -- it compresses
 * slightly toward the diagonals -- and that is fine: the radial jitter is larger
 * than the discrepancy, and a village ring is not meant to be a regular polygon.
 */
export function ringDirection(t: number, out: Float64Array): void {
  // Wrap first, so a node jittered backwards past t = 0 comes out just clockwise
  // of (1, 0) rather than a quarter turn away. `t - floor(t)` is exact.
  const wrapped = t - Math.floor(t);
  const s = wrapped * 4;
  const q = Math.floor(s);
  const f = s - q;
  let u: number;
  let v: number;
  if (q <= 0) {
    u = 1 - f;
    v = f;
  } else if (q === 1) {
    u = -f;
    v = 1 - f;
  } else if (q === 2) {
    u = f - 1;
    v = -f;
  } else {
    u = f;
    v = f - 1;
  }
  const inverse = 1 / Math.sqrt(u * u + v * v);
  out[0] = u * inverse;
  out[1] = v * inverse;
}

/** A signed unit jitter in (-1, 1) for one settlement cell and one index. */
function jitterAt(cellX: number, cellZ: number, index: number, seed: number, salt: number): number {
  return hashUnit(hash3i(cellX, cellZ, index, (seed ^ salt) >>> 0)) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Where the roads leave
// ---------------------------------------------------------------------------

/** A road endpoint is the settlement itself, to well inside the nearest other one. */
const AT_SETTLEMENT = 1;

/**
 * Unit bearings of the roads leaving a settlement, written into `out` as xz
 * pairs. Returns how many were found.
 *
 * `RoadNetwork.pathStart` gives the CSR span of each routed road, and
 * `routeEdge` pins a path's first and last node to the settlements it joins, so
 * a road belongs to this settlement iff one of its ends is at the centre. The
 * bearing is then taken from the first node at least `ringRadius` out, which is
 * where the road actually crosses the ring -- not from the second node, which on
 * a 128 m routing lattice is a step of the search rather than a direction of
 * travel.
 */
function roadBearings(
  net: RoadNetwork,
  s: Settlement,
  ringRadius: number,
  out: Float64Array,
): number {
  let count = 0;
  const paths = net.pathStart.length - 1;
  for (let p = 0; p < paths && count < MAX_ROAD_BEARINGS; p++) {
    const from = net.pathStart[p] as number;
    const to = net.pathStart[p + 1] as number;
    if (to - from < 2) continue;

    const atFrom =
      Math.abs((net.nodeX[from] as number) - s.x) <= AT_SETTLEMENT &&
      Math.abs((net.nodeZ[from] as number) - s.z) <= AT_SETTLEMENT;
    const last = to - 1;
    const atTo =
      Math.abs((net.nodeX[last] as number) - s.x) <= AT_SETTLEMENT &&
      Math.abs((net.nodeZ[last] as number) - s.z) <= AT_SETTLEMENT;
    if (!atFrom && !atTo) continue;

    const step = atFrom ? 1 : -1;
    let at = atFrom ? from : last;
    for (;;) {
      const next = at + step;
      if (next < from || next > last) break;
      at = next;
      const dx = (net.nodeX[at] as number) - s.x;
      const dz = (net.nodeZ[at] as number) - s.z;
      if (dx * dx + dz * dz >= ringRadius * ringRadius) break;
    }

    const dx = (net.nodeX[at] as number) - s.x;
    const dz = (net.nodeZ[at] as number) - s.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq <= 0) continue;
    const inverse = 1 / Math.sqrt(lengthSq);
    out[count * 2] = dx * inverse;
    out[count * 2 + 1] = dz * inverse;
    count++;
  }
  return count;
}

/** How closely a direction lines up with the nearest road bearing, in [-1, 1]. */
function alignmentWithRoads(
  dx: number,
  dz: number,
  bearings: Float64Array,
  count: number,
): number {
  let best = -1;
  for (let i = 0; i < count; i++) {
    const dot = dx * (bearings[i * 2] as number) + dz * (bearings[i * 2 + 1] as number);
    if (dot > best) best = dot;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sector-tier generation
// ---------------------------------------------------------------------------

/**
 * Lay out the streets of one sector.
 *
 * RULE 3 IS ENFORCED BY THE ARGUMENT LIST, AND THIS IS THE FIRST THREE-LEVEL
 * READ IN THE PROJECT. `context` is a SECTOR tier context, so
 * `context.coarser('region')` is legal and returns the Region-tier record, while
 * `coarser('sector')` and `coarser('chunk')` both throw. A sector may look up
 * the road network; it could not look at a chunk if it tried.
 *
 * The record is missing rather than defaulted when the caller forgot it, for the
 * same reason `generateChunk` throws: a settlement laid out without its roads
 * would put a lane straight down the middle of one, and the failure would show
 * up as a graded artefact hundreds of chunks away rather than as an error here.
 *
 * Prefer `sectorStreets`, which memoises this.
 */
export function generateSectorStreets(
  coord: SectorCoord,
  context: TierContext,
): SectorStreets {
  if (context.tier !== 'sector') {
    throw new Error(`generateSectorStreets needs a 'sector' TierContext, got '${context.tier}'`);
  }
  const region = context.coarser<StreetRegion>('region');
  if (region === undefined || region.roads === undefined) {
    throw new Error(
      'generateSectorStreets needs the Region-tier road record on its TierContext. ' +
        'Build the context with sectorStreetField(...) or createTierContext(seed, ' +
        "'sector', { region }).",
    );
  }
  const roads = region.roads;
  const worldSeed = context.worldSeed;
  const terrain = roads.terrain;

  // ONE region, and it is the settlement's own: a sector lies entirely inside a
  // region, so the sector centre and any settlement centre inside the sector
  // resolve to the same network -- the one guaranteed to have routed every road
  // leaving that settlement. See the header.
  const centerX = coord.x * SECTOR_SIZE + SECTOR_SIZE / 2;
  const centerZ = coord.z * SECTOR_SIZE + SECTOR_SIZE / 2;
  const net = roads.networkAt(centerX, centerZ);

  // Cities are Region-owned and may cross many sectors. Every overlapping
  // sector clips the same CityPlan; villages retain centre ownership below.
  const minX = coord.x * SECTOR_SIZE;
  const minZ = coord.z * SECTOR_SIZE;
  const maxX = minX + SECTOR_SIZE;
  const maxZ = minZ + SECTOR_SIZE;
  const seenCities = new Set<string>();
  const cityNodeX: number[] = [];
  const cityNodeZ: number[] = [];
  const cityStreetStart: number[] = [0];
  let citySite: Settlement | undefined;
  for (const candidate of net.settlements) {
    if (!isCity(candidate)) continue;
    const key = `${candidate.cellX},${candidate.cellZ}`;
    if (seenCities.has(key)) continue;
    seenCities.add(key);
    const nearX = Math.max(minX, Math.min(candidate.x, maxX));
    const nearZ = Math.max(minZ, Math.min(candidate.z, maxZ));
    const dx = candidate.x - nearX;
    const dz = candidate.z - nearZ;
    if (dx * dx + dz * dz > candidate.farmRadius * candidate.farmRadius) continue;
    const plan = cityPlanAt(candidate, worldSeed);
    if (plan === undefined) continue;
    citySite ??= candidate;
    clipCityPlan(
      plan.nodeX,
      plan.nodeZ,
      plan.streetStart,
      minX - STREET_SHOULDER,
      minZ - STREET_SHOULDER,
      maxX + STREET_SHOULDER,
      maxZ + STREET_SHOULDER,
      cityNodeX,
      cityNodeZ,
      cityStreetStart,
    );
  }
  if (citySite !== undefined) {
    return finishStreets(
      terrain,
      worldSeed,
      coord.x,
      coord.z,
      citySite,
      LAYOUT_CITY,
      cityNodeX,
      cityNodeZ,
      cityStreetStart,
    );
  }

  let site: Settlement | undefined;
  let found = 0;
  for (let i = 0; i < net.settlements.length; i++) {
    const s = net.settlements[i] as Settlement;
    if (isCity(s) || Math.floor(s.x / SECTOR_SIZE) !== coord.x) continue;
    if (Math.floor(s.z / SECTOR_SIZE) !== coord.z) continue;
    found++;
    if (site === undefined) site = s;
  }
  if (found > 1) {
    // Structurally impossible while `SETTLEMENT_CELL === SECTOR_SIZE` and
    // `SETTLEMENT_JITTER < SECTOR_SIZE / 2`: one candidate per cell, and it
    // cannot leave its cell. If it ever happens, the alignment this whole file
    // rests on has been broken and silently laying out one of them would hide it.
    throw new Error(
      `sector (${coord.x}, ${coord.z}) contains ${found} settlement centres; ` +
        'the settlement lattice is no longer aligned to the sector grid.',
    );
  }
  if (site === undefined) return emptyStreets(terrain, worldSeed, coord.x, coord.z);

  const layout = layoutFamily(worldSeed, site.cellX, site.cellZ);
  const quality =
    (site.radius - SETTLEMENT_RADIUS_MIN) / (SETTLEMENT_RADIUS_MAX - SETTLEMENT_RADIUS_MIN);
  const ringRadius = site.radius * STREET_RING_FRACTION;
  const rimRadius = site.radius * STREET_RIM_FRACTION;

  const bearings = new Float64Array(MAX_ROAD_BEARINGS * 2);
  const bearingCount = roadBearings(net, site, ringRadius, bearings);

  const nodeX: number[] = [];
  const nodeZ: number[] = [];
  const streetStart: number[] = [0];

  if (layout === LAYOUT_LINEAR) {
    layoutLinear(site, worldSeed, quality, rimRadius, bearings, bearingCount, nodeX, nodeZ, streetStart);
  } else if (layout === LAYOUT_GRID) {
    layoutGrid(site, worldSeed, quality, rimRadius, bearings, bearingCount, nodeX, nodeZ, streetStart);
  } else if (layout === LAYOUT_HILLTOP) {
    layoutHilltop(site, worldSeed, quality, bearings, bearingCount, nodeX, nodeZ, streetStart);
  } else {
    layoutRing(
      site,
      worldSeed,
      quality,
      ringRadius,
      rimRadius,
      bearings,
      bearingCount,
      nodeX,
      nodeZ,
      streetStart,
    );
  }

  return finishStreets(terrain, worldSeed, coord.x, coord.z, site, layout, nodeX, nodeZ, streetStart);
}

/** Clip CityPlan segments to one sector's padded square. */
function clipCityPlan(
  x: Float64Array,
  z: Float64Array,
  starts: Uint32Array,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  outX: number[],
  outZ: number[],
  outStarts: number[],
): void {
  for (let street = 0; street + 1 < starts.length; street++) {
    const from = starts[street] as number;
    const to = starts[street + 1] as number;
    for (let i = from; i + 1 < to; i++) {
      const ax = x[i] as number;
      const az = z[i] as number;
      const bx = x[i + 1] as number;
      const bz = z[i + 1] as number;
      const clipped = clipSegment(ax, az, bx, bz, minX, minZ, maxX, maxZ);
      if (clipped === undefined) continue;
      outX.push(clipped[0], clipped[2]);
      outZ.push(clipped[1], clipped[3]);
      outStarts.push(outX.length);
    }
  }
}

function clipSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): readonly [number, number, number, number] | undefined {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - minX, maxX - ax, az - minZ, maxZ - az];
  for (let i = 0; i < 4; i++) {
    const pi = p[i] as number;
    const qi = q[i] as number;
    if (pi === 0) {
      if (qi < 0) return undefined;
      continue;
    }
    const r = qi / pi;
    if (pi < 0) {
      if (r > t1) return undefined;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return undefined;
      if (r < t1) t1 = r;
    }
  }
  return [ax + dx * t0, az + dz * t0, ax + dx * t1, az + dz * t1];
}

/**
 * Finish a plan: every node targets the settlement altitude, reach is measured,
 * CSR counts are derived. Shared by every layout family so grading stays step-free.
 */
function finishStreets(
  terrain: RoadTerrain,
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
  site: Settlement,
  layout: number,
  nodeX: number[],
  nodeZ: number[],
  streetStart: number[],
): SectorStreets {
  const count = nodeX.length;
  const nodeY = new Float64Array(count);
  nodeY.fill(site.y);

  let reachSq = 0;
  for (let i = 0; i < count; i++) {
    const dx = (nodeX[i] as number) - site.x;
    const dz = (nodeZ[i] as number) - site.z;
    const d = dx * dx + dz * dz;
    if (d > reachSq) reachSq = d;
  }
  const streetCount = streetStart.length - 1;
  let segCount = 0;
  for (let i = 0; i < streetCount; i++) {
    segCount += (streetStart[i + 1] as number) - (streetStart[i] as number) - 1;
  }

  return {
    terrain,
    worldSeed,
    sectorX,
    sectorZ,
    settlement: site,
    nodeX: Float64Array.from(nodeX),
    nodeZ: Float64Array.from(nodeZ),
    nodeY,
    streetStart: Int32Array.from(streetStart),
    streetCount,
    segCount,
    halfWidth: STREET_HALF_WIDTH,
    reachRadius: Math.sqrt(reachSq) + STREET_HALF_WIDTH + STREET_SHOULDER,
    layout,
  };
}

/** How many ring nodes a settlement of this quality gets (ring / hilltop). */
function ringNodeCount(quality: number, min: number, max: number): number {
  return Math.min(max, min + Math.floor(quality * (max - min + 1)));
}

/**
 * The original Phase 4b plan: closed ring, outer lanes, spokes in. Extracted
 * rather than rewritten so existing ring villages stay byte-identical for the
 * same `(seed, cell)` that still hashes into family 0.
 */
function layoutRing(
  site: Settlement,
  worldSeed: number,
  quality: number,
  ringRadius: number,
  rimRadius: number,
  bearings: Float64Array,
  bearingCount: number,
  nodeX: number[],
  nodeZ: number[],
  streetStart: number[],
): void {
  const ringNodes = ringNodeCount(quality, STREET_RING_NODES_MIN, STREET_RING_NODES_MAX);
  const direction = new Float64Array(2);
  const ringDX = new Float64Array(ringNodes);
  const ringDZ = new Float64Array(ringNodes);
  const ringX = new Float64Array(ringNodes);
  const ringZ = new Float64Array(ringNodes);

  for (let k = 0; k < ringNodes; k++) {
    const around =
      STREET_ANGULAR_JITTER * jitterAt(site.cellX, site.cellZ, k, worldSeed, ANGLE_SALT);
    ringDirection((k + around) / ringNodes, direction);
    const dx = direction[0] as number;
    const dz = direction[1] as number;
    const radius =
      ringRadius *
      (1 + STREET_RADIAL_JITTER * jitterAt(site.cellX, site.cellZ, k, worldSeed, RING_SALT));
    ringDX[k] = dx;
    ringDZ[k] = dz;
    ringX[k] = site.x + dx * radius;
    ringZ[k] = site.z + dz * radius;
    nodeX.push(ringX[k] as number);
    nodeZ.push(ringZ[k] as number);
  }
  // Closed by repeating the first node: open polyline, no wrap-around downstream.
  nodeX.push(ringX[0] as number);
  nodeZ.push(ringZ[0] as number);
  streetStart.push(nodeX.length);

  for (let k = 0; k < ringNodes; k++) {
    const dx = ringDX[k] as number;
    const dz = ringDZ[k] as number;
    if (alignmentWithRoads(dx, dz, bearings, bearingCount) >= STREET_ROAD_CLEARANCE_DOT) continue;

    if (k % 2 === 0) {
      const radius =
        rimRadius *
        (1 + STREET_RADIAL_JITTER * jitterAt(site.cellX, site.cellZ, k, worldSeed, LANE_SALT));
      nodeX.push(ringX[k] as number);
      nodeZ.push(ringZ[k] as number);
      nodeX.push(site.x + dx * radius);
      nodeZ.push(site.z + dz * radius);
    } else {
      nodeX.push(site.x);
      nodeZ.push(site.z);
      nodeX.push(ringX[k] as number);
      nodeZ.push(ringZ[k] as number);
    }
    streetStart.push(nodeX.length);
  }
}

/** Compact hill enclosure: smaller closed ring, few spokes, almost no outer lanes. */
function layoutHilltop(
  site: Settlement,
  worldSeed: number,
  quality: number,
  bearings: Float64Array,
  bearingCount: number,
  nodeX: number[],
  nodeZ: number[],
  streetStart: number[],
): void {
  const hillNodes = ringNodeCount(quality, 5, 8);
  const hillRadius = site.radius * 0.42;
  const direction = new Float64Array(2);
  const ringDX = new Float64Array(hillNodes);
  const ringDZ = new Float64Array(hillNodes);
  const ringX = new Float64Array(hillNodes);
  const ringZ = new Float64Array(hillNodes);

  for (let k = 0; k < hillNodes; k++) {
    const around =
      STREET_ANGULAR_JITTER * jitterAt(site.cellX, site.cellZ, k, worldSeed, ANGLE_SALT);
    ringDirection((k + around) / hillNodes, direction);
    const dx = direction[0] as number;
    const dz = direction[1] as number;
    const radius =
      hillRadius *
      (1 + STREET_RADIAL_JITTER * 0.7 * jitterAt(site.cellX, site.cellZ, k, worldSeed, RING_SALT));
    ringDX[k] = dx;
    ringDZ[k] = dz;
    ringX[k] = site.x + dx * radius;
    ringZ[k] = site.z + dz * radius;
    nodeX.push(ringX[k] as number);
    nodeZ.push(ringZ[k] as number);
  }
  nodeX.push(ringX[0] as number);
  nodeZ.push(ringZ[0] as number);
  streetStart.push(nodeX.length);

  // Spokes only, and only every other node that clears a road — compact, not a cartwheel.
  for (let k = 0; k < hillNodes; k++) {
    if (k % 2 === 0) continue;
    const dx = ringDX[k] as number;
    const dz = ringDZ[k] as number;
    if (alignmentWithRoads(dx, dz, bearings, bearingCount) >= STREET_ROAD_CLEARANCE_DOT) continue;
    nodeX.push(site.x);
    nodeZ.push(site.z);
    nodeX.push(ringX[k] as number);
    nodeZ.push(ringZ[k] as number);
    streetStart.push(nodeX.length);
  }
}

/**
 * Primary road bearing through the pad, or axis +X when the settlement is isolated.
 * Written into `out` as a unit xz pair.
 */
function primaryBearing(
  bearings: Float64Array,
  bearingCount: number,
  out: Float64Array,
): void {
  if (bearingCount <= 0) {
    out[0] = 1;
    out[1] = 0;
    return;
  }
  out[0] = bearings[0] as number;
  out[1] = bearings[1] as number;
}

/**
 * Linear village: a long spine along the strongest road bearing, short spurs
 * on both sides. The spine IS the street that follows the road corridor; spurs
 * still honour road clearance so they do not stack a second lane on another road.
 */
function layoutLinear(
  site: Settlement,
  worldSeed: number,
  quality: number,
  rimRadius: number,
  bearings: Float64Array,
  bearingCount: number,
  nodeX: number[],
  nodeZ: number[],
  streetStart: number[],
): void {
  const along = new Float64Array(2);
  primaryBearing(bearings, bearingCount, along);
  const ax = along[0] as number;
  const az = along[1] as number;
  const px = -az;
  const pz = ax;

  const halfLen = rimRadius * (0.85 + 0.1 * quality);
  const spineNodes = 4 + Math.floor(quality * 2);
  for (let i = 0; i < spineNodes; i++) {
    const t = spineNodes === 1 ? 0 : (i / (spineNodes - 1)) * 2 - 1;
    const jitter =
      STREET_RADIAL_JITTER *
      0.35 *
      halfLen *
      jitterAt(site.cellX, site.cellZ, i, worldSeed, RING_SALT);
    nodeX.push(site.x + ax * halfLen * t + px * jitter);
    nodeZ.push(site.z + az * halfLen * t + pz * jitter);
  }
  streetStart.push(nodeX.length);

  const spurLen = rimRadius * (0.32 + 0.08 * quality);
  const spurCount = 3 + Math.floor(quality * 2);
  for (let i = 0; i < spurCount; i++) {
    const t = spurCount === 1 ? 0 : (i / (spurCount - 1)) * 2 - 1;
    const sx = site.x + ax * halfLen * t * 0.85;
    const sz = site.z + az * halfLen * t * 0.85;
    const len =
      spurLen *
      (1 + STREET_RADIAL_JITTER * jitterAt(site.cellX, site.cellZ, i + 40, worldSeed, LANE_SALT));
    for (const sign of [1, -1] as const) {
      const dx = px * sign;
      const dz = pz * sign;
      if (alignmentWithRoads(dx, dz, bearings, bearingCount) >= STREET_ROAD_CLEARANCE_DOT) continue;
      nodeX.push(sx);
      nodeZ.push(sz);
      nodeX.push(sx + dx * len);
      nodeZ.push(sz + dz * len);
      streetStart.push(nodeX.length);
    }
  }
}

/**
 * Small road-aligned grid inside the rim: 2–3 streets each way. The centre line
 * along the primary road is omitted — the road already is that corridor.
 */
function layoutGrid(
  site: Settlement,
  worldSeed: number,
  quality: number,
  rimRadius: number,
  bearings: Float64Array,
  bearingCount: number,
  nodeX: number[],
  nodeZ: number[],
  streetStart: number[],
): void {
  const along = new Float64Array(2);
  primaryBearing(bearings, bearingCount, along);
  const ax = along[0] as number;
  const az = along[1] as number;
  const px = -az;
  const pz = ax;

  const n = 2 + (quality > 0.45 ? 1 : 0);
  const half = rimRadius * 0.72;

  // Streets parallel to the road (across offsets). Skip offset ≈ 0: that is the road.
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    if (Math.abs(u) < 0.2) continue;
    const ox = px * half * u;
    const oz = pz * half * u;
    const jitter =
      STREET_RADIAL_JITTER *
      0.15 *
      half *
      jitterAt(site.cellX, site.cellZ, i, worldSeed, RING_SALT);
    nodeX.push(site.x + ox - ax * half + px * jitter);
    nodeZ.push(site.z + oz - az * half + pz * jitter);
    nodeX.push(site.x + ox + ax * half + px * jitter);
    nodeZ.push(site.z + oz + az * half + pz * jitter);
    streetStart.push(nodeX.length);
  }

  // Cross streets (along offsets). Skip the centre line — that may be a leaving
  // road on the perpendicular bearing; the outer crosses still give lot frontage.
  for (let j = 0; j < n; j++) {
    const v = n === 1 ? 0 : (j / (n - 1)) * 2 - 1;
    if (Math.abs(v) < 0.2) continue;
    const ox = ax * half * v;
    const oz = az * half * v;
    const jitter =
      STREET_RADIAL_JITTER *
      0.15 *
      half *
      jitterAt(site.cellX, site.cellZ, j + 20, worldSeed, LANE_SALT);
    nodeX.push(site.x + ox - px * half + ax * jitter);
    nodeZ.push(site.z + oz - pz * half + az * jitter);
    nodeX.push(site.x + ox + px * half + ax * jitter);
    nodeZ.push(site.z + oz + pz * half + az * jitter);
    streetStart.push(nodeX.length);
  }

  // A grid that somehow emitted nothing (isolated + bad luck) still needs lot
  // frontage: fall back to one short cross through the centre.
  if (streetStart.length <= 1) {
    nodeX.push(site.x - px * half);
    nodeZ.push(site.z - pz * half);
    nodeX.push(site.x + px * half);
    nodeZ.push(site.z + pz * half);
    streetStart.push(nodeX.length);
  }
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

const cache: SectorStreets[] = [];
let cacheBuilds = 0;

/** Diagnostics for tests and the HUD. Not part of any determinism claim. */
export function streetCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: cache.length, limit: STREET_CACHE_LIMIT, builds: cacheBuilds };
}

export function clearStreetCache(): void {
  cache.length = 0;
}

/**
 * The street plan for one sector, memoised.
 *
 * Same shape as `regionRoads` and `regionRivers`: a linear scan over an array
 * with `terrain` compared by REFERENCE, promotion by SWAPPING with the entry in
 * front rather than splice-and-unshift, because a hit runs on the hottest path
 * in generation and must not move memory.
 *
 * The limit is higher than the road cache's 8 because sectors are 64 times
 * smaller: a coarse quadtree node can span a 4x4 block of them and a query reads
 * up to four per point, so a smaller cache would thrash on exactly the nodes
 * that cover the most ground. The entries are cheap -- most sectors hold no
 * settlement and cost three empty arrays.
 */
export function sectorStreets(
  region: StreetRegion,
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
): SectorStreets {
  const seed = worldSeed >>> 0;
  const terrain = region.roads.terrain;
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i] as SectorStreets;
    if (
      entry.sectorX === sectorX &&
      entry.sectorZ === sectorZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain
    ) {
      if (i > 0) {
        cache[i] = cache[i - 1] as SectorStreets;
        cache[i - 1] = entry;
      }
      return entry;
    }
  }

  const built = generateSectorStreets(
    { x: sectorX, z: sectorZ },
    createTierContext(seed, 'sector', { region }),
  );
  cacheBuilds++;
  cache.unshift(built);
  if (cache.length > STREET_CACHE_LIMIT) cache.length = STREET_CACHE_LIMIT;
  return built;
}

// ---------------------------------------------------------------------------
// The grading
// ---------------------------------------------------------------------------

const scratch = new Float64Array(2);

/** Add one sector's streets at a point to a blend. */
function accumulateSector(
  rec: SectorStreets,
  x: number,
  z: number,
  blend: GradeBlend,
): void {
  const site = rec.settlement;
  if (site === undefined) return;
  // One disc test rejects every point outside the village, which is almost all
  // of them even on a chunk that touches one.
  const dx = x - site.x;
  const dz = z - site.z;
  if (dx * dx + dz * dz >= rec.reachRadius * rec.reachRadius) return;

  const half = rec.halfWidth;
  const reach = half + STREET_SHOULDER;
  for (let s = 0; s < rec.streetCount; s++) {
    const from = rec.streetStart[s] as number;
    const to = rec.streetStart[s + 1] as number;
    for (let i = from; i + 1 < to; i++) {
      closestOnSegment(
        x,
        z,
        rec.nodeX[i] as number,
        rec.nodeZ[i] as number,
        rec.nodeX[i + 1] as number,
        rec.nodeZ[i + 1] as number,
        scratch,
      );
      const distance = Math.sqrt(scratch[0] as number);
      if (distance >= reach) continue;
      // 1 across the flat bed, tapering to exactly 0 at the shoulder's edge --
      // the same profile a road uses, so a street meeting a road is two equal
      // weights meeting rather than two different falloffs.
      const weight = 1 - smoothstep(half, reach, distance);
      if (weight <= 0) continue;
      const target = lerp(
        rec.nodeY[i] as number,
        rec.nodeY[i + 1] as number,
        scratch[1] as number,
      );
      blend.add(
        weight,
        target,
        1 - smoothstep(half * 0.6, half * 1.35, distance),
        SURFACE_STREET,
      );
    }
  }
}

/**
 * The sector record a chunk generator reads through `TierContext.coarser`.
 *
 * `accumulate` is the hot path and adds into a caller-owned blend, so a
 * per-vertex allocation never happens. `streetsAt` is exposed for tests and for
 * Phase 6, which will want a settlement's streets to hang lots off.
 */
export interface SectorStreetField {
  readonly worldSeed: number;
  /** Add every street influencing a point to a blend. Reads one to four sectors. */
  accumulate(x: number, z: number, blend: GradeBlend): void;
  /** The plan of one sector, by sector coordinate. */
  streetsAt(sectorX: number, sectorZ: number): SectorStreets;
}

/**
 * Bind a Region-tier record and a seed into the record chunks read.
 *
 * A query consults every sector whose square, inflated by `STREET_REACH`,
 * contains the point: one normally, two across an edge, four near a corner.
 * There is no blending between them and none is needed -- two sectors never both
 * own a settlement, so what they contribute is disjoint. See the header.
 */
export function sectorStreetField(region: StreetRegion, worldSeed: number): SectorStreetField {
  const seed = worldSeed >>> 0;
  return {
    worldSeed: seed,
    streetsAt: (sectorX, sectorZ) => sectorStreets(region, seed, sectorX, sectorZ),
    accumulate(x, z, blend) {
      const c0 = Math.floor((x - STREET_REACH) / SECTOR_SIZE);
      const c1 = Math.floor((x + STREET_REACH) / SECTOR_SIZE);
      const r0 = Math.floor((z - STREET_REACH) / SECTOR_SIZE);
      const r1 = Math.floor((z + STREET_REACH) / SECTOR_SIZE);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          accumulateSector(sectorStreets(region, seed, c, r), x, z, blend);
        }
      }
    },
  };
}
