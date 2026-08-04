import * as THREE from 'three';
import type { CameraRig } from './camera-rig';
import type { WorldCollision } from '../world/collision';

const EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.42;
const WALK_SPEED = 5.2;
const SPRINT_MULTIPLIER = 1.65;
const GRAVITY = 22;
const LOOK_SENSITIVITY = 0.0022 * (180 / Math.PI);

/** Grounded first-person controller used by `?walk=1`. */
export class PlayerController {
  private readonly keys = new Set<string>();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly movement = new THREE.Vector3();
  private element: HTMLElement | null = null;
  private verticalVelocity = 0;

  constructor(
    private readonly rig: CameraRig,
    private readonly collision: WorldCollision,
  ) {}

  attach(element: HTMLElement): void {
    this.detach();
    this.element = element;
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  detach(): void {
    if (this.element === null) return;
    this.element.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.element = null;
    this.keys.clear();
  }

  update(dt: number): void {
    const camera = this.rig.camera;
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() > 0) this.forward.normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);
    this.movement.set(0, 0, 0);
    if (this.keys.has('KeyW')) this.movement.add(this.forward);
    if (this.keys.has('KeyS')) this.movement.sub(this.forward);
    if (this.keys.has('KeyD')) this.movement.add(this.right);
    if (this.keys.has('KeyA')) this.movement.sub(this.right);
    if (this.movement.lengthSq() > 0) {
      const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = WALK_SPEED * (sprint ? SPRINT_MULTIPLIER : 1);
      this.movement.normalize().multiplyScalar(speed * dt);
      const moved = this.collision.move(
        camera.position.x,
        camera.position.z,
        camera.position.x + this.movement.x,
        camera.position.z + this.movement.z,
        PLAYER_RADIUS,
      );
      camera.position.x = moved.x;
      camera.position.z = moved.z;
    }

    const floor = this.collision.groundHeight(camera.position.x, camera.position.z) + EYE_HEIGHT;
    this.verticalVelocity -= GRAVITY * dt;
    camera.position.y += this.verticalVelocity * dt;
    if (camera.position.y <= floor) {
      camera.position.y = floor;
      this.verticalVelocity = 0;
    }
  }

  private readonly onMouseDown = (): void => {
    if (this.element !== null) void this.element.requestPointerLock();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.element) return;
    const look = this.rig.look;
    this.rig.setLook(
      look.yaw - event.movementX * LOOK_SENSITIVITY,
      look.pitch - event.movementY * LOOK_SENSITIVITY,
    );
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
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
