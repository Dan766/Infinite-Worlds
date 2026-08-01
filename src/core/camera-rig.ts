/**
 * Minimal free-fly camera.
 *
 * Included in Phase 0 because `?pos=` and `?look=` would otherwise be
 * write-only: with no way to move, there is no way to find a viewpoint worth
 * capturing, and the panel's "copy link" would have nothing to copy.
 *
 * Note that the camera keeps moving while the simulation is frozen. Freezing is
 * for inspecting a world state from any angle, so pausing the camera too would
 * defeat the purpose.
 *
 * Controls: WASD to move, Q/E down/up, Shift to sprint, click to capture the
 * mouse, Escape to release.
 */

import * as THREE from 'three';
import type { LookParams, Vec3Params } from './params';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const PITCH_LIMIT = 89 * DEG_TO_RAD;

export interface CameraRigOptions {
  fov: number;
  near: number;
  far: number;
  speed: number;
  sprintMultiplier: number;
  /** Radians of rotation per pixel of mouse movement. */
  lookSensitivity: number;
}

/**
 * `far` must clear the streamer's view distance or the quadtree's outermost
 * ring is generated and then clipped away, which costs everything and shows
 * nothing. 8 km is the default 4 km view distance with room for the panel to
 * turn it up, and 0.5 m near keeps the depth ratio at 16,000:1 -- tight enough
 * that two overlapping nodes at 4 km do not z-fight during a level transition.
 * The Phase 0 0.1 m near would have made that ratio 80,000:1.
 */
const DEFAULTS: CameraRigOptions = {
  fov: 60,
  near: 0.5,
  far: 8000,
  speed: 6,
  sprintMultiplier: 6,
  lookSensitivity: 0.0022,
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private readonly options: CameraRigOptions;
  private readonly keys = new Set<string>();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();

  private yaw: number;
  private pitch: number;
  private element: HTMLElement | null = null;
  private pointerLocked = false;
  private enabled = true;

  constructor(pos: Vec3Params, look: LookParams, options: Partial<CameraRigOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.camera = new THREE.PerspectiveCamera(
      this.options.fov,
      1,
      this.options.near,
      this.options.far,
    );
    this.camera.position.set(pos.x, pos.y, pos.z);
    this.yaw = look.yaw * DEG_TO_RAD;
    this.pitch = clampPitch(look.pitch * DEG_TO_RAD);
    this.applyRotation();
  }

  get position(): Vec3Params {
    const { x, y, z } = this.camera.position;
    return { x, y, z };
  }

  /** Yaw and pitch in degrees, matching the `?look=` parameter format. */
  get look(): LookParams {
    return { yaw: this.yaw * RAD_TO_DEG, pitch: this.pitch * RAD_TO_DEG };
  }

  /** Place the camera directly. Used by the autopilot, which owns the X axis. */
  setPosition(x: number, y: number, z: number): void {
    this.camera.position.set(x, y, z);
  }

  /**
   * Aim the camera directly, in degrees. Used by `npm run soak`, which flies
   * one leg at a steep pitch and one near the horizon: the geometry budgets
   * mean nothing measured looking straight down, where frustum culling throws
   * away almost the entire world.
   */
  setLook(yawDegrees: number, pitchDegrees: number): void {
    this.yaw = yawDegrees * DEG_TO_RAD;
    this.pitch = clampPitch(pitchDegrees * DEG_TO_RAD);
    this.applyRotation();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.keys.clear();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  attach(element: HTMLElement): void {
    this.detach();
    this.element = element;
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  detach(): void {
    if (this.element === null) return;
    this.element.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.element = null;
    this.keys.clear();
  }

  /** Advance the camera by `dt` seconds of wall-clock time. */
  update(dt: number): void {
    if (!this.enabled || this.keys.size === 0) return;

    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.move.set(0, 0, 0);

    if (this.keys.has('KeyW')) this.move.add(this.forward);
    if (this.keys.has('KeyS')) this.move.sub(this.forward);
    if (this.keys.has('KeyD')) this.move.add(this.right);
    if (this.keys.has('KeyA')) this.move.sub(this.right);
    if (this.keys.has('KeyE')) this.move.y += 1;
    if (this.keys.has('KeyQ')) this.move.y -= 1;

    if (this.move.lengthSq() === 0) return;

    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = this.options.speed * (sprinting ? this.options.sprintMultiplier : 1);
    this.camera.position.addScaledVector(this.move.normalize(), speed * dt);
  }

  private applyRotation(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private readonly onMouseDown = (): void => {
    if (!this.enabled || this.element === null) return;
    void this.element.requestPointerLock();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.element;
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked || !this.enabled) return;
    this.yaw -= event.movementX * this.options.lookSensitivity;
    this.pitch = clampPitch(this.pitch - event.movementY * this.options.lookSensitivity);
    this.applyRotation();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    // Leave modified shortcuts to the browser.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}

function clampPitch(pitch: number): number {
  return Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pitch));
}
