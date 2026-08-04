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

/** Vertices and triangles one building costs. Exported for the payload maths. */
/**
 * Vertices and triangles one building costs.
 *
 * Every kind (cottage / barn / hall) lands on the SAME budget: the base gabled
 * box plus exactly two facade quads. Keeping the cost fixed keeps the payload
 * maths and the winding tests load-bearing rather than kind-dependent.
 */
export const BUILDING_VERTEX_COUNT = 38;
export const BUILDING_TRIANGLE_COUNT = 18;

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
   * Buildings this node owns. Not derivable from the triangle count -- every
   * building has the same 18 triangles, so a count of objects is the only thing
   * that distinguishes "forty houses" from "one enormous one".
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
  /** See `BUILDING_LEVEL_LOD`. False on a coarse node, where the number would lie. */
  countLevel = true;

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
    const count = this.px.length;
    if (count === 0) return EMPTY_BUILDINGS();
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

/**
 * Landmark-only exterior shells. Several oriented volumes replace the cottage
 * gable path, giving every civic kind its own footprint and skyline.
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
  const box = (
    offsetAlong: number,
    offsetAcross: number,
    halfAlong: number,
    halfAcross: number,
    bottom: number,
    top: number,
    side: Rgb = wall,
    cap: Rgb = roof,
  ): void => addOrientedBox(
    b, centerX, centerZ, alongX, alongZ, acrossX, acrossZ,
    offsetAlong, offsetAcross, halfAlong, halfAcross, bottom, top, side, cap,
  );

  if (kind === KIND_KEEP) {
    // C5 keep: bailey, gate/approach, central keep, four corner towers (≥2 visible).
    // Towers ≥20% taller than bailey roof (28 vs 6 m above floor). Stone tints
    // separate volumes in shaded proofs. Gate projects toward +Z (approach from SE).
    const stone: Rgb = [0.7, 0.66, 0.58];
    const stoneDark: Rgb = [0.45, 0.42, 0.36];
    const baileyTop = floor + 6;
    const keepLowerTop = floor + 14;
    const keepUpperTop = floor + 19;
    const towerTop = floor + 28;
    const gateTop = floor + 12;
    // 1 Bailey platform — full 44×44 m footprint.
    box(0, 0, halfWidth, halfDepth, base, baileyTop, plinth, stone);
    // 2 Gate / approach barbican — projects toward +Z (negative across).
    box(0, -halfDepth * 1.15, halfWidth * 0.36, halfDepth * 0.2, base, gateTop, stone, stoneDark);
    box(0, -halfDepth * 1.02, halfWidth * 0.14, halfDepth * 0.1, floor, gateTop - 2, stoneDark, stone);
    // 3 Central keep — offset toward gate so the mass reads from approach.
    box(0, -halfDepth * 0.12, halfWidth * 0.42, halfDepth * 0.42, floor, keepLowerTop, stone, stoneDark);
    box(0, -halfDepth * 0.12, halfWidth * 0.28, halfDepth * 0.28, keepLowerTop - 0.5, keepUpperTop, stoneDark, roof);
    // 4 Four corner towers with crown caps (≥2 required; four for top-down readability).
    for (const u of [-1, 1]) {
      for (const v of [-1, 1]) {
        box(
          u * halfWidth * 0.76,
          v * halfDepth * -0.76,
          halfWidth * 0.18,
          halfDepth * 0.18,
          base,
          towerTop,
          stoneDark,
          stone,
        );
        box(
          u * halfWidth * 0.76,
          v * halfDepth * -0.76,
          halfWidth * 0.12,
          halfDepth * 0.12,
          towerTop - 0.5,
          towerTop + 3,
          stone,
          stoneDark,
        );
      }
    }
    return;
  }

  if (kind === KIND_CATHEDRAL) {
    // C5 cathedral: cruciform plan — nave, transept/crossing, west front tower.
    // Transept halfAcross 13 m vs nave 5 m → 260% width ratio (≥125%). Stone
    // tints separate volumes in shaded proofs. Approach from +Z (city core).
    const stone: Rgb = [0.62, 0.6, 0.54];
    const stoneDark: Rgb = [0.44, 0.42, 0.38];
    const stoneLight: Rgb = [0.72, 0.7, 0.64];
    const naveTop = floor + 16;
    const clerestoryTop = floor + 25;
    const transeptTop = floor + 18;
    const towerTop = floor + 34;
    // 1 Nave — long narrow volume along +X.
    box(4, 0, halfWidth * 0.62, 5, base, naveTop, stone, stoneDark);
    // 2 Transept / crossing — wider across, shorter along (cruciform top view).
    box(0, 0, halfWidth * 0.32, halfDepth * 0.46, floor, transeptTop, stoneDark, stone);
    // 3 Nave clerestory — raised centre ridge over the nave.
    box(4, 0, halfWidth * 0.5, 3.5, naveTop - 0.5, clerestoryTop, stoneLight, roof);
    // 4 West front tower — tall block at the −X (west) end.
    box(-halfWidth * 0.68, 0, halfWidth * 0.38, halfDepth * 0.28, base, towerTop, stoneDark, stoneLight);
    box(-halfWidth * 0.68, 0, halfWidth * 0.26, halfDepth * 0.18, towerTop - 0.5, towerTop + 4, stoneLight, stoneDark);
    return;
  }

  if (kind === KIND_TOWNHALL) {
    // C5 town hall: full plinth on all four sides, main hall + clock tower
    // (≥2 roof levels). Frontage = 2×halfWidth along +X (≥18 m absolute).
    const stone: Rgb = [0.58, 0.54, 0.48];
    const stoneDark: Rgb = [0.4, 0.38, 0.34];
    const hallTop = floor + 8;
    const towerTop = floor + 18;
    // 1 Plinth podium — full footprint, visible on every side.
    box(0, 0, halfWidth, halfDepth, base, floor + 3, plinth, stone);
    // 2 Main hall block — inset above plinth.
    box(0, 0, halfWidth * 0.88, halfDepth * 0.82, floor + 2.8, hallTop, stone, stoneDark);
    // 3 Clock tower — projects toward +Z (approach from city core).
    box(0, -halfDepth * 0.28, halfWidth * 0.38, halfDepth * 0.42, floor + 2.8, towerTop, stoneDark, roof);
    box(0, -halfDepth * 0.28, halfWidth * 0.24, halfDepth * 0.28, towerTop - 0.5, towerTop + 3, stone, stoneDark);
    // 4 Side annex wings — lower flanking masses (second silhouette tier).
    box(-halfWidth * 0.62, 0, halfWidth * 0.32, halfDepth * 0.72, floor + 2.8, floor + 6.5, stoneDark, stone);
    box(halfWidth * 0.62, 0, halfWidth * 0.32, halfDepth * 0.72, floor + 2.8, floor + 6.5, stoneDark, stone);
    return;
  }

  if (kind === KIND_GUILDHALL) {
    // C5 guildhall: hall + deep workshop wing + flanking loading piers with
    // gap on approach — envelope is wide and asymmetric, not barn-like.
    const stone: Rgb = [0.55, 0.5, 0.44];
    const stoneDark: Rgb = [0.38, 0.34, 0.3];
    const timber: Rgb = [0.32, 0.22, 0.14];
    // 1 Guild hall proper — set back from the street.
    box(0, halfDepth * 0.22, halfWidth * 0.75, halfDepth * 0.58, base, eaves, stone, stoneDark);
    // 2 Workshop mass — taller, deeper volume toward the approach (+Z).
    box(0, -halfDepth * 0.28, halfWidth * 0.92, halfDepth * 0.78, floor, floor + 11, stoneDark, timber);
    // 3 Loading piers flanking the yard opening (gap between = traversable slot).
    box(-halfWidth * 0.62, -halfDepth * 0.88, halfWidth * 0.38, halfDepth * 0.22, floor, floor + 6, timber, stone);
    box(halfWidth * 0.62, -halfDepth * 0.88, halfWidth * 0.38, halfDepth * 0.22, floor, floor + 6, timber, stone);
    // 4 Loading lintel bridging the piers (opening reads below this band).
    box(0, -halfDepth * 0.88, halfWidth * 0.22, halfDepth * 0.18, floor + 5.5, floor + 8.5, stoneDark, stone);
    return;
  }

  if (kind === KIND_GATEHOUSE) {
    // C5 gatehouse: twin towers + lintel; centre stays empty for the road.
    // Towers ≥125% curtain height (WALL_HEIGHT=14 → top ≥ floor+17.5).
    const stone: Rgb = [0.72, 0.68, 0.6];
    const stoneDark: Rgb = [0.48, 0.44, 0.38];
    const towerTop = floor + 26;
    const lintelBot = floor + 11;
    // 1 West tower (along −X in lot frame).
    box(-halfWidth * 0.72, 0, halfWidth * 0.32, halfDepth * 0.95, base, towerTop, stone, stoneDark);
    box(-halfWidth * 0.72, 0, halfWidth * 0.22, halfDepth * 0.72, towerTop - 0.5, towerTop + 3, stoneDark, stone);
    // 2 East tower (along +X).
    box(halfWidth * 0.72, 0, halfWidth * 0.32, halfDepth * 0.95, base, towerTop, stone, stoneDark);
    box(halfWidth * 0.72, 0, halfWidth * 0.22, halfDepth * 0.72, towerTop - 0.5, towerTop + 3, stoneDark, stone);
    // 3 Lintel / parapet band above the opening (no fill below lintelBot).
    box(0, 0, halfWidth * 0.42, halfDepth * 0.7, lintelBot, floor + 16, stone, stoneDark);
    // 4 Outer buttresses on the approach face for silhouette readability.
    box(-halfWidth * 0.72, halfDepth * 0.7, halfWidth * 0.22, halfDepth * 0.28, floor, towerTop - 4, stoneDark, stone);
    box(halfWidth * 0.72, halfDepth * 0.7, halfWidth * 0.22, halfDepth * 0.28, floor, towerTop - 4, stoneDark, stone);
    return;
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
): void {
  for (let k = 0; k < rec.count; k++) {
    if (b.count >= BUILDING_MAX_PER_NODE) break;
    const cx = rec.centerX[k] as number;
    const cz = rec.centerZ[k] as number;
    if (cx < minX || cx >= maxX || cz < minZ || cz >= maxZ) continue;
    addBuilding(b, rec, k, minX, minZ, groundAt, palette);
  }
}

function addBuilding(
  b: BuildingBuilder,
  lots: SectorLots,
  i: number,
  originX: number,
  originZ: number,
  groundAt: (localX: number, localZ: number) => number,
  palette: BuildingPalette,
): void {
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

  // Gable ends: the triangle between the eaves line and the ridge at each end of
  // the ridge. Wall-coloured, because a gable is the wall carrying on up.
  const ridgeA: Corner = { x: cornerX(-1, 0), y: ridge, z: cornerZ(-1, 0) };
  const ridgeB: Corner = { x: cornerX(1, 0), y: ridge, z: cornerZ(1, 0) };
  const gableColors: readonly Rgb[] = [wall, wall, wall];
  face(b, [at(-1, -1, eaves), at(-1, 1, eaves), ridgeA], gableColors, -alongX, 0, -alongZ);
  face(b, [at(1, 1, eaves), at(1, -1, eaves), ridgeB], gableColors, alongX, 0, alongZ);

  // Roof: two slopes meeting at the ridge. The outward hint carries a +Y
  // component, so a shallow-pitched roof still faces up rather than sideways.
  const roofColors: readonly Rgb[] = [roof, roof, roof, roof];
  face(b, [at(-1, -1, eaves), at(1, -1, eaves), ridgeB, ridgeA], roofColors, -acrossX, 1, -acrossZ);
  face(b, [at(1, 1, eaves), at(-1, 1, eaves), ridgeA, ridgeB], roofColors, acrossX, 1, acrossZ);

  // Facade detail: exactly two quads for every non-landmark kind, so
  // BUILDING_VERTEX_COUNT stays load-bearing for the cottage-derived path.
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
          emitLotsInNode(b, lots.lotsAt(sx, sz), minX, minZ, maxX, maxZ, groundAt, palette);
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
            emitLotsInNode(b, lots.lotsAt(sx, sz), minX, minZ, maxX, maxZ, groundAt, palette);
          }
        }
      }
    }
  }

  return b.finish();
}
