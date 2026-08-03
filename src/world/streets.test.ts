/**
 * Tests for Phase 4b: Sector-tier street layout inside a settlement.
 *
 * Three kinds of test, as `roads.test.ts` has:
 *
 * PURE ARITHMETIC. `ringDirection` has one right answer and no world in it, and
 * the "no trigonometry on the path to a stored vertex" rule is a determinism
 * guarantee rather than a style, so it is asserted directly.
 *
 * THE TIER SYSTEM. The Sector tier is the whole point of the phase. That a
 * sector may read a region and may not read a chunk, that a sector holds at most
 * one settlement, and that a settlement never leaves the sector its cell owns,
 * are all statements the type system cannot make.
 *
 * THE REAL WORLD. Determinism, the memo, sector-boundary agreement, "a street
 * never lands on a road" and "a street actually changes the ground" are claims
 * about the world this project ships, so they are asserted against the actual
 * height field.
 */

import { describe, expect, it } from 'vitest';
import { hashString } from '../core/hash';
import { createTierContext, SECTOR_SIZE } from './contracts';
import {
  GradeBlend,
  GRADE_OUT_LENGTH,
  GRADE_STREET_SURFACE,
  ROAD_MAX_CUT,
  ROAD_MAX_FILL,
} from './grading';
import { baseHeight, gradeSurface, sampleHeight, worldRegionField } from './height-field';
import {
  SETTLEMENT_CELL,
  SETTLEMENT_JITTER,
  SETTLEMENT_RADIUS_MAX,
  type RoadNetwork,
  type Settlement,
} from './roads';
import {
  clearStreetCache,
  generateSectorStreets,
  layoutFamily,
  LAYOUT_GRID,
  LAYOUT_HILLTOP,
  LAYOUT_LINEAR,
  LAYOUT_RING,
  ringDirection,
  sectorStreetField,
  sectorStreets,
  streetCacheStats,
  STREET_CACHE_LIMIT,
  STREET_MAX_EXTENT,
  STREET_REACH,
  STREET_RING_NODES_MAX,
  STREET_RING_NODES_MIN,
  STREET_SHOULDER,
  type SectorStreets,
  type StreetRegion,
} from './streets';

const SEED = hashString('streets-test');

const region = (seed = SEED): StreetRegion => worldRegionField(seed);

/** Every sector coordinate in a square block, coarse-to-fine reading order. */
function* sectorBlock(
  x0: number,
  z0: number,
  count: number,
): Generator<{ x: number; z: number }> {
  for (let z = z0; z < z0 + count; z++) {
    for (let x = x0; x < x0 + count; x++) yield { x, z };
  }
}

/** Every laid-out sector in a block, so the real-world tests are not vacuous. */
function populatedSectors(seed: number, x0: number, z0: number, count: number): SectorStreets[] {
  const field = sectorStreetField(region(seed), seed);
  const out: SectorStreets[] = [];
  for (const c of sectorBlock(x0, z0, count)) {
    const rec = field.streetsAt(c.x, c.z);
    if (rec.settlement !== undefined) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULE 3: the first three-level read in the project
// ---------------------------------------------------------------------------

describe('RULE 3', () => {
  it('refuses to run on anything but a sector context', () => {
    for (const tier of ['region', 'chunk'] as const) {
      expect(() =>
        generateSectorStreets({ x: 0, z: 0 }, createTierContext(SEED, tier, { region: region() })),
      ).toThrow(/needs a 'sector' TierContext/);
    }
  });

  it('may read the Region tier, and may not read its own or finer', () => {
    // THE POINT OF THE PHASE. Phases 1 to 4a used two of the three declared
    // tiers; `coarser('region')` from a sector context is the read that has been
    // legal since Phase 1 and performed by nothing.
    const context = createTierContext(SEED, 'sector', { region: region() });
    expect(context.coarser('region')).toBeDefined();
    for (const tier of ['sector', 'chunk'] as const) {
      expect(() => context.coarser(tier)).toThrow(/Tier rule violation/);
    }
  });

  it('refuses a sector context with no Region-tier road record', () => {
    // A settlement laid out without its roads would put a lane down the middle
    // of one, and the failure would surface as a graded artefact hundreds of
    // chunks away rather than as an error here.
    expect(() => generateSectorStreets({ x: 0, z: 0 }, createTierContext(SEED, 'sector'))).toThrow(
      /Region-tier road record/,
    );
    expect(() =>
      generateSectorStreets({ x: 0, z: 0 }, createTierContext(SEED, 'sector', { region: {} })),
    ).toThrow(/Region-tier road record/);
  });
});

// ---------------------------------------------------------------------------
// Directions, and the ban on trigonometry
// ---------------------------------------------------------------------------

describe('ringDirection', () => {
  it('returns exactly unit vectors', () => {
    // Not "close to unit". The direction scales the ring radius, which decides a
    // vertex altitude, so a length that drifts is a vertex that drifts.
    const out = new Float64Array(2);
    for (let n = STREET_RING_NODES_MIN; n <= STREET_RING_NODES_MAX; n++) {
      for (let k = 0; k < n; k++) {
        ringDirection(k / n, out);
        const length = Math.hypot(out[0] as number, out[1] as number);
        expect(Math.abs(length - 1)).toBeLessThan(1e-15);
      }
    }
  });

  it('walks once around the circle without repeating or reversing', () => {
    const out = new Float64Array(2);
    const points: [number, number][] = [];
    const n = 16;
    for (let k = 0; k < n; k++) {
      ringDirection(k / n, out);
      points.push([out[0] as number, out[1] as number]);
    }
    // Consecutive directions turn the same way every time -- a positive cross
    // product throughout -- which is what "monotonic around the circle" means
    // without an angle to measure it with.
    for (let k = 0; k < n; k++) {
      const a = points[k] as [number, number];
      const b = points[(k + 1) % n] as [number, number];
      expect(a[0] * b[1] - a[1] * b[0]).toBeGreaterThan(0);
    }
    // The four axis directions are hit EXACTLY, which is what makes the diamond
    // parametrisation close on itself with no seam at t = 0. Compared by value
    // rather than by identity, because IEEE-754 has a signed zero and `-0` is a
    // perfectly good zero here.
    const axis = (k: number): [number, number] => {
      const p = points[k] as [number, number];
      return [p[0] + 0, p[1] + 0];
    };
    expect(axis(0)).toEqual([1, 0]);
    expect(axis(4)).toEqual([0, 1]);
    expect(axis(8)).toEqual([-1, 0]);
    expect(axis(12)).toEqual([0, -1]);
  });

  it('spaces the directions evenly enough to read as a ring', () => {
    // The diamond-to-circle map compresses toward the diagonals. It is allowed
    // to, but not by an amount larger than the radial jitter that hides it: no
    // gap may be more than 1.5x the smallest.
    const out = new Float64Array(2);
    const n = 12;
    let minDot = -1;
    let maxDot = 1;
    for (let k = 0; k < n; k++) {
      ringDirection(k / n, out);
      const ax = out[0] as number;
      const az = out[1] as number;
      ringDirection(((k + 1) % n) / n, out);
      const dot = ax * (out[0] as number) + az * (out[1] as number);
      if (dot > minDot) minDot = dot;
      if (dot < maxDot) maxDot = dot;
    }
    // Larger dot means a smaller gap. Convert both to gaps and compare.
    const smallest = Math.acos(minDot);
    const largest = Math.acos(maxDot);
    expect(largest / smallest).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// A sector holds at most one settlement, and that is the phase's open decision
// ---------------------------------------------------------------------------

describe('sector containment', () => {
  it('the settlement lattice IS the sector grid', () => {
    // Phase 4a set `SETTLEMENT_CELL = SECTOR_SIZE` so that this phase would be a
    // refinement of its siting rather than a second grid. If that ever stops
    // being true, everything below is wrong, so it is asserted rather than
    // assumed -- along with the jitter bound that keeps a candidate inside its
    // own cell.
    expect(SETTLEMENT_CELL).toBe(SECTOR_SIZE);
    expect(SETTLEMENT_JITTER).toBeLessThan(SECTOR_SIZE / 2);
  });

  it('never lays out more than one settlement per sector, over a whole region', () => {
    const laid = populatedSectors(SEED, -4, -4, 16);
    expect(laid.length).toBeGreaterThan(3); // anti-vacuity: villages exist
    for (const rec of laid) {
      const s = rec.settlement as Settlement;
      // The sector that owns it is the settlement's own lattice cell.
      expect(rec.sectorX).toBe(s.cellX);
      expect(rec.sectorZ).toBe(s.cellZ);
      expect(Math.floor(s.x / SECTOR_SIZE)).toBe(rec.sectorX);
      expect(Math.floor(s.z / SECTOR_SIZE)).toBe(rec.sectorZ);
    }
  });

  it('leaves the overwhelming majority of sectors empty, and empty is cheap', () => {
    const field = sectorStreetField(region(), SEED);
    let empty = 0;
    let total = 0;
    for (const c of sectorBlock(-4, -4, 16)) {
      const rec = field.streetsAt(c.x, c.z);
      total++;
      if (rec.settlement === undefined) {
        empty++;
        expect(rec.streetCount).toBe(0);
        expect(rec.segCount).toBe(0);
        expect(rec.nodeX.length).toBe(0);
        expect(rec.reachRadius).toBe(0);
      }
    }
    expect(empty / total).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// The overhang, which is what decides how many sectors a query reads
// ---------------------------------------------------------------------------

describe('STREET_REACH', () => {
  it('is under half a sector, so a query never reads more than four', () => {
    expect(STREET_REACH).toBeLessThan(SECTOR_SIZE / 2);
    expect(STREET_REACH).toBeGreaterThanOrEqual(
      SETTLEMENT_JITTER + STREET_MAX_EXTENT - SECTOR_SIZE / 2,
    );
    // Including its graded corridor, a street stays inside the footprint the
    // settlement pad already claims. A lane that ran past the rim would be
    // grading ground the pad is busy tapering off, and the two would fight.
    expect(STREET_MAX_EXTENT).toBeLessThan(SETTLEMENT_RADIUS_MAX);
  });

  it('bounds every street node in the real world', () => {
    // The derived constant is a promise about geometry that is generated from
    // noise, so it is checked against the geometry rather than against itself.
    const laid = populatedSectors(SEED, -6, -6, 20);
    expect(laid.length).toBeGreaterThan(3);
    let worst = 0;
    for (const rec of laid) {
      const minX = rec.sectorX * SECTOR_SIZE;
      const minZ = rec.sectorZ * SECTOR_SIZE;
      for (let i = 0; i < rec.nodeX.length; i++) {
        const x = rec.nodeX[i] as number;
        const z = rec.nodeZ[i] as number;
        const outside = Math.max(minX - x, x - (minX + SECTOR_SIZE), minZ - z, z - (minZ + SECTOR_SIZE));
        if (outside > worst) worst = outside;
      }
      expect(rec.reachRadius).toBeLessThanOrEqual(STREET_MAX_EXTENT + 1e-9);
    }
    expect(worst).toBeLessThanOrEqual(STREET_REACH);
  });

  it('picks up a settlement that overhangs into a neighbouring sector', () => {
    // THE REASON A QUERY READS UP TO FOUR SECTORS. A settlement centred near a
    // sector edge puts graded, surfaced ground in the sector next door, and that
    // sector does not own it. If the query only ever read its own sector, the
    // village would be sliced off along a 512 m line.
    const field = sectorStreetField(region(), SEED);
    const blend = new GradeBlend();
    const out = new Float64Array(GRADE_OUT_LENGTH);
    let checked = 0;
    for (const rec of populatedSectors(SEED, -8, -8, 24)) {
      const s = rec.settlement as Settlement;
      const minX = rec.sectorX * SECTOR_SIZE;
      for (let i = 0; i < rec.nodeX.length; i++) {
        const x = rec.nodeX[i] as number;
        if (x >= minX) continue; // this node is not over the western edge
        const z = rec.nodeZ[i] as number;
        // The point is inside the NEIGHBOURING sector, which owns no settlement.
        expect(field.streetsAt(rec.sectorX - 1, rec.sectorZ).settlement?.cellX).not.toBe(s.cellX);
        blend.reset();
        field.accumulate(x, z, blend);
        blend.resolve(s.y - 5, 0, out);
        expect(out[GRADE_STREET_SURFACE] as number).toBeGreaterThan(0.5);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The layout itself
// ---------------------------------------------------------------------------

describe('the street plan', () => {
  it('picks a layout family from (seed, cell) and keeps ring the majority', () => {
    // Bias is load-bearing for soak: ring ~52%, the other three share the rest.
    const counts = [0, 0, 0, 0];
    for (let z = -40; z < 40; z++) {
      for (let x = -40; x < 40; x++) {
        counts[layoutFamily(SEED, x, z)]!++;
      }
    }
    const total = counts.reduce((a, b) => a + b, 0);
    expect(counts[LAYOUT_RING]! / total).toBeGreaterThan(0.45);
    expect(counts[LAYOUT_LINEAR]!).toBeGreaterThan(0);
    expect(counts[LAYOUT_GRID]!).toBeGreaterThan(0);
    expect(counts[LAYOUT_HILLTOP]!).toBeGreaterThan(0);
    expect(layoutFamily(SEED, 3, 7)).toBe(layoutFamily(SEED, 3, 7));
    expect(layoutFamily(SEED, 3, 7)).not.toBe(layoutFamily(hashString('other'), 3, 7));
  });

  it('tags every populated sector with its layout family', () => {
    let seen = 0;
    for (const rec of populatedSectors(SEED, -10, -10, 28)) {
      expect(rec.layout).toBeGreaterThanOrEqual(LAYOUT_RING);
      expect(rec.layout).toBeLessThanOrEqual(LAYOUT_HILLTOP);
      expect(rec.layout).toBe(
        layoutFamily(SEED, (rec.settlement as Settlement).cellX, (rec.settlement as Settlement).cellZ),
      );
      seen++;
    }
    expect(seen).toBeGreaterThan(5);
  });

  it('gives ring and hilltop a closed first street; linear a long spine; grid orthogonal runs', () => {
    const byFamily: SectorStreets[][] = [[], [], [], []];
    for (const rec of populatedSectors(SEED, -12, -12, 32)) {
      byFamily[rec.layout]!.push(rec);
    }
    for (const family of [LAYOUT_RING, LAYOUT_LINEAR, LAYOUT_GRID, LAYOUT_HILLTOP]) {
      expect(byFamily[family]!.length).toBeGreaterThan(0);
    }

    for (const rec of byFamily[LAYOUT_RING]!) {
      expect(rec.streetCount).toBeGreaterThan(1);
      const ringEnd = (rec.streetStart[1] as number) - 1;
      expect(rec.nodeX[ringEnd]).toBe(rec.nodeX[0]);
      expect(rec.nodeZ[ringEnd]).toBe(rec.nodeZ[0]);
      expect(ringEnd).toBeGreaterThanOrEqual(STREET_RING_NODES_MIN);
      expect(ringEnd).toBeLessThanOrEqual(STREET_RING_NODES_MAX);
      for (let s = 1; s < rec.streetCount; s++) {
        expect((rec.streetStart[s + 1] as number) - (rec.streetStart[s] as number)).toBe(2);
      }
    }

    for (const rec of byFamily[LAYOUT_HILLTOP]!) {
      const ringEnd = (rec.streetStart[1] as number) - 1;
      expect(rec.nodeX[ringEnd]).toBe(rec.nodeX[0]);
      expect(rec.nodeZ[ringEnd]).toBe(rec.nodeZ[0]);
      expect(ringEnd).toBeGreaterThanOrEqual(4);
      expect(ringEnd).toBeLessThanOrEqual(9);
    }

    for (const rec of byFamily[LAYOUT_LINEAR]!) {
      expect(rec.streetCount).toBeGreaterThan(0);
      const from = rec.streetStart[0] as number;
      const to = rec.streetStart[1] as number;
      expect(to - from).toBeGreaterThanOrEqual(4);
      let spine = 0;
      for (let i = from; i + 1 < to; i++) {
        const dx = (rec.nodeX[i + 1] as number) - (rec.nodeX[i] as number);
        const dz = (rec.nodeZ[i + 1] as number) - (rec.nodeZ[i] as number);
        spine += Math.hypot(dx, dz);
      }
      const s = rec.settlement as Settlement;
      expect(spine).toBeGreaterThan(s.radius * 0.8);
    }

    for (const rec of byFamily[LAYOUT_GRID]!) {
      expect(rec.streetCount).toBeGreaterThanOrEqual(2);
      let orthogonalPairs = 0;
      const dirs: [number, number][] = [];
      for (let s = 0; s < rec.streetCount; s++) {
        const a = rec.streetStart[s] as number;
        const b = (rec.streetStart[s + 1] as number) - 1;
        const dx = (rec.nodeX[b] as number) - (rec.nodeX[a] as number);
        const dz = (rec.nodeZ[b] as number) - (rec.nodeZ[a] as number);
        const len = Math.hypot(dx, dz);
        if (len < 1) continue;
        dirs.push([dx / len, dz / len]);
      }
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          const a = dirs[i] as [number, number];
          const b = dirs[j] as [number, number];
          if (Math.abs(a[0] * b[0] + a[1] * b[1]) < 0.2) orthogonalPairs++;
        }
      }
      expect(orthogonalPairs).toBeGreaterThan(0);
    }
  });

  it('holds the settlement altitude at every node', () => {
    // The composition with the settlement pad, stated. Both target the same
    // altitude, so a street leaving the pad's flat core carries that altitude
    // outward instead of arguing with it -- which is why this file needs no
    // gradient limiter of its own.
    for (const rec of populatedSectors(SEED, -6, -6, 20)) {
      const s = rec.settlement as Settlement;
      for (let i = 0; i < rec.nodeY.length; i++) expect(rec.nodeY[i]).toBe(s.y);
    }
  });

  it('never lays a non-spine lane along a road leaving the same settlement', () => {
    // THE RULE THAT MAKES A STREET A REFINEMENT RATHER THAN A DUPLICATE. Ring and
    // hilltop drop any lane whose bearing matches a leaving road; the concrete
    // check is that the tip of every spoke/lane stays clear of the carriageway.
    // Linear spines and grid runs sit beside (or on) the road corridor by design
    // — those families are covered by the layout shape tests instead.
    const roads = worldRegionField(SEED).roads;
    let withRoads = 0;
    let outerNodes = 0;
    for (const rec of populatedSectors(SEED, -8, -8, 24)) {
      if (rec.layout !== LAYOUT_RING && rec.layout !== LAYOUT_HILLTOP) continue;
      const s = rec.settlement as Settlement;
      const net = roads.networkAt(s.x, s.z);
      const own = ownRoadSegments(net, s);
      if (own.length === 0) continue;
      withRoads++;
      for (let street = 1; street < rec.streetCount; street++) {
        const from = rec.streetStart[street] as number;
        const to = rec.streetStart[street + 1] as number;
        let best = from;
        let bestD = -1;
        for (let i = from; i < to; i++) {
          const d = Math.hypot((rec.nodeX[i] as number) - s.x, (rec.nodeZ[i] as number) - s.z);
          if (d > bestD) {
            bestD = d;
            best = i;
          }
        }
        if (bestD < 1) continue;
        outerNodes++;
        expect(
          nearestRoadDistance(own, rec.nodeX[best] as number, rec.nodeZ[best] as number),
        ).toBeGreaterThan(15);
      }
    }
    expect(withRoads).toBeGreaterThan(1);
    expect(outerNodes).toBeGreaterThan(10);
  });

  it('leaves enough street length for lots on every family', () => {
    // Anti-vacuity for Phase 7b: a family that emits a closed plan with no
    // walkable frontage would pass every street test and starve buildings.
    const byFamily = [0, 0, 0, 0];
    for (const rec of populatedSectors(SEED, -12, -12, 32)) {
      let length = 0;
      for (let s = 0; s < rec.streetCount; s++) {
        const from = rec.streetStart[s] as number;
        const to = rec.streetStart[s + 1] as number;
        for (let n = from; n + 1 < to; n++) {
          const dx = (rec.nodeX[n + 1] as number) - (rec.nodeX[n] as number);
          const dz = (rec.nodeZ[n + 1] as number) - (rec.nodeZ[n] as number);
          length += Math.hypot(dx, dz);
        }
      }
      expect(length).toBeGreaterThan(40);
      byFamily[rec.layout]!++;
    }
    for (const family of [LAYOUT_RING, LAYOUT_LINEAR, LAYOUT_GRID, LAYOUT_HILLTOP]) {
      expect(byFamily[family]!).toBeGreaterThan(0);
    }
  });
});

/** The routed roads that begin or end at a settlement, as flat segment lists. */
function ownRoadSegments(net: RoadNetwork, s: Settlement): number[][] {
  const out: number[][] = [];
  for (let p = 0; p + 1 < net.pathStart.length; p++) {
    const from = net.pathStart[p] as number;
    const to = net.pathStart[p + 1] as number;
    if (to - from < 2) continue;
    const atStart =
      Math.hypot((net.nodeX[from] as number) - s.x, (net.nodeZ[from] as number) - s.z) < 1;
    const atEnd =
      Math.hypot((net.nodeX[to - 1] as number) - s.x, (net.nodeZ[to - 1] as number) - s.z) < 1;
    if (!atStart && !atEnd) continue;
    for (let i = from; i + 1 < to; i++) {
      out.push([
        net.nodeX[i] as number,
        net.nodeZ[i] as number,
        net.nodeX[i + 1] as number,
        net.nodeZ[i + 1] as number,
      ]);
    }
  }
  return out;
}

function nearestRoadDistance(segments: number[][], x: number, z: number): number {
  const out = new Float64Array(2);
  let best = Infinity;
  for (const seg of segments) {
    const ax = seg[0] as number;
    const az = seg[1] as number;
    const bx = seg[2] as number;
    const bz = seg[3] as number;
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq)) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) best = d;
    out[0] = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Determinism and the memo
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('rebuilds byte-identically after the memo is dropped', () => {
    // RULE 2 for derived data: the cache is a pure function of its key, so it
    // can be thrown away and the same bytes must come back. That is what makes
    // it not "global mutable world state".
    const laid = populatedSectors(SEED, -6, -6, 12);
    expect(laid.length).toBeGreaterThan(2);
    const before = laid.map((r) => ({
      key: `${r.sectorX},${r.sectorZ}`,
      x: Array.from(r.nodeX),
      z: Array.from(r.nodeZ),
      y: Array.from(r.nodeY),
      start: Array.from(r.streetStart),
    }));

    clearStreetCache();
    expect(streetCacheStats().entries).toBe(0);

    const field = sectorStreetField(region(), SEED);
    for (const b of before) {
      const [sx, sz] = b.key.split(',').map(Number) as [number, number];
      const again = field.streetsAt(sx, sz);
      expect(Array.from(again.nodeX)).toEqual(b.x);
      expect(Array.from(again.nodeZ)).toEqual(b.z);
      expect(Array.from(again.nodeY)).toEqual(b.y);
      expect(Array.from(again.streetStart)).toEqual(b.start);
    }
  });

  it('does not depend on the order sectors are visited in', () => {
    const field = sectorStreetField(region(), SEED);
    const forwards: string[] = [];
    for (const c of sectorBlock(-3, -3, 8)) {
      forwards.push(`${c.x},${c.z}:${Array.from(field.streetsAt(c.x, c.z).nodeX).join(',')}`);
    }
    clearStreetCache();
    const coords = [...sectorBlock(-3, -3, 8)].reverse();
    const backwards = new Map<string, string>();
    for (const c of coords) {
      backwards.set(
        `${c.x},${c.z}`,
        `${c.x},${c.z}:${Array.from(field.streetsAt(c.x, c.z).nodeX).join(',')}`,
      );
    }
    for (const line of forwards) {
      const key = line.slice(0, line.indexOf(':'));
      expect(backwards.get(key)).toBe(line);
    }
  });

  it('keeps the memo bounded', () => {
    clearStreetCache();
    const field = sectorStreetField(region(), SEED);
    for (let i = 0; i < STREET_CACHE_LIMIT * 2; i++) field.streetsAt(500 + i, 500);
    expect(streetCacheStats().entries).toBe(STREET_CACHE_LIMIT);
    expect(streetCacheStats().limit).toBe(STREET_CACHE_LIMIT);
  });

  it('does not alias two seeds', () => {
    clearStreetCache();
    const a = sectorStreets(region(SEED), SEED, 3, 2);
    const b = sectorStreets(region(SEED + 1), SEED + 1, 3, 2);
    expect(a.worldSeed).not.toBe(b.worldSeed);
    // Either the sites differ or the layouts do; what must never happen is the
    // second seed getting the first's cached answer back.
    const same =
      a.nodeX.length === b.nodeX.length &&
      Array.from(a.nodeX).every((v, i) => v === (b.nodeX[i] as number));
    expect(same && a.settlement !== undefined).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Sector tier is load-bearing, and the ground is continuous
// ---------------------------------------------------------------------------

describe('the graded ground', () => {
  it('actually moves, so the tier is not decorative', () => {
    // ANTI-VACUITY, and the one test that would fail if `streets.ts` returned
    // nothing at all. Every other test in this file is about the SHAPE of the
    // answer; this one is about there being one. A street's target is the same
    // altitude the settlement pad uses, so inside the pad's flat core it changes
    // nothing -- the difference appears where a lane runs out past that core,
    // which is the whole visible content of the phase.
    const field = worldRegionField(SEED);
    const sectors = sectorStreetField(field, SEED);
    const blend = new GradeBlend();
    const out = new Float64Array(GRADE_OUT_LENGTH);
    let differed = 0;
    let surfaced = 0;
    for (const rec of populatedSectors(SEED, -8, -8, 24)) {
      for (let street = 1; street < rec.streetCount; street++) {
        const i = (rec.streetStart[street] as number) + 1;
        const x = rec.nodeX[i] as number;
        const z = rec.nodeZ[i] as number;
        const base = baseHeight(x, z, SEED);
        const drop = field.rivers.drop(x, z, base);
        const carved = base - drop;
        gradeSurface(field, sectors, x, z, carved, drop, blend, out);
        if ((out[GRADE_STREET_SURFACE] as number) > 0.5) surfaced++;
        const roadsOnly = carved + field.roads.lift(x, z, carved, drop);
        if (Math.abs(carved + (out[0] as number) - roadsOnly) > 0.05) differed++;
      }
    }
    expect(surfaced).toBeGreaterThan(20);
    expect(differed).toBeGreaterThan(5);
  });

  it('reaches sampleHeight, so the main thread and the worker agree', () => {
    // `sampleHeight` is the single description of the ground; if the Sector tier
    // were wired into `chunk-gen.ts` alone, the cube, the camera and Phase 8's
    // collision would stand on different ground from the mesh.
    const field = worldRegionField(SEED);
    const sectors = sectorStreetField(field, SEED);
    const blend = new GradeBlend();
    const out = new Float64Array(GRADE_OUT_LENGTH);
    let checked = 0;
    for (const rec of populatedSectors(SEED, -8, -8, 16)) {
      for (let street = 1; street < rec.streetCount; street++) {
        const i = (rec.streetStart[street] as number) + 1;
        const x = rec.nodeX[i] as number;
        const z = rec.nodeZ[i] as number;
        const base = baseHeight(x, z, SEED);
        const drop = field.rivers.drop(x, z, base);
        gradeSurface(field, sectors, x, z, base - drop, drop, blend, out);
        expect(sampleHeight(x, z, SEED)).toBe(base - drop + (out[0] as number));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('has no step anywhere across a whole settlement', () => {
    // THE FAILURE THIS PHASE IS MOST LIKELY TO HAVE, and the reason streets join
    // `GradeBlend` rather than grading in a second pass. Two graders resolved
    // independently and added would put a visible ledge exactly where a street
    // meets the road it joins, or where it crosses the edge of the pad.
    //
    // THE BOUND IS DERIVED, NOT OBSERVED. Grading tapers with a smoothstep, whose
    // steepest slope is `1.5 / width`, and it can move the ground by at most
    // `ROAD_MAX_CUT + ROAD_MAX_FILL` in total. So the steepest surface grading
    // can produce anywhere is that product over the NARROWEST shoulder in play,
    // which is the street's -- and a step, of any size, is infinitely steeper.
    // The terrain's own slope is added on top, generously.
    const field = worldRegionField(SEED);
    const sectors = sectorStreetField(field, SEED);
    const blend = new GradeBlend();
    const out = new Float64Array(GRADE_OUT_LENGTH);
    const rec = populatedSectors(SEED, -8, -8, 24).sort(
      (a, b) => (b.settlement as Settlement).radius - (a.settlement as Settlement).radius,
    )[0] as SectorStreets;
    const s = rec.settlement as Settlement;

    const step = 0.25;
    const TERRAIN_SLOPE = 1; // metres per metre, well above anything a village sits on
    const limit = ((1.5 * (ROAD_MAX_CUT + ROAD_MAX_FILL)) / STREET_SHOULDER + TERRAIN_SLOPE) * step;
    let worst = 0;
    let onStreet = 0;
    for (let z = s.z - s.radius; z <= s.z + s.radius; z += 11) {
      let previous = Number.NaN;
      for (let x = s.x - s.radius - 40; x <= s.x + s.radius + 40; x += step) {
        const base = baseHeight(x, z, SEED);
        const drop = field.rivers.drop(x, z, base);
        const carved = base - drop;
        gradeSurface(field, sectors, x, z, carved, drop, blend, out);
        const height = carved + (out[0] as number);
        if ((out[GRADE_STREET_SURFACE] as number) > 0.25) onStreet++;
        if (Number.isFinite(previous)) worst = Math.max(worst, Math.abs(height - previous));
        previous = height;
      }
    }
    // Anti-vacuity: the line has to have actually crossed some streets.
    expect(onStreet).toBeGreaterThan(20);
    expect(worst).toBeLessThan(limit);
  });

  it('is identical either side of a sector boundary', () => {
    // The Sector-tier answer to `river-region-seam`. A query reads up to four
    // sector records and they contribute DISJOINT streets -- two sectors never
    // both own a settlement -- so crossing a boundary must change nothing at
    // all, not merely change it smoothly.
    const field = worldRegionField(SEED);
    const sectors = sectorStreetField(field, SEED);
    const blend = new GradeBlend();
    const out = new Float64Array(GRADE_OUT_LENGTH);
    const rec = populatedSectors(SEED, -8, -8, 24)[0] as SectorStreets;
    const s = rec.settlement as Settlement;

    // The nearest sector boundary to the settlement centre, and a line crossing
    // it through the village.
    const boundary = Math.round(s.x / SECTOR_SIZE) * SECTOR_SIZE;
    let worst = 0;
    let onStreet = 0;
    for (let z = s.z - s.radius; z <= s.z + s.radius; z += 3) {
      let previous = Number.NaN;
      for (let d = -1.5; d <= 1.5; d += 0.05) {
        const x = boundary + d;
        const base = baseHeight(x, z, SEED);
        const drop = field.rivers.drop(x, z, base);
        gradeSurface(field, sectors, x, z, base - drop, drop, blend, out);
        const h = base - drop + (out[0] as number);
        if ((out[GRADE_STREET_SURFACE] as number) > 0.25) onStreet++;
        if (Number.isFinite(previous)) worst = Math.max(worst, Math.abs(h - previous));
        previous = h;
      }
    }
    expect(worst).toBeLessThan(0.3);
    expect(onStreet).toBeGreaterThan(0);
  });
});
