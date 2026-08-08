/**
 * Tests for Phase Politics P3: names.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { CULTURE_COUNT } from './culture';
import { NAME_SETS, cultureName, nationName, settlementName } from './names';

const SEED = hashString('names-test');
const NAME_PATTERN = /^[A-Za-z' -]+$/;

describe('NAME_SETS', () => {
  it('has exactly CULTURE_COUNT entries', () => {
    expect(NAME_SETS.length).toBe(CULTURE_COUNT);
  });

  it('every culture\'s settlement suffixes are disjoint from every other culture\'s', () => {
    const seen = new Map<string, number>();
    for (let culture = 0; culture < NAME_SETS.length; culture++) {
      for (const suffix of (NAME_SETS[culture] as (typeof NAME_SETS)[number]).settlementSuffixes) {
        const owner = seen.get(suffix);
        expect(owner === undefined || owner === culture).toBe(true);
        seen.set(suffix, culture);
      }
    }
  });

  it('every table entry is non-empty', () => {
    for (const set of NAME_SETS) {
      expect(set.onsets.length).toBeGreaterThan(0);
      expect(set.nuclei.length).toBeGreaterThan(0);
      expect(set.codas.length).toBeGreaterThan(0);
      expect(set.settlementSuffixes.length).toBeGreaterThan(0);
      expect(set.nationSuffixes.length).toBeGreaterThan(0);
      expect(set.diminutiveSuffix.length).toBeGreaterThan(0);
    }
  });
});

describe('settlementName', () => {
  it('is a pure function of its inputs', () => {
    const a = settlementName(1, 5, -9, SEED);
    const b = settlementName(1, 5, -9, SEED);
    expect(a).toBe(b);
  });

  it('a different seed can move the name (not tautologically fixed)', () => {
    let anyDifferent = false;
    for (let i = 0; i < 40; i++) {
      const a = settlementName(i % CULTURE_COUNT, i, -i, SEED);
      const b = settlementName(i % CULTURE_COUNT, i, -i, SEED ^ 0x3333_3333);
      if (a !== b) {
        anyDifferent = true;
        break;
      }
    }
    expect(anyDifferent).toBe(true);
  });

  it('every generated name matches the allowed character set and length cap', () => {
    for (let culture = 0; culture < CULTURE_COUNT; culture++) {
      for (let i = 0; i < 30; i++) {
        const name = settlementName(culture, i, -i * 3, SEED);
        expect(name).toMatch(NAME_PATTERN);
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(24);
      }
    }
  });

  it('does not collapse to one name per culture, over thousands of cells', () => {
    // Anti-vacuity: a generator returning a single fixed name per culture
    // would pass every purity/charset test above perfectly.
    const seenPerCulture: Set<string>[] = Array.from({ length: CULTURE_COUNT }, () => new Set());
    const CELLS = 3000;
    for (let i = 0; i < CELLS; i++) {
      const culture = i % CULTURE_COUNT;
      const cellX = i;
      const cellZ = (i * 2654435761) % 100000;
      const name = settlementName(culture, cellX, cellZ, SEED);
      (seenPerCulture[culture] as Set<string>).add(name);
    }
    const perCulture = CELLS / CULTURE_COUNT;
    let totalDistinct = 0;
    for (const set of seenPerCulture) {
      expect(set.size).toBeGreaterThan(perCulture * 0.5);
      totalDistinct += set.size;
    }
    expect(totalDistinct / CELLS).toBeGreaterThan(0.5);
  });

  it('a hamlet-tier (diminutive) name differs from the ordinary name at the same cell', () => {
    let anyDifferent = false;
    for (let i = 0; i < 30; i++) {
      const ordinary = settlementName(i % CULTURE_COUNT, i, -i, SEED);
      const hamlet = settlementName(i % CULTURE_COUNT, i, -i, SEED, true);
      if (ordinary !== hamlet) {
        anyDifferent = true;
        break;
      }
    }
    expect(anyDifferent).toBe(true);
  });
});

describe('nationName', () => {
  it('is a pure function of its inputs', () => {
    const a = nationName(3, 2, -4, SEED);
    const b = nationName(3, 2, -4, SEED);
    expect(a).toBe(b);
  });

  it('differs from the capital\'s own settlement name at the same cell', () => {
    for (let culture = 0; culture < CULTURE_COUNT; culture++) {
      const capital = settlementName(culture, 10, 20, SEED);
      const nation = nationName(culture, 10, 20, SEED);
      expect(nation).not.toBe(capital);
    }
  });

  it('shares a recognisable stem with the capital\'s settlement name', () => {
    // Both are built from the same `stemAt`, so the nation name should start
    // with the same first few characters as the settlement name, even though
    // the suffixes differ.
    for (let culture = 0; culture < CULTURE_COUNT; culture++) {
      const capital = settlementName(culture, 7, -3, SEED);
      const nation = nationName(culture, 7, -3, SEED);
      const prefixLen = Math.min(3, capital.length, nation.length);
      expect(nation.slice(0, prefixLen)).toBe(capital.slice(0, prefixLen));
    }
  });

  it('matches the allowed character set and length cap', () => {
    for (let culture = 0; culture < CULTURE_COUNT; culture++) {
      for (let i = 0; i < 20; i++) {
        const name = nationName(culture, i, -i, SEED);
        expect(name).toMatch(NAME_PATTERN);
        expect(name.length).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe('cultureName', () => {
  it('returns every culture\'s distinct label', () => {
    const labels = new Set<string>();
    for (let i = 0; i < CULTURE_COUNT; i++) labels.add(cultureName(i));
    expect(labels.size).toBe(CULTURE_COUNT);
  });
});
