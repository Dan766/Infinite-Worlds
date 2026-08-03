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
import { LOT_MAX_EXTENT, type SectorLotField, type SectorLots } from './lots';
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
export const BUILDING_VERTEX_COUNT = 30;
export const BUILDING_TRIANGLE_COUNT = 14;

/**
 * Metres beyond the node square within which a region is consulted for
 * settlements.
 *
 * A settlement whose buildings reach this node can stand `LOT_MAX_EXTENT`
 * outside it, and its own region is the one guaranteed to list it. This is the
 * same lookup `road-mesh.ts` performs for streets, one number larger, and it is
 * why buildings cost no extra region build: the regions are already resident.
 */
const REGION_SEARCH_PAD = LOT_MAX_EXTENT;

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
   * building has the same 14 triangles, so a count of objects is the only thing
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

/**
 * Add one building to the node.
 *
 * `groundAt` is THIS node's rendered ground in node-local metres -- the same
 * interpolation of the same lattice `road-mesh.ts` fits a deck to -- and it is
 * read for the plinth and for the levelness count, never for the floor. See the
 * header.
 */
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

  const r0X = Math.floor((minX - REGION_SEARCH_PAD) / REGION_SIZE);
  const r1X = Math.floor((maxX + REGION_SEARCH_PAD) / REGION_SIZE);
  const r0Z = Math.floor((minZ - REGION_SEARCH_PAD) / REGION_SIZE);
  const r1Z = Math.floor((maxZ + REGION_SEARCH_PAD) / REGION_SIZE);

  const visited = new Set<string>();
  for (let rz = r0Z; rz <= r1Z; rz++) {
    for (let rx = r0X; rx <= r1X; rx++) {
      const net = roads.networkAt(
        rx * REGION_SIZE + REGION_SIZE / 2,
        rz * REGION_SIZE + REGION_SIZE / 2,
      );
      for (let i = 0; i < net.settlements.length; i++) {
        const s = net.settlements[i] as (typeof net.settlements)[number];
        if (s.x + LOT_MAX_EXTENT < minX || s.x - LOT_MAX_EXTENT > maxX) continue;
        if (s.z + LOT_MAX_EXTENT < minZ || s.z - LOT_MAX_EXTENT > maxZ) continue;
        // Two regions can both list one settlement, and its own sector is
        // unique, so the sector coordinate is the identity to deduplicate on --
        // the same rule `road-mesh.ts` uses for street plans.
        const sx = Math.floor(s.x / SECTOR_SIZE);
        const sz = Math.floor(s.z / SECTOR_SIZE);
        const key = `${sx},${sz}`;
        if (visited.has(key)) continue;
        visited.add(key);

        const rec = lots.lotsAt(sx, sz);
        for (let k = 0; k < rec.count; k++) {
          if (b.count >= BUILDING_MAX_PER_NODE) break;
          const cx = rec.centerX[k] as number;
          const cz = rec.centerZ[k] as number;
          // Half-open on the maximum edges, the same `[min, max)` convention
          // `worldToChunk` and `clipSegmentToBox` use, so a building whose
          // centre lands exactly on a boundary belongs to one node and not two.
          if (cx < minX || cx >= maxX || cz < minZ || cz >= maxZ) continue;
          addBuilding(b, rec, k, minX, minZ, groundAt, palette);
        }
      }
    }
  }

  return b.finish();
}
