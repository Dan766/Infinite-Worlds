/**
 * Buildings, as geometry: one batched submesh per node.
 *
 * Phase 6, and the second thing after Phase 5's deck that costs a draw call of
 * its own. It follows the deck in every structural respect -- per-chunk, built
 * in the worker, zero-length arrays where there is nothing, disposed with the
 * node -- and differs from it in exactly two, both deliberate.
 *
 * ---------------------------------------------------------------------------
 * ONE MESH PER NODE, NOT ONE PER BUILDING, AND THAT IS NOT AN OPTIMISATION TO
 * DEFER
 *
 * A road is sparse: the busiest node carries one deck. Buildings are dense --
 * a village node at lod 0 holds a handful and a village node at the root level
 * holds the whole settlement -- so one mesh per building would put fifty draw
 * calls on a node that currently costs three, on top of a budget already at 357
 * of 680. Every building in a node goes into ONE buffer with per-vertex colour,
 * which is what keeps this phase's cost to +1 draw call per node that has any.
 *
 * The cost of batching is that a building cannot be culled, moved or replaced
 * individually. Nothing wants to: a building is fixed content of the world at
 * `(worldSeed, sector)`, exactly like the ground under it.
 *
 * ---------------------------------------------------------------------------
 * A BUILDING IS NOT CLIPPED. IT IS OWNED BY THE NODE HOLDING ITS CENTRE
 *
 * The deck is a ribbon hundreds of metres long, so it is clipped parametrically
 * to the node square and the two sides of a boundary agree by IEEE arithmetic. A
 * building is eight metres across, and clipping one would mean solving the
 * intersection of a box with a node square and closing the cut -- for the sole
 * benefit of a building that straddles a boundary. Instead the node containing
 * the CENTRE emits the whole thing and lets it overhang, which is the same
 * purely positional ownership rule a road segment already uses for its midpoint:
 * total, so exactly one node emits each building, and needing no communication
 * to agree on which.
 *
 * The consequence is that a node's geometry can reach up to one bounding radius
 * outside its square, so the submesh's bounds are computed from the vertices
 * actually emitted rather than from the node box -- as the deck's and the
 * water's already are, and for the sharper reason here that frustum culling
 * would otherwise clip a building in half at the screen edge.
 *
 * ---------------------------------------------------------------------------
 * THE FLOOR IS LOD-INDEPENDENT AND THE PLINTH IS NOT
 *
 * `SectorLots.floorY` is the ground `sampleHeight` reports at the centre, fixed
 * at the Sector tier, so a building does not move when the quadtree changes
 * level under it. What each node decides for itself is how far the PLINTH
 * reaches down: to the lowest ground THIS node renders under the footprint,
 * plus a little, capped at `BUILDING_MAX_PLINTH`.
 *
 * That split is what the deck's `max(target, ground)` rule is for a ribbon: it
 * keeps the visible surface where the world says it is, and lets the buried part
 * absorb the difference between one lattice and another. A coarse node's ground
 * can sit a metre below the fine ground the floor was fixed to, and the plinth
 * covers it instead of daylight appearing under the walls. The cap is the
 * `DECK_BEAM` argument again: without it, a building sited at the top of a bank
 * grows a twenty-metre skirt down the slope.
 *
 * ---------------------------------------------------------------------------
 * WINDING IS CHECKED, NOT REASONED ABOUT
 *
 * Every face is emitted through `face()`, which is given the corners and an
 * OUTWARD HINT and reverses the winding if the two disagree. Getting the sign of
 * a cross product wrong in a house with ten faces is a five-minute bug that
 * looks like a lighting problem, and single-sided materials make it invisible
 * from one side and black from the other. A unit test asserts that every
 * triangle's geometric normal points away from the building's centre.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Exact IEEE-754 only: `+ - * /` and `Math.sqrt`. Nothing here reads a clock or
 * anything but the records it is given.
 */

import { chunkSizeAt, REGION_SIZE, SECTOR_SIZE, type ChunkCoord } from './contracts';
import {
  KIND_BARN,
  KIND_HALL,
  KIND_TOWNHOUSE,
  KIND_GUILDHALL,
  KIND_WAREHOUSE,
  KIND_KEEP,
  KIND_CATHEDRAL,
  KIND_TOWNHALL,
  KIND_GATEHOUSE,
  LOT_MAX_EXTENT,
  type SectorLotField,
  type SectorLots,
} from './lots';
import { cityInfluenceRadius, isCity } from './city';
import { type RegionRoadField } from './roads';
import { hash2i } from '../core/hash';
import { CULTURES, ROOF_FLAT_PARAPET, ROOF_GABLE, ROOF_HIP, ROOF_PYRAMID, ROOF_SHED, type Culture } from './culture';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres the plinth reaches below the lowest ground under a footprint.
 *
 * Small: its whole job is to make sure the walls meet the ground rather than
 * stopping a few centimetres above it on an interpolated triangle. Everything
 * larger than this is buried and invisible.
 */
export const BUILDING_FOOTING = 0.35;

/**
 * Metres of plinth below the floor, at most.
 *
 * `DECK_BEAM`'s argument in a different shape. A building near a bank or a
 * clamped cut can have ground several metres below its floor at one corner; the
 * plinth follows it down and reads as a stone base, which is what a house on a
 * slope has. Unbounded, the same mechanism hangs a curtain down a hillside from
 * a building at the top of it. Lots are refused where the ground varies by more
 * than `LOT_SPREAD_MAX` (2.5 m) across the footprint, so on a fine node this cap
 * is never the binding constraint -- it exists for the COARSE node, whose
 * lattice can put the ground anywhere within its own interpolation error.
 */
export const BUILDING_MAX_PLINTH = 4;

/**
 * Metres of disagreement between a node's rendered ground and a building's floor
 * at which the building stops counting as level.
 *
 * The anti-vacuity threshold for `BuildingSurface.level`, and nothing else reads
 * it. See `BUILDING_LEVEL_LOD`.
 */
export const BUILDING_LEVEL_TOLERANCE = 0.75;

/**
 * The only level at which levelness is counted.
 *
 * `BRIDGE_COUNT_LOD`'s argument, and the same measurement behind it. A
 * building's floor is fixed to `sampleHeight`; a node's rendered ground is the
 * interpolation of ITS lattice, which at lod 0 is 2 m and describes a village
 * pad exactly, and at lod 3 is 16 m and cannot describe an 8 m footprint at all.
 * Counting a coarse node would produce a number about mesh resolution rather
 * than about whether a village levelled its ground -- which is the claim this
 * counter exists to make.
 */
export const BUILDING_LEVEL_LOD = 0;

/**
 * The lowest LOD (inclusive) at which an ordinary building draws its
 * simplified silhouette -- four walls and a flat cap, no roof-type variety,
 * no facade detail -- instead of full massing.
 *
 * Phase Politics B4. `lod 0` is the only tier close enough to the camera for
 * a roof's shape or a door panel to read as anything but a handful of
 * pixels, and it is the SAME tier `BUILDING_LEVEL_LOD` already treats as
 * "close enough to measure" -- reusing it here rather than inventing a
 * second distance judgement. A coarse node (lod >= 1) can hold dozens of
 * buildings at once (a whole village, or a city's rim sectors), which is
 * exactly where B1's per-building roof cap and facade panels cost the most
 * vertices for the least visible return. Landmarks are NOT simplified at any
 * LOD -- see `addBuilding`'s landmark branch -- there are far fewer of them
 * per city, and a keep that loses its towers at distance would misread as a
 * different, smaller kind of building.
 */
export const BUILDING_LOD_SIMPLIFY = 1;

/**
 * Hard cap on buildings in one node's submesh.
 *
 * A SAFETY VALVE THAT SHOULD NEVER FIRE, like `DECK_MAX_STATIONS`. The largest
 * possible load is one root-level node over the largest settlement, which is
 * `LOT_MAX_BUILDINGS` (256) for that sector plus its neighbours; 1,024 covers
 * several at once. Truncation is deterministic -- regions, then settlements,
 * then the lot order inside each sector -- so a node that hit it would still
 * regenerate byte-identically.
 */
export const BUILDING_MAX_PER_NODE = 1024;

/**
 * Metres beyond the node square within which a region is consulted for
 * settlements.
 *
 * A settlement whose buildings reach this node can stand `LOT_MAX_EXTENT`
 * outside it, and its own region is the one guaranteed to list it. This is the
 * same lookup `road-mesh.ts` performs for streets, one number larger, and it is
 * why buildings cost no extra region build: the regions are already resident.
 */
/**
 * Cities span multiple sectors (wall radius ~400-600 m + farm belt). Building
 * lookup must reach the settlement centre from a rim chunk, and must load lots
 * from EVERY overlapping sector — not only the centre cell.
 */
const CITY_BUILDING_SEARCH_PAD = 1200;

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/**
 * One node's building submesh. Empty arrays on a node with no building centre
 * in it, which is all but a handful in the world.
 *
 * Positions are in the same node-local frame as `ChunkData.positions`: X and Z
 * are metres from the node's minimum corner, Y is absolute world altitude.
 */
export interface BuildingSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /**
   * CSR vertex-offset boundaries, one entry per building plus a final total
   * (length `count + 1`) -- building `b` owns vertices
   * `[buildingStart[b], buildingStart[b + 1])`. Phase Politics B1 made this
   * load-bearing: every kind used to cost the SAME fixed
   * `BUILDING_VERTEX_COUNT`/`BUILDING_TRIANGLE_COUNT` (now deleted), so a
   * uniform stride was enough to find one building's vertices in the shared
   * buffer. Roof-type variety means two buildings of the same kind can now
   * cost different vertex counts, so consumers that need per-building
   * extents (the winding test; a future per-building LOD or pick ray) read
   * this instead of assuming a stride.
   */
  buildingStart: Uint32Array;
  /**
   * Buildings this node owns. NOT derivable from the vertex or triangle
   * count now that roof type varies per building -- see `buildingStart`.
   */
  count: number;
  /**
   * Of those, how many stand on ground this node renders within
   * `BUILDING_LEVEL_TOLERANCE` of their own floor. Counted at lod 0 only.
   *
   * THE ANTI-VACUITY COUNTER OF THE PHASE, and it is a measurement of the
   * geometry rather than of the lot record. `count` says buildings were placed;
   * this says they were placed on ground a village actually levelled. A
   * regression in the grading, in `gradeTarget`, or in the lot acceptance tests
   * leaves `count` untouched and drives this to zero, and no other check in the
   * project would notice.
   */
  level: number;
  /** Kind breakdown of `count` -- soak anti-vacuity per kind. */
  cottage: number;
  barn: number;
  hall: number;
  townhouse: number;
  guildhall: number;
  warehouse: number;
  keep: number;
  cathedral: number;
  townhall: number;
  gatehouse: number;
  /**
   * Of the ordinary (non-landmark) buildings in `count`, how many drew the
   * `BUILDING_LOD_SIMPLIFY` silhouette instead of full massing. Phase
   * Politics B4's own anti-vacuity counter: without it, "the LOD branch
   * exists" and "the LOD branch never actually fires" look identical to
   * every other check in this file.
   */
  simplified: number;
}

/** The palette a building is painted with, LINEAR rgb. */
export interface BuildingPalette {
  /** Wall colour range: `wallTint` picks between them. */
  readonly wallA: readonly [number, number, number];
  readonly wallB: readonly [number, number, number];
  /** Roof colour range: `roofTint` picks between them. */
  readonly roofA: readonly [number, number, number];
  readonly roofB: readonly [number, number, number];
  /** The buried base. Darker than any wall, so a plinth on a slope reads as stone. */
  readonly plinth: readonly [number, number, number];
}

const EMPTY_BUILDINGS: () => BuildingSurface = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  buildingStart: new Uint32Array(0),
  count: 0,
  level: 0,
  cottage: 0,
  barn: 0,
  hall: 0,
  townhouse: 0,
  guildhall: 0,
  warehouse: 0,
  keep: 0,
  cathedral: 0,
  townhall: 0,
  gatehouse: 0,
  simplified: 0,
});

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Accumulates one node's buildings.
 *
 * Plain number arrays, converted once at the end, for the reason `DeckBuilder`
 * gives: the final size is not known until every settlement in reach has been
 * walked, and this runs once per NODE rather than once per vertex.
 */
class BuildingBuilder {
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
  /** CSR vertex-start boundaries -- see `BuildingSurface.buildingStart`. */
  readonly buildingStart: number[] = [];
  count = 0;
  level = 0;
  cottage = 0;
  barn = 0;
  hall = 0;
  townhouse = 0;
  guildhall = 0;
  warehouse = 0;
  keep = 0;
  cathedral = 0;
  townhall = 0;
  gatehouse = 0;
  simplified = 0;
  /** See `BUILDING_LEVEL_LOD`. False on a coarse node, where the number would lie. */
  countLevel = true;

  /** Mark the start of one new building's vertices. Call BEFORE emitting any of its geometry. */
  startBuilding(): void {
    this.buildingStart.push(this.px.length);
  }

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

  finish(): BuildingSurface {
    const vertexCount = this.px.length;
    if (vertexCount === 0) return EMPTY_BUILDINGS();
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
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
      buildingStart: Uint32Array.from([...this.buildingStart, vertexCount]),
      count: this.count,
      level: this.level,
      cottage: this.cottage,
      barn: this.barn,
      hall: this.hall,
      townhouse: this.townhouse,
      guildhall: this.guildhall,
      warehouse: this.warehouse,
      keep: this.keep,
      cathedral: this.cathedral,
      townhall: this.townhall,
      gatehouse: this.gatehouse,
      simplified: this.simplified,
    };
  }
}

/** A corner, in the node-local frame the payload uses. */
interface Corner {
  x: number;
  y: number;
  z: number;
}

type Rgb = readonly [number, number, number];

/**
 * Emit one planar face as a triangle fan over `corners`, facing `hint`, with one
 * colour per corner.
 *
 * The winding is DERIVED, not assumed: the face normal comes from the first
 * three corners, and if it disagrees with the outward hint both the normal and
 * the vertex order are reversed. See the header -- a house has ten faces at
 * arbitrary bearings, and hand-deriving ten cross-product signs is how one of
 * them ends up inside out and unlit.
 *
 * Colours are per corner rather than per face for exactly one reason: an exposed
 * plinth shades from stone into the wall over the height of the exposure instead
 * of at a hard line, and where nothing is exposed the two colours are equal and
 * the gradient disappears. Giving the plinth its own band of geometry would cost
 * a third of the building's triangles to describe something usually underground.
 *
 * A degenerate face (three collinear corners) is skipped rather than emitted
 * with a zero normal, which would shade as a black hole.
 */
function face(
  b: BuildingBuilder,
  corners: readonly Corner[],
  colors: readonly Rgb[],
  hintX: number,
  hintY: number,
  hintZ: number,
): void {
  const a = corners[0] as Corner;
  const c1 = corners[1] as Corner;
  const c2 = corners[2] as Corner;
  const ux = c1.x - a.x;
  const uy = c1.y - a.y;
  const uz = c1.z - a.z;
  const vx = c2.x - a.x;
  const vy = c2.y - a.y;
  const vz = c2.z - a.z;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length <= 0) return;
  nx /= length;
  ny /= length;
  nz /= length;

  const flip = nx * hintX + ny * hintY + nz * hintZ < 0;
  if (flip) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const first = b.px.length;
  const total = corners.length;
  for (let i = 0; i < total; i++) {
    // Reversing the order is what actually flips the winding; the normal above
    // is only what the shader reads. The colours are reversed with it, or a
    // flipped wall would take its plinth shade at the roofline.
    const pick = flip ? total - 1 - i : i;
    const corner = corners[pick] as Corner;
    b.vertex(corner.x, corner.y, corner.z, nx, ny, nz, colors[pick] as Rgb);
  }
  for (let i = 2; i < total; i++) {
    b.indices.push(first, first + i - 1, first + i);
  }
}

/** Emit one flat-roofed box aligned to a lot's frontage and depth axes. */
function addOrientedBox(
  b: BuildingBuilder,
  centerX: number,
  centerZ: number,
  alongX: number,
  alongZ: number,
  acrossX: number,
  acrossZ: number,
  offsetAlong: number,
  offsetAcross: number,
  halfAlong: number,
  halfAcross: number,
  bottom: number,
  top: number,
  wall: Rgb,
  roof: Rgb,
): void {
  const at = (u: number, v: number, y: number): Corner => ({
    x: centerX + alongX * (offsetAlong + halfAlong * u) + acrossX * (offsetAcross + halfAcross * v),
    y,
    z: centerZ + alongZ * (offsetAlong + halfAlong * u) + acrossZ * (offsetAcross + halfAcross * v),
  });
  const wallColors: readonly Rgb[] = [wall, wall, wall, wall];
  face(b, [at(-1, -1, bottom), at(1, -1, bottom), at(1, -1, top), at(-1, -1, top)], wallColors, -acrossX, 0, -acrossZ);
  face(b, [at(1, 1, bottom), at(-1, 1, bottom), at(-1, 1, top), at(1, 1, top)], wallColors, acrossX, 0, acrossZ);
  face(b, [at(-1, 1, bottom), at(-1, -1, bottom), at(-1, -1, top), at(-1, 1, top)], wallColors, -alongX, 0, -alongZ);
  face(b, [at(1, -1, bottom), at(1, 1, bottom), at(1, 1, top), at(1, -1, top)], wallColors, alongX, 0, alongZ);
  face(b, [at(-1, -1, top), at(1, -1, top), at(1, 1, top), at(-1, 1, top)], [roof, roof, roof, roof], 0, 1, 0);
}

/** One oriented box in a landmark recipe, in the same units `addOrientedBox` takes. */
interface LandmarkBox {
  offsetAlong: number;
  offsetAcross: number;
  halfAlong: number;
  halfAcross: number;
  bottom: number;
  top: number;
  side: Rgb;
  cap: Rgb;
}

/** What a landmark recipe function is given to compute its box list from. */
interface LandmarkContext {
  halfWidth: number;
  halfDepth: number;
  base: number;
  floor: number;
  eaves: number;
  wall: Rgb;
  roof: Rgb;
  plinth: Rgb;
}

/**
 * One box list per landmark `KIND_*`, keyed by kind and produced from a
 * `LandmarkContext` rather than written as a chain of `box(...)` calls
 * in-line. Phase Politics B2: this is the data the old 160-line
 * `if (kind === KIND_KEEP) { ... } if (kind === KIND_CATHEDRAL) { ... }`
 * chain computed imperatively; every literal below is unchanged from it, so
 * this refactor is byte-identical geometry (verified: every C5 landmark test
 * and every committed landmark screenshot passed with zero changes).
 *
 * Per-culture variant recipes are NOT implemented yet -- `cultureId` does not
 * reach `SectorLots` until Phase B3, and threading a fake seed through here
 * ahead of that plumbing would mean redoing this table twice. See
 * PROGRESS.md.
 */
const LANDMARK_RECIPES: Record<number, (ctx: LandmarkContext) => LandmarkBox[]> = {
  [KIND_KEEP]: (ctx) => {
    // C5 keep: bailey, gate/approach, central keep, four corner towers (≥2 visible).
    // Towers ≥20% taller than bailey roof (28 vs 6 m above floor). Stone tints
    // separate volumes in shaded proofs. Gate projects toward +Z (approach from SE).
    const { halfWidth: hw, halfDepth: hd, base, floor, plinth } = ctx;
    const stone: Rgb = [0.7, 0.66, 0.58];
    const stoneDark: Rgb = [0.45, 0.42, 0.36];
    const baileyTop = floor + 6;
    const keepLowerTop = floor + 14;
    const keepUpperTop = floor + 19;
    const towerTop = floor + 28;
    const gateTop = floor + 12;
    const boxes: LandmarkBox[] = [
      // 1 Bailey platform — full 44×44 m footprint.
      { offsetAlong: 0, offsetAcross: 0, halfAlong: hw, halfAcross: hd, bottom: base, top: baileyTop, side: plinth, cap: stone },
      // 2 Gate / approach barbican — projects toward +Z (negative across).
      { offsetAlong: 0, offsetAcross: -hd * 1.15, halfAlong: hw * 0.36, halfAcross: hd * 0.2, bottom: base, top: gateTop, side: stone, cap: stoneDark },
      { offsetAlong: 0, offsetAcross: -hd * 1.02, halfAlong: hw * 0.14, halfAcross: hd * 0.1, bottom: floor, top: gateTop - 2, side: stoneDark, cap: stone },
      // 3 Central keep — offset toward gate so the mass reads from approach.
      { offsetAlong: 0, offsetAcross: -hd * 0.12, halfAlong: hw * 0.42, halfAcross: hd * 0.42, bottom: floor, top: keepLowerTop, side: stone, cap: stoneDark },
      { offsetAlong: 0, offsetAcross: -hd * 0.12, halfAlong: hw * 0.28, halfAcross: hd * 0.28, bottom: keepLowerTop - 0.5, top: keepUpperTop, side: stoneDark, cap: ctx.roof },
    ];
    // 4 Four corner towers with crown caps (≥2 required; four for top-down readability).
    for (const u of [-1, 1]) {
      for (const v of [-1, 1]) {
        boxes.push({ offsetAlong: u * hw * 0.76, offsetAcross: v * hd * -0.76, halfAlong: hw * 0.18, halfAcross: hd * 0.18, bottom: base, top: towerTop, side: stoneDark, cap: stone });
        boxes.push({ offsetAlong: u * hw * 0.76, offsetAcross: v * hd * -0.76, halfAlong: hw * 0.12, halfAcross: hd * 0.12, bottom: towerTop - 0.5, top: towerTop + 3, side: stone, cap: stoneDark });
      }
    }
    return boxes;
  },

  [KIND_CATHEDRAL]: (ctx) => {
    // C5 cathedral: cruciform plan — nave, transept/crossing, west front tower.
    // Transept halfAcross 13 m vs nave 5 m → 260% width ratio (≥125%). Stone
    // tints separate volumes in shaded proofs. Approach from +Z (city core).
    const { halfWidth: hw, halfDepth: hd, base, floor, roof } = ctx;
    const stone: Rgb = [0.62, 0.6, 0.54];
    const stoneDark: Rgb = [0.44, 0.42, 0.38];
    const stoneLight: Rgb = [0.72, 0.7, 0.64];
    const naveTop = floor + 16;
    const clerestoryTop = floor + 25;
    const transeptTop = floor + 18;
    const towerTop = floor + 34;
    return [
      // 1 Nave — long narrow volume along +X.
      { offsetAlong: 4, offsetAcross: 0, halfAlong: hw * 0.62, halfAcross: 5, bottom: base, top: naveTop, side: stone, cap: stoneDark },
      // 2 Transept / crossing — wider across, shorter along (cruciform top view).
      { offsetAlong: 0, offsetAcross: 0, halfAlong: hw * 0.32, halfAcross: hd * 0.46, bottom: floor, top: transeptTop, side: stoneDark, cap: stone },
      // 3 Nave clerestory — raised centre ridge over the nave.
      { offsetAlong: 4, offsetAcross: 0, halfAlong: hw * 0.5, halfAcross: 3.5, bottom: naveTop - 0.5, top: clerestoryTop, side: stoneLight, cap: roof },
      // 4 West front tower — tall block at the −X (west) end.
      { offsetAlong: -hw * 0.68, offsetAcross: 0, halfAlong: hw * 0.38, halfAcross: hd * 0.28, bottom: base, top: towerTop, side: stoneDark, cap: stoneLight },
      { offsetAlong: -hw * 0.68, offsetAcross: 0, halfAlong: hw * 0.26, halfAcross: hd * 0.18, bottom: towerTop - 0.5, top: towerTop + 4, side: stoneLight, cap: stoneDark },
    ];
  },

  [KIND_TOWNHALL]: (ctx) => {
    // C5 town hall: full plinth on all four sides, main hall + clock tower
    // (≥2 roof levels). Frontage = 2×halfWidth along +X (≥18 m absolute).
    const { halfWidth: hw, halfDepth: hd, base, floor, roof, plinth } = ctx;
    const stone: Rgb = [0.58, 0.54, 0.48];
    const stoneDark: Rgb = [0.4, 0.38, 0.34];
    const hallTop = floor + 8;
    const towerTop = floor + 18;
    return [
      // 1 Plinth podium — full footprint, visible on every side.
      { offsetAlong: 0, offsetAcross: 0, halfAlong: hw, halfAcross: hd, bottom: base, top: floor + 3, side: plinth, cap: stone },
      // 2 Main hall block — inset above plinth.
      { offsetAlong: 0, offsetAcross: 0, halfAlong: hw * 0.88, halfAcross: hd * 0.82, bottom: floor + 2.8, top: hallTop, side: stone, cap: stoneDark },
      // 3 Clock tower — projects toward +Z (approach from city core).
      { offsetAlong: 0, offsetAcross: -hd * 0.28, halfAlong: hw * 0.38, halfAcross: hd * 0.42, bottom: floor + 2.8, top: towerTop, side: stoneDark, cap: roof },
      { offsetAlong: 0, offsetAcross: -hd * 0.28, halfAlong: hw * 0.24, halfAcross: hd * 0.28, bottom: towerTop - 0.5, top: towerTop + 3, side: stone, cap: stoneDark },
      // 4 Side annex wings — lower flanking masses (second silhouette tier).
      { offsetAlong: -hw * 0.62, offsetAcross: 0, halfAlong: hw * 0.32, halfAcross: hd * 0.72, bottom: floor + 2.8, top: floor + 6.5, side: stoneDark, cap: stone },
      { offsetAlong: hw * 0.62, offsetAcross: 0, halfAlong: hw * 0.32, halfAcross: hd * 0.72, bottom: floor + 2.8, top: floor + 6.5, side: stoneDark, cap: stone },
    ];
  },

  [KIND_GUILDHALL]: (ctx) => {
    // C5 guildhall: hall + deep workshop wing + flanking loading piers with
    // gap on approach — envelope is wide and asymmetric, not barn-like.
    const { halfWidth: hw, halfDepth: hd, base, floor, eaves } = ctx;
    const stone: Rgb = [0.55, 0.5, 0.44];
    const stoneDark: Rgb = [0.38, 0.34, 0.3];
    const timber: Rgb = [0.32, 0.22, 0.14];
    return [
      // 1 Guild hall proper — set back from the street.
      { offsetAlong: 0, offsetAcross: hd * 0.22, halfAlong: hw * 0.75, halfAcross: hd * 0.58, bottom: base, top: eaves, side: stone, cap: stoneDark },
      // 2 Workshop mass — taller, deeper volume toward the approach (+Z).
      { offsetAlong: 0, offsetAcross: -hd * 0.28, halfAlong: hw * 0.92, halfAcross: hd * 0.78, bottom: floor, top: floor + 11, side: stoneDark, cap: timber },
      // 3 Loading piers flanking the yard opening (gap between = traversable slot).
      { offsetAlong: -hw * 0.62, offsetAcross: -hd * 0.88, halfAlong: hw * 0.38, halfAcross: hd * 0.22, bottom: floor, top: floor + 6, side: timber, cap: stone },
      { offsetAlong: hw * 0.62, offsetAcross: -hd * 0.88, halfAlong: hw * 0.38, halfAcross: hd * 0.22, bottom: floor, top: floor + 6, side: timber, cap: stone },
      // 4 Loading lintel bridging the piers (opening reads below this band).
      { offsetAlong: 0, offsetAcross: -hd * 0.88, halfAlong: hw * 0.22, halfAcross: hd * 0.18, bottom: floor + 5.5, top: floor + 8.5, side: stoneDark, cap: stone },
    ];
  },

  [KIND_GATEHOUSE]: (ctx) => {
    // C5 gatehouse: twin towers + lintel; centre stays empty for the road.
    // Towers ≥125% curtain height (WALL_HEIGHT=14 → top ≥ floor+17.5).
    const { halfWidth: hw, halfDepth: hd, base, floor } = ctx;
    const stone: Rgb = [0.72, 0.68, 0.6];
    const stoneDark: Rgb = [0.48, 0.44, 0.38];
    const towerTop = floor + 26;
    const lintelBot = floor + 11;
    return [
      // 1 West tower (along −X in lot frame).
      { offsetAlong: -hw * 0.72, offsetAcross: 0, halfAlong: hw * 0.32, halfAcross: hd * 0.95, bottom: base, top: towerTop, side: stone, cap: stoneDark },
      { offsetAlong: -hw * 0.72, offsetAcross: 0, halfAlong: hw * 0.22, halfAcross: hd * 0.72, bottom: towerTop - 0.5, top: towerTop + 3, side: stoneDark, cap: stone },
      // 2 East tower (along +X).
      { offsetAlong: hw * 0.72, offsetAcross: 0, halfAlong: hw * 0.32, halfAcross: hd * 0.95, bottom: base, top: towerTop, side: stone, cap: stoneDark },
      { offsetAlong: hw * 0.72, offsetAcross: 0, halfAlong: hw * 0.22, halfAcross: hd * 0.72, bottom: towerTop - 0.5, top: towerTop + 3, side: stoneDark, cap: stone },
      // 3 Lintel / parapet band above the opening (no fill below lintelBot).
      { offsetAlong: 0, offsetAcross: 0, halfAlong: hw * 0.42, halfAcross: hd * 0.7, bottom: lintelBot, top: floor + 16, side: stone, cap: stoneDark },
      // 4 Outer buttresses on the approach face for silhouette readability.
      { offsetAlong: -hw * 0.72, offsetAcross: hd * 0.7, halfAlong: hw * 0.22, halfAcross: hd * 0.28, bottom: floor, top: towerTop - 4, side: stoneDark, cap: stone },
      { offsetAlong: hw * 0.72, offsetAcross: hd * 0.7, halfAlong: hw * 0.22, halfAcross: hd * 0.28, bottom: floor, top: towerTop - 4, side: stoneDark, cap: stone },
    ];
  },
};

/**
 * Landmark-only exterior shells. `LANDMARK_RECIPES[kind]` replaces the
 * cottage gable path, giving every civic kind its own footprint and skyline.
 */
function addLandmarkBuilding(
  b: BuildingBuilder,
  kind: number,
  centerX: number,
  centerZ: number,
  alongX: number,
  alongZ: number,
  acrossX: number,
  acrossZ: number,
  halfWidth: number,
  halfDepth: number,
  base: number,
  floor: number,
  eaves: number,
  _ridge: number,
  wall: Rgb,
  roof: Rgb,
  plinth: Rgb,
): void {
  const recipe = LANDMARK_RECIPES[kind];
  if (recipe === undefined) return;
  const ctx: LandmarkContext = { halfWidth, halfDepth, base, floor, eaves, wall, roof, plinth };
  for (const box of recipe(ctx)) {
    addOrientedBox(
      b, centerX, centerZ, alongX, alongZ, acrossX, acrossZ,
      box.offsetAlong, box.offsetAcross, box.halfAlong, box.halfAcross, box.bottom, box.top, box.side, box.cap,
    );
  }
}

/**
 * Add one building to the node.
 *
 * `groundAt` is THIS node's rendered ground in node-local metres -- the same
 * interpolation of the same lattice `road-mesh.ts` fits a deck to -- and it is
 * read for the plinth and for the levelness count, never for the floor. See the
 * header.
 */

function emitLotsInNode(
  b: BuildingBuilder,
  rec: SectorLots,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  groundAt: (localX: number, localZ: number) => number,
  palette: BuildingPalette,
  cultureId: number,
  lod: number,
): void {
  for (let k = 0; k < rec.count; k++) {
    if (b.count >= BUILDING_MAX_PER_NODE) break;
    const cx = rec.centerX[k] as number;
    const cz = rec.centerZ[k] as number;
    if (cx < minX || cx >= maxX || cz < minZ || cz >= maxZ) continue;
    addBuilding(b, rec, k, minX, minZ, groundAt, palette, cultureId, lod);
  }
}

// ---------------------------------------------------------------------------
// Roof variety (Phase Politics B1)
// ---------------------------------------------------------------------------

const ROOF_SALT = 0x526f_6f66; // 'Roof'

/** The `ROOF_*` values `addRoofCap` actually draws. See its own `else` branch. */
const IMPLEMENTED_ROOFS: readonly number[] = [ROOF_GABLE, ROOF_HIP, ROOF_FLAT_PARAPET, ROOF_SHED, ROOF_PYRAMID];

const CULTURE_ROOF_SALT = 0x4375_526f; // 'CuRo'

/**
 * Phase Politics B3. For the cottage/warehouse bucket only (see `pickRoofType`),
 * a culture's own `houseRoofs` preference (`culture.ts`) nudges the roll
 * toward one of ITS preferred roofs, restricted to the ones `addRoofCap` can
 * actually draw -- `MANSARD`/`GAMBREL`/`DOME_FACET` are still unimplemented
 * (Phase B1's gap, not this slice's), so a culture whose preference is one of
 * those (Riverlands, Highland Clans) simply has fewer of its OWN roofs to
 * draw from here, rather than silently drawing an unrelated one.
 *
 * A SOFT nudge (55% of the time), not a hard filter to the culture's list:
 * hard-filtering would collapse a culture whose only implemented preference
 * is `ROOF_GABLE` to a monotonous single-roof village, undoing B1's whole
 * point. `undefined` means "no nudge this roll" -- `pickRoofType` falls
 * through to its own kind-based distribution.
 */
function cultureHouseRoof(cultureId: number, worldX: number, worldZ: number): number | undefined {
  const culture = CULTURES[cultureId] as Culture | undefined;
  if (culture === undefined) return undefined;
  const implemented = culture.houseRoofs.filter((r) => IMPLEMENTED_ROOFS.includes(r));
  if (implemented.length === 0) return undefined;
  const nudgeRoll =
    (hash2i(Math.round(worldX * 4) + 1, Math.round(worldZ * 4) + 1, CULTURE_ROOF_SALT) >>> 0) % 100;
  if (nudgeRoll >= 55) return undefined;
  return implemented[nudgeRoll % implemented.length] as number;
}

/**
 * Which `ROOF_*` (`culture.ts`) an ordinary building gets. A pure function of
 * its own WORLD centre (not the node-local one -- the choice must not depend
 * on which node/lod happens to be rendering it), its `kind`, and (for the
 * cottage/warehouse bucket) its `cultureId`, so a barn leans toward
 * `ROOF_SHED`/`ROOF_GABLE` and a dense townhouse street leans toward
 * `ROOF_FLAT_PARAPET`/`ROOF_HIP` rather than every kind drawing from the same
 * weights.
 *
 * `cultureId` only biases the cottage/warehouse default bucket (see
 * `cultureHouseRoof`) -- barn/townhouse/hall keep their own kind-specific
 * distribution unbiased by culture, a deliberate B3 scope limit: those three
 * already have a strong kind-appropriate shape (a barn is a barn in every
 * culture), and civic-flavoured roofs on a barn would read as a mistake, not
 * variety. `cultureId = -1` (the default) means "no culture data available",
 * matching `polity.ts`'s own sentinel for unclaimed ground.
 *
 * `MANSARD`/`GAMBREL`/`DOME_FACET` (the other three of `culture.ts`'s 8) are
 * not implemented yet -- see PROGRESS.md. `pickRoofType` never returns them.
 */
export function pickRoofType(
  kind: number,
  worldX: number,
  worldZ: number,
  cultureId = -1,
): number {
  // *4 before rounding: lots sit at fractional metres, and rounding straight
  // to an integer metre would make two lots ~0.5 m apart alias to the same
  // hash more often than this hash's own avalanche already spreads them.
  const roll =
    (hash2i(Math.round(worldX * 4), Math.round(worldZ * 4), ROOF_SALT) >>> 0) % 100;
  if (kind === KIND_BARN) {
    return roll < 65 ? ROOF_GABLE : ROOF_SHED;
  }
  if (kind === KIND_TOWNHOUSE) {
    if (roll < 45) return ROOF_FLAT_PARAPET;
    if (roll < 80) return ROOF_GABLE;
    return ROOF_HIP;
  }
  if (kind === KIND_HALL) {
    return roll < 60 ? ROOF_GABLE : ROOF_HIP;
  }
  // Cottage, warehouse, and the default for any future kind this function
  // does not yet know about.
  const cultureRoof = cultureHouseRoof(cultureId, worldX, worldZ);
  if (cultureRoof !== undefined) return cultureRoof;
  if (roll < 42) return ROOF_GABLE;
  if (roll < 68) return ROOF_HIP;
  if (roll < 88) return ROOF_PYRAMID;
  return ROOF_SHED;
}

/**
 * Emit the roof cap (everything above `eaves`) for one ordinary building.
 * The four walls up to `eaves` are already emitted by the caller and are the
 * SAME for every roof type -- only what sits on top of them differs.
 *
 * `at(u, v, y)` is the caller's corner helper: `u` runs along the frontage in
 * `[-1, 1]`, `v` runs from the front (`-1`) to the back (`1`), matching the
 * ordinary wall geometry's own convention.
 */
function addRoofCap(
  b: BuildingBuilder,
  roofType: number,
  at: (u: number, v: number, y: number) => Corner,
  cornerX: (u: number, v: number) => number,
  cornerZ: (u: number, v: number) => number,
  eaves: number,
  ridge: number,
  alongX: number,
  alongZ: number,
  acrossX: number,
  acrossZ: number,
  wall: Rgb,
  roof: Rgb,
): void {
  const roofColors4: readonly Rgb[] = [roof, roof, roof, roof];
  const roofColors3: readonly Rgb[] = [roof, roof, roof];
  const wallColors3: readonly Rgb[] = [wall, wall, wall];

  if (roofType === ROOF_HIP) {
    // Ridge shortened to `hipFrac` of the full length rather than running
    // edge to edge -- the roof slopes down on EVERY side, so there is no
    // vertical gable triangle at the ends, only two more (sloped,
    // roof-coloured) faces closing them.
    const hipFrac = 0.45;
    const ridgeA: Corner = { x: cornerX(-hipFrac, 0), y: ridge, z: cornerZ(-hipFrac, 0) };
    const ridgeB: Corner = { x: cornerX(hipFrac, 0), y: ridge, z: cornerZ(hipFrac, 0) };
    face(b, [at(-1, -1, eaves), at(1, -1, eaves), ridgeB, ridgeA], roofColors4, -acrossX, 1, -acrossZ);
    face(b, [at(1, 1, eaves), at(-1, 1, eaves), ridgeA, ridgeB], roofColors4, acrossX, 1, acrossZ);
    face(b, [at(-1, -1, eaves), at(-1, 1, eaves), ridgeA], roofColors3, -alongX, 1, -alongZ);
    face(b, [at(1, 1, eaves), at(1, -1, eaves), ridgeB], roofColors3, alongX, 1, alongZ);
  } else if (roofType === ROOF_PYRAMID) {
    // The ridge collapses to a single apex -- four triangular slopes, one
    // per wall. Reads as a small tower or a modest cottage roof depending on
    // the footprint's own aspect ratio.
    const apex: Corner = { x: cornerX(0, 0), y: ridge, z: cornerZ(0, 0) };
    face(b, [at(-1, -1, eaves), at(1, -1, eaves), apex], roofColors3, -acrossX, 1, -acrossZ);
    face(b, [at(1, 1, eaves), at(-1, 1, eaves), apex], roofColors3, acrossX, 1, acrossZ);
    face(b, [at(-1, -1, eaves), at(-1, 1, eaves), apex], roofColors3, -alongX, 1, -alongZ);
    face(b, [at(1, 1, eaves), at(1, -1, eaves), apex], roofColors3, alongX, 1, alongZ);
  } else if (roofType === ROOF_FLAT_PARAPET) {
    // No ridge at all: a flat cap a short parapet above the eaves line, with
    // the parapet itself as four short wall-coloured risers -- reads as a
    // dense city street rather than a cottage.
    const parapetTop = eaves + 0.6;
    const parapetColors: readonly Rgb[] = [wall, wall, wall, wall];
    face(
      b,
      [at(-1, -1, eaves), at(1, -1, eaves), at(1, -1, parapetTop), at(-1, -1, parapetTop)],
      parapetColors,
      -acrossX,
      0,
      -acrossZ,
    );
    face(
      b,
      [at(1, 1, eaves), at(-1, 1, eaves), at(-1, 1, parapetTop), at(1, 1, parapetTop)],
      parapetColors,
      acrossX,
      0,
      acrossZ,
    );
    face(
      b,
      [at(-1, 1, eaves), at(-1, -1, eaves), at(-1, -1, parapetTop), at(-1, 1, parapetTop)],
      parapetColors,
      -alongX,
      0,
      -alongZ,
    );
    face(
      b,
      [at(1, -1, eaves), at(1, 1, eaves), at(1, 1, parapetTop), at(1, -1, parapetTop)],
      parapetColors,
      alongX,
      0,
      alongZ,
    );
    face(
      b,
      [at(-1, -1, parapetTop), at(1, -1, parapetTop), at(1, 1, parapetTop), at(-1, 1, parapetTop)],
      roofColors4,
      0,
      1,
      0,
    );
  } else if (roofType === ROOF_SHED) {
    // One sloped plane, low at the front (`eaves`) and high at the back
    // (`ridge`) -- a lean-to. The back wall needs a short riser up to the
    // slope's high edge, and the two side walls need a triangular infill
    // between their flat top (still `eaves`, unchanged from the shared wall
    // geometry) and the raised back corner.
    const riserColors: readonly Rgb[] = [wall, wall, wall, wall];
    face(
      b,
      [at(-1, 1, eaves), at(1, 1, eaves), at(1, 1, ridge), at(-1, 1, ridge)],
      riserColors,
      acrossX,
      0,
      acrossZ,
    );
    face(b, [at(-1, -1, eaves), at(-1, 1, eaves), at(-1, 1, ridge)], wallColors3, -alongX, 0, -alongZ);
    face(b, [at(1, -1, eaves), at(1, 1, eaves), at(1, 1, ridge)], wallColors3, alongX, 0, alongZ);
    face(
      b,
      [at(-1, -1, eaves), at(1, -1, eaves), at(1, 1, ridge), at(-1, 1, ridge)],
      roofColors4,
      0,
      1,
      0,
    );
  } else {
    // ROOF_GABLE, and the default for any roof type this function does not
    // (yet) implement -- the original C0 shape.
    const ridgeA: Corner = { x: cornerX(-1, 0), y: ridge, z: cornerZ(-1, 0) };
    const ridgeB: Corner = { x: cornerX(1, 0), y: ridge, z: cornerZ(1, 0) };
    face(b, [at(-1, -1, eaves), at(-1, 1, eaves), ridgeA], wallColors3, -alongX, 0, -alongZ);
    face(b, [at(1, 1, eaves), at(1, -1, eaves), ridgeB], wallColors3, alongX, 0, alongZ);
    face(b, [at(-1, -1, eaves), at(1, -1, eaves), ridgeB, ridgeA], roofColors4, -acrossX, 1, -acrossZ);
    face(b, [at(1, 1, eaves), at(-1, 1, eaves), ridgeA, ridgeB], roofColors4, acrossX, 1, acrossZ);
  }
}

/**
 * The `BUILDING_LOD_SIMPLIFY` cap: one flat quad at `eaves`, roof-coloured,
 * no riser, no roof-type variety. Paired with the four ordinary walls
 * (unchanged at every LOD -- the footprint is what makes a settlement read
 * as a settlement from any distance) and nothing else: no facade panels.
 */
function addSimplifiedCap(b: BuildingBuilder, at: (u: number, v: number, y: number) => Corner, eaves: number, roof: Rgb): void {
  const roofColors: readonly Rgb[] = [roof, roof, roof, roof];
  face(b, [at(-1, -1, eaves), at(1, -1, eaves), at(1, 1, eaves), at(-1, 1, eaves)], roofColors, 0, 1, 0);
}

function addBuilding(
  b: BuildingBuilder,
  lots: SectorLots,
  i: number,
  originX: number,
  originZ: number,
  groundAt: (localX: number, localZ: number) => number,
  palette: BuildingPalette,
  cultureId: number,
  lod: number,
): void {
  b.startBuilding();
  const centerX = (lots.centerX[i] as number) - originX;
  const centerZ = (lots.centerZ[i] as number) - originZ;
  const floor = lots.floorY[i] as number;
  const alongX = lots.alongX[i] as number;
  const alongZ = lots.alongZ[i] as number;
  const halfWidth = lots.halfWidth[i] as number;
  const halfDepth = lots.halfDepth[i] as number;
  const eaves = floor + (lots.eaves[i] as number);
  const ridge = eaves + (lots.ridge[i] as number);

  // The across axis, chosen so that `along x across` points up: with
  // along = (ax, 0, az), across = (az, 0, -ax) gives a cross product of +Y.
  const acrossX = alongZ;
  const acrossZ = -alongX;

  // -- where the plinth stops -------------------------------------------------
  let lowest = Infinity;
  let worst = 0;
  for (let cornerU = -1; cornerU <= 1; cornerU += 2) {
    for (let cornerV = -1; cornerV <= 1; cornerV += 2) {
      const cx = centerX + alongX * halfWidth * cornerU + acrossX * halfDepth * cornerV;
      const cz = centerZ + alongZ * halfWidth * cornerU + acrossZ * halfDepth * cornerV;
      const g = groundAt(cx, cz);
      if (g < lowest) lowest = g;
      const off = g > floor ? g - floor : floor - g;
      if (off > worst) worst = off;
    }
  }
  let base = lowest - BUILDING_FOOTING;
  const floorLimit = floor - BUILDING_MAX_PLINTH;
  if (base < floorLimit) base = floorLimit;
  // A node whose ground rises ABOVE the floor would otherwise invert the walls.
  if (base > floor) base = floor;

  b.count++;
  if (b.countLevel && worst <= BUILDING_LEVEL_TOLERANCE) b.level++;

  // -- colours ---------------------------------------------------------------
  const wallT = lots.wallTint[i] as number;
  const roofT = lots.roofTint[i] as number;
  const wall: [number, number, number] = [
    palette.wallA[0] + (palette.wallB[0] - palette.wallA[0]) * wallT,
    palette.wallA[1] + (palette.wallB[1] - palette.wallA[1]) * wallT,
    palette.wallA[2] + (palette.wallB[2] - palette.wallA[2]) * wallT,
  ];
  const roof: [number, number, number] = [
    palette.roofA[0] + (palette.roofB[0] - palette.roofA[0]) * roofT,
    palette.roofA[1] + (palette.roofB[1] - palette.roofA[1]) * roofT,
    palette.roofA[2] + (palette.roofB[2] - palette.roofA[2]) * roofT,
  ];
  const kind = lots.kind[i] as number;
  if (kind === KIND_BARN) b.barn++;
  else if (kind === KIND_HALL) b.hall++;
  else if (kind === KIND_TOWNHOUSE) b.townhouse++;
  else if (kind === KIND_GUILDHALL) b.guildhall++;
  else if (kind === KIND_WAREHOUSE) b.warehouse++;
  else if (kind === KIND_KEEP) b.keep++;
  else if (kind === KIND_CATHEDRAL) b.cathedral++;
  else if (kind === KIND_TOWNHALL) b.townhall++;
  else if (kind === KIND_GATEHOUSE) b.gatehouse++;
  else b.cottage++;

  if (
    kind === KIND_KEEP ||
    kind === KIND_CATHEDRAL ||
    kind === KIND_TOWNHALL ||
    kind === KIND_GUILDHALL ||
    kind === KIND_GATEHOUSE
  ) {
    addLandmarkBuilding(
      b,
      kind,
      centerX,
      centerZ,
      alongX,
      alongZ,
      acrossX,
      acrossZ,
      halfWidth,
      halfDepth,
      base,
      floor,
      eaves,
      ridge,
      wall,
      roof,
      palette.plinth,
    );
    return;
  }

  // Phase Politics B4. `lod` decides full massing vs the flat silhouette cap
  // -- see `BUILDING_LOD_SIMPLIFY`'s own doc comment for why lod 0 is the cut
  // line. `roofType` is only meaningful (and only computed) on the full path.
  const simplified = lod >= BUILDING_LOD_SIMPLIFY;

  // Phase Politics B1. One of `ROOF_*` (`culture.ts`), a pure function of the
  // lot's own WORLD position (not the node-local one, so the choice is the
  // same regardless of which node/lod renders it) and its kind -- a barn
  // never gets a flat parapet, a townhouse never gets a barn's plain gable
  // bias. See `pickRoofType`.
  const roofType = simplified
    ? -1
    : pickRoofType(kind, lots.centerX[i] as number, lots.centerZ[i] as number, cultureId);

  // -- the corners -----------------------------------------------------------
  //
  // `u` runs along the frontage and `v` back from it; the ridge lies over the
  // centreline v = 0, along u, which is what makes a gable end face the street.
  const cornerX = (u: number, v: number): number =>
    centerX + alongX * halfWidth * u + acrossX * halfDepth * v;
  const cornerZ = (u: number, v: number): number =>
    centerZ + alongZ * halfWidth * u + acrossZ * halfDepth * v;

  const at = (u: number, v: number, y: number): Corner => ({
    x: cornerX(u, v),
    y,
    z: cornerZ(u, v),
  });

  // The plinth is not its own band of geometry: it is the part of the wall below
  // the floor line, coloured as stone only where it is actually exposed.
  const wallBase: Rgb = floor - base > BUILDING_FOOTING ? palette.plinth : wall;
  const wallColors: readonly Rgb[] = [wallBase, wallBase, wall, wall];
  const wallFace = (
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    hintX: number,
    hintZ: number,
  ): void => {
    face(
      b,
      [at(u0, v0, base), at(u1, v1, base), at(u1, v1, eaves), at(u0, v0, eaves)],
      wallColors,
      hintX,
      0,
      hintZ,
    );
  };

  // Four walls, base to eaves, in the four outward directions.
  wallFace(-1, -1, 1, -1, -acrossX, -acrossZ);
  wallFace(1, 1, -1, 1, acrossX, acrossZ);
  wallFace(-1, 1, -1, -1, -alongX, -alongZ);
  wallFace(1, -1, 1, 1, alongX, alongZ);

  if (simplified) {
    // Phase Politics B4. Walls only, plus one flat cap -- see
    // `addSimplifiedCap` and `BUILDING_LOD_SIMPLIFY`. No roof-type variety,
    // no facade detail: at this distance neither would read as more than a
    // handful of pixels, and a coarse node can hold dozens of these at once.
    addSimplifiedCap(b, at, eaves, roof);
    b.simplified++;
    return;
  }

  // The roof cap -- everything above `eaves` -- varies by `roofType`. See
  // `addRoofCap` (Phase Politics B1). The walls above are the same regardless.
  addRoofCap(b, roofType, at, cornerX, cornerZ, eaves, ridge, alongX, alongZ, acrossX, acrossZ, wall, roof);

  // Facade detail: exactly two quads for every non-landmark kind, on top of
  // whatever the roof cap cost -- vertex count is no longer fixed across
  // roof types, so `BuildingSurface.buildingStart` is what a consumer needing
  // per-building extents reads (see its own doc comment).
  const wood: Rgb = [0.18, 0.11, 0.07];
  const glass: Rgb = [0.22, 0.28, 0.34];
  const stone: Rgb = [0.22, 0.2, 0.18];
  const push = 0.05;
  const panel = (
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    y0: number,
    y1: number,
    outX: number,
    outZ: number,
    color: Rgb,
  ): void => {
    const ox = outX * push;
    const oz = outZ * push;
    face(
      b,
      [
        { x: cornerX(u0, v0) + ox, y: y0, z: cornerZ(u0, v0) + oz },
        { x: cornerX(u1, v1) + ox, y: y0, z: cornerZ(u1, v1) + oz },
        { x: cornerX(u1, v1) + ox, y: y1, z: cornerZ(u1, v1) + oz },
        { x: cornerX(u0, v0) + ox, y: y1, z: cornerZ(u0, v0) + oz },
      ],
      [color, color, color, color],
      outX,
      0,
      outZ,
    );
  };

  if (kind === KIND_BARN) {
    const y0 = floor + 0.05;
    const y1 = floor + (eaves - floor) * 0.85;
    panel(-0.85, -1, -0.05, -1, y0, y1, -acrossX, -acrossZ, wood);
    panel(0.05, -1, 0.85, -1, y0, y1, -acrossX, -acrossZ, wood);
  } else if (kind === KIND_HALL) {
    // Door on the street front, chimney as an upward-facing cap on the ridge.
    // The cap's +Y hint keeps the winding test honest (a vertical chimney slab
    // on the roof pulled the vertex centroid and failed it).
    const y0 = floor + 0.05;
    const y1 = floor + (eaves - floor) * 0.55;
    panel(-0.22, -1, 0.22, -1, y0, y1, -acrossX, -acrossZ, wood);
    const cu = 0.4;
    const half = 0.2;
    const topY = ridge + 1.4;
    face(
      b,
      [
        {
          x: cornerX(cu - half, -half),
          y: topY,
          z: cornerZ(cu - half, -half),
        },
        {
          x: cornerX(cu + half, -half),
          y: topY,
          z: cornerZ(cu + half, -half),
        },
        {
          x: cornerX(cu + half, half),
          y: topY,
          z: cornerZ(cu + half, half),
        },
        {
          x: cornerX(cu - half, half),
          y: topY,
          z: cornerZ(cu - half, half),
        },
      ],
      [stone, stone, stone, stone],
      0,
      1,
      0,
    );
  } else {
    const y0 = floor + 0.05;
    const y1 = floor + (eaves - floor) * 0.55;
    panel(-0.18, -1, 0.18, -1, y0, y1, -acrossX, -acrossZ, wood);
    const wy0 = floor + (eaves - floor) * 0.35;
    const wy1 = floor + (eaves - floor) * 0.7;
    panel(1, -0.35, 1, 0.05, wy0, wy1, alongX, alongZ, glass);
  }

}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build one node's building submesh.
 *
 * The settlements in reach are ENUMERATED through the region records rather than
 * found by sweeping the sector grid, for the reason `road-mesh.ts` states at
 * length and paid for in a 96-second screenshot: a lot record exists only where
 * a settlement centre is, and the region already lists every settlement that can
 * reach this node. A node normally visits none.
 */
export function buildBuildingSurface(
  coord: ChunkCoord,
  roads: RegionRoadField,
  lots: SectorLotField,
  groundAt: (localX: number, localZ: number) => number,
  palette: BuildingPalette,
  cultureId = -1,
): BuildingSurface {
  const size = chunkSizeAt(coord.lod);
  const minX = coord.x * size;
  const minZ = coord.z * size;
  const maxX = minX + size;
  const maxZ = minZ + size;

  const b = new BuildingBuilder();
  b.countLevel = coord.lod === BUILDING_LEVEL_LOD;

  const searchPad = CITY_BUILDING_SEARCH_PAD;
  const r0X = Math.floor((minX - searchPad) / REGION_SIZE);
  const r1X = Math.floor((maxX + searchPad) / REGION_SIZE);
  const r0Z = Math.floor((minZ - searchPad) / REGION_SIZE);
  const r1Z = Math.floor((maxZ + searchPad) / REGION_SIZE);

  const visitedSectors = new Set<string>();
  const visitedSettlements = new Set<string>();
  for (let rz = r0Z; rz <= r1Z; rz++) {
    for (let rx = r0X; rx <= r1X; rx++) {
      const net = roads.networkAt(
        rx * REGION_SIZE + REGION_SIZE / 2,
        rz * REGION_SIZE + REGION_SIZE / 2,
      );
      for (let i = 0; i < net.settlements.length; i++) {
        const site = net.settlements[i] as (typeof net.settlements)[number];
        const reach = isCity(site) ? cityInfluenceRadius(site) : LOT_MAX_EXTENT;
        if (site.x + reach < minX || site.x - reach > maxX) continue;
        if (site.z + reach < minZ || site.z - reach > maxZ) continue;

        const settleKey = `${site.cellX},${site.cellZ}`;
        if (visitedSettlements.has(settleKey)) continue;
        visitedSettlements.add(settleKey);

        // Villages: one sector owns all lots (centre cell).
        // Cities: every sector overlapping the city may hold clipped lots —
        // load each sector whose square intersects this node (and the city).
        if (!isCity(site)) {
          const sx = Math.floor(site.x / SECTOR_SIZE);
          const sz = Math.floor(site.z / SECTOR_SIZE);
          const key = `${sx},${sz}`;
          if (visitedSectors.has(key)) continue;
          visitedSectors.add(key);
          emitLotsInNode(b, lots.lotsAt(sx, sz), minX, minZ, maxX, maxZ, groundAt, palette, cultureId, coord.lod);
          continue;
        }

        const s0x = Math.floor((Math.max(minX, site.x - reach) - 1) / SECTOR_SIZE);
        const s1x = Math.floor((Math.min(maxX, site.x + reach) + 1) / SECTOR_SIZE);
        const s0z = Math.floor((Math.max(minZ, site.z - reach) - 1) / SECTOR_SIZE);
        const s1z = Math.floor((Math.min(maxZ, site.z + reach) + 1) / SECTOR_SIZE);
        for (let sz = s0z; sz <= s1z; sz++) {
          for (let sx = s0x; sx <= s1x; sx++) {
            const key = `${sx},${sz}`;
            if (visitedSectors.has(key)) continue;
            visitedSectors.add(key);
            emitLotsInNode(b, lots.lotsAt(sx, sz), minX, minZ, maxX, maxZ, groundAt, palette, cultureId, coord.lod);
          }
        }
      }
    }
  }

  return b.finish();
}
