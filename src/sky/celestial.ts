/**
 * Where the sun and moon are, and what colour the world is because of it.
 *
 * Phase 10. This module is PURE: it imports nothing, touches no Three.js, and
 * is a total function of `(simTime, todAtZero)`. `sky-dome.ts` and
 * `atmosphere.ts` are the Three-side adapters that consume it, exactly the
 * `WorldMapField` / `WorldMap` split in `src/debug/world-map.ts` and the
 * `interior-mesh.ts` / `interior-overlay.ts` split in `src/world/`. Vitest runs
 * in a plain Node environment with no jsdom, so a module that imported Three at
 * top level to reach a `Vector3` would be untestable outright -- hence the
 * local `Vec3` / `Rgb` records below rather than Three's types.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN `sky/` AND NOT IN `world/`
 *
 * Everything under `src/world/` is content that is a pure function of a
 * COORDINATE and belongs to a tier under RULE 3. The sun belongs to no tier and
 * has no coordinate: it is a pure function of TIME. That is a different axis,
 * and mixing it into `world/` would put something in the Region/Sector/Chunk
 * hierarchy that has no place in it.
 *
 * ---------------------------------------------------------------------------
 * RULE 1 AND `Math.sin`
 *
 * The conventions forbid `Math.sin` / `cos` / `pow` on any path that ends in a
 * stored vertex, because those are the operations whose last bit is allowed to
 * differ between JavaScript engines. Nothing here ends in a vertex: a sun
 * direction is per-frame render state that never enters a `ChunkData` payload,
 * never reaches `chunkDataBytes`, and is not covered by the soak's geometry
 * hash. So trig is fine here and the ban still stands everywhere it was aimed.
 * `star-field.ts` is the module in this directory that DOES emit vertices, and
 * it is written to the stricter rule -- see its header.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM, AND THE ONE CONSTANT THAT PROTECTS THE BASELINES
 *
 * The 68 canonical screenshots are all captured with `?freeze=1`, so their sim
 * time is exactly `?time=` and never advances. Their time of day is therefore a
 * constant per view, and `TOD_AT_TIME_ZERO` is what decides whether that
 * constant is daylight or midnight. 67 of the 68 run at `?time=3` and one at
 * `?time=0`; at the values below those are 09:30 and 09:33.6 -- mid-morning,
 * sun a little over 40 degrees up. Change `TOD_AT_TIME_ZERO` and every baseline
 * moves. `celestial.test.ts` asserts both hours land in daylight, so the guard
 * is a failing test rather than 68 black PNGs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A direction or point. Deliberately not `THREE.Vector3` -- see the header. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * sRGB-encoded RGB in [0, 1] -- the same convention a `0x9fc4e8` hex literal
 * carries when Three reads it, which is how every colour in this project has
 * been authored since Phase 0. `atmosphere.ts` hands these to `Color.setRGB`
 * with `SRGBColorSpace`, so Three converts to its linear working space exactly
 * as it did for the placeholder rig's hex constants. Authoring these by eye in
 * linear space instead would make every constant below unreadable for no gain.
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface LightSource {
  /** Unit vector pointing FROM the world TOWARD the body. */
  readonly direction: Vec3;
  /** Angle above the horizon in degrees; negative when the body has set. */
  readonly elevationDeg: number;
  readonly color: Rgb;
  /** Zero once the body is far enough below the horizon to contribute nothing. */
  readonly intensity: number;
}

export interface CelestialState {
  /** Time of day in [0, 24). */
  readonly todHours: number;
  readonly sun: LightSource;
  readonly moon: LightSource;
  /**
   * The single shadow-casting source: the sun while it is up, the moon once the
   * sun is down, crossfaded through twilight. ONE directional rig, not two --
   * see `atmosphere.ts`. Its `direction` is always unit length even at the
   * crossover, so the shadow camera never degenerates.
   */
  readonly dominant: LightSource;
  /** Hemisphere light, upper half. */
  readonly ambientSky: Rgb;
  /** Hemisphere light, lower half. */
  readonly ambientGround: Rgb;
  /** Never reaches zero -- see `AMBIENT_INTENSITY_NIGHT`. */
  readonly ambientIntensity: number;
  /** Sky colour at the horizon. The fog takes this so terrain dissolves INTO the sky. */
  readonly horizon: Rgb;
  /**
   * The sky BEHIND the Preetham dome, which is what a night sky actually is.
   *
   * Preetham is a daytime model and has a hard cutoff built into it: its
   * `sunIntensity` reaches exactly zero at a zenith angle of 92.3 degrees, so
   * the dome renders pure black from 2.3 degrees below the horizon downward. It
   * is not a night sky that is too dark, it is no night sky at all.
   *
   * So `sky-dome.ts` paints this colour first and blends the dome over it
   * ADDITIVELY, which is what skyglow physically is. It is scaled by the
   * inverse of the daylight term, so it is a deep blue at midnight and exactly
   * black by day -- at which point the dome is the only thing contributing and
   * nothing has been lifted.
   */
  readonly backdrop: Rgb;
  /** `FogExp2` density. */
  readonly fogDensity: number;
  /** 0 in daylight, 1 in full night. Drives the star field's opacity. */
  readonly starVisibility: number;
  /** Fraction of the moon's disc that is lit, in [0, 1]. */
  readonly moonIllumination: number;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Sim seconds in one full 24-hour cycle.
 *
 * CHOSEN FROM THE SOAK, NOT FROM TASTE. `npm run soak` flies for 300 seconds,
 * which at this rate is six hours of world time. Starting it at `?tod=15.5`
 * (see `scripts/soak.mjs`) covers 15:30 to 21:30 -- long afternoon shadows, a
 * sunset, and real night -- so ONE flight makes the daytime shadow counter and
 * the star counter non-vacuous at the same time. Shorter and the sun visibly
 * strobes across a screenshot session; longer and the soak never reaches night
 * without a second run.
 */
export const DAY_LENGTH_SECONDS = 1200;

/** Time of day, in hours, at sim time zero. See the header for why 9.5. */
export const TOD_AT_TIME_ZERO = 9.5;

/**
 * Time of day for a sim time, wrapped into [0, 24).
 *
 * Sim time, never wall clock: `Loop.simTime` is `tick * fixedDt`, so this is
 * pausable, single-steppable, and seekable with `?time=`, and a screenshot of
 * it is reproducible. A wall-clock sky would make all 68 baselines unstable by
 * construction.
 *
 * Negative sim times cannot occur (`parseParams` clamps `?time=` at zero) but
 * the floor-based wrap handles them anyway rather than returning a negative
 * hour that would index off the end of every colour ramp below.
 */
export function timeOfDayHours(simTime: number, todAtZero: number = TOD_AT_TIME_ZERO): number {
  const hours = todAtZero + (simTime / DAY_LENGTH_SECONDS) * 24;
  return hours - Math.floor(hours / 24) * 24;
}

// ---------------------------------------------------------------------------
// Where the sun is
// ---------------------------------------------------------------------------

/**
 * Fixed latitude. Temperate, matching the medieval-European settlement content
 * the world already generates. Combined with the declination below it puts the
 * midday sun at 90 - |42 - 8| = 56 degrees: high enough to light the ground
 * properly, low enough that buildings always cast a shadow with some length to
 * it. A latitude near the equator would put the sun overhead at noon and delete
 * the shadows this phase exists to add.
 */
export const LATITUDE_DEG = 42;

/**
 * Fixed solar declination -- there are no seasons, deliberately.
 *
 * Seasons would need a second, slower clock and a year length, and every
 * canonical screenshot would then depend on both. Eight degrees is a little
 * past the equinox, so days run slightly longer than nights and the sun's arc
 * is not perfectly symmetric about noon, which reads as more natural than a
 * dead-on equinox for no extra state.
 */
export const SOLAR_DECLINATION_DEG = 8;

/** The moon rides the opposite tilt, so a full moon is high when the sun is low. */
const LUNAR_DECLINATION_DEG = -SOLAR_DECLINATION_DEG;

/** Sim days in one new-moon-to-new-moon cycle. */
export const MOON_PHASE_PERIOD_DAYS = 29.5;

const DEG = Math.PI / 180;

const SIN_LAT = Math.sin(LATITUDE_DEG * DEG);
const COS_LAT = Math.cos(LATITUDE_DEG * DEG);

/**
 * A body's direction from the hour angle and declination, in world axes.
 *
 * The standard equatorial-to-horizon transform, written as a direct vector
 * rather than as an altitude and an azimuth. Going through an azimuth means
 * dividing by `cos(altitude)`, which is a removable singularity at the zenith
 * that this latitude never reaches but that someone would eventually hit by
 * changing `LATITUDE_DEG`. The vector form has no division at all.
 *
 * World axes: +X is east, +Z is north, +Y is up. At noon a northern-hemisphere
 * sun is therefore up and toward -Z, and it travels from +X to -X across the
 * day -- which is why `celestial.test.ts` asserts the sign of `direction.x`
 * before and after noon.
 */
function bodyDirection(hourAngleDeg: number, declinationDeg: number): Vec3 {
  const h = hourAngleDeg * DEG;
  const d = declinationDeg * DEG;
  const sinDec = Math.sin(d);
  const cosDec = Math.cos(d);
  const cosH = Math.cos(h);

  const east = -cosDec * Math.sin(h);
  const north = sinDec * COS_LAT - cosDec * cosH * SIN_LAT;
  const up = sinDec * SIN_LAT + cosDec * cosH * COS_LAT;

  return { x: east, y: up, z: north };
}

/** Hour angle in degrees: zero at local noon, 15 degrees per hour. */
function hourAngleOf(todHours: number): number {
  return (todHours - 12) * 15;
}

/**
 * Elevation in degrees from a unit direction's Y component.
 *
 * `asin` rather than a stored altitude because `bodyDirection` never computes
 * an altitude in the first place, and the only consumer that wants degrees is
 * the HUD and the twilight ramps below.
 */
function elevationOf(direction: Vec3): number {
  return Math.asin(Math.max(-1, Math.min(1, direction.y))) / DEG;
}

/** Unit direction toward the sun at a given time of day. Exported for tests. */
export function sunDirectionAt(todHours: number): Vec3 {
  return bodyDirection(hourAngleOf(todHours), SOLAR_DECLINATION_DEG);
}

/**
 * The moon's phase in [0, 1): 0 is new, 0.5 is full.
 *
 * A pure function of sim time like everything else here, so `?time=` reproduces
 * an exact moon and the phase is not a hidden piece of mutable state.
 */
export function moonPhase(simTime: number): number {
  const days = simTime / (DAY_LENGTH_SECONDS * MOON_PHASE_PERIOD_DAYS);
  return days - Math.floor(days);
}

/** Lit fraction of the moon's disc, in [0, 1]. Full at phase 0.5. */
export function moonIlluminationOf(phase: number): number {
  return (1 - Math.cos(phase * 2 * Math.PI)) / 2;
}

/**
 * Unit direction toward the moon.
 *
 * The moon lags the sun by its phase: at new moon it shares the sun's hour
 * angle, at full moon it is a full twelve hours behind and therefore rises as
 * the sun sets. That is the one property that has to be right for a night to
 * look coherent, and it costs one subtraction.
 */
export function moonDirectionAt(todHours: number, phase: number): Vec3 {
  return bodyDirection(hourAngleOf(todHours) - phase * 360, LUNAR_DECLINATION_DEG);
}

// ---------------------------------------------------------------------------
// Colour and intensity ramps
// ---------------------------------------------------------------------------

/**
 * Every ramp below is keyed on ELEVATION, not on the hour.
 *
 * Keying on the hour would need dawn and dusk hardcoded, and they would then be
 * wrong the moment `LATITUDE_DEG` or `SOLAR_DECLINATION_DEG` moved. Keying on
 * elevation makes sunrise and sunset symmetric and correct for free, at any
 * latitude, with no second copy of the orbital model.
 */

/** Peak directional intensity, at the sun's highest elevation of the day. */
export const SUN_INTENSITY_NOON = 3.4;

/** Directional intensity of a full moon at its highest. */
export const MOON_INTENSITY_FULL = 0.42;

/** Hemisphere intensity in full daylight. */
export const AMBIENT_INTENSITY_DAY = 1.0;

/**
 * Hemisphere intensity at midnight. NOT ZERO, deliberately.
 *
 * A world that goes literally black is one where a lighting bug and a correct
 * night are the same picture, and where `shots:check`'s "fewer than four
 * distinct colours" guard fires on a frame that is working as intended. This
 * floor keeps night navigable and keeps a black frame diagnostic.
 *
 * MUCH CLOSER TO THE DAYTIME VALUE THAN A PHYSICAL MODEL WOULD PUT IT, for two
 * reasons that were measured rather than argued.
 *
 * 1. ACES HAS A VERY STEEP TOE. Its fit maps a scene value of 0.0098 to
 *    0.00102 -- a ten-fold crush -- so anything landing below roughly 0.05
 *    before tone mapping is black on screen however carefully it was computed.
 *    Three successive guesses at a "realistic" floor (0.12, 0.18, 0.5) all
 *    rendered the night ground at 0-2 out of 255, because the arithmetic behind
 *    them ignored the toe. Without eye adaptation -- which needs a
 *    post-processing chain, and is Phase 11's -- a fixed exposure has to be
 *    chosen for one end of the day, and this is the compensation for choosing
 *    the bright end.
 *
 * 2. Ambient is not what makes daytime bright; the SUN is, at
 *    `SUN_INTENSITY_NOON` against an ambient of 1. So a modest day-to-night
 *    ambient ratio still leaves the day several times brighter overall, and the
 *    dynamic range lands where it belongs -- on the thing that casts shadows.
 *
 * Measured at the same pixel of the same view, RGB out of 255: noon
 * (134,156,73), dusk (18,19,6), midnight around (8,24,13) -- dark, still
 * recognisably grass, and readable against the horizon.
 */
export const AMBIENT_INTENSITY_NIGHT = 0.64;

/** Sun elevation at which the disc's DIRECT light is fully gone. */
const SUN_SET_FADE_DEG = -6;

/**
 * Elevations over which SKYLIGHT fades, which is a different and much longer
 * ramp than the sun disc's.
 *
 * These must not share a curve, and the first draft of this file made that
 * mistake: driving the ambient term off `sunLightFalloff` meant the world was
 * essentially black thirteen minutes after sunset, because the direct ramp is
 * finished by -6 degrees. In reality the sky goes on lighting the ground long
 * after the sun is out of sight -- that is what civil and nautical twilight
 * ARE -- and -12 degrees is the conventional end of usable twilight. Keeping
 * two ramps costs one extra `smooth` per frame and is the whole difference
 * between a dusk and a power cut.
 */
const SKYLIGHT_FADE_FULL_DEG = -12;
const SKYLIGHT_FADE_START_DEG = 8;

/** Star ramp: nothing above this, fully out below `STAR_FADE_FULL_DEG`. */
export const STAR_FADE_START_DEG = -4;
export const STAR_FADE_FULL_DEG = -12;

/** `FogExp2` density in clear daylight. See `atmosphere.ts` for the sums. */
export const FOG_DENSITY_CLEAR = 1 / 5200;

/** Dawn and dusk haze, as a multiple of `FOG_DENSITY_CLEAR`. */
const FOG_DENSITY_TWILIGHT_SCALE = 1.6;
/** Night haze, as a multiple of `FOG_DENSITY_CLEAR`. */
const FOG_DENSITY_NIGHT_SCALE = 1.25;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear remap of `v` from [a, b] into [0, 1], clamped at both ends. */
function ramp(v: number, a: number, b: number): number {
  return clamp01((v - a) / (b - a));
}

/** Hermite ease. Used for colour blends where a linear seam is visible. */
function smooth(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

function rgb(hex: number): Rgb {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
  };
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const c = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * c,
    g: a.g + (b.g - a.g) * c,
    b: a.b + (b.b - a.b) * c,
  };
}

/** Three-stop ramp: `low` below `midDeg`, `high` above `highDeg`. */
function rampRgb(elevationDeg: number, low: Rgb, mid: Rgb, high: Rgb, midDeg: number, highDeg: number): Rgb {
  if (elevationDeg <= midDeg) {
    return mixRgb(low, mid, smooth(ramp(elevationDeg, midDeg - 8, midDeg)));
  }
  return mixRgb(mid, high, smooth(ramp(elevationDeg, midDeg, highDeg)));
}

const SUN_COLOR_HORIZON = rgb(0xff8c42);
const SUN_COLOR_LOW = rgb(0xffd9a0);
const SUN_COLOR_HIGH = rgb(0xfff6e8);

const MOON_COLOR = rgb(0xaec4e8);

/**
 * THE HEMISPHERE COLOURS CARRY HUE; `ambientIntensity` CARRIES BRIGHTNESS.
 *
 * Getting this wrong is the second mistake this file made. The first draft
 * ramped the night sky colour down to `0x1a2438` -- a colour that is dark
 * because it encodes both "blue" and "not much of it" -- and then ALSO
 * multiplied it by a night intensity of 0.12. The two attenuations compounded
 * to an effective ambient around 0.02 and midnight came out as a black frame,
 * which is exactly the failure `AMBIENT_INTENSITY_NIGHT` exists to prevent.
 *
 * So these are kept at roughly comparable RELATIVE LUMINANCE -- around 0.45 to
 * 0.52 in linear terms -- and differ almost entirely in hue: blue at night,
 * violet through twilight, pale blue by day. Anything that wants the sky to be
 * DIMMER belongs in `ambientIntensity`, where there is exactly one of it, it
 * moves monotonically from night to noon, and it can be reasoned about.
 *
 * The first version of this file broke the rule while stating it -- the night
 * colour was left five times darker than the day one -- and the result was a
 * brightness curve that was not monotonic at all: raising the night floor high
 * enough to see by made midnight come out BRIGHTER than dusk.
 *
 * `HORIZON_COLOR_*` below is the opposite case and is deliberately NOT
 * normalised: it becomes `scene.fog.color`, which is a colour rather than a
 * light, is never multiplied by an intensity, and genuinely must go dark at
 * night or the horizon glows through a midnight sky.
 */
const SKY_COLOR_NIGHT = rgb(0xa0b3ff);
const SKY_COLOR_TWILIGHT = rgb(0xd9b3e6);
const SKY_COLOR_DAY = rgb(0x9fc4e8);

const GROUND_COLOR_NIGHT = rgb(0x2a2c38);
const GROUND_COLOR_TWILIGHT = rgb(0x4a3d48);
const GROUND_COLOR_DAY = rgb(0x4a4034);

/**
 * The night sky itself, at its darkest.
 *
 * Dark enough to read as night, blue enough that the horizon line between it
 * and the unlit ground is still visible, which is the one thing a player at
 * midnight needs. Brighter than a real moonless sky by a long way, and
 * deliberately: the alternative is a black rectangle.
 */
const BACKDROP_NIGHT = rgb(0x121c33);

const HORIZON_COLOR_NIGHT = rgb(0x141c2c);
const HORIZON_COLOR_TWILIGHT = rgb(0xe08a52);
const HORIZON_COLOR_DAY = rgb(0xb8cee0);

/**
 * Star opacity for a sun elevation.
 *
 * Zero above `STAR_FADE_START_DEG` so the whole `Points` object can be made
 * invisible in daylight and cost nothing at all -- see `sky-dome.ts`.
 */
export function starVisibilityAt(sunElevationDeg: number): number {
  return smooth(ramp(sunElevationDeg, STAR_FADE_START_DEG, STAR_FADE_FULL_DEG));
}

/**
 * How much of the sun's light survives at a given elevation.
 *
 * Normalised so the peak of the day is exactly 1: the maximum elevation is
 * `90 - |LATITUDE_DEG - SOLAR_DECLINATION_DEG|`, and dividing by its sine keeps
 * `SUN_INTENSITY_NOON` meaning what its name says no matter what the latitude
 * is set to. The 0.75 exponent keeps mid-morning from being dimmer than it
 * looks -- a straight cosine falloff reads as overcast by 9am.
 */
function sunLightFalloff(elevationDeg: number): number {
  const peakSin = Math.sin((90 - Math.abs(LATITUDE_DEG - SOLAR_DECLINATION_DEG)) * DEG);
  const setSin = Math.sin(SUN_SET_FADE_DEG * DEG);
  const t = ramp(Math.sin(elevationDeg * DEG), setSin, peakSin);
  return Math.pow(t, 0.75);
}

// ---------------------------------------------------------------------------
// The whole state
// ---------------------------------------------------------------------------

/**
 * Everything the renderer needs about the sky, for one sim time.
 *
 * One call per frame from `Atmosphere.update`. It allocates a handful of small
 * records; at 60 fps that is nothing next to the per-frame quadtree selection,
 * and returning frozen-shaped plain objects is what lets the tests compare two
 * calls for exact equality to prove purity.
 */
export function celestialAt(simTime: number, todAtZero: number = TOD_AT_TIME_ZERO): CelestialState {
  const todHours = timeOfDayHours(simTime, todAtZero);

  const sunDirection = sunDirectionAt(todHours);
  const sunElevationDeg = elevationOf(sunDirection);
  const sunFalloff = sunLightFalloff(sunElevationDeg);

  const phase = moonPhase(simTime);
  const moonIllumination = moonIlluminationOf(phase);
  const moonDirection = moonDirectionAt(todHours, phase);
  const moonElevationDeg = elevationOf(moonDirection);
  // The moon contributes only while it is up AND lit, and only once the sun is
  // out of the way -- a daytime moon is a disc in the sky, not a light source.
  const moonFalloff =
    ramp(moonElevationDeg, -2, 12) * moonIllumination * (1 - clamp01(sunFalloff * 4));

  const sun: LightSource = {
    direction: sunDirection,
    elevationDeg: sunElevationDeg,
    color: rampRgb(sunElevationDeg, SUN_COLOR_HORIZON, SUN_COLOR_LOW, SUN_COLOR_HIGH, 8, 30),
    intensity: SUN_INTENSITY_NOON * sunFalloff,
  };

  const moon: LightSource = {
    direction: moonDirection,
    elevationDeg: moonElevationDeg,
    color: MOON_COLOR,
    intensity: MOON_INTENSITY_FULL * moonFalloff,
  };

  // ONE shadow-casting source. Whichever body is currently contributing more
  // light wins outright rather than being blended: two directional lights would
  // need two cascade rigs, and a blended DIRECTION would swing through the
  // ground at the crossover and drag every shadow across the world with it.
  // Both bodies are near the horizon at the moment of the swap, and the ambient
  // floor carries the frame, so the switch is not visible.
  const dominant = sun.intensity >= moon.intensity ? sun : moon;

  // `skyLight` is how much the SKY is lighting the ground, which outlasts the
  // sun disc by a long way -- see `SKYLIGHT_FADE_FULL_DEG`. `twilight` peaks
  // when the sun is within a few degrees of the horizon, which is exactly when
  // the horizon burns.
  const skyLight = smooth(ramp(sunElevationDeg, SKYLIGHT_FADE_FULL_DEG, SKYLIGHT_FADE_START_DEG));
  const twilight = 1 - clamp01(Math.abs(sunElevationDeg) / 10);

  const ambientSky = rampRgb(sunElevationDeg, SKY_COLOR_NIGHT, SKY_COLOR_TWILIGHT, SKY_COLOR_DAY, 0, 20);
  const ambientGround = rampRgb(
    sunElevationDeg,
    GROUND_COLOR_NIGHT,
    GROUND_COLOR_TWILIGHT,
    GROUND_COLOR_DAY,
    0,
    20,
  );
  const horizon = rampRgb(
    sunElevationDeg,
    HORIZON_COLOR_NIGHT,
    HORIZON_COLOR_TWILIGHT,
    HORIZON_COLOR_DAY,
    2,
    18,
  );

  const ambientIntensity =
    AMBIENT_INTENSITY_NIGHT + (AMBIENT_INTENSITY_DAY - AMBIENT_INTENSITY_NIGHT) * skyLight;

  const fogScale =
    1 +
    (FOG_DENSITY_TWILIGHT_SCALE - 1) * twilight +
    (FOG_DENSITY_NIGHT_SCALE - 1) * (1 - skyLight) * (1 - twilight);

  return {
    todHours,
    sun,
    moon,
    dominant,
    ambientSky,
    ambientGround,
    ambientIntensity,
    horizon,
    backdrop: {
      r: BACKDROP_NIGHT.r * (1 - skyLight),
      g: BACKDROP_NIGHT.g * (1 - skyLight),
      b: BACKDROP_NIGHT.b * (1 - skyLight),
    },
    fogDensity: FOG_DENSITY_CLEAR * fogScale,
    starVisibility: starVisibilityAt(sunElevationDeg),
    moonIllumination,
  };
}
