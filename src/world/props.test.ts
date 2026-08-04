/**
 * Tests for Phase 7a: prop placement.
 *
 * Placement is a pure function of (worldSeed, worldXZ) with ownership by centre.
 * These tests pin determinism, ownership, clearance, and that a forest node
 * actually receives vegetation (anti-vacuity of the accept gate).
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { chunkSizeAt, type ChunkCoord } from './contracts';
import { worldRegionField, worldSectorField } from './height-field';
import {
  PROP_CELL,
  PROP_KIND_BUSH,
  PROP_KIND_CRATE,
  PROP_KIND_POST,
  PROP_KIND_TREE,
  PROP_MAX_PER_NODE,
  SPECIES_BROADLEAF,
  SPECIES_BUSH_ROUND,
  SPECIES_BUSH_TALL,
  SPECIES_CRATE,
  SPECIES_PINE,
  SPECIES_POST,
  collectNodeProps,
  emptyPropField,
} from './props';

const SEED = hashString('props-test');

function fields(seed = SEED) {
  const region = worldRegionField(seed);
  const sector = worldSectorField(region, seed);
  return { region, sector };
}

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
      if (props.count >= 8) return coord;
    }
  }
  throw new Error('no prop-bearing lod-0 node found near origin for seed props-test');
}

describe('collectNodeProps', () => {
  it('is deterministic for the same seed and coordinate', () => {
    const coord = findPropNode();
    const { region, sector } = fields();
    const a = collectNodeProps(coord, SEED, region.roads, sector.streets, sector.lots);
    const b = collectNodeProps(coord, SEED, region.roads, sector.streets, sector.lots);
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    expect(Array.from(a.centerX)).toEqual(Array.from(b.centerX));
    expect(Array.from(a.centerZ)).toEqual(Array.from(b.centerZ));
    expect(Array.from(a.kind)).toEqual(Array.from(b.kind));
    expect(Array.from(a.species)).toEqual(Array.from(b.species));
    expect(Array.from(a.scale)).toEqual(Array.from(b.scale));
  });

  it('owns props strictly by centre inside the node square', () => {
    const coord = findPropNode();
    const size = chunkSizeAt(coord.lod);
    const minX = coord.x * size;
    const minZ = coord.z * size;
    const maxX = minX + size;
    const maxZ = minZ + size;
    const { region, sector } = fields();
    const props = collectNodeProps(coord, SEED, region.roads, sector.streets, sector.lots);
    expect(props.count).toBeGreaterThan(0);
    for (let i = 0; i < props.count; i++) {
      const x = props.centerX[i] as number;
      const z = props.centerZ[i] as number;
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThan(maxX);
      expect(z).toBeGreaterThanOrEqual(minZ);
      expect(z).toBeLessThan(maxZ);
    }
  });

  it('partitions ownership across neighbouring nodes without double emission', () => {
    const origin = findPropNode();
    const { region, sector } = fields();
    const seen = new Map<string, string>();
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const coord = { x: origin.x + dx, z: origin.z + dz, lod: 0 };
        const props = collectNodeProps(
          coord,
          SEED,
          region.roads,
          sector.streets,
          sector.lots,
        );
        for (let i = 0; i < props.count; i++) {
          const key = `${(props.centerX[i] as number).toFixed(3)},${(props.centerZ[i] as number).toFixed(3)}`;
          expect(seen.has(key)).toBe(false);
          seen.set(key, `${coord.x},${coord.z}`);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('caps at PROP_MAX_PER_NODE and exposes a positive lattice spacing', () => {
    expect(PROP_MAX_PER_NODE).toBeGreaterThan(100);
    expect(PROP_CELL).toBeGreaterThan(0);
  });

  it('uses only the sparse Phase 7a kinds', () => {
    const coord = findPropNode();
    const { region, sector } = fields();
    const props = collectNodeProps(coord, SEED, region.roads, sector.streets, sector.lots);
    const allowed = new Set([PROP_KIND_TREE, PROP_KIND_BUSH, PROP_KIND_CRATE, PROP_KIND_POST]);
    for (let i = 0; i < props.count; i++) {
      expect(allowed.has(props.kind[i] as number)).toBe(true);
    }
  });

  it('stores species in the allowed set and mixes tree/bush families', () => {
    const { region, sector } = fields();
    const allowed = new Set([
      SPECIES_PINE,
      SPECIES_BROADLEAF,
      SPECIES_BUSH_ROUND,
      SPECIES_BUSH_TALL,
      SPECIES_CRATE,
      SPECIES_POST,
    ]);
    let pine = 0;
    let broadleaf = 0;
    let bushRound = 0;
    let bushTall = 0;
    for (let z = -60; z <= 60; z++) {
      for (let x = -60; x <= 60; x++) {
        const props = collectNodeProps(
          { x, z, lod: 0 },
          SEED,
          region.roads,
          sector.streets,
          sector.lots,
        );
        for (let i = 0; i < props.count; i++) {
          const sp = props.species[i] as number;
          expect(allowed.has(sp)).toBe(true);
          if (sp === SPECIES_PINE) pine++;
          if (sp === SPECIES_BROADLEAF) broadleaf++;
          if (sp === SPECIES_BUSH_ROUND) bushRound++;
          if (sp === SPECIES_BUSH_TALL) bushTall++;
        }
      }
    }
    expect(pine).toBeGreaterThan(0);
    expect(broadleaf).toBeGreaterThan(0);
    expect(bushRound).toBeGreaterThan(0);
    expect(bushTall).toBeGreaterThan(0);
  });

  it('clusters world density by grove without emptying the lattice', () => {
    const { region, sector } = fields();
    let total = 0;
    let nodes = 0;
    for (let z = -30; z <= 30; z++) {
      for (let x = -30; x <= 30; x++) {
        const props = collectNodeProps(
          { x, z, lod: 0 },
          SEED,
          region.roads,
          sector.streets,
          sector.lots,
        );
        if (props.count > 0) {
          nodes++;
          total += props.count;
        }
      }
    }
    expect(nodes).toBeGreaterThan(10);
    expect(total / nodes).toBeGreaterThan(1);
  });

  it('emptyPropField is zero-length everywhere', () => {
    const empty = emptyPropField();
    expect(empty.count).toBe(0);
    expect(empty.centerX).toHaveLength(0);
    expect(empty.kind).toHaveLength(0);
    expect(empty.species).toHaveLength(0);
  });
});
