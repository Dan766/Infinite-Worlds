/**
 * Placeholder scene content: one lit cube.
 *
 * Beyond being something to look at, it exists to prove the two registries work
 * before any real subsystem depends on them -- it registers a HUD line and a
 * debug toggle exactly the way Phase 1's chunk streamer will.
 *
 * Its colour is derived from the world seed, so changing `?seed=` produces a
 * visibly different result. That makes seed plumbing verifiable by eye.
 */

import * as THREE from 'three';
import { rngFromHash } from '../core/hash';
import { HudOrder, type Hud } from '../debug/hud';
import type { DebugPanel } from '../debug/panel';

/** Radians per second. Applied to sim time, never wall time. */
const SPIN_Y = 0.6;
const SPIN_X = 0.25;

export class CubeScene {
  readonly root = new THREE.Group();

  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;

  constructor(seedHash: number) {
    const rng = rngFromHash(seedHash);
    const color = new THREE.Color().setHSL(rng.float(), 0.55, 0.55);

    this.geometry = new THREE.BoxGeometry(2, 2, 2);
    this.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.root.add(this.mesh);
    this.root.name = 'cube';
  }

  /**
   * Orientation is a pure function of simulation time, so `?time=` reproduces
   * an exact pose and two screenshots of the same URL match.
   */
  update(simTime: number): void {
    this.mesh.rotation.set(simTime * SPIN_X, simTime * SPIN_Y, 0);
  }

  get enabled(): boolean {
    return this.root.visible;
  }

  setEnabled(enabled: boolean): void {
    this.root.visible = enabled;
  }

  get triangles(): number {
    const index = this.geometry.getIndex();
    const position = this.geometry.getAttribute('position');
    const vertexCount = index !== null ? index.count : position.count;
    return this.enabled ? vertexCount / 3 : 0;
  }

  /** Every subsystem registers its own HUD line and debug toggle. */
  registerDebug(hud: Hud, panel: DebugPanel): void {
    hud.register('cube tris', () => this.triangles, HudOrder.world);
    panel.folder('Cube').addToggle(
      'visible',
      () => this.enabled,
      (value) => this.setEnabled(value),
    );
  }

  dispose(): void {
    this.root.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
