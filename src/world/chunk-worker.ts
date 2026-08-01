/**
 * Chunk generation worker.
 *
 * RULE: zero world generation on the main thread. Every payload the streamer
 * renders comes through here.
 *
 * The worker is stateless. It holds no cache and no counters, so which worker
 * in the pool happens to pick up a job cannot influence the result -- that is
 * what makes "same seed and coordinate, byte-identical output" true regardless
 * of visit order.
 *
 * `self` is typed locally rather than by switching the TS lib to `webworker`,
 * because that lib conflicts with `dom` and this project needs both.
 */

import { createTierContext, chunkDataTransferables } from './contracts';
import { generateChunk } from './chunk-gen';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  if (request.kind !== 'generate') return;

  try {
    const startedAt = performance.now();
    // Phase 1 has no coarser tiers to supply. Phases 2-4 pass the region and
    // sector records in here; nothing else about this file changes.
    const context = createTierContext(request.worldSeed, 'chunk');
    const data = generateChunk(request.coord, context);
    const elapsedMs = performance.now() - startedAt;

    // Transfer rather than clone: the payload's buffers move to the main thread
    // and are neutered here. Nothing in this worker may touch `data` after this.
    scope.postMessage(
      { kind: 'chunk', id: request.id, data, elapsedMs },
      chunkDataTransferables(data),
    );
  } catch (error) {
    scope.postMessage(
      {
        kind: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      },
      [],
    );
  }
};
