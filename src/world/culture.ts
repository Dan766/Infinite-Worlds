/**
 * Culture: the data table that makes two cities in different nations read as
 * different civilisations.
 *
 * Phase Politics P3. Pure and data-only -- no Three.js, no geometry, not even
 * the noise primitives beyond `hashUnit`. `cultureIdAt` is the only function
 * here that does any work; everything else is a lookup table indexed by
 * culture id.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE, SEPARATE FROM `polity.ts`. A `Polity`
 * (nation or city-state) and a `Culture` are different axes: two neighbouring
 * nations descended from the same culture should look related even at war,
 * and this module is what lets `cultureIdAt` be queried once per CAPITAL
 * (`roads.ts`/`city.ts`, Phase S/C) and every member city inherit it, rather
 * than each settlement rolling its own unrelated palette.
 *
 * FORWARD DECLARATIONS. `ROOF_*` and `ARCH_*` belong conceptually to
 * `massing.ts` and `city.ts` (Phase B/C, not part of this slice), but the
 * culture table needs to name them NOW to declare which roofs and which city
 * archetypes each culture prefers. Declaring them here rather than duplicating
 * them later is deliberate: Phase B/C import these constants from this module
 * instead of inventing a second numbering.
 */

import { hash3i } from '../core/hash';
import { hashUnit } from './noise';

// ---------------------------------------------------------------------------
// Forward declarations for Phase B (massing.ts) and Phase C (city.ts)
// ---------------------------------------------------------------------------

export const ROOF_GABLE = 0;
export const ROOF_HIP = 1;
export const ROOF_MANSARD = 2;
export const ROOF_FLAT_PARAPET = 3;
export const ROOF_SHED = 4;
export const ROOF_PYRAMID = 5;
export const ROOF_GAMBREL = 6;
export const ROOF_DOME_FACET = 7;
export const ROOF_COUNT = 8;

export const ARCH_RADIAL = 0;
export const ARCH_RIVERPORT = 1;
export const ARCH_HILL_CITADEL = 2;
export const ARCH_GRID = 3;
export const ARCH_HARBOR = 4;
export const ARCHETYPE_COUNT = 5;

// ---------------------------------------------------------------------------
// The palette shape
// ---------------------------------------------------------------------------

/**
 * Same five-colour shape `building-mesh.ts`'s `BuildingPalette` already uses
 * (`wallA`/`wallB`/`roofA`/`roofB`/`plinth`, each an `[r, g, b]` tuple in
 * `[0, 1]`), so Phase B can index straight into `CULTURES` in place of the
 * single global palette `chunk-gen.ts` uses today, with no reshape.
 */
export interface CulturePalette {
  readonly wallA: readonly [number, number, number];
  readonly wallB: readonly [number, number, number];
  readonly roofA: readonly [number, number, number];
  readonly roofB: readonly [number, number, number];
  readonly plinth: readonly [number, number, number];
}

/** One culture: how it builds, and where in the world it tends to arise. */
export interface Culture {
  readonly id: number;
  readonly label: string;
  /** Climate this culture is most associated with, in [0, 1] each. Biases `cultureIdAt`, does not gate it. */
  readonly idealTemperature: number;
  readonly idealHumidity: number;
  readonly palette: CulturePalette;
  /** `ROOF_*` ids ordinary buildings may use. At least one. */
  readonly houseRoofs: readonly number[];
  /** `ROOF_*` ids landmarks may use. At least one. */
  readonly civicRoofs: readonly number[];
  /** Non-negative weight per `ARCH_*`, length `ARCHETYPE_COUNT`. Breaks ties in `city.ts`'s archetype cascade (Phase C). */
  readonly archetypeBias: readonly number[];
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const CULTURE_COUNT = 6;

/**
 * Six cultures, spread across the climate square and, collectively, across
 * every roof type -- so no single roof shape can be "the world's roof".
 */
export const CULTURES: readonly Culture[] = [
  {
    id: 0,
    label: 'Northern Hold',
    idealTemperature: 0.15,
    idealHumidity: 0.3,
    palette: {
      wallA: [0.62, 0.62, 0.64],
      wallB: [0.42, 0.42, 0.46],
      roofA: [0.28, 0.3, 0.34],
      roofB: [0.18, 0.2, 0.24],
      plinth: [0.35, 0.35, 0.37],
    },
    houseRoofs: [ROOF_GABLE, ROOF_SHED],
    civicRoofs: [ROOF_HIP, ROOF_PYRAMID],
    archetypeBias: [0.8, 0.2, 1.6, 1.1, 0.1],
  },
  {
    id: 1,
    label: 'Riverlands',
    idealTemperature: 0.55,
    idealHumidity: 0.75,
    palette: {
      wallA: [0.78, 0.7, 0.5],
      wallB: [0.55, 0.42, 0.28],
      roofA: [0.5, 0.25, 0.16],
      roofB: [0.36, 0.18, 0.12],
      plinth: [0.4, 0.34, 0.26],
    },
    houseRoofs: [ROOF_GABLE, ROOF_GAMBREL],
    civicRoofs: [ROOF_MANSARD, ROOF_GABLE],
    archetypeBias: [1.2, 1.7, 0.3, 0.6, 0.4],
  },
  {
    id: 2,
    label: 'Desert Dominion',
    idealTemperature: 0.85,
    idealHumidity: 0.15,
    palette: {
      wallA: [0.86, 0.76, 0.56],
      wallB: [0.68, 0.56, 0.38],
      roofA: [0.62, 0.4, 0.22],
      roofB: [0.46, 0.28, 0.14],
      plinth: [0.5, 0.42, 0.3],
    },
    houseRoofs: [ROOF_FLAT_PARAPET, ROOF_SHED],
    civicRoofs: [ROOF_DOME_FACET, ROOF_FLAT_PARAPET],
    archetypeBias: [1.1, 0.2, 0.3, 1.6, 0.3],
  },
  {
    id: 3,
    label: 'Coastal Republic',
    idealTemperature: 0.6,
    idealHumidity: 0.6,
    palette: {
      wallA: [0.9, 0.9, 0.86],
      wallB: [0.72, 0.74, 0.74],
      roofA: [0.24, 0.42, 0.5],
      roofB: [0.16, 0.3, 0.4],
      plinth: [0.5, 0.5, 0.48],
    },
    houseRoofs: [ROOF_HIP, ROOF_FLAT_PARAPET],
    civicRoofs: [ROOF_DOME_FACET, ROOF_MANSARD],
    archetypeBias: [0.5, 0.5, 0.2, 0.6, 2.0],
  },
  {
    id: 4,
    label: 'Highland Clans',
    idealTemperature: 0.35,
    idealHumidity: 0.65,
    palette: {
      wallA: [0.5, 0.48, 0.46],
      wallB: [0.32, 0.3, 0.3],
      roofA: [0.22, 0.24, 0.26],
      roofB: [0.14, 0.16, 0.18],
      plinth: [0.3, 0.28, 0.26],
    },
    houseRoofs: [ROOF_GAMBREL, ROOF_GABLE],
    civicRoofs: [ROOF_PYRAMID, ROOF_HIP],
    archetypeBias: [0.6, 0.3, 2.0, 0.4, 0.1],
  },
  {
    id: 5,
    label: 'Steppe Khaganate',
    idealTemperature: 0.7,
    idealHumidity: 0.25,
    palette: {
      wallA: [0.72, 0.5, 0.3],
      wallB: [0.54, 0.34, 0.18],
      roofA: [0.58, 0.3, 0.14],
      roofB: [0.4, 0.2, 0.1],
      plinth: [0.44, 0.32, 0.2],
    },
    houseRoofs: [ROOF_PYRAMID, ROOF_SHED],
    civicRoofs: [ROOF_HIP, ROOF_PYRAMID],
    archetypeBias: [1.4, 0.2, 0.4, 1.3, 0.2],
  },
];

const CULTURE_SALT = 0x4375_6c74; // 'Cult'

/**
 * Which culture a capital's nation belongs to.
 *
 * A weighted mix of climate fit (70%) and an independent hash roll (30%), so
 * culture correlates with climate -- a desert nation reads as the desert
 * culture more often than not -- without collapsing to a strict biome lookup,
 * which would make culture fully predictable from climate and remove the
 * "accident of history" a real cultural map has.
 *
 * Queried once per capital cell; every member city inherits the result
 * through its polity (Phase S wires `Settlement.cultureId` from
 * `polityOfCity(...).capitalCellX/Z` through this function).
 */
export function cultureIdAt(
  capCellX: number,
  capCellZ: number,
  worldSeed: number,
  temperatureValue: number,
  humidityValue: number,
): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < CULTURES.length; i++) {
    const culture = CULTURES[i] as Culture;
    const dt = temperatureValue - culture.idealTemperature;
    const dh = humidityValue - culture.idealHumidity;
    const distance = Math.sqrt(dt * dt + dh * dh);
    const climateMatch = 1 - distance;
    const roll = hashUnit(hash3i(capCellX, capCellZ, i, (worldSeed ^ CULTURE_SALT) >>> 0));
    const score = climateMatch * 0.7 + roll * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
