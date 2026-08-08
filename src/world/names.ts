/**
 * Names: culture-keyed syllable morphology for settlements and nations.
 *
 * Phase Politics P3. Pure, and deliberately decoupled from `roads.ts`: a
 * settlement's tier is passed in as a plain `diminutive` boolean rather than
 * the numeric `SETTLEMENT_CLASS_*` this module has no business knowing about
 * (the same discipline `polity.ts` follows for the same reason -- see its
 * header note on why the dependency edge only ever points one way).
 *
 * Every name is `hash3i`/`hashUnit` of `(worldSeed, cell, index)`, so a
 * settlement's name is as deterministic and as cheap to recompute as its
 * position. Nothing here is stored; a caller that wants a name asks for it
 * again.
 */

import { hash3i } from '../core/hash';
import { CULTURE_COUNT, CULTURES } from './culture';

// ---------------------------------------------------------------------------
// Per-culture syllable tables
// ---------------------------------------------------------------------------

export interface NameSet {
  readonly onsets: readonly string[];
  readonly nuclei: readonly string[];
  /** May include `''` for an open syllable. */
  readonly codas: readonly string[];
  readonly settlementSuffixes: readonly string[];
  readonly nationSuffixes: readonly string[];
  /** Appended in place of a settlement suffix for a hamlet-tier name. */
  readonly diminutiveSuffix: string;
}

/**
 * One entry per `CULTURES` index. Every culture's `settlementSuffixes` are
 * disjoint from every other culture's -- asserted in `names.test.ts` -- which
 * is most of what makes two cultures read as different at a glance rather
 * than as one naming scheme wearing different palettes.
 */
export const NAME_SETS: readonly NameSet[] = [
  {
    // Northern Hold
    onsets: ['Th', 'Br', 'Gr', 'Vor', 'Sk', 'Fr'],
    nuclei: ['o', 'a', 'e', 'u', 'i'],
    codas: ['n', 'r', 'th', 'ld', 'k', ''],
    settlementSuffixes: ['stead', 'holm', 'fjord', 'wick'],
    nationSuffixes: [' Hold', ' Reach', ' March'],
    diminutiveSuffix: 'cot',
  },
  {
    // Riverlands
    onsets: ['Wil', 'Al', 'Rav', 'Am', 'Del', 'Mer'],
    nuclei: ['a', 'e', 'o', 'ie'],
    codas: ['n', 'm', 'd', 'le', ''],
    settlementSuffixes: ['ford', 'bridge', 'mill', 'vale'],
    nationSuffixes: [' Vale', ' Shire', ' Commons'],
    diminutiveSuffix: 'brook',
  },
  {
    // Desert Dominion
    onsets: ['Az', 'Kar', 'Sal', 'Nim', 'Zar', 'Qod'],
    nuclei: ['a', 'i', 'u'],
    codas: ['n', 'r', 'm', 'sh', ''],
    settlementSuffixes: ['ara', 'abad', 'oasis', 'dune'],
    nationSuffixes: [' Dominion', ' Emirate', ' Expanse'],
    diminutiveSuffix: 'well',
  },
  {
    // Coastal Republic
    onsets: ['Sol', 'Mar', 'Bel', 'Cor', 'Val', 'Por'],
    nuclei: ['a', 'o', 'e', 'i'],
    codas: ['n', 's', 'ro', 'ta', ''],
    settlementSuffixes: ['port', 'bay', 'harbor', 'isle'],
    nationSuffixes: [' Republic', ' League', ' Coast'],
    diminutiveSuffix: 'cove',
  },
  {
    // Highland Clans
    onsets: ['Mac', 'Gal', 'Dun', 'Kil', 'Bra', 'Glen'],
    nuclei: ['a', 'o', 'ai'],
    codas: ['n', 'r', 'gh', 'ck', ''],
    settlementSuffixes: ['glen', 'cairn', 'moor', 'crag'],
    nationSuffixes: [' Highlands', ' Clans', ' Confederacy'],
    diminutiveSuffix: 'croft',
  },
  {
    // Steppe Khaganate
    onsets: ['Kha', 'Bat', 'Or', 'Tem', 'Ulan', 'Sar'],
    nuclei: ['a', 'u', 'o'],
    codas: ['n', 'r', 'g', 'kh', ''],
    settlementSuffixes: ['camp', 'ordu', 'steppe', 'yurt'],
    nationSuffixes: [' Khaganate', ' Horde', ' Steppes'],
    diminutiveSuffix: 'kul',
  },
];

const SALT = {
  syllableCount: 0x53_79_6c43, // 'SylC'
  onset: 0x4f_6e_73_74, // 'Onst'
  nucleus: 0x4e_75_63_6c, // 'Nucl'
  coda: 0x43_6f_64_61, // 'Coda'
  settlementSuffix: 0x53_75_66_66, // 'Suff'
  nationSuffix: 0x4e_53_75_66, // 'NSuf'
} as const;

/** Hard cap so a pathological syllable/suffix combination can never produce an unbounded label. */
const NAME_MAX_LENGTH = 24;

function nameSetFor(cultureId: number): NameSet {
  // Structural safety net rather than a caller contract: an out-of-range id
  // (a bad seed migration, a stale save) degrades to culture 0 instead of
  // throwing on a path that may run every frame the HUD is visible.
  const set = NAME_SETS[cultureId];
  return set ?? (NAME_SETS[0] as NameSet);
}

function pick<T>(
  list: readonly T[],
  cellX: number,
  cellZ: number,
  index: number,
  worldSeed: number,
  salt: number,
): T {
  const h = hash3i(cellX, cellZ, index, (worldSeed ^ salt) >>> 0) >>> 0;
  return list[h % list.length] as T;
}

/** 1-3 syllables, from `hash3i(cellX, cellZ, 0, seed ^ syllableCount salt) % 3 + 1`. */
function syllableCount(cellX: number, cellZ: number, worldSeed: number): number {
  const h = hash3i(cellX, cellZ, 0, (worldSeed ^ SALT.syllableCount) >>> 0) >>> 0;
  return 1 + (h % 3);
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The bare stem -- no settlement or nation suffix -- shared by
 * `settlementName` and `nationName` when both are asked about the SAME cell.
 * That sharing is what makes a capital's own settlement name and its
 * nation's name look like the same word wearing two different endings,
 * rather than two unrelated rolls.
 */
function stemAt(cultureId: number, cellX: number, cellZ: number, worldSeed: number): string {
  const set = nameSetFor(cultureId);
  const count = syllableCount(cellX, cellZ, worldSeed);
  let stem = '';
  for (let i = 0; i < count; i++) {
    const onset = pick(set.onsets, cellX, cellZ, i, worldSeed, SALT.onset);
    const nucleus = pick(set.nuclei, cellX, cellZ, i, worldSeed, SALT.nucleus);
    const coda = pick(set.codas, cellX, cellZ, i, worldSeed, SALT.coda);
    stem += onset + nucleus + coda;
  }
  return capitalize(stem);
}

function clip(word: string): string {
  return word.length > NAME_MAX_LENGTH ? word.slice(0, NAME_MAX_LENGTH) : word;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A settlement's name. `diminutive` is for a hamlet-tier settlement (see
 * `roads.ts`'s `SETTLEMENT_CLASS_HAMLET`, Phase S): it swaps the ordinary
 * settlement suffix for a smaller-sounding one, so a hamlet reads as modest
 * without a second naming scheme.
 */
export function settlementName(
  cultureId: number,
  cellX: number,
  cellZ: number,
  worldSeed: number,
  diminutive = false,
): string {
  const set = nameSetFor(cultureId);
  const stem = stemAt(cultureId, cellX, cellZ, worldSeed);
  if (diminutive) return clip(stem + set.diminutiveSuffix);
  const suffix = pick(set.settlementSuffixes, cellX, cellZ, 0, worldSeed, SALT.settlementSuffix);
  return clip(stem + suffix);
}

/**
 * A nation's (or city-state's) name, keyed by its CAPITAL's cell. Deliberately
 * shares `stemAt` with `settlementName` at the same cell, so a capital and its
 * nation are recognisably the same word -- see `stemAt`'s note -- while the
 * disjoint suffix tables guarantee the two strings are never identical.
 */
export function nationName(
  cultureId: number,
  capCellX: number,
  capCellZ: number,
  worldSeed: number,
): string {
  const set = nameSetFor(cultureId);
  const stem = stemAt(cultureId, capCellX, capCellZ, worldSeed);
  const suffix = pick(set.nationSuffixes, capCellX, capCellZ, 0, worldSeed, SALT.nationSuffix);
  return clip(stem + suffix);
}

/** The culture's own display name -- a thin re-export of `culture.ts`'s data, kept here so a caller asking about names never needs a second import. */
export function cultureName(cultureId: number): string {
  const culture = CULTURES[cultureId] ?? CULTURES[0];
  return (culture as (typeof CULTURES)[number]).label;
}

export { CULTURE_COUNT };
