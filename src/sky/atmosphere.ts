/**
 * The sky, as scene objects. Phase 10.
 *
 * This is the Three-side adapter over `celestial.ts`: it owns the lights, and
 * from slice 10.3 onward the sky dome and the fog, and it does exactly one
 * thing per frame -- ask `celestialAt(simTime)` where the sun is and copy the
 * answer onto them. Every decision about WHAT the sky looks like lives in the
 * pure module; this file only knows how to say it in Three.
 *
 * It replaces `App.addLighting()`, which since Phase 0 has been a hemisphere
 * light and a directional light at a fixed angle with a comment saying not to
 * build on it.
 *
 * ---------------------------------------------------------------------------
 * ONE DIRECTIONAL LIGHT, NOT TWO
 *
 * There is a sun and there is a moon, but there is only ever ONE directional
 * light in the scene: `celestial.ts` picks whichever body is currently the
 * brighter and reports it as `dominant`. Two lights would mean two shadow
 * rigs from slice 10.5, both of them running every frame so that one of them
 * could be dark. The swap happens when both bodies are near the horizon and
 * both are contributing almost nothing, and the hemisphere light carries the
 * frame across it.
 *
 * The `HemisphereLight` is the ambient floor and never goes to zero -- see
 * `AMBIENT_INTENSITY_NIGHT`. A world that renders literally black is one where
 * a broken light rig and a correct midnight are the same picture.
 *
 * ---------------------------------------------------------------------------
 * THE LIGHT HAS AN EXPLICIT TARGET
 *
 * The Phase 0 placeholder set `sun.position` and left `sun.target` at its
 * default, which is an `Object3D` at the origin that is never added to the
 * scene. That works by accident for a light whose direction happens to be its
 * position, and stops working the moment the light needs to follow the camera
 * -- which it does from slice 10.5, because a shadow camera has to be near what
 * it is shadowing. So the target is created here, added to the scene, and both
 * it and the light are moved together every frame.
 */

import * as THREE from 'three';
import type { DebugFolder, DebugPanel } from '../debug/panel';
import type { Hud } from '../debug/hud';
import { HudOrder } from '../debug/hud';
import {
  celestialAt,
  DAY_LENGTH_SECONDS,
  TOD_AT_TIME_ZERO,
  type CelestialState,
  type Rgb,
  type Vec3,
} from './celestial';
import { SkyDome } from './sky-dome';

/**
 * How far in front of the camera the directional light is parked.
 *
 * A directional light has no position in the physics sense -- only a direction
 * -- so this number is invisible until slice 10.5 gives it a shadow camera,
 * at which point it decides where the cascades are centred. Kept here from the
 * start so the light and its target are already moving together by then.
 */
const LIGHT_DISTANCE = 200;

export interface AtmosphereOptions {
  /** Time of day at sim time zero. Comes from `?tod=`. */
  todAtZero: number;
}

export class Atmosphere {
  readonly root = new THREE.Group();

  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly lightTarget = new THREE.Object3D();
  private readonly dome = new SkyDome();

  private todAtZero: number;
  private dayLength = DAY_LENGTH_SECONDS;
  private paused = false;
  private starsEnabled = true;
  /** Sim time the sky is frozen at while `paused`. */
  private heldSimTime = 0;

  private state: CelestialState;

  constructor(options: Partial<AtmosphereOptions> = {}) {
    this.todAtZero = options.todAtZero ?? TOD_AT_TIME_ZERO;

    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.target = this.lightTarget;

    this.root.add(this.hemisphere, this.sunLight, this.lightTarget, this.dome.root);
    // The group holds only lights and (from 10.3) the sky dome, none of which
    // are ever culled or picked, so Three never needs to walk it for bounds.
    this.root.matrixAutoUpdate = false;

    this.state = celestialAt(0, this.todAtZero);
    this.apply(new THREE.Vector3(), 0);
  }

  /** The sky's current state. Read by the HUD and by `perfSnapshot`. */
  get current(): CelestialState {
    return this.state;
  }

  /**
   * Advance the sky to a sim time.
   *
   * Sim time, not wall time: `Loop.simTime` is `tick * fixedDt`, so a paused
   * loop holds the sun still and `?time=` seeks it. That is the entire reason
   * the 68 canonical screenshots stay reproducible with a moving sun in the
   * world -- they are all captured with `?freeze=1`.
   */
  update(simTime: number, cameraPosition: THREE.Vector3): void {
    const t = this.paused ? this.heldSimTime : simTime;
    this.heldSimTime = t;
    this.state = celestialAt(scaleTime(t, this.dayLength), this.todAtZero);
    this.apply(cameraPosition, t);
  }

  dispose(): void {
    this.hemisphere.dispose();
    this.sunLight.dispose();
    this.dome.dispose();
    this.root.clear();
  }

  registerDebug(hud: Hud, panel: DebugPanel): void {
    hud.register(
      'sky',
      () => {
        const s = this.state;
        return `${formatClock(s.todHours)}  sun ${signed(s.sun.elevationDeg)}  moon ${signed(
          s.moon.elevationDeg,
        )}  moon ${(s.moonIllumination * 100).toFixed(0)}% lit`;
      },
      HudOrder.world,
    );

    const folder = panel.folder('Sky');
    this.registerControls(folder);
  }

  /** Split out so slices 10.3-10.6 can add their controls to the same folder. */
  protected registerControls(folder: DebugFolder): void {
    folder.addNumber(
      'time of day',
      () => this.state.todHours,
      (hours) => this.setTimeOfDay(hours),
      { min: 0, max: 24, step: 0.05 },
    );
    folder.addToggle(
      'sky paused',
      () => this.paused,
      (v) => {
        this.paused = v;
      },
    );
    folder.addNumber(
      'day length (s)',
      () => this.dayLength,
      (v) => {
        // Holding the CURRENT hour across the change keeps the scrubber from
        // jumping the sky whenever the speed is adjusted.
        const hours = this.state.todHours;
        this.dayLength = Math.max(1, v);
        this.setTimeOfDay(hours);
      },
      { min: 60, max: 7200, step: 10 },
    );
    folder.addNumber(
      'clouds',
      () => this.dome.clouds,
      (v) => this.dome.setClouds(v),
      { min: 0, max: 1, step: 0.01 },
    );
    folder.addToggle(
      'stars',
      () => this.starsEnabled,
      (v) => {
        this.starsEnabled = v;
        this.dome.setStarsEnabled(v);
      },
    );
  }

  /**
   * Re-phase the cycle so that the CURRENT sim time reads as `hours`.
   *
   * The scrubber moves `todAtZero`, not sim time: sim time belongs to the loop
   * and is what NPCs and the cube step on, so dragging a lighting control must
   * not teleport the simulation. It also means the panel's "copy link to this
   * view" serialises the result as `?tod=`, which reproduces exactly.
   */
  setTimeOfDay(hours: number): void {
    const elapsed = scaleTime(this.heldSimTime, this.dayLength) / DAY_LENGTH_SECONDS;
    const drift = elapsed * 24;
    const next = hours - drift;
    this.todAtZero = next - Math.floor(next / 24) * 24;
    this.state = celestialAt(scaleTime(this.heldSimTime, this.dayLength), this.todAtZero);
  }

  /** The `?tod=` value that would reproduce the current sky. */
  get todParam(): number {
    return this.todAtZero;
  }

  private apply(cameraPosition: THREE.Vector3, simTime: number): void {
    const s = this.state;
    this.dome.update(s, cameraPosition, simTime);

    copyRgb(this.hemisphere.color, s.ambientSky);
    copyRgb(this.hemisphere.groundColor, s.ambientGround);
    this.hemisphere.intensity = s.ambientIntensity;

    copyRgb(this.sunLight.color, s.dominant.color);
    this.sunLight.intensity = s.dominant.intensity;
    setFromDirection(this.sunLight.position, cameraPosition, s.dominant.direction, LIGHT_DISTANCE);
    this.lightTarget.position.copy(cameraPosition);
    this.lightTarget.updateMatrixWorld();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rescale sim time so `celestialAt` -- which is written against the fixed
 * `DAY_LENGTH_SECONDS` -- sees the day length the panel currently asks for.
 *
 * Done here rather than by threading a day length through `celestial.ts`,
 * because the pure module's constant is what the tests, the soak and the
 * canonical hours are all reasoned about; a runtime-variable day length is a
 * debug affordance and should not be able to change what `?time=3` means.
 */
function scaleTime(simTime: number, dayLength: number): number {
  return dayLength === DAY_LENGTH_SECONDS ? simTime : (simTime * DAY_LENGTH_SECONDS) / dayLength;
}

function copyRgb(target: THREE.Color, rgb: Rgb): void {
  target.setRGB(rgb.r, rgb.g, rgb.b, THREE.SRGBColorSpace);
}

/** Park an object `distance` along `direction` from `origin`. */
function setFromDirection(
  target: THREE.Vector3,
  origin: THREE.Vector3,
  direction: Vec3,
  distance: number,
): void {
  target.set(
    origin.x + direction.x * distance,
    origin.y + direction.y * distance,
    origin.z + direction.z * distance,
  );
}

function formatClock(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function signed(degrees: number): string {
  return `${degrees >= 0 ? '+' : ''}${degrees.toFixed(1)}`;
}
