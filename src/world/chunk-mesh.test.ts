/**
 * Disposal is the whole reason this file has tests: a chunk that is merely
 * dropped from a Map leaves its GPU buffers alive, and that is precisely the
 * leak the five-minute flat-heap criterion exists to catch.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createChunkMesh, disposeChunkMesh } from './chunk-mesh';
import { generateChunk } from './chunk-gen';
import { CHUNK_SIZE, createTierContext, type ChunkCoord } from './contracts';

const build = (coord: ChunkCoord = { x: 0, z: 0 }): ReturnType<typeof createChunkMesh> =>
  createChunkMesh(generateChunk(coord, createTierContext(99, 'chunk')));

describe('createChunkMesh', () => {
  it('places the mesh at the chunk origin, with chunk-local geometry', () => {
    const entry = build({ x: 3, z: -2 });
    expect(entry.mesh.position.x).toBe(3 * CHUNK_SIZE);
    expect(entry.mesh.position.y).toBe(0);
    expect(entry.mesh.position.z).toBe(-2 * CHUNK_SIZE);
    disposeChunkMesh(entry);
  });

  it('sets explicit bounds so frustum culling works without scanning vertices', () => {
    const entry = build({ x: 0, z: 0 });
    expect(entry.geometry.boundingSphere).not.toBeNull();
    expect(entry.geometry.boundingBox).not.toBeNull();
    expect(entry.geometry.boundingSphere?.radius).toBeGreaterThan(CHUNK_SIZE / 2);
    disposeChunkMesh(entry);
  });

  it('assigns a draw order that depends only on the coordinate', () => {
    // Without this, draw order is material creation order -- i.e. whichever
    // worker finished first -- and the wireframe screenshots stop reproducing.
    const a = build({ x: 4, z: 9 });
    const b = build({ x: 4, z: 9 });
    const c = build({ x: 5, z: 9 });
    const d = build({ x: 4, z: 10 });
    expect(a.mesh.renderOrder).toBe(b.mesh.renderOrder);
    expect(a.mesh.renderOrder).not.toBe(c.mesh.renderOrder);
    expect(a.mesh.renderOrder).not.toBe(d.mesh.renderOrder);
    // Exactly representable, so distinct chunks can never collide.
    expect(Number.isSafeInteger(a.mesh.renderOrder)).toBe(true);
    for (const entry of [a, b, c, d]) disposeChunkMesh(entry);
  });

  it('gives visibly different colours to different coordinates', () => {
    const a = build({ x: 0, z: 0 });
    const b = build({ x: 1, z: 0 });
    expect(a.material.color.getHex()).not.toBe(b.material.color.getHex());
    disposeChunkMesh(a);
    disposeChunkMesh(b);
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
