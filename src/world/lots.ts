/**
 * Lots: where a building stands, at the SECTOR tier.
 *
 * Phase 6. Phase 4b decided the streets of a settlement here; this decides what
 * fronts onto them. It is the second Sector-tier generator, and it stands in the
 * same relation to `streets.ts` that `roads.ts` stands in to `rivers.ts`: same
 * tier, one direction, the dependency passed as an ARGUMENT rather than reached
 * for through an import, so the graph stays acyclic and a test can drive it with
 * a synthetic street plan.
 *
 * ---------------------------------------------------------------------------
 * A LOT IS DECIDED HERE AND NOWHERE ELSE, AND THAT IS WHAT MAKES IT STABLE
 *
 * Everything a building IS -- its kind (cottage / barn / hall), its position,
 * its footprint, its facing, its height, the altitude of its floor -- is fixed
 * at this tier, from `(worldSeed, sector)` alone. `building-mesh.ts` places
 * geometry and decides nothing.
 *
 * That is a deliberate departure from Phase 5's deck, which is fitted per node
 * to that node's own rendered ground, and the reason is the difference between a
 * ribbon and an object. A deck is hundreds of metres long, so a lod-independent
 * one sinks into a coarse hillside and floats over a coarse valley -- it MUST
 * follow the lattice it is drawn against. A building is eight metres across: it
 * occupies about one lod-3 cell, so there is nothing to follow, and fitting its
 * floor to each node's lattice would instead make it JUMP vertically every time
 * the quadtree changed level under it. What varies per node is only how far its
 * plinth reaches down to meet the ground -- see `building-mesh.ts`.
 *
 * ---------------------------------------------------------------------------
 * A LOT IS REFUSED WHERE THE VILLAGE FAILED TO LEVEL THE GROUND
 *
 * The one test that matters, and it replaces a pile of separate ones. A building
 * is accepted only where the ground the world actually renders is within
 * `LOT_UNLEVEL_MAX` of the altitude everything grading that point AGREED on, and
 * where it varies by less than `LOT_SPREAD_MAX` across the footprint. Those two
 * numbers subsume, without naming any of them:
 *
 *  - a river running through the village. `grading.ts` yields completely inside
 *    a channel, so the ground is metres below the target and the lot is refused;
 *  - a hillside too steep for `ROAD_MAX_CUT` to bench, where the ground is
 *    clamped above the target;
 *  - the outer rim of a settlement where the pad's taper has run out;
 *  - anything a later phase does to the height field that stops a village being
 *    flat, which is the case a hand-written list of rejections would miss.
 *
 * It costs five evaluations of the full height stack per surviving candidate,
 * once per sector, behind a memo. That is affordable exactly because it is not
 * on the per-vertex path.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GROUND ARRIVES AS AN ARGUMENT
 *
 * `LotGround` is injected by `height-field.ts` and wraps the one composition
 * `sampleHeight` uses. This module could not import it -- `height-field.ts`
 * imports this one, which is what wires the tiers together -- and, more to the
 * point, a second implementation of "where is the ground" is the exact thing
 * that puts a building a metre under the grass. `RiverTerrain` and `RoadTerrain`
 * are injected for the same reason, and it has the same useful side effect: a
 * unit test can hand this module a flat plane and know the right answer.
 *
 * ---------------------------------------------------------------------------
 * NO TRIGONOMETRY
 *
 * A lot's position and facing decide where vertices go, so `Math.sin` and
 * `Math.cos` are out, per the note at the top of `noise.ts`. A building faces
 * along the street it fronts -- a direction already available as a normalised
 * segment vector -- and is turned off it by MIXING IN the perpendicular and
 * renormalising, which is exact division and one correctly-rounded `Math.sqrt`.
 */

import { hash3i } from '../core/hash';
import { createTierContext, SECTOR_SIZE, type SectorCoord, type TierContext } from './contracts';
import { closestOnSegment } from './grading';
import { clamp, hashUnit, lerp } from './noise';
import {
  roadClearance,
  type RegionRoadField,
  type RoadNetwork,
  type RoadTerrain,
  type Settlement,
} from './roads';
import { STREET_MAX_EXTENT, type SectorStreetField } from './streets';
import {
  cityPlanAt,
  isCity,
  LANDMARK_CATHEDRAL,
  LANDMARK_GATEHOUSE,
  LANDMARK_GUILD,
  LANDMARK_KEEP,
  LANDMARK_MARKET,
  LANDMARK_TOWNHALL,
} from './city';

// ---------------------------------------------------------------------------
// What this tier is allowed to read
// ---------------------------------------------------------------------------

/**
 * The Region-tier record, as the lot generator sees it.
 *
 * Declared structurally rather than imported from `height-field.ts`, for the
 * reason `StreetRegion` is: that module imports this one. `RegionField`
 * satisfies it by shape.
 */
export interface LotRegion {
  readonly roads: RegionRoadField;
}

/**
 * The ground, as the lot generator sees it: the final rendered surface and the
 * altitude everything grading a point agreed on.
 *
 * Both come from `height-field.ts`, which owns the one composition. `height` is
 * `sampleHeight`; `target` is `gradeTarget`, which is that same accumulation
 * stopped before the strength, the caps and the river yield are applied. The
 * difference between the two IS "how badly did the village fail to level this",
 * which is the only terrain question this module asks.
 */
export interface LotGround {
  height(x: number, z: number): number;
  target(x: number, z: number): number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres of street frontage per candidate station, before jitter.
 *
 * The spacing of the candidates, NOT of the buildings: most candidates are
 * refused, and the ones that survive are further apart than this. Halving it
 * does not double the village, it just makes the rejection tests work harder.
 */
export const LOT_FRONTAGE = 16;

/** City station spacing — tighter than villages so aerial packing reads. */
export const CITY_LOT_FRONTAGE = 4.95; // 2*2.4 + 0.15 abut pitch

/**
 * Metres between the edge of the street bed and the near wall of a building.
 *
 * This is where a lot is PLACED. `LOT_STREET_CLEAR` below is what a lot is
 * REJECTED for, and it is deliberately smaller -- see there.
 */
export const LOT_SETBACK = 3.2;

/** City buildings sit closer to the carriageway. */
export const CITY_LOT_SETBACK = 2.0;

/**
 * Metres of clear ground a building must keep from ANY street bed, including
 * the one it fronts.
 *
 * Smaller than `LOT_SETBACK` on purpose, and the gap between the two is what
 * stops a building being rejected by its own street. A lot placed at the setback
 * sits exactly `LOT_SETBACK` from the segment it was measured against, but at a
 * bend the ADJACENT segment is closer, by an amount that grows with the angle.
 * Testing against the setback itself would therefore delete every building on
 * the inside of every corner -- which is most of a ring. This threshold catches
 * a building standing on a DIFFERENT street, which is what the test is for.
 */
export const LOT_STREET_CLEAR = 1;
export const CITY_LOT_STREET_CLEAR = 0.4;

/** Metres of clear ground a building must keep from a Region-tier roadbed. */
export const LOT_ROAD_CLEAR = 1.5;

/** Metres between the bounding circles of two buildings. */
export const LOT_GAP = 2.5;

/** Clearance between city buildings (townhouse rhythm). */
export const CITY_LOT_GAP = 0.15;

/** Fraction of the settlement radius beyond which no lot is sited. */
export const LOT_RIM_FRACTION = 0.95;

/** Cities pack almost to the curtain. */
export const CITY_LOT_RIM_FRACTION = 0.99;

/**
 * Metres the rendered ground may sit from the altitude the village graded
 * toward, before a lot is refused. See the header: this one number is the river
 * test, the steep-hillside test and the outside-the-pad test.
 */
export const LOT_UNLEVEL_MAX = 1.75;

/** Metres the ground may vary across a footprint's four corners. */
export const LOT_SPREAD_MAX = 2.5;

/** Cities grade less perfectly at rim; slightly softer than village. */
export const CITY_LOT_UNLEVEL_MAX = 4.0;
export const CITY_LOT_SPREAD_MAX = 4.5;

/**
 * Hard cap on buildings in one sector.
 *
 * A SAFETY VALVE THAT SHOULD NEVER FIRE, in the spirit of `DECK_MAX_STATIONS`:
 * the largest settlement measured produces well under a hundred. It exists
 * because the alternative is an unbounded allocation inside a generator, and
 * truncation here is deterministic -- streets in CSR order, stations along each,
 * near side before far -- so a sector that hit it would still regenerate
 * byte-identically.
 */
export const LOT_MAX_BUILDINGS = 256;

/** Per-sector cap for cities — denser fabric legitimately exceeds 256. */
export const CITY_LOT_MAX_BUILDINGS = 2048;

/** Footprint, in metres. Width runs ALONG the frontage, depth back from it. */
/**
 * Building kinds. Chosen here; the mesh only reads them.
 *
 * Cottage is the majority (~62%) so a village still reads as houses from the
 * air; barn and hall share the rest so soak can find each without hunting.
 */
export const KIND_COTTAGE = 0;
export const KIND_BARN = 1;
export const KIND_HALL = 2;
export const KIND_TOWNHOUSE = 3;
export const KIND_GUILDHALL = 4;
export const KIND_WAREHOUSE = 5;
export const KIND_KEEP = 6;
export const KIND_CATHEDRAL = 7;
export const KIND_TOWNHALL = 8;
export const KIND_GATEHOUSE = 9;

/** Half-footprint ranges per kind, metres. The exported MAX below is the global cap. */
const COTTAGE_HALF_WIDTH = { min: 2.6, max: 4.8 };
const COTTAGE_HALF_DEPTH = { min: 2.2, max: 3.8 };
const TOWNHOUSE_HALF_WIDTH = { min: 2.4, max: 2.4 }; // exact abut on CITY_LOT_FRONTAGE
const TOWNHOUSE_HALF_DEPTH = { min: 4.0, max: 4.0 }; // fixed depth so city rows share walls
const WAREHOUSE_HALF_WIDTH = { min: 4.5, max: 7.0 };
const WAREHOUSE_HALF_DEPTH = { min: 5.0, max: 8.0 };
const GUILD_HALF_WIDTH = { min: 4.0, max: 6.5 };
const GUILD_HALF_DEPTH = { min: 4.5, max: 7.0 };
const BARN_HALF_WIDTH = { min: 4.5, max: 7.2 };
const BARN_HALF_DEPTH = { min: 3.5, max: 5.8 };
const HALL_HALF_WIDTH = { min: 3.5, max: 6.0 };
const HALL_HALF_DEPTH = { min: 3.0, max: 5.0 };

/** Global footprint caps -- used by `LOT_MAX_EXTENT` and rim shrink. */
export const BUILDING_HALF_WIDTH_MIN = COTTAGE_HALF_WIDTH.min;
export const BUILDING_HALF_WIDTH_MAX = BARN_HALF_WIDTH.max;
export const BUILDING_HALF_DEPTH_MIN = COTTAGE_HALF_DEPTH.min;
export const BUILDING_HALF_DEPTH_MAX = WAREHOUSE_HALF_DEPTH.max;

/** Metres from the floor to the eaves, and from the eaves to the ridge. */
const COTTAGE_EAVES = { min: 3.0, max: 5.2 };
const COTTAGE_RIDGE = { min: 1.5, max: 3.0 };
const TOWNHOUSE_EAVES = { min: 5.5, max: 8.0 };
const TOWNHOUSE_RIDGE = { min: 2.0, max: 3.5 };
const BARN_EAVES = { min: 3.5, max: 5.0 };
const BARN_RIDGE = { min: 2.0, max: 3.8 };
const HALL_EAVES = { min: 5.5, max: 8.5 };
const HALL_RIDGE = { min: 2.0, max: 3.5 };

export const BUILDING_EAVES_MIN = COTTAGE_EAVES.min;
export const BUILDING_EAVES_MAX = HALL_EAVES.max;
export const BUILDING_RIDGE_MIN = COTTAGE_RIDGE.min;
export const BUILDING_RIDGE_MAX = BARN_RIDGE.max;

/**
 * How far a building may turn off the street it fronts, as the fraction of the
 * perpendicular mixed into its facing before renormalising.
 *
 * Small, and it is the difference between a village and a caravan park. 0.12 is
 * about 7 degrees. It is a MIX rather than a rotation because a rotation needs
 * `Math.sin`; see the header.
 */
export const BUILDING_SKEW = 0.12;

/**
 * How much smaller a building on the rim is than one in the middle.
 *
 * Not decoration: it is what gives a settlement a legible centre from the air,
 * which is the thing `settlement-streets` shows and `settlement-footprint`
 * cannot. The core keeps the full size range and the rim loses a third of it.
 */
export const BUILDING_RIM_SHRINK = 0.34;

/**
 * Sector lot records held at once, per JS context.
 *
 * Much smaller than `STREET_CACHE_LIMIT` and for a stated reason rather than by
 * eye: a street plan is read PER VERTEX by the grading, so its working set is a
 * whole node's padded sample grid, 121 sectors at the root level. A lot record
 * is read once per NODE by the mesh builder, through the settlements the region
 * record already lists, so its working set is the number of settlements one node
 * can reach. The settlement lattice is 512 m with a strict 3x3 local-maximum
 * rule, so a 4 km node contains at most nine, and 64 covers several neighbouring
 * root nodes with room to spare.
 */
export const LOT_CACHE_LIMIT = 64;

/**
 * Salts, one per quantity.
 *
 * Distinct salts rather than distinct indices into one stream: a lot's width and
 * its depth are drawn from the same `(cell, index)` pair, and reusing a salt
 * would make every building in the world exactly as deep as it is wide.
 */
const STATION_SALT = 0x4c_6f_53_74;
const KIND_SALT = 0x4c_6f_4b_64;
const WIDTH_SALT = 0x4c_6f_57_64;
const DEPTH_SALT = 0x4c_6f_44_70;
const EAVES_SALT = 0x4c_6f_45_76;
const RIDGE_SALT = 0x4c_6f_52_67;
const WALL_SALT = 0x4c_6f_57_6c;
const ROOF_SALT = 0x4c_6f_52_66;
const SKEW_SALT = 0x4c_6f_53_6b;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * One sector's buildings.
 *
 * Empty on the overwhelming majority of sectors, exactly like `SectorStreets`,
 * and an empty record costs a handful of zero-length arrays.
 *
 * Everything is a typed array because this lives in a bounded cache in every
 * worker. Angles are stored as a unit direction pair rather than as a number of
 * radians, because nothing downstream may call `Math.cos` on the path to a
 * stored vertex.
 */
export interface SectorLots {
  readonly terrain: RoadTerrain;
  readonly worldSeed: number;
  readonly sectorX: number;
  readonly sectorZ: number;
  /** The settlement these buildings belong to, if this sector holds one. */
  readonly settlement: Settlement | undefined;
  /** Footprint centre, world metres. */
  readonly centerX: Float64Array;
  readonly centerZ: Float64Array;
  /**
   * Floor altitude, world metres: the ground `sampleHeight` reports at the
   * centre. LOD-INDEPENDENT, deliberately -- see the header.
   */
  readonly floorY: Float64Array;
  /** Unit facing: the direction the frontage runs, i.e. the building's width axis. */
  readonly alongX: Float64Array;
  readonly alongZ: Float64Array;
  /** Half the footprint, metres: `width` along the frontage, `depth` back from it. */
  readonly halfWidth: Float64Array;
  readonly halfDepth: Float64Array;
  /** Metres from floor to eaves, and from eaves to the ridge above them. */
  readonly eaves: Float64Array;
  readonly ridge: Float64Array;
  /** Two independent picks in [0, 1) for the wall and roof palettes. */
  readonly wallTint: Float64Array;
  readonly roofTint: Float64Array;
  /**
   * Building kind per lot (`KIND_COTTAGE` / `KIND_BARN` / `KIND_HALL`).
   * Decided here; `building-mesh.ts` only reads it.
   */
  readonly kind: Uint8Array;
  readonly count: number;
  /**
   * Distance from the settlement centre beyond which no building of this sector
   * can reach. Zero on an empty sector, and the first thing a query tests.
   */
  readonly reachRadius: number;
}

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);

function emptyLots(
  terrain: RoadTerrain,
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
): SectorLots {
  return {
    terrain,
    worldSeed,
    sectorX,
    sectorZ,
    settlement: undefined,
    centerX: EMPTY_F64,
    centerZ: EMPTY_F64,
    floorY: EMPTY_F64,
    alongX: EMPTY_F64,
    alongZ: EMPTY_F64,
    halfWidth: EMPTY_F64,
    halfDepth: EMPTY_F64,
    eaves: EMPTY_F64,
    ridge: EMPTY_F64,
    wallTint: EMPTY_F64,
    roofTint: EMPTY_F64,
    kind: EMPTY_U8,
    count: 0,
    reachRadius: 0,
  };
}

/** A unit value in [0, 1) for one settlement cell, one lot index and one salt. */
function unitAt(site: Settlement, index: number, worldSeed: number, salt: number): number {
  return hashUnit(hash3i(site.cellX, site.cellZ, index, (worldSeed ^ salt) >>> 0));
}

/**
 * Which building this lot is.
 *
 * Bucketed so cottage stays the majority (~62%) and barn / hall share the rest.
 * Pure function of `(worldSeed, settlement cell, lot index)` -- the mesh must
 * not re-roll this.
 */
export function pickBuildingKind(site: Settlement, index: number, worldSeed: number): number {
  const bucket = Math.floor(unitAt(site, index, worldSeed, KIND_SALT) * 100);
  if (isCity(site)) {
    // Continuous ribbons: civic kinds only via landmark reservations.
    return KIND_TOWNHOUSE;
  }
  if (bucket < 62) return KIND_COTTAGE;
  if (bucket < 84) return KIND_BARN;
  return KIND_HALL;
}

/**
 * The furthest a building of this sector can be from the settlement centre.
 *
 * Derived rather than typed in: a building stands a setback and a depth beyond
 * the street it fronts, a street reaches `STREET_MAX_EXTENT`, and the building's
 * own half-width can point outward from there.
 *
 * It has `STREET_MAX_EXTENT`'s obligation, one number larger. A settlement's
 * centre sits up to `SETTLEMENT_JITTER` from its cell centre, so a sector's lots
 * overhang its square by `SETTLEMENT_JITTER + LOT_MAX_EXTENT - SECTOR_SIZE / 2`,
 * and that has to stay under half a sector or a positional query would have to
 * read more than the four sectors nearest it. A unit test asserts the bound, and
 * asserts that no building in the real world exceeds this reach.
 */
export const LOT_MAX_EXTENT =
  STREET_MAX_EXTENT +
  LOT_SETBACK +
  2 * BUILDING_HALF_DEPTH_MAX +
  BUILDING_HALF_WIDTH_MAX;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Accumulates the accepted lots of one sector. */
interface LotAccumulator {
  readonly cx: number[];
  readonly cz: number[];
  readonly fy: number[];
  readonly ax: number[];
  readonly az: number[];
  readonly hw: number[];
  readonly hd: number[];
  readonly ev: number[];
  readonly rg: number[];
  readonly wt: number[];
  readonly rt: number[];
  readonly kd: number[];
  /** Bounding circle radius of each accepted building, for the overlap test. */
  readonly br: number[];
}

/** Squared distance from a point to the nearest street bed centreline. */
function nearestStreetDistanceSq(
  nodeX: ArrayLike<number>,
  nodeZ: ArrayLike<number>,
  streetStart: ArrayLike<number>,
  streetCount: number,
  x: number,
  z: number,
  out: Float64Array,
): number {
  let best = Infinity;
  for (let s = 0; s < streetCount; s++) {
    const from = streetStart[s] as number;
    const to = streetStart[s + 1] as number;
    for (let i = from; i + 1 < to; i++) {
      closestOnSegment(
        x,
        z,
        nodeX[i] as number,
        nodeZ[i] as number,
        nodeX[i + 1] as number,
        nodeZ[i + 1] as number,
        out,
      );
      const d = out[0] as number;
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Lay out the buildings of one sector.
 *
 * RULE 3 IS ENFORCED BY THE ARGUMENT LIST, exactly as it is in
 * `generateSectorStreets`: `context` is a SECTOR context, so `coarser('region')`
 * is legal and `coarser('sector')` throws. The street plan is a SECTOR-tier
 * input and therefore arrives as an argument rather than through the context --
 * the same shape `generateRegionRoads` uses for the river field it reads.
 *
 * Prefer `sectorLots`, which memoises this.
 */
export function generateSectorLots(
  coord: SectorCoord,
  context: TierContext,
  streets: SectorStreetField,
  ground: LotGround,
): SectorLots {
  if (context.tier !== 'sector') {
    throw new Error(`generateSectorLots needs a 'sector' TierContext, got '${context.tier}'`);
  }
  const region = context.coarser<LotRegion>('region');
  if (region === undefined || region.roads === undefined) {
    throw new Error(
      'generateSectorLots needs the Region-tier road record on its TierContext. ' +
        'Build the context with sectorLotField(...) or createTierContext(seed, ' +
        "'sector', { region }).",
    );
  }
  const worldSeed = context.worldSeed;
  const terrain = region.roads.terrain;

  const rec = streets.streetsAt(coord.x, coord.z);
  const site = rec.settlement;
  if (site === undefined) return emptyLots(terrain, worldSeed, coord.x, coord.z);

  // One network, and it is the settlement's own -- the same argument
  // `streets.ts` makes: a sector lies inside one region, and the region holding
  // a settlement has routed every road incident to it.
  const net = region.roads.networkAt(site.x, site.z);

  const lots: LotAccumulator = {
    cx: [], cz: [], fy: [], ax: [], az: [], hw: [], hd: [], ev: [], rg: [], wt: [], rt: [], kd: [], br: [],
  };
  const scratch = new Float64Array(2);

  // Landmark lots are Region-owned reservations. The sector containing each
  // landmark centre emits it first, so random frontage lots collide with and
  // yield to the reserved footprint.
  if (isCity(site)) {
    const plan = cityPlanAt(site, worldSeed);
    if (plan !== undefined) {
      const minX = coord.x * 512;
      const minZ = coord.z * 512;
      for (let landmark = 0; landmark < plan.landmarkCount; landmark++) {
        const x = plan.landmarkX[landmark] as number;
        const z = plan.landmarkZ[landmark] as number;
        if (x < minX || x >= minX + 512 || z < minZ || z >= minZ + 512) continue;
        const landmarkKind = plan.landmarkKind[landmark] as number;
        if (landmarkKind === LANDMARK_MARKET) continue;
        const kind =
          landmarkKind === LANDMARK_KEEP ? KIND_KEEP :
          landmarkKind === LANDMARK_CATHEDRAL ? KIND_CATHEDRAL :
          landmarkKind === LANDMARK_TOWNHALL ? KIND_TOWNHALL :
          landmarkKind === LANDMARK_GATEHOUSE ? KIND_GATEHOUSE :
          landmarkKind === LANDMARK_GUILD ? KIND_GUILDHALL : KIND_TOWNHOUSE;
        const planHalfW = plan.landmarkHalfW[landmark] as number;
        const planHalfD = plan.landmarkHalfD[landmark] as number;
        const hw = kind === KIND_KEEP ? Math.max(17, planHalfW) : planHalfW;
        const hd = kind === KIND_KEEP ? Math.max(17, planHalfD) :
          kind === KIND_CATHEDRAL ? Math.max(22, planHalfD) : planHalfD;
        lots.cx.push(x); lots.cz.push(z); lots.fy.push(ground.height(x, z));
        // Gatehouses face along the curtain so twin towers flank the opening;
        // other landmarks keep the historical +X along axis.
        let alongX = 1;
        let alongZ = 0;
        if (kind === KIND_GATEHOUSE) {
          for (let g = 0; g < plan.gateCount; g++) {
            const gi = plan.gateIndex[g] as number;
            const gx = plan.wallX[gi] as number;
            const gz = plan.wallZ[gi] as number;
            if (Math.abs(gx - x) + Math.abs(gz - z) > 0.05) continue;
            const prev = gi === 0 ? plan.wallCount - 2 : gi - 1;
            const next = gi + 1;
            let tx = (plan.wallX[next] as number) - (plan.wallX[prev] as number);
            let tz = (plan.wallZ[next] as number) - (plan.wallZ[prev] as number);
            const tlen = Math.sqrt(tx * tx + tz * tz);
            if (tlen > 0.01) {
              alongX = tx / tlen;
              alongZ = tz / tlen;
            }
            break;
          }
        }
        lots.ax.push(alongX); lots.az.push(alongZ); lots.hw.push(hw); lots.hd.push(hd);
        lots.ev.push(kind === KIND_KEEP ? 14 : kind === KIND_CATHEDRAL ? 16 : 8);
        lots.rg.push(kind === KIND_KEEP ? 7 : kind === KIND_CATHEDRAL ? 9 : 5);
        lots.wt.push(unitAt(site, 10_000 + landmark, worldSeed, WALL_SALT));
        lots.rt.push(unitAt(site, 10_000 + landmark, worldSeed, ROOF_SALT));
        lots.kd.push(kind);
        lots.br.push(Math.sqrt(hw * hw + hd * hd));
      }
    }
  }

  const rimRadius = site.radius * (isCity(site) ? CITY_LOT_RIM_FRACTION : LOT_RIM_FRACTION);
  const streetHalf = rec.halfWidth;
  const frontage = isCity(site) ? CITY_LOT_FRONTAGE : LOT_FRONTAGE;
  const maxBuildings = isCity(site) ? CITY_LOT_MAX_BUILDINGS : LOT_MAX_BUILDINGS;
  let index = 0;
  let emitted = lots.cx.length; // landmarks already in-sector

  // City lots walk the Region-owned CityPlan, not the sector-clipped street
  // fragments. Clipped polylines restart station phase at every CSR joint and
  // punch one-pitch holes in townhouse ribbons. Ownership is by lot centre:
  // each sector accepts only buildings whose centre lands in its square, so
  // the same plan walk in every overlapping sector stays byte-identical.
  const cityPlan = isCity(site) ? cityPlanAt(site, worldSeed) : undefined;
  const sectorMinX = coord.x * SECTOR_SIZE;
  const sectorMinZ = coord.z * SECTOR_SIZE;
  const sectorMaxX = sectorMinX + SECTOR_SIZE;
  const sectorMaxZ = sectorMinZ + SECTOR_SIZE;
  const streetNodeX = cityPlan !== undefined ? cityPlan.nodeX : rec.nodeX;
  const streetNodeZ = cityPlan !== undefined ? cityPlan.nodeZ : rec.nodeZ;
  const streetStarts = cityPlan !== undefined ? cityPlan.streetStart : rec.streetStart;
  const streetCount = cityPlan !== undefined ? cityPlan.streetCount : rec.streetCount;

  for (let s = 0; s < streetCount && emitted < maxBuildings; s++) {
    const from = streetStarts[s] as number;
    const to = streetStarts[s + 1] as number;
    if (to - from < 2) continue;

    // Stations are spaced along the WHOLE polyline rather than per segment, so
    // they do not cluster at every joint of a ring the way a per-segment walk
    // would. The first is offset by a jittered fraction of one spacing, so two
    // streets meeting at a node do not both start a building at the junction.
    let travelled = 0;
    let next = isCity(site) ? frontage * 0.5 : frontage * (0.3 + 0.4 * unitAt(site, s, worldSeed, STATION_SALT));

    for (let i = from; i + 1 < to && emitted < maxBuildings; i++) {
      const ax = streetNodeX[i] as number;
      const az = streetNodeZ[i] as number;
      const bx = streetNodeX[i + 1] as number;
      const bz = streetNodeZ[i + 1] as number;
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length <= 0) continue;
      const dirX = dx / length;
      const dirZ = dz / length;

      while (next <= travelled + length && emitted < maxBuildings) {
        const t = (next - travelled) / length;
        const stationX = ax + dx * t;
        const stationZ = az + dz * t;
        // Both sides of the street, left before right. A FIXED ORDER is what
        // makes the overlap test below -- which depends on what has been
        // accepted so far -- a deterministic function of the seed rather than of
        // the order the arrays happened to be walked in.
        for (let side = -1; side <= 1; side += 2) {
          if (emitted >= maxBuildings) break;
          const before = lots.cx.length;
          tryLot(
            lots,
            index++,
            site,
            streetNodeX,
            streetNodeZ,
            streetStarts,
            streetCount,
            net,
            ground,
            worldSeed,
            stationX,
            stationZ,
            dirX,
            dirZ,
            side,
            streetHalf,
            rimRadius,
            scratch,
            0,
            cityPlan !== undefined ? sectorMinX : undefined,
            cityPlan !== undefined ? sectorMinZ : undefined,
            cityPlan !== undefined ? sectorMaxX : undefined,
            cityPlan !== undefined ? sectorMaxZ : undefined,
          );
          if (lots.cx.length > before && (lots.ev[lots.ev.length - 1] as number) >= 0) emitted++;
          // City second row fills block depth so aerial/market FOV is not lawn cores.
          if (isCity(site) && emitted < maxBuildings) {
            const before2 = lots.cx.length;
            tryLot(
              lots,
              index++,
              site,
              streetNodeX,
              streetNodeZ,
              streetStarts,
              streetCount,
              net,
              ground,
              worldSeed,
              stationX,
              stationZ,
              dirX,
              dirZ,
              side,
              streetHalf,
              rimRadius,
              scratch,
              1,
              sectorMinX,
              sectorMinZ,
              sectorMaxX,
              sectorMaxZ,
            );
            if (lots.cx.length > before2 && (lots.ev[lots.ev.length - 1] as number) >= 0) emitted++;
          }
        }
        next += isCity(site) ? frontage : frontage * (0.75 + 0.5 * unitAt(site, index, worldSeed, STATION_SALT));
      }
      travelled += length;
    }
  }

  const count = lots.cx.length;
  const emitIdx: number[] = [];
  for (let i = 0; i < count; i++) {
    if ((lots.ev[i] as number) >= 0) emitIdx.push(i);
  }
  const emitCount = emitIdx.length;
  const centerX = new Float64Array(emitCount);
  const centerZ = new Float64Array(emitCount);
  const floorY = new Float64Array(emitCount);
  const alongX = new Float64Array(emitCount);
  const alongZ = new Float64Array(emitCount);
  const halfWidth = new Float64Array(emitCount);
  const halfDepth = new Float64Array(emitCount);
  const eaves = new Float64Array(emitCount);
  const ridge = new Float64Array(emitCount);
  const wallTint = new Float64Array(emitCount);
  const roofTint = new Float64Array(emitCount);
  const kind = new Uint8Array(emitCount);
  let reachSq = 0;
  for (let e = 0; e < emitCount; e++) {
    const i = emitIdx[e] as number;
    centerX[e] = lots.cx[i] as number;
    centerZ[e] = lots.cz[i] as number;
    floorY[e] = lots.fy[i] as number;
    alongX[e] = lots.ax[i] as number;
    alongZ[e] = lots.az[i] as number;
    halfWidth[e] = lots.hw[i] as number;
    halfDepth[e] = lots.hd[i] as number;
    eaves[e] = lots.ev[i] as number;
    ridge[e] = lots.rg[i] as number;
    wallTint[e] = lots.wt[i] as number;
    roofTint[e] = lots.rt[i] as number;
    kind[e] = lots.kd[i] as number;
    const dx = centerX[e]! - site.x;
    const dz = centerZ[e]! - site.z;
    const d = Math.sqrt(dx * dx + dz * dz) + (lots.br[i] as number);
    if (d * d > reachSq) reachSq = d * d;
  }

  return {
    terrain,
    worldSeed,
    sectorX: coord.x,
    sectorZ: coord.z,
    settlement: site,
    centerX,
    centerZ,
    floorY,
    alongX,
    alongZ,
    halfWidth,
    halfDepth,
    eaves,
    ridge,
    wallTint,
    roofTint,
    kind,
    count: emitCount,
    reachRadius: Math.sqrt(reachSq),
  };
}

/**
 * Test one candidate and append it if it survives.
 *
 * The tests run cheapest first, which is not a micro-optimisation: the last one
 * evaluates the whole height stack five times, and the geometric tests reject
 * most candidates before it is reached.
 */
function tryLot(
  lots: LotAccumulator,
  index: number,
  site: Settlement,
  streetNodeX: ArrayLike<number>,
  streetNodeZ: ArrayLike<number>,
  streetStarts: ArrayLike<number>,
  streetCount: number,
  net: RoadNetwork,
  ground: LotGround,
  worldSeed: number,
  stationX: number,
  stationZ: number,
  dirX: number,
  dirZ: number,
  side: number,
  streetHalf: number,
  rimRadius: number,
  scratch: Float64Array,
  row = 0,
  sectorMinX?: number,
  sectorMinZ?: number,
  sectorMaxX?: number,
  sectorMaxZ?: number,
): void {
  // -- kind, then size from the seed and how central the frontage is ----------
  const kind = pickBuildingKind(site, index, worldSeed);
  const stationDistance = Math.sqrt(
    (stationX - site.x) * (stationX - site.x) + (stationZ - site.z) * (stationZ - site.z),
  );
  const central = site.radius > 0 ? clamp(1 - stationDistance / site.radius, 0, 1) : 1;
  const scale = isCity(site) ? 1 : 1 - BUILDING_RIM_SHRINK * (1 - central);

  const widthRange =
    kind === KIND_BARN ? BARN_HALF_WIDTH :
    kind === KIND_HALL ? HALL_HALF_WIDTH :
    kind === KIND_TOWNHOUSE ? TOWNHOUSE_HALF_WIDTH :
    kind === KIND_WAREHOUSE ? WAREHOUSE_HALF_WIDTH :
    kind === KIND_GUILDHALL ? GUILD_HALF_WIDTH :
    COTTAGE_HALF_WIDTH;
  const depthRange =
    kind === KIND_BARN ? BARN_HALF_DEPTH :
    kind === KIND_HALL ? HALL_HALF_DEPTH :
    kind === KIND_TOWNHOUSE ? TOWNHOUSE_HALF_DEPTH :
    kind === KIND_WAREHOUSE ? WAREHOUSE_HALF_DEPTH :
    kind === KIND_GUILDHALL ? GUILD_HALF_DEPTH :
    COTTAGE_HALF_DEPTH;
  const eavesRange =
    kind === KIND_BARN ? BARN_EAVES :
    kind === KIND_HALL ? HALL_EAVES :
    kind === KIND_TOWNHOUSE || kind === KIND_WAREHOUSE || kind === KIND_GUILDHALL ? TOWNHOUSE_EAVES :
    COTTAGE_EAVES;
  const ridgeRange =
    kind === KIND_BARN ? BARN_RIDGE :
    kind === KIND_HALL ? HALL_RIDGE :
    kind === KIND_TOWNHOUSE || kind === KIND_WAREHOUSE || kind === KIND_GUILDHALL ? TOWNHOUSE_RIDGE :
    COTTAGE_RIDGE;

  let halfWidth =
    lerp(widthRange.min, widthRange.max, unitAt(site, index, worldSeed, WIDTH_SALT)) * scale;
  let halfDepth =
    lerp(depthRange.min, depthRange.max, unitAt(site, index, worldSeed, DEPTH_SALT)) * scale;
  // City townhouses lock width to the station pitch so accepted lots abut.
  if (isCity(site) && kind === KIND_TOWNHOUSE) {
    halfWidth = CITY_LOT_FRONTAGE * 0.5 - CITY_LOT_GAP * 0.5;
  }
  const boundingRadius = Math.sqrt(halfWidth * halfWidth + halfDepth * halfDepth);

  // -- where it stands --------------------------------------------------------
  const normalX = -dirZ * side;
  const normalZ = dirX * side;
  const setback = isCity(site) ? CITY_LOT_SETBACK : LOT_SETBACK;
  const gapNow = isCity(site) ? CITY_LOT_GAP : LOT_GAP;
  const offset = streetHalf + setback + halfDepth + row * (halfDepth * 2 + gapNow + 0.2);
  const centerX = stationX + normalX * offset;
  const centerZ = stationZ + normalZ * offset;

  // City multi-sector: skip candidates far from this sector. Near-but-outside
  // centres still run the accept path into the overlap shadow so boundary
  // ribbons do not double-emit or ignore a neighbour across the CSR cut.
  const CITY_SHADOW_M = 64;
  let emitLot = true;
  if (sectorMinX !== undefined && sectorMinZ !== undefined && sectorMaxX !== undefined && sectorMaxZ !== undefined) {
    const inSector =
      centerX >= sectorMinX && centerX < sectorMaxX &&
      centerZ >= sectorMinZ && centerZ < sectorMaxZ;
    const inMargin =
      centerX >= sectorMinX - CITY_SHADOW_M && centerX < sectorMaxX + CITY_SHADOW_M &&
      centerZ >= sectorMinZ - CITY_SHADOW_M && centerZ < sectorMaxZ + CITY_SHADOW_M;
    if (!inMargin) return;
    emitLot = inSector;
  }

  // Inside the footprint. A building past the rim stands where the pad's taper
  // has run out, and the level test below would refuse it anyway -- this is the
  // cheap version of the same statement.
  const dx = centerX - site.x;
  const dz = centerZ - site.z;
  if (dx * dx + dz * dz > rimRadius * rimRadius) return;

  // Clear of every street, including the one it fronts. See `LOT_STREET_CLEAR`
  // for why the threshold is not the setback.
  const distSq = nearestStreetDistanceSq(
    streetNodeX,
    streetNodeZ,
    streetStarts,
    streetCount,
    centerX,
    centerZ,
    scratch,
  );
  if (isCity(site) && kind === KIND_TOWNHOUSE) {
    // Dense polar grids make the village "clear of ANY street" test delete
    // ribbon stations that sit legally on their own frontage; only refuse if
    // the centre is still inside the carriageway.
    if (distSq < streetHalf * streetHalf) return;
  } else {
    const clearOfStreet = streetHalf + halfDepth + (isCity(site) ? CITY_LOT_STREET_CLEAR : LOT_STREET_CLEAR);
    if (distSq < clearOfStreet * clearOfStreet) return;
  }

  // Clear of the carriageway. `roadClearance` measures from the roadbed EDGE and
  // is exact well inside `ROAD_CLEARANCE_RANGE`, which this threshold is.
  if (!(isCity(site) && kind === KIND_TOWNHOUSE)) {
    if (roadClearance(net, centerX, centerZ) < boundingRadius + LOT_ROAD_CLEAR) return;
  }

  // Clear of every building already accepted. Bounding circles, because two
  // rectangles at arbitrary bearings need a separating-axis test to answer the
  // same question and the extra precision would buy nothing but denser villages.
  const gap = isCity(site) ? CITY_LOT_GAP : LOT_GAP;
  // City packing: axis-aligned in the street frame so abutting townhouses are not
  // rejected by diagonal bounding circles (which dwarfed CITY_LOT_GAP).
  if (isCity(site)) {
    const nX = normalX;
    const nZ = normalZ;
    const aX = dirX;
    const aZ = dirZ;
    // Epsilon so station-pitch neighbours (dAlong ≈ needAlong) are not refused
    // by float noise on the polyline walk — that punched one-lot ribbon holes.
    const eps = 0.05;
    for (let i = 0; i < lots.cx.length; i++) {
      const ox = (lots.cx[i] as number) - centerX;
      const oz = (lots.cz[i] as number) - centerZ;
      const dAlong = ox * aX + oz * aZ;
      const dAcross = ox * nX + oz * nZ;
      const needAlong = halfWidth + (lots.hw[i] as number) + gap;
      const needAcross = halfDepth + (lots.hd[i] as number) + gap;
      if (
        dAlong < needAlong - eps && dAlong > -(needAlong - eps) &&
        dAcross < needAcross - eps && dAcross > -(needAcross - eps)
      ) {
        return;
      }
    }
  } else {
    for (let i = 0; i < lots.cx.length; i++) {
      const ox = (lots.cx[i] as number) - centerX;
      const oz = (lots.cz[i] as number) - centerZ;
      const need = boundingRadius + (lots.br[i] as number) + gap;
      if (ox * ox + oz * oz < need * need) return;
    }
  }

  // -- the facing, turned slightly off the street -----------------------------
  const skew = isCity(site) ? 0 : BUILDING_SKEW * (unitAt(site, index, worldSeed, SKEW_SALT) * 2 - 1);
  const mixX = dirX + normalX * skew;
  const mixZ = dirZ + normalZ * skew;
  const mixLength = Math.sqrt(mixX * mixX + mixZ * mixZ);
  if (mixLength <= 0) return;
  const alongX = mixX / mixLength;
  const alongZ = mixZ / mixLength;

  // -- the ground, which is the test that actually refuses things -------------
  const floor = ground.height(centerX, centerZ);
  const target = ground.target(centerX, centerZ);
  // City townhouse ribbons prioritize continuous frontage over village-grade
  // pad flatness; other city kinds and villages still take the level tests.
  const skipLevel = isCity(site) && kind === KIND_TOWNHOUSE;
  if (
    !skipLevel &&
    !(Math.abs(floor - target) <= (isCity(site) ? CITY_LOT_UNLEVEL_MAX : LOT_UNLEVEL_MAX))
  ) {
    return;
  }

  const acrossX = -alongZ;
  const acrossZ = alongX;
  let low = floor;
  let high = floor;
  for (let cornerU = -1; cornerU <= 1; cornerU += 2) {
    for (let cornerV = -1; cornerV <= 1; cornerV += 2) {
      const cx = centerX + alongX * halfWidth * cornerU + acrossX * halfDepth * cornerV;
      const cz = centerZ + alongZ * halfWidth * cornerU + acrossZ * halfDepth * cornerV;
      const h = ground.height(cx, cz);
      if (h < low) low = h;
      if (h > high) high = h;
    }
  }
  if (!skipLevel && high - low > (isCity(site) ? CITY_LOT_SPREAD_MAX : LOT_SPREAD_MAX)) return;

  // Always record into the accumulator for overlap (city shadow neighbours).
  // Emit only when the centre is owned by this sector.
  lots.cx.push(centerX);
  lots.cz.push(centerZ);
  lots.fy.push(floor);
  lots.ax.push(alongX);
  lots.az.push(alongZ);
  lots.hw.push(halfWidth);
  lots.hd.push(halfDepth);
  lots.ev.push(
    lerp(eavesRange.min, eavesRange.max, unitAt(site, index, worldSeed, EAVES_SALT)) * scale,
  );
  lots.rg.push(
    lerp(ridgeRange.min, ridgeRange.max, unitAt(site, index, worldSeed, RIDGE_SALT)) * scale,
  );
  lots.wt.push(unitAt(site, index, worldSeed, WALL_SALT));
  lots.rt.push(unitAt(site, index, worldSeed, ROOF_SALT));
  lots.kd.push(kind);
  lots.br.push(boundingRadius);
  if (!emitLot) {
    // Shadow-only: keep for overlap, strip from the emitted record by marking
    // kind as a tombstone consumed at finish. Cheaper than dual arrays: filter
    // tombstones when packing the typed arrays below would need a second pass
    // marker — use negative eaves as the out-of-sector flag.
    lots.ev[lots.ev.length - 1] = -1;
  }
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

const cache: SectorLots[] = [];
let cacheBuilds = 0;

/** Diagnostics for tests and the HUD. Not part of any determinism claim. */
export function lotCacheStats(): { entries: number; limit: number; builds: number } {
  return { entries: cache.length, limit: LOT_CACHE_LIMIT, builds: cacheBuilds };
}

export function clearLotCache(): void {
  cache.length = 0;
}

/**
 * The lots of one sector, memoised.
 *
 * The same shape as `sectorStreets`: a linear scan, `terrain` compared by
 * REFERENCE, promotion by swapping with the entry in front rather than
 * splice-and-unshift.
 */
export function sectorLots(
  region: LotRegion,
  streets: SectorStreetField,
  ground: LotGround,
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
): SectorLots {
  const seed = worldSeed >>> 0;
  const terrain = region.roads.terrain;
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i] as SectorLots;
    if (
      entry.sectorX === sectorX &&
      entry.sectorZ === sectorZ &&
      entry.worldSeed === seed &&
      entry.terrain === terrain
    ) {
      if (i > 0) {
        cache[i] = cache[i - 1] as SectorLots;
        cache[i - 1] = entry;
      }
      return entry;
    }
  }

  const built = generateSectorLots(
    { x: sectorX, z: sectorZ },
    createTierContext(seed, 'sector', { region }),
    streets,
    ground,
  );
  cacheBuilds++;
  cache.unshift(built);
  if (cache.length > LOT_CACHE_LIMIT) cache.length = LOT_CACHE_LIMIT;
  return built;
}

/**
 * The sector-tier lot record a chunk generator reads.
 *
 * There is no `accumulate` here and there is deliberately never going to be one:
 * a building does not grade the ground. Everything before Phase 6 that stood on
 * the terrain moved it -- a river carves, a road benches, a street holds an
 * altitude -- and a building instead READS the altitude a village already
 * levelled and stands on it. That is what makes this phase purely additive: not
 * one terrain vertex in the world moves, so every canonical view that does not
 * contain a building is byte-identical to Phase 5's.
 */
export interface SectorLotField {
  readonly worldSeed: number;
  /** The lots of one sector, by sector coordinate. */
  lotsAt(sectorX: number, sectorZ: number): SectorLots;
}

/** Bind a region record, a street field and a ground sampler into the lot record. */
export function sectorLotField(
  region: LotRegion,
  streets: SectorStreetField,
  ground: LotGround,
  worldSeed: number,
): SectorLotField {
  const seed = worldSeed >>> 0;
  return {
    worldSeed: seed,
    lotsAt: (sectorX, sectorZ) => sectorLots(region, streets, ground, seed, sectorX, sectorZ),
  };
}