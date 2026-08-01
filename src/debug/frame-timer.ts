/**
 * Rolling frame-time statistics for the perf HUD.
 *
 * The budgets in the master plan are stated as "60fps, <=16ms frame time, no GC
 * spikes above 4ms", which means an average alone is useless -- a 40ms hitch
 * once a second vanishes into a mean. So this tracks the worst frame in the
 * window alongside the average, and counts spikes explicitly.
 */

export interface FrameStats {
  fps: number;
  avgMs: number;
  maxMs: number;
  /** Frames in the window that exceeded the spike threshold. */
  spikes: number;
}

export class FrameTimer {
  private readonly windowSeconds: number;
  private readonly spikeThresholdMs: number;

  /** Samples needed for the very first publish, before the window has closed. */
  private static readonly PRIMING_SAMPLES = 4;

  private samples: number[] = [];
  private elapsed = 0;
  private hasPublished = false;
  private published: FrameStats = { fps: 0, avgMs: 0, maxMs: 0, spikes: 0 };

  constructor(windowSeconds = 0.5, spikeThresholdMs = 20) {
    this.windowSeconds = windowSeconds;
    this.spikeThresholdMs = spikeThresholdMs;
  }

  /** Feed one frame's wall-clock delta, in seconds. */
  sample(wallDt: number): void {
    if (!Number.isFinite(wallDt) || wallDt <= 0) return;
    this.samples.push(wallDt * 1000);
    this.elapsed += wallDt;

    // Publish early the first time round. Otherwise the HUD reads "fps 0" for
    // the first half second, which looks like a bug rather than a warm-up.
    const priming = !this.hasPublished && this.samples.length >= FrameTimer.PRIMING_SAMPLES;
    if (priming || this.elapsed >= this.windowSeconds) this.publish();
  }

  /** Latest published statistics. Updated once per window, not per frame. */
  get stats(): FrameStats {
    return this.published;
  }

  private publish(): void {
    const count = this.samples.length;
    if (count === 0) return;

    let total = 0;
    let max = 0;
    let spikes = 0;
    for (const ms of this.samples) {
      total += ms;
      if (ms > max) max = ms;
      if (ms > this.spikeThresholdMs) spikes++;
    }

    this.published = {
      fps: count / this.elapsed,
      avgMs: total / count,
      maxMs: max,
      spikes,
    };

    this.hasPublished = true;
    this.samples = [];
    this.elapsed = 0;
  }
}
