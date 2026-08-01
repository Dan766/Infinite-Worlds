/**
 * The message contract between the main thread and a chunk worker.
 *
 * Kept in its own module so both sides import the same definitions and neither
 * pulls in the other's dependencies -- the worker must not reach Three.js, and
 * the main thread must not reach worker globals.
 */

import type { ChunkCoord, ChunkData } from './contracts';

export interface GenerateChunkRequest {
  readonly kind: 'generate';
  /** Job id, unique per pool. Echoed back so a result can be matched to a request. */
  readonly id: number;
  readonly coord: ChunkCoord;
  readonly worldSeed: number;
}

export type WorkerRequest = GenerateChunkRequest;

export interface ChunkReadyResponse {
  readonly kind: 'chunk';
  readonly id: number;
  readonly data: ChunkData;
  /** Milliseconds spent generating, measured inside the worker. */
  readonly elapsedMs: number;
}

export interface ChunkFailedResponse {
  readonly kind: 'error';
  readonly id: number;
  readonly message: string;
}

export type WorkerResponse = ChunkReadyResponse | ChunkFailedResponse;

/**
 * Minimal surface the pool needs from a worker.
 *
 * `Worker` is not structurally assignable to this (its `onmessage` property is
 * contravariant in a way that strict mode rejects), so the browser
 * implementation is an adapter. The upside is that unit tests can supply a
 * synchronous fake and exercise queueing, priority and cancellation with no
 * browser at all.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  setHandlers(
    onMessage: (message: WorkerResponse) => void,
    onError: (error: unknown) => void,
  ): void;
  terminate(): void;
}
