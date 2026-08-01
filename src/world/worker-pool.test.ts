/**
 * Worker pool behaviour, driven by a fake worker.
 *
 * The point of injecting `spawn` is right here: priority ordering and
 * cancellation are the two things most likely to be subtly wrong, and both are
 * far cheaper to pin down with a synchronous fake than with a real browser.
 */

import { describe, expect, it } from 'vitest';
import { generateChunk } from './chunk-gen';
import { createTierContext, type ChunkCoord } from './contracts';
import { WorkerPool } from './worker-pool';
import type { WorkerLike, WorkerRequest, WorkerResponse } from './worker-protocol';

class FakeWorker implements WorkerLike {
  readonly received: WorkerRequest[] = [];
  terminated = false;
  private onMessage: (message: WorkerResponse) => void = () => {};
  private onError: (error: unknown) => void = () => {};

  postMessage(message: WorkerRequest): void {
    this.received.push(message);
  }

  setHandlers(
    onMessage: (message: WorkerResponse) => void,
    onError: (error: unknown) => void,
  ): void {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Complete the oldest un-answered job, as a real worker would. */
  finishOldest(): void {
    const request = this.received[this.answered++];
    if (request === undefined) throw new Error('nothing to finish');
    const data = generateChunk(request.coord, createTierContext(request.worldSeed, 'chunk'));
    this.onMessage({ kind: 'chunk', id: request.id, data, elapsedMs: 0.5 });
  }

  failOldest(message: string): void {
    const request = this.received[this.answered++];
    if (request === undefined) throw new Error('nothing to fail');
    this.onMessage({ kind: 'error', id: request.id, message });
  }

  raiseError(error: unknown): void {
    this.onError(error);
  }

  private answered = 0;
}

/** One worker, so dispatch order is directly observable. */
function makePool(workerCount = 1): { pool: WorkerPool; workers: FakeWorker[]; errors: string[] } {
  const workers: FakeWorker[] = [];
  const errors: string[] = [];
  const pool = new WorkerPool({
    worldSeed: 1234,
    workerCount,
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onError: (message) => errors.push(message),
  });
  return { pool, workers, errors };
}

const at = (x: number, z: number): ChunkCoord => ({ x, z });
const dispatchedCoords = (worker: FakeWorker): string[] =>
  worker.received.map((r) => `${r.coord.x},${r.coord.z}`);

describe('WorkerPool', () => {
  it('dispatches immediately while a worker is idle', async () => {
    const { pool, workers } = makePool(1);
    const promise = pool.request(at(0, 0), 10);
    const worker = workers[0] as FakeWorker;
    expect(worker.received).toHaveLength(1);
    expect(pool.stats.inFlight).toBe(1);

    worker.finishOldest();
    const data = await promise;
    expect(data?.coord).toEqual({ x: 0, z: 0 });
    expect(pool.stats.completed).toBe(1);
    expect(pool.stats.inFlight).toBe(0);
    pool.dispose();
  });

  it('runs queued requests nearest-first, not first-come-first-served', async () => {
    const { pool, workers } = makePool(1);
    const worker = workers[0] as FakeWorker;

    pool.request(at(0, 0), 0); // takes the only worker immediately
    void pool.request(at(1, 0), 500);
    void pool.request(at(2, 0), 100);
    void pool.request(at(3, 0), 300);
    expect(pool.stats.queued).toBe(3);

    worker.finishOldest();
    await Promise.resolve();
    worker.finishOldest();
    await Promise.resolve();
    worker.finishOldest();
    await Promise.resolve();

    expect(dispatchedCoords(worker)).toEqual(['0,0', '2,0', '3,0', '1,0']);
    pool.dispose();
  });

  it('honours a priority change made while a request is still queued', async () => {
    const { pool, workers } = makePool(1);
    const worker = workers[0] as FakeWorker;

    pool.request(at(0, 0), 0);
    void pool.request(at(1, 0), 500);
    void pool.request(at(2, 0), 100);
    // The camera turned around: the far chunk is now the near one.
    pool.reprioritize(at(1, 0), 1);

    worker.finishOldest();
    await Promise.resolve();
    expect(dispatchedCoords(worker)[1]).toBe('1,0');
    pool.dispose();
  });

  it('never starts a second job for a coordinate already outstanding', async () => {
    const { pool, workers } = makePool(1);
    const worker = workers[0] as FakeWorker;

    const first = pool.request(at(4, 4), 50);
    const second = pool.request(at(4, 4), 5);
    expect(first).toBe(second);
    expect(worker.received).toHaveLength(1);

    worker.finishOldest();
    expect(await first).not.toBeNull();
    expect(pool.stats.completed).toBe(1);
    pool.dispose();
  });

  it('drops a queued request that was cancelled before a worker reached it', async () => {
    const { pool, workers } = makePool(1);
    const worker = workers[0] as FakeWorker;

    pool.request(at(0, 0), 0);
    const doomed = pool.request(at(9, 9), 900);
    const wanted = pool.request(at(1, 1), 950);

    pool.cancel(at(9, 9));
    expect(await doomed).toBeNull();
    expect(pool.stats.cancelled).toBe(1);
    expect(pool.stats.queued).toBe(1);

    worker.finishOldest();
    await Promise.resolve();
    worker.finishOldest();
    expect(await wanted).not.toBeNull();

    // The cancelled coordinate was never handed to a worker at all.
    expect(dispatchedCoords(worker)).toEqual(['0,0', '1,1']);
    pool.dispose();
  });

  it('discards the result of a request cancelled after dispatch', async () => {
    const { pool, workers } = makePool(1);
    const worker = workers[0] as FakeWorker;

    const promise = pool.request(at(2, 2), 0);
    pool.cancel(at(2, 2));
    worker.finishOldest();

    expect(await promise).toBeNull();
    expect(pool.stats.cancelled).toBe(1);
    expect(pool.stats.completed).toBe(0);
    // The worker is handed back either way, so the pool does not deadlock.
    expect(pool.stats.inFlight).toBe(0);
    pool.dispose();
  });

  it('revives an in-flight request that is re-requested before it lands', async () => {
    const { pool, workers } = makePool(1);
    const worker = workers[0] as FakeWorker;

    const promise = pool.request(at(3, 3), 0);
    pool.cancel(at(3, 3));
    expect(pool.request(at(3, 3), 0)).toBe(promise);
    worker.finishOldest();

    expect(await promise).not.toBeNull();
    expect(pool.stats.completed).toBe(1);
    expect(pool.stats.cancelled).toBe(0);
    pool.dispose();
  });

  it('cancels everything outside a keep set in one pass', async () => {
    const { pool } = makePool(1);
    pool.request(at(0, 0), 0);
    const keep = pool.request(at(1, 0), 10);
    const dropA = pool.request(at(2, 0), 20);
    const dropB = pool.request(at(3, 0), 30);

    expect(pool.cancelExcept(new Set(['0,0', '1,0']))).toBe(2);
    expect(await dropA).toBeNull();
    expect(await dropB).toBeNull();
    expect(pool.stats.queued).toBe(1);
    expect(pool.outstandingKeys().sort()).toEqual(['0,0', '1,0']);
    void keep;
    pool.dispose();
  });

  it('spreads work across every worker in the pool', () => {
    const { pool, workers } = makePool(3);
    for (let i = 0; i < 3; i++) pool.request(at(i, 0), i);
    expect(workers.every((w) => w.received.length === 1)).toBe(true);
    expect(pool.stats.inFlight).toBe(3);
    pool.dispose();
  });

  it('settles every outstanding promise on dispose, and terminates its workers', async () => {
    const { pool, workers } = makePool(2);
    const a = pool.request(at(0, 0), 0);
    const b = pool.request(at(1, 0), 1);
    const c = pool.request(at(2, 0), 2); // queued behind the two workers

    pool.dispose();
    expect(await Promise.all([a, b, c])).toEqual([null, null, null]);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(pool.stats.queued).toBe(0);
    // Requests after disposal settle rather than hanging.
    expect(await pool.request(at(5, 5), 0)).toBeNull();
  });

  it('reports a worker-side failure without wedging the pool', async () => {
    const { pool, workers, errors } = makePool(1);
    const worker = workers[0] as FakeWorker;

    const failed = pool.request(at(0, 0), 0);
    const next = pool.request(at(1, 0), 1);
    worker.failOldest('boom');

    expect(await failed).toBeNull();
    expect(errors).toEqual(['boom']);
    expect(pool.failures).toBe(1);

    await Promise.resolve();
    worker.finishOldest();
    expect(await next).not.toBeNull();
    pool.dispose();
  });

  it('recovers the worker after an onerror event', () => {
    const { pool, workers, errors } = makePool(1);
    const worker = workers[0] as FakeWorker;
    pool.request(at(0, 0), 0);
    worker.raiseError(new Error('worker died'));
    expect(errors).toEqual(['worker died']);
    // Freed worker picks up the next request rather than the pool stalling.
    pool.request(at(1, 0), 1);
    expect(worker.received).toHaveLength(2);
    pool.dispose();
  });
});
