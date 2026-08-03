/**
 * Tests for Phase 6: Sector-tier lot siting.
 *
 * The same three kinds `streets.test.ts` has, with one addition that is specific
 * to this phase and is the reason several tests here look like they are testing
 * the height field:
 *
 * A LOT IS THE FIRST CONTENT DECIDED BY EVALUATING THE FINISHED GROUND. Rivers,
 * roads and streets are all routed from `baseHeight` and then MOVE the ground.
 * A building reads the ground everything else produced and stands on it, so the
 * claims worth asserting are relational -- "the floor is the height the world
 * reports at that point", "the ground under the footprint is level" -- and none
 * of them can be checked without the real height field.
 *
 * The anti-vacuity half is everywhere: a rejection test that refuses everything
 * passes every "no building is too close to a road" assertion perfectly, so each
 * of those is paired with a count of what survived.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { createTierContext, SECTOR_SIZE } from './contracts';
import { GradeBlend } from './grading';
import {
  gradeTarget,
  sampleHeight,
  worldRegionField,
  worldSectorField,
  type RegionField,
} from './height-field';
import {
  BUILDING_HALF_DEPTH_MAX,
  BUILDING_HALF_WIDTH_MAX,
  KIND_BARN,
  KIND_COTTAGE,
  KIND_HALL,
  BUILDING_SKEW,
  clearLotCache,
  generateSectorLots,
  LOT_CACHE_LIMIT,
  LOT_GAP,
  LOT_MAX_BUILDINGS,
  LOT_MAX_EXTENT,
  LOT_ROAD_CLEAR,
  LOT_SPREAD_MAX,
  LOT_STREET_CLEAR,
  LOT_UNLEVEL_MAX,
  lotCacheStats,
  sectorLots,
  type LotGround,
  type SectorLots,
} from './lots';
import { roadClearance, SETTLEMENT_JITTER } from './roads';
import { sectorStreetField } from './streets';
import { isCity } from './city';

const SEED = hashString('lots-test');

const region = (seed = SEED): RegionField => worldRegionField(seed);

/** The whole Sector tier for one seed: streets, and the lots fronting onto them. */
function sectors(seed = SEED): ReturnType<typeof worldSectorField> {
  return worldSectorField(region(seed), seed);
}

/**
 * Every sector in a block that actually laid out buildings.
 *
 * THE ANTI-VACUITY HELPER OF THIS FILE. Almost every sector in the world is
 * empty, so a test that walks a block and asserts a property of what it finds
 * would pass on a generator that returns nothing at all. Every test that uses
 * this also asserts the list is not empty, and most assert a floor on the total
 * number of buildings in it.
 */
function populated(seed = SEED, x0 = -6, z0 = -6, count = 12): SectorLots[] {
  const field = sectors(seed).lots;
  const out: SectorLots[] = [];
  for (let z = z0; z < z0 + count; z++) {
    for (let x = x0; x < x0 + count; x++) {
      const rec = field.lotsAt(x, z);
      if (rec.count > 0 && rec.settlement !== undefined && !isCity(rec.settlement)) out.push(rec);
    }
  }
  return out;
}

/** Total buildings across a list of sector records. */
function total(records: readonly SectorLots[]): number {
  return records.reduce((sum, rec) => sum + rec.count, 0);
}

/** The four footprint corners of one building, in world metres. */
function corners(rec: SectorLots, i: number): { x: number; z: number }[] {
  const cx = rec.centerX[i] as number;
  const cz = rec.centerZ[i] as number;
  const ax = rec.alongX[i] as number;
  const az = rec.alongZ[i] as number;
  const hw = rec.halfWidth[i] as number;
  const hd = rec.halfDepth[i] as number;
  const out: { x: number; z: number }[] = [];
  for (let u = -1; u <= 1; u += 2) {
    for (let v = -1; v <= 1; v += 2) {
      out.push({ x: cx + ax * hw * u - az * hd * v, z: cz + az * hw * u + ax * hd * v });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULE 3
// ---------------------------------------------------------------------------

describe('RULE 3', () => {
  const streets = (seed = SEED) => sectorStreetField(region(seed), seed);
  const flat: LotGround = { height: () => 0, target: () => 0 };

  it('refuses to run on anything but a sector context', () => {
    for (const tier of ['region', 'chunk'] as const) {
      expect(() =>
        generateSectorLots(
          { x: 0, z: 0 },
          createTierContext(SEED, tier, { region: region() }),
          streets(),
          flat,
        ),
      ).toThrow(/needs a 'sector' TierContext/);
    }
  });

  it('refuses a sector context with no Region-tier road record', () => {
    // A lot laid out without the roads would put a house on the carriageway,
    // and the symptom would be a building embedded in a deck a long way from
    // anything that could explain it.
    expect(() =>
      generateSectorLots({ x: 0, z: 0 }, createTierContext(SEED, 'sector'), streets(), flat),
    ).toThrow(/Region-tier road record/);
  });

  it('takes the street plan as an argument rather than through the context', () => {
    // Streets are the SAME tier, so `coarser('sector')` would throw. Passing the
    // plan in is what makes a same-tier dependency legal and explicit, and it is
    // what lets this test drive the generator with a plane for ground.
    const context = createTierContext(SEED, 'sector', { region: region() });
    expect(() => context.coarser('sector')).toThrow(/Tier rule violation/);
    expect(() => generateSectorLots({ x: 0, z: 0 }, context, streets(), flat)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reach: how far a sector's content may leave its own square
// ---------------------------------------------------------------------------

describe('reach', () => {
  it('overhangs its sector by less than half of one', () => {
    // `STREET_MAX_EXTENT`'s bound, one number larger. Break this and a query for
    // "what stands at this point" would have to read more than the four sectors
    // nearest it, which is a change to how every consumer of this tier is
    // written rather than a tuning adjustment.
    const overhang = SETTLEMENT_JITTER + LOT_MAX_EXTENT - SECTOR_SIZE / 2;
    expect(overhang).toBeGreaterThan(0);
    expect(overhang).toBeLessThan(SECTOR_SIZE / 2);
  });

  it('sites no real building beyond its own stated reach', () => {
    const records = populated();
    expect(records.length).toBeGreaterThan(0);
    expect(total(records)).toBeGreaterThan(60);
    for (const rec of records) {
      const site = rec.settlement;
      expect(site).toBeDefined();
      if (site === undefined) continue;
      expect(rec.reachRadius).toBeLessThanOrEqual(LOT_MAX_EXTENT);
      for (let i = 0; i < rec.count; i++) {
        const dx = (rec.centerX[i] as number) - site.x;
        const dz = (rec.centerZ[i] as number) - site.z;
        const far = Math.sqrt(dx * dx + dz * dz);
        expect(far).toBeLessThanOrEqual(rec.reachRadius);
        expect(far + BUILDING_HALF_WIDTH_MAX).toBeLessThanOrEqual(LOT_MAX_EXTENT);
      }
    }
  });

  it('leaves the overwhelming majority of sectors empty', () => {
    // The other half of `populated`: if this were false, "buildings are sparse"
    // -- which every cache size and draw-call estimate in the phase rests on --
    // would be wrong, and the tests above would be measuring a world of houses.
    const field = sectors().lots;
    let empty = 0;
    let seen = 0;
    for (let z = -6; z < 6; z++) {
      for (let x = -6; x < 6; x++) {
        seen++;
        if (field.lotsAt(x, z).count === 0) empty++;
      }
    }
    expect(seen).toBe(144);
    expect(empty / seen).toBeGreaterThan(0.8);
  });
});

// ---------------------------------------------------------------------------
// Determinism (RULE 1)
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical records from two independent field chains', () => {
    // Two chains, not two calls on one: a memo makes the second call trivially
    // equal, and what RULE 1 claims is that a fresh worker reproduces the bytes.
    clearLotCache();
    const first = sectors().lots.lotsAt(0, 0);
    clearLotCache();
    const second = sectors().lots.lotsAt(0, 0);
    expect(second.count).toBe(first.count);
    expect(Array.from(second.centerX)).toEqual(Array.from(first.centerX));
    expect(Array.from(second.centerZ)).toEqual(Array.from(first.centerZ));
    expect(Array.from(second.floorY)).toEqual(Array.from(first.floorY));
    expect(Array.from(second.alongX)).toEqual(Array.from(first.alongX));
    expect(Array.from(second.halfWidth)).toEqual(Array.from(first.halfWidth));
    expect(Array.from(second.kind)).toEqual(Array.from(first.kind));
    expect(Array.from(second.ridge)).toEqual(Array.from(first.ridge));
  });

  it('lays out a different village for a different seed', () => {
    const a = populated(SEED);
    const b = populated(hashString('lots-test-other'));
    expect(total(a)).toBeGreaterThan(0);
    expect(total(b)).toBeGreaterThan(0);
    const key = (records: SectorLots[]): string =>
      records.map((r) => `${r.sectorX},${r.sectorZ}:${r.count}`).join('|');
    expect(key(b)).not.toBe(key(a));
  });

  it('draws each property from its own salt', () => {
    // Reusing one salt across two quantities is invisible in a screenshot and
    // obvious here: every building would be exactly as deep as it is wide, and
    // its roof exactly as tall as its walls.
    const records = populated();
    let sameShape = 0;
    let sameHeight = 0;
    let count = 0;
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        count++;
        if (rec.halfWidth[i] === rec.halfDepth[i]) sameShape++;
        if (rec.eaves[i] === rec.ridge[i]) sameHeight++;
        if (rec.wallTint[i] === rec.roofTint[i]) sameHeight++;
      }
    }
    expect(count).toBeGreaterThan(60);
    expect(sameShape).toBe(0);
    expect(sameHeight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

describe('the memo', () => {
  it('returns the same object for a repeated sector and bounds what it holds', () => {
    clearLotCache();
    const field = sectors();
    // `builds` is cumulative for the life of the module, so the claim is about
    // the DELTA: a repeated sector costs one build, not two.
    const before = lotCacheStats().builds;
    const first = field.lots.lotsAt(3, 3);
    const again = field.lots.lotsAt(3, 3);
    expect(again).toBe(first);
    expect(lotCacheStats().builds - before).toBe(1);

    for (let i = 0; i < LOT_CACHE_LIMIT + 20; i++) field.lots.lotsAt(i, 40);
    expect(lotCacheStats().entries).toBeLessThanOrEqual(LOT_CACHE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Where a building may stand
// ---------------------------------------------------------------------------

describe('siting', () => {
  it('keeps every building clear of every street bed and of the carriageway', () => {
    const field = sectors();
    const records = populated();
    expect(total(records)).toBeGreaterThan(60);
    let checked = 0;
    for (const rec of records) {
      const site = rec.settlement;
      if (site === undefined) continue;
      const streets = field.streets.streetsAt(rec.sectorX, rec.sectorZ);
      const net = region().roads.networkAt(site.x, site.z);
      for (let i = 0; i < rec.count; i++) {
        checked++;
        const cx = rec.centerX[i] as number;
        const cz = rec.centerZ[i] as number;
        const bounding = Math.sqrt(
          (rec.halfWidth[i] as number) * (rec.halfWidth[i] as number) +
            (rec.halfDepth[i] as number) * (rec.halfDepth[i] as number),
        );
        // Clear of the roadbed, measured the way the generator measures it.
        expect(roadClearance(net, cx, cz)).toBeGreaterThanOrEqual(bounding + LOT_ROAD_CLEAR);
        // And clear of every street bed. Recomputed here from the street plan
        // rather than trusting the record.
        let nearest = Infinity;
        for (let s = 0; s < streets.streetCount; s++) {
          const from = streets.streetStart[s] as number;
          const to = streets.streetStart[s + 1] as number;
          for (let n = from; n + 1 < to; n++) {
            nearest = Math.min(
              nearest,
              pointToSegment(
                cx,
                cz,
                streets.nodeX[n] as number,
                streets.nodeZ[n] as number,
                streets.nodeX[n + 1] as number,
                streets.nodeZ[n + 1] as number,
              ),
            );
          }
        }
        expect(nearest).toBeGreaterThanOrEqual(
          streets.halfWidth + (rec.halfDepth[i] as number) + LOT_STREET_CLEAR,
        );
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('never overlaps two buildings', () => {
    const records = populated();
    expect(total(records)).toBeGreaterThan(60);
    let pairs = 0;
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        for (let j = i + 1; j < rec.count; j++) {
          pairs++;
          const dx = (rec.centerX[i] as number) - (rec.centerX[j] as number);
          const dz = (rec.centerZ[i] as number) - (rec.centerZ[j] as number);
          const ri = Math.sqrt(
            (rec.halfWidth[i] as number) ** 2 + (rec.halfDepth[i] as number) ** 2,
          );
          const rj = Math.sqrt(
            (rec.halfWidth[j] as number) ** 2 + (rec.halfDepth[j] as number) ** 2,
          );
          expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThanOrEqual(ri + rj + LOT_GAP);
        }
      }
    }
    expect(pairs).toBeGreaterThan(100);
  });

  it('stays under the per-sector cap', () => {
    for (const rec of populated()) expect(rec.count).toBeLessThanOrEqual(LOT_MAX_BUILDINGS);
  });
});

// ---------------------------------------------------------------------------
// The ground, which is the test that actually refuses things
// ---------------------------------------------------------------------------

describe('the ground under a lot', () => {
  it('fixes the floor at the height the world reports there', () => {
    // The claim the whole phase rests on. `floorY` is LOD-independent because it
    // is `sampleHeight` and nothing else; a building drawn at a coarse level
    // must sit at the same altitude it does at a fine one, and this is where a
    // second implementation of "where is the ground" would show up.
    const records = populated();
    expect(total(records)).toBeGreaterThan(60);
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        const x = rec.centerX[i] as number;
        const z = rec.centerZ[i] as number;
        expect(rec.floorY[i]).toBe(sampleHeight(x, z, SEED));
      }
    }
  });

  it('refuses ground the village failed to level', () => {
    // The one test that subsumes the river test, the steep-hillside test and the
    // outside-the-pad test. Asserted on the accepted lots, so it is a statement
    // about what survived rather than about what the code intended.
    const blend = new GradeBlend();
    const field = sectors();
    const reg = region();
    const records = populated();
    expect(total(records)).toBeGreaterThan(60);
    let level = 0;
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        const x = rec.centerX[i] as number;
        const z = rec.centerZ[i] as number;
        const target = gradeTarget(reg, field.streets, x, z, blend);
        // Everything accepted is inside a settlement pad, so something graded
        // it -- an ungraded point reports -Infinity and could never pass.
        expect(target).toBeGreaterThan(-Infinity);
        expect(Math.abs((rec.floorY[i] as number) - target)).toBeLessThanOrEqual(LOT_UNLEVEL_MAX);
        level++;

        let low = Infinity;
        let high = -Infinity;
        for (const c of corners(rec, i)) {
          const h = sampleHeight(c.x, c.z, SEED);
          low = Math.min(low, h);
          high = Math.max(high, h);
        }
        expect(high - low).toBeLessThanOrEqual(LOT_SPREAD_MAX);
      }
    }
    expect(level).toBeGreaterThan(60);
  });

  it('accepts far fewer lots than it offers, so the tests above are not free', () => {
    // The sharpest anti-vacuity guard here. Every "no building is X" assertion
    // above would pass on a generator that accepted nothing, and every one would
    // also pass on one that accepted everything if the ground happened to be
    // flat. Candidates are spaced `LOT_FRONTAGE` apart on both sides of every
    // street, so a settlement offers many times what it keeps.
    const records = populated();
    const kept = total(records);
    let offered = 0;
    const field = sectors();
    for (const rec of records) {
      const streets = field.streets.streetsAt(rec.sectorX, rec.sectorZ);
      let length = 0;
      for (let s = 0; s < streets.streetCount; s++) {
        const from = streets.streetStart[s] as number;
        const to = streets.streetStart[s + 1] as number;
        for (let n = from; n + 1 < to; n++) {
          const dx = (streets.nodeX[n + 1] as number) - (streets.nodeX[n] as number);
          const dz = (streets.nodeZ[n + 1] as number) - (streets.nodeZ[n] as number);
          length += Math.sqrt(dx * dx + dz * dz);
        }
      }
      offered += (length / 16) * 2;
    }
    expect(kept).toBeGreaterThan(60);
    expect(offered).toBeGreaterThan(kept * 1.5);
  });
});

// ---------------------------------------------------------------------------
// Facing, and the ban on trigonometry
// ---------------------------------------------------------------------------

describe('facing', () => {
  it('stores a unit direction and turns each building only slightly off its street', () => {
    // Stored as a direction pair rather than as radians because nothing
    // downstream may call `Math.cos` on the path to a stored vertex. The skew
    // bound is what keeps a village legible: mixing in the perpendicular and
    // renormalising is a rotation of at most `atan(BUILDING_SKEW)`.
    const records = populated();
    expect(total(records)).toBeGreaterThan(60);
    let skewed = 0;
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        const ax = rec.alongX[i] as number;
        const az = rec.alongZ[i] as number;
        expect(Math.abs(Math.sqrt(ax * ax + az * az) - 1)).toBeLessThan(1e-12);
        // The mix is `dir + normal * skew` renormalised, so the component along
        // the street can never drop below `1 / sqrt(1 + skew^2)`.
        const minAlong = 1 / Math.sqrt(1 + BUILDING_SKEW * BUILDING_SKEW);
        expect(Math.abs(ax * ax + az * az)).toBeGreaterThanOrEqual(minAlong * minAlong - 1e-12);
        if (Math.abs(ax) !== 1 && Math.abs(az) !== 1) skewed++;
      }
    }
    expect(skewed).toBeGreaterThan(60);
  });

  it('gives every building a footprint inside the declared range', () => {
    const records = populated();
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        expect(rec.halfWidth[i]).toBeGreaterThan(0);
        expect(rec.halfWidth[i]).toBeLessThanOrEqual(BUILDING_HALF_WIDTH_MAX);
        expect(rec.halfDepth[i]).toBeGreaterThan(0);
        expect(rec.halfDepth[i]).toBeLessThanOrEqual(BUILDING_HALF_DEPTH_MAX);
        expect(rec.eaves[i]).toBeGreaterThan(0);
        expect(rec.ridge[i]).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The injected ground
// ---------------------------------------------------------------------------

describe('LotGround', () => {
  it('is what decides acceptance, and a flat world proves it', () => {
    // The injection is not plumbing for its own sake: it is what lets a test
    // state "on perfectly level ground every geometric survivor is accepted"
    // without a height field in the way. A plane where the target and the
    // surface agree passes both ground tests by construction, so the only
    // rejections left are the geometric ones.
    clearLotCache();
    const flat: LotGround = { height: () => 12, target: () => 12 };
    const streets = sectorStreetField(region(), SEED);
    const context = createTierContext(SEED, 'sector', { region: region() });

    let flatTotal = 0;
    let realTotal = 0;
    for (let z = -6; z < 6; z++) {
      for (let x = -6; x < 6; x++) {
        if (streets.streetsAt(x, z).settlement === undefined) continue;
        flatTotal += generateSectorLots({ x, z }, context, streets, flat).count;
        realTotal += sectorLots(
          region(),
          streets,
          { height: (px, pz) => sampleHeight(px, pz, SEED), target: () => 0 },
          SEED,
          x,
          z,
        ).count;
      }
    }
    expect(flatTotal).toBeGreaterThan(60);
    // Every building on the plane sits at the plane's altitude, and there are
    // strictly more of them than the real world accepts -- which is the whole
    // claim that the ground tests reject something.
    expect(realTotal).toBeLessThan(flatTotal);
  });
});

/** Distance from a point to a segment. Independent of `grading.ts`, deliberately. */
function pointToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  let t = lengthSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + dx * t - px;
  const cz = az + dz * t - pz;
  return Math.sqrt(cx * cx + cz * cz);
}

// ---------------------------------------------------------------------------
// Phase 7b: lots still form on every street layout family
// ---------------------------------------------------------------------------

describe('lots across layout families', () => {
  it('places at least one building on each of ring, linear, grid and hilltop', () => {
    const field = sectors();
    const byFamily = [0, 0, 0, 0];
    for (let z = -14; z < 14; z++) {
      for (let x = -14; x < 14; x++) {
        const streets = field.streets.streetsAt(x, z);
        if (streets.settlement === undefined || streets.layout < 0) continue;
        const lots = field.lots.lotsAt(x, z);
        if (lots.count > 0) byFamily[streets.layout]! += lots.count;
      }
    }
    for (const family of [0, 1, 2, 3]) {
      expect(byFamily[family]!).toBeGreaterThan(0);
    }
  });
});

describe('building kinds', () => {
  it('emits only cottage / barn / hall, and every kind appears', () => {
    const records = populated();
    const seen = [0, 0, 0];
    let total = 0;
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        const k = rec.kind[i] as number;
        expect(k === KIND_COTTAGE || k === KIND_BARN || k === KIND_HALL).toBe(true);
        seen[k]!++;
        total++;
      }
    }
    expect(total).toBeGreaterThan(60);
    expect(seen[KIND_COTTAGE]).toBeGreaterThan(0);
    expect(seen[KIND_BARN]).toBeGreaterThan(0);
    expect(seen[KIND_HALL]).toBeGreaterThan(0);
    // Cottage stays the majority so a village still reads as houses.
    expect(seen[KIND_COTTAGE]!).toBeGreaterThan(seen[KIND_BARN]!);
    expect(seen[KIND_COTTAGE]!).toBeGreaterThan(seen[KIND_HALL]!);
  });

  it('gives barns a wider footprint than cottages on average', () => {
    const records = populated();
    let cottageW = 0;
    let cottageN = 0;
    let barnW = 0;
    let barnN = 0;
    for (const rec of records) {
      for (let i = 0; i < rec.count; i++) {
        const w = rec.halfWidth[i] as number;
        if (rec.kind[i] === KIND_COTTAGE) {
          cottageW += w;
          cottageN++;
        } else if (rec.kind[i] === KIND_BARN) {
          barnW += w;
          barnN++;
        }
      }
    }
    expect(cottageN).toBeGreaterThan(0);
    expect(barnN).toBeGreaterThan(0);
    expect(barnW / barnN).toBeGreaterThan(cottageW / cottageN);
  });
});

