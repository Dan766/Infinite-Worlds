/**
 * Deterministic camera flight path, driven by `?fly=` and `?flyleg=`.
 *
 * This exists because the Phase 1 acceptance criterion is "fly in a straight
 * line for five minutes and watch the heap", which is otherwise a human staring
 * at a screen. `npm run soak` opens a URL with `?fly=` set and the flight runs
 * itself, identically every time.
 *
 * The path is a triangle wave along +X: out for `legSeconds`, back for
 * `legSeconds`, repeat. Two properties matter:
 *
 *  - The offset is a closed-form function of elapsed time rather than an
 *    accumulated per-frame delta, so the camera arrives back at *exactly* the
 *    starting X at every multiple of `2 * legSeconds`, whatever the frame rate
 *    was. That is what makes "returning to origin shows the same colours"
 *    checkable rather than approximate.
 *  - It drives X only, so WASD still works on the other axes while it runs.
 *
 * Time here is wall clock, like the camera itself: the camera is deliberately
 * not part of simulation state (see ARCHITECTURE.md), so freezing the sim does
 * not stop the flight.
 */

export class Autopilot {
  private readonly speed: number;
  private readonly legSeconds: number;
  private baseX = 0;
  private elapsedSeconds = 0;
  private started = false;

  /**
   * @param speed metres per second along X. Zero disables the autopilot.
   * @param legSeconds seconds spent travelling before reversing.
   */
  constructor(speed: number, legSeconds: number) {
    this.speed = speed;
    this.legSeconds = legSeconds;
  }

  get active(): boolean {
    return this.speed !== 0 && this.legSeconds > 0;
  }

  get elapsed(): number {
    return this.elapsedSeconds;
  }

  /** Signed distance from the starting X at the current time. */
  get offset(): number {
    return offsetAt(this.elapsedSeconds, this.speed, this.legSeconds);
  }

  /**
   * Advance by `dt` wall seconds and return the absolute X the camera should be
   * at. `currentX` seeds the path on the first call, so `?pos=` still decides
   * where the flight starts.
   */
  advance(dt: number, currentX: number): number {
    if (!this.active) return currentX;
    if (!this.started) {
      this.baseX = currentX;
      this.started = true;
    }
    if (Number.isFinite(dt) && dt > 0) this.elapsedSeconds += dt;
    return this.baseX + this.offset;
  }
}

/** Triangle wave. Exported for unit testing. */
export function offsetAt(elapsed: number, speed: number, legSeconds: number): number {
  if (speed === 0 || legSeconds <= 0) return 0;
  const period = legSeconds * 2;
  const phase = elapsed - Math.floor(elapsed / period) * period;
  const travelled = phase <= legSeconds ? phase : period - phase;
  return travelled * speed;
}
