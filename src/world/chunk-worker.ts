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

import { chunkDataTransferables } from './contracts';
import { chunkTierContext, generateChunk } from './chunk-gen';
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
    // Phase 3b supplies the Region tier for the first time: `chunkTierContext`
    // attaches the river network so `generateChunk` reads it through
    // `coarser('region')` (RULE 3). The network itself is memoised per region
    // inside `rivers.ts`, so this is one object per request, not one flow
    // accumulation pass.
    //
    // The worker is still stateless PER MESSAGE. The river memo is derived data
    // -- a pure function of `(seed, region)` that can be dropped and rebuilt
    // byte-identically -- so which worker answers a request still cannot
    // influence the result.
    const context = chunkTierContext(request.worldSeed);
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
