import { describe, expect, it } from 'vitest';
import {
  AMBIENT_INTENSITY_NIGHT,
  celestialAt,
  DAY_LENGTH_SECONDS,
  LATITUDE_DEG,
  MOON_PHASE_PERIOD_DAYS,
  moonDirectionAt,
  moonIlluminationOf,
  moonPhase,
  SOLAR_DECLINATION_DEG,
  STAR_FADE_FULL_DEG,
  STAR_FADE_START_DEG,
  SUN_INTENSITY_NOON,
  starVisibilityAt,
  sunDirectionAt,
  timeOfDayHours,
  TOD_AT_TIME_ZERO,
  type Vec3,
} from './celestial';

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function elevationDegOf(v: Vec3): number {
  return (Math.asin(v.y / length(v)) * 180) / Math.PI;
}

/** Rec. 709 relative luminance, over the stored sRGB encoding. */
function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

describe('timeOfDayHours', () => {
  it('starts at TOD_AT_TIME_ZERO', () => {
    expect(timeOfDayHours(0)).toBeCloseTo(TOD_AT_TIME_ZERO, 10);
  });

  it('advances 24 hours over one DAY_LENGTH_SECONDS', () => {
    expect(timeOfDayHours(DAY_LENGTH_SECONDS)).toBeCloseTo(TOD_AT_TIME_ZERO, 10);
    expect(timeOfDayHours(DAY_LENGTH_SECONDS / 2)).toBeCloseTo(
      (TOD_AT_TIME_ZERO + 12) % 24,
      10,
    );
  });

  it('stays in [0, 24) for large, small and negative sim times', () => {
    for (const t of [-9999, -1, 0, 0.5, 3, 1200, 100000]) {
      const h = timeOfDayHours(t);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(24);
    }
  });

  it('honours an explicit todAtZero', () => {
    expect(timeOfDayHours(0, 21)).toBeCloseTo(21, 10);
    expect(timeOfDayHours(0, 23.5)).toBeCloseTo(23.5, 10);
  });
});

/**
 * THE TEST THAT PROTECTS THE 68 BASELINES.
 *
 * Every canonical view is captured with `?freeze=1`, so its sim time is exactly
 * `?time=` -- 67 views at 3 and one at 0. If `TOD_AT_TIME_ZERO` ever moves to a
 * night hour, every one of those PNGs becomes a black frame and `shots:check`
 * reports 68 unexplained failures. This turns that into one failing assertion
 * with a name that says what went wrong.
 */
describe('the canonical screenshot hours are daylight', () => {
  it.each([0, 3])('sim time %d is well after sunrise', (simTime) => {
    const state = celestialAt(simTime);
    expect(state.sun.elevationDeg).toBeGreaterThan(20);
    expect(state.sun.intensity).toBeGreaterThan(1);
    expect(state.starVisibility).toBe(0);
  });

  it('the two canonical hours differ, so ?time= is visibly seeking the sun', () => {
    expect(celestialAt(3).sun.elevationDeg).not.toBe(celestialAt(0).sun.elevationDeg);
  });
});

describe('sunDirectionAt', () => {
  it('returns a unit vector at every hour', () => {
    for (let h = 0; h < 24; h += 0.25) {
      expect(length(sunDirectionAt(h))).toBeCloseTo(1, 10);
    }
  });

  it('peaks at local noon, at 90 - |latitude - declination| degrees', () => {
    const noon = elevationDegOf(sunDirectionAt(12));
    expect(noon).toBeCloseTo(90 - Math.abs(LATITUDE_DEG - SOLAR_DECLINATION_DEG), 6);

    for (let h = 0; h < 24; h += 0.25) {
      expect(elevationDegOf(sunDirectionAt(h))).toBeLessThanOrEqual(noon + 1e-9);
    }
  });

  it('rises in the east and sets in the west', () => {
    // +X is east, so the morning sun is at positive X and the evening sun negative.
    expect(sunDirectionAt(8).x).toBeGreaterThan(0);
    expect(sunDirectionAt(16).x).toBeLessThan(0);
    expect(sunDirectionAt(12).x).toBeCloseTo(0, 10);
  });

  it('sits to the south at noon, as a northern latitude must', () => {
    // +Z is north.
    expect(sunDirectionAt(12).z).toBeLessThan(0);
  });

  it('climbs monotonically from dawn to noon', () => {
    let previous = -Infinity;
    for (let h = 6; h <= 12; h += 0.5) {
      const elevation = elevationDegOf(sunDirectionAt(h));
      expect(elevation).toBeGreaterThan(previous);
      previous = elevation;
    }
  });

  it('is below the horizon at midnight', () => {
    expect(elevationDegOf(sunDirectionAt(0))).toBeLessThan(-10);
  });
});

describe('the moon', () => {
  it('is new at phase 0 and full at phase 0.5', () => {
    expect(moonIlluminationOf(0)).toBeCloseTo(0, 10);
    expect(moonIlluminationOf(0.5)).toBeCloseTo(1, 10);
    expect(moonIlluminationOf(0.25)).toBeCloseTo(0.5, 10);
  });

  it('illumination stays within [0, 1] across a whole cycle', () => {
    for (let p = 0; p < 1; p += 0.01) {
      const lit = moonIlluminationOf(p);
      expect(lit).toBeGreaterThanOrEqual(0);
      expect(lit).toBeLessThanOrEqual(1);
    }
  });

  it('completes one phase cycle per MOON_PHASE_PERIOD_DAYS', () => {
    const period = DAY_LENGTH_SECONDS * MOON_PHASE_PERIOD_DAYS;
    expect(moonPhase(0)).toBeCloseTo(0, 10);
    expect(moonPhase(period)).toBeCloseTo(0, 10);
    expect(moonPhase(period / 2)).toBeCloseTo(0.5, 10);
  });

  it('a full moon is opposite the sun, so it rises as the sun sets', () => {
    // At phase 0.5 the moon lags the sun by twelve hours of hour angle, which
    // means its direction at noon is the sun's direction at midnight.
    const fullMoonAtNoon = moonDirectionAt(12, 0.5);
    expect(fullMoonAtNoon.y).toBeLessThan(0);

    const fullMoonAtMidnight = moonDirectionAt(0, 0.5);
    expect(fullMoonAtMidnight.y).toBeGreaterThan(0);
  });

  it('a new moon shares the sun sky, so it is up at noon', () => {
    expect(moonDirectionAt(12, 0).y).toBeGreaterThan(0);
  });

  it('returns a unit vector for every hour and phase', () => {
    for (let h = 0; h < 24; h += 1) {
      for (let p = 0; p < 1; p += 0.125) {
        expect(length(moonDirectionAt(h, p))).toBeCloseTo(1, 10);
      }
    }
  });
});

describe('starVisibilityAt', () => {
  it('is fully off in daylight and fully on in deep night', () => {
    expect(starVisibilityAt(40)).toBe(0);
    expect(starVisibilityAt(STAR_FADE_START_DEG)).toBe(0);
    expect(starVisibilityAt(STAR_FADE_FULL_DEG)).toBe(1);
    expect(starVisibilityAt(-60)).toBe(1);
  });

  it('never decreases as the sun sinks', () => {
    let previous = -Infinity;
    for (let e = 20; e >= -30; e -= 0.5) {
      const v = starVisibilityAt(e);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });
});

describe('celestialAt', () => {
  it('is pure: the same sim time always gives the same state', () => {
    for (const t of [0, 3, 137.25, 900]) {
      expect(celestialAt(t)).toEqual(celestialAt(t));
    }
  });

  it('never lets the world go fully black', () => {
    for (let t = 0; t < DAY_LENGTH_SECONDS; t += DAY_LENGTH_SECONDS / 96) {
      expect(celestialAt(t).ambientIntensity).toBeGreaterThanOrEqual(AMBIENT_INTENSITY_NIGHT);
    }
  });

  it('the dominant source is the sun by day and the moon by night', () => {
    const noon = celestialAt(midOf(12));
    expect(noon.sun.intensity).toBeGreaterThan(0);
    expect(noon.dominant.direction).toEqual(noon.sun.direction);

    // Fourteen days in, the moon is within a fraction of a percent of full and
    // midnight puts it high. A chosen day rather than an exact half period,
    // because full moon and midnight genuinely drift apart over a lunar month.
    const night = celestialAt(14 * DAY_LENGTH_SECONDS + midOf(0));
    expect(night.moonIllumination).toBeGreaterThan(0.99);
    expect(night.sun.intensity).toBe(0);
    expect(night.moon.intensity).toBeGreaterThan(0);
    expect(night.dominant.direction).toEqual(night.moon.direction);
  });

  it('the dominant direction is always unit length, including at the crossover', () => {
    for (let t = 0; t < DAY_LENGTH_SECONDS * 2; t += DAY_LENGTH_SECONDS / 240) {
      expect(length(celestialAt(t).dominant.direction)).toBeCloseTo(1, 10);
    }
  });

  it('the sun contributes nothing once it is well below the horizon', () => {
    expect(celestialAt(midOf(0)).sun.intensity).toBe(0);
    expect(celestialAt(midOf(12)).sun.intensity).toBeGreaterThan(3);
  });

  it('a moon in a daylit sky is a disc, not a light source', () => {
    // Scanned across two lunar months, so the moon passes through every phase
    // and every position relative to the sun: whenever the sun is meaningfully
    // up, the moon must be contributing nothing at all.
    const span = DAY_LENGTH_SECONDS * MOON_PHASE_PERIOD_DAYS * 2;
    let daylitSamples = 0;
    for (let t = 0; t < span; t += DAY_LENGTH_SECONDS / 48) {
      const s = celestialAt(t);
      if (s.sun.intensity > 0.9) {
        daylitSamples++;
        expect(s.moon.intensity).toBe(0);
      }
    }
    // The scan actually found daylight, rather than passing on an empty set.
    expect(daylitSamples).toBeGreaterThan(100);
  });

  it('skylight outlasts the sun disc, so dusk is not a power cut', () => {
    // 18:42 is roughly thirteen minutes past sunset at this latitude. The
    // direct sun is all but gone; the SKY is not, and the ground must still be
    // lit by it. Driving ambient off the sun-disc ramp instead put the world at
    // barely twice its midnight floor here, which read as a blackout.
    const dusk = celestialAt(midOf(18.7));
    const night = celestialAt(midOf(23));
    expect(dusk.sun.elevationDeg).toBeLessThan(0);
    expect(dusk.sun.intensity).toBeLessThan(SUN_INTENSITY_NOON * 0.2);
    expect(dusk.ambientIntensity).toBeGreaterThan(night.ambientIntensity * 1.2);
  });

  it('the hemisphere colours carry hue, not brightness', () => {
    // The rule the constants state, asserted rather than trusted. Leaving the
    // night colour darker than the day one -- which the first version of this
    // file did while documenting the opposite -- makes `ambientIntensity` stop
    // being the single brightness control, and midnight came out brighter than
    // dusk as a result.
    const samples = [0, 5, 12, 18, 23].map((h) => celestialAt(midOf(h)).ambientSky);
    const values = samples.map(luminance);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.35);
  });

  it('ambient brightness rises monotonically from midnight to noon', () => {
    let previous = -Infinity;
    for (let h = 0; h <= 12; h += 0.25) {
      const v = celestialAt(midOf(h)).ambientIntensity;
      expect(v).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = v;
    }
    expect(celestialAt(midOf(12)).ambientIntensity).toBeGreaterThan(
      celestialAt(midOf(0)).ambientIntensity,
    );
  });

  it('ambient reaches its floor only once twilight is genuinely over', () => {
    expect(celestialAt(midOf(23)).ambientIntensity).toBeCloseTo(AMBIENT_INTENSITY_NIGHT, 6);
    expect(celestialAt(midOf(12)).ambientIntensity).toBeCloseTo(1, 6);
  });

  it('fog thickens at twilight and at night, and is thinnest in clear daylight', () => {
    const noon = celestialAt(midOf(12)).fogDensity;
    const dusk = celestialAt(midOf(18.4)).fogDensity;
    const night = celestialAt(midOf(0)).fogDensity;
    expect(dusk).toBeGreaterThan(noon);
    expect(night).toBeGreaterThan(noon);
  });

  it('every colour channel it produces stays within [0, 1]', () => {
    for (let t = 0; t < DAY_LENGTH_SECONDS; t += DAY_LENGTH_SECONDS / 120) {
      const s = celestialAt(t);
      for (const c of [s.sun.color, s.moon.color, s.ambientSky, s.ambientGround, s.horizon]) {
        for (const channel of [c.r, c.g, c.b]) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('reports the time of day it was asked for', () => {
    expect(celestialAt(0, 21).todHours).toBeCloseTo(21, 10);
  });
});

/** Sim time whose time of day is `hour`, given the default phase. */
function midOf(hour: number): number {
  const delta = (hour - TOD_AT_TIME_ZERO + 24) % 24;
  return (delta / 24) * DAY_LENGTH_SECONDS;
}
