/**
 * Disposal is the whole reason this file has tests: a chunk that is merely
 * dropped from a Map leaves its GPU buffers alive, and that is precisely the
 * leak the five-minute flat-heap criterion exists to catch.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createChunkMesh, disposeChunkMesh, hashPositions } from './chunk-mesh';
import { generateChunk } from './chunk-gen';
import { CHUNK_SIZE, createTierContext, type ChunkCoord } from './contracts';

const build = (coord: ChunkCoord = { x: 0, z: 0, lod: 0 }): ReturnType<typeof createChunkMesh> =>
  createChunkMesh(generateChunk(coord, createTierContext(99, 'chunk')));

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
    const entry = build();
    expect(entry.triangles).toBe(2048);
    expect(entry.vertices).toBe(1089);
    // positions + normals + colors (3 floats each) + indices (uint32).
    expect(entry.bytes).toBe(1089 * 3 * 4 * 3 + 2048 * 3 * 4);
    disposeChunkMesh(entry);
  });
});

describe('hashPositions', () => {
  it('is identical for identically regenerated geometry (RULE 2)', () => {
    const a = build({ x: -6, z: 21, lod: 0 });
    const b = build({ x: -6, z: 21, lod: 0 });
    expect(a.positionsHash).toBe(b.positionsHash);
    disposeChunkMesh(a);
    disposeChunkMesh(b);
  });

  it('differs for different chunks', () => {
    const a = build({ x: -6, z: 21, lod: 0 });
    const b = build({ x: -6, z: 22, lod: 0 });
    expect(a.positionsHash).not.toBe(b.positionsHash);
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
