/**
 * Worker pool implementing `ChunkProvider`.
 *
 * Responsibilities, and why each exists:
 *
 *  - **Pool sizing** at `hardwareConcurrency - 1`, so generation never starves
 *    the main thread of the core it renders on.
 *  - **Priority queue** ordered by distance to the camera, so the chunk about
 *    to be looked at is generated before the one behind you.
 *  - **Cancellation**, because a camera moving at speed will queue chunks that
 *    are out of range before a worker ever reaches them. Without it the queue
 *    grows without bound and every chunk arrives too late to matter.
 *  - **Transferable payloads**: results arrive as transferred `ArrayBuffer`s,
 *    not clones.
 *
 * The pool is deliberately free of Three.js and of the DOM. `spawn` is
 * injectable so tests drive the whole thing with a synchronous fake worker.
 */

import {
  chunkKey,
  type ChunkCoord,
  type ChunkData,
  type ChunkProvider,
  type ChunkProviderStats,
} from './contracts';
import { PriorityQueue } from './priority-queue';
import type { WorkerLike, WorkerResponse } from './worker-protocol';

type JobState = 'queued' | 'inFlight' | 'cancelled';

interface Job {
  readonly id: number;
  readonly coord: ChunkCoord;
  readonly key: string;
  priority: number;
  state: JobState;
  readonly promise: Promise<ChunkData | null>;
  settle: (data: ChunkData | null) => void;
}

export interface WorkerPoolOptions {
  /**
   * uint32 world seed. A pool belongs to exactly one world, which is why
   * `ChunkProvider.request` takes no seed: a chunk's identity is its coordinate
   * within a fixed world.
   */
  worldSeed: number;
  /** How many workers to spawn. Clamped to at least 1. */
  workerCount: number;
  /** Creates one worker. Injected so tests need no browser. */
  spawn: () => WorkerLike;
  /** Called for worker-side generation failures. Defaults to `console.error`. */
  onError: (message: string) => void;
}

/**
 * Default pool size: leave one core for the main thread. `hardwareConcurrency`
 * is undefined on some browsers, hence the fallback.
 */
export function defaultWorkerCount(): number {
  const cores = typeof navigator === 'undefined' ? 0 : (navigator.hardwareConcurrency ?? 0);
  return Math.max(1, (cores || 4) - 1);
}

/** Spawn the real chunk worker.
 *
 * `new URL('./chunk-worker.ts', import.meta.url)` is the form Vite rewrites to
 * a hashed asset URL resolved relative to the importing module. That relative
 * resolution is what keeps workers working under a nested static deploy path --
 * see `npm run verify:subpath`. Do not replace it with a string path.
 */
export function spawnChunkWorker(): WorkerLike {
  const worker = new Worker(new URL('./chunk-worker.ts', import.meta.url), {
    type: 'module',
    name: 'chunk-worker',
  });
  return {
    postMessage: (message) => worker.postMessage(message),
    setHandlers: (onMessage, onError) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => onMessage(event.data);
      worker.onerror = (event) => onError(event);
    },
    terminate: () => worker.terminate(),
  };
}

export class WorkerPool implements ChunkProvider {
  private readonly workers: WorkerLike[] = [];
  private readonly idle: number[] = [];
  /** The job each worker is currently running, so a crash can be attributed. */
  private readonly assigned: (Job | undefined)[] = [];
  private readonly queue = new PriorityQueue<Job>();
  private readonly jobsByKey = new Map<string, Job>();
  private readonly jobsById = new Map<number, Job>();
  private readonly onError: (message: string) => void;
  private readonly worldSeed: number;

  private nextId = 1;
  private completedCount = 0;
  private cancelledCount = 0;
  private failedCount = 0;
  private totalGenerateMs = 0;
  private disposed = false;

  constructor(options: Partial<WorkerPoolOptions> = {}) {
    this.worldSeed = (options.worldSeed ?? 0) >>> 0;
    const workerCount = Math.max(1, Math.floor(options.workerCount ?? defaultWorkerCount()));
    const spawn = options.spawn ?? spawnChunkWorker;
    this.onError = options.onError ?? ((message) => console.error(`[chunk worker] ${message}`));

    for (let index = 0; index < workerCount; index++) {
      const worker = spawn();
      worker.setHandlers(
        (message) => this.onWorkerMessage(index, message),
        (error) => this.onWorkerCrash(index, error),
      );
      this.workers.push(worker);
      this.assigned.push(undefined);
      this.idle.push(index);
    }
  }

  get stats(): ChunkProviderStats {
    return {
      queued: this.queue.size,
      inFlight: this.workers.length - this.idle.length,
      completed: this.completedCount,
      cancelled: this.cancelledCount,
      workers: this.workers.length,
    };
  }

  /** Worker-reported generation failures. Should stay at zero. */
  get failures(): number {
    return this.failedCount;
  }

  /** Mean worker-side generation time in ms, over the whole run. */
  get averageGenerateMs(): number {
    return this.completedCount === 0 ? 0 : this.totalGenerateMs / this.completedCount;
  }

  request(coord: ChunkCoord, priority: number): Promise<ChunkData | null> {
    if (this.disposed) return Promise.resolve(null);

    const key = chunkKey(coord);
    const existing = this.jobsByKey.get(key);
    if (existing !== undefined) {
      // Never start a second job for a coordinate. Re-requesting an outstanding
      // one just re-ranks it; a cancelled-but-still-running one is revived.
      if (existing.state === 'cancelled') existing.state = 'inFlight';
      this.reprioritizeJob(existing, priority);
      return existing.promise;
    }

    let settle: (data: ChunkData | null) => void = () => {};
    const promise = new Promise<ChunkData | null>((resolve) => {
      settle = resolve;
    });

    const job: Job = {
      id: this.nextId++,
      coord: { x: coord.x, z: coord.z },
      key,
      priority,
      state: 'queued',
      promise,
      settle,
    };

    this.jobsByKey.set(key, job);
    this.jobsById.set(job.id, job);
    this.queue.push(key, job, priority);
    this.pump();
    return promise;
  }

  reprioritize(coord: ChunkCoord, priority: number): void {
    const job = this.jobsByKey.get(chunkKey(coord));
    if (job !== undefined) this.reprioritizeJob(job, priority);
  }

  cancel(coord: ChunkCoord): void {
    const key = chunkKey(coord);
    const job = this.jobsByKey.get(key);
    if (job === undefined) return;

    if (job.state === 'queued') {
      // Never dispatched: drop it entirely, which is the case that matters for
      // a fast-moving camera.
      this.queue.remove(key);
      this.finish(job, null, 'cancelled');
      return;
    }

    // Already on a worker. Terminating it to save a few microseconds of
    // generation would cost a worker respawn, so let it finish and throw the
    // result away when it lands.
    job.state = 'cancelled';
  }

  /** Cancel every queued request whose key is not in `keep`. */
  cancelExcept(keep: ReadonlySet<string>): number {
    let cancelled = 0;
    for (const entry of this.queue.toSortedArray()) {
      if (keep.has(entry.key)) continue;
      this.cancel(entry.value.coord);
      cancelled++;
    }
    return cancelled;
  }

  /** Chunk keys currently queued or running. */
  outstandingKeys(): string[] {
    return [...this.jobsByKey.keys()];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.assigned.length = 0;
    this.queue.clear();

    // Settle everything still outstanding, otherwise callers awaiting a chunk
    // hold their closures (and whatever they captured) alive forever.
    for (const job of [...this.jobsByKey.values()]) this.finish(job, null, 'cancelled');
    this.jobsByKey.clear();
    this.jobsById.clear();
  }

  private reprioritizeJob(job: Job, priority: number): void {
    if (job.priority === priority) return;
    job.priority = priority;
    this.queue.reprioritize(job.key, priority);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.size > 0) {
      const entry = this.queue.pop();
      if (entry === undefined) return;
      const index = this.idle.pop() as number;
      const job = entry.value;
      job.state = 'inFlight';
      this.assigned[index] = job;
      (this.workers[index] as WorkerLike).postMessage({
        kind: 'generate',
        id: job.id,
        coord: job.coord,
        worldSeed: this.worldSeed,
      });
    }
  }

  /**
   * A worker threw outside our own try/catch, so the job it held will never
   * report back. Settle it as cancelled -- otherwise the streamer waits on a
   * promise that can never resolve and the chunk is permanently missing.
   */
  private onWorkerCrash(index: number, error: unknown): void {
    this.failedCount++;
    this.onError(error instanceof Error ? error.message : String(error));
    const job = this.assigned[index];
    if (job !== undefined) this.finish(job, null, 'cancelled');
    this.releaseWorker(index);
  }

  private onWorkerMessage(index: number, message: WorkerResponse): void {
    const job = this.jobsById.get(message.id);
    this.assigned[index] = undefined;

    if (message.kind === 'error') {
      this.failedCount++;
      this.onError(message.message);
      if (job !== undefined) this.finish(job, null, 'cancelled');
      this.releaseWorker(index);
      return;
    }

    if (job === undefined) {
      this.releaseWorker(index);
      return;
    }

    this.totalGenerateMs += message.elapsedMs;
    if (job.state === 'cancelled') {
      // Generated but no longer wanted. The payload is dropped here and
      // garbage collected; nothing reaches the scene.
      this.finish(job, null, 'cancelled');
    } else {
      this.finish(job, message.data, 'completed');
    }
    this.releaseWorker(index);
  }

  private releaseWorker(index: number): void {
    if (this.disposed) return;
    this.assigned[index] = undefined;
    if (!this.idle.includes(index)) this.idle.push(index);
    this.pump();
  }

  private finish(job: Job, data: ChunkData | null, outcome: 'completed' | 'cancelled'): void {
    this.jobsByKey.delete(job.key);
    this.jobsById.delete(job.id);
    if (outcome === 'completed') this.completedCount++;
    else this.cancelledCount++;
    job.settle(data);
  }
}
