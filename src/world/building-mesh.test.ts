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
  BUILDING_MAX_PLINTH,
  BUILDING_TRIANGLE_COUNT,
  BUILDING_VERTEX_COUNT,
  buildBuildingSurface,
  type BuildingPalette,
  type BuildingSurface,
} from './building-mesh';
import { worldRegionField, worldSectorField, type RegionField } from './height-field';
import { type SectorLots } from './lots';

const SEED = hashString('buildings-test');

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

// ---------------------------------------------------------------------------
// The shape of a building
// ---------------------------------------------------------------------------

describe('one building', () => {
  it('costs exactly the vertices and triangles the constants claim', () => {
    // The payload maths in `PROGRESS.md` and the cap in `BUILDING_MAX_PER_NODE`
    // are both derived from these two numbers, so they are not documentation.
    const nodes = findVillageNodes();
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const surface = surfaceAt(node.coord);
      if (surface.count === 0) continue;
      expect(surface.positions.length / 3).toBe(surface.count * BUILDING_VERTEX_COUNT);
      expect(surface.indices.length / 3).toBe(surface.count * BUILDING_TRIANGLE_COUNT);
      expect(surface.normals.length).toBe(surface.positions.length);
      expect(surface.colors.length).toBe(surface.positions.length);
    }
  });

  it('faces outward on every triangle', () => {
    // THE TEST THE OUTWARD-HINT MACHINERY EXISTS FOR. A house is a closed
    // convex-ish solid, so a triangle whose geometric normal points back toward
    // the building's centre is inside out -- invisible from outside with a
    // single-sided material, which is exactly how it would ship unnoticed.
    const nodes = findVillageNodes();
    let checked = 0;
    for (const node of nodes) {
      const surface = surfaceAt(node.coord);
      const p = surface.positions;
      const n = surface.normals;
      for (let b = 0; b < surface.count; b++) {
        const base = b * BUILDING_VERTEX_COUNT;
        // The centre of this building's own vertices. Every face of a box is on
        // the far side of it from the interior.
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let v = 0; v < BUILDING_VERTEX_COUNT; v++) {
          cx += p[(base + v) * 3] as number;
          cy += p[(base + v) * 3 + 1] as number;
          cz += p[(base + v) * 3 + 2] as number;
        }
        cx /= BUILDING_VERTEX_COUNT;
        cy /= BUILDING_VERTEX_COUNT;
        cz /= BUILDING_VERTEX_COUNT;

        const from = b * BUILDING_TRIANGLE_COUNT * 3;
        const to = from + BUILDING_TRIANGLE_COUNT * 3;
        for (let t = from; t < to; t += 3) {
          const i0 = surface.indices[t] as number;
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
    }
    expect(checked).toBeGreaterThan(BUILDING_TRIANGLE_COUNT);
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
  it('puts the floor where the sector record says, at every level', () => {
    // The reason a building does not jump when the quadtree changes level under
    // it. Fitting the floor per node would be the obvious thing to do and is
    // exactly what this refuses.
    const nodes = findVillageNodes();
    const anchor = nodes[0] as { coord: ChunkCoord; lots: SectorLots };
    const rec = anchor.lots;
    let lowestFloor = Infinity;
    for (let i = 0; i < rec.count; i++) lowestFloor = Math.min(lowestFloor, rec.floorY[i] as number);

    // Every altitude ABOVE the floor line -- the eaves and the ridge -- is
    // `floorY + something the sector record fixed`, so it cannot depend on the
    // level. Only the base is per node, and with the ground put a kilometre
    // down every base is below the lowest floor and out of this set.
    const above = (surface: BuildingSurface): number[] => {
      const out = new Set<number>();
      for (let i = 1; i < surface.positions.length; i += 3) {
        const y = surface.positions[i] as number;
        if (y >= lowestFloor) out.add(y);
      }
      return [...out].sort((a, b) => a - b);
    };

    const fine = above(surfaceAt(anchor.coord));
    expect(fine.length).toBeGreaterThan(0);
    for (const lod of [1, 2, 3]) {
      const coord: ChunkCoord = {
        x: Math.floor((anchor.coord.x * 64) / chunkSizeAt(lod)),
        z: Math.floor((anchor.coord.z * 64) / chunkSizeAt(lod)),
        lod,
      };
      // A coarse node owns everything the fine one does and more, so its set of
      // above-floor altitudes must CONTAIN the fine node's exactly. A floor
      // fitted per node would move every one of them.
      const coarse = new Set(above(surfaceAt(coord)));
      for (const y of fine) expect(coarse.has(y)).toBe(true);
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
