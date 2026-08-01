import { describe, expect, it } from 'vitest';
import { Loop, type LoopOptions } from './loop';

const FIXED_DT = 1 / 60;

function makeLoop(options: Partial<LoopOptions> = {}): { loop: Loop; ticks: number[] } {
  const ticks: number[] = [];
  const loop = new Loop(
    (_dt, tick) => ticks.push(tick),
    () => {},
    options,
  );
  return { loop, ticks };
}

describe('Loop', () => {
  it('runs exactly one fixed step per fixedDt of wall time', () => {
    const { loop, ticks } = makeLoop();
    expect(loop.advance(FIXED_DT)).toBe(1);
    expect(loop.advance(FIXED_DT * 3)).toBe(3);
    expect(ticks).toEqual([1, 2, 3, 4]);
    expect(loop.tick).toBe(4);
  });

  it('accumulates sub-step remainders instead of dropping them', () => {
    const { loop } = makeLoop();
    // Three frames of half a step should produce one step, not zero.
    loop.advance(FIXED_DT * 0.5);
    expect(loop.tick).toBe(0);
    loop.advance(FIXED_DT * 0.5);
    expect(loop.tick).toBe(1);
  });

  it('exposes simTime as exactly tick * fixedDt', () => {
    const { loop } = makeLoop({ maxSubSteps: 100, maxWallDt: 10 });
    loop.advance(FIXED_DT * 10);
    expect(loop.tick).toBe(10);
    expect(loop.simTime).toBe(10 * FIXED_DT);
  });

  it('is deterministic: the same wall-time sequence yields the same ticks', () => {
    const deltas = [0.004, 0.021, 0.0003, 0.05, 0.0166, 0.009];
    const run = () => {
      const { loop, ticks } = makeLoop();
      for (const d of deltas) loop.advance(d);
      return { ticks: [...ticks], tick: loop.tick, alpha: loop.alpha };
    };
    expect(run()).toEqual(run());
  });

  it('reaches the same tick regardless of how wall time is chunked', () => {
    const oneBigFrame = makeLoop({ maxWallDt: 10, maxSubSteps: 1000 });
    oneBigFrame.loop.advance(FIXED_DT * 20);

    const manySmallFrames = makeLoop({ maxWallDt: 10, maxSubSteps: 1000 });
    for (let i = 0; i < 20; i++) manySmallFrames.loop.advance(FIXED_DT);

    expect(oneBigFrame.loop.tick).toBe(manySmallFrames.loop.tick);
  });

  it('clamps sub-steps and drops the backlog instead of spiralling', () => {
    const { loop } = makeLoop({ maxSubSteps: 5, maxWallDt: 10 });
    expect(loop.advance(FIXED_DT * 100)).toBe(5);
    expect(loop.tick).toBe(5);
    // Backlog was discarded, so the next normal frame advances by exactly one.
    expect(loop.advance(FIXED_DT)).toBe(1);
    expect(loop.tick).toBe(6);
  });

  it('clamps absurd wall deltas (tab switch) to maxWallDt', () => {
    const { loop } = makeLoop({ maxWallDt: FIXED_DT * 2, maxSubSteps: 100 });
    expect(loop.advance(3600)).toBe(2);
  });

  it('ignores negative wall deltas', () => {
    const { loop } = makeLoop();
    expect(loop.advance(-5)).toBe(0);
    expect(loop.tick).toBe(0);
  });

  describe('pause and step', () => {
    it('does not advance while paused', () => {
      const { loop } = makeLoop({ paused: true });
      loop.advance(FIXED_DT * 10);
      expect(loop.tick).toBe(0);
      expect(loop.alpha).toBe(0);
    });

    it('step() advances exactly one tick while paused', () => {
      const { loop, ticks } = makeLoop({ paused: true });
      loop.step();
      expect(loop.advance(0)).toBe(1);
      expect(loop.tick).toBe(1);
      expect(ticks).toEqual([1]);

      // And no further drift on subsequent frames.
      loop.advance(FIXED_DT * 5);
      expect(loop.tick).toBe(1);
    });

    it('step(n) advances exactly n ticks', () => {
      const { loop } = makeLoop({ paused: true });
      loop.step(4);
      loop.advance(0);
      expect(loop.tick).toBe(4);
    });

    it('resumes from the tick it was paused on, with no partial step carried', () => {
      const { loop } = makeLoop();
      loop.advance(FIXED_DT * 1.5);
      expect(loop.tick).toBe(1);
      loop.pause();
      expect(loop.alpha).toBe(0);
      loop.resume();
      loop.advance(FIXED_DT * 0.6);
      expect(loop.tick).toBe(1);
    });

    it('togglePaused flips state', () => {
      const { loop } = makeLoop();
      expect(loop.paused).toBe(false);
      loop.togglePaused();
      expect(loop.paused).toBe(true);
      loop.togglePaused();
      expect(loop.paused).toBe(false);
    });
  });

  describe('seeking', () => {
    it('startTick makes sim state a pure function of the URL', () => {
      const { loop } = makeLoop({ startTick: 180, paused: true });
      expect(loop.tick).toBe(180);
      expect(loop.simTime).toBeCloseTo(3, 10);
    });

    it('seekToTick jumps without running intermediate steps', () => {
      const { loop, ticks } = makeLoop();
      loop.seekToTick(1000);
      expect(loop.tick).toBe(1000);
      expect(ticks).toEqual([]);
      expect(loop.alpha).toBe(0);
    });
  });

  it('keeps alpha in [0, 1)', () => {
    const { loop } = makeLoop();
    for (const d of [0.001, 0.007, 0.016, 0.033, 0.0005]) {
      loop.advance(d);
      expect(loop.alpha).toBeGreaterThanOrEqual(0);
      expect(loop.alpha).toBeLessThan(1);
    }
  });
});
