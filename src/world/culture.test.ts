/**
 * Tests for Phase Politics P3: the culture table.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import {
  ARCHETYPE_COUNT,
  CULTURE_COUNT,
  CULTURES,
  ROOF_COUNT,
  cultureIdAt,
  type Culture,
} from './culture';

const SEED = hashString('culture-test');

function inUnitRange(v: number): boolean {
  return v >= 0 && v <= 1;
}

describe('CULTURES', () => {
  it('has exactly CULTURE_COUNT entries, indexed 0..CULTURE_COUNT-1', () => {
    expect(CULTURES.length).toBe(CULTURE_COUNT);
    for (let i = 0; i < CULTURES.length; i++) {
      expect((CULTURES[i] as Culture).id).toBe(i);
    }
  });

  it('every palette component is in [0, 1]', () => {
    for (const culture of CULTURES) {
      const p = culture.palette;
      for (const swatch of [p.wallA, p.wallB, p.roofA, p.roofB, p.plinth]) {
        for (const component of swatch) {
          expect(inUnitRange(component)).toBe(true);
        }
      }
    }
  });

  it('every culture declares at least one house roof and one civic roof', () => {
    for (const culture of CULTURES) {
      expect(culture.houseRoofs.length).toBeGreaterThan(0);
      expect(culture.civicRoofs.length).toBeGreaterThan(0);
      for (const roof of [...culture.houseRoofs, ...culture.civicRoofs]) {
        expect(roof).toBeGreaterThanOrEqual(0);
        expect(roof).toBeLessThan(ROOF_COUNT);
      }
    }
  });

  it('collectively covers at least 6 of the 8 roof types', () => {
    // Anti-vacuity: six cultures that all picked ROOF_GABLE would each pass
    // the "at least one roof" test above perfectly while the world had
    // exactly one roof shape in it.
    const seen = new Set<number>();
    for (const culture of CULTURES) {
      for (const roof of [...culture.houseRoofs, ...culture.civicRoofs]) seen.add(roof);
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it('every archetypeBias has ARCHETYPE_COUNT non-negative entries', () => {
    for (const culture of CULTURES) {
      expect(culture.archetypeBias.length).toBe(ARCHETYPE_COUNT);
      for (const weight of culture.archetypeBias) {
        expect(weight).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('every culture has a non-empty, distinct label', () => {
    const labels = new Set(CULTURES.map((c) => c.label));
    expect(labels.size).toBe(CULTURES.length);
    for (const culture of CULTURES) {
      expect(culture.label.length).toBeGreaterThan(0);
    }
  });
});

describe('cultureIdAt', () => {
  it('is a pure function of its inputs', () => {
    const a = cultureIdAt(4, -9, SEED, 0.5, 0.5);
    const b = cultureIdAt(4, -9, SEED, 0.5, 0.5);
    expect(a).toBe(b);
  });

  it('always returns a valid culture index', () => {
    for (let i = 0; i < 100; i++) {
      const id = cultureIdAt(i, -i * 3, SEED, (i % 10) / 10, ((i * 7) % 10) / 10);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(CULTURE_COUNT);
    }
  });

  it('is biased toward climate fit without being fully determined by it', () => {
    // Desert Dominion (index 2) is centred on hot and dry. Sampling many
    // different capital cells at exactly that climate should pick it more
    // than a uniform 1/CULTURE_COUNT chance would, but not every time --
    // proving both the climate bias AND the hash roll are actually live.
    const desert = CULTURES[2] as Culture;
    let desertPicks = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
      const id = cultureIdAt(i, -i * 5 + 1, SEED, desert.idealTemperature, desert.idealHumidity);
      if (id === 2) desertPicks++;
    }
    const uniform = trials / CULTURE_COUNT;
    expect(desertPicks).toBeGreaterThan(uniform * 1.5);
    expect(desertPicks).toBeLessThan(trials);
  });

  it('a different seed can change the result at the same cell (not tautologically fixed)', () => {
    let anyDifferent = false;
    for (let i = 0; i < 50; i++) {
      const a = cultureIdAt(i, i, SEED, 0.5, 0.5);
      const b = cultureIdAt(i, i, SEED ^ 0x2222_2222, 0.5, 0.5);
      if (a !== b) {
        anyDifferent = true;
        break;
      }
    }
    expect(anyDifferent).toBe(true);
  });
});
