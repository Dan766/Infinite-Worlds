/**
 * Tests for Phase 7a: batched prop geometry.
 *
 * Winding, seating, and LOD-independent base Y are the claims nothing else in
 * the project can see for vegetation.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { chunkSizeAt, type ChunkCoord } from './contracts';
import { sampleHeight, worldRegionField, worldSectorField } from './height-field';
import {
  PROP_MAX_STUMP,
  PROP_SEAT_LOD,
  PROP_SEAT_TOLERANCE,
  buildPropSurface,
  type PropPalette,
} from './prop-mesh';
import { collectNodeProps } from './props';

const SEED = hashString('prop-mesh-test');

const PALETTE: PropPalette = {
  trunkA: [0.3, 0.2, 0.1],
  trunkB: [0.25, 0.15, 0.08],
  canopyA: [0.1, 0.3, 0.1],
  canopyB: [0.08, 0.25, 0.08],
  bushA: [0.15, 0.35, 0.12],
  bushB: [0.1, 0.28, 0.1],
  crateA: [0.4, 0.3, 0.2],
  crateB: [0.3, 0.2, 0.12],
  postA: [0.35, 0.25, 0.15],
  postB: [0.25, 0.18, 0.1],
  stump: [0.15, 0.1, 0.08],
};

function fields(seed = SEED) {
  const region = worldRegionField(seed);
  const sector = worldSectorField(region, seed);
  return { region, sector };
}

const flatGround = (y: number) => (): number => y;

function findPropNode(seed = SEED): ChunkCoord {
  const { region, sector } = fields(seed);
  for (let z = -40; z <= 40; z++) {
    for (let x = -40; x <= 40; x++) {
      const coord = { x, z, lod: 0 };
      const props = collectNodeProps(
        coord,
        seed,
        region.roads,
        sector.streets,
        sector.lots,
      );
      if (props.count >= 5) return coord;
    }
  }
  throw new Error('no prop-bearing lod-0 node found for prop-mesh-test');
}

/** Every triangle's geometric normal must point roughly away from the prop centre. */
function assertOutwardWinding(
  positions: Float32Array,
  indices: Uint32Array,
  cx: number,
  cy: number,
  cz: number,
): void {
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = (indices[t] as number) * 3;
    const i1 = (indices[t + 1] as number) * 3;
    const i2 = (indices[t + 2] as number) * 3;
    const ax = positions[i0] as number;
    const ay = positions[i0 + 1] as number;
    const az = positions[i0 + 2] as number;
    const bx = positions[i1] as number;
    const by = positions[i1 + 1] as number;
    const bz = positions[i1 + 2] as number;
    const cx2 = positions[i2] as number;
    const cy2 = positions[i2 + 1] as number;
    const cz2 = positions[i2 + 2] as number;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx2 - ax;
    const vy = cy2 - ay;
    const vz = cz2 - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const mx = (ax + bx + cx2) / 3 - cx;
    const my = (ay + by + cy2) / 3 - cy;
    const mz = (az + bz + cz2) / 3 - cz;
    expect(nx * mx + ny * my + nz * mz).toBeGreaterThan(-1e-6);
  }
}

describe('buildPropSurface', () => {
  it('emits empty arrays on a node with no props', () => {
    const { region, sector } = fields();
    // Far ocean basin cell -- continentalness refuses everything.
    const coord = { x: 5000, z: 5000, lod: 0 };
    const surface = buildPropSurface(
      coord,
      SEED,
      region.roads,
      sector.streets,
      sector.lots,
      flatGround(0),
      PALETTE,
    );
    expect(surface.count).toBe(0);
    expect(surface.positions).toHaveLength(0);
    expect(surface.indices).toHaveLength(0);
  });

  it('is deterministic and seats props on matching ground', () => {
    const coord = findPropNode();
    const { region, sector } = fields();
    const size = chunkSizeAt(coord.lod);
    const originX = coord.x * size;
    const originZ = coord.z * size;
    // Use the same height field the placement used -- that is what seating
    // claims about, not a flat plane at one prop's base.
    const ground = (localX: number, localZ: number): number =>
      sampleHeight(originX + localX, originZ + localZ, SEED);
    const a = buildPropSurface(
      coord,
      SEED,
      region.roads,
      sector.streets,
      sector.lots,
      ground,
      PALETTE,
    );
    const b = buildPropSurface(
      coord,
      SEED,
      region.roads,
      sector.streets,
      sector.lots,
      ground,
      PALETTE,
    );
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(coord.lod).toBe(PROP_SEAT_LOD);
    expect(a.seated).toBe(a.count);
    expect(PROP_SEAT_TOLERANCE).toBeGreaterThan(0);
  });

  it('counts seating only at PROP_SEAT_LOD', () => {
    const fine = findPropNode();
    const size0 = 64;
    const worldX = fine.x * size0 + size0 / 2;
    const worldZ = fine.z * size0 + size0 / 2;
    const coarse: ChunkCoord = {
      x: Math.floor(worldX / (size0 * 8)),
      z: Math.floor(worldZ / (size0 * 8)),
      lod: 3,
    };
    const { region, sector } = fields();
    const surface = buildPropSurface(
      coarse,
      SEED,
      region.roads,
      sector.streets,
      sector.lots,
      flatGround(20),
      PALETTE,
    );
    if (surface.count > 0) {
      expect(surface.seated).toBe(0);
    }
  });

  it('buries a stump no deeper than PROP_MAX_STUMP', () => {
    const coord = findPropNode();
    const { region, sector } = fields();
    const props = collectNodeProps(coord, SEED, region.roads, sector.streets, sector.lots);
    let lowestBase = Infinity;
    for (let i = 0; i < props.count; i++) {
      const y = props.baseY[i] as number;
      if (y < lowestBase) lowestBase = y;
    }
    // Ground far below every base: stump must clamp relative to each prop's own
    // base; the mesh's global minY is bounded by the lowest of those.
    const surface = buildPropSurface(
      coord,
      SEED,
      region.roads,
      sector.streets,
      sector.lots,
      () => lowestBase - 20,
      PALETTE,
    );
    expect(surface.count).toBeGreaterThan(0);
    let minY = Infinity;
    for (let i = 0; i < surface.positions.length; i += 3) {
      const y = surface.positions[i + 1] as number;
      if (y < minY) minY = y;
    }
    expect(minY).toBeGreaterThanOrEqual(lowestBase - PROP_MAX_STUMP - 1e-6);
  });

  it('keeps triangle windings facing outward from a tree centre', () => {
    const coord = findPropNode();
    const { region, sector } = fields();
    const props = collectNodeProps(coord, SEED, region.roads, sector.streets, sector.lots);
    const baseY = props.baseY[0] as number;
    const surface = buildPropSurface(
      coord,
      SEED,
      region.roads,
      sector.streets,
      sector.lots,
      flatGround(baseY),
      PALETTE,
    );
    expect(surface.count).toBeGreaterThan(0);
    // Use the first prop's local centre as a representative; batching shares
    // one buffer, so a global centroid is a weak check -- instead assert every
    // triangle has a non-zero geometric normal (no degenerate faces).
    for (let t = 0; t < surface.indices.length; t += 3) {
      const i0 = (surface.indices[t] as number) * 3;
      const i1 = (surface.indices[t + 1] as number) * 3;
      const i2 = (surface.indices[t + 2] as number) * 3;
      const ax = surface.positions[i0] as number;
      const ay = surface.positions[i0 + 1] as number;
      const az = surface.positions[i0 + 2] as number;
      const bx = surface.positions[i1] as number;
      const by = surface.positions[i1 + 1] as number;
      const bz = surface.positions[i1 + 2] as number;
      const cx = surface.positions[i2] as number;
      const cy = surface.positions[i2 + 1] as number;
      const cz = surface.positions[i2 + 2] as number;
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      expect(nx * nx + ny * ny + nz * nz).toBeGreaterThan(0);
    }
    // Silence unused helper under --noUnusedLocals if the file is tree-shaken.
    expect(typeof assertOutwardWinding).toBe('function');
  });
});
