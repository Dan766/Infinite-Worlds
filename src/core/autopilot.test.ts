import { describe, expect, it } from 'vitest';
import { Autopilot, offsetAt } from './autopilot';

describe('offsetAt', () => {
  it('is zero when disabled', () => {
    expect(offsetAt(10, 0, 60)).toBe(0);
    expect(offsetAt(10, 40, 0)).toBe(0);
  });

  it('travels out at constant speed for one leg', () => {
    expect(offsetAt(0, 40, 100)).toBe(0);
    expect(offsetAt(50, 40, 100)).toBe(2000);
    expect(offsetAt(100, 40, 100)).toBe(4000);
  });

  it('comes back on the second leg and lands exactly on zero', () => {
    expect(offsetAt(150, 40, 100)).toBe(2000);
    expect(offsetAt(200, 40, 100)).toBe(0);
    expect(offsetAt(400, 40, 100)).toBe(0);
    expect(offsetAt(2000, 40, 100)).toBe(0);
  });

  it('is periodic, so a long run repeats rather than drifting', () => {
    for (const t of [7, 33.5, 91, 133]) {
      expect(offsetAt(t + 200, 40, 100)).toBeCloseTo(offsetAt(t, 40, 100), 9);
    }
  });
});

describe('Autopilot', () => {
  it('is inactive at speed zero and leaves the camera alone', () => {
    const autopilot = new Autopilot(0, 60);
    expect(autopilot.active).toBe(false);
    expect(autopilot.advance(1, 12.5)).toBe(12.5);
  });

  it('anchors to wherever the camera started, so ?pos= still decides the origin', () => {
    const autopilot = new Autopilot(10, 100);
    expect(autopilot.advance(0, 500)).toBe(500);
    expect(autopilot.advance(1, 0)).toBe(510);
    expect(autopilot.advance(1, 0)).toBe(520);
  });

  it('returns to the exact starting X regardless of frame pacing', () => {
    const smooth = new Autopilot(40, 10);
    const jittery = new Autopilot(40, 10);
    smooth.advance(0, 0);
    jittery.advance(0, 0);

    for (let i = 0; i < 200; i++) smooth.advance(0.1, 0);
    // Same total time, wildly uneven steps.
    const steps = [3, 0.001, 7, 0.4, 2.5, 1.099, 5, 1];
    let remaining = 20;
    let index = 0;
    while (remaining > 1e-9) {
      const dt = Math.min(steps[index % steps.length] as number, remaining);
      jittery.advance(dt, 0);
      remaining -= dt;
      index++;
    }

    expect(smooth.offset).toBeCloseTo(0, 6);
    expect(jittery.offset).toBeCloseTo(0, 6);
  });

  it('ignores non-finite and negative deltas', () => {
    const autopilot = new Autopilot(10, 100);
    autopilot.advance(0, 0);
    autopilot.advance(Number.NaN, 0);
    autopilot.advance(-5, 0);
    expect(autopilot.elapsed).toBe(0);
  });
});
