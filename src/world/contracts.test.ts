import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  REGION_SIZE,
  SECTOR_SIZE,
  chunkCenter,
  chunkKey,
  chunkOrigin,
  chunkSizeAt,
  chunkToSector,
  createTierContext,
  isCoarserThan,
  parseChunkKey,
  sectorToRegion,
  tierDepth,
  worldToChunk,
} from './contracts';

describe('tier constants', () => {
  it('nest exactly, so a coarse cell is a whole number of finer cells', () => {
    expect(REGION_SIZE % SECTOR_SIZE).toBe(0);
    expect(SECTOR_SIZE % CHUNK_SIZE).toBe(0);
  });

  it('order from coarse to fine', () => {
    expect(tierDepth('region')).toBeLessThan(tierDepth('sector'));
    expect(tierDepth('sector')).toBeLessThan(tierDepth('chunk'));
    expect(isCoarserThan('region', 'chunk')).toBe(true);
    expect(isCoarserThan('chunk', 'region')).toBe(false);
    expect(isCoarserThan('chunk', 'chunk')).toBe(false);
  });
});

describe('chunk keys', () => {
  it('round-trip, including negatives and every lod', () => {
    for (const coord of [
      { x: 0, z: 0, lod: 0 },
      { x: 7, z: -3, lod: 0 },
      { x: -1000000, z: 999999, lod: 0 },
      { x: 7, z: -3, lod: 1 },
      { x: -4, z: 5, lod: 6 },
    ]) {
      expect(parseChunkKey(chunkKey(coord))).toEqual(coord);
    }
  });

  it('are distinct for transposed coordinates', () => {
    expect(chunkKey({ x: 1, z: 2, lod: 0 })).not.toBe(chunkKey({ x: 2, z: 1, lod: 0 }));
  });

  it('are distinct for the same square at different levels', () => {
    // Two nodes can share (x, z) while covering completely different squares.
    // If the key did not carry lod they would alias in the streamer's maps and
    // in the worker pool's job table.
    expect(chunkKey({ x: 3, z: 4, lod: 0 })).not.toBe(chunkKey({ x: 3, z: 4, lod: 1 }));
  });

  it('reject anything they did not produce', () => {
    expect(() => parseChunkKey('nope')).toThrow();
    expect(() => parseChunkKey('1.5,2,0')).toThrow();
    // A Phase 1 two-component key must be rejected, not silently read as lod 0.
    expect(() => parseChunkKey('1,2')).toThrow();
    expect(() => parseChunkKey('1,2,-1')).toThrow();
    expect(() => parseChunkKey('1,2,0,0')).toThrow();
  });
});

describe('chunkSizeAt', () => {
  it('doubles per level, starting at one chunk', () => {
    expect(chunkSizeAt(0)).toBe(CHUNK_SIZE);
    expect(chunkSizeAt(1)).toBe(CHUNK_SIZE * 2);
    expect(chunkSizeAt(3)).toBe(CHUNK_SIZE * 8);
    // A whole sector is a node some number of levels up, exactly.
    expect(SECTOR_SIZE % chunkSizeAt(2)).toBe(0);
  });
});

describe('world to chunk mapping', () => {
  it('floors, so negative coordinates do not fold onto zero', () => {
    expect(worldToChunk(0, 0)).toEqual({ x: 0, z: 0, lod: 0 });
    expect(worldToChunk(CHUNK_SIZE - 0.001, 0)).toEqual({ x: 0, z: 0, lod: 0 });
    expect(worldToChunk(CHUNK_SIZE, 0)).toEqual({ x: 1, z: 0, lod: 0 });
    expect(worldToChunk(-0.001, 0)).toEqual({ x: -1, z: 0, lod: 0 });
    expect(worldToChunk(-CHUNK_SIZE, 0)).toEqual({ x: -1, z: 0, lod: 0 });
    expect(worldToChunk(-CHUNK_SIZE - 0.001, 0)).toEqual({ x: -2, z: 0, lod: 0 });
  });

  it('is the inverse of chunkOrigin, at every level', () => {
    for (const lod of [0, 1, 4]) {
      for (const coord of [
        { x: 0, z: 0, lod },
        { x: 5, z: -9, lod },
        { x: -12345, z: 6789, lod },
      ]) {
        const origin = chunkOrigin(coord);
        expect(worldToChunk(origin.x, origin.z, lod)).toEqual(coord);
        const centre = chunkCenter(coord);
        expect(worldToChunk(centre.x, centre.z, lod)).toEqual(coord);
      }
    }
  });

  it('reads the level from the coordinate rather than assuming zero', () => {
    // The bug this guards: a coarse node drawn at the fine node's origin.
    expect(chunkOrigin({ x: 3, z: 0, lod: 2 }).x).toBe(3 * CHUNK_SIZE * 4);
    expect(chunkOrigin({ x: 3, z: 0, lod: 0 }).x).toBe(3 * CHUNK_SIZE);
    expect(chunkCenter({ x: 0, z: 0, lod: 1 })).toEqual({ x: CHUNK_SIZE, z: CHUNK_SIZE });
  });
});

describe('tier nesting', () => {
  it('maps chunks into sectors and sectors into regions, negatives included', () => {
    const chunksPerSector = SECTOR_SIZE / CHUNK_SIZE;
    expect(chunkToSector({ x: 0, z: 0, lod: 0 })).toEqual({ x: 0, z: 0 });
    expect(chunkToSector({ x: chunksPerSector - 1, z: 0, lod: 0 })).toEqual({ x: 0, z: 0 });
    expect(chunkToSector({ x: chunksPerSector, z: 0, lod: 0 })).toEqual({ x: 1, z: 0 });
    expect(chunkToSector({ x: -1, z: -1, lod: 0 })).toEqual({ x: -1, z: -1 });

    const sectorsPerRegion = REGION_SIZE / SECTOR_SIZE;
    expect(sectorToRegion({ x: sectorsPerRegion - 1, z: 0 })).toEqual({ x: 0, z: 0 });
    expect(sectorToRegion({ x: -1, z: 0 })).toEqual({ x: -1, z: 0 });
  });
});

describe('TierContext', () => {
  it('carries the seed as a uint32 and the tier cell size', () => {
    const context = createTierContext(-1, 'chunk');
    expect(context.worldSeed).toBe(4294967295);
    expect(context.cellSize).toBe(CHUNK_SIZE);
    expect(context.tier).toBe('chunk');
  });

  it('hands over coarser-tier data', () => {
    const context = createTierContext(1, 'chunk', { region: { biome: 'tundra' } });
    expect(context.coarser<{ biome: string }>('region')).toEqual({ biome: 'tundra' });
    // Legal to ask for, simply absent in Phase 1.
    expect(context.coarser('sector')).toBeUndefined();
  });

  it('throws when a tier reads itself or anything finer (RULE 3)', () => {
    const chunk = createTierContext(1, 'chunk');
    expect(() => chunk.coarser('chunk')).toThrow(/Tier rule violation/);

    const region = createTierContext(1, 'region');
    expect(() => region.coarser('sector')).toThrow(/Tier rule violation/);
    expect(() => region.coarser('chunk')).toThrow(/Tier rule violation/);
  });
});
