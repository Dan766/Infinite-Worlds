/**
 * Props and vegetation: where a placed object stands, as a pure record.
 *
 * Phase 7a. Placement is a pure function of `(worldSeed, worldXZ)` with node
 * ownership by centre -- the same rule buildings use. There is no Sector-tier
 * memo for world trees: density is continuous across the map, and a sector memo
 * would either overhang like streets or force an 11×11 working set for every
 * chunk. Yard props are the sparse second half of the same pipeline; they query
 * nearby `SectorLots` when a settlement is in reach.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DECIDES, AND WHAT IT DOES NOT
 *
 * Everything a prop IS -- kind, centre, facing-as-unit-direction, scale, tint,
 * base altitude -- is fixed here. `prop-mesh.ts` places geometry and decides
 * nothing. That split is deliberate: a Node test can assert "this forest cell
 * holds a tree" without building a mesh, and the mesh builder can stay free of
 * biome and clearance logic.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Exact IEEE-754 only: `+ - * /` and `Math.sqrt`. Facing is a hash unit
 * direction, never `Math.sin` / `Math.cos` -- those are approximations on the
 * path to a stored vertex (RULE 1).
 */

import { hash3i } from '../core/hash';
import {
  chunkSizeAt,
  REGION_SIZE,
  SECTOR_SIZE,
  type ChunkCoord,
} from './contracts';
import { closestOnSegment } from './grading';
import {
  biomeFields,
  sampleHeight,
  SEA_LEVEL,
} from './height-field';
import { LOT_MAX_EXTENT, type SectorLotField, type SectorLots } from './lots';
import { clamp, hashUnit, lerp } from './noise';
import {
  roadClearance,
  type RegionRoadField,
  type RoadNetwork,
} from './roads';
import { isCity } from './city';
import {
  STREET_HALF_WIDTH,
  type SectorStreetField,
  type SectorStreets,
} from './streets';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Candidate lattice spacing, metres.
 *
 * Tuned so a lod-0 forest node holds tens to low hundreds of props, not
 * thousands. A 64 m node has an 8×8 cell grid at this spacing; accept rates in
 * good biome land around a third to a half, which is the budget this phase
 * exists to prove.
 */
export const PROP_CELL = 10;

/**
 * Soft density gate: candidates whose hash falls below this (after biome
 * weighting) are refused. Keeps open meadows from filling solid while still
 * allowing a forest node to reach the tens–low-hundreds band.
 */
export const PROP_ACCEPT_BASE = 0.42;

/** Metres above sea a prop must clear before it is considered on land. */
export const PROP_SEA_MARGIN = 1.25;

/**
 * Maximum ground slope (rise over run) a prop will accept.
 *
 * Measured from four height samples a metre out from the centre. Steeper ground
 * is where trees look planted into a cliff face; the threshold is deliberately
 * soft -- Phase 7b can tighten per species.
 */
export const PROP_MAX_SLOPE = 0.55;

/** Minimum humidity / temperature / continentalness for world vegetation. */
export const PROP_MIN_HUMIDITY = 0.22;
export const PROP_MIN_TEMPERATURE = 0.12;
export const PROP_MIN_CONTINENT = -0.05;

/** Metres of clear ground from a roadbed edge. */
export const PROP_ROAD_CLEAR = 2.5;

/** Metres of clear ground from a street bed centreline, beyond half-width. */
export const PROP_STREET_CLEAR = 2.0;

/** Metres of clear ground from a building footprint bounding circle. */
export const PROP_BUILDING_CLEAR = 1.5;

/**
 * Hard cap on props in one node's submesh.
 *
 * A SAFETY VALVE THAT SHOULD NEVER FIRE, like `BUILDING_MAX_PER_NODE`. Forest
 * density at `PROP_CELL` lands well under this on a lod-0 node; a root-level
 * node over a forested region is the binding case. Truncation is deterministic
 * -- world lattice order, then yard order -- so a node that hit it would still
 * regenerate byte-identically.
 */
export const PROP_MAX_PER_NODE = 768;

/**
 * Metres of disagreement between a node's rendered ground and a prop's base at
 * which the prop stops counting as seated.
 *
 * The anti-vacuity threshold for `PropSurface.seated`, and nothing else reads
 * it. See `PROP_SEAT_LOD`.
 */
export const PROP_SEAT_TOLERANCE = 0.85;

/**
 * The only level at which seating is counted.
 *
 * Same argument as `BUILDING_LEVEL_LOD`: a prop's base is fixed to
 * `sampleHeight`; a coarse node's lattice cannot describe that contact, and
 * counting it would produce a number about mesh resolution rather than about
 * whether props sit on the ground the world made.
 */
export const PROP_SEAT_LOD = 0;

/** Fraction of world candidates that become bushes rather than trees. */
export const PROP_BUSH_FRACTION = 0.32;

/** Tree / bush scale ranges. */
export const PROP_TREE_SCALE_MIN = 0.75;
export const PROP_TREE_SCALE_MAX = 1.35;
export const PROP_BUSH_SCALE_MIN = 0.55;
export const PROP_BUSH_SCALE_MAX = 1.15;

/** Yard prop scale ranges. */
export const PROP_CRATE_SCALE_MIN = 0.7;
export const PROP_CRATE_SCALE_MAX = 1.2;
export const PROP_POST_SCALE_MIN = 0.85;
export const PROP_POST_SCALE_MAX = 1.25;

/**
 * Metres beyond the node square within which a region is consulted for
 * settlements (yard props + building clearance).
 */
const REGION_SEARCH_PAD = LOT_MAX_EXTENT + 8;

/** How many yard candidates to try per lot, at most. */
const YARD_CANDIDATES_PER_LOT = 2;

/** Salts, one per quantity, so reusing an index cannot alias two attributes. */
const CELL_ACCEPT_SALT = 0x7052_6f70;
const CELL_KIND_SALT = 0x7052_4b6e;
const CELL_SCALE_SALT = 0x7052_5363;
const CELL_TINT_SALT = 0x7052_546e;
const CELL_DIR_SALT = 0x7052_4469;
const CELL_JITTER_SALT = 0x7052_4a74;
const YARD_ACCEPT_SALT = 0x7059_4163;
const YARD_KIND_SALT = 0x7059_4b6e;
const YARD_SCALE_SALT = 0x7059_5363;
const YARD_TINT_SALT = 0x7059_546e;
const YARD_DIR_SALT = 0x7059_4469;
const YARD_SIDE_SALT = 0x7059_5364;
const CELL_SPECIES_SALT = 0x7052_5370;
const YARD_SPECIES_SALT = 0x7059_5370;
const CLUSTER_SALT = 0x7052_436c;

/** World-prop grove stride in cells. Density is modulated per 3x3 block. */
export const CLUSTER_STRIDE = 3;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Sparse kind set for Phase 7a. Species proliferation is Phase 7b / 7c. */
export type PropKind = 'tree' | 'bush' | 'crate' | 'post';

export const PROP_KIND_TREE = 0;
export const PROP_KIND_BUSH = 1;
export const PROP_KIND_CRATE = 2;
export const PROP_KIND_POST = 3;

/**
 * Global species / yard-role IDs. Kind still says tree/bush/crate/post; species
 * picks the silhouette family the mesh reads. Yard roles equal their kind.
 */
export const SPECIES_PINE = 0;
export const SPECIES_BROADLEAF = 1;
export const SPECIES_BUSH_ROUND = 2;
export const SPECIES_BUSH_TALL = 3;
export const SPECIES_CRATE = 4;
export const SPECIES_POST = 5;

/** Integer tag for a kind, so SoA storage stays typed-array clean. */
export function propKindId(kind: PropKind): number {
  switch (kind) {
    case 'tree':
      return PROP_KIND_TREE;
    case 'bush':
      return PROP_KIND_BUSH;
    case 'crate':
      return PROP_KIND_CRATE;
    case 'post':
      return PROP_KIND_POST;
  }
}

export function propKindFromId(id: number): PropKind {
  switch (id) {
    case PROP_KIND_BUSH:
      return 'bush';
    case PROP_KIND_CRATE:
      return 'crate';
    case PROP_KIND_POST:
      return 'post';
    default:
      return 'tree';
  }
}

/**
 * One node's accepted props, as SoA arrays.
 *
 * Empty on a node with nothing in it, which is most of the world away from
 * forest and settlement. Positions are world metres; the mesh builder converts
 * to the node-local frame.
 */
export interface PropField {
  readonly centerX: Float64Array;
  readonly centerZ: Float64Array;
  /** Base altitude: `sampleHeight` at the centre. LOD-independent. */
  readonly baseY: Float64Array;
  /** Unit facing in XZ. Never derived from `sin`/`cos`. */
  readonly dirX: Float64Array;
  readonly dirZ: Float64Array;
  readonly scale: Float64Array;
  /** Palette pick in [0, 1]. */
  readonly tint: Float64Array;
  readonly kind: Uint8Array;
  /** Species / yard-role id (`SPECIES_*`). */
  readonly species: Uint8Array;
  readonly count: number;
}

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);

export function emptyPropField(): PropField {
  return {
    centerX: EMPTY_F64,
    centerZ: EMPTY_F64,
    baseY: EMPTY_F64,
    dirX: EMPTY_F64,
    dirZ: EMPTY_F64,
    scale: EMPTY_F64,
    tint: EMPTY_F64,
    kind: EMPTY_U8,
    species: EMPTY_U8,
    count: 0,
  };
}

interface PropAccumulator {
  readonly cx: number[];
  readonly cz: number[];
  readonly by: number[];
  readonly dx: number[];
  readonly dz: number[];
  readonly sc: number[];
  readonly tn: number[];
  readonly kd: number[];
  readonly sp: number[];
}

function finishProps(acc: PropAccumulator): PropField {
  const count = acc.cx.length;
  if (count === 0) return emptyPropField();
  return {
    centerX: Float64Array.from(acc.cx),
    centerZ: Float64Array.from(acc.cz),
    baseY: Float64Array.from(acc.by),
    dirX: Float64Array.from(acc.dx),
    dirZ: Float64Array.from(acc.dz),
    scale: Float64Array.from(acc.sc),
    tint: Float64Array.from(acc.tn),
    kind: Uint8Array.from(acc.kd),
    species: Uint8Array.from(acc.sp),
    count,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scratch = new Float64Array(2);

/** Unit facing from two independent hashes. Exact `sqrt` renormalisation only. */
function unitFacing(ax: number, az: number, worldSeed: number, salt: number): [number, number] {
  const u = hashUnit(hash3i(ax, az, worldSeed ^ salt)) * 2 - 1;
  const v = hashUnit(hash3i(ax, az, (worldSeed ^ salt) + 1)) * 2 - 1;
  const len = Math.sqrt(u * u + v * v);
  if (len <= 0) return [1, 0];
  return [u / len, v / len];
}

/**
 * Approximate slope (rise/run) at a point from four 1 m height samples.
 *
 * Not a stored normal -- only a gate -- so the samples may disagree slightly
 * with the mesh lattice without mattering.
 */
function groundSlope(x: number, z: number, worldSeed: number): number {
  const hE = sampleHeight(x + 1, z, worldSeed);
  const hW = sampleHeight(x - 1, z, worldSeed);
  const hN = sampleHeight(x, z + 1, worldSeed);
  const hS = sampleHeight(x, z - 1, worldSeed);
  const gx = (hE - hW) * 0.5;
  const gz = (hN - hS) * 0.5;
  return Math.sqrt(gx * gx + gz * gz);
}

/**
 * Metres of clear ground from the nearest street bed EDGE in one sector record,
 * or `Infinity` when the sector has no streets.
 */
function streetClearanceIn(rec: SectorStreets, x: number, z: number): number {
  if (rec.streetCount === 0) return Infinity;
  let best = Infinity;
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
      const clear = Math.sqrt(scratch[0] as number) - STREET_HALF_WIDTH;
      if (clear < best) best = clear;
    }
  }
  return best;
}

/**
 * Clearance from street beds across sectors that can reach `(x, z)`.
 *
 * A street plan exists only near settlements, so most of the world returns
 * Infinity after a cheap settlement-radius test on neighbouring sectors.
 */
function streetClearance(
  streets: SectorStreetField,
  x: number, z: number,
): number {
  const sx0 = Math.floor((x - STREET_HALF_WIDTH - PROP_STREET_CLEAR - 16) / SECTOR_SIZE);
  const sx1 = Math.floor((x + STREET_HALF_WIDTH + PROP_STREET_CLEAR + 16) / SECTOR_SIZE);
  const sz0 = Math.floor((z - STREET_HALF_WIDTH - PROP_STREET_CLEAR - 16) / SECTOR_SIZE);
  const sz1 = Math.floor((z + STREET_HALF_WIDTH + PROP_STREET_CLEAR + 16) / SECTOR_SIZE);
  let best = Infinity;
  for (let sz = sz0; sz <= sz1; sz++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const rec = streets.streetsAt(sx, sz);
      if (rec.settlement === undefined && rec.streetCount === 0) continue;
      const clear = streetClearanceIn(rec, x, z);
      if (clear < best) best = clear;
    }
  }
  return best;
}

/** True when `(x, z)` sits inside any nearby building's inflated bounding circle. */
function insideBuildingClearance(
  lots: SectorLotField,
  roads: RegionRoadField,
  x: number,
  z: number,
): boolean {
  const minX = x - LOT_MAX_EXTENT;
  const maxX = x + LOT_MAX_EXTENT;
  const minZ = z - LOT_MAX_EXTENT;
  const maxZ = z + LOT_MAX_EXTENT;
  const rx0 = Math.floor((minX - REGION_SEARCH_PAD) / REGION_SIZE);
  const rx1 = Math.floor((maxX + REGION_SEARCH_PAD) / REGION_SIZE);
  const rz0 = Math.floor((minZ - REGION_SEARCH_PAD) / REGION_SIZE);
  const rz1 = Math.floor((maxZ + REGION_SEARCH_PAD) / REGION_SIZE);
  const visited = new Set<string>();

  for (let rz = rz0; rz <= rz1; rz++) {
    for (let rx = rx0; rx <= rx1; rx++) {
      const net = roads.networkAt(
        rx * REGION_SIZE + REGION_SIZE / 2,
        rz * REGION_SIZE + REGION_SIZE / 2,
      );
      for (let i = 0; i < net.settlements.length; i++) {
        const s = net.settlements[i] as (typeof net.settlements)[number];
        if (s.x + LOT_MAX_EXTENT < minX || s.x - LOT_MAX_EXTENT > maxX) continue;
        if (s.z + LOT_MAX_EXTENT < minZ || s.z - LOT_MAX_EXTENT > maxZ) continue;
        const ssx = Math.floor(s.x / SECTOR_SIZE);
        const ssz = Math.floor(s.z / SECTOR_SIZE);
        const key = `${ssx},${ssz}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const rec = lots.lotsAt(ssx, ssz);
        for (let k = 0; k < rec.count; k++) {
          const dx = (rec.centerX[k] as number) - x;
          const dz = (rec.centerZ[k] as number) - z;
          const hw = rec.halfWidth[k] as number;
          const hd = rec.halfDepth[k] as number;
          const radius = Math.sqrt(hw * hw + hd * hd) + PROP_BUILDING_CLEAR;
          if (dx * dx + dz * dz < radius * radius) return true;
        }
      }
    }
  }
  return false;
}

function biomeCanGrow(x: number, z: number, worldSeed: number): number {
  const fields = biomeFields(x, z, worldSeed);
  if (fields.continentalness < PROP_MIN_CONTINENT) return 0;
  if (fields.humidity < PROP_MIN_HUMIDITY) return 0;
  if (fields.temperature < PROP_MIN_TEMPERATURE) return 0;
  // Denser where humid and mild; continentalness above the shelf boosts further.
  const hum = clamp((fields.humidity - PROP_MIN_HUMIDITY) / (1 - PROP_MIN_HUMIDITY), 0, 1);
  const temp =
    1 -
    Math.abs(fields.temperature - 0.55) / 0.55;
  const land = clamp((fields.continentalness - PROP_MIN_CONTINENT) / 0.6, 0, 1);
  return clamp(hum * clamp(temp, 0, 1) * (0.45 + 0.55 * land), 0, 1);
}

function clearOfInfrastructure(
  net: RoadNetwork,
  streets: SectorStreetField,
  lots: SectorLotField,
  roads: RegionRoadField,
  x: number,
  z: number,
): boolean {
  if (roadClearance(net, x, z) < PROP_ROAD_CLEAR) return false;
  if (streetClearance(streets, x, z) < PROP_STREET_CLEAR) return false;
  if (insideBuildingClearance(lots, roads, x, z)) return false;
  return true;
}


/**
 * Tree species: ~55% pine / ~45% broadleaf. Pure of (worldSeed, cell).
 */
export function pickTreeSpecies(worldSeed: number, cellX: number, cellZ: number): number {
  const bucket = Math.floor(hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_SPECIES_SALT)) * 100);
  return bucket < 55 ? SPECIES_PINE : SPECIES_BROADLEAF;
}

/**
 * Bush species: ~55% round / ~45% tall. Pure of (worldSeed, cell).
 */
export function pickBushSpecies(worldSeed: number, cellX: number, cellZ: number): number {
  const bucket = Math.floor(hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_SPECIES_SALT)) * 100);
  return bucket < 55 ? SPECIES_BUSH_ROUND : SPECIES_BUSH_TALL;
}

/**
 * Size-class bands from an existing [0,1] scale salt: sapling / adult / elder
 * within the kind's PROP_*_SCALE_MIN/MAX. Keeps vertex cost fixed; only scale changes.
 */
function sizeClassScale(min: number, max: number, u: number): number {
  const band = u < 1 / 3 ? 0 : u < 2 / 3 ? 1 : 2;
  const t = (band + 0.5) / 3;
  return lerp(min, max, t);
}

/**
 * Grove density factor for world props. Self grove blended with 4-neighbour
 * average so edges soften without changing the deterministic cell accept.
 */
function groveFactor(worldSeed: number, cellX: number, cellZ: number): number {
  const gx = Math.floor(cellX / CLUSTER_STRIDE);
  const gz = Math.floor(cellZ / CLUSTER_STRIDE);
  const self = hashUnit(hash3i(gx, gz, worldSeed ^ CLUSTER_SALT));
  const n0 = hashUnit(hash3i(gx - 1, gz, worldSeed ^ CLUSTER_SALT));
  const n1 = hashUnit(hash3i(gx + 1, gz, worldSeed ^ CLUSTER_SALT));
  const n2 = hashUnit(hash3i(gx, gz - 1, worldSeed ^ CLUSTER_SALT));
  const n3 = hashUnit(hash3i(gx, gz + 1, worldSeed ^ CLUSTER_SALT));
  const neigh = (n0 + n1 + n2 + n3) * 0.25;
  const grove = self * 0.5 + neigh * 0.5;
  return lerp(0.55, 1.35, grove);
}

function pushProp(
  acc: PropAccumulator,
  x: number,
  z: number,
  worldSeed: number,
  kind: PropKind,
  species: number,
  scale: number,
  tint: number,
  dirSalt: number,
  ax: number,
  az: number,
): void {
  if (acc.cx.length >= PROP_MAX_PER_NODE) return;
  const [dx, dz] = unitFacing(ax, az, worldSeed, dirSalt);
  acc.cx.push(x);
  acc.cz.push(z);
  acc.by.push(sampleHeight(x, z, worldSeed));
  acc.dx.push(dx);
  acc.dz.push(dz);
  acc.sc.push(scale);
  acc.tn.push(tint);
  acc.kd.push(propKindId(kind));
  acc.sp.push(species);
}

// ---------------------------------------------------------------------------
// World vegetation
// ---------------------------------------------------------------------------

function tryWorldProp(
  acc: PropAccumulator,
  cellX: number,
  cellZ: number,
  worldSeed: number,
  roads: RegionRoadField,
  streets: SectorStreetField,
  lots: SectorLotField,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): void {
  if (acc.cx.length >= PROP_MAX_PER_NODE) return;

  const jx = hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_JITTER_SALT));
  const jz = hashUnit(hash3i(cellX, cellZ, (worldSeed ^ CELL_JITTER_SALT) + 1));
  const x = (cellX + jx) * PROP_CELL;
  const z = (cellZ + jz) * PROP_CELL;

  // Ownership by centre: only the node whose square contains the centre emits.
  if (x < minX || x >= maxX || z < minZ || z >= maxZ) return;

  const grow = biomeCanGrow(x, z, worldSeed);
  if (grow <= 0) return;

  const threshold =
    PROP_ACCEPT_BASE * (0.35 + 0.65 * grow) * groveFactor(worldSeed, cellX, cellZ);
  const accept = hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_ACCEPT_SALT)) < threshold;
  if (!accept) return;

  const base = sampleHeight(x, z, worldSeed);
  if (base < SEA_LEVEL + PROP_SEA_MARGIN) return;
  if (groundSlope(x, z, worldSeed) > PROP_MAX_SLOPE) return;

  const net = roads.networkAt(x, z);
  // Dense world vegetation yields inside curtain walls. Sparse yard props are
  // placed later from lots, so a city can still contain authored clutter.
  for (const settlement of net.settlements) {
    if (!isCity(settlement)) continue;
    const cityX = x - settlement.x;
    const cityZ = z - settlement.z;
    if (cityX * cityX + cityZ * cityZ < settlement.wallRadius * settlement.wallRadius) return;
  }
  if (!clearOfInfrastructure(net, streets, lots, roads, x, z)) return;

  const kindRoll = hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_KIND_SALT));
  const kind: PropKind = kindRoll < PROP_BUSH_FRACTION ? 'bush' : 'tree';
  const species =
    kind === 'bush'
      ? pickBushSpecies(worldSeed, cellX, cellZ)
      : pickTreeSpecies(worldSeed, cellX, cellZ);
  const scaleU = hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_SCALE_SALT));
  const scale =
    kind === 'bush'
      ? sizeClassScale(PROP_BUSH_SCALE_MIN, PROP_BUSH_SCALE_MAX, scaleU)
      : sizeClassScale(PROP_TREE_SCALE_MIN, PROP_TREE_SCALE_MAX, scaleU);
  const tint = hashUnit(hash3i(cellX, cellZ, worldSeed ^ CELL_TINT_SALT));

  pushProp(acc, x, z, worldSeed, kind, species, scale, tint, CELL_DIR_SALT, cellX, cellZ);
}

// ---------------------------------------------------------------------------
// Yard props
// ---------------------------------------------------------------------------

function tryYardProps(
  acc: PropAccumulator,
  rec: SectorLots,
  worldSeed: number,
  roads: RegionRoadField,
  streets: SectorStreetField,
  lots: SectorLotField,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): void {
  if (rec.count === 0 || rec.settlement === undefined) return;

  for (let i = 0; i < rec.count && acc.cx.length < PROP_MAX_PER_NODE; i++) {
    const cx = rec.centerX[i] as number;
    const cz = rec.centerZ[i] as number;
    const alongX = rec.alongX[i] as number;
    const alongZ = rec.alongZ[i] as number;
    const acrossX = alongZ;
    const acrossZ = -alongX;
    const hw = rec.halfWidth[i] as number;
    const hd = rec.halfDepth[i] as number;

    for (let n = 0; n < YARD_CANDIDATES_PER_LOT; n++) {
      if (acc.cx.length >= PROP_MAX_PER_NODE) return;
      const index = i * YARD_CANDIDATES_PER_LOT + n;
      const accept = hashUnit(hash3i(rec.sectorX, rec.sectorZ, worldSeed ^ (YARD_ACCEPT_SALT + index)));
      // Sparse: roughly one in three candidates survives the roll.
      if (accept > 0.34) continue;

      const side = hashUnit(hash3i(rec.sectorX, rec.sectorZ, worldSeed ^ (YARD_SIDE_SALT + index))) * 2 - 1;
      const alongT = hashUnit(hash3i(rec.sectorX, index, worldSeed ^ YARD_SIDE_SALT)) * 2 - 1;
      // Sit just outside the footprint, on the pad side (back / flank).
      const back = hd + PROP_BUILDING_CLEAR + 1.2 + accept * 1.5;
      const x = cx + acrossX * back * (side >= 0 ? 1 : -1) + alongX * alongT * hw * 0.7;
      const z = cz + acrossZ * back * (side >= 0 ? 1 : -1) + alongZ * alongT * hw * 0.7;

      if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;

      const base = sampleHeight(x, z, worldSeed);
      if (base < SEA_LEVEL + PROP_SEA_MARGIN) continue;
      if (groundSlope(x, z, worldSeed) > PROP_MAX_SLOPE) continue;

      const net = roads.networkAt(x, z);
      if (!clearOfInfrastructure(net, streets, lots, roads, x, z)) continue;

      const kindRoll = hashUnit(hash3i(rec.sectorX, index, worldSeed ^ YARD_KIND_SALT));
      const kind: PropKind = kindRoll < 0.55 ? 'crate' : 'post';
      const species = kind === 'crate' ? SPECIES_CRATE : SPECIES_POST;
      void YARD_SPECIES_SALT;
      const scaleU = hashUnit(hash3i(rec.sectorX, index, worldSeed ^ YARD_SCALE_SALT));
      const scale =
        kind === 'crate'
          ? sizeClassScale(PROP_CRATE_SCALE_MIN, PROP_CRATE_SCALE_MAX, scaleU)
          : sizeClassScale(PROP_POST_SCALE_MIN, PROP_POST_SCALE_MAX, scaleU);
      const tint = hashUnit(hash3i(rec.sectorX, index, worldSeed ^ YARD_TINT_SALT));

      pushProp(acc, x, z, worldSeed, kind, species, scale, tint, YARD_DIR_SALT + index, rec.sectorX, index);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Collect every prop whose centre lies in this node.
 *
 * World vegetation first (lattice over the node square), then sparse yard props
 * from settlements in reach. Truncation at `PROP_MAX_PER_NODE` is deterministic.
 */
export function collectNodeProps(
  coord: ChunkCoord,
  worldSeed: number,
  roads: RegionRoadField,
  streets: SectorStreetField,
  lots: SectorLotField,
): PropField {
  const size = chunkSizeAt(coord.lod);
  const minX = coord.x * size;
  const minZ = coord.z * size;
  const maxX = minX + size;
  const maxZ = minZ + size;

  const acc: PropAccumulator = {
    cx: [],
    cz: [],
    by: [],
    dx: [],
    dz: [],
    sc: [],
    tn: [],
    kd: [],
    sp: [],
  };

  const cellMinX = Math.floor(minX / PROP_CELL) - 1;
  const cellMaxX = Math.floor(maxX / PROP_CELL) + 1;
  const cellMinZ = Math.floor(minZ / PROP_CELL) - 1;
  const cellMaxZ = Math.floor(maxZ / PROP_CELL) + 1;

  for (let cellZ = cellMinZ; cellZ <= cellMaxZ; cellZ++) {
    for (let cellX = cellMinX; cellX <= cellMaxX; cellX++) {
      tryWorldProp(
        acc,
        cellX,
        cellZ,
        worldSeed,
        roads,
        streets,
        lots,
        minX,
        minZ,
        maxX,
        maxZ,
      );
      if (acc.cx.length >= PROP_MAX_PER_NODE) return finishProps(acc);
    }
  }

  // Yard props: same region walk building-mesh uses for settlements.
  const rx0 = Math.floor((minX - REGION_SEARCH_PAD) / REGION_SIZE);
  const rx1 = Math.floor((maxX + REGION_SEARCH_PAD) / REGION_SIZE);
  const rz0 = Math.floor((minZ - REGION_SEARCH_PAD) / REGION_SIZE);
  const rz1 = Math.floor((maxZ + REGION_SEARCH_PAD) / REGION_SIZE);
  const visited = new Set<string>();

  for (let rz = rz0; rz <= rz1; rz++) {
    for (let rx = rx0; rx <= rx1; rx++) {
      const net = roads.networkAt(
        rx * REGION_SIZE + REGION_SIZE / 2,
        rz * REGION_SIZE + REGION_SIZE / 2,
      );
      for (let i = 0; i < net.settlements.length; i++) {
        const s = net.settlements[i] as (typeof net.settlements)[number];
        if (s.x + LOT_MAX_EXTENT < minX || s.x - LOT_MAX_EXTENT > maxX) continue;
        if (s.z + LOT_MAX_EXTENT < minZ || s.z - LOT_MAX_EXTENT > maxZ) continue;
        const ssx = Math.floor(s.x / SECTOR_SIZE);
        const ssz = Math.floor(s.z / SECTOR_SIZE);
        const key = `${ssx},${ssz}`;
        if (visited.has(key)) continue;
        visited.add(key);
        tryYardProps(
          acc,
          lots.lotsAt(ssx, ssz),
          worldSeed,
          roads,
          streets,
          lots,
          minX,
          minZ,
          maxX,
          maxZ,
        );
        if (acc.cx.length >= PROP_MAX_PER_NODE) return finishProps(acc);
      }
    }
  }

  return finishProps(acc);
}
