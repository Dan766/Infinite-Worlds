/**
 * The sky, the stars, and the moon, as scene objects. Phase 10, slice 10.3.
 *
 * Three objects, drawn before everything else and writing no depth:
 *
 *   1. A `Sky` box (Preetham) carrying the atmosphere and the sun disc.
 *   2. A `Points` star field, visible only once the sun is far enough down.
 *   3. A camera-facing disc for the moon.
 *
 * ---------------------------------------------------------------------------
 * WHY `three/examples/jsm/objects/Sky.js` AND NOT A HAND-WRITTEN GRADIENT
 *
 * It ships inside the pinned `three` package with matching `@types/three`
 * declarations, so it adds nothing to `package.json` -- it is NOT the same kind
 * of decision as installing `postprocessing`, which is a separate package and
 * belongs to Phase 11.
 *
 * Two things make it worth more than a two-stop gradient. First, r185's copy
 * already contains a procedural CLOUD layer (`cloudCoverage`, `cloudDensity`,
 * `cloudElevation`, `cloudScale`, `cloudSpeed` and `time`), implemented as
 * fragment-shader value noise with ZERO textures -- so the phase's cloud
 * requirement arrives without introducing this project's first texture or its
 * first render target. Second, its fragment shader ends with
 * `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`, so it
 * goes through the same ACES curve and sRGB transfer the world does. The sky
 * and the ground agree by construction rather than by two tunings kept in step
 * by hand.
 *
 * ---------------------------------------------------------------------------
 * PREETHAM HAS NO NIGHT, AND THAT IS WHY THERE ARE THREE OBJECTS
 *
 * The Preetham model describes a daytime sky. Below the horizon it collapses
 * toward black, which is not wrong so much as useless: a player at midnight
 * would have no horizon, no orientation, and nothing to steer by. The stars and
 * the moon disc are what make night navigable, and the ambient floor in
 * `celestial.ts` is what keeps the ground under them from being a void.
 *
 * ---------------------------------------------------------------------------
 * DEPTH AND DRAW ORDER
 *
 * All three write no depth and are drawn before any world geometry, so they are
 * a backdrop that anything else paints over. That ordering is not cosmetic --
 * see `SKY_RENDER_ORDER`.
 */

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { CelestialState } from './celestial';
import { buildStarField, STAR_COUNT } from './star-field';

/**
 * WHY THIS NUMBER IS SO LARGE AND SO NEGATIVE.
 *
 * `chunk-mesh.ts` sorts world geometry into explicit bands to keep screenshots
 * byte-stable, and the terrain band is `chunkRenderOrder = (z * 4194304 + x) * 8
 * + lod` -- which is NEGATIVE for negative Z, down to roughly -2^46. A sky left
 * at the default `renderOrder = 0` would therefore sort into the MIDDLE of the
 * terrain, drawing after the chunks west and south of the origin and before the
 * ones east and north of it. It would look correct at the origin and wrong four
 * kilometres away, which is the worst kind of wrong.
 *
 * -(2^51) is below every existing band (+-2^46 terrain, +2^48 deck, +2^49
 * building, +2^50 prop), is exactly representable as a double, and disturbs
 * none of them.
 */
const SKY_RENDER_ORDER = -(2 ** 51);

/**
 * Edge length of the sky box, in metres.
 *
 * `BoxGeometry` here is a unit cube, so the faces sit 3500 m away and the
 * corners 6062 m. Both are inside the camera's 8000 m far plane and outside its
 * 0.5 m near plane, which is the only constraint that matters: the box writes
 * no depth and is drawn first, so its distance never decides what occludes what.
 */
const SKY_BOX_SCALE = 7000;

/** Stars sit just inside the box faces. */
const STAR_RADIUS = SKY_BOX_SCALE * 0.47;

/**
 * Star size in PIXELS -- `sizeAttenuation` is off, because a star has no
 * distance and must not shrink when the box is scaled.
 */
const STAR_SIZE_PX = 2;

/**
 * Angular radius of the moon disc, in degrees.
 *
 * The real moon is about a quarter of a degree. This is three times that,
 * which every game does and every photograph appears to: at a true half-degree
 * the moon is four pixels at 1280x720 and reads as a bright star rather than as
 * the moon.
 */
const MOON_ANGULAR_RADIUS_DEG = 0.85;

const MOON_RADIUS = STAR_RADIUS;
const MOON_DISC_SIZE = MOON_RADIUS * Math.tan((MOON_ANGULAR_RADIUS_DEG * Math.PI) / 180);

/** Default cloud cover, in [0, 1]. Exposed on the debug panel. */
export const CLOUD_COVERAGE_DEFAULT = 0.35;

// ---------------------------------------------------------------------------
// Anti-vacuity counters
// ---------------------------------------------------------------------------

/**
 * Sky boxes actually rasterised since the last reset.
 *
 * THE SAME GUARD AS `waterDraws` IN `chunk-mesh.ts`, for the same reason. A sky
 * that is configured, positioned, updated every frame and never submitted looks
 * identical from JavaScript to one that is working; the only difference is on
 * screen. `onBeforeRender` fires once per object that survives culling and is
 * actually submitted, so counting it measures "the sky reached the rasteriser"
 * rather than "a sky object exists".
 *
 * It matters more here than for water, because this object is the one thing in
 * the scene whose failure mode is a picture that still looks plausible -- the
 * clear colour behind it is a dark blue that could pass for a night sky.
 */
let skyDraws = 0;

/**
 * Star fields actually rasterised since the last reset.
 *
 * Non-zero ONLY at night, because the object is made invisible in daylight. So
 * this counter carries two claims at once: the stars drew, and the flight
 * actually reached a time of day dark enough for them. The soak asserts it
 * rises above zero, which is what stops a "night works" claim from being made
 * by a run that never saw one.
 */
let starDraws = 0;

/** Moon discs actually rasterised since the last reset. */
let moonDraws = 0;

export function skyDrawsSinceReset(): number {
  return skyDraws;
}

export function starDrawsSinceReset(): number {
  return starDraws;
}

export function moonDrawsSinceReset(): number {
  return moonDraws;
}

/** Call immediately before `renderer.render` to scope the counts to one frame. */
export function resetSkyDraws(): void {
  skyDraws = 0;
  starDraws = 0;
  moonDraws = 0;
}

// ---------------------------------------------------------------------------

export class SkyDome {
  readonly root = new THREE.Group();

  private readonly sky: Sky;
  private readonly backdrop: THREE.Mesh;
  private readonly backdropMaterial: THREE.MeshBasicMaterial;
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly moon: THREE.Mesh;
  private readonly moonMaterial: THREE.MeshBasicMaterial;

  private cloudCoverage = CLOUD_COVERAGE_DEFAULT;

  constructor(starCount: number = STAR_COUNT) {
    // Painted BEFORE the Preetham dome and blended over additively. See
    // `CelestialState.backdrop`: Preetham's `sunIntensity` hits exactly zero at
    // a 92.3 degree zenith angle, so from 2.3 degrees below the horizon down
    // the dome is pure black and this is the entire sky. Slightly smaller than
    // the dome, though only for tidiness -- neither writes depth, so it is the
    // render order and not the geometry that decides which is behind.
    this.backdropMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.backdropMaterial);
    this.backdrop.scale.setScalar(SKY_BOX_SCALE * 0.98);
    this.backdrop.renderOrder = SKY_RENDER_ORDER - 1;
    this.backdrop.frustumCulled = false;
    this.backdrop.matrixAutoUpdate = false;

    this.sky = new Sky();
    // Additive, so the dome is SKYGLOW added to the night sky rather than a
    // replacement for it. By day the backdrop is exactly black and this is a
    // no-op; by night the dome contributes nothing and the backdrop is the sky.
    this.sky.material.transparent = true;
    this.sky.material.blending = THREE.AdditiveBlending;
    this.sky.scale.setScalar(SKY_BOX_SCALE);
    this.sky.renderOrder = SKY_RENDER_ORDER;
    // The box always contains the camera, so culling it can only ever be wrong.
    this.sky.frustumCulled = false;
    this.sky.matrixAutoUpdate = false;
    this.sky.onBeforeRender = countSkyDraw;

    const u = this.sky.material.uniforms;
    // Clearer than the addon's defaults: this world is a wide green landscape
    // and a hazy sky reads as pollution over it rather than as distance.
    setUniform(u, 'turbidity', 2.2);
    setUniform(u, 'rayleigh', 1.4);
    setUniform(u, 'mieCoefficient', 0.005);
    setUniform(u, 'mieDirectionalG', 0.8);
    setUniform(u, 'cloudCoverage', this.cloudCoverage);

    const field = buildStarField(starCount);
    const positions = new Float32Array(field.count * 3);
    for (let i = 0; i < positions.length; i++) {
      positions[i] = (field.directions[i] as number) * STAR_RADIUS;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(field.colors, 3));
    // Set by hand: the extents are known, and a sphere of stars centred on the
    // camera can never be culled anyway.
    starGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS);

    this.starMaterial = new THREE.PointsMaterial({
      size: STAR_SIZE_PX,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // A star is outside the atmosphere; fogging it would tint the night sky
      // with the colour of the ground haze.
      fog: false,
    });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.renderOrder = SKY_RENDER_ORDER + 1;
    this.stars.frustumCulled = false;
    this.stars.matrixAutoUpdate = false;
    this.stars.visible = false;
    this.stars.onBeforeRender = countStarDraw;

    this.moonMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(MOON_DISC_SIZE, 24), this.moonMaterial);
    this.moon.renderOrder = SKY_RENDER_ORDER + 2;
    this.moon.frustumCulled = false;
    this.moon.matrixAutoUpdate = false;
    this.moon.visible = false;
    this.moon.onBeforeRender = countMoonDraw;

    this.root.add(this.backdrop, this.sky, this.stars, this.moon);
    this.root.matrixAutoUpdate = false;
  }

  get clouds(): number {
    return this.cloudCoverage;
  }

  setClouds(coverage: number): void {
    this.cloudCoverage = Math.max(0, Math.min(1, coverage));
    setUniform(this.sky.material.uniforms, 'cloudCoverage', this.cloudCoverage);
  }

  get starsVisible(): boolean {
    return this.stars.visible;
  }

  setStarsEnabled(enabled: boolean): void {
    this.starMaterial.visible = enabled;
  }

  /**
   * Follow the camera and take the sky's state for this frame.
   *
   * `simTime` drives the cloud drift, so the clouds are a pure function of the
   * simulation clock like everything else -- a frozen loop holds them still and
   * `?time=` reproduces an exact cloud pattern.
   */
  update(state: CelestialState, cameraPosition: THREE.Vector3, simTime: number): void {
    this.backdrop.position.copy(cameraPosition);
    this.backdrop.updateMatrix();
    this.backdropMaterial.color.setRGB(
      state.backdrop.r,
      state.backdrop.g,
      state.backdrop.b,
      THREE.SRGBColorSpace,
    );

    this.sky.position.copy(cameraPosition);
    this.sky.updateMatrix();

    const u = this.sky.material.uniforms;
    const sunPosition = u['sunPosition']?.value as THREE.Vector3 | undefined;
    sunPosition?.set(state.sun.direction.x, state.sun.direction.y, state.sun.direction.z);
    setUniform(u, 'time', simTime);
    // Hide the disc once it is below the horizon, or its bloom bleeds up
    // through the ground line after sunset.
    setUniform(u, 'showSunDisc', state.sun.elevationDeg > -1 ? 1 : 0);

    this.stars.position.copy(cameraPosition);
    this.stars.updateMatrix();
    this.starMaterial.opacity = state.starVisibility;
    // Invisible above the fade start, so a daylit frame costs nothing at all
    // for the star field -- not a draw call, not a blend, not a vertex.
    this.stars.visible = this.starMaterial.visible && state.starVisibility > 0;

    // The moon is drawn whenever it is up and lit; its LIGHT is the `dominant`
    // source in `celestial.ts` and is applied by `atmosphere.ts`, not here.
    const litAndUp = state.moonIllumination > 0.02 && state.moon.elevationDeg > -2;
    this.moon.visible = litAndUp;
    if (litAndUp) {
      const d = state.moon.direction;
      this.moon.position.set(
        cameraPosition.x + d.x * MOON_RADIUS,
        cameraPosition.y + d.y * MOON_RADIUS,
        cameraPosition.z + d.z * MOON_RADIUS,
      );
      this.moon.lookAt(cameraPosition);
      this.moon.updateMatrix();
      // Fades with the phase and with the last few degrees above the horizon,
      // so a setting crescent does not wink out.
      this.moonMaterial.opacity =
        state.moonIllumination * Math.min(1, (state.moon.elevationDeg + 2) / 6);
    }
  }

  dispose(): void {
    this.backdrop.geometry.dispose();
    this.backdropMaterial.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.moon.geometry.dispose();
    this.moonMaterial.dispose();
    this.root.clear();
  }
}

// ---------------------------------------------------------------------------

const countSkyDraw = (): void => {
  skyDraws++;
};

const countStarDraw = (): void => {
  starDraws++;
};

const countMoonDraw = (): void => {
  moonDraws++;
};

/**
 * Write a scalar uniform if the addon still declares it.
 *
 * `Sky`'s uniform set is an addon's, not a stable public API, and the cloud
 * uniforms in particular arrived recently. A missing name should cost a
 * slightly plainer sky, not a `TypeError` that takes the whole frame down.
 */
function setUniform(
  uniforms: Record<string, THREE.IUniform | undefined>,
  name: string,
  value: number,
): void {
  const uniform = uniforms[name];
  if (uniform !== undefined) uniform.value = value;
}
