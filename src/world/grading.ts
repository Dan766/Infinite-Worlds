/**
 * How everything that moves the ground combines into one answer.
 *
 * Phase 4b. Phase 4a had exactly one grader -- `roads.ts` -- so the blend rule
 * lived inside it as a local accumulator. Phase 4b adds a SECOND grader at a
 * DIFFERENT tier (streets, `streets.ts`, Sector), and two copies of a rule whose
 * whole job is to make two influences meet without a step is precisely the
 * duplication that drifts. `cell-heap.ts` was lifted out of `rivers.ts` for the
 * same reason when roads needed it; this is that move again.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS THIS ONE
 *
 * Every influence contributes a WEIGHT (1 across its flat bed, tapering to
 * exactly 0 at the edge of its shoulder) and a TARGET ALTITUDE. The ground is
 * then moved toward the WEIGHTED AVERAGE of the targets, at the strength of the
 * STRONGEST single influence:
 *
 *   target = sum(weight * target) / sum(weight)
 *   lift   = strongest * yield * clamp(target - carved, -MAX_CUT, +MAX_FILL)
 *
 * Picking the strongest influence's target outright is the obvious alternative
 * and is wrong: where two influences are equally strong the choice would flip
 * between two different altitudes, which is a step in the ground exactly where a
 * street meets the road it joins, or where a road meets the village it serves.
 * Averaging the targets while taking the strength from the strongest is what
 * makes a junction continuous without weakening either influence on its own.
 *
 * Using the SUM of weights as the strength is the other obvious alternative and
 * is also wrong: two roads running side by side would grade harder than either
 * one alone, and a crossroads would punch a hole.
 *
 * ---------------------------------------------------------------------------
 * SURFACING IS A MAXIMUM, NOT A SUM OR AN AVERAGE
 *
 * Coverage is "how much of the ground here is a made surface", so two overlapping
 * surfaces are still one surface. It is tracked PER SOURCE, because the whole
 * point of `ChunkData.streetVertices` is to be able to tell "the flight never
 * passed a village" from "street grading silently returns zero", and a single
 * combined number cannot: a village pad already surfaces the ground at
 * `SETTLEMENT_SURFACE` before any street is laid.
 *
 * ---------------------------------------------------------------------------
 * RIVERS WIN, AND THEY WIN HERE
 *
 * The yield factor is applied once, in `resolve`, rather than by each grader.
 * That is what guarantees a street and the road it joins stand down by the same
 * amount inside a channel; if each applied its own, the two would only agree
 * while their weights did.
 */

import { clamp, smoothstep } from './noise';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * Hard caps on how far grading may move the ground, in metres.
 *
 * Cut and fill are separate numbers because they fail differently: a deep cut
 * turns a hillside road into a trench, while a deep fill turns a valley crossing
 * into a dam. They bound `MIN_HEIGHT` and `MAX_HEIGHT` in `height-field.ts` the
 * way `RIVER_MAX_CUT` already does.
 *
 * They keep their `ROAD_` names now that they live here rather than in
 * `roads.ts`, because a street IS a road: the caps, the yield rule and the
 * `MIN_HEIGHT` derivation are all about the same physical quantity, and renaming
 * them would break the correspondence between this code and every paragraph in
 * `ARCHITECTURE.md` and `PROGRESS.md` that reasons about it.
 */
export const ROAD_MAX_CUT = 18;
export const ROAD_MAX_FILL = 12;

/**
 * Metres of river carve at which grading is fully suppressed.
 *
 * THE COMPOSITION RULE, AND THE BRIDGE DEFERRAL. Rivers are applied first and
 * everything else yields to them: the blend's strength is multiplied by
 * `1 - smoothstep(0, ROAD_RIVER_YIELD, riverDrop)`, so inside a carved channel a
 * road moves no ground at all.
 *
 * Without this a fill across a channel raises the bed above the Phase 3a water
 * surface -- which is built from this very height grid -- and the river visibly
 * runs over the top of the dam. Yielding instead leaves the roadbed running to
 * the bank and resuming on the far side, which reads as a ford. The crossing is
 * recorded on the network (`RoadNetwork.segCrossing`) so Phase 5 can put a
 * bridge on it.
 */
export const ROAD_RIVER_YIELD = 1.5;

// ---------------------------------------------------------------------------
// The output pair, and who surfaced the ground
// ---------------------------------------------------------------------------

/** Indices into the `out` array `GradeBlend.resolve` writes. */
export const GRADE_LIFT = 0;
export const GRADE_SURFACE = 1;
export const GRADE_STREET_SURFACE = 2;
/** Length an `out` array must have. */
export const GRADE_OUT_LENGTH = 3;

/**
 * Which grader put a surface down. Kept apart so an anti-vacuity counter can
 * ask about one of them; combined by `max` for the palette, which only cares
 * that the ground is surfaced at all.
 */
export const SURFACE_ROAD = 0;
export const SURFACE_STREET = 1;
export const SURFACE_SOURCES = 2;

// ---------------------------------------------------------------------------
// The accumulator
// ---------------------------------------------------------------------------

/**
 * One point's worth of grading, accumulated across tiers and then resolved.
 *
 * MUTABLE AND CALLER-OWNED, deliberately. This runs once per chunk vertex --
 * about 1,200 times per chunk, on the hottest path in the codebase -- so an
 * object per call is millions of short-lived allocations per soak run, which is
 * GC pressure in exactly the frame budget this project is trying to hold. The
 * caller holds one instance for a whole chunk and calls `reset` per vertex, the
 * same discipline `roads.ts` already uses for its segment scratch.
 *
 * It is not world state under RULE 2: nothing survives a `reset`, and the answer
 * depends only on what was added since.
 */
export class GradeBlend {
  private weightSum = 0;
  private targetSum = 0;
  private strongest = 0;
  private readonly surface = new Float64Array(SURFACE_SOURCES);

  /** Start a new point. Must be called before the first `add`. */
  reset(): void {
    this.weightSum = 0;
    this.targetSum = 0;
    this.strongest = 0;
    this.surface[SURFACE_ROAD] = 0;
    this.surface[SURFACE_STREET] = 0;
  }

  /**
   * Contribute one influence.
   *
   * `weight` is 1 across a flat bed and tapers to exactly 0 at the edge of its
   * shoulder -- the "exactly" matters, because an influence that ended at some
   * small non-zero weight would put a step at its own boundary. `target` is the
   * altitude that influence wants the ground to hold. `surface` is how much of a
   * made surface it lays down there, in [0, 1].
   */
  add(weight: number, target: number, surface: number, source: number): void {
    if (weight <= 0) return;
    this.weightSum += weight;
    this.targetSum += weight * target;
    if (weight > this.strongest) this.strongest = weight;
    if (surface > (this.surface[source] as number)) this.surface[source] = surface;
  }

  /** True when nothing has been added since the last `reset`. */
  get empty(): boolean {
    return this.weightSum <= 0;
  }

  /**
   * Write `[lift, surface, streetSurface]` into `out`.
   *
   * `carved` is the ground AFTER rivers and `riverDrop` is how much the river
   * took -- both come from the caller, so this module never has to know about
   * `rivers.ts` or evaluate the terrain twice.
   */
  resolve(carved: number, riverDrop: number, out: Float64Array): void {
    out[GRADE_LIFT] = 0;
    out[GRADE_SURFACE] = 0;
    out[GRADE_STREET_SURFACE] = 0;

    // Rivers win. Inside a channel nothing moves ground and nothing paints.
    const yielded = 1 - smoothstep(0, ROAD_RIVER_YIELD, riverDrop);
    if (yielded <= 0 || this.weightSum <= 0) return;

    const target = this.targetSum / this.weightSum;
    const move = clamp(target - carved, -ROAD_MAX_CUT, ROAD_MAX_FILL);
    const road = this.surface[SURFACE_ROAD] as number;
    const street = this.surface[SURFACE_STREET] as number;
    out[GRADE_LIFT] = this.strongest * yielded * move;
    out[GRADE_SURFACE] = (road > street ? road : street) * yielded;
    out[GRADE_STREET_SURFACE] = street * yielded;
  }
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

/**
 * Squared distance from a point to a segment, and where along it that lands.
 *
 * Returned through a caller-owned array rather than an object, because this runs
 * for every segment near every one of ~1,200 chunk vertices, and an object
 * literal per call is millions of short-lived allocations per soak run.
 *
 * Shared by `roads.ts` and `streets.ts` for the reason `CellHeap` is shared: the
 * value it returns decides a vertex's altitude, so two implementations that
 * agreed today could disagree in the last bits tomorrow, and the symptom would
 * be a seam where a street meets a road.
 */
export function closestOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  out: Float64Array,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  let t = 0;
  if (lengthSq > 0) {
    t = clamp(((px - ax) * dx + (pz - az) * dz) / lengthSq, 0, 1);
  }
  const cx = ax + dx * t - px;
  const cz = az + dz * t - pz;
  out[0] = cx * cx + cz * cz;
  out[1] = t;
}
