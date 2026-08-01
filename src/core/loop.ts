/**
 * Fixed-timestep simulation loop with a decoupled render.
 *
 * The key property for this project is that simulation state is a pure
 * function of an integer tick counter, never of wall-clock time. That is what
 * lets `?time=` reproduce an exact world state from a URL, and what makes
 * screenshots comparable between runs on machines with different frame rates.
 *
 * `advance()` is deliberately public and free of `requestAnimationFrame` so the
 * stepping logic can be unit tested without a browser.
 */

export type FixedUpdateFn = (dt: number, tick: number) => void;
export type RenderFn = (alpha: number, wallDt: number) => void;

export interface LoopOptions {
  /** Simulation step, in seconds. Defaults to 1/60. */
  fixedDt: number;
  /**
   * Maximum simulation steps per `advance()` call. Prevents the "spiral of
   * death" where a slow frame queues more work than the next frame can clear.
   */
  maxSubSteps: number;
  /** Tick to start at, so `?time=` can seek. */
  startTick: number;
  /** Start paused, for `?freeze=1`. */
  paused: boolean;
  /** Largest wall-clock delta accepted, in seconds. Absorbs tab-switch gaps. */
  maxWallDt: number;
}

const DEFAULTS: LoopOptions = {
  fixedDt: 1 / 60,
  maxSubSteps: 5,
  startTick: 0,
  paused: false,
  maxWallDt: 0.25,
};

export class Loop {
  readonly fixedDt: number;

  private readonly maxSubSteps: number;
  private readonly maxWallDt: number;
  private readonly onFixed: FixedUpdateFn;
  private readonly onRender: RenderFn;

  private accumulator = 0;
  private currentTick: number;
  private isPaused: boolean;
  private queuedSteps = 0;
  private rafHandle = 0;
  private lastWallTime = 0;
  private currentAlpha = 0;
  private isRunning = false;

  constructor(onFixed: FixedUpdateFn, onRender: RenderFn, options: Partial<LoopOptions> = {}) {
    const opts = { ...DEFAULTS, ...options };
    this.onFixed = onFixed;
    this.onRender = onRender;
    this.fixedDt = opts.fixedDt;
    this.maxSubSteps = opts.maxSubSteps;
    this.maxWallDt = opts.maxWallDt;
    this.currentTick = opts.startTick;
    this.isPaused = opts.paused;
  }

  /** Integer simulation tick. The single source of truth for sim state. */
  get tick(): number {
    return this.currentTick;
  }

  /** Simulation time in seconds. Always exactly `tick * fixedDt`. */
  get simTime(): number {
    return this.currentTick * this.fixedDt;
  }

  /** Interpolation factor in [0, 1) between the last tick and the next one. */
  get alpha(): number {
    return this.currentAlpha;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get running(): boolean {
    return this.isRunning;
  }

  pause(): void {
    this.isPaused = true;
    // Drop the partial step so a resumed loop restarts cleanly on a tick
    // boundary; otherwise `alpha` would be frozen mid-step in screenshots.
    this.accumulator = 0;
    this.currentAlpha = 0;
  }

  resume(): void {
    this.isPaused = false;
  }

  togglePaused(): void {
    if (this.isPaused) this.resume();
    else this.pause();
  }

  /** Queue `count` fixed steps to run on the next advance, even while paused. */
  step(count = 1): void {
    if (count > 0) this.queuedSteps += Math.floor(count);
  }

  /** Jump the simulation to an absolute tick without running the steps. */
  seekToTick(tick: number): void {
    this.currentTick = Math.floor(tick);
    this.accumulator = 0;
    this.currentAlpha = 0;
  }

  /**
   * Run whatever fixed steps `wallDt` seconds have earned, then report how many
   * ran. Pure with respect to wall clock: the caller owns time measurement.
   */
  advance(wallDt: number): number {
    let steps = 0;

    // Manual steps always run, paused or not -- that is the point of `step()`.
    while (this.queuedSteps > 0) {
      this.queuedSteps--;
      this.currentTick++;
      this.onFixed(this.fixedDt, this.currentTick);
      steps++;
    }

    if (this.isPaused) {
      this.currentAlpha = 0;
      return steps;
    }

    this.accumulator += Math.min(Math.max(wallDt, 0), this.maxWallDt);

    let autoSteps = 0;
    while (this.accumulator >= this.fixedDt && autoSteps < this.maxSubSteps) {
      this.accumulator -= this.fixedDt;
      this.currentTick++;
      this.onFixed(this.fixedDt, this.currentTick);
      autoSteps++;
      steps++;
    }

    // Hit the clamp: we are running behind, so discard the backlog rather than
    // accumulating debt we can never repay.
    if (autoSteps === this.maxSubSteps && this.accumulator >= this.fixedDt) {
      this.accumulator = 0;
    }

    this.currentAlpha = this.accumulator / this.fixedDt;
    return steps;
  }

  /** Start driving `advance` + render from requestAnimationFrame. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastWallTime = performance.now();

    const frame = (now: number): void => {
      if (!this.isRunning) return;
      const wallDt = (now - this.lastWallTime) / 1000;
      this.lastWallTime = now;
      this.advance(wallDt);
      this.onRender(this.currentAlpha, wallDt);
      this.rafHandle = requestAnimationFrame(frame);
    };

    this.rafHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.isRunning = false;
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
  }
}
