/**
 * The debug political world map. Phase Politics P4.
 *
 * Renders a top-down canvas of `polity.ts`'s territory partition -- filled
 * nations, borders, and city markers -- so the whole political layer (P1-P3)
 * can be eyeballed before it changes a single vertex of the actual world
 * (Phase S). Hidden by default; shown with `?map=1` or the debug panel.
 *
 * ---------------------------------------------------------------------------
 * TWO CLASSES, AND WHY
 *
 * `WorldMapField` does the actual sampling. It is pure -- no Three.js, no DOM
 * -- and runs identically in a Node test and in the browser, the same
 * discipline every module in `src/world/` follows. `WorldMap` is a thin
 * wrapper that owns a real `<canvas>` element and blits `WorldMapField`'s
 * pixel buffer into it. Splitting them is what makes the sampling logic
 * testable at all: this project's Vitest config runs in a plain Node
 * environment with no jsdom, so a class that touched `document` on
 * construction would be untestable outright.
 *
 * ---------------------------------------------------------------------------
 * THE ONE HARD CONSTRAINT: NEVER CALL `sampleHeight`
 *
 * `sampleHeight` routes through `mainFields()` (`height-field.ts`), which
 * synchronously builds a Region's rivers and roads on first touch -- tens of
 * milliseconds, sometimes more. A 256x256 map calls its height function
 * 65,536 times per full build; at even a fraction of that cost the tab would
 * hang for minutes. `WorldMapField` therefore only ever calls the injected
 * `terrain.height`, which the browser wrapper below binds to `baseHeight` --
 * never `sampleHeight` -- exactly as `polity.ts`'s own siting does, and for
 * the same reason. `world-map.test.ts` asserts the source text of this file
 * never mentions `sampleHeight` at all, on top of the field's own tests
 * proving it only ever calls its injected terrain.
 *
 * ---------------------------------------------------------------------------
 * INCREMENTAL BUILDING
 *
 * `WorldMapField.step(budgetMs)` builds a bounded number of rows and returns,
 * so `WorldMap.update()` can be called once per frame with a couple of
 * milliseconds of budget and never cost more than that -- the same "small
 * bounded chunk of work per frame" discipline `chunk-streamer.ts` uses for
 * chunk residency, applied to pixels instead of chunks.
 */

import { hash2i } from '../core/hash';
import { baseHeight, continentalness, habitability, humidity, SEA_LEVEL, temperature } from '../world/height-field';
import { hashUnit } from '../world/noise';
import {
  citiesInBox,
  polityAt,
  polityOfCity,
  type CitySite,
  type Polity,
  type PolityTerrain,
} from '../world/polity';
import { cultureIdAt } from '../world/culture';
import { nationName, settlementName } from '../world/names';

// ---------------------------------------------------------------------------
// The climate this module needs
// ---------------------------------------------------------------------------

/**
 * A superset of `polity.ts`'s `PolityClimate` -- structurally compatible with
 * it, so a `WorldMapClimate` can be passed anywhere a `PolityClimate` is
 * expected -- plus `temperature`/`humidity`, which `culture.ts`'s
 * `cultureIdAt` needs to bias a nation's culture toward its capital's actual
 * climate. Declared here, not imported from `height-field.ts`, so
 * `WorldMapField` stays injectable with synthetic climates in tests.
 */
export interface WorldMapClimate {
  continentalness(x: number, z: number, worldSeed: number): number;
  habitability(x: number, z: number, worldSeed: number): number;
  temperature(x: number, z: number, worldSeed: number): number;
  humidity(x: number, z: number, worldSeed: number): number;
}

export interface WorldMapDeps {
  /** MUST be `baseHeight` in production -- see the module header. */
  readonly terrain: PolityTerrain;
  readonly climate: WorldMapClimate;
  readonly worldSeed: number;
}

export interface WorldMapOptions {
  /** Pixels along one edge of the square view. Default 256. */
  readonly size?: number;
  /** World metres per pixel. Default 128 (a 32.77 km view at the default size). */
  readonly metresPerPixel?: number;
}

const DEFAULT_SIZE = 256;
const DEFAULT_METRES_PER_PIXEL = 128;

/**
 * Fraction of the view's half-width the camera may drift before the map
 * re-centres and restarts its incremental build. Small enough that the map
 * never falls far behind the camera; large enough that ordinary walking
 * speed (this project's player moves at a few m/s) does not thrash a rebuild
 * every frame.
 */
const RECENTER_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const SEA_COLOR: readonly [number, number, number] = [26, 46, 74];
const UNCLAIMED_COLOR: readonly [number, number, number] = [58, 58, 50];
const BORDER_COLOR: readonly [number, number, number] = [12, 12, 12];
const CITY_MARKER_COLOR: readonly [number, number, number] = [246, 244, 232];

const MAP_COLOR_SALT = 0x4d61_7043; // 'MapC'

/**
 * Standard piecewise-linear HSL to RGB -- no trigonometry, consistent with
 * this project's determinism rule even though a debug overlay's pixels are
 * never a stored vertex and RULE 1 does not strictly reach them.
 */
function hslToRgb(hueDegrees: number, saturation: number, lightness: number): [number, number, number] {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = hueDegrees / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = lightness - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function polityColor(polityId: number): [number, number, number] {
  const hue = hashUnit(hash2i(polityId, 0, MAP_COLOR_SALT)) * 360;
  return hslToRgb(hue, 0.5, 0.4);
}

// ---------------------------------------------------------------------------
// A political label at a point -- standalone so it needs no field or canvas
// ---------------------------------------------------------------------------

/**
 * A short human-readable label for whatever owns a point: `'Sea'`,
 * `'Unclaimed wilderness'`, or a nation's name (with a `(city-state)` suffix
 * when its polity has no members beyond its own capital).
 */
export function politicalLabelAt(
  x: number,
  z: number,
  terrain: PolityTerrain,
  climate: WorldMapClimate,
  worldSeed: number,
): string {
  const y = terrain.height(x, z, worldSeed);
  if (y < terrain.seaLevel) return 'Sea';
  const polity = polityAt(x, z, terrain, climate, worldSeed);
  if (polity === undefined) return 'Unclaimed wilderness';
  const nation = polityDisplayName(polity, climate, worldSeed);
  return polity.isCityState ? `${nation} (city-state)` : nation;
}

function polityDisplayName(polity: Polity, climate: WorldMapClimate, worldSeed: number): string {
  const cultureId = cultureIdAt(
    polity.capitalCellX,
    polity.capitalCellZ,
    worldSeed,
    climate.temperature(polity.capitalX, polity.capitalZ, worldSeed),
    climate.humidity(polity.capitalX, polity.capitalZ, worldSeed),
  );
  return nationName(cultureId, polity.capitalCellX, polity.capitalCellZ, worldSeed);
}

// ---------------------------------------------------------------------------
// WorldMapField: the pure, testable sampler
// ---------------------------------------------------------------------------

export class WorldMapField {
  readonly width: number;
  readonly height: number;
  /** RGBA, `width * height * 4` bytes. Owned; callers read it, never replace it. */
  readonly pixels: Uint8ClampedArray;

  private readonly terrain: PolityTerrain;
  private readonly climate: WorldMapClimate;
  private readonly worldSeedValue: number;
  private metresPerPixelValue: number;

  /** Where the CURRENT build is centred. Set by `recenter`, read by `step`. */
  private builtCenterX = 0;
  private builtCenterZ = 0;
  /** Next pixel index to paint, row-major. `>= width * height` means done. */
  private cursor = 0;
  /** -1: sea or unclaimed. >= 0: a real `Polity.polityId`, truncated for the equality check only. */
  private readonly polityIdBuffer: Float64Array;

  constructor(deps: WorldMapDeps, options: WorldMapOptions = {}) {
    this.terrain = deps.terrain;
    this.climate = deps.climate;
    this.worldSeedValue = deps.worldSeed >>> 0;
    this.width = options.size ?? DEFAULT_SIZE;
    this.height = this.width;
    this.metresPerPixelValue = options.metresPerPixel ?? DEFAULT_METRES_PER_PIXEL;
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    this.polityIdBuffer = new Float64Array(this.width * this.height).fill(-1);
  }

  get worldSeed(): number {
    return this.worldSeedValue;
  }

  get metresPerPixel(): number {
    return this.metresPerPixelValue;
  }

  get centerX(): number {
    return this.builtCenterX;
  }

  get centerZ(): number {
    return this.builtCenterZ;
  }

  /** True once every pixel of the current view has been painted. */
  get done(): boolean {
    return this.cursor >= this.width * this.height;
  }

  setScale(metresPerPixel: number): void {
    if (metresPerPixel === this.metresPerPixelValue) return;
    this.metresPerPixelValue = metresPerPixel;
    this.restart(this.builtCenterX, this.builtCenterZ);
  }

  /**
   * Re-centre on the camera if it has drifted far enough to matter. Cheap
   * and safe to call every frame -- most calls are a no-op comparison.
   */
  recenter(cameraX: number, cameraZ: number): void {
    const halfSpan = (this.width / 2) * this.metresPerPixelValue;
    const dx = cameraX - this.builtCenterX;
    const dz = cameraZ - this.builtCenterZ;
    const drifted =
      Math.abs(dx) > halfSpan * RECENTER_FRACTION || Math.abs(dz) > halfSpan * RECENTER_FRACTION;
    if (drifted || (this.cursor === 0 && this.builtCenterX === 0 && this.builtCenterZ === 0)) {
      this.restart(cameraX, cameraZ);
    }
  }

  private restart(centerX: number, centerZ: number): void {
    this.builtCenterX = centerX;
    this.builtCenterZ = centerZ;
    this.cursor = 0;
  }

  private originX(): number {
    return this.builtCenterX - (this.width / 2) * this.metresPerPixelValue;
  }

  private originZ(): number {
    return this.builtCenterZ - (this.height / 2) * this.metresPerPixelValue;
  }

  /**
   * Advance the build for up to `budgetMs` of wall-clock time, then return
   * `done`. The clock is checked once per row rather than once per pixel --
   * `performance.now()` is itself not free, and a row is a fine enough grain
   * for a budget meant in whole milliseconds.
   */
  step(budgetMs: number): boolean {
    const start = performance.now();
    const total = this.width * this.height;
    const originX = this.originX();
    const originZ = this.originZ();

    while (this.cursor < total) {
      const px = this.cursor % this.width;
      const pz = (this.cursor - px) / this.width;
      this.paintPixel(px, pz, originX, originZ);
      this.cursor++;
      if (px === this.width - 1 && performance.now() - start >= budgetMs) break;
    }

    if (this.done) this.paintCities(originX, originZ);
    return this.done;
  }

  private paintPixel(px: number, pz: number, originX: number, originZ: number): void {
    const x = originX + (px + 0.5) * this.metresPerPixelValue;
    const z = originZ + (pz + 0.5) * this.metresPerPixelValue;
    const cell = pz * this.width + px;
    const idx = cell * 4;

    const y = this.terrain.height(x, z, this.worldSeedValue);
    let color: readonly [number, number, number];
    let polityId = -1;
    if (y < this.terrain.seaLevel) {
      color = SEA_COLOR;
    } else {
      const polity = polityAt(x, z, this.terrain, this.climate, this.worldSeedValue);
      if (polity === undefined) {
        color = UNCLAIMED_COLOR;
      } else {
        polityId = polity.polityId;
        color = polityColor(polity.polityId);
      }
    }
    this.polityIdBuffer[cell] = polityId;

    // A border marks a CLAIMED/CLAIMED transition only: two different patches
    // of unclaimed land, or unclaimed land meeting the sea, is not a border.
    // Only the LEFT and TOP neighbours are checked -- both already painted in
    // this row-major build order -- so this is a one-sided edge detector, not
    // a full boundary trace. Good enough to prove borders exist and are not
    // straight lines; a future minimap doing more than that should difference
    // the finished buffer in both directions instead.
    let isBorder = false;
    if (polityId !== -1) {
      if (px > 0) {
        const leftId = this.polityIdBuffer[cell - 1] as number;
        if (leftId !== -1 && leftId !== polityId) isBorder = true;
      }
      if (!isBorder && pz > 0) {
        const topId = this.polityIdBuffer[cell - this.width] as number;
        if (topId !== -1 && topId !== polityId) isBorder = true;
      }
    }
    if (isBorder) color = BORDER_COLOR;

    this.pixels[idx] = color[0];
    this.pixels[idx + 1] = color[1];
    this.pixels[idx + 2] = color[2];
    this.pixels[idx + 3] = 255;
  }

  private paintCities(originX: number, originZ: number): void {
    for (const city of this.citiesInView()) {
      const px = Math.round((city.x - originX) / this.metresPerPixelValue);
      const pz = Math.round((city.z - originZ) / this.metresPerPixelValue);
      this.markDot(px, pz);
    }
  }

  private markDot(px: number, pz: number): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx;
        const z = pz + dz;
        if (x < 0 || z < 0 || x >= this.width || z >= this.height) continue;
        const idx = (z * this.width + x) * 4;
        this.pixels[idx] = CITY_MARKER_COLOR[0];
        this.pixels[idx + 1] = CITY_MARKER_COLOR[1];
        this.pixels[idx + 2] = CITY_MARKER_COLOR[2];
        this.pixels[idx + 3] = 255;
      }
    }
  }

  /** Every city whose coarse cell overlaps the current view. */
  citiesInView(): readonly CitySite[] {
    const originX = this.originX();
    const originZ = this.originZ();
    return citiesInBox(
      originX,
      originZ,
      originX + this.width * this.metresPerPixelValue,
      originZ + this.height * this.metresPerPixelValue,
      this.terrain,
      this.climate,
      this.worldSeedValue,
    );
  }

  /** Where a city falls in the current view, in pixel coordinates (may be off-canvas). */
  screenPositionOf(city: CitySite): { px: number; pz: number } {
    return {
      px: (city.x - this.originX()) / this.metresPerPixelValue,
      pz: (city.z - this.originZ()) / this.metresPerPixelValue,
    };
  }

  /** A city's settlement name, resolved through the polity (hence culture) that owns it. */
  nameOfCity(city: CitySite): string {
    const polity = polityOfCity(city, this.terrain, this.climate, this.worldSeedValue);
    const cultureId = cultureIdAt(
      polity.capitalCellX,
      polity.capitalCellZ,
      this.worldSeedValue,
      this.climate.temperature(polity.capitalX, polity.capitalZ, this.worldSeedValue),
      this.climate.humidity(polity.capitalX, polity.capitalZ, this.worldSeedValue),
    );
    return settlementName(cultureId, city.siteCellX, city.siteCellZ, this.worldSeedValue);
  }

  /** A nation or city-state's display name. */
  nameOfPolity(polity: Polity): string {
    return polityDisplayName(polity, this.climate, this.worldSeedValue);
  }

  /** Same rule `politicalLabelAt` implements, bound to this field's own terrain/climate/seed. */
  labelAt(x: number, z: number): string {
    return politicalLabelAt(x, z, this.terrain, this.climate, this.worldSeedValue);
  }
}

// ---------------------------------------------------------------------------
// WorldMap: the browser wrapper
// ---------------------------------------------------------------------------

/**
 * The real-world climate binding: `baseHeight` -- NEVER `sampleHeight`, see
 * the module header -- plus the four biome fields `WorldMapClimate` needs.
 * A module-level constant, not a fresh literal per `WorldMap`, for the same
 * reason `roads.ts`'s `WORLD_TERRAIN` is: nothing here is memoised, but
 * keeping one shared binding avoids a second source of truth for "what is
 * the ground" ever creeping in.
 */
const REAL_TERRAIN: PolityTerrain = { seaLevel: SEA_LEVEL, height: baseHeight };
const REAL_CLIMATE: WorldMapClimate = { continentalness, habitability, temperature, humidity };

export interface WorldMapConstructorOptions extends WorldMapOptions {
  readonly visible?: boolean;
}

/**
 * Owns a `<canvas>` element positioned in the corner of the viewport and
 * blits a `WorldMapField`'s pixel buffer into it. Never touches Three.js --
 * this is a 2D debug overlay, drawn independently of the render loop's own
 * scene graph, the same way `Hud` and `DebugPanel` are.
 */
export class WorldMap {
  readonly element: HTMLCanvasElement;

  private readonly field: WorldMapField;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private isVisible: boolean;

  constructor(worldSeed: number, options: WorldMapConstructorOptions = {}) {
    this.field = new WorldMapField(
      { terrain: REAL_TERRAIN, climate: REAL_CLIMATE, worldSeed },
      options,
    );

    this.element = document.createElement('canvas');
    this.element.width = this.field.width;
    this.element.height = this.field.height;
    this.element.className = 'world-map';
    Object.assign(this.element.style, {
      position: 'fixed',
      right: '8px',
      bottom: '8px',
      width: `${this.field.width}px`,
      height: `${this.field.height}px`,
      zIndex: '10',
      borderRadius: '4px',
      imageRendering: 'pixelated',
      border: '1px solid rgba(255, 255, 255, 0.25)',
      pointerEvents: 'none',
    });

    const ctx = this.element.getContext('2d');
    if (ctx === null) throw new Error('WorldMap: 2D canvas context unavailable');
    this.ctx = ctx;
    this.imageData = ctx.createImageData(this.field.width, this.field.height);

    this.isVisible = options.visible ?? false;
    this.applyVisibility();
  }

  get visible(): boolean {
    return this.isVisible;
  }

  get metresPerPixel(): number {
    return this.field.metresPerPixel;
  }

  setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.element.style.display = this.isVisible ? '' : 'none';
  }

  setScale(metresPerPixel: number): void {
    this.field.setScale(metresPerPixel);
  }

  /** A short label for whatever is under the camera, for the HUD. */
  labelAt(x: number, z: number): string {
    return this.field.labelAt(x, z);
  }

  /**
   * Advance the incremental build toward the camera's current position and
   * repaint the canvas. Cheap to call every frame: hidden, or once the
   * current view is fully built, this is a couple of comparisons and an
   * early return.
   */
  update(cameraX: number, cameraZ: number, budgetMs = 2): void {
    if (!this.isVisible) return;
    this.field.recenter(cameraX, cameraZ);
    if (this.field.done) return;
    this.field.step(budgetMs);
    this.imageData.data.set(this.field.pixels);
    this.ctx.putImageData(this.imageData, 0, 0);
    this.drawLabels();
  }

  private drawLabels(): void {
    this.ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    this.ctx.textBaseline = 'top';
    for (const city of this.field.citiesInView()) {
      const { px, pz } = this.field.screenPositionOf(city);
      if (px < -40 || px > this.field.width + 40 || pz < -12 || pz > this.field.height + 12) continue;
      this.ctx.fillText(this.field.nameOfCity(city), px + 3, pz + 2);
    }
  }

  dispose(): void {
    this.element.remove();
  }
}
