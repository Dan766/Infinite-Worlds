/**
 * Road and street DECKS: the made surface of a carriageway, as geometry.
 *
 * Phase 5, and the first content since Phase 3a's water that is its own submesh
 * rather than a modification of the terrain mesh every node already had. Rivers
 * dented that mesh, roads graded and recoloured it, streets did the same at a
 * finer tier; all three were invisible to the draw-call budget by construction.
 * A deck is not, and this file is where that cost is decided.
 *
 * ---------------------------------------------------------------------------
 * WHY A DECK AT ALL, WHEN THE GROUND IS ALREADY GRADED AND PAINTED
 *
 * Phase 4a's surfacing is a per-vertex colour on the terrain lattice, so the
 * width of a road is quantised to that lattice and the edge is smeared over the
 * grading taper. At lod 0 that is 2 m of quantisation on a 7-12 m road, which is
 * tolerable; at lod 3 it is 16 m and the road is a soft stain; by lod 5 it has
 * washed out entirely while still being several pixels wide on screen. A deck is
 * exact at every level, because its width comes from the road record and not
 * from whatever lattice happens to be under it.
 *
 * The second reason is the one Phase 4a wrote down and deferred: a road crossing
 * a river is currently a ford, because `grading.ts` yields inside a channel and
 * the roadbed simply stops at the bank. A deck spans it -- see BRIDGES below.
 *
 * ---------------------------------------------------------------------------
 * WHY PER-CHUNK GEOMETRY, AND NOT ONE MESH PER ROAD
 *
 * The obvious alternative is one mesh per routed road, built once and placed in
 * the scene. It is wrong here for the same three reasons a single world-sized
 * water plane was wrong in Phase 3a, plus one that is new:
 *
 *  - its extent is not a function of `(worldSeed, coord)`, so it is not covered
 *    by the streamer's residency, the LRU cache, or the soak's round-trip hash;
 *  - it cannot be clipped to what the quadtree currently covers, so it hangs
 *    over the edge of the loaded world;
 *  - it would need a main-thread build, since no single worker owns a road; and
 *  - IT CANNOT FOLLOW THE LEVEL OF DETAIL. A node's rendered ground is the
 *    linear interpolation of its own vertex lattice, which at lod 5 cuts corners
 *    by metres. A lod-independent deck sinks into a coarse node's hillside and
 *    floats over a coarse node's valley -- and roads are in valleys. The deck
 *    has to be built against the SAME grid the node renders, which means it has
 *    to be built by the node.
 *
 * So a deck is per-chunk geometry, generated in the worker, transferred with the
 * payload, and disposed with the node. Exactly like water.
 *
 * ---------------------------------------------------------------------------
 * THE DECK IS `max(blended target, this node's ground)`, AND THAT IS THE WHOLE
 * TRICK
 *
 * A station's altitude is the higher of two things: the altitude everything
 * grading that point AGREES ON (`GradeBlend.target`, via `gradeTarget` in
 * `height-field.ts`), and the ground THIS NODE renders under it. Four properties
 * follow, and all four are wanted:
 *
 *  - on ordinary terrain the grading achieved the target, so the two are equal
 *    and the deck lies flush on the ground;
 *  - at a village edge the target is the weighted average of the pad and the
 *    road, which is exactly what the ground holds, so the deck is flush there
 *    too. Using the ROAD'S OWN PROFILE instead was the first thing tried and it
 *    floated a metre or two over every village approach -- the average is not
 *    the road's profile, which is the entire point of `grading.ts`;
 *  - where grading was clamped (`ROAD_MAX_CUT` on a steep hillside) the ground
 *    stays above the target and wins, so the deck lies on the ground instead of
 *    disappearing into it;
 *  - inside a river channel the grading yielded ENTIRELY, so the ground is many
 *    metres below the target, the target wins, and the deck spans the channel.
 *    THE BRIDGE IS NOT A SEPARATE FEATURE -- it is what this rule does at a
 *    crossing, and it is the exact complement of the yield in `grading.ts`:
 *    rivers win on the ground, and the deck is what the road does instead.
 *    `RoadNetwork.segCrossing` is not consulted at all; it stays as the
 *    network's own record of where a crossing is, and `bridgeVertices` counts
 *    what the geometry actually produced, which is the stronger claim.
 *
 * ---------------------------------------------------------------------------
 * THE APRON IS THE SKIRT ARGUMENT AGAIN, AND IT IS ALSO THE BRIDGE SIDE
 *
 * Every deck edge carries an apron hanging below it, exactly as every terrain
 * node carries one. It does two jobs with one mechanism:
 *
 *  - where the deck lies on the ground it is buried and invisible, and it plugs
 *    the sliver that opens at a node boundary between two DIFFERENT levels for
 *    precisely the reason the terrain skirt exists -- the two nodes interpolate
 *    the same ground at different rates;
 *  - where the deck spans a channel it is the side of the bridge.
 *
 * It carries both windings and the material stays single-sided, for the reason
 * spelled out at `SKIRT_TRIANGLE_COUNT` in `chunk-gen.ts`: a double-sided
 * material flips the normal on back faces, and the underside of a bridge would
 * shade near-black.
 *
 * ---------------------------------------------------------------------------
 * TWO NEIGHBOURS AT THE SAME LEVEL AGREE EXACTLY, AND THAT IS ARITHMETIC
 *
 * A centreline is clipped to the node square parametrically. For the shared
 * boundary of two same-level neighbours the two clips solve the same equation
 * with opposite signs -- `(maxX - ax) / dx` against `(ax - minX) / -dx` -- and
 * IEEE-754 makes those bit-identical, so both nodes place a station at the same
 * world point. Their ground grids sample the same world positions along that
 * edge, so the station gets the same altitude from both. A unit test asserts it.
 *
 * The deck therefore has NO seam between same-level neighbours and no
 * double-drawn overlap, because the two clips partition the centreline rather
 * than sharing it.
 *
 * ---------------------------------------------------------------------------
 * WHO OWNS A SEGMENT
 *
 * Two regions both route a road near their shared boundary and both hold a
 * bit-identical copy of it (Phase 4a's whole point). Emitting from both would
 * double-draw it, so a road segment is emitted by the region containing its
 * MIDPOINT -- a total, purely positional rule, so exactly one region emits each
 * segment and no communication is needed to agree on which.
 *
 * Streets need no such rule: a sector lays out only the settlement whose centre
 * it contains, so two sectors never hold the same street.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Exact IEEE-754 only: `+ - * /` and `Math.sqrt`, no `pow`, `sin`, `cos` or
 * `exp` -- see the note at the top of `noise.ts`. Nothing here reads a clock, a
 * counter, or anything but `(worldSeed, coord)` through the records it is given.
 */

import { chunkSizeAt, REGION_SIZE, SECTOR_SIZE, type ChunkCoord } from './contracts';
import {
  ROAD_CELL,
  ROAD_HALF_WIDTH_MAX,
  type RegionRoadField,
  type RoadNetwork,
} from './roads';
import {
  STREET_MAX_EXTENT,
  type SectorStreetField,
  type SectorStreets,
} from './streets';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres the deck sits above the ground it was fitted to.
 *
 * Deliberately tiny. It is not what stops the deck z-fighting the terrain --
 * `polygonOffset` on the material is, because the two surfaces are coplanar by
 * construction and a fixed world-space lift cannot win at 4 km, where the depth
 * buffer resolves about 2 m. This exists so that the deck is unambiguously above
 * the ground in the near field, where an author is looking at it.
 */
export const DECK_LIFT = 0.05;

/**
 * Metres the apron reaches BELOW whatever it is hanging from.
 *
 * Sized to bury the apron on ordinary ground and to close the sliver that opens
 * at a boundary between two levels. It is a constant rather than the terrain
 * skirt's "three times the largest border step", because a deck is flat across
 * its width by construction, so there is no local relief for the depth to be
 * proportional to -- the quantity it has to cover is the two nodes' disagreement
 * about the ground under one 5-12 m strip, not about a whole node edge.
 */
export const DECK_APRON = 1.6;

/**
 * Metres of structure below a deck that is standing clear of the ground.
 *
 * THIS IS WHAT MAKES A BRIDGE A BRIDGE AND NOT A DAM, and the first attempt got
 * it wrong. Hanging the apron to the ground unconditionally is right where the
 * deck rests on it and catastrophic where it does not: over a 15 m channel it
 * produced a solid wall from bank to bank, standing in the water, which is
 * exactly the failure `ROAD_RIVER_YIELD` exists to prevent one layer down. The
 * river would visibly run into it.
 *
 * So the apron follows the ground only while the ground is within `DECK_BEAM` of
 * the deck; past that it stops, and what is left is a deck with a beam under it
 * and daylight below. Total visible depth over a channel is
 * `DECK_BEAM + DECK_APRON`.
 */
export const DECK_BEAM = 0.8;

/**
 * Metres of clearance above the ground at which a deck station counts as being
 * on a bridge.
 *
 * The anti-vacuity threshold for `ChunkData.bridgeVertices`, and nothing else
 * reads it. Well above the deck lift and the noise in an interpolated sample,
 * and well below the depth of any channel `ROAD_RIVER_YIELD` fully stands down
 * in -- so "a road crosses a river here" is counted and "the terrain interpolated
 * a centimetre low" is not.
 */
export const BRIDGE_CLEARANCE = 1.5;

/**
 * The only level at which bridges are counted.
 *
 * MEASURED, NOT ASSUMED, AND THE NUMBER WAS WRONG BEFORE THIS. A deck stands at
 * the blended target; the ground reaches that target only where the vertex
 * lattice has samples inside the roadbed, whose half-width is 2.6-6 m. At lod 0
 * the spacing is 2 m and several vertices sit on the bed, so ground and target
 * agree and clearance is the deck lift. At lod 3 the spacing is 16 m and usually
 * NO vertex lies on the bed, so the deck legitimately stands a metre or two
 * above ground the lattice cannot represent -- which is the deck doing its job,
 * and is not a bridge. Counting it inflated the soak's peak by roughly an order
 * of magnitude and turned the one number that says "a road crossed a river" into
 * a statement about mesh resolution.
 *
 * So the count is a lod-0 quantity, like `streetVertices` is a near-camera one.
 * The geometry is unaffected: every level spans a channel, only the statistic is
 * taken where the ground is described finely enough to mean something.
 */
export const BRIDGE_COUNT_LOD = 0;

/**
 * Hard cap on stations in one node's deck, and therefore on its vertex count.
 *
 * A SAFETY VALVE THAT SHOULD NEVER FIRE, not a level of detail. Station spacing
 * is the node's own vertex spacing, so a lod-0 node caps out around 32 stations
 * per 64 m of centreline and the busiest village node measured is well under 400.
 * It exists because the alternative is an unbounded allocation inside the
 * generator, on the one path where a pathological input would take the worker
 * down rather than merely make it slow. Truncation is deterministic -- regions,
 * then paths, then sectors, then streets, all in a fixed order -- so a node that
 * hit it would still regenerate byte-identically.
 */
export const DECK_MAX_STATIONS = 4096;

/**
 * Metres beyond the node square within which a region is consulted.
 *
 * Two things have to be inside it and the larger wins:
 *
 *  - a road segment is emitted by the region holding its MIDPOINT, so the search
 *    must reach half the longest possible segment (`ROAD_CELL` diagonal, since
 *    the router steps one lattice cell at a time) plus the widest roadbed;
 *  - a SETTLEMENT whose streets reach this node can stand `STREET_MAX_EXTENT`
 *    outside it, and its own region is the one guaranteed to list it.
 */
const REGION_SEARCH_PAD = Math.max(ROAD_CELL + ROAD_HALF_WIDTH_MAX, STREET_MAX_EXTENT);

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/**
 * One node's deck submesh. Empty arrays on a node no road or street reaches,
 * which is most of them.
 *
 * Positions are in the same node-local frame as `ChunkData.positions`: X and Z
 * are metres from the node's minimum corner, Y is absolute world altitude.
 */
export interface DeckSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /**
   * Deck stations standing more than `BRIDGE_CLEARANCE` above the ground.
   *
   * The anti-vacuity counter for bridges, and it is a measurement of the
   * geometry rather than of the road record: `RoadNetwork.segCrossing` says
   * where the router THOUGHT a crossing was, and this says where a deck
   * actually left the ground. A phase that broke the `max` rule would keep
   * `segCrossing` intact and drive this to zero.
   */
  bridgeVertices: number;
}

/** The palette entries a deck is painted with, LINEAR rgb. */
export interface DeckPalette {
  /** Region-tier roads. */
  readonly road: readonly [number, number, number];
  /** Sector-tier streets. Village lanes are not highways. */
  readonly street: readonly [number, number, number];
}

const EMPTY_DECK: () => DeckSurface = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  bridgeVertices: 0,
});

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

/**
 * The sub-interval of a segment that lies inside an axis-aligned box.
 *
 * Liang-Barsky, written out rather than borrowed, because the exact expressions
 * matter: `(maxX - ax) / dx` and `(ax - minX) / -dx` are the two forms the two
 * sides of one boundary produce, and IEEE-754 guarantees they are bit-identical
 * (negation is exact, and `x / -y === -(x / y)`). That is what makes two
 * same-level neighbours put a station at exactly the same world point instead of
 * leaving a sliver of unpainted road between them.
 *
 * Writes `[t0, t1]` into `out` and returns false when the segment misses the box
 * or only grazes it.
 */
export function clipSegmentToBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: Float64Array,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  for (let edge = 0; edge < 4; edge++) {
    let p: number;
    let q: number;
    if (edge === 0) {
      p = -dx;
      q = ax - minX;
    } else if (edge === 1) {
      p = dx;
      q = maxX - ax;
    } else if (edge === 2) {
      p = -dz;
      q = az - minZ;
    } else {
      p = dz;
      q = maxZ - az;
    }
    if (p === 0) {
      // THE BOX IS HALF-OPEN ON ITS MAXIMUM EDGES, and only this branch can
      // tell. A segment running exactly along a shared boundary is parallel to
      // it, so no interval clips it away, and both neighbours would emit the
      // same strip on top of each other. Rejecting it on the maximum edge and
      // keeping it on the minimum one gives it to exactly one of them -- the
      // same `[min, max)` convention `worldToChunk`'s floor already uses.
      const inside = edge === 0 || edge === 2 ? q >= 0 : q > 0;
      if (!inside) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  out[0] = t0;
  out[1] = t1;
  return t1 > t0;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Accumulates one node's deck.
 *
 * Plain number arrays rather than typed ones because the final size is not known
 * until every polyline has been clipped, and the arrays are converted once at the
 * end. This runs once per NODE, not once per vertex, so it is nowhere near the
 * hot path `GradeBlend` is on.
 */
class DeckBuilder {
  readonly px: number[] = [];
  readonly py: number[] = [];
  readonly pz: number[] = [];
  readonly nx: number[] = [];
  readonly ny: number[] = [];
  readonly nz: number[] = [];
  readonly cr: number[] = [];
  readonly cg: number[] = [];
  readonly cb: number[] = [];
  readonly indices: number[] = [];
  stations = 0;
  bridgeVertices = 0;
  /** See `BRIDGE_COUNT_LOD`. False on a coarse node, where the number would lie. */
  countBridges = true;

  vertex(
    x: number,
    y: number,
    z: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    color: readonly [number, number, number],
  ): number {
    const at = this.px.length;
    this.px.push(x);
    this.py.push(y);
    this.pz.push(z);
    this.nx.push(normalX);
    this.ny.push(normalY);
    this.nz.push(normalZ);
    this.cr.push(color[0]);
    this.cg.push(color[1]);
    this.cb.push(color[2]);
    return at;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Both windings of one quad. See the apron note in the header. */
  quadBothSides(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
    this.indices.push(a, c, b, a, d, c);
  }

  finish(): DeckSurface {
    const count = this.px.length;
    if (count === 0) return EMPTY_DECK();
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const at = i * 3;
      positions[at] = this.px[i] as number;
      positions[at + 1] = this.py[i] as number;
      positions[at + 2] = this.pz[i] as number;
      normals[at] = this.nx[i] as number;
      normals[at + 1] = this.ny[i] as number;
      normals[at + 2] = this.nz[i] as number;
      colors[at] = this.cr[i] as number;
      colors[at + 1] = this.cg[i] as number;
      colors[at + 2] = this.cb[i] as number;
    }
    return {
      positions,
      normals,
      colors,
      indices: Uint32Array.from(this.indices),
      bridgeVertices: this.bridgeVertices,
    };
  }
}

/**
 * One polyline's worth of centreline, in world metres, as the extruder wants it.
 *
 * A view over somebody else's arrays rather than a copy: `RoadNetwork` and
 * `SectorStreets` are both CSR, so a road or a street is a span, and copying one
 * out per node would allocate for every node a village touches.
 */
interface Centreline {
  readonly x: ArrayLike<number>;
  readonly z: ArrayLike<number>;
  /** First and last node index of this polyline, inclusive of `from`, exclusive of `to`. */
  readonly from: number;
  readonly to: number;
  readonly halfWidth: number;
  readonly color: readonly [number, number, number];
}

/** Unit horizontal direction of segment `i`, into `out`. Zero-length yields (1, 0). */
function segmentDirection(line: Centreline, i: number, out: Float64Array): void {
  const dx = (line.x[i + 1] as number) - (line.x[i] as number);
  const dz = (line.z[i + 1] as number) - (line.z[i] as number);
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= 0) {
    out[0] = 1;
    out[1] = 0;
    return;
  }
  const inverse = 1 / Math.sqrt(lengthSq);
  out[0] = dx * inverse;
  out[1] = dz * inverse;
}

/**
 * The direction the deck faces at parameter `t` of segment `i`.
 *
 * At an interior joint the two adjacent segment directions are averaged, which
 * is what stops a wedge of unpainted ground opening on the outside of every
 * corner. Everywhere else it is the segment's own direction.
 *
 * It is a pure function of the polyline and `t`, deliberately: the same joint is
 * clipped by two different nodes and both must place the vertex identically.
 */
function deckDirection(line: Centreline, i: number, t: number, out: Float64Array): void {
  segmentDirection(line, i, out);
  const blendWith = t === 0 ? i - 1 : t === 1 ? i + 1 : -1;
  if (blendWith < line.from || blendWith + 1 >= line.to) return;

  const other = new Float64Array(2);
  segmentDirection(line, blendWith, other);
  const mx = (out[0] as number) + (other[0] as number);
  const mz = (out[1] as number) + (other[1] as number);
  const lengthSq = mx * mx + mz * mz;
  // A hairpin whose two directions cancel has no meaningful miter; keep the
  // segment's own direction rather than dividing by zero.
  if (lengthSq <= 0) return;
  const inverse = 1 / Math.sqrt(lengthSq);
  out[0] = mx * inverse;
  out[1] = mz * inverse;
}

/**
 * Where the apron under one deck edge stops.
 *
 * Two clamps, in this order, and each of them fixes a specific failure:
 *
 *  - never ABOVE the deck, so the uphill edge of a bench cut into a hillside
 *    gets a buried apron rather than a wall standing on the carriageway;
 *  - never more than `DECK_BEAM` below it, so a deck spanning a channel is a
 *    bridge with daylight under it rather than a dam from bank to bank.
 *
 * Between those it follows the ground, which is the ordinary case and the one
 * that buries the apron out of sight.
 */
function apronY(deckY: number, ground: number): number {
  let base = ground < deckY ? ground : deckY;
  const floor = deckY - DECK_BEAM;
  if (base < floor) base = floor;
  return base - DECK_APRON;
}

/**
 * Extrude one clipped run of a centreline into the builder.
 *
 * `groundAt` is the node's OWN rendered ground, in node-local metres; `targetAt`
 * is the blended grading target in world metres. Every altitude here is
 * `max` of those two -- see the header. Note what is NOT read: the polyline's own
 * node altitudes. `targetAt` interpolates them through `grading.ts` along with
 * everything else influencing the point, and a second interpolation here would
 * be a second source of truth for the number that decides where a road is.
 */
function extrudeRun(
  b: DeckBuilder,
  line: Centreline,
  i: number,
  t0: number,
  t1: number,
  stationStep: number,
  originX: number,
  originZ: number,
  groundAt: (localX: number, localZ: number) => number,
  targetAt: (worldX: number, worldZ: number) => number,
): void {
  const ax = line.x[i] as number;
  const az = line.z[i] as number;
  const bx = line.x[i + 1] as number;
  const bz = line.z[i + 1] as number;
  const dx = bx - ax;
  const dz = bz - az;
  const runLength = Math.sqrt(dx * dx + dz * dz) * (t1 - t0);

  let steps = Math.ceil(runLength / stationStep);
  if (steps < 1) steps = 1;
  if (b.stations + steps + 1 > DECK_MAX_STATIONS) return;

  const half = line.halfWidth;
  const direction = new Float64Array(2);

  // Two vertices of deck and two of apron per station, laid out
  // [deckLeft, deckRight, apronLeft, apronRight] so the strips below can index
  // them by arithmetic rather than by bookkeeping.
  let previous = -1;
  for (let k = 0; k <= steps; k++) {
    const t = t0 + ((t1 - t0) * k) / steps;
    const worldX = ax + dx * t;
    const worldZ = az + dz * t;
    const localX = worldX - originX;
    const localZ = worldZ - originZ;

    deckDirection(line, i, k === 0 ? t0 : k === steps ? t1 : -1, direction);
    // `crossX = -dirZ, crossZ = dirX` is the left-to-right direction that makes
    // the triangle order below wind counter-clockwise seen from +Y.
    const crossX = -(direction[1] as number);
    const crossZ = direction[0] as number;

    const ground = groundAt(localX, localZ);
    // The blended target, NOT this polyline's own profile. They are the same
    // number on an isolated road and differ by metres wherever two graders
    // overlap -- a village, a junction -- which is where a deck built from the
    // profile alone visibly floats. See the header.
    const target = targetAt(worldX, worldZ);
    const deckY = (target > ground ? target : ground) + DECK_LIFT;
    if (b.countBridges && deckY - ground > BRIDGE_CLEARANCE) b.bridgeVertices++;

    const leftX = localX - crossX * half;
    const leftZ = localZ - crossZ * half;
    const rightX = localX + crossX * half;
    const rightZ = localZ + crossZ * half;

    // THE CROSS-SECTION IS HORIZONTAL, and that is what a roadbed is: a bench.
    // Sampling the ground separately at each edge and tilting the deck to match
    // would make a road across a hillside a ramp, and would fold the two
    // triangles of every quad against each other. The apron is what covers the
    // resulting gap on the downhill side, which is exactly an embankment.
    const apronLeft = apronY(deckY, groundAt(leftX, leftZ));
    const apronRight = apronY(deckY, groundAt(rightX, rightZ));

    // Deck normals are +Y for now and fixed up below, once the stations either
    // side of this one exist and the deck's REAL slope is known. Deriving it
    // from the road's profile instead would be wrong wherever the deck follows
    // the ground rather than the target, which is most of its length.
    const deckLeft = b.vertex(leftX, deckY, leftZ, 0, 1, 0, line.color);
    b.vertex(rightX, deckY, rightZ, 0, 1, 0, line.color);
    // Apron vertices carry the OUTWARD horizontal normal, unlike the terrain
    // skirt which copies the surface's. The terrain apron is only ever glimpsed
    // edge-on through a crack and wants to read as the ground continuing; this
    // one is the side of a bridge and wants to read as a wall.
    b.vertex(leftX, apronLeft, leftZ, -crossX, 0, -crossZ, line.color);
    b.vertex(rightX, apronRight, rightZ, crossX, 0, crossZ, line.color);
    b.stations++;

    if (previous >= 0) {
      const l0 = previous;
      const r0 = previous + 1;
      const la0 = previous + 2;
      const ra0 = previous + 3;
      const l1 = deckLeft;
      const r1 = deckLeft + 1;
      const la1 = deckLeft + 2;
      const ra1 = deckLeft + 3;
      // The carriageway.
      b.triangle(l0, r0, l1);
      b.triangle(r0, r1, l1);
      // ...and its two flanks, both windings.
      b.quadBothSides(l0, l1, la1, la0);
      b.quadBothSides(r0, r1, ra1, ra0);
    }
    previous = deckLeft;
  }

  const firstStation = b.px.length - (steps + 1) * 4;
  const lastStation = b.px.length - 4;

  // -- deck normals, from the deck itself ------------------------------------
  //
  // The along direction is the line between the neighbouring stations' CENTRES
  // and the across direction is recovered from the two deck vertices, so this
  // reads only geometry that was actually emitted. `across x along` points up
  // for the winding chosen above.
  for (let k = 0; k <= steps; k++) {
    const here = firstStation + k * 4;
    const before = firstStation + (k > 0 ? k - 1 : k) * 4;
    const after = firstStation + (k < steps ? k + 1 : k) * 4;
    const centreX = (at: number): number =>
      ((b.px[at] as number) + (b.px[at + 1] as number)) / 2;
    const centreZ = (at: number): number =>
      ((b.pz[at] as number) + (b.pz[at + 1] as number)) / 2;
    const runX = centreX(after) - centreX(before);
    const runZ = centreZ(after) - centreZ(before);
    const run = Math.sqrt(runX * runX + runZ * runZ);
    if (run <= 0) continue;
    const slope = ((b.py[after] as number) - (b.py[before] as number)) / run;
    const acrossX = (b.px[here + 1] as number) - (b.px[here] as number);
    const acrossZ = (b.pz[here + 1] as number) - (b.pz[here] as number);
    const acrossLength = Math.sqrt(acrossX * acrossX + acrossZ * acrossZ);
    if (acrossLength <= 0) continue;
    const crossX = acrossX / acrossLength;
    const crossZ = acrossZ / acrossLength;
    const normalX = -crossZ * slope;
    const normalZ = crossX * slope;
    const inverse = 1 / Math.sqrt(normalX * normalX + 1 + normalZ * normalZ);
    for (const vertex of [here, here + 1]) {
      b.nx[vertex] = normalX * inverse;
      b.ny[vertex] = inverse;
      b.nz[vertex] = normalZ * inverse;
    }
  }

  // End caps, so a deck cut at a node boundary or ending on a bridge abutment is
  // closed rather than showing the inside of its own flanks.
  b.quadBothSides(firstStation, firstStation + 1, firstStation + 3, firstStation + 2);
  b.quadBothSides(lastStation, lastStation + 1, lastStation + 3, lastStation + 2);
}

/** Clip one polyline to the node square and extrude whatever survives. */
function addCentreline(
  b: DeckBuilder,
  line: Centreline,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  stationStep: number,
  groundAt: (localX: number, localZ: number) => number,
  targetAt: (worldX: number, worldZ: number) => number,
  owns: (index: number) => boolean,
): void {
  const clip = new Float64Array(2);
  for (let i = line.from; i + 1 < line.to; i++) {
    if (!owns(i)) continue;
    const ax = line.x[i] as number;
    const az = line.z[i] as number;
    const bx = line.x[i + 1] as number;
    const bz = line.z[i + 1] as number;
    if (!clipSegmentToBox(ax, az, bx, bz, minX, minZ, maxX, maxZ, clip)) continue;
    // The box's minimum corner IS the node origin, which is what `extrudeRun`
    // subtracts to write node-local positions.
    extrudeRun(
      b,
      line,
      i,
      clip[0] as number,
      clip[1] as number,
      stationStep,
      minX,
      minZ,
      groundAt,
      targetAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Gathering the centrelines
// ---------------------------------------------------------------------------

/** Add every road segment this region owns to the deck. */
function addRegionRoads(
  b: DeckBuilder,
  net: RoadNetwork,
  regionX: number,
  regionZ: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  stationStep: number,
  groundAt: (localX: number, localZ: number) => number,
  targetAt: (worldX: number, worldZ: number) => number,
  palette: DeckPalette,
): void {
  const paths = net.pathStart.length - 1;
  for (let p = 0; p < paths; p++) {
    const from = net.pathStart[p] as number;
    const to = net.pathStart[p + 1] as number;
    if (to - from < 2) continue;
    const line: Centreline = {
      x: net.nodeX,
      z: net.nodeZ,
      from,
      to,
      halfWidth: net.nodeHalfWidth[from] as number,
      color: palette.road,
    };
    addCentreline(b, line, minX, minZ, maxX, maxZ, stationStep, groundAt, targetAt, (i) => {
      // ONE region emits each segment: the one containing its midpoint. Both
      // regions either side of a boundary hold a bit-identical copy of the road,
      // so without this the overlap would be drawn twice.
      const midX = ((net.nodeX[i] as number) + (net.nodeX[i + 1] as number)) / 2;
      const midZ = ((net.nodeZ[i] as number) + (net.nodeZ[i + 1] as number)) / 2;
      return (
        Math.floor(midX / REGION_SIZE) === regionX && Math.floor(midZ / REGION_SIZE) === regionZ
      );
    });
  }
}

/** Add every street of one sector's plan to the deck. */
function addSectorStreets(
  b: DeckBuilder,
  rec: SectorStreets,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  stationStep: number,
  groundAt: (localX: number, localZ: number) => number,
  targetAt: (worldX: number, worldZ: number) => number,
  palette: DeckPalette,
): void {
  if (rec.settlement === undefined) return;
  for (let s = 0; s < rec.streetCount; s++) {
    const from = rec.streetStart[s] as number;
    const to = rec.streetStart[s + 1] as number;
    if (to - from < 2) continue;
    const line: Centreline = {
      x: rec.nodeX,
      z: rec.nodeZ,
      from,
      to,
      halfWidth: rec.halfWidth,
      color: palette.street,
    };
    // No ownership test: a sector lays out only the settlement whose centre it
    // contains, so two sectors never hold the same street. See `streets.ts`.
    addCentreline(b, line, minX, minZ, maxX, maxZ, stationStep, groundAt, targetAt, () => true);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build one node's road and street deck.
 *
 * `groundAt` must be THIS NODE's rendered ground in node-local metres -- an
 * interpolation of the very vertex grid the node uploads -- because the deck's
 * whole job is to sit on the surface that is actually drawn. Handing it
 * `sampleHeight` instead would be subtly wrong at every level above 0, which is
 * where the deck matters most.
 *
 * `targetAt` must be `gradeTarget` from `height-field.ts` in world metres: the
 * SAME blend the ground was graded toward, so that "flush wherever the grading
 * succeeded" and "spanning wherever it stood down" are the same rule rather than
 * two that happen to agree.
 */
export function buildDeckSurface(
  coord: ChunkCoord,
  roads: RegionRoadField,
  sectors: SectorStreetField,
  groundAt: (localX: number, localZ: number) => number,
  targetAt: (worldX: number, worldZ: number) => number,
  palette: DeckPalette,
): DeckSurface {
  const size = chunkSizeAt(coord.lod);
  const minX = coord.x * size;
  const minZ = coord.z * size;
  const maxX = minX + size;
  const maxZ = minZ + size;
  // Stations are the node's own vertex spacing, so a deck follows the ground at
  // exactly the fidelity the ground is drawn at -- 2 m at lod 0, 128 m at lod 6.
  // Anything finer would be geometry describing detail the terrain under it does
  // not have.
  const stationStep = size / 32;

  const b = new DeckBuilder();
  b.countBridges = coord.lod === BRIDGE_COUNT_LOD;

  // -- Region-tier roads ----------------------------------------------------
  //
  // Every region whose square could hold the midpoint of a segment reaching this
  // node, or the centre of a settlement whose streets do. At lod 0 that is one
  // region, or up to four near a corner; at the root level, where a node is a
  // whole region, it is up to nine -- which is what the per-vertex grading
  // already touches through its padded sample grid, so it costs no region build
  // the node was not paying for anyway.
  const r0X = Math.floor((minX - REGION_SEARCH_PAD) / REGION_SIZE);
  const r1X = Math.floor((maxX + REGION_SEARCH_PAD) / REGION_SIZE);
  const r0Z = Math.floor((minZ - REGION_SEARCH_PAD) / REGION_SIZE);
  const r1Z = Math.floor((maxZ + REGION_SEARCH_PAD) / REGION_SIZE);

  // -- Sector-tier streets, found through the settlements ---------------------
  //
  // THE SECTOR GRID IS NOT SWEPT, AND THAT IS A MEASURED DECISION RATHER THAN A
  // TIDY ONE. Sweeping every sector whose square inflated by `STREET_REACH`
  // meets the node is the obvious way to write this and is what
  // `sectorStreetField.accumulate` does per vertex -- but a vertex touches one
  // sector and a NODE touches its whole square, which at the root level is a
  // 10x10 block against a 64-entry memo. Every node then evicted every street
  // plan the next node wanted. Measured on one canonical screenshot: 96 seconds
  // to become ready, against a 120 second harness timeout, and 16 seconds with
  // the memo temporarily enlarged.
  //
  // A street plan exists only where a SETTLEMENT CENTRE is, and the region
  // records already list every settlement that can reach this node -- so the
  // sectors worth visiting can be enumerated exactly instead of searched for.
  // A node normally visits none, and a node over a village visits one.
  const visited = new Set<string>();
  for (let rz = r0Z; rz <= r1Z; rz++) {
    for (let rx = r0X; rx <= r1X; rx++) {
      const net = roads.networkAt(
        rx * REGION_SIZE + REGION_SIZE / 2,
        rz * REGION_SIZE + REGION_SIZE / 2,
      );
      addRegionRoads(
        b,
        net,
        rx,
        rz,
        minX,
        minZ,
        maxX,
        maxZ,
        stationStep,
        groundAt,
        targetAt,
        palette,
      );

      for (let i = 0; i < net.settlements.length; i++) {
        const s = net.settlements[i] as (typeof net.settlements)[number];
        if (s.x + STREET_MAX_EXTENT < minX || s.x - STREET_MAX_EXTENT > maxX) continue;
        if (s.z + STREET_MAX_EXTENT < minZ || s.z - STREET_MAX_EXTENT > maxZ) continue;
        // Two regions can both list one settlement, and its own sector is
        // unique, so the sector coordinate is the identity to deduplicate on.
        const sx = Math.floor(s.x / SECTOR_SIZE);
        const sz = Math.floor(s.z / SECTOR_SIZE);
        const key = `${sx},${sz}`;
        if (visited.has(key)) continue;
        visited.add(key);
        addSectorStreets(
          b,
          sectors.streetsAt(sx, sz),
          minX,
          minZ,
          maxX,
          maxZ,
          stationStep,
          groundAt,
          targetAt,
          palette,
        );
      }
    }
  }

  return b.finish();
}
