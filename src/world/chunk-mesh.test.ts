/**
 * Disposal is the whole reason this file has tests: a chunk that is merely
 * dropped from a Map leaves its GPU buffers alive, and that is precisely the
 * leak the five-minute flat-heap criterion exists to catch.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createChunkMesh,
  disposeChunkMesh,
  hashPositions,
  resetWaterDraws,
  waterDrawsSinceReset,
} from './chunk-mesh';
import { generateChunk, skirtDepthOf } from './chunk-gen';
import { SEA_LEVEL } from './height-field';
import { CHUNK_SIZE, createTierContext, type ChunkCoord } from './contracts';

const build = (coord: ChunkCoord = { x: 0, z: 0, lod: 0 }): ReturnType<typeof createChunkMesh> =>
  createChunkMesh(generateChunk(coord, createTierContext(99, 'chunk')));

/**
 * Three nodes on seed 99, chosen because the water tests need all three cases
 * and a test that has to search for one is a test that stops meaning anything
 * when the height field is retuned. `chunk-gen.test.ts` asserts these really
 * are dry / part-submerged / fully submerged, so if a later phase moves the
 * terrain under them, that file fails first and says why.
 */
const DRY: ChunkCoord = { x: 2, z: 5, lod: 0 };
const SHORE: ChunkCoord = { x: 0, z: 3, lod: 0 };
const SUBMERGED: ChunkCoord = { x: 0, z: 0, lod: 0 };

describe('createChunkMesh', () => {
  it('places the mesh at the chunk origin, with chunk-local geometry', () => {
    const entry = build({ x: 3, z: -2, lod: 0 });
    expect(entry.mesh.position.x).toBe(3 * CHUNK_SIZE);
    // Y stays 0: vertex heights are absolute, so the mesh is never lifted.
    expect(entry.mesh.position.y).toBe(0);
    expect(entry.mesh.position.z).toBe(-2 * CHUNK_SIZE);
    disposeChunkMesh(entry);
  });

  it('sets explicit bounds so frustum culling works without scanning vertices', () => {
    const entry = build({ x: 0, z: 0, lod: 0 });
    expect(entry.geometry.boundingSphere).not.toBeNull();
    expect(entry.geometry.boundingBox).not.toBeNull();
    expect(entry.geometry.boundingSphere?.radius).toBeGreaterThan(CHUNK_SIZE / 2);
    disposeChunkMesh(entry);
  });

  it('bounds contain the real vertical extent of the terrain', () => {
    const entry = build({ x: 11, z: 7, lod: 0 });
    const box = entry.geometry.boundingBox as THREE.Box3;
    const position = entry.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeGreaterThanOrEqual(box.min.y - 1e-3);
      expect(position.getY(i)).toBeLessThanOrEqual(box.max.y + 1e-3);
    }
    // A flat box would mean minY/maxY were never wired up.
    expect(box.max.y - box.min.y).toBeGreaterThan(0.05);
    disposeChunkMesh(entry);
  });

  it('uploads normals and per-vertex colours', () => {
    const entry = build({ x: 2, z: 2, lod: 0 });
    const normal = entry.geometry.getAttribute('normal');
    const color = entry.geometry.getAttribute('color');
    const position = entry.geometry.getAttribute('position');
    expect(normal.count).toBe(position.count);
    expect(color.count).toBe(position.count);
    expect(entry.material.vertexColors).toBe(true);
    // Not one flat colour: the terrain palette must actually vary.
    const distinct = new Set<string>();
    for (let i = 0; i < color.count; i++) {
      distinct.add(`${color.getX(i).toFixed(4)},${color.getY(i).toFixed(4)}`);
    }
    expect(distinct.size).toBeGreaterThan(20);
    disposeChunkMesh(entry);
  });

  it('assigns a draw order that depends only on the coordinate', () => {
    // Without this, draw order is material creation order -- i.e. whichever
    // worker finished first -- and the wireframe screenshots stop reproducing.
    const a = build({ x: 4, z: 9, lod: 0 });
    const b = build({ x: 4, z: 9, lod: 0 });
    const c = build({ x: 5, z: 9, lod: 0 });
    const d = build({ x: 4, z: 10, lod: 0 });
    expect(a.mesh.renderOrder).toBe(b.mesh.renderOrder);
    expect(a.mesh.renderOrder).not.toBe(c.mesh.renderOrder);
    expect(a.mesh.renderOrder).not.toBe(d.mesh.renderOrder);
    // Exactly representable, so distinct chunks can never collide.
    expect(Number.isSafeInteger(a.mesh.renderOrder)).toBe(true);
    for (const entry of [a, b, c, d]) disposeChunkMesh(entry);
  });

  it('gives visibly different identity colours to different coordinates', () => {
    const a = build({ x: 0, z: 0, lod: 0 });
    const b = build({ x: 1, z: 0, lod: 0 });
    expect(a.color).not.toEqual(b.color);
    disposeChunkMesh(a);
    disposeChunkMesh(b);
  });

  it('reports its own triangle, vertex and byte counts', () => {
    // An INLAND node, so this measures the terrain cost alone. Seed 99 puts
    // deep water over the origin, which is convenient for the water tests below
    // and would silently inflate this one.
    const entry = build(DRY);
    expect(entry.waterTriangles).toBe(0);
    // 2048 surface triangles plus the apron's 512 (two windings), and 1089 surface
    // vertices plus its 132. Every node costs this at EVERY level -- which is
    // what makes node count, not triangle count, the thing the quadtree bounds.
    expect(entry.triangles).toBe(2560);
    expect(entry.vertices).toBe(1221);
    // positions + normals + colors (3 floats each) + indices (uint32).
    expect(entry.bytes).toBe(1221 * 3 * 4 * 3 + 2560 * 3 * 4);
    expect(entry.bytes).toBe(74676);
    disposeChunkMesh(entry);
  });

  it('extends the bounding box down to the bottom of the skirt', () => {
    // Frustum culling reads this box. Leave the apron out of it and the node is
    // culled exactly when its skirt is the only thing on screen -- at a level
    // boundary running off the bottom of the view.
    const entry = build({ x: 11, z: 7, lod: 3 });
    const box = entry.geometry.boundingBox as THREE.Box3;
    const data = generateChunk({ x: 11, z: 7, lod: 3 }, createTierContext(99, 'chunk'));
    expect(skirtDepthOf(data.positions)).toBeGreaterThan(0);
    expect(box.min.y).toBeCloseTo(data.minY - skirtDepthOf(data.positions), 3);
    disposeChunkMesh(entry);
  });

  it('gives nodes at different levels over the same square distinct draw orders', () => {
    // Both can be resident at once while a split or a merge streams in. If they
    // share a renderOrder the tie falls back to material id -- i.e. to whichever
    // worker finished first -- and the wireframe screenshots go flaky again.
    const orders = new Set<number>();
    for (let lod = 0; lod < 6; lod++) {
      const entry = build({ x: 0, z: 0, lod });
      expect(Number.isSafeInteger(entry.mesh.renderOrder)).toBe(true);
      orders.add(entry.mesh.renderOrder);
      disposeChunkMesh(entry);
    }
    expect(orders.size).toBe(6);
  });
});

describe('the water submesh', () => {
  it('is absent entirely on a node with no ground below sea level', () => {
    // THE budget discipline of Phase 3a. An inland node that built an empty
    // water mesh "for uniformity" would cost a draw call to draw nothing, and
    // most of the world is inland -- that is how a water phase doubles a
    // project's draw calls without rendering a single extra pixel.
    const entry = build(DRY);
    expect(entry.waterMesh).toBeNull();
    expect(entry.waterGeometry).toBeNull();
    expect(entry.waterMaterial).toBeNull();
    expect(entry.waterTriangles).toBe(0);
    expect(entry.mesh.children).toHaveLength(0);
    disposeChunkMesh(entry);
  });

  it('is present, transparent and vertex-coloured on a submerged node', () => {
    const entry = build(SUBMERGED);
    const water = entry.waterMesh as THREE.Mesh;
    const material = entry.waterMaterial as THREE.MeshLambertMaterial;
    expect(water).not.toBeNull();
    expect(material.transparent).toBe(true);
    expect(material.vertexColors).toBe(true);
    // Depth-writing transparent geometry occludes whatever is drawn after it.
    expect(material.depthWrite).toBe(false);
    // FOUR components, or Three ignores the alpha and the sea is a solid sheet.
    expect(entry.waterGeometry?.getAttribute('color').itemSize).toBe(4);
    expect(entry.waterTriangles).toBe(2048);
    disposeChunkMesh(entry);
  });

  it('lies exactly at sea level, everywhere, at every level', () => {
    // This is why water needs no skirt: two neighbours at any pair of levels
    // put their shared edge at the identical height, so nothing can crack.
    for (const lod of [0, 2, 4]) {
      const entry = build({ ...SUBMERGED, lod });
      const position = entry.waterGeometry?.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) expect(position.getY(i)).toBe(SEA_LEVEL);
      disposeChunkMesh(entry);
    }
  });

  it('rides along with the terrain mesh rather than being tracked separately', () => {
    // Parented, so every add / remove / dispose the streamer already performs
    // carries the water with it and cannot leave a sheet of sea behind.
    const entry = build(SUBMERGED);
    expect(entry.mesh.children).toContain(entry.waterMesh);
    const root = new THREE.Group();
    root.add(entry.mesh);
    root.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    (entry.waterMesh as THREE.Mesh).getWorldPosition(world);
    expect(world.x).toBe(0);
    expect(world.z).toBe(0);
    disposeChunkMesh(entry);
    expect(entry.mesh.parent).toBeNull();
    expect((entry.waterMesh as THREE.Mesh).parent).toBeNull();
  });

  it('gets the same coordinate-derived draw order as its terrain', () => {
    // Three sorts transparent draws by renderOrder and then by view depth, and
    // falls back to OBJECT ID -- worker completion order -- on a tie. A flat
    // surface makes ties easy to arrange, so the order is pinned to the
    // coordinate exactly as the opaque pass has been since Phase 1.
    const a = build(SUBMERGED);
    const b = build(SUBMERGED);
    const c = build({ x: 1, z: 0, lod: 0 });
    expect(a.waterMesh?.renderOrder).toBe(a.mesh.renderOrder);
    expect(a.waterMesh?.renderOrder).toBe(b.waterMesh?.renderOrder);
    expect(a.waterMesh?.renderOrder).not.toBe(c.waterMesh?.renderOrder);
    for (const entry of [a, b, c]) disposeChunkMesh(entry);
  });

  it('bounds only the part of the node that actually has water', () => {
    // A node with one submerged corner must not tell the frustum test it has a
    // node-sized sheet of sea, or it keeps a draw call it does not need.
    const shore = build(SHORE);
    const submerged = build(SUBMERGED);
    const shoreBox = shore.waterGeometry?.boundingBox as THREE.Box3;
    const fullBox = submerged.waterGeometry?.boundingBox as THREE.Box3;
    expect(shoreBox.min.y).toBe(SEA_LEVEL);
    expect(shoreBox.max.y).toBe(SEA_LEVEL);
    expect(fullBox.max.x - fullBox.min.x).toBe(CHUNK_SIZE);
    expect(shoreBox.max.x - shoreBox.min.x).toBeLessThanOrEqual(CHUNK_SIZE);
    // ...and it must still contain every water vertex it did emit.
    const position = shore.waterGeometry?.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      expect(position.getX(i)).toBeGreaterThanOrEqual(shoreBox.min.x);
      expect(position.getX(i)).toBeLessThanOrEqual(shoreBox.max.x);
      expect(position.getZ(i)).toBeGreaterThanOrEqual(shoreBox.min.z);
      expect(position.getZ(i)).toBeLessThanOrEqual(shoreBox.max.z);
    }
    disposeChunkMesh(shore);
    disposeChunkMesh(submerged);
  });

  it('carries an up-facing normal for every water vertex', () => {
    // Built here rather than shipped: 1,089 copies of +Y per coastal node is
    // pure redundancy in the payload budget. Without it a lit material shades
    // the sea black.
    const entry = build(SUBMERGED);
    const normal = entry.waterGeometry?.getAttribute('normal') as THREE.BufferAttribute;
    const position = entry.waterGeometry?.getAttribute('position') as THREE.BufferAttribute;
    expect(normal.count).toBe(position.count);
    for (let i = 0; i < normal.count; i++) {
      expect(normal.getX(i)).toBe(0);
      expect(normal.getY(i)).toBe(1);
      expect(normal.getZ(i)).toBe(0);
    }
    disposeChunkMesh(entry);
  });

  it('counts its triangles, vertices and bytes into the node total', () => {
    // Every water buffer must be accounted for, or the geometry budgets in the
    // soak silently stop covering half the geometry in the world.
    const entry = build(SUBMERGED);
    expect(entry.triangles).toBe(2560 + 2048);
    expect(entry.vertices).toBe(1221 + 1089);
    expect(entry.bytes).toBe(74676 + 1089 * 3 * 4 + 1089 * 4 * 4 + 2048 * 3 * 4);
    expect(entry.bytes).toBe(129744);
    disposeChunkMesh(entry);
  });

  it('is counted only while it is actually drawn', () => {
    // The soak's anti-vacuity guard rests on this counter, so it has to measure
    // rendering rather than residency.
    resetWaterDraws();
    expect(waterDrawsSinceReset()).toBe(0);
    const entry = build(SUBMERGED);
    expect(waterDrawsSinceReset()).toBe(0);
    (entry.waterMesh as THREE.Mesh).onBeforeRender(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    expect(waterDrawsSinceReset()).toBe(1);
    resetWaterDraws();
    expect(waterDrawsSinceReset()).toBe(0);
    disposeChunkMesh(entry);
  });
});

describe('hashPositions', () => {
  it('is identical for identically regenerated geometry (RULE 2)', () => {
    const a = build({ x: -6, z: 21, lod: 0 });
    const b = build({ x: -6, z: 21, lod: 0 });
    expect(a.geometryHash).toBe(b.geometryHash);
    disposeChunkMesh(a);
    disposeChunkMesh(b);
  });

  it('differs for different chunks', () => {
    const a = build({ x: -6, z: 21, lod: 0 });
    const b = build({ x: -6, z: 22, lod: 0 });
    expect(a.geometryHash).not.toBe(b.geometryHash);
    disposeChunkMesh(a);
    disposeChunkMesh(b);
  });

  it('notices a single flipped bit anywhere in the buffer', () => {
    // The whole point: if it did not, "byte-identical after a round trip" would
    // be a claim the check could not actually make.
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const before = hashPositions(positions);
    positions[4] = 5.000001;
    expect(hashPositions(positions)).not.toBe(before);
    positions[4] = 5;
    expect(hashPositions(positions)).toBe(before);
  });
});

describe('disposeChunkMesh', () => {
  it('disposes the geometry and the material, and detaches from the scene', () => {
    const entry = build();
    const parent = new THREE.Group();
    parent.add(entry.mesh);

    let geometryDisposed = 0;
    let materialDisposed = 0;
    entry.geometry.addEventListener('dispose', () => geometryDisposed++);
    entry.material.addEventListener('dispose', () => materialDisposed++);

    disposeChunkMesh(entry);

    expect(geometryDisposed).toBe(1);
    expect(materialDisposed).toBe(1);
    expect(parent.children).toHaveLength(0);
    expect(entry.mesh.parent).toBeNull();
  });

  it('disposes textures hanging off the material', () => {
    const entry = build();
    const texture = new THREE.Texture();
    let textureDisposed = 0;
    texture.addEventListener('dispose', () => textureDisposed++);
    entry.material.map = texture;

    disposeChunkMesh(entry);

    expect(textureDisposed).toBe(1);
  });
});
