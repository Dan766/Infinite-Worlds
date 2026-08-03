/**
 * The one rule in `renderer.ts` that can be tested without a GPU.
 *
 * `applyWireframe` carries the fix for the Phase 5 screenshot instability:
 * WebGL has no `POLYGON_OFFSET_LINE`, so a material asking for a polygon offset
 * while being drawn as lines has undefined depth, and SwiftShader's answer
 * depended on GPU-process state that outlived the page. Every wireframe
 * canonical view containing a deck was therefore unreproducible.
 *
 * These assertions are the invariant that fix rests on, and both halves matter:
 * the offset must be GONE in wireframe (otherwise the flake is back) and it must
 * COME BACK when wireframe goes off (otherwise every shaded view changes, which
 * is how we know the offset is doing real work in the first place).
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyWireframe } from './renderer';

function meshWith(material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BufferGeometry(), material);
}

function offsetMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
}

describe('applyWireframe', () => {
  it('turns wireframe on and off across a subtree', () => {
    const scene = new THREE.Scene();
    const parent = meshWith(new THREE.MeshLambertMaterial());
    const child = meshWith(new THREE.MeshLambertMaterial());
    parent.add(child);
    scene.add(parent);

    applyWireframe(scene, true);
    expect((parent.material as THREE.MeshLambertMaterial).wireframe).toBe(true);
    expect((child.material as THREE.MeshLambertMaterial).wireframe).toBe(true);

    applyWireframe(scene, false);
    expect((parent.material as THREE.MeshLambertMaterial).wireframe).toBe(false);
    expect((child.material as THREE.MeshLambertMaterial).wireframe).toBe(false);
  });

  it('drops a requested polygon offset in wireframe and restores it after', () => {
    const material = offsetMaterial();
    const scene = new THREE.Scene();
    scene.add(meshWith(material));

    applyWireframe(scene, true);
    expect(material.polygonOffset).toBe(false);

    applyWireframe(scene, false);
    expect(material.polygonOffset).toBe(true);
    // The magnitudes are never touched: they are what the deck needs when it is
    // filled, and forgetting them would be the same bug in the other direction.
    expect(material.polygonOffsetFactor).toBe(-1);
    expect(material.polygonOffsetUnits).toBe(-2);
  });

  it('survives repeated toggles, which is how the debug panel drives it', () => {
    const material = offsetMaterial();
    const scene = new THREE.Scene();
    scene.add(meshWith(material));

    for (let i = 0; i < 4; i++) {
      applyWireframe(scene, true);
      expect(material.polygonOffset).toBe(false);
      applyWireframe(scene, false);
      expect(material.polygonOffset).toBe(true);
    }
  });

  it('leaves a material that never asked for an offset alone', () => {
    // The important half: nothing may hand an offset to the terrain, which is
    // the surface the deck is offset AGAINST. `polygonOffset` defaults to false,
    // so a bug that recorded the wireframe value as the requested one would show
    // up here as the terrain acquiring an offset the moment wireframe goes off.
    const material = new THREE.MeshLambertMaterial();
    const scene = new THREE.Scene();
    scene.add(meshWith(material));

    applyWireframe(scene, true);
    expect(material.polygonOffset).toBe(false);
    applyWireframe(scene, false);
    expect(material.polygonOffset).toBe(false);
  });

  it('starts in filled mode without losing the offset', () => {
    // `Renderer` applies the state before the first frame, and `?wireframe=1` is
    // the rarer path -- so the first call is normally `false`, and it must not
    // record "off" as what the material wanted.
    const material = offsetMaterial();
    const scene = new THREE.Scene();
    scene.add(meshWith(material));

    applyWireframe(scene, false);
    expect(material.polygonOffset).toBe(true);
    applyWireframe(scene, true);
    expect(material.polygonOffset).toBe(false);
    applyWireframe(scene, false);
    expect(material.polygonOffset).toBe(true);
  });
});
