/**
 * Props, as geometry: one batched submesh per node.
 *
 * Phase 7a. Follows buildings in every structural respect -- per-chunk, built in
 * the worker, zero-length arrays where there is nothing, disposed with the
 * node, ownership by centre, LOD-independent base Y from `sampleHeight`, and a
 * short buried stump that meets THIS node's rendered ground the way a plinth
 * does.
 *
 * ---------------------------------------------------------------------------
 * ONE MESH PER NODE, NOT ONE PER PROP
 *
 * A forest lod-0 node holds tens to low hundreds of trees. One mesh each would
 * put the draw-call budget through the floor; every prop in the node goes into
 * ONE buffer with per-vertex colour, which is what keeps this phase's cost to
 * +1 draw call per node that has any.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Exact IEEE-754 only: `+ - * /` and `Math.sqrt`. Facing arrives as a unit
 * direction from `props.ts`; nothing here calls `sin` / `cos`.
 */

import { type ChunkCoord, chunkSizeAt } from './contracts';
import { type SectorLotField } from './lots';
import { lerp } from './noise';
import {
  collectNodeProps,
  PROP_KIND_BUSH,
  PROP_KIND_CRATE,
  PROP_KIND_TREE,
  PROP_MAX_PER_NODE,
  PROP_SEAT_LOD,
  PROP_SEAT_TOLERANCE,
  type PropField,
} from './props';
import { type RegionRoadField } from './roads';
import { type SectorStreetField } from './streets';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres the stump reaches below the lowest ground under a prop.
 *
 * Same job as `BUILDING_FOOTING`: make sure the trunk meets the ground rather
 * than stopping a few centimetres above an interpolated triangle.
 */
export const PROP_FOOTING = 0.3;

/**
 * Metres of stump below the base, at most.
 *
 * Coarse nodes can put ground a metre below the LOD-independent base; the stump
 * covers it. Unbounded, a tree on a bank grows a curtain down the hillside.
 */
export const PROP_MAX_STUMP = 2.5;

/**
 * Coarsest level that still emits a prop submesh.
 *
 * A root-level node owns every tree centre in a 4 km square and would otherwise
 * hit `PROP_MAX_PER_NODE` with a single draw call of forest geometry nobody can
 * resolve from that lattice. Lod 0-2 still cover what a canopy aerial needs;
 * coarser nodes stay empty arrays (zero draw cost), the same discipline water
 * uses inland.
 */
export const PROP_MESH_MAX_LOD = 2;

/** Re-export the seating constants the payload and streamer read. */
export { PROP_SEAT_LOD, PROP_SEAT_TOLERANCE, PROP_MAX_PER_NODE };

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/**
 * One node's prop submesh. Empty arrays on a node with no prop centre in it.
 *
 * Positions are in the same node-local frame as `ChunkData.positions`.
 */
export interface PropSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Props this node owns. */
  count: number;
  /**
   * Of those, how many stand on ground this node renders within
   * `PROP_SEAT_TOLERANCE` of their own base. Counted at lod 0 only.
   *
   * THE ANTI-VACUITY COUNTER OF THE PHASE: `count` says props were placed; this
   * says they sit on ground the world actually made.
   */
  seated: number;
}

/** LINEAR rgb palette a prop is painted with. */
export interface PropPalette {
  readonly trunkA: readonly [number, number, number];
  readonly trunkB: readonly [number, number, number];
  readonly canopyA: readonly [number, number, number];
  readonly canopyB: readonly [number, number, number];
  readonly bushA: readonly [number, number, number];
  readonly bushB: readonly [number, number, number];
  readonly crateA: readonly [number, number, number];
  readonly crateB: readonly [number, number, number];
  readonly postA: readonly [number, number, number];
  readonly postB: readonly [number, number, number];
  readonly stump: readonly [number, number, number];
}

const EMPTY_PROPS: () => PropSurface = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  count: 0,
  seated: 0,
});

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

class PropBuilder {
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
  seated = 0;
  countSeated = true;

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

  finish(): PropSurface {
    const count = this.px.length;
    if (count === 0) return EMPTY_PROPS();
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
      seated: this.seated,
    };
  }
}

interface Corner {
  x: number;
  y: number;
  z: number;
}

type Rgb = readonly [number, number, number];

/**
 * Emit one planar face as a triangle fan over `corners`, facing `hint`.
 *
 * Reverses winding when the geometric normal disagrees with the outward hint,
 * for the same reason buildings do: a flipped face looks like a lighting bug.
 */
function face(
  b: PropBuilder,
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
    const pick = flip ? total - 1 - i : i;
    const corner = corners[pick] as Corner;
    b.vertex(corner.x, corner.y, corner.z, nx, ny, nz, colors[pick] as Rgb);
  }
  for (let i = 2; i < total; i++) {
    b.indices.push(first, first + i - 1, first + i);
  }
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function boxAt(
  b: PropBuilder,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  dirX: number,
  dirZ: number,
  color: Rgb,
  bottomColor: Rgb | null,
): void {
  // Local axes: along = facing, across = perpendicular in XZ, up = Y.
  const ax = dirX;
  const az = dirZ;
  const bx = dirZ;
  const bz = -dirX;

  const corner = (u: number, v: number, y: number): Corner => ({
    x: cx + ax * hx * u + bx * hz * v,
    y,
    z: cz + az * hx * u + bz * hz * v,
  });

  const y0 = cy - hy;
  const y1 = cy + hy;
  const bot = bottomColor ?? color;
  const cols4 = (c: Rgb): Rgb[] => [c, c, c, c];

  // +along
  face(
    b,
    [corner(1, -1, y0), corner(1, 1, y0), corner(1, 1, y1), corner(1, -1, y1)],
    [bot, bot, color, color],
    ax,
    0,
    az,
  );
  // -along
  face(
    b,
    [corner(-1, 1, y0), corner(-1, -1, y0), corner(-1, -1, y1), corner(-1, 1, y1)],
    [bot, bot, color, color],
    -ax,
    0,
    -az,
  );
  // +across
  face(
    b,
    [corner(1, 1, y0), corner(-1, 1, y0), corner(-1, 1, y1), corner(1, 1, y1)],
    [bot, bot, color, color],
    bx,
    0,
    bz,
  );
  // -across
  face(
    b,
    [corner(-1, -1, y0), corner(1, -1, y0), corner(1, -1, y1), corner(-1, -1, y1)],
    [bot, bot, color, color],
    -bx,
    0,
    -bz,
  );
  // top
  face(b, [corner(-1, -1, y1), corner(1, -1, y1), corner(1, 1, y1), corner(-1, 1, y1)], cols4(color), 0, 1, 0);
  // bottom
  face(b, [corner(-1, 1, y0), corner(1, 1, y0), corner(1, -1, y0), corner(-1, -1, y0)], cols4(bot), 0, -1, 0);
}

function stumpBase(
  groundAt: (localX: number, localZ: number) => number,
  localX: number,
  localZ: number,
  baseY: number,
): number {
  let lowest = Infinity;
  for (let u = -1; u <= 1; u += 2) {
    for (let v = -1; v <= 1; v += 2) {
      const g = groundAt(localX + u * 0.4, localZ + v * 0.4);
      if (g < lowest) lowest = g;
    }
  }
  let bottom = lowest - PROP_FOOTING;
  const floorLimit = baseY - PROP_MAX_STUMP;
  if (bottom < floorLimit) bottom = floorLimit;
  if (bottom > baseY) bottom = baseY;
  return bottom;
}

function addProp(
  b: PropBuilder,
  props: PropField,
  i: number,
  originX: number,
  originZ: number,
  groundAt: (localX: number, localZ: number) => number,
  palette: PropPalette,
): void {
  const worldX = props.centerX[i] as number;
  const worldZ = props.centerZ[i] as number;
  const localX = worldX - originX;
  const localZ = worldZ - originZ;
  const baseY = props.baseY[i] as number;
  const dirX = props.dirX[i] as number;
  const dirZ = props.dirZ[i] as number;
  const scale = props.scale[i] as number;
  const tint = props.tint[i] as number;
  const kind = props.kind[i] as number;

  const bottom = stumpBase(groundAt, localX, localZ, baseY);
  const ground = groundAt(localX, localZ);
  const off = ground > baseY ? ground - baseY : baseY - ground;
  b.count++;
  if (b.countSeated && off <= PROP_SEAT_TOLERANCE) b.seated++;

  if (kind === PROP_KIND_TREE) {
    const trunk = mixRgb(palette.trunkA, palette.trunkB, tint);
    const canopy = mixRgb(palette.canopyA, palette.canopyB, tint);
    const trunkH = 2.4 * scale;
    const trunkR = 0.22 * scale;
    const midY = (bottom + baseY + trunkH) * 0.5;
    const halfH = (baseY + trunkH - bottom) * 0.5;
    boxAt(b, localX, midY, localZ, trunkR, halfH, trunkR, dirX, dirZ, trunk, palette.stump);
    const canopyY = baseY + trunkH + 1.1 * scale;
    const canopyR = 1.15 * scale;
    const canopyH = 1.1 * scale;
    boxAt(b, localX, canopyY, localZ, canopyR, canopyH, canopyR, dirX, dirZ, canopy, null);
    return;
  }

  if (kind === PROP_KIND_BUSH) {
    const bush = mixRgb(palette.bushA, palette.bushB, tint);
    const h = 0.55 * scale;
    const r = 0.7 * scale;
    const midY = (bottom + baseY + h * 2) * 0.5;
    const halfH = (baseY + h * 2 - bottom) * 0.5;
    boxAt(b, localX, midY, localZ, r, halfH, r, dirX, dirZ, bush, palette.stump);
    return;
  }

  if (kind === PROP_KIND_CRATE) {
    const crate = mixRgb(palette.crateA, palette.crateB, tint);
    const h = 0.35 * scale;
    const r = 0.32 * scale;
    const midY = (bottom + baseY + h * 2) * 0.5;
    const halfH = (baseY + h * 2 - bottom) * 0.5;
    boxAt(b, localX, midY, localZ, r, halfH, r, dirX, dirZ, crate, palette.stump);
    return;
  }

  // post
  const post = mixRgb(palette.postA, palette.postB, tint);
  const h = 1.1 * scale;
  const r = 0.08 * scale;
  const midY = (bottom + baseY + h) * 0.5;
  const halfH = (baseY + h - bottom) * 0.5;
  boxAt(b, localX, midY, localZ, r, halfH, r, dirX, dirZ, post, palette.stump);
}

/**
 * Build one node's prop submesh.
 *
 * Collects props via `collectNodeProps`, then emits batched geometry against
 * THIS node's rendered ground for the stump and the seating counter.
 */
export function buildPropSurface(
  coord: ChunkCoord,
  worldSeed: number,
  roads: RegionRoadField,
  streets: SectorStreetField,
  lots: SectorLotField,
  groundAt: (localX: number, localZ: number) => number,
  palette: PropPalette,
): PropSurface {
  if (coord.lod > PROP_MESH_MAX_LOD) return EMPTY_PROPS();

  const props = collectNodeProps(coord, worldSeed, roads, streets, lots);
  if (props.count === 0) return EMPTY_PROPS();

  const size = chunkSizeAt(coord.lod);
  const originX = coord.x * size;
  const originZ = coord.z * size;

  const b = new PropBuilder();
  b.countSeated = coord.lod === PROP_SEAT_LOD;

  for (let i = 0; i < props.count; i++) {
    addProp(b, props, i, originX, originZ, groundAt, palette);
  }

  return b.finish();
}
