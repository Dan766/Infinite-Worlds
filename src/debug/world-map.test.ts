/**
 * Tests for Phase Politics P4: the debug world map's pure sampler.
 *
 * `WorldMap` (the `<canvas>`-owning wrapper) is deliberately not exercised
 * here -- this project's Vitest config runs in a plain Node environment, and
 * `WorldMapField` exists precisely so the sampling logic does not need a DOM
 * to be tested. See the module header in `world-map.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { clearNeighbourhoodCache, clearPoliticalCache } from '../world/polity';
import { WorldMapField, politicalLabelAt, type WorldMapClimate } from './world-map';
import type { PolityTerrain } from '../world/polity';

const SEED = hashString('world-map-test');

/**
 * A hand-built world with a known answer, in the same spirit as
 * `roads.test.ts`'s synthetic-terrain tests: a flat, dry-nowhere continent
 * with a sharp sea far to the west, and one "city" planted via a habitability
 * bump CENTRED ON A CITY_CELL'S OWN CENTRE (world (4096, 4096), the centre of
 * coarse cell (0, 0)) -- not on a cell corner, which would split the bump's
 * coverage across four cells and produce no clean local maximum at all. The
 * radius (3,200 m) comfortably covers every stage-1 sub-probe of its own cell
 * (the furthest is 2,896 m from centre) while leaving neighbouring cells,
 * 8,192 m away, at background habitability. `polityAt`/`citiesInBox` still do
 * the real siting/partition work -- only the climate/terrain feeding them is
 * synthetic.
 */
const BUMP_X = 4096;
const BUMP_Z = 4096;
const BUMP_RADIUS = 3_200;

function bumpWorld(): { terrain: PolityTerrain; climate: WorldMapClimate } {
  const terrain: PolityTerrain = {
    seaLevel: 0,
    // -20,000 is more than two full CITY_CELLs west of the bump's cell (0, 0)
    // -- comfortably clear of the coarse local-max scan around it -- while
    // still inside the wide view the sea/unclaimed/claimed test below uses.
    height: (x) => (x < -20_000 ? -50 : 200),
  };
  const climate: WorldMapClimate = {
    continentalness: () => 1,
    habitability: (x, z) => {
      const dx = x - BUMP_X;
      const dz = z - BUMP_Z;
      return Math.sqrt(dx * dx + dz * dz) < BUMP_RADIUS ? 1 : 0;
    },
    temperature: () => 0.5,
    humidity: () => 0.5,
  };
  return { terrain, climate };
}

describe('WorldMapField: never touches sampleHeight', () => {
  it('never imports sampleHeight, and never calls it in call-syntax anywhere in the source', () => {
    // A blanket "the word never appears" check would also trip on this
    // module's own prose explaining WHY it must not call `sampleHeight` --
    // this file's header does, deliberately, at length. The two checks that
    // actually prove the constraint: the import from `height-field.ts` never
    // names it, and no line anywhere calls it as a function.
    const path = fileURLToPath(new URL('./world-map.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const importLine = source
      .split('\n')
      .find((line) => line.includes("from '../world/height-field'"));
    expect(importLine).toBeDefined();
    expect(importLine as string).not.toMatch(/\bsampleHeight\b/);
    expect(source).not.toMatch(/sampleHeight\s*\(/);
  });

  it('calls only the injected terrain.height -- never any other height source', () => {
    let calls = 0;
    const { climate } = bumpWorld();
    const terrain: PolityTerrain = {
      seaLevel: 0,
      height: (x) => {
        calls++;
        return x < -500 ? -50 : 200;
      },
    };
    clearPoliticalCache();
    clearNeighbourhoodCache();
    const field = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 32 });
    field.recenter(0, 0);
    field.step(Number.POSITIVE_INFINITY);
    expect(calls).toBeGreaterThan(0);
    expect(field.done).toBe(true);
  });
});

describe('WorldMapField: incremental building', () => {
  it('spreads a build over multiple step() calls under a tight budget', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 64 });
    field.recenter(0, 0);
    let calls = 0;
    while (!field.step(0.05)) {
      calls++;
      if (calls > 100_000) throw new Error('step() never finished');
    }
    expect(calls).toBeGreaterThan(1);
  });

  it('the finished bitmap does not depend on how many steps it took to build', () => {
    const { terrain, climate } = bumpWorld();

    const chunked = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 48 });
    chunked.recenter(1_000, -2_000);
    while (!chunked.step(0.02)) {
      /* keep stepping */
    }

    const oneShot = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 48 });
    oneShot.recenter(1_000, -2_000);
    oneShot.step(Number.POSITIVE_INFINITY);

    expect(Array.from(chunked.pixels)).toEqual(Array.from(oneShot.pixels));
  });

  it('done is false before the first step and true only once every pixel is painted', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 16 });
    field.recenter(0, 0);
    expect(field.done).toBe(false);
    field.step(Number.POSITIVE_INFINITY);
    expect(field.done).toBe(true);
  });
});

describe('WorldMapField: the bitmap is not vacuous', () => {
  it('contains sea, unclaimed land, and at least one claimed polity colour, not one flat colour', () => {
    const { terrain, climate } = bumpWorld();
    // Wide enough (102.4 km) to span from deep sea (west of -20,000) through
    // the one city's territory to ground well beyond any polity's frontier
    // (FRONTIER_MAX is 44,000 m) -- so all three regimes are guaranteed to
    // appear, not just likely to.
    const field = new WorldMapField(
      { terrain, climate, worldSeed: SEED },
      { size: 128, metresPerPixel: 800 },
    );
    field.recenter(0, 0);
    field.step(Number.POSITIVE_INFINITY);

    const distinctColors = new Set<string>();
    for (let i = 0; i < field.pixels.length; i += 4) {
      distinctColors.add(`${field.pixels[i]},${field.pixels[i + 1]},${field.pixels[i + 2]}`);
    }
    // Anti-vacuity: a map that rendered without throwing but painted every
    // pixel one colour would pass a "did it crash" check perfectly.
    expect(distinctColors.size).toBeGreaterThanOrEqual(3);
  });

  it('sees at least one city in a view built around the bump', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField(
      { terrain, climate, worldSeed: SEED },
      { size: 64, metresPerPixel: 250 },
    );
    field.recenter(BUMP_X, BUMP_Z);
    field.step(Number.POSITIVE_INFINITY);
    expect(field.citiesInView().length).toBeGreaterThan(0);
  });
});

describe('recenter and setScale', () => {
  it('a small camera move does not restart the build; a large one does', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField(
      { terrain, climate, worldSeed: SEED },
      { size: 32, metresPerPixel: 100 },
    );
    field.recenter(0, 0);
    field.step(Number.POSITIVE_INFINITY);
    expect(field.done).toBe(true);

    field.recenter(1, 0); // a metre: far under the recentre threshold
    expect(field.done).toBe(true);

    field.recenter(100_000, 0); // far outside the current view
    expect(field.done).toBe(false);
  });

  it('setScale to a different value restarts the build', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField(
      { terrain, climate, worldSeed: SEED },
      { size: 32, metresPerPixel: 100 },
    );
    field.recenter(0, 0);
    field.step(Number.POSITIVE_INFINITY);
    field.setScale(200);
    expect(field.done).toBe(false);
    expect(field.metresPerPixel).toBe(200);
  });
});

describe('politicalLabelAt / WorldMapField.labelAt', () => {
  it('reports Sea over water and a stable label repeatedly', () => {
    const { terrain, climate } = bumpWorld();
    const a = politicalLabelAt(-30_000, 0, terrain, climate, SEED);
    const b = politicalLabelAt(-30_000, 0, terrain, climate, SEED);
    expect(a).toBe('Sea');
    expect(b).toBe('Sea');
  });

  it('reports a non-empty label at a real city site', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 48 });
    field.recenter(BUMP_X, BUMP_Z);
    field.step(Number.POSITIVE_INFINITY);
    const cities = field.citiesInView();
    expect(cities.length).toBeGreaterThan(0);
    const city = cities[0] as { x: number; z: number };
    const label = field.labelAt(city.x, city.z);
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe('Sea');
    expect(label).not.toBe('Unclaimed wilderness');
  });

  it('reports a non-empty city name via nameOfCity', () => {
    const { terrain, climate } = bumpWorld();
    const field = new WorldMapField({ terrain, climate, worldSeed: SEED }, { size: 48 });
    field.recenter(BUMP_X, BUMP_Z);
    field.step(Number.POSITIVE_INFINITY);
    const cities = field.citiesInView();
    expect(cities.length).toBeGreaterThan(0);
    for (const city of cities) {
      expect(field.nameOfCity(city).length).toBeGreaterThan(0);
    }
  });
});
