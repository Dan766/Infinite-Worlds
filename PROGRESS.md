# Progress

One phase per session, fresh context. This file plus `ARCHITECTURE.md` is how
state moves between sessions. Update both at the end of every phase.

| Phase | Title                              | Status |
| ----- | ---------------------------------- | ------ |
| 0     | Scaffold and verification harness  | Done   |
| 1     | Chunk streaming skeleton           | Done   |
| 2     | Terrain heightfield and LOD        | Next   |
| 3     | Water                              | -      |
| 4     | Settlements and road network       | -      |
| 5     | Road meshes                        | -      |
| 6     | Lots and buildings                 | -      |
| 7     | Vegetation and props               | -      |
| 8     | Player controller and collision    | -      |
| 9     | NPCs                               | -      |
| 10    | Lighting and atmosphere            | -      |
| 11    | Materials and post-processing      | -      |
| 12    | Ship                               | -      |

---

## Phase 0 -- Scaffold and verification harness (done)

### Built

- Vite + TypeScript (strict, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`) + Three.js WebGL2. One lit cube whose colour is
  derived from the world seed, so seed plumbing is verifiable by eye.
- `src/core/hash.ts` -- counter-based `hash2i` / `hash3i` / `hashString` /
  `rngFromHash`, all uint32 via `Math.imul`. 20 unit tests covering purity,
  order-independence, negative and extreme coordinates, avalanche, and bucket
  spread.
- `src/core/loop.ts` -- fixed-timestep loop, 60Hz sim decoupled from render,
  pausable and single-steppable, sub-step clamped. `advance()` is public and
  rAF-free so it is unit testable. 16 tests.
- `src/core/params.ts` -- URL parameters in and out, with 16 tests including
  round-tripping and malformed-input fallback.
- `src/render/renderer.ts` -- the only module touching `THREE.WebGLRenderer`.
- `src/debug/` -- perf HUD with a line registry, rolling frame timer with spike
  counting, lil-gui panel with a control registry.
- `src/core/camera-rig.ts` -- minimal free-fly camera (see judgement calls).
- Screenshot harness: `shot`, `shots`, `shots:check`, plus `verify:subpath`.
- Five canonical baselines committed in `shots/`.

### Verified

All run on 2026-08-01 in the dev container:

| Check                  | Result                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `npm test`             | 52 passed, 3 files                                             |
| `npm run build`        | clean `tsc --noEmit`; `dist/` 563.8 kB (142.4 kB gzip)         |
| `npm run shots:check`  | all 5 views byte-identical, run twice, plus once across a source change |
| `npm run verify:subpath` | app ready, zero failed requests, `src="./assets/..."`        |

Live HUD readings at `?seed=hud-check&time=3`, software rendering:

```
fps           60.0
frame ms      16.7 avg / 16.8 max / 0 spikes
draw calls    1
triangles     12
js heap       5.9 MB
chunks        0
worker queue  0
```

Comfortably inside every budget, as it should be with one cube -- the numbers
matter as a starting point to watch, not as an achievement.

### Judgement calls worth knowing about

1. **A free-fly camera was included**, though the roadmap first mentions one in
   Phase 1. Without any way to move, `?pos=` and `?look=` are write-only and the
   panel's copy-link button has nothing to copy, so the Phase 0 URL-repro
   deliverable could not actually be exercised. Kept minimal: WASD/QE, shift to
   sprint, pointer-lock look.

2. **`file://` is not supported, by design.** The acceptance criterion said "the
   deployed static build works from a file path". Chrome blocks ES module
   scripts over `file://` for CORS reasons, and Phase 1's Web Workers hit the
   same wall, so a literal `file://` open cannot work with the fixed stack
   without inlining everything -- which Phase 1 would immediately break.
   Confirmed with the user and implemented as "runs from any static host at any
   nested subpath", enforced by `npm run verify:subpath`.

3. **The screenshot check needed a guard against passing on nothing.** The first
   baseline run produced five byte-identical PNGs and `shots:check` reported
   success -- because the camera was pointing away from the cube and every frame
   was an empty clear colour. A byte comparison cannot tell "stable" from
   "blank". `shots:check` now also fails if a frame has fewer than 4 distinct
   colours, or if all canonical views produce the same image.

4. **The HUD is excluded from canonical screenshots.** It shows fps and heap,
   which can never match between runs. `canonicalizeUrl` forces
   `hud=0&panel=0&freeze=1` on every canonical view. Use `npm run shot -- <url>
   <name> --raw` to capture the HUD while debugging.

5. **`postprocessing` is deliberately not installed.** It belongs to Phase 11.

### Known gaps, deliberately left

- No `src/world/contracts.ts` yet -- Phase 1 owns it.
- The `chunks` and `worker queue` HUD lines are placeholders returning 0. Phase 1
  re-registers the same labels to supply real values; no edit to `app.ts` needed.
- Lighting in `app.ts` is a hemisphere plus a directional light, explicitly
  placeholder. Phase 10 replaces it entirely. Do not build on it.
- The bundle is a single 563 kB chunk. Vite warns about this. Not worth splitting
  until Phase 12 sets an asset budget.

---

## Phase 1 -- Chunk streaming skeleton (done)

Goal was to prove the streaming machinery in isolation, with no terrain, where
bugs are still cheap to find. It is flat coloured quads and nothing else.

### Built

- `src/world/contracts.ts` -- `ChunkCoord`, `ChunkData`, `ChunkProvider`,
  `TierContext`, plus tier sizes and coordinate helpers. No Three.js and no DOM,
  so it imports cleanly into a worker and into a Node test. `TierContext.coarser`
  **throws** on a same-or-finer tier read rather than returning undefined,
  because RULE 3 violations must fail at the call site instead of surfacing three
  phases later as a mysterious non-determinism bug. Region and Sector are
  declared but unused; Phases 2-4 add generators, not new types.
- `src/world/chunk-gen.ts` -- pure `generateChunk(coord, ctx)` and
  `chunkColor(coord, seed)` built on `rngAt2i`. The worker and the unit tests run
  the identical function.
- `src/world/chunk-worker.ts` + `worker-protocol.ts` -- module worker, stateless,
  posting transferred `ArrayBuffer`s.
- `src/world/worker-pool.ts` -- `navigator.hardwareConcurrency - 1` workers,
  priority queue by distance to camera, cancellation, and a `spawn` injection
  point so tests drive the whole thing with a synchronous fake worker.
- `src/world/priority-queue.ts` -- keyed binary min-heap with in-place re-ranking
  and remove-by-key, ties broken by insertion order so it is testable.
- `src/world/lru-cache.ts` -- hard entry cap, eviction hook. `delete` does not
  evict, because deleting means the caller is taking ownership back.
- `src/world/chunk-mesh.ts` -- the only file under `world/` that imports Three.
  Builds and disposes geometry, material and any textures on it.
- `src/world/chunk-streamer.ts` -- radius load/unload with hysteresis, LRU of
  retired chunks, bounded mesh builds per frame, and the real `chunks` /
  `worker queue` HUD lines plus a `Streaming` panel folder.
- `src/core/autopilot.ts` and `?fly=` / `?flyleg=` -- a deterministic camera
  flight, so the five-minute acceptance criterion is a command instead of a
  human staring at a screen.
- `scripts/soak.mjs` and `npm run soak`.
- Five new canonical views. 86 new unit tests (138 total).

### Verified

All run on 2026-08-01 in the dev container, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | 138 passed, 11 files                                                |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 579.1 kB + a 2.1 kB worker chunk       |
| `npm run shots:check`    | all 10 views byte-identical, run twice                              |
| `npm run verify:subpath` | app ready, zero failed requests, 3 workers fetched from the nested mount, 197 chunks streamed |
| `npm run soak`           | 300s, heap trend **-0.05 MB/min**, 25/25 start colours matched. Run twice; the chunk totals reproduced exactly. |

Full 5-minute soak, 45 m/s, seed `soak`:

```
heap    5.2 MB at t=0 -> 8.6 MB by t=50s -> 8.5 MB at t=300s
        post-warmup trend -0.05 MB/min (limit 6), peak 9.0 MB (budget 400)
chunks  live 197 min / 246.0 mean / 247 max
        3345 generated, 2714 evicted, 384 cached at the cap
frames  15536 drawn, worst 66.7 ms (83.4 ms on a second run), 2400 over 20 ms
draws   108 peak (budget 1200)
trip    out to x=6726 m and back to x=26 m; 25/25 chunk colours identical
```

The heap is flat, the chunk count is stable, and the origin comes back
identical. Note the shape of the run: the heap climbs from 5.2 to 8.6 MB over
the first 50 seconds while the LRU cache fills to its 384-entry cap, then sits
flat for the remaining four minutes with 2714 evictions behind it. That is the
cap doing its job, and it is why the soak fits its trend line after a 25%
warm-up. A 60-second run reports about +2 MB/min for the same reason and is not
evidence of a leak.

Live HUD at `?seed=hud-check&pos=0,300,0&look=0,-72&time=3`:

```
fps           43.1
frame ms      23.2 avg / 33.4 max / 9 spikes
draw calls    94
triangles     198
programs      2
js heap       7.7 MB
chunk mem     13.9 kB vertex data
chunks        197 live / 0 cached / 0 evicted
worker queue  0 queued / 0 busy / 3 workers
chunk gen     197 built / 0 cancelled
```

### Budgets

| Budget                        | Status                                                    |
| ----------------------------- | --------------------------------------------------------- |
| <=1200 draw calls             | **Met.** 108 peak.                                          |
| <=400MB heap after 5 minutes  | **Met.** 9.0 MB peak, trend flat.                           |
| 60fps at 1080p                | **Not measured on target hardware.** 43-56 fps at 1280x720 under SwiftShader. |
| <=16ms frame, no >4ms GC spike | **Not measured on target hardware.** Worst frame 66.7-83.4 ms under SwiftShader. |

Be clear about the last two: this container has no GPU, and every number above
comes from a software rasteriser. 197 flat quads with one draw call each cannot
plausibly cost 70-80 ms on real hardware -- the cost is fragment fill in
SwiftShader. The same 197 chunks cost 18-23 ms per frame from an aerial view and
60 ms from the ground-level default view, where a handful of quads cover the
whole screen. That is a fill-rate signature, not a scene-complexity one.
They are recorded as unverified rather than passed. Someone with a GPU should
open `?pos=0,300,0&look=0,-72` at 1080p and read the HUD.

The soak therefore *reports* worst frame time and warns above 100 ms, but does
not fail on it. A check that is permanently red in the only environment that
runs it is a check nobody reads.

### Judgement calls worth knowing about

1. **The placeholder cube stays.** Phase 1 could have removed it, but two of the
   canonical views exist to prove `?time=` seeks the simulation, and chunks are
   completely static -- with the cube gone, `cube-t0` and `cube-default` would
   become the same image and that part of the harness would silently stop
   testing anything. The cube is also the only seed-visible object that is not a
   chunk. It was raised to `y = 1` so it rests on the new ground plane instead of
   being buried to the waist.

2. **Chunk meshes get an explicit `renderOrder` derived from the coordinate.**
   Found the hard way: the first `shots:check` after Phase 1 failed on the two
   wireframe views only. Three.js sorts opaque draws by `material.id` before
   depth, material ids are assigned in construction order, and construction
   order is whichever worker finished first. Solid quads do not care; wireframe
   does, because neighbouring chunks draw their shared edge at identical depth
   and the first drawn wins. Without the fix the harness is intermittently red,
   which is worse than being wrong.

3. **`window.__worldReady` now waits for the streamer to settle**, not just for
   two frames. Screenshots would otherwise race the workers. This is an edit to
   `app.ts`'s readiness logic, not to its HUD block -- the `chunks` and
   `worker queue` lines are still replaced by label from `chunk-streamer.ts`.

4. **Flat unlit `MeshBasicMaterial`, one material per chunk.** Unlit so the
   colour on screen is exactly the coordinate hash, with no placeholder lighting
   in between; a screenshot is then a direct read-out of determinism. Per-chunk
   materials also mean the disposal path is genuinely exercised. Phase 2 should
   revisit this: a shared material with vertex colours is cheaper once chunks
   stop being one flat colour.

5. **Two radii, not one.** Load at 8 chunks (512 m), unload at 10. A single
   radius makes a camera sitting on a chunk boundary load and unload the same
   ring every frame.

6. **Retired chunks are cached, not destroyed**, up to 384 entries. Turning
   around should not re-run the workers. The cap is what keeps that from being a
   leak with a friendly name, and the soak shows it holding at exactly 384 with
   2714 evictions behind it.

7. **`?fly=` uses a closed-form triangle wave**, not an accumulated per-frame
   delta, so the camera lands on *exactly* its starting X at every multiple of
   `2 * flyleg` whatever the frame rate did. That is what makes the round-trip
   colour check exact rather than approximate.

8. **The soak has anti-vacuity guards.** Phase 0 learned that a byte-comparison
   harness can report five green screenshots while rendering nothing. A soak run
   over an empty world would likewise show a beautifully flat heap, so it fails
   if fewer than 50 chunks were ever resident, if no more chunks were generated
   than were resident at once, if too few frames were drawn, or if the camera
   barely moved. These are not hypothetical: running the soak at 2000 m/s
   correctly failed with "no chunks were resident where the flight started",
   because the page had already travelled a kilometre before the first sample.

### Known gaps, deliberately left

- **The cancellation path never fires in the live soak.** `cancelled total` is 0
  at every speed tried, including 2000 m/s. Phase 1's generator takes a few
  microseconds per chunk, so the queue empties faster than the camera can
  invalidate it, and there is never a queued request to cancel. The path is
  covered by unit tests (both queued-cancel and cancel-after-dispatch) and by the
  streamer test, and it will start firing for real in Phase 2 when generation
  costs something. Watch `chunk gen ... / N cancelled` in the HUD then.
- Chunk payloads are 48 bytes of positions and 24 of indices -- a single quad.
  The transfer machinery is real, the volume is not. `SEGMENTS` in
  `chunk-gen.ts` is the knob Phase 2 turns.
- No LOD. Every chunk is full detail, which is fine at 2 triangles each and will
  not be in Phase 2.
- The ground plane is at `y = 0` with `minY = maxY = 0`. `ChunkData` already
  carries the vertical extent so bounds and culling do not need reworking.
- Lighting in `app.ts` is still the Phase 0 placeholder. Chunks deliberately do
  not use it. Phase 10 replaces it.
- The bundle is still one 579 kB chunk plus a 2.1 kB worker. Vite still warns.
  Not worth splitting until Phase 12 sets an asset budget.

---

## Phase 2 -- Terrain heightfield and LOD (next)

Starting points that already exist:

- `generateChunk` in `src/world/chunk-gen.ts` is the one function to change.
  Raise `SEGMENTS`, write real Y values, and set `minY` / `maxY`. Everything
  downstream -- transfer, priority, cancellation, caching, disposal -- already
  works and is tested.
- `TierContext.coarser('region')` and `coarser('sector')` are already wired and
  already enforce RULE 3. Populate them in the worker's `createTierContext` call.
- `ChunkData` may gain fields (normals, materials). Add them as typed arrays and
  add their buffers to `chunkDataTransferables`, or they will be cloned instead
  of transferred.
- Re-run `npm run soak` and expect `cancelled` to stop being zero. If it is still
  zero once generation is expensive, the cancellation path has regressed.
- Add canonical views for terrain and re-run `npm run shots`. The existing ten
  will change; say so here.
