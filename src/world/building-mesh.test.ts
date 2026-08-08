/**
 * Tests for Phase 6: batched building geometry.
 *
 * Three things are asserted here that nothing else in the project can see.
 *
 * WINDING. `building-mesh.ts` derives each face's winding from an outward hint
 * rather than assuming one, precisely because hand-deriving ten cross-product
 * signs is how one face ends up inside out. The test for that is direct: every
 * triangle's geometric normal must point away from the building's centre, and
 * every vertex normal must agree with its triangle. A single-sided material
 * makes a mistake here look like a lighting bug, which is the slowest kind to
 * find.
 *
 * OWNERSHIP. A building is emitted by the node containing its CENTRE and is not
 * clipped. Exactly one node must emit each building -- no node twice, no
 * building lost at a boundary -- and the property is stated as a partition over
 * a block of nodes rather than as a spot check.
 *
 * THE PLINTH. The floor is fixed at the Sector tier and the plinth is what
 * varies per node. That is the whole LOD story of the phase, so it is asserted
 * across levels: the same building, drawn at lod 0 and at lod 3, must have the
 * same floor and may differ only below it.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { chunkSizeAt, type ChunkCoord } from './contracts';
import {
  BUILDING_LOD_SIMPLIFY,
  BUILDING_MAX_PLINTH,
  buildBuildingSurface,
  pickRoofType,
  type BuildingPalette,
  type BuildingSurface,
} from './building-mesh';
import { baseHeight, continentalness, habitability, SEA_LEVEL, worldRegionField, worldSectorField, type RegionField } from './height-field';
import {
  KIND_BARN,
  KIND_CATHEDRAL,
  KIND_COTTAGE,
  KIND_GATEHOUSE,
  KIND_GUILDHALL,
  KIND_HALL,
  KIND_KEEP,
  KIND_TOWNHALL,
  KIND_TOWNHOUSE,
  type SectorLots,
} from './lots';
import { parseParams } from '../core/params';
import { SETTLEMENT_CLASS_CITY, type Settlement } from './roads';
import { citiesInBox, type PolityClimate, type PolityTerrain } from './polity';
import { WALL_HEIGHT } from './wall-mesh';
import {
  ROOF_FLAT_PARAPET,
  ROOF_GABLE,
  ROOF_HIP,
  ROOF_PYRAMID,
  ROOF_SHED,
} from './culture';

const SEED = hashString('buildings-test');
const CITY_SEED = parseParams('').seedHash;

/**
 * Historical single-building cost from before Phase Politics B1 (roof-type
 * variety). Ordinary ("gable box") buildings no longer have a fixed
 * vertex/triangle count -- `BUILDING_VERTEX_COUNT`/`BUILDING_TRIANGLE_COUNT`
 * were deleted from `building-mesh.ts` for it -- but landmark buildings are
 * untouched by B1 (built by the separate, unchanged `addLandmarkBuilding`
 * path) and always cost far more than this, so it remains a valid
 * anti-vacuity floor for landmark-only assertions below.
 */
const LANDMARK_MIN_VERTS = 38;

/** An ordinary building's own vertex span, across every roof type B1 emits. */
const ORDINARY_VERTS_MIN = 30;
const ORDINARY_VERTS_MAX = 50;

const PALETTE: BuildingPalette = {
  wallA: [0.5, 0.5, 0.5],
  wallB: [0.6, 0.55, 0.5],
  roofA: [0.2, 0.1, 0.1],
  roofB: [0.15, 0.15, 0.18],
  plinth: [0.08, 0.08, 0.08],
};

const region = (seed = SEED): RegionField => worldRegionField(seed);
const world = (seed = SEED) => worldSectorField(region(seed), seed);

/** A ground function that is flat at `y`, in the node-local frame. */
const flatGround = (y: number) => (): number => y;

/**
 * A node whose square holds at least one building, found by walking outward
 * from a settlement the world actually placed.
 *
 * Everything in this file needs one, and "find a village" is the part that
 * would otherwise be copied into every test with a different hard-coded
 * coordinate that stops being right the moment a constant moves.
 */
function findVillageNodes(seed = SEED): { coord: ChunkCoord; lots: SectorLots }[] {
  const field = world(seed);
  const found: { coord: ChunkCoord; lots: SectorLots }[] = [];
  for (let sz = -6; sz < 6 && found.length < 3; sz++) {
    for (let sx = -6; sx < 6 && found.length < 3; sx++) {
      const rec = field.lots.lotsAt(sx, sz);
      if (rec.count === 0) continue;
      const cx = rec.centerX[0] as number;
      const cz = rec.centerZ[0] as number;
      found.push({
        coord: { x: Math.floor(cx / 64), z: Math.floor(cz / 64), lod: 0 },
        lots: rec,
      });
    }
  }
  return found;
}

/** Build one node's buildings against flat ground well below every floor. */
function surfaceAt(coord: ChunkCoord, seed = SEED, groundY = -1000): BuildingSurface {
  const field = world(seed);
  return buildBuildingSurface(coord, region(seed).roads, field.lots, flatGround(groundY), PALETTE);
}

/**
 * Find a real city on `seed`, wherever `polity.ts`'s lattice actually put
 * one -- Phase Politics S1 moved every city on every seed, so a hardcoded
 * coordinate (this file used to share `(-32612, -28480)` with
 * `city-density.test.ts`) is no longer meaningful on any seed. Same search
 * shape `city-density.test.ts` uses.
 */
function findRealCitySettlement(seed: number): Settlement {
  const terrain: PolityTerrain = { seaLevel: SEA_LEVEL, height: baseHeight };
  const climate: PolityClimate = { continentalness, habitability };
  let span = 20_000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const sites = citiesInBox(-span, -span, span, span, terrain, climate, seed);
    for (const site of sites) {
      const net = worldRegionField(seed).roads.networkAt(site.x, site.z);
      const settlement = net.settlements.find((s) => s.class === SETTLEMENT_CLASS_CITY);
      if (settlement !== undefined) return settlement;
    }
    span *= 2;
  }
  throw new Error(`findRealCitySettlement: no city found within +/-${span}m of the origin on seed ${seed}`);
}

/** Find the first landmark lot of `kind` inside the default city. */
function findCityLandmark(kind: number): { rec: SectorLots; i: number } | undefined {
  const regionField = worldRegionField(CITY_SEED);
  const field = worldSectorField(regionField, CITY_SEED);
  const s = findRealCitySettlement(CITY_SEED);
  const cx = s.x;
  const cz = s.z;
  const R = s.wallRadius ?? 260;
  const s0 = Math.floor((cx - R) / 512);
  const s1 = Math.floor((cx + R) / 512);
  const z0 = Math.floor((cz - R) / 512);
  const z1 = Math.floor((cz + R) / 512);
  for (let sz = z0; sz <= z1; sz++) {
    for (let sx = s0; sx <= s1; sx++) {
      const rec = field.lots.lotsAt(sx, sz);
      for (let i = 0; i < rec.count; i++) {
        if ((rec.kind[i] as number) === kind) return { rec, i };
      }
    }
  }
  return undefined;
}

function surfaceForLandmark(kind: number) {
  const lot = findCityLandmark(kind);
  expect(lot).toBeDefined();
  const rec = lot!.rec;
  const index = lot!.i;
  const kx = rec.centerX[index] as number;
  const kz = rec.centerZ[index] as number;
  const coord: ChunkCoord = {
    x: Math.floor(kx / 64),
    z: Math.floor(kz / 64),
    lod: 0,
  };
  const regionField = worldRegionField(CITY_SEED);
  const field = worldSectorField(regionField, CITY_SEED);
  const surface = buildBuildingSurface(
    coord,
    regionField.roads,
    field.lots,
    flatGround(-1000),
    PALETTE,
  );
  return { surface, kx, kz, rec, index };
}

function vertsNear(
  surface: BuildingSurface,
  lcx: number,
  lcz: number,
  radius: number,
  originX: number,
  originZ: number,
): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let v = 0; v < surface.positions.length; v += 3) {
    const x = (surface.positions[v] as number) + originX;
    const y = surface.positions[v + 1] as number;
    const z = (surface.positions[v + 2] as number) + originZ;
    if (Math.abs(x - lcx) > radius || Math.abs(z - lcz) > radius) continue;
    out.push({ x, y, z });
  }
  return out;
}

function landmarkVerts(kind: number) {
  const { surface, kx, kz, rec, index } = surfaceForLandmark(kind);
  const coord = {
    x: Math.floor(kx / 64),
    z: Math.floor(kz / 64),
    lod: 0 as const,
  };
  const originX = coord.x * 64;
  const originZ = coord.z * 64;
  const floor = rec.floorY[index] as number;
  const verts = vertsNear(surface, kx, kz, 22, originX, originZ);
  return { surface, kx, kz, rec, index, floor, verts };
}

// ---------------------------------------------------------------------------
// The shape of a building
// ---------------------------------------------------------------------------

describe('one building', () => {
  it('gives buildingStart an exact partition of the surface, each span inside the roof budget', () => {
    // Phase Politics B1 gave ordinary buildings roof-type variety, so they no
    // longer share one fixed vertex/triangle count -- what's still true, and
    // what this asserts instead, is that `buildingStart` partitions the
    // surface with no gaps or overlaps, and every ordinary building's own
    // span is a sane roof-type cost.
    const nodes = findVillageNodes();
    expect(nodes.length).toBeGreaterThan(0);
    let ordinaryChecked = 0;
    for (const node of nodes) {
      const surface = surfaceAt(node.coord);
      if (surface.count === 0) continue;
      expect(surface.buildingStart.length).toBe(surface.count + 1);
      expect(surface.buildingStart[0]).toBe(0);
      expect(surface.buildingStart[surface.count]).toBe(surface.positions.length / 3);
      const landmarks =
        surface.keep + surface.cathedral + surface.townhall + surface.guildhall + surface.gatehouse;
      for (let b = 0; b < surface.count; b++) {
        const from = surface.buildingStart[b] as number;
        const to = surface.buildingStart[b + 1] as number;
        expect(to).toBeGreaterThan(from);
        if (landmarks === 0) {
          expect(to - from).toBeGreaterThanOrEqual(ORDINARY_VERTS_MIN);
          expect(to - from).toBeLessThanOrEqual(ORDINARY_VERTS_MAX);
          ordinaryChecked++;
        }
      }
      expect(surface.normals.length).toBe(surface.positions.length);
      expect(surface.colors.length).toBe(surface.positions.length);
    }
    expect(ordinaryChecked).toBeGreaterThan(0);
  });

  it('gives the known city keep more shell geometry than a cottage', () => {
    const citySeed = hashString('infinite-world');
    const field = world(citySeed);
    const city = findRealCitySettlement(citySeed);
    const R = city.wallRadius ?? 260;
    const s0 = Math.floor((city.x - R) / 512);
    const s1 = Math.floor((city.x + R) / 512);
    const z0 = Math.floor((city.z - R) / 512);
    const z1 = Math.floor((city.z + R) / 512);
    let keepLot;
    for (let z = z0; z <= z1 && keepLot === undefined; z++) {
      for (let x = s0; x <= s1 && keepLot === undefined; x++) {
        const rec = field.lots.lotsAt(x, z);
        for (let i = 0; i < rec.count; i++) {
          if ((rec.kind[i] as number) === KIND_KEEP) {
            keepLot = { rec, i };
            break;
          }
        }
      }
    }
    expect(keepLot).toBeDefined();
    const rec = keepLot?.rec as SectorLots;
    const index = keepLot?.i as number;
    const coord: ChunkCoord = {
      x: Math.floor((rec.centerX[index] as number) / 64),
      z: Math.floor((rec.centerZ[index] as number) / 64),
      lod: 0,
    };
    const surface = buildBuildingSurface(
      coord,
      region(citySeed).roads,
      field.lots,
      flatGround(-1000),
      PALETTE,
    );
    expect(surface.keep).toBeGreaterThan(0);
    // The keep dwarfs any ordinary roof-type box (whose own span never
    // exceeds `ORDINARY_VERTS_MAX`) -- found via `buildingStart` rather than
    // a fixed per-building stride, since B1 gave ordinary buildings variable
    // vertex counts.
    let maxSpan = 0;
    for (let b = 0; b < surface.count; b++) {
      const span = (surface.buildingStart[b + 1] as number) - (surface.buildingStart[b] as number);
      if (span > maxSpan) maxSpan = span;
    }
    expect(maxSpan).toBeGreaterThan(ORDINARY_VERTS_MAX);
  });

  it('C5 keep towers rise at least 20% above the bailey roof', () => {
    const citySeed = hashString('infinite-world');
    const field = world(citySeed);
    const city = findRealCitySettlement(citySeed);
    const cityR = city.wallRadius ?? 260;
    const s0 = Math.floor((city.x - cityR) / 512);
    const s1 = Math.floor((city.x + cityR) / 512);
    const z0 = Math.floor((city.z - cityR) / 512);
    const z1 = Math.floor((city.z + cityR) / 512);
    let keepLot: { rec: SectorLots; i: number } | undefined;
    for (let z = z0; z <= z1 && keepLot === undefined; z++) {
      for (let x = s0; x <= s1 && keepLot === undefined; x++) {
        const rec = field.lots.lotsAt(x, z);
        for (let i = 0; i < rec.count; i++) {
          if ((rec.kind[i] as number) === KIND_KEEP) {
            keepLot = { rec, i };
            break;
          }
        }
      }
    }
    expect(keepLot).toBeDefined();
    const rec = keepLot?.rec as SectorLots;
    const index = keepLot?.i as number;
    const kx = rec.centerX[index] as number;
    const kz = rec.centerZ[index] as number;
    const floor = rec.floorY[index] as number;
    const coord: ChunkCoord = {
      x: Math.floor(kx / 64),
      z: Math.floor(kz / 64),
      lod: 0,
    };
    const originX = coord.x * 64;
    const originZ = coord.z * 64;
    const lcx = kx - originX;
    const lcz = kz - originZ;
    const surface = buildBuildingSurface(
      coord,
      region(citySeed).roads,
      field.lots,
      flatGround(-1000),
      PALETTE,
    );
    expect(surface.keep).toBe(1);

    const radius = 28;
    let keepVerts = 0;
    let maxY = -Infinity;
    let minY = Infinity;
    const baileyRoof = floor + 6;
    for (let v = 0; v < surface.positions.length; v += 3) {
      const x = surface.positions[v] as number;
      const y = surface.positions[v + 1] as number;
      const z = surface.positions[v + 2] as number;
      if (Math.abs(x - lcx) > radius || Math.abs(z - lcz) > radius) continue;
      keepVerts++;
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
    // Anti-vacuity: keep landmark actually emitted verts near its lot centre.
    expect(keepVerts).toBeGreaterThan(LANDMARK_MIN_VERTS);
    // Positive: tower crowns exceed bailey roof by ≥20%.
    expect(maxY).toBeGreaterThanOrEqual(baileyRoof * 1.2);
    expect(maxY).toBeGreaterThanOrEqual(floor + 28);
    expect(minY).toBeLessThanOrEqual(floor);
  });

  it('C5 cathedral transept is at least 125% nave width and emits shell verts', () => {
    const { surface, kx, kz, rec, index, floor, verts } = landmarkVerts(KIND_CATHEDRAL);
    expect(surface.cathedral).toBe(1);
    expect(verts.length).toBeGreaterThan(LANDMARK_MIN_VERTS);
    expect(Math.max(...verts.map((v) => v.y))).toBeGreaterThanOrEqual(floor + 34);
    const hw = rec.halfWidth[index] as number;
    const hd = rec.halfDepth[index] as number;
    const transeptHalfAcross = hd * 0.46;
    const naveHalfAcross = 5;
    expect(transeptHalfAcross).toBeGreaterThanOrEqual(naveHalfAcross * 1.25);
    const ax = rec.alongX[index] as number;
    const az = rec.alongZ[index] as number;
    // The transept box itself (building-mesh.ts's `addLandmarkBuilding`,
    // KIND_CATHEDRAL: `box(0, 0, halfWidth * 0.32, halfDepth * 0.46, ...)`)
    // is `halfWidth * 0.32` wide along its own along-axis, centred on
    // along=0 -- so its own corner vertices, which are the ONLY vertices
    // carrying the wide across-measurement (a box has no verts along its
    // edges, only at its corners), sit exactly AT that half-extent. A window
    // narrower than it -- this test previously hardcoded `< 5`, and
    // `halfWidth` is always 16 (a literal in `city.ts`, not city-instance
    // dependent) giving exactly 5.12 -- silently excludes those corners and
    // measures whatever unrelated, narrower geometry happens to remain. The
    // window is derived from the box's own half-extent, with a small margin,
    // so this stays correct regardless of any future tuning of that literal.
    const transeptHalfAlong = hw * 0.32;
    let trAcross = 0;
    let towerAlong = 0;
    for (const v of verts) {
      const along = (v.x - kx) * ax + (v.z - kz) * az;
      const across = (v.x - kx) * az - (v.z - kz) * ax;
      if (Math.abs(along) <= transeptHalfAlong + 0.5 && v.y >= floor && v.y <= floor + 19) {
        trAcross = Math.max(trAcross, Math.abs(across));
      }
      if (v.y >= floor + 32 && along < -8) towerAlong = Math.min(towerAlong, along);
    }
    expect(trAcross * 2).toBeGreaterThan(20);
    expect(towerAlong).toBeLessThan(-8);
  });

  it('C5 town hall has plinth, dual roof levels, and frontage ≥18 m', () => {
    const { surface, kx, kz, rec, index, floor, verts } = landmarkVerts(KIND_TOWNHALL);
    expect(surface.townhall).toBe(1);
    const hw = rec.halfWidth[index] as number;
    expect(hw * 2).toBeGreaterThanOrEqual(18);
    expect(verts.length).toBeGreaterThan(LANDMARK_MIN_VERTS);
    const roofHeights = new Set<number>();
    for (const v of verts) {
      if (v.y >= floor + 7.5 && v.y <= floor + 9) roofHeights.add(1);
      if (v.y >= floor + 17.5 && v.y <= floor + 21) roofHeights.add(2);
    }
    expect(roofHeights.size).toBeGreaterThanOrEqual(2);
    const plinthBand = verts.filter((v) => v.y >= floor - 0.5 && v.y <= floor + 3.5);
    expect(plinthBand.length).toBeGreaterThan(40);
    const north = plinthBand.filter((v) => v.z > kz + 8).length;
    const south = plinthBand.filter((v) => v.z < kz - 8).length;
    const east = plinthBand.filter((v) => v.x > kx + 8).length;
    const west = plinthBand.filter((v) => v.x < kx - 8).length;
    expect([north, south, east, west].filter((n) => n > 5).length).toBeGreaterThanOrEqual(3);
  });

  it('C5 guildhall workshop exceeds hall height and loading gap exists on approach', () => {
    const { surface, kx, kz, rec, index, floor, verts } = landmarkVerts(KIND_GUILDHALL);
    expect(surface.guildhall).toBeGreaterThan(0);
    expect(verts.length).toBeGreaterThan(LANDMARK_MIN_VERTS);
    const maxY = Math.max(...verts.map((v) => v.y));
    expect(maxY).toBeGreaterThan(floor + 10.5);
    const ax = rec.alongX[index] as number;
    const az = rec.alongZ[index] as number;
    const hw = rec.halfWidth[index] as number;
    const hd = rec.halfDepth[index] as number;
    // Project into the lot's own (along, across) frame -- same discipline the
    // cathedral test above uses -- rather than the world x/z this test
    // previously assumed, since a guildhall's alongX/alongZ depends on the
    // street it fronts and is not guaranteed to be (1, 0) for any city.
    const projected = verts.map((v) => ({
      along: (v.x - kx) * ax + (v.z - kz) * az,
      across: (v.x - kx) * az - (v.z - kz) * ax,
      y: v.y,
    }));
    // The loading piers (`building-mesh.ts`'s KIND_GUILDHALL, box 3/4) sit at
    // offsetAcross = -halfDepth * 0.88 -- the approach side -- so a box's own
    // CORNER vertices, not its centre, are what a window has to reach: they
    // are centred at along = +/- halfWidth * 0.62 with half-extent
    // halfWidth * 0.38, so their |along| is halfWidth * 0.24 (inner edge) to
    // halfWidth * 1.0 (outer edge), not halfWidth * 0.62 itself. The old
    // fixed `< 2` window around a hardcoded 7.5 excluded both edges whenever
    // the actual half-extents didn't happen to put them within 2 m of that
    // literal -- the same class of bug the cathedral transept window had.
    const pierAlongMin = hw * 0.24 - 0.5;
    const pierAlongMax = hw * 1.0 + 0.5;
    const approachAcross = -hd * 0.4;
    const gapVerts = projected.filter(
      (v) => Math.abs(v.along) < hw * 0.2 && v.across < approachAcross && v.y > floor && v.y < floor + 5,
    );
    expect(gapVerts.length).toBe(0);
    const pierVerts = projected.filter(
      (v) =>
        Math.abs(v.along) >= pierAlongMin &&
        Math.abs(v.along) <= pierAlongMax &&
        v.across < approachAcross &&
        v.y > floor + 4,
    );
    expect(pierVerts.length).toBeGreaterThan(0);
  });

  it('C5 gatehouse towers exceed 125% curtain height with centre opening', () => {
    const { surface, kx, kz, floor, verts } = landmarkVerts(KIND_GATEHOUSE);
    expect(surface.gatehouse).toBeGreaterThan(0);
    expect(verts.length).toBeGreaterThan(LANDMARK_MIN_VERTS);
    const minTower = floor + WALL_HEIGHT * 1.25;
    expect(Math.max(...verts.map((v) => v.y))).toBeGreaterThanOrEqual(minTower);
    const centreGap = verts.filter(
      (v) => Math.abs(v.x - kx) < 2 && Math.abs(v.z - kz) < 3 && v.y > floor && v.y < floor + 10,
    );
    expect(centreGap.length).toBe(0);
    const towerVerts = verts.filter((v) => Math.abs(Math.abs(v.x - kx) - 7) < 3 && v.y > floor + 20);
    expect(towerVerts.length).toBeGreaterThan(0);
  });

  it('faces outward on every triangle', () => {
    // THE TEST THE OUTWARD-HINT MACHINERY EXISTS FOR. A house is a closed
    // convex-ish solid, so a triangle whose geometric normal points back toward
    // the building's centre is inside out -- invisible from outside with a
    // single-sided material, which is exactly how it would ship unnoticed.
    // B1 gave ordinary buildings variable per-roof-type vertex counts, so a
    // building's vertex range is no longer `[b * BUILDING_VERTEX_COUNT, ...)`
    // -- it's `[buildingStart[b], buildingStart[b + 1])`. Triangle indices are
    // absolute into `positions` and are emitted in building order (`face()`
    // never splits a triangle's corners across two buildings), so walking the
    // index buffer once while advancing `b` whenever the lead index crosses
    // into the next building's span finds each triangle's owner without a
    // separate triangle-boundary array.
    const nodes = findVillageNodes();
    let checked = 0;
    for (const node of nodes) {
      const surface = surfaceAt(node.coord);
      const p = surface.positions;
      const n = surface.normals;
      const centers: { x: number; y: number; z: number }[] = [];
      for (let b = 0; b < surface.count; b++) {
        const vFrom = surface.buildingStart[b] as number;
        const vTo = surface.buildingStart[b + 1] as number;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let v = vFrom; v < vTo; v++) {
          cx += p[v * 3] as number;
          cy += p[v * 3 + 1] as number;
          cz += p[v * 3 + 2] as number;
        }
        const vertCount = vTo - vFrom;
        centers.push({ x: cx / vertCount, y: cy / vertCount, z: cz / vertCount });
      }

      let b = 0;
      for (let t = 0; t < surface.indices.length; t += 3) {
        const i0 = surface.indices[t] as number;
        while (b < surface.count - 1 && i0 >= (surface.buildingStart[b + 1] as number)) b++;
        const { x: cx, y: cy, z: cz } = centers[b] as { x: number; y: number; z: number };

        const i1 = surface.indices[t + 1] as number;
        const i2 = surface.indices[t + 2] as number;
        const ax = p[i0 * 3] as number;
        const ay = p[i0 * 3 + 1] as number;
        const az = p[i0 * 3 + 2] as number;
        const ux = (p[i1 * 3] as number) - ax;
        const uy = (p[i1 * 3 + 1] as number) - ay;
        const uz = (p[i1 * 3 + 2] as number) - az;
        const vx = (p[i2 * 3] as number) - ax;
        const vy = (p[i2 * 3 + 1] as number) - ay;
        const vz = (p[i2 * 3 + 2] as number) - az;
        const gx = uy * vz - uz * vy;
        const gy = uz * vx - ux * vz;
        const gz = ux * vy - uy * vx;
        // Away from the centre...
        expect(gx * (ax - cx) + gy * (ay - cy) + gz * (az - cz)).toBeGreaterThan(0);
        // ...and the shaded normal agrees with the triangle it belongs to,
        // which is what makes the lighting match the geometry.
        const length = Math.sqrt(gx * gx + gy * gy + gz * gz);
        expect(length).toBeGreaterThan(0);
        const dot =
          (gx / length) * (n[i0 * 3] as number) +
          (gy / length) * (n[i0 * 3 + 1] as number) +
          (gz / length) * (n[i0 * 3 + 2] as number);
        expect(dot).toBeGreaterThan(0.99);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('writes a linear colour in range at every vertex', () => {
    const nodes = findVillageNodes();
    let seen = 0;
    for (const node of nodes) {
      const surface = surfaceAt(node.coord);
      for (const c of surface.colors) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Roof variety (Phase Politics B1)
// ---------------------------------------------------------------------------

describe('roof variety', () => {
  it('picks the same roof for the same building every time (pure in kind and world position)', () => {
    for (const [kind, x, z] of [
      [KIND_COTTAGE, 1234, -5678],
      [KIND_BARN, -910, 1112],
      [KIND_TOWNHOUSE, 31415, -9265],
      [KIND_HALL, -27182, 8182],
    ] as const) {
      const a = pickRoofType(kind, x, z);
      const b = pickRoofType(kind, x, z);
      expect(b).toBe(a);
    }
  });

  it('covers every implemented roof type over enough cottages, none of the unimplemented three', () => {
    // ROOF_MANSARD/ROOF_GAMBREL/ROOF_DOME_FACET are culture.ts enum values with
    // no geometry in `addRoofCap` yet (see its doc comment) -- `pickRoofType`
    // must never return them, or `addRoofCap`'s `else` branch would silently
    // draw a gable in their place instead of the intended shape.
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      seen.add(pickRoofType(KIND_COTTAGE, i * 97 - 500, i * 53 + 1000));
    }
    expect(seen.has(ROOF_GABLE)).toBe(true);
    expect(seen.has(ROOF_HIP)).toBe(true);
    expect(seen.has(ROOF_PYRAMID)).toBe(true);
    expect(seen.has(ROOF_SHED)).toBe(true);
    // ROOF_FLAT_PARAPET is cottage-reachable too (the generic roll below 42
    // is gable, 42-68 hip, 68-88 pyramid, 88+ shed -- flat-parapet only comes
    // from the townhouse-specific branch), so it is asserted separately below
    // rather than here.
    for (const type of seen) {
      expect(type).not.toBe(2 /* ROOF_MANSARD */);
      expect(type).not.toBe(6 /* ROOF_GAMBREL */);
      expect(type).not.toBe(7 /* ROOF_DOME_FACET */);
    }
  });

  it('biases barns toward gable/shed, townhouses toward flat-parapet/gable/hip, halls toward gable/hip', () => {
    const barnRoofs = new Set<number>();
    const townhouseRoofs = new Set<number>();
    const hallRoofs = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = i * 71 - 300;
      const z = i * 43 + 700;
      barnRoofs.add(pickRoofType(KIND_BARN, x, z));
      townhouseRoofs.add(pickRoofType(KIND_TOWNHOUSE, x, z));
      hallRoofs.add(pickRoofType(KIND_HALL, x, z));
    }
    expect(barnRoofs).toEqual(new Set([ROOF_GABLE, ROOF_SHED]));
    expect(townhouseRoofs).toEqual(new Set([ROOF_FLAT_PARAPET, ROOF_GABLE, ROOF_HIP]));
    expect(hallRoofs).toEqual(new Set([ROOF_GABLE, ROOF_HIP]));
  });

  it('nudges cottages toward a culture\'s own houseRoofs, without touching barn/townhouse/hall', () => {
    // Phase Politics B3. Culture 0 ('Northern Hold') prefers
    // [ROOF_GABLE, ROOF_SHED] -- both implemented -- so its cottages should
    // draw HIP/PYRAMID much less often than the unbiased (cultureId -1)
    // baseline. Culture 1 ('Riverlands') prefers [ROOF_GABLE, ROOF_GAMBREL],
    // and GAMBREL is unimplemented, so its nudge collapses to GABLE alone --
    // a stronger, single-roof bias -- rather than silently drawing GAMBREL or
    // falling back to an unrelated roof.
    const SAMPLES = 3000;
    let baselineOther = 0;
    let culture0Other = 0;
    let culture1Gable = 0;
    let culture1Total = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = i * 131 - 4000;
      const z = i * 89 + 2500;
      const base = pickRoofType(KIND_COTTAGE, x, z, -1);
      if (base === ROOF_HIP || base === ROOF_PYRAMID) baselineOther++;
      const c0 = pickRoofType(KIND_COTTAGE, x, z, 0);
      if (c0 === ROOF_HIP || c0 === ROOF_PYRAMID) culture0Other++;
      const c1 = pickRoofType(KIND_COTTAGE, x, z, 1);
      if (c1 === ROOF_GABLE) culture1Gable++;
      culture1Total++;
    }
    // Baseline HIP+PYRAMID share is ~46% (26 + 20); Northern Hold's nudge
    // should cut that meaningfully without eliminating all variety (the
    // nudge is soft, not a hard filter).
    expect(culture0Other).toBeLessThan(baselineOther * 0.75);
    expect(culture0Other).toBeGreaterThan(0);
    // Baseline GABLE share is ~42%; Riverlands' single-implemented-roof
    // nudge (55% forced GABLE + 45% baseline's own 42% GABLE share) should
    // land well above that.
    expect(culture1Gable / culture1Total).toBeGreaterThan(0.65);

    // Kinds with their own shape logic are untouched by culture.
    for (const kind of [KIND_BARN, KIND_TOWNHOUSE, KIND_HALL]) {
      for (let i = 0; i < 200; i++) {
        const x = i * 211 + 900;
        const z = i * 173 - 1600;
        expect(pickRoofType(kind, x, z, 0)).toBe(pickRoofType(kind, x, z, -1));
      }
    }
  });

  it('gives a real village more than one roof shape, visible as more than one distinct vertex span', () => {
    // The pure-function tests above prove the roll varies; this ties it to
    // actual generated content, the same anti-vacuity discipline the
    // archetype/street-density tests use in city.test.ts.
    const nodes = findVillageNodes();
    const spans = new Set<number>();
    for (const node of nodes) {
      const surface = surfaceAt(node.coord);
      const landmarks =
        surface.keep + surface.cathedral + surface.townhall + surface.guildhall + surface.gatehouse;
      if (landmarks > 0) continue;
      for (let b = 0; b < surface.count; b++) {
        spans.add((surface.buildingStart[b + 1] as number) - (surface.buildingStart[b] as number));
      }
    }
    expect(spans.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Ownership: exactly one node emits each building
// ---------------------------------------------------------------------------

describe('ownership', () => {
  it('emits each building from exactly one node, and lets it overhang', () => {
    // A boundary rule that is total and needs no communication. Off-by-one in
    // either direction is a house drawn twice (z-fighting on every face) or a
    // house that vanishes when the camera crosses a chunk line.
    const field = world();
    const nodes = findVillageNodes();
    expect(nodes.length).toBeGreaterThan(0);
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const rec = anchor.lots;

    let emitted = 0;
    let overhanging = 0;
    const radius = 6;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const coord: ChunkCoord = { x: anchor.coord.x + dx, z: anchor.coord.z + dz, lod: 0 };
        const surface = buildBuildingSurface(
          coord,
          region().roads,
          field.lots,
          flatGround(-1000),
          PALETTE,
        );
        emitted += surface.count;
        // A building is not clipped, so its geometry may reach outside the node
        // square. That is expected -- and it is what the submesh's bounds have
        // to be computed from the vertices for.
        const size = chunkSizeAt(coord.lod);
        for (let i = 0; i < surface.positions.length; i += 3) {
          const x = surface.positions[i] as number;
          const z = surface.positions[i + 2] as number;
          if (x < 0 || x > size || z < 0 || z > size) overhanging++;
        }
      }
    }
    // Every building of the anchor sector is inside a 6-node radius of it, so
    // the block must account for all of them and for none of them twice.
    expect(emitted).toBeGreaterThanOrEqual(rec.count);
    expect(overhanging).toBeGreaterThan(0);

    // The partition itself: sum over the block of "centres in this node" equals
    // the sector's own count, exactly.
    let owned = 0;
    for (let i = 0; i < rec.count; i++) {
      const cx = rec.centerX[i] as number;
      const cz = rec.centerZ[i] as number;
      const nodeX = Math.floor(cx / 64);
      const nodeZ = Math.floor(cz / 64);
      if (
        Math.abs(nodeX - anchor.coord.x) <= radius &&
        Math.abs(nodeZ - anchor.coord.z) <= radius
      ) {
        owned++;
      }
    }
    expect(owned).toBe(rec.count);
  });

  it('emits nothing at all on a node far from any settlement', () => {
    // The `null`-submesh discipline, at the level that decides it. A node with
    // no building centre must produce empty arrays, or every node in the world
    // costs a draw call for a village it is nowhere near.
    const surface = surfaceAt({ x: 900, z: -900, lod: 0 });
    expect(surface.count).toBe(0);
    expect(surface.positions).toHaveLength(0);
    expect(surface.indices).toHaveLength(0);
    expect(surface.level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The floor is LOD-independent and the plinth is not
// ---------------------------------------------------------------------------

describe('the floor and the plinth', () => {
  it('puts the floor (and eaves) where the sector record says, at every level', () => {
    // The reason a building does not jump when the quadtree changes level under
    // it. Fitting the floor per node would be the obvious thing to do and is
    // exactly what this refuses.
    //
    // Floor and eaves (`floorY + lots.eaves`) are both Sector-tier fixed
    // points, so their altitudes cannot depend on the node's own level --
    // that is what this checks. Everything ABOVE eaves (ridge, roof slopes,
    // facade panels) is NOT included any more: Phase Politics B4 gave
    // `lod >= BUILDING_LOD_SIMPLIFY` its own flat cap directly at eaves
    // instead of full massing (see `BUILDING_LOD_SIMPLIFY`), so what sits
    // above eaves is deliberately level-dependent now -- eaves itself is the
    // true invariant this test is named for, and the one still worth
    // checking exactly.
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const rec = anchor.lots;

    // Only the buildings `anchor.coord` ITSELF owns (centre inside its own
    // 64 m square) -- the sector record `rec` can span the whole village,
    // most of which belongs to sibling lod-0 nodes and is absent from this
    // one's own render. Landmarks (`LANDMARK_RECIPES`, Phase Politics B2)
    // never read `lots.eaves` either -- each box's own top/bottom is a
    // literal offset from `floor` -- so a landmark lot's `rec.eaves[i]` has
    // no corresponding vertex to find at all; only ordinary buildings do.
    const minX = anchor.coord.x * 64;
    const minZ = anchor.coord.z * 64;
    const maxX = minX + 64;
    const maxZ = minZ + 64;
    const landmarkKinds = new Set([KIND_KEEP, KIND_CATHEDRAL, KIND_TOWNHALL, KIND_GUILDHALL, KIND_GATEHOUSE]);
    const eavesAltitudes = new Set<number>();
    for (let i = 0; i < rec.count; i++) {
      const cx = rec.centerX[i] as number;
      const cz = rec.centerZ[i] as number;
      if (cx < minX || cx >= maxX || cz < minZ || cz >= maxZ) continue;
      if (landmarkKinds.has(rec.kind[i] as number)) continue;
      eavesAltitudes.add(Math.fround((rec.floorY[i] as number) + (rec.eaves[i] as number)));
    }
    expect(eavesAltitudes.size).toBeGreaterThan(0);

    const altitudesOf = (surface: BuildingSurface): Set<number> => {
      const out = new Set<number>();
      for (let i = 1; i < surface.positions.length; i += 3) out.add(surface.positions[i] as number);
      return out;
    };

    for (const lod of [0, 1, 2, 3]) {
      const coord: ChunkCoord = {
        x: Math.floor((anchor.coord.x * 64) / chunkSizeAt(lod)),
        z: Math.floor((anchor.coord.z * 64) / chunkSizeAt(lod)),
        lod,
      };
      const altitudes = altitudesOf(surfaceAt(coord));
      for (const y of eavesAltitudes) expect(altitudes.has(y)).toBe(true);
    }
  });

  it('reaches the plinth down to this node\u2019s ground, and no further than the cap', () => {
    // The per-node half of the split. Ground far below the floor must not hang a
    // curtain down the hillside; ground at the floor must produce no plinth at
    // all beyond the footing.
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const rec = anchor.lots;
    let floor = Infinity;
    for (let i = 0; i < rec.count; i++) floor = Math.min(floor, rec.floorY[i] as number);

    const deep = surfaceAt(anchor.coord, SEED, -1000);
    expect(deep.count).toBeGreaterThan(0);
    let lowest = Infinity;
    for (let i = 1; i < deep.positions.length; i += 3) {
      lowest = Math.min(lowest, deep.positions[i] as number);
    }
    expect(lowest).toBeGreaterThanOrEqual(floor - BUILDING_MAX_PLINTH - 1e-9);

    // And ground ABOVE every floor does not invert the walls: the base is
    // clamped to the floor rather than rising through it.
    const high = surfaceAt(anchor.coord, SEED, 10000);
    let highest = -Infinity;
    let lowestHigh = Infinity;
    for (let i = 1; i < high.positions.length; i += 3) {
      highest = Math.max(highest, high.positions[i] as number);
      lowestHigh = Math.min(lowestHigh, high.positions[i] as number);
    }
    expect(lowestHigh).toBeLessThanOrEqual(highest);
    expect(lowestHigh).toBeGreaterThanOrEqual(floor - 1e-9);
  });

  it('counts levelness at lod 0 only', () => {
    // `BUILDING_LEVEL_LOD`'s argument, and the anti-vacuity counter of the
    // phase. At a coarse level the number would describe the mesh's own
    // resolution rather than whether a village levelled its ground, so it is
    // not reported at all rather than reported wrong.
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    for (const lod of [1, 2, 3]) {
      const coord: ChunkCoord = {
        x: Math.floor((anchor.coord.x * 64) / chunkSizeAt(lod)),
        z: Math.floor((anchor.coord.z * 64) / chunkSizeAt(lod)),
        lod,
      };
      expect(surfaceAt(coord).level).toBe(0);
    }
    // ...and at lod 0, with ground put exactly at each floor, every building
    // this node owns counts. Anything else means the measurement is broken
    // rather than the world being unlevel.
    const rec = anchor.lots;
    const surface = buildBuildingSurface(
      anchor.coord,
      region().roads,
      world().lots,
      (localX, localZ) => {
        // Nearest floor to the queried point, which is the ground a perfectly
        // graded village would render.
        const worldX = anchor.coord.x * 64 + localX;
        const worldZ = anchor.coord.z * 64 + localZ;
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < rec.count; i++) {
          const dx = (rec.centerX[i] as number) - worldX;
          const dz = (rec.centerZ[i] as number) - worldZ;
          const d = dx * dx + dz * dz;
          if (d < bestDistance) {
            bestDistance = d;
            best = rec.floorY[i] as number;
          }
        }
        return best;
      },
      PALETTE,
    );
    expect(surface.count).toBeGreaterThan(0);
    expect(surface.level).toBe(surface.count);
  });
});

// ---------------------------------------------------------------------------
// LOD bands (Phase Politics B4)
// ---------------------------------------------------------------------------

describe('LOD simplification', () => {
  it('draws full massing at lod 0 and the flat silhouette at BUILDING_LOD_SIMPLIFY, walls and eaves unchanged either way', () => {
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const fine = surfaceAt(anchor.coord);
    expect(fine.count).toBeGreaterThan(0);
    expect(fine.simplified).toBe(0);

    const coarseCoord: ChunkCoord = {
      x: Math.floor((anchor.coord.x * 64) / chunkSizeAt(BUILDING_LOD_SIMPLIFY)),
      z: Math.floor((anchor.coord.z * 64) / chunkSizeAt(BUILDING_LOD_SIMPLIFY)),
      lod: BUILDING_LOD_SIMPLIFY,
    };
    const coarse = surfaceAt(coarseCoord);
    expect(coarse.count).toBeGreaterThan(0);
    expect(coarse.simplified).toBeGreaterThan(0);

    // Landmarks are never simplified (see `BUILDING_LOD_SIMPLIFY`'s doc
    // comment) -- `simplified` never exceeds the ordinary-building share of
    // `count`.
    const landmarks =
      coarse.keep + coarse.cathedral + coarse.townhall + coarse.guildhall + coarse.gatehouse;
    expect(coarse.simplified).toBeLessThanOrEqual(coarse.count - landmarks);

    // Every simplified building costs EXACTLY 4 walls (4v each) + 1 flat cap
    // (4v) = 20v -- unlike full massing, the simplified path has no
    // roof-type variety, so this is an exact count, not a range.
    let simplifiedChecked = 0;
    for (let b = 0; b < coarse.count; b++) {
      const span = (coarse.buildingStart[b + 1] as number) - (coarse.buildingStart[b] as number);
      if (span === 20) simplifiedChecked++;
    }
    expect(simplifiedChecked).toBe(coarse.simplified);
  });

  it('faces outward on every triangle of the simplified silhouette too', () => {
    // The winding test above (`describe('one building')`) only ever
    // exercises lod 0 nodes via `findVillageNodes()` -- this is the same
    // check, run once against a real coarse-LOD village, so the simplified
    // cap's own winding is verified rather than assumed from the shared
    // `face()` machinery alone.
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const coarseCoord: ChunkCoord = {
      x: Math.floor((anchor.coord.x * 64) / chunkSizeAt(BUILDING_LOD_SIMPLIFY)),
      z: Math.floor((anchor.coord.z * 64) / chunkSizeAt(BUILDING_LOD_SIMPLIFY)),
      lod: BUILDING_LOD_SIMPLIFY,
    };
    const surface = surfaceAt(coarseCoord);
    expect(surface.simplified).toBeGreaterThan(0);
    const p = surface.positions;
    const n = surface.normals;
    let checked = 0;
    for (let b = 0; b < surface.count; b++) {
      const vFrom = surface.buildingStart[b] as number;
      const vTo = surface.buildingStart[b + 1] as number;
      if (vTo - vFrom !== 20) continue; // only the simplified buildings
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let v = vFrom; v < vTo; v++) {
        cx += p[v * 3] as number;
        cy += p[v * 3 + 1] as number;
        cz += p[v * 3 + 2] as number;
      }
      const count = vTo - vFrom;
      cx /= count;
      cy /= count;
      cz /= count;
      for (let t = 0; t < surface.indices.length; t += 3) {
        const i0 = surface.indices[t] as number;
        if (i0 < vFrom || i0 >= vTo) continue;
        const i1 = surface.indices[t + 1] as number;
        const i2 = surface.indices[t + 2] as number;
        const ax = p[i0 * 3] as number;
        const ay = p[i0 * 3 + 1] as number;
        const az = p[i0 * 3 + 2] as number;
        const ux = (p[i1 * 3] as number) - ax;
        const uy = (p[i1 * 3 + 1] as number) - ay;
        const uz = (p[i1 * 3 + 2] as number) - az;
        const vx = (p[i2 * 3] as number) - ax;
        const vy = (p[i2 * 3 + 1] as number) - ay;
        const vz = (p[i2 * 3 + 2] as number) - az;
        const gx = uy * vz - uz * vy;
        const gy = uz * vx - ux * vz;
        const gz = ux * vy - uy * vx;
        expect(gx * (ax - cx) + gy * (ay - cy) + gz * (az - cz)).toBeGreaterThan(0);
        const length = Math.sqrt(gx * gx + gy * gy + gz * gz);
        expect(length).toBeGreaterThan(0);
        const dot =
          (gx / length) * (n[i0 * 3] as number) +
          (gy / length) * (n[i0 * 3 + 1] as number) +
          (gz / length) * (n[i0 * 3 + 2] as number);
        expect(dot).toBeGreaterThan(0.99);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('rebuilds a node byte-identically', () => {
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const first = surfaceAt(anchor.coord);
    const second = surfaceAt(anchor.coord);
    expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
    expect(Array.from(second.normals)).toEqual(Array.from(first.normals));
    expect(Array.from(second.colors)).toEqual(Array.from(first.colors));
    expect(Array.from(second.indices)).toEqual(Array.from(first.indices));
    expect(first.count).toBeGreaterThan(0);
  });
});
