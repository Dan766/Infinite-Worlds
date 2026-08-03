/**
 * Tests for the grading blend.
 *
 * `grading.ts` has no terrain in it and no world: it is arithmetic on weights
 * and target altitudes, which is exactly why it can be asserted rather than
 * described. Every property here is one that a rendered screenshot would only
 * show as a seam, at a village, after ten minutes of streaming.
 */

import { describe, expect, it } from 'vitest';
import {
  closestOnSegment,
  GradeBlend,
  GRADE_LIFT,
  GRADE_OUT_LENGTH,
  GRADE_STREET_SURFACE,
  GRADE_SURFACE,
  ROAD_MAX_CUT,
  ROAD_MAX_FILL,
  ROAD_RIVER_YIELD,
  SURFACE_ROAD,
  SURFACE_STREET,
} from './grading';

const out = (): Float64Array => new Float64Array(GRADE_OUT_LENGTH);

describe('GradeBlend', () => {
  it('is empty until something is added, and empty again after a reset', () => {
    const blend = new GradeBlend();
    blend.reset();
    expect(blend.empty).toBe(true);

    const o = out();
    blend.resolve(0, 0, o);
    expect(Array.from(o)).toEqual([0, 0, 0]);

    blend.add(1, 50, 1, SURFACE_ROAD);
    expect(blend.empty).toBe(false);
    blend.reset();
    expect(blend.empty).toBe(true);
  });

  it('exposes the TARGET before any clamp or yield, for Phase 5 to build on', () => {
    // A deck is PLACED at the target rather than moved toward it, so it needs
    // the average itself and not what the ground made of it. All three filters
    // -- the strength, the cut and fill caps, and the river yield -- are exactly
    // what a bridge has to ignore.
    const blend = new GradeBlend();
    blend.reset();
    // -Infinity, not 0 and not NaN, so `max(ground, target)` means "the ground
    // wins" wherever nothing grades at all, with no special case at the caller.
    expect(blend.target).toBe(-Infinity);

    blend.add(1, 40, 0, SURFACE_ROAD);
    blend.add(1, 60, 0, SURFACE_ROAD);
    expect(blend.target).toBe(50);

    // The ground here is clamped to +12 m of fill and stood down completely by
    // the river; the target is untouched by both. That IS the bridge rule.
    const o = out();
    blend.resolve(0, 0, o);
    expect(o[GRADE_LIFT]).toBe(ROAD_MAX_FILL);
    blend.resolve(0, ROAD_RIVER_YIELD, o);
    expect(o[GRADE_LIFT]).toBe(0);
    expect(blend.target).toBe(50);
  });

  it('moves the ground all the way to the target at full weight', () => {
    const blend = new GradeBlend();
    blend.reset();
    blend.add(1, 50, 1, SURFACE_ROAD);
    const o = out();
    blend.resolve(42, 0, o);
    expect(o[GRADE_LIFT]).toBe(8);
  });

  it('averages the TARGETS but takes the strength from the strongest', () => {
    // The whole rule in one assertion, and the reason it is this rule. Two
    // influences of weight 0.5 pulling to 40 m and 60 m must produce the same
    // answer as one influence of weight 0.5 pulling to 50 m -- not twice the
    // movement (which a summed weight would give), and not a jump between 40 and
    // 60 (which picking the strongest target would give the moment one of them
    // edged ahead).
    const both = new GradeBlend();
    both.reset();
    both.add(0.5, 40, 0, SURFACE_ROAD);
    both.add(0.5, 60, 0, SURFACE_ROAD);
    const a = out();
    both.resolve(45, 0, a);

    const one = new GradeBlend();
    one.reset();
    one.add(0.5, 50, 0, SURFACE_ROAD);
    const b = out();
    one.resolve(45, 0, b);

    expect(a[GRADE_LIFT]).toBe(b[GRADE_LIFT]);
    // Ground at 45 m, target 50 m, half weight: half of the 5 m difference,
    // which is well inside `ROAD_MAX_FILL` so no clamp is in play.
    expect(a[GRADE_LIFT]).toBe(2.5);
  });

  it('does not grade harder because two influences overlap', () => {
    // Two roads side by side, or a street lying along one. A summed strength
    // would punch a hole at every crossroads.
    const blend = new GradeBlend();
    blend.reset();
    blend.add(1, 50, 1, SURFACE_ROAD);
    blend.add(1, 50, 1, SURFACE_STREET);
    const o = out();
    blend.resolve(0, 0, o);
    expect(o[GRADE_LIFT]).toBe(ROAD_MAX_FILL);

    const alone = new GradeBlend();
    alone.reset();
    alone.add(1, 50, 1, SURFACE_ROAD);
    const p = out();
    alone.resolve(0, 0, p);
    expect(o[GRADE_LIFT]).toBe(p[GRADE_LIFT]);
  });

  it('ignores a zero or negative weight entirely', () => {
    // An influence must reach exactly zero at the edge of its shoulder. A
    // contribution that still counted at weight 0 would put a step there.
    const blend = new GradeBlend();
    blend.reset();
    blend.add(0, 1000, 1, SURFACE_ROAD);
    blend.add(-1, 1000, 1, SURFACE_ROAD);
    expect(blend.empty).toBe(true);
    const o = out();
    blend.resolve(0, 0, o);
    expect(Array.from(o)).toEqual([0, 0, 0]);
  });

  it('clamps a cut and a fill separately', () => {
    const cut = new GradeBlend();
    cut.reset();
    cut.add(1, -1000, 0, SURFACE_ROAD);
    const a = out();
    cut.resolve(0, 0, a);
    expect(a[GRADE_LIFT]).toBe(-ROAD_MAX_CUT);

    const fill = new GradeBlend();
    fill.reset();
    fill.add(1, 1000, 0, SURFACE_ROAD);
    const b = out();
    fill.resolve(0, 0, b);
    expect(b[GRADE_LIFT]).toBe(ROAD_MAX_FILL);
  });

  it('yields completely inside a river channel', () => {
    // The composition rule, and the reason there is no dam anywhere in the
    // world: a fill across a carved channel would raise the bed above the
    // Phase 3a water surface, which is built from this very height grid.
    const blend = new GradeBlend();
    blend.reset();
    blend.add(1, 1000, 1, SURFACE_ROAD);
    blend.add(1, 1000, 1, SURFACE_STREET);
    const o = out();
    blend.resolve(0, ROAD_RIVER_YIELD, o);
    expect(Array.from(o)).toEqual([0, 0, 0]);
  });

  it('yields PARTIALLY in a shallow one, and monotonically', () => {
    let previous = Infinity;
    for (let drop = 0; drop <= ROAD_RIVER_YIELD; drop += ROAD_RIVER_YIELD / 12) {
      const blend = new GradeBlend();
      blend.reset();
      blend.add(1, 1000, 1, SURFACE_ROAD);
      const o = out();
      blend.resolve(0, drop, o);
      expect(o[GRADE_LIFT] as number).toBeLessThanOrEqual(previous);
      previous = o[GRADE_LIFT] as number;
    }
    expect(previous).toBe(0);
  });

  it('keeps surfacing per source, and combines them by maximum', () => {
    // The anti-vacuity property `ChunkData.streetVertices` rests on. A
    // settlement pad surfaces its whole disc, so a combined number is non-zero
    // across a village with no street in it at all.
    const blend = new GradeBlend();
    blend.reset();
    blend.add(1, 0, 0.55, SURFACE_ROAD);
    blend.add(1, 0, 0.9, SURFACE_STREET);
    const o = out();
    blend.resolve(0, 0, o);
    expect(o[GRADE_SURFACE]).toBe(0.9);
    expect(o[GRADE_STREET_SURFACE]).toBe(0.9);

    const roadOnly = new GradeBlend();
    roadOnly.reset();
    roadOnly.add(1, 0, 0.55, SURFACE_ROAD);
    const p = out();
    roadOnly.resolve(0, 0, p);
    expect(p[GRADE_SURFACE]).toBe(0.55);
    expect(p[GRADE_STREET_SURFACE]).toBe(0);
  });

  it('takes the maximum surfacing within a source, not the sum', () => {
    const blend = new GradeBlend();
    blend.reset();
    blend.add(1, 0, 0.4, SURFACE_ROAD);
    blend.add(1, 0, 0.7, SURFACE_ROAD);
    blend.add(1, 0, 0.3, SURFACE_ROAD);
    const o = out();
    blend.resolve(0, 0, o);
    expect(o[GRADE_SURFACE]).toBe(0.7);
  });

  it('is a pure function of what was added since the last reset', () => {
    // RULE 1 for a mutable accumulator: it is reused across ~1,200 vertices per
    // chunk, so anything surviving a reset would make a vertex depend on the
    // vertex before it.
    const blend = new GradeBlend();
    const first = out();
    blend.reset();
    blend.add(0.3, 12, 0.5, SURFACE_STREET);
    blend.add(0.9, -4, 0.2, SURFACE_ROAD);
    blend.resolve(7, 0.4, first);

    blend.reset();
    blend.add(1, 900, 1, SURFACE_ROAD);
    blend.resolve(0, 0, out());

    const second = out();
    blend.reset();
    blend.add(0.3, 12, 0.5, SURFACE_STREET);
    blend.add(0.9, -4, 0.2, SURFACE_ROAD);
    blend.resolve(7, 0.4, second);

    expect(Array.from(second)).toEqual(Array.from(first));
  });
});

describe('closestOnSegment', () => {
  const probe = (
    px: number,
    pz: number,
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): { distance: number; t: number } => {
    const o = new Float64Array(2);
    closestOnSegment(px, pz, ax, az, bx, bz, o);
    return { distance: Math.sqrt(o[0] as number), t: o[1] as number };
  };

  it('finds the perpendicular foot inside the segment', () => {
    const r = probe(5, 3, 0, 0, 10, 0);
    expect(r.distance).toBe(3);
    expect(r.t).toBe(0.5);
  });

  it('clamps to the ends rather than extending the line', () => {
    expect(probe(-4, 0, 0, 0, 10, 0)).toEqual({ distance: 4, t: 0 });
    expect(probe(14, 0, 0, 0, 10, 0)).toEqual({ distance: 4, t: 1 });
  });

  it('handles a degenerate segment without dividing by zero', () => {
    const r = probe(3, 4, 1, 1, 1, 1);
    expect(r.t).toBe(0);
    expect(r.distance).toBeCloseTo(Math.sqrt(4 + 9), 12);
  });
});
