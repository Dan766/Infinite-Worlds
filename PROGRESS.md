# Progress

One phase per session, fresh context. This file plus `ARCHITECTURE.md` is how
state moves between sessions. Update both at the end of every phase.

| Phase | Title                              | Status |
| ----- | ---------------------------------- | ------ |
| 0     | Scaffold and verification harness  | Done   |
| 1     | Chunk streaming skeleton           | Done   |
| 2a    | Terrain heightfield                | Done   |
| 2b    | Quadtree LOD                       | Done   |
| 3a    | Sea level and shoreline            | Done   |
| 3b    | Rivers                             | Done   |
| 4a    | Settlements and road network       | Done   |
| 4b    | Settlement streets (Sector tier)   | Done   |
| 5     | Road meshes                        | Done   |
| 6     | Lots and buildings                 | Next   |
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

## Phase 2a -- Terrain heightfield (done)

The roadmap's Phase 2 bundled heightfield + quadtree LOD + `sampleHeight` parity
+ splat material. It was split deliberately. **2a is the heightfield; 2b is the
quadtree.** This phase keeps the Phase 1 uniform 512 m load radius and builds no
quadtree, no skirts, no stitching and no LOD transitions.

### Built

- **`src/world/noise.ts`** (new) -- gradient noise on `hash2i`, fBm, ridged
  multifractal, domain warp, plus `smoothstep` / `lerp` / `clamp`. No Three, no
  DOM, importable from a worker and from Node.
- **`src/world/height-field.ts`** (new) -- `sampleHeight(x, z, worldSeed)` and
  the four low-frequency fields Phase 4 onward reads for biomes:
  `continentalness` and `erosion` in [-1, 1], `temperature` and `humidity` in
  [0, 1]. Elevation is a domain-warped fBm continent shelf, plus a ridged
  multifractal masked to young inland ground, plus hills, plus detail.
- **`src/world/contracts.ts`** -- the one authorised reshape (see below), plus
  `normals` and `colors` on `ChunkData`, both added to
  `chunkDataTransferables` and to `chunkDataBytes`. `CHUNK_DATA_VERSION` is 2.
- **`src/world/chunk-gen.ts`** -- `SEGMENTS` 1 -> 32 (2 m resolution; 1089
  vertices and 2048 triangles per chunk). Vertex Y from `sampleHeight`, normals
  from central differences of the height field over a one-cell skirt, per-vertex
  colours from slope / altitude / temperature / humidity, real `minY`/`maxY`.
  `surfaceColor` is exported as a pure function of five scalars so the palette
  is unit-testable without a GPU.
- **`src/world/chunk-mesh.ts`** -- `normal` and `color` attributes, a
  `MeshLambertMaterial` with `vertexColors`, bounds from the real vertical
  extent. The coordinate-derived `renderOrder` is kept. Adds `hashPositions`,
  used by the soak's RULE 2 check.
- **`src/scene/cube.ts`** -- the cube is seated at `sampleHeight(0,0) + 1` via
  the MAIN-THREAD function, so a main-thread/worker parity bug shows up as a
  floating or buried cube in `shots/cube-default.png`.
- **`src/core/params.ts`** -- `hasParam`, so `App` can tell an absent `?pos=`
  from a supplied one.
- **`scripts/soak.mjs`** -- round-trip check replaced with a position-buffer
  hash; four GPU-independent hard budgets added.
- Two new canonical views, and 90 new unit tests (228 total).

### The contract change

Pre-authorised by the user, made once, and now settled. `ARCHITECTURE.md`
rule 4 records it. `ChunkCoord` gained `readonly lod`, `chunkKey` became
`x,z,lod` (`parseChunkKey` rejects a Phase 1 two-component key rather than
reading it as lod 0), `chunkSizeAt(lod)` was added, and `worldToChunk` /
`chunkOrigin` / `chunkCenter` became lod-aware. **Throughout Phase 2a `lod` is
always 0.** It exists so Phase 2b adds behaviour without touching contracts
again.

### Verified

All run on 2026-08-01 in the dev container, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | 228 passed, 13 files (138 -> 228)                                   |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 585.0 kB + a 6.1 kB worker chunk       |
| `npm run shots:check`    | all 12 views byte-identical, run twice                              |
| `npm run verify:subpath` | app ready, zero failed requests, 3 workers from the nested mount, 197 chunks streamed |
| `npm run soak`           | 300s, heap trend **-0.07 MB/min**, **25/25 geometry hashes identical** |

Full 5-minute soak, 45 m/s, seed `soak`:

```
heap     18.6 MB at t=0 -> 48.4 MB by t=75s -> 48.3 MB at t=300s
         post-warmup trend -0.07 MB/min (limit 6), peak 48.9 MB (budget 400)
chunks   live 214 min / 245.0 mean / 247 max
         3345 generated, 2714 evicted, 384 cached at the cap
geometry 505,856 live triangles peak (budget 900,000)
         268,983 live vertices peak (budget 500,000)
         38.4 MB payload peak (budget 96 MB), 63,780 bytes per chunk
         105 draw calls peak (budget 1200)
frames   2206 drawn, worst 900 ms, 2050 over 20 ms
trip     out to x=6644 m and back to x=101 m; 25/25 position hashes identical
```

The chunk totals (3345 generated, 2714 evicted, 384 cached) reproduce Phase 1's
exactly, which is the streaming machinery behaving identically under a payload
nearly 900x larger.

Live HUD at `?seed=hud-check&pos=0,300,0&look=0,-72&time=3`:

```
fps           6.5
frame ms      154.2 avg / 299.9 max / 3 spikes
draw calls    58
triangles     116,748
programs      2
js heap       18.4 MB
chunk mem     12.0 MB vertex data
chunks        197 live / 0 cached / 0 evicted
chunk geo     403456 tris / 214533 verts live
worker queue  0 queued / 0 busy / 3 workers
chunk gen     197 built / 0 cancelled
```

### Budgets

| Budget                         | Status                                                    |
| ------------------------------ | --------------------------------------------------------- |
| <=1200 draw calls              | **Met.** 105 peak.                                          |
| <=400MB heap after 5 minutes   | **Met.** 48.9 MB peak, trend flat.                          |
| live triangles <=900,000       | **Met.** 505,856 peak. New this phase, hard failure.        |
| live vertices <=500,000        | **Met.** 268,983 peak. New this phase, hard failure.        |
| chunk payload <=96 MB          | **Met.** 38.4 MB peak. New this phase, hard failure.        |
| 60fps at 1080p                 | **UNVERIFIED.** 4-10 fps at 1280x720 under SwiftShader.     |
| <=16ms frame, no >4ms GC spike | **UNVERIFIED.** Worst frame 900 ms under SwiftShader.       |

Be blunt about the last two. This container has no GPU and every timing above
comes from a software rasteriser now pushing half a million triangles of
fill. They are recorded as unverified, not as passed, exactly as Phase 1 did.
Someone with a GPU should open `?pos=0,300,0&look=0,-72` at 1080p and read the
HUD. What CAN be said from these numbers: the frame cost tracks fill rate and
triangle count, and it got roughly 10x worse than Phase 1 for a ~1000x increase
in triangles, which is the signature of a fill-bound software rasteriser rather
than of a scene-complexity problem.

The four geometry budgets were added precisely because they are the part of the
budget this environment can judge honestly, and because Phase 2b needs a real
number to land against.

### Screenshots: all ten existing baselines changed, and two were added

Every one of the ten Phase 0/1 baselines is different, and legitimately so:
the ground went from a flat y=0 plane of hash-coloured quads to a lit,
vertex-coloured heightfield, and the cube and the default camera now sit on it.
No canonical view's `params` were edited -- only their pixels changed -- so each
one still tests exactly what it used to. The two new views are:

- `terrain-mountain-profile` (`?time=3&pos=-3300,175,420&look=120,-8`) -- a
  mountain in silhouette against the sky with a snow cap, 3.3 km west of the
  origin on the default seed. All four elevation terms visible at once. If the
  terrain regresses to noise or to a plane, this view says so first.
- `terrain-wireframe-relief` (the same viewpoint, `&wireframe=1`) -- the 2 m
  triangle grid draped over relief. Catches a change to `SEGMENTS`, a broken
  vertex grid, or a chunk that failed to build, none of which are obvious in the
  shaded view, and re-tests the coordinate-derived `renderOrder` now that
  neighbouring chunks are no longer coplanar.

All twelve were inspected by eye before being committed, and `shots:check` was
run twice afterwards.

### Judgement calls worth knowing about

1. **The origin was a lattice point, and it mattered.** Gradient noise is
   exactly zero at every integer lattice point, and the world origin is a
   lattice point of every frequency. The first working build returned
   `h(0,0) = -9.6` for *every seed* -- the terrain was seed-independent exactly
   where the default camera looks, which is a silent hole in the whole `?seed=`
   verification story. Each field now offsets its lattice by a seed-derived
   amount (`offsetX` / `offsetZ` in `height-field.ts`). The height-field tests
   assert `field(0, 0, seedA) !== field(0, 0, seedB)` so this cannot come back.

2. **The snow line's sign was inverted, and a test caught it.** The first
   version put snow *lower* in warm climates. The unit test
   `puts the snow line higher in a warm climate than a cold one` failed on it.
   That is the argument for keeping `surfaceColor` a pure function of five
   scalars instead of inlining the palette into the vertex loop: the property is
   directly assertable, and no screenshot comparison would have flagged it.

3. **The two `sampleHeight` parity assertions are deliberately different.**
   Function-to-function is `===`, exact, because both sides compute in float64
   and anything less is a bug being tolerated -- it is what catches a generator
   that accumulates `x += step` instead of recomputing `origin + col * step`.
   Function-to-stored-vertex uses `abs(h) * 1e-6 + 1e-4`, because vertices are
   `Float32Array` and float32 carries about 1e-5 of absolute precision at these
   heights; a 1e-6 assertion there could never pass however correct the code.
   That tolerance is a statement about the storage format, not a knob. A third
   test asserts neighbouring vertices differ by far more than the tolerance, so
   the tolerant assertion cannot pass vacuously.

4. **Normals come from the height field, not from the triangles.** Triangle
   normals are discontinuous at chunk borders and would draw a lighting crease
   along every 64 m boundary in the world. `chunk-gen.ts` samples a one-cell
   skirt beyond the node and takes central differences; a unit test asserts the
   shared edge of two neighbouring chunks gets bit-identical normals from both.
   This also gives Phase 2b a normal that does not depend on the node's
   resolution.

5. **No `Math.pow` on the path to a vertex.** ECMAScript only approximates
   `pow`/`sin`/`cos`/`exp`, so two engines may disagree in the last bits, and
   these values land in buffers RULE 2 says must come back identical. The
   gradient table is eight fixed directions built from `Math.SQRT1_2` rather
   than `cos`/`sin` of a hashed angle, and the sRGB->linear conversion is a
   polynomial rather than `x^2.4`.

6. **The fractal functions take positional parameters, not an options object.**
   They run five or six times per height sample and a height sample runs ~1200
   times per chunk; an options literal per call is millions of short-lived
   objects per soak run, which is GC pressure in exactly the frame budget this
   project is trying to hold.

7. **The default camera Y is now relative to the ground; an explicit `?pos=` is
   not.** With terrain, one fixed default height is underground on one seed and
   in the clouds on the next. `hasParam(search, 'pos')` makes the distinction,
   and `currentUrl()` serialises the resolved absolute position, so links still
   round-trip. This is the only asymmetry in the URL contract and it is
   documented in `ARCHITECTURE.md`.

8. **Vertex colours, not a shader.** The roadmap's triplanar splat is Phase 11.
   Baking the palette in the worker keeps `chunk-gen.ts` the single testable
   source of truth for what the world looks like and leaves the material dumb
   enough to be replaced outright.

9. **`ChunkData.color` was kept even though nothing renders it.** It is the
   stable per-chunk identity colour from `chunkColor(coord, seed)`, still used
   by the streamer's debug sampler. Removing it would have been a second
   contract reshape in a phase that was authorised exactly one.

10. **One material per chunk was kept, not a shared instance.** A shared
    material would make `disposeChunkMesh` a no-op nobody notices until it
    matters, and Three caches the compiled program across identical materials
    anyway, so the cost is a JS object. Revisit if `programs` in the HUD ever
    stops reading 2.

### Known gaps, deliberately left

- **No LOD.** Uniform 512 m radius, every chunk full detail, exactly as scoped.
  Phase 2b owns the quadtree, skirts and stitching. `lod` is plumbed and always
  0; `chunkSizeAt` and the lod-aware coordinate helpers are already tested at
  non-zero levels.
- **`cancelled` is still 0 in the soak**, at every speed tried. Phase 1 expected
  this to start firing once generation cost something, and it has not: chunk
  generation is now ~10 ms instead of ~5 us, but SwiftShader renders at 5-10 fps,
  so three workers still empty the queue faster than the camera can invalidate
  it. The path is covered by unit tests (queued-cancel, cancel-after-dispatch,
  `cancelExcept`) and by the streamer test. Expect it to fire for real on
  hardware that renders fast enough to move the camera quickly, and in Phase 2b
  when the streamer starts churning nodes across LOD boundaries.
- **No water.** Roughly a third of the world is below y=0 and currently renders
  as dark silt. Phase 3 fills it. The basin floor deliberately keeps 30% of its
  hill relief so there is a lake bed with shape for water to sit in.
- **No rock texture, no triplanar, no normal maps.** Phase 11.
- **Lighting in `app.ts` is still the Phase 0 placeholder** (hemisphere +
  directional). Chunks are now lit by it, so terrain shading will change when
  Phase 10 replaces it -- expect the baselines to move then, and say so.
- **`temperature` ignores altitude.** A peak is not colder than the valley below
  it in the climate field; only the snow-line term in `surfaceColor` accounts
  for height. Phase 4 may want a lapse rate.
- The bundle is still one 585 kB chunk plus a 6.1 kB worker. Vite still warns.
  Not worth splitting until Phase 12 sets an asset budget.

### For Phase 2b

- `ChunkCoord.lod`, `chunkKey`, `chunkSizeAt`, `worldToChunk(x, z, lod)`,
  `chunkOrigin` and `chunkCenter` are all lod-aware and tested at levels 0, 1, 2
  and 4. Contracts should not need to change again.
- `chunk-gen.ts` already generates at any `lod`: `vertexWorldX` / `vertexWorldZ`
  scale by `chunkSizeAt(coord.lod)` and `SEGMENTS` is fixed, which is what makes
  a coarse node cheaper than the four fine nodes it replaces.
- Normals are sampled from the height field, so they are already consistent
  between levels; only positions need stitching.
- The four geometry budgets in `scripts/soak.mjs` are the numbers to beat. They
  should go **down**.
- `chunk-mesh.ts` sets `renderOrder` from `(x, z)` only. Two nodes at different
  levels over the same square would collide; fold `lod` in when nodes can
  overlap during a transition.

---

## Phase 2b -- Quadtree LOD (done)

The second half of the roadmap's Phase 2. 2a was the heightfield at a uniform
512 m radius; 2b replaces the radius with a quadtree and pushes the view
distance to 4 km. No geomorphing, no stitching, no batching, no shader work, and
**no change to `contracts.ts`** -- which was the whole point of landing the
`lod` reshape early in 2a, and it held.

### What the phase was actually optimising, and why that changed the design

The user profiled 2a on real hardware (Intel Arc 140V, ANGLE/D3D11, 1920x1080).
The result reframed the problem:

- **Frame time was never the issue.** 1.46 ms median GPU render for the whole
  scene at 1080p -- about 11x headroom. The dev container's 154 ms figure is a
  ~100x software-rasteriser penalty and means nothing.
- **Draw calls and heap were.** At radius 48 (3 km) flat LOD with the camera
  near the horizon: **1,834 draw calls** (budget 1200) and **504 MB heap**
  (budget 400 MB), at a comfortable 8 ms frame. Extrapolated to 4 km: ~12,000
  chunks, ~3,000 draw calls, ~730 MB of vertex data.

So the quadtree's job is cutting **node count**, not triangle throughput.
`SEGMENTS` stays 32 -- lowering it would be optimising against a measurement
artifact -- and because it is constant across levels, **every node costs the
same 74,676 bytes and 2,560 triangles whatever area it covers**. That is what
makes node count the only quantity worth bounding, and it is why this quadtree
looks different from one tuned for triangle reduction.

### Built

- **`src/world/quadtree.ts`** (new) -- `selectQuadtree(cameraX, cameraZ, {
  viewDistance, splitFactor })`, plus `nodeParent` / `nodeChildren` /
  `isDescendantOrSelf` / `distanceToNode` / `distanceToNodeCenter` /
  `rootLodFor` / `lodHistogram`. Pure arithmetic: no Three, no DOM, no state, so
  the entire selection is unit-testable as a function. Descends from roots
  covering the view distance, splitting while
  `distance(camera, nodeCentre) < splitFactor * nodeSize`, culling by the
  nearest point of a node's square so the cover has no holes at the rim.
  Returns leaves sorted nearest-first and split nodes in DFS preorder.
- **`src/world/chunk-streamer.ts`** -- rewritten around the selection. The disc
  of offsets is gone; `loadRadius` / `unloadRadius` became `viewDistance` /
  `splitFactor`. New: a residency-conditioned retirement pass, a `subtreeReady`
  roll-up, a `lod` HUD line, `liveCoords()` for tests, and per-level counts in
  `stats()`. Cache raised 384 -> 512 entries.
- **`src/world/chunk-gen.ts`** -- skirts. `SKIRT_*` / `SURFACE_*` / `VERTEX_COUNT`
  / `TRIANGLE_COUNT` constants, `skirtDepthOf(positions)`, and an apron of 132
  vertices and 512 triangles per node. `SEGMENTS` unchanged at 32.
- **`src/world/chunk-mesh.ts`** -- `renderOrder` folds in `lod`; the bounding box
  extends down to the bottom of the apron; the material stays single-sided (see
  judgement call 3).
- **`src/core/camera-rig.ts`** -- near 0.1 -> 0.5 m, far 4000 -> 8000 m, so 4 km
  of terrain is not generated and then clipped; plus `setLook()` for the soak.
- **`src/app.ts`** -- `setLook`, `lodCounts()`, and `selectedNodes` / `rootLod` /
  `viewDistance` / `cameraY` / `cameraPitch` in `perfSnapshot()`.
- **`scripts/soak.mjs`** -- a shallow-pitch return leg, re-derived budgets, two
  new anti-vacuity guards, and per-level reporting.
- Three new canonical views and 35 new unit tests (228 -> 263).

### Verified

All run on 2026-08-01 in the dev container, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | 263 passed, 14 files (228 -> 263)                                   |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 588.2 kB + a 6.9 kB worker chunk       |
| `npm run shots:check`    | all 15 views byte-identical, run twice                              |
| `npm run verify:subpath` | app ready, zero failed requests, 3 workers from the nested mount, 256 nodes streamed                                                      |
| `npm run soak`           | 300s, heap trend **-0.38 MB/min**, **25/25 geometry hashes identical**                                                         |

Full 5-minute soak, 45 m/s, seed `soak`, shallow leg from t=145s:

```
heap     29.2 MB at t=0 -> 68.8 MB by t=75s -> 65.9 MB at t=300s
         post-warmup trend -0.38 MB/min (limit 6), peak 69.4 MB (budget 400)
nodes    live 253 min / 277.0 mean / 283 max
         281 selected at the end, lod [72 54 54 54 46 1 0], view distance 4096 m
         3329 generated, 2562 evicted, 512 cached at the cap
geometry 724,480 live triangles peak (budget 1,300,000)
         345,543 live vertices peak (budget 620,000)
         56.6 MB payload peak (budget 76 MB), 74,676 bytes per node
         106 draw calls peak (budget 200) -- 105 steep leg, 106 shallow leg
frames   1284 drawn, worst 983.3 ms, 1165 over 20 ms
trip     out to x=6687 m and back to x=158 m; 25/25 position hashes identical
```

Two things in there are worth reading twice.

**The two legs measure almost the same thing, and that is the honest result.**
105 draw calls steep against 106 shallow. The outbound pitch of -18 degrees from
90 m up was already close enough to the horizon that nearly the whole horizontal
fov reaches the 4 km rim, so dropping to -3 confirms the budget rather than
moving it. The leg still earns its place: it is what makes the claim checkable
instead of assumed, and the 55-call floor means a future change that quietly
tips the canary back toward nadir fails the run.

**`cancelled` is 3, not 0 -- for the first time in three phases.** Phases 1 and
2a both recorded that the cancellation path never fired in a live run, because a
uniform disc only invalidates queued work at its rim. It now fires. It is still
a small number because three workers empty the queue faster than a 45 m/s camera
can invalidate it; the unit tests cover the path properly.

Live HUD at `?seed=hud-check&pos=-3300,175,420&look=120,-8`, settled, at
1920x1080 -- a shallow pitch, because that is the only kind of view that
measures anything (see the harness section):

```
fps           1.0
frame ms      1000.0 avg / 1000.0 max / 1 spikes
draw calls    91
triangles     232,960
programs      1
js heap       30.4 MB
chunk mem     21.4 MB vertex data
cube tris     12
chunks        300 live / 0 cached / 0 evicted
lod           300 nodes  [80 56 57 61 44 2 0]  4096 m
chunk geo     768000 tris / 366300 verts live
worker queue  0 queued / 0 busy / 3 workers
chunk gen     300 built / 0 cancelled
```

300 nodes for 4 km of terrain in every direction, 91 of them drawn after frustum
culling. A flat lod-0 disc of the same radius would be about 12,000 nodes and
~3,000 draw calls. The 1 fps is SwiftShader filling 233k triangles across a
1080p frame and means nothing about real hardware.

### The acceptance gate, in the numbers it was stated in

At 4 km view distance with the camera near the horizon:

| Gate                            | Measured                                     |
| ------------------------------- | -------------------------------------------- |
| draw calls <= 1200              | **91-106.** Met, ~11x margin.                 |
| heap <= 400 MB after 5 min      | **69.4 MB peak**, trend -0.38 MB/min. Met.    |
| no cracks at a level boundary   | **Met.** See the screenshots section.         |
| byte-identical regeneration     | **Met.** 25/25 position hashes on the round trip. |

For scale, against Phase 2a's uniform 512 m disc: the view distance went from
512 m to 4096 m -- **64x the area** -- for **1.43x the triangles (505,856 ->
724,480) and the SAME draw calls (105 -> 106)**. Per square kilometre of world,
triangles fell about 45x and draw calls about 64x. Every node also grew a skirt
in the process, so the per-node cost went up, not down.

### `splitFactor` is 2.5, and popping is not proven invisible

2.5 puts about 300 nodes in the resident set at 4 km, distributed roughly
`[80 56 57 61 44 2 0]` across levels 0-6, and lands draw calls near 100.

The honest part. Popping is mitigated by threshold placement alone -- no
geomorphing, no custom shader, so Phase 11 stays free to replace the material.
The brief's target was "switch where screen-space error is about a pixel".
**That target is not reachable by moving this knob**, and the test
`screen-space error at a level switch` in `quadtree.test.ts` measures why.

Worst-case error at a switch, at 1080p with the project's 60-degree fov,
measured over five separate places in the world:

| splitFactor | lod 0 | lod 1 | lod 2 | lod 3 | lod 4 | nodes at 4 km |
| ----------- | ----- | ----- | ----- | ----- | ----- | ------------- |
| 1.5         | 3.6px | 5.2px | 10.5px| 11.2px| 13.4px| ~170          |
| 2.0         | 2.7px | 3.9px | 7.9px | 8.4px | 10.0px| ~206          |
| **2.5**     | **2.1px** | **3.1px** | **6.3px** | **6.7px** | **8.0px** | **~280**  |
| 3.0         | 1.8px | 2.6px | 5.3px | 5.6px | 6.7px | ~429          |
| 4.0         | 1.3px | 2.0px | 3.9px | 4.2px | 5.0px | ~600          |

Error falls as `1/splitFactor` while node count grows as its square, so buying
1 px would cost roughly forty times the nodes. The quantity that actually
governs it is `SEGMENTS`, which the phase is explicitly told not to touch, and
after that geomorphing, which is out of scope. 2.5 was kept because 3.0 buys 17%
less error for 50% more nodes -- a bad trade at these numbers -- and because it
is what the brief specified.

What that means in practice: **a level switch should be visible if you look for
it**, as a few pixels of silhouette shift on rough ground at 1-3 km, worst along
ridge lines. It is not visible as an artefact in any of the still captures --
the level boundaries in `lod-horizon` and `lod-rings-wireframe` are only
findable in wireframe -- but a still cannot show a transition, and this container
renders at 1-7 fps, so **I could not observe popping in motion and am not
claiming it is absent.** The measured numbers above are the honest statement;
someone with a GPU should fly through a boundary at speed and judge. If it is
objectionable, the levers are `SEGMENTS` or geomorphing, both out of scope for
this phase.

### The harness problem, fixed

The brief called the existing perf canary vacuous, and it was. `?pos=0,300,0&
look=0,-72` is near-nadir: it culls to ~74 draw calls and the soak's 1200-call
budget **could not have fired no matter how bad things got**. Three changes:

1. **Three new canonical views**, described in the screenshots section below.
   `lod-horizon` is the shallow-pitch perf and crack canary; `lod-rings-
   wireframe` is the structural one.
2. **The soak flies a shallow-pitch leg.** At the turn-around the camera drops
   to 3 degrees below the horizon for the return leg. The pitch change does not
   touch the flight path, so the round-trip determinism check is unaffected.
3. **All four geometry budgets re-derived** from that leg (see below). Plus two
   new anti-vacuity guards: the run fails if the shallow leg produced fewer than
   3 samples, or if it peaked under 55 draw calls -- i.e. if the canary was
   pointed at nothing.

The near-nadir view is **kept**, as instructed, as a parity canary: the cube is
seated with the main-thread `sampleHeight` while the ground comes from the
worker, so a divergence shows as a floating or buried cube.

The heap-trend window fix that landed after 2a -- anchoring warm-up to observed
cache saturation and refusing to judge a trend on a run too short to saturate --
is preserved untouched.

### Budgets

| Budget                         | Status                                                    |
| ------------------------------ | --------------------------------------------------------- |
| <=1200 draw calls              | **Met.** 106 peak on the shallow leg.                |
| <=400MB heap after 5 minutes   | **Met.** 69.4 MB peak, trend -0.38 MB/min.        |
| live triangles <=1,300,000     | **Met.** 724,480 peak.                                    |
| live vertices <=620,000        | **Met.** 345,543 peak.                                   |
| chunk payload <=76 MB          | **Met.** 56.6 MB peak.                                |
| 60fps at 1080p                 | **UNVERIFIED.** 3-10 fps at 1080p under SwiftShader.        |
| <=16ms frame, no >4ms GC spike | **UNVERIFIED.** Worst frame 983 ms under SwiftShader. |

The last two are recorded as unverified, not as passed, exactly as Phases 1 and
2a did. This container has no GPU. What the 2a hardware profile suggests is that
a scene of ~100 draw calls and ~250k drawn triangles will not trouble an Arc
140V, which rendered 3.8x that in 1.46 ms -- but that is an inference, not a
measurement, and the user should re-check on hardware.

The four geometry budgets were re-derived from the shallow leg with ~1.8x
headroom, and are deliberately far tighter than the project's 1200-call
ceiling: the ceiling says what the hardware can take, these say what the world
costs today.

### Screenshots: all twelve existing baselines changed, and three were added

Every existing baseline is different, and legitimately so: the view distance
went from 512 m to 4096 m, so **every view that can see a horizon now has one**
where Phase 2a's terrain simply ended. Nothing about the terrain itself changed
-- `height-field.ts` is untouched -- and no view's `params` were edited, so each
one still tests exactly what it did before.

The three new views:

- **`lod-horizon`** (`?time=3&pos=-1400,300,420&look=90,-5`) -- the shallow
  view the harness was missing. Snow-capped range 2-4 km out, all five levels
  in play on screen at once. A crack at a level boundary would show as a sliver
  of clear colour through the ground. 91-97 draw calls at 1080p.
- **`lod-ground-horizon`** (`?time=3&pos=-1400,88,420&look=90,-1`) -- 8 m above
  the ground, 1 degree below the horizon. This is where the lod-0/lod-1 boundary
  lands closest to the camera (~320 m) and so where a crack is widest in screen
  space. Also exercises the near-plane end of the depth range against 4 km of
  terrain.
- **`lod-rings-wireframe`** (`?time=3&pos=-1400,2600,420&look=0,-88&
  wireframe=1`) -- straight down from 2.6 km in wireframe: the quadtree itself.
  The bright centre is lod 0, whose 2 m cells are sub-pixel at that scale and so
  read as solid fill; each step outward doubles node size and halves apparent
  line density, with the classic quadtree staircase between them.

All fifteen were inspected by eye before being committed. **I looked
specifically for cracks along level boundaries in `lod-horizon`,
`lod-ground-horizon`, `terrain-mountain-profile`, `cube-default` and
`cube-seed-alpha`, and for ring structure in `lod-rings-wireframe`,
`chunks-wireframe` and `terrain-wireframe-relief`.** No cracks; the rings are
concentric, correctly ordered fine-to-coarse, and tile without gaps.

One thing the first capture DID show, and it is worth recording because it was
invisible in every unit test: **a dark speckled seam along every node boundary
in the world.** Diagnosis and fix are judgement call 3.

### Judgement calls worth knowing about

1. **The split test has no hysteresis, and that is a correctness property, not
   tidiness.** `selectQuadtree` is a pure function of `(cameraX, cameraZ,
   viewDistance, splitFactor)`. If it remembered anything, the set of resident
   nodes would depend on the route the camera took to a position -- per-node
   content would still be deterministic, but the resident SET would drift, and
   a byte-comparison harness cannot tell that from a real regression. There is a
   unit test that flies to one point from three different directions (and from a
   cold start) and demands the same resident set.

2. **Unload hysteresis is conditioned on RESIDENCY, not on distance -- and the
   distance version was written first and thrown away.** A node that stops being
   selected survives until whatever replaced it is in the scene: a parent until
   its four children are up, four children until their parent is. The obvious
   alternative, a distance margin (`viewDistance * 1.15`, which is what Phases 1
   and 2a used), was implemented and then removed, because the path-independence
   test above caught it red-handed: a camera that had passed within the margin
   left 173 nodes resident where a cold start left 110. Conditioning on
   residency gives a margin that is transient by construction -- **once nothing
   is streaming, live == selected, exactly** -- and the LRU cache makes the
   churn it no longer absorbs free.

   Getting rid of it is not just theory: the same test is what proves a settled
   screenshot cannot depend on where the camera has been.

3. **The skirt carries both windings and the material stayed single-sided.**
   First attempt used `THREE.DoubleSide`, which is the obvious way to make an
   apron opaque from both sides -- a crack is a vertical slot and you can see
   into it from the high side and the low side. It produced a dark speckled line
   along **every** node boundary in the world, clearly visible in the first
   shallow-pitch capture. Cause: Three.js flips the normal on back faces, the
   apron copies the surface normal, so the flipped copy shades near-black; and
   two same-level neighbours put geometrically identical aprons in the same
   plane, so a lit front face z-fights a black back face everywhere. Emitting
   both windings and keeping `FrontSide` fixes it exactly: whichever copy faces
   the camera is drawn with the surface's own normal, the other is culled before
   rasterising, and the two neighbours' coincident aprons are then bit-identical
   so their z-fight is invisible. Cost: 256 extra triangles a node, about 11%.

4. **Skirt depth is `3 x (largest step between adjacent border vertices)`, not a
   fraction of the node's relief.** The relief version was the first thing
   tried and hangs a 200 m curtain off every node in a mountain range, most of
   which sits in mid-air at the outer edge of the view distance. The border-step
   version is proportional to the terrain right at the seam, which is what the
   crack is: measured 1.0-2.5 m at lod 0 and 12-24 m on a 1024 m node, i.e.
   about 2% of node size. `skirtDepthOf(positions)` reads it back out of the
   uploaded buffer rather than recomputing it on the main thread, so there is
   one source of truth and no `ChunkData` field.

5. **`window.__worldReady` got stricter.** It used to mean "nothing
   outstanding"; it now means "every SELECTED node is in the scene". With
   several levels arriving asynchronously the weaker form would let a capture
   fire while a coarse node was still standing in for four fine ones, and the
   baselines would go flaky in a way that looks exactly like non-determinism.

6. **Selection is recomputed on every frame the camera moves, allocating
   fresh.** ~300 leaves and ~100 internal nodes is a few microseconds. Recycled
   mutable coordinate objects handed out to a caller is exactly the sort of
   cleverness that produces a bug nobody can reproduce, and there is no
   measurement suggesting it is needed. Revisit if the frame budget ever says
   otherwise -- on hardware, not in this container.

7. **Distance is horizontal, ignoring camera altitude.** 3D distance to a node
   centre placed at y=0 looks more principled and behaves worse: standing on a
   300 m peak would push the ground under your own feet to lod 2. Node count is
   bounded identically either way, so the horizontal form costs nothing.

8. **The camera's near plane moved 0.1 -> 0.5 m along with far 4000 -> 8000.**
   4 km of view distance needs the far plane or the outer ring is generated and
   then clipped, which costs everything and shows nothing. Leaving near at 0.1
   would have made the depth ratio 80,000:1, which is where two overlapping
   nodes start to z-fight during a transition; 0.5 keeps it at 16,000:1.

9. **`cancelled` is finally non-zero in a live run.** Phases 1 and 2a both
   recorded that the cancellation path never fired, because a uniform disc only
   invalidates work at its rim. A quadtree invalidates it everywhere, every time
   a node changes level, and the soak now shows real cancellations. There is
   also a unit test that asserts a split produces them.

10. **`chunk payload bytes` was the one budget that had to be tightened rather
    than scaled.** It is structurally capped -- LRU cap 512 over a resident set
    of ~300, at 74,676 bytes a node -- so its real ceiling is about 61 MB and
    Phase 2a's 96 MB limit was unreachable. A budget that cannot fire is not a
    budget; 76 MB sits above the worst plausible transient and below anything a
    per-node size regression would produce.

### Known gaps, deliberately left

- **Popping is quantified but UNOBSERVED.** 2-8 px of worst-case screen-space
  error at a switch (table above). This container renders at 1-7 fps, so a
  transition in motion could not be watched; the number is measured, the
  perceptual verdict is not. Fixing it properly means geomorphing or a larger
  `SEGMENTS`, both out of scope.
- **A handful of grazing coarse leaves.** A node whose square touches the view
  circle at a single point is kept, so 2-8 nodes at lod 5 (2 km squares) can be
  resident with almost none of their area on screen. Harmless at this node
  count; a tighter cull would cost more arithmetic than the nodes cost.
- **No batching or merging of distant nodes.** Unnecessary at ~100 draw calls,
  and explicitly out of scope. It is the obvious lever if a later phase's
  content pushes draw calls back up.
- **Frustum culling only; no occlusion culling.** A node behind a mountain still
  costs a draw call. At ~100 calls this is not worth an occlusion query.
- **No water.** Phase 3. The 4 km horizon now makes the missing sea very obvious
  from `lod-horizon`, where basins read as dark silt to the skyline.
- **Lighting is still the Phase 0 placeholder.** Phase 10 replaces it; expect
  the baselines to move then.
- **The `chunks-aerial` pair is a weak parity canary now.** At a 4 km horizon
  the cube is about three pixels. `cube-default` is the real ground-parity view.
- The bundle is one 588 kB chunk plus a 6.9 kB worker. Vite still warns. Not
  worth splitting until Phase 12 sets an asset budget.

### For Phase 3

- `selectQuadtree` is where anything "how much world is resident" belongs. It
  takes no state; if water needs its own residency rule, give it its own
  selection rather than adding a mode to this one.
- A water surface has the same crack problem at level boundaries and the same
  answer: a skirt, generated in the worker, depending only on `(seed, coord)`.
  Do not stitch, for the reasons in `ARCHITECTURE.md`.
- `ChunkData` has room for a water field; adding one is expected (RULE 4 permits
  adding fields). Add its buffer to `chunkDataTransferables` or it gets
  structured-cloned, and bump `CHUNK_DATA_VERSION`.
- The soak's shallow leg is the budget that matters. If water adds a second draw
  call per node, draw calls double to ~200 and the soak's 200-call limit fires
  immediately -- that is intentional. Re-derive it with a stated number, do not
  just raise it.
- `?pos=`-style URLs are unchanged, but every existing canonical view now sees
  4 km. Water will move all fifteen baselines again.

---

## Phase 3a -- Sea level and shoreline (done)

The roadmap's Phase 3 bundled a sea plane, a soft shoreline, and rivers carved
into `sampleHeight` by flow accumulation on the Region heightfield. It was split
deliberately. **3a is the sea; 3b is the rivers.** This phase builds no rivers,
no flow accumulation, no `baseHeight`/`finalHeight`, and touches no Region-tier
code. It also builds no waves, normal maps, reflections, refraction, foam,
caustics, custom shaders, render targets or underwater camera treatment -- all
explicitly out of scope. **`contracts.ts` gained three fields to `ChunkData` and
nothing else changed shape** (RULE 4 permits adding fields).

### Built

- **`src/world/height-field.ts`** -- exports `SEA_LEVEL` (0). It was implicit
  before: `sampleHeight` returned negative values in basins and `surfaceColor`
  faded silt into sand near zero, with nothing connecting them. It lives with
  the height field rather than with the mesher because it is a property of the
  world; Phase 3b's rivers drain to it and Phase 8's swimming test is against it.
- **`src/world/chunk-gen.ts`** -- `surfaceColor`'s silt/sand/vegetation bands and
  the snow line are now offsets from `SEA_LEVEL` rather than bare literals. New:
  `waterColor(depth) -> [r, g, b, alpha]`, a pure function of one scalar, and
  `buildWaterSurface`, which emits a flat submesh at `SEA_LEVEL` over the part of
  a node whose ground is below it -- **or nothing at all**, for a node with no
  submerged ground.
- **`src/world/contracts.ts`** -- `waterPositions`, `waterColors` (rgbA, four
  components) and `waterIndices` on `ChunkData`, all three added to
  `chunkDataTransferables` and `chunkDataBytes`. `CHUNK_DATA_VERSION` 2 -> 3.
- **`src/world/chunk-mesh.ts`** -- the water submesh: a transparent,
  vertex-coloured `MeshLambertMaterial` with `depthWrite: false`, parented to the
  terrain mesh, carrying the same coordinate-derived `renderOrder`. Plus
  `hashChunkGeometry` (terrain + water buffers) and the `waterDrawsSinceReset`
  counter that the soak's anti-vacuity guard rests on.
- **`src/world/chunk-streamer.ts`** -- `waterNodes` / `waterTriangles` in
  `stats()`, a `water` HUD line, `sampleGeometryHashes` (was
  `samplePositionHashes`) and `sampleWaterTriangles`.
- **`src/app.ts`** -- `waterNodes` / `waterTriangles` / `waterDrawCalls` in
  `perfSnapshot`, a `water draws` HUD line, and `sampleChunkWater`.
- **`scripts/soak.mjs`** -- the flight moved over water, four water assertions,
  re-derived budgets, and the heap trend re-based (see below).
- **`scripts/lib/browser.mjs`** -- the readiness timeout raised 30 s -> 120 s.
- **`vite.config.ts`** -- a 60 s per-test timeout (see judgement call 8).
- Four new canonical views and 26 new unit tests (263 -> 289).

### Verified

All run on 2026-08-01 in the dev container, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | 289 passed, 14 files (263 -> 289)                                   |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 590.2 kB + an 8.3 kB worker chunk      |
| `npm run shots:check`    | all 19 views byte-identical, run **four** times (see below)         |
| `npm run verify:subpath` | app ready, zero failed requests, 3 workers from the nested mount, 256 nodes streamed |
| `npm run soak`           | 300s over water, unexplained heap trend **+3.62 MB/min**, **25/25 geometry hashes identical, water included** |

Full 5-minute soak, 45 m/s, seed `soak`, starting at `(-7000, 90, -3500)`,
shallow leg from t=150s:

```
heap     100.6 MB at t=0 -> 71.9 MB over land at t=145s -> 108.3 MB back at sea
         peak 117.9 MB (budget 400)
         raw trend +13.07 MB/min -- REPORTED ONLY, it tracks how much sea is in
         view, not a leak (judgement call 8)
         UNEXPLAINED trend +3.62 MB/min (limit 6); residual 20.7 -> 22.7 MB
nodes    live 288 min / 305.2 mean / 318 max
         315 selected at the end, lod [84 59 60 64 46 2 0], view distance 4096 m
         4162 generated, 3358 evicted, 489 cached
geometry 1,238,272 live triangles peak (budget 2,100,000)
         616,127 live vertices peak (budget 1,040,000)
         92.3 MB payload peak (budget 100 MB), 111,555 bytes per node
         292 draw calls peak (budget 500) -- 267 steep leg, 292 shallow leg
water    249 water nodes peak of 318 live; 434,558 water triangles peak
         93 water meshes DRAWN in a frame at peak (floor 30)
         199 peak draw calls with water excluded
         25/25 round-tripped chunks had sea in them
frames   978 drawn, worst 1166.6 ms, 941 over 20 ms
trip     out to x=-295 m and back to x=-5705 m; 25/25 geometry hashes identical
```

Live HUD at 1920x1080, settled, seed `hud-check`, over a coastline and inland:

```
                    over water          inland
draw calls          217                 86
water draws         68                  4
triangles           413,456             200,820
programs            3                   3
js heap             36.4 MB             31.7 MB
chunk mem           25.0 MB             22.7 MB
chunks              294 live            312 live
water               117 nodes / 156,630 tris    31 nodes / 19,256 tris
```

`programs` went 2 -> 3: the water material's `USE_COLOR_ALPHA` and transparency
defines compile a separate program from the terrain's. Expected, and the number
to watch if it ever starts climbing.

### What water costs, measured

The interesting number is not the total, it is the split. The soak now reports
draw calls with and without water in the same frame:

```
over open sea     292 draw calls  =  199 terrain  +  93 water   (soak, 1280x720)
over land          95 draw calls  =   91 terrain  +   4 water   (soak, 1280x720)
coastline         217 draw calls  =  149 terrain  +  68 water   (HUD, 1920x1080)
```

Per node, on a node that is entirely at sea (the worst case):

```
terrain   74,676 bytes   2,560 triangles   1,221 vertices
water     55,068 bytes   2,048 triangles   1,089 vertices   (+73.7% bytes)
total    129,744 bytes   4,608 triangles   2,310 vertices
```

An inland node is unchanged at 74,676 bytes and gets no water mesh at all. Ten of
the fifteen pre-existing canonical baselines changed and five did not -- the five
that did not are the views with no sea in them, which is the cheapest possible
confirmation that water is being emitted where the water is and nowhere else.

### Screenshots: ten of fifteen baselines changed, five did not, and four were added

Every change is explained by water appearing where the ground is below zero:

- `cube-default`, `cube-t0`, `cube-far`, `cube-wireframe` -- the default seed's
  origin sits at **h = -0.42 m**, on the edge of an inland sea. The default
  camera resolves to y = 1.8 (ground + 2.5), so it stands in ankle-deep water
  looking across a sand flat, and the cube at `sampleHeight(0,0) + 1` sits just
  above the surface with water washing over the ground behind it. This is now
  the closest-range shoreline test in the harness, at about two metres.
- `chunks-aerial`, `chunks-wireframe` -- straight down on that sea. The wireframe
  one is the clearest picture of the phase: the water grid is the terrain grid,
  it stops at the coastline, and the boundary is a smooth curve rather than a
  staircase of node squares.
- `chunks-aerial-seed-beta` -- seed `beta`'s origin is deep ocean, so this view
  is now almost entirely sea (40 distinct colours, still comfortably past the
  blank-frame guard). It became a **weakened canary**: it still differs from
  `chunks-aerial`, but it no longer shows a grid of distinct chunk colours, and
  a total seed-plumbing failure could shift a few pixels of blue and still pass
  it. **Superseded by `seed-canary-inland` (see below); retained unedited for
  history**, because editing a canonical viewpoint destroys the only record the
  harness has of what it used to show.
- `chunks-radius-edge`, `cube-seed-alpha`, `lod-rings-wireframe` -- a coastline
  entered the frame at the edge.
- **Unchanged, byte for byte:** `terrain-mountain-profile`,
  `terrain-wireframe-relief`, `lod-horizon`, `lod-ground-horizon`,
  `chunks-far-from-origin`. All five are inland.

The four new views:

- **`water-coast`** (`?time=3&pos=3000,150,1800&look=-90,-6`) -- a coastline 900 m
  east of a headland with open sea beyond. The view that says the sea exists and
  is in the right place. No canonical view before this one framed a shoreline at
  all, so a phase that stopped emitting water entirely would have moved a few
  pixels of colour and passed.
- **`water-shoreline-shallow`** (`?time=3&pos=3900,5.5,1800&look=-90,-3`) -- the
  shallow-pitch one. Standing on the beach 5.5 m above sea level, 3 degrees below
  the horizon, waterline a few metres away. A grazing angle stretches a
  one-metre depth band across hundreds of pixels, which is exactly where a hard
  intersection would show; it is where the depth-derived alpha earns its place.
- **`water-bay-aerial`** (`?time=3&pos=3400,800,1800&look=-90,-30`) -- the whole
  bay from 800 m, where the depth shading is the subject. A flat, uniformly
  coloured sea passes `water-coast` and fails here.
- **`water-bay-wireframe`** -- the same bay in wireframe: which nodes carry water
  at all. That discipline is what the entire draw-call budget rests on and it is
  invisible in every shaded view.

All nineteen were inspected by eye before being committed. **I looked
specifically for a hard intersection line along the shore** in `water-coast`,
`water-shoreline-shallow`, `cube-default` and `chunks-aerial`, and at four
further exploratory angles not kept as baselines (1, 2, 3 and 6 degrees below
the horizon, from 5 m and from 150 m). There is none at any of them: the sand
fades continuously through turquoise into navy. **I also looked for square holes
in the sea** -- a node that failed to emit water -- in `water-bay-aerial`,
`chunks-aerial` and `lod-rings-wireframe`, and for water stopping short at a
level boundary. None.

### `shots:check` stability, honestly

Six runs against the new baselines: **five passes and one failure.** Precisely:

| run | result |
| --- | ------ |
| 1   | pass -- all 19 byte-identical |
| 2   | pass -- all 19 byte-identical |
| 3   | **FAILED** -- `page.waitForFunction` timeout at 30 s waiting for `window.__worldReady` on the first view |
| 3'  | pass, after raising the readiness timeout to 120 s |
| 4   | pass |
| 5   | pass, after the final `hashChunkGeometry` tidy-up |

Be precise about that failure, because "flaky screenshot harness" is exactly the
thing this project cannot afford to wave away. **No image was compared** -- the
run died before the first capture. It was not a pixel difference and not an
ordering flake; it was a wall-clock timeout on a container that had just run two
back-to-back full capture suites. Water raised a coastal view's payload by about
40%, and 30 s was already a thin allowance for a software rasteriser streaming
~300 nodes. The readiness timeout is now 120 s, which loosens nothing: waiting on
readiness is what makes the byte comparison meaningful in the first place, and a
harness that goes red under load teaches people to re-run until green.

Five byte-identical passes is evidence, not proof, and I did not observe a single
pixel of difference in any of them.

**Transparency did not reintroduce the Phase 1 ordering flake**, because it was
pre-empted rather than discovered. Three sorts transparent draws by
`renderOrder`, then view depth, then *object id* -- construction order, i.e.
whichever worker finished first -- and a perfectly flat surface makes depth ties
easy to arrange. The water mesh therefore carries the same coordinate-derived
`renderOrder` the terrain has had since Phase 1. Four clean runs is evidence, not
proof; if a wireframe or water view ever goes intermittent, that is the first
place to look.

### Budgets

| Budget                         | Status                                                    |
| ------------------------------ | --------------------------------------------------------- |
| <=1200 draw calls              | **Met.** 292 peak over open sea, 95 over land.             |
| <=400MB heap after 5 minutes   | **Met.** 117.9 MB peak, unexplained trend +3.62 MB/min.    |
| live triangles <=2,100,000     | **Met.** 1,238,272 peak. Re-derived this phase.            |
| live vertices <=1,040,000      | **Met.** 616,127 peak. Re-derived this phase.              |
| chunk payload <=100 MB         | **Met.** 92.3 MB peak. Re-derived this phase.              |
| clean shoreline at all angles  | **Met**, by inspection at six pitches. See above.          |
| `sampleHeight` worker parity   | **Met.** Exact, function to function; float32-aware against stored vertices. Unchanged from 2a. |
| byte-identical regeneration    | **Met.** 25/25 geometry hashes, water included.            |
| 60fps at 1080p                 | **UNVERIFIED.** 1-7 fps at 1280x720 under SwiftShader.     |
| <=16ms frame, no >4ms GC spike | **UNVERIFIED.** Worst frame 1600 ms under SwiftShader.     |

The last two are recorded as unverified, not as passed, exactly as Phases 1, 2a
and 2b did. This container has no GPU and every timing comes from a software
rasteriser now filling a 1080p frame with a transparent surface over half of it,
which is the single worst case for a software rasteriser. The 2a hardware
profile (Intel Arc 140V: 1.46 ms median GPU render for the whole scene) suggests
292 draw calls and ~1.2M live triangles will not trouble it, but that is an
inference and the user should re-check on hardware.

**All four Phase 2b geometry budgets were breached, on purpose.** 2b wrote down
in advance that water adding a second draw call per node would double draw calls
and fire the 200-call limit, and that the correct response was to re-derive with
a stated number rather than raise it quietly. The re-derivation and its headroom
are in the table in `ARCHITECTURE.md`.

### Judgement calls worth knowing about

1. **The water grid is the terrain grid, at full `SEGMENTS` resolution, and the
   obvious optimisation is wrong.** A flat surface plainly does not need 2 m
   vertices, and an 8x8 or 16x16 water grid would cut the water payload by 16x or
   4x. It was designed, costed and rejected, because of what "covers the part
   below sea level" has to mean to be artefact-free. A quad is emitted when any
   of its four corners is below sea level; the rendered terrain inside a quad is
   the linear interpolation of those same four corners; so that test is exactly
   "rendered ground dips below the sea here", and two properties fall out:
   **no ground that renders below sea level is left uncovered**, and **every
   emitted quad has a submerged corner and therefore non-zero alpha somewhere.**
   A coarser grid keeps the first and breaks the second -- a wet cell whose four
   corners are all on dry land shades to alpha 0 at every corner and renders as a
   patch of bare sea floor, up to 512 m across at lod 6. Every repair for that
   was worse: a minimum depth per wet cell puts a visible alpha step back at the
   shore, and a minimum-over-window depth makes a border vertex's colour depend
   on which side of the chunk boundary you computed it from, which is a seam
   along every node edge in the world. Full resolution is the boring option and
   the only exact one.

2. **Alpha is exactly zero at zero depth, and that is the whole shoreline
   treatment.** `WATER_ALPHA_MAX * sqrt(depth / WATER_ALPHA_FULL_DEPTH)`. The
   square root is there because real shallow water darkens fast in the first
   metre or two and then hardly at all; it is also IEEE-exact, unlike `exp`, so
   it is allowed on the path to a stored vertex. Reaching zero rather than some
   small floor is the part that matters: the sea fades out as the floor rises to
   meet it, so there is no line for the eye to catch and no alpha-blended speckle
   along the intersection curve where two surfaces' depths disagree in the last
   bits. It also makes the water grid's overhang harmless -- where the ground is
   above sea level the water is both occluded and transparent.

3. **No skirt on the water, and that is a consequence rather than an omission.**
   Terrain cracks at a level boundary because two nodes sample a *curved* surface
   at different rates. The water surface is the plane `y = SEA_LEVEL` at every
   level, so neighbours agree on their shared edge exactly. There is a unit test
   asserting every water vertex is at exactly `SEA_LEVEL` at lods 0, 1 and 3, so
   the day someone gives the sea a wave the missing skirt fails loudly.

4. **The water mesh is parented to the terrain mesh.** The streamer adds,
   removes, caches and disposes chunk meshes in five places; parenting means all
   five carry the water with them and none of them had to learn that water
   exists. Frustum culling is unaffected -- Three projects children whether or not
   the parent survived the cull -- and the water gets its own tight bounding box
   from the vertices actually emitted, so a node with one submerged corner does
   not claim a node-sized sheet of sea.

5. **`DoubleSide` is safe here and was not in Phase 2b.** The skirt broke under
   `DoubleSide` because two same-level neighbours put coincident aprons in one
   plane and a lit front face z-fought a normal-flipped black back face. Water
   has no coincident partner: adjacent nodes abut, they do not overlap. The only
   thing double-siding changes is that a camera below sea level sees the
   underside of the sea instead of seeing straight through it into the sky.

6. **The water normal is built on the main thread, not shipped.** Every water
   normal is +Y. Sending 1,089 copies of a constant through `postMessage` for
   every coastal node would be pure redundancy in the payload budget -- the one
   budget this phase is actually near. Same heap either way; nothing crosses the
   worker boundary.

7. **The soak flight had to move, and this was the sharpest vacuity trap the
   project has hit.** The autopilot flies along X from a fixed start, and on seed
   `soak` the line `z = 0` is dry for all 6.75 km of it. Every water assertion
   this phase added -- water generated, water drawn, water byte-identical after a
   round trip -- would have passed by never encountering any sea, and the phase
   would have shipped green having verified nothing. The start moved to
   `(-7000, -3500)`: 3.5 km of open water, a coastline at x = -3400, mountains
   beyond it, and a 5x5 square of submerged lod-0 chunks around the start so the
   round-trip hash is a statement about water. Four assertions turn that from an
   intention into a check: **no water generated**, **no water drawn**, **no water
   drawn on the shallow leg**, and **no water in the round-tripped chunks** are
   each a failure. `waterDrawCalls` comes from `Object3D.onBeforeRender`, so it
   measures rasterisation rather than residency -- a world full of sea with the
   camera pointed at a mountain does not count.

   Moving the start also broke an existing guard that tested *absolute* camera X
   against a distance threshold. It now tests distance travelled, which is what
   it always meant.

8. **The heap trend is fitted on heap MINUS chunk payload, and the first run of
   this phase is why.** Water made the resident payload depend on where the
   camera is: a node at sea costs 74% more than an inland one. On a flight that
   starts at sea, crosses a coast and comes back, the raw heap is a V, and a
   least-squares line through a V whose warm-up window clips one arm reported
   **+13.30 MB/min** on a run whose heap ended 8 MB above where it started after
   13.5 km. Nothing was wrong with the window -- the cache-saturation anchoring
   from after 2a is preserved untouched -- the quantity was wrong. A leak is heap
   the streamer is not knowingly holding, so that is what gets the trend line,
   while the payload keeps its own hard budget and a per-node figure in the
   report. This is a **stronger** detector, not a weaker one: a retained mesh
   whose cache entry has already been evicted -- precisely what explicit disposal
   exists to prevent -- leaves the streamer's byte count and stays in the heap,
   so it shows up here and in nothing else. The raw trend is still printed.

   **The residual is not fully immune to the route, and the margin is thinner
   than it looks.** It measured +3.62 MB/min against a 6 MB/min limit -- a 1.66x
   margin -- while the residual's own endpoints moved only 20.7 -> 22.7 MB across
   13.5 km, i.e. +0.4 MB/min. The gap is the same V-shape artefact, attenuated
   about four-fold: per-frame transient allocation scales with how much is
   streaming, and streaming is heaviest over the sea. If a later phase's route is
   more lopsided than this one, expect to have to fit the trend over a whole
   number of flight legs rather than over "everything after warm-up".

9. **`vitest` got a 60 s per-test timeout.** Two streaming tests time out at
   vitest's 5 s default on this container -- **including on the unmodified Phase
   2b commit**, which I checked by stashing. They drive a synchronous fake worker
   through hundreds of real chunk generations inside a single `it`, and Phase 3a
   made each generation slightly more expensive. A test that fails on a busy
   machine teaches people to re-run until green, which is worse than a slow
   suite. It is a type-only `/// <reference types="vitest/config" />` in
   `vite.config.ts` rather than an import, so a production `vite build` does not
   depend on a dev dependency resolving.

10. **`positionsHash` became `geometryHash` and folds the water buffers in.**
    Leaving water out would have let the RULE 2 round-trip check keep passing
    while the sea came back a different shape -- and Phase 3b is about to start
    cutting channels through exactly this ground. `waterPositions` is what
    encodes which cells the shoreline covered; `waterColors` is what encodes how
    deep it thought they were.

11. **Water is a `MeshLambertMaterial`, like the terrain.** Unlit would have been
    cheaper and would have made the on-screen colour exactly what
    `waterColor(depth)` returned, which is tempting for testability. It was
    rejected because the sea would then need its brightness pre-multiplied by an
    assumed light level -- a second, hidden copy of the lighting model, which is
    the same mistake as a second copy of `sampleHeight`. Being flat, Lambert
    applies one constant factor over the whole world, and Phase 10 gets to change
    the light and have the sea follow.

12. **Sea level is 0, deliberately not a tuning knob.** The brief said sea level
    was implicit at height 0, so `SEA_LEVEL = 0` moves no terrain and no
    baseline. Everything now reads it, and a unit test pins both halves of what
    "shared" means: the palette's silt and sand bands land at exactly
    `SEA_LEVEL - 14` and `SEA_LEVEL + 1`, and `waterColor(0)` has alpha exactly
    0 with every water vertex at exactly `SEA_LEVEL`. Changing the constant moves
    the coastline coherently and moves every committed baseline with it.

### Known gaps, deliberately left

- **No rivers.** Phase 3b. The shoreline they need to flow into is here:
  `SEA_LEVEL` is the drain, the water surface already covers everything below it,
  and a river channel cut into `sampleHeight` will grow its own estuary for free.
- **An underwater camera sees a dark ceiling and no surface detail.** Explicitly
  out of scope. `DoubleSide` means you at least see the underside of the sea
  rather than the sky; there is no tint, no fog and no caustics. The one place
  this is reachable by accident is the default seed's origin, where the ground is
  0.42 m below sea level -- but the default camera resolves to y = 1.8, above it.
- **The sea is glass-flat and unmoving.** No waves, no normal map, no
  reflections, no refraction, no foam, no caustics, no shoreline wet-sand
  darkening. All out of scope, all Phase 11 or later. The material is
  deliberately dumb enough to be replaced outright.
- **Water is transparent but casts and receives nothing.** Lighting is still the
  Phase 0 placeholder; Phase 10 replaces it and the baselines will move again.
- **`chunk payload bytes` has only 1.08x headroom** and cannot honestly have
  more -- see the table in `ARCHITECTURE.md`. A flight spending its whole length
  over open ocean rather than half of it would legitimately approach it.
- **The leak check now runs at a 1.66x margin** (+3.62 MB/min against 6), for
  route reasons rather than leak reasons -- judgement call 8. It is the thinnest
  margin of any hard budget in the project and it is the one to fix first if a
  later phase makes it fire.
- **The seed canary was rebuilt after 3a weakened it.** `chunks-aerial-seed-beta`
  degraded into a nearly featureless blue field once sea level existed, because
  seed `beta`'s origin is deep ocean. `seed-canary-inland` replaces it in that
  role: `?seed=beta&pos=4000,600,4500&look=0,-72`, a position chosen by searching
  the height field for ground that is dry with real relief on **both** the
  default seed and `beta`. Their height ranges there do not overlap at all
  (default 15-120 m, beta 107-232 m), so the two seeds could never be confused,
  and the view carries 88 distinct colours of terrain structure against the old
  one's 40 of flat sea. The old view is kept unedited for history.

  This is the fifth time this project has caught a check that kept passing after
  it stopped proving anything -- after the blank screenshots in Phase 0, the
  soak's false leak alarm in 2a, the unfireable draw-call budget before 2b, and
  the dry soak route in 3a. Worth re-reading the canonical `expect` strings at
  the start of every phase, not just when something fails.
- **Popping at a level switch is still quantified but unobserved**, unchanged
  from 2b, and water does not make it worse: the water surface is at the same
  height at every level, so a switch moves no water vertex at all.
- The bundle is one 590 kB chunk plus an 8.3 kB worker. Vite still warns. Not
  worth splitting until Phase 12 sets an asset budget.

### For Phase 3b

- `SEA_LEVEL` is exported from `height-field.ts` and read by the surface palette
  and the water surface. A river carved into `sampleHeight` gets its water
  surface for free wherever the channel drops below it -- but only there, so an
  inland river above sea level will need its own surface, and that is a decision
  3b has to make rather than inherit.
- `buildWaterSurface` in `chunk-gen.ts` is a pure function of the node's padded
  height grid. If 3b changes `sampleHeight`, the water follows automatically and
  the water tests will fail with clear reasons if the three fixture chunks on
  seed 99 stop being dry / part-submerged / fully submerged.
- **Every geometry budget was just re-derived and is the number to beat.** River
  channels lower ground below sea level near the coast, which turns dry nodes
  into water-bearing ones and adds draw calls. Watch `draws without it` in the
  soak report -- it isolates the terrain half.
- The soak's flight start (`START_X` / `START_Z` in `scripts/soak.mjs`) is chosen
  for the water it crosses. If 3b needs it to cross a river as well, move it
  deliberately and add the matching anti-vacuity assertion; do not assume the
  path goes anywhere interesting.
- `ChunkData` now has seven bulk buffers. Anything Phase 3b adds goes in
  `chunkDataTransferables` AND `chunkDataBytes`, and `chunk-gen.test.ts` asserts
  the list length -- update the number rather than the assertion.

---

## Phase 3b -- Rivers (done)

The second half of the roadmap's Phase 3, and **the first phase that uses the
tier system for anything.** 3a was the sea; 3b is flow accumulation on the
Region heightfield, a channel carved into `sampleHeight`, and the
`baseHeight` / `finalHeight` layering that Phase 4's roads will slot into.

No roads, no settlements, no separate lake bodies, no waves, no custom shaders,
no render targets, no post-processing. **`contracts.ts` gained exactly one
field -- a scalar on `ChunkData` -- and a version bump; nothing changed shape**
(RULE 4 permits adding fields). `ChunkCoord`, `ChunkProvider` and `TierContext`
are untouched, which is what the tier system was declared for in Phase 1.

### Why this phase mattered more than it looks

Three things had been documented since Phase 1 and never exercised:
`TierContext.coarser()` was called only from its own unit tests, `REGION_SIZE`
was a constant nothing read, and RULE 3 was a paragraph. Rivers are the first
content that spans chunks -- a river is hundreds of chunks long -- so they are
the first content that *has* to be decided at a tier that contains it.

### Built

- **`src/world/rivers.ts`** (new, ~730 lines) -- the Region tier. Priority-flood
  to a depression-less surface, D8 flow direction, flow accumulation, a
  threshold into channel nodes and segments, a monotonic water-surface profile,
  a spatial index, and the carve. Plus the bounded memo. It imports
  `contracts.ts` and `noise.ts` and **nothing else** -- in particular not
  `height-field.ts` (see judgement call 1).
- **`src/world/height-field.ts`** -- `sampleHeight`'s Phase 3a body renamed
  `baseHeight`; `sampleHeight` is now `baseHeight - riverDrop(...)`. Same name,
  same signature, same callers. `MIN_HEIGHT` drops by `RIVER_MAX_CUT`. New
  `worldRiverField(worldSeed)`, the Region-tier record a chunk generator reads.
- **`src/world/chunk-gen.ts`** -- `chunkTierContext(worldSeed)` builds a chunk
  context **with** its region record; `generateChunk` reads it through
  `coarser('region')` and **throws** if it is missing or belongs to another
  seed. Vertex heights are `base - drop` spelled out, so the carve depth is
  available for `riverVertices` without a second `baseHeight` evaluation.
- **`src/world/contracts.ts`** -- `ChunkData.riverVertices` (a scalar, so the
  transfer list is untouched), `CHUNK_DATA_VERSION` 3 -> 4.
- **`src/world/chunk-mesh.ts`** -- `riverDrawsSinceReset` / `resetRiverDraws`
  and an `onBeforeRender` counter on nodes that actually carry carved ground.
  Exactly the Phase 3a water pattern, for exactly the same reason.
- **`src/world/chunk-streamer.ts`** -- `riverNodes` / `riverVertices` in
  `stats()`, a `rivers` HUD line, `sampleRiverVertices`.
- **`src/app.ts`** -- `riverNodes` / `riverVertices` / `riverDrawCalls` in
  `perfSnapshot`, a `river draws` HUD line, `sampleChunkRivers`.
- **`src/world/chunk-worker.ts`** -- builds the context with
  `chunkTierContext`. Still stateless per message.
- **`scripts/soak.mjs`** -- five river assertions and a river report block.
- **`src/world/rivers.test.ts`** (new, 32 tests) plus additions to
  `chunk-gen.test.ts` (+6) and `height-field.test.ts` (+7). 289 -> 334.
- Five new canonical views.

### The layering, which is the part Phase 4 inherits

```
baseHeight()    pure terrain, exactly Phase 3a's sampleHeight body.
                The ONLY thing river routing may read.
sampleHeight()  baseHeight blended toward the carved channel profile.
                What EVERYTHING downstream reads.
```

Rivers carve terrain but are routed *from* terrain. If routing read its own
output the network would depend on how many times it had been evaluated, and
RULE 1 would be gone. `rivers.ts` therefore takes the base sampler as a
`RiverTerrain` argument rather than importing `height-field.ts`, which makes the
dependency acyclic and puts the rule in the type system instead of in a comment.

`sampleHeight` kept its name and signature, so every existing caller -- chunk
vertices, normals, the water surface, `cube.ts`, the camera's ground-relative
default Y, the parity tests -- sees rivers without a single edit.

### The algorithm, and its numbers

Per region, on a **global** 64 m lattice covering the region plus 1,536 m of
margin: 112 x 112 = 12,544 `baseHeight` samples, **54-59 ms**.

1. sample `baseHeight`;
2. priority-flood (min-heap, ties broken by cell index) to a depression-less
   surface, so every cell drains somewhere;
3. D8 steepest descent on the filled surface, with the flood's own discovery
   edges as the fallback on flats -- both edge kinds strictly decrease
   `(filled, pop order)`, so the union is acyclic and one forward pass over the
   pop order is a valid downstream-first traversal;
4. accumulate;
5. threshold at `RIVER_HEAD_ACCUM` = 150 cells (0.6 km^2) into nodes and
   segments -- about **400-500 nodes per region window**, 150-210 of them at
   strength above 0.5;
6. a profile `waterY = max(waterY[downstream], base)`, monotonically
   non-increasing downstream.

The carve blends terrain toward `waterY - depth` inside a bank of
`12 + strength * 32` metres, `strength = sqrt((accum - 150) / 1250)` clamped,
depth up to 20 m, total cut capped at 45 m.

What that costs the world, measured over 12 km x 12 km on two seeds:

```
dry land carved >= 0.25 m   4.6%        >= 1 m  3.7%   >= 4 m  2.0%   >= 10 m  0.4%
mean cut over dry land      0.20 m
dry ground newly submerged  0.56%       (estuaries -- these become water nodes)
sea floor carved >= 1 m     11.5%       (drowned channels; invisible under the sea)
```

That is a river network, not a global smoothing filter, and it is the number to
watch if a later phase widens the bank.

### Region-boundary continuity, and its limits

**The chosen scheme.** Three things together, and all three are needed:

1. **The routing lattice is global**, not per-region: cell index is
   `floor(world / 64)`. Two neighbouring regions therefore sample the identical
   points, get identical `baseHeight`, and compute **identical flow
   directions**. The *path* of a river is continuous across a boundary by
   construction; only its *size* can disagree.
2. **Each region routes on a window padded 1,536 m beyond its own square**, so a
   cell on a region's edge still sees 1.5 km of its upstream catchment.
3. **A point takes the maximum influence over every region within `RIVER_BLEND`
   (768 m) of it**, each weighted by a factor that is exactly 1 over the
   region's own square, exactly 1 for *both* regions on a shared boundary, and
   exactly **0** where a region stops being consulted. A region contributes
   nothing at the moment it drops out, so the combined field is continuous
   everywhere; and in the overlap band the region with more of the catchment
   wins.

**`RIVER_PAD` (1,536 m) and `RIVER_BLEND` (768 m) are deliberately different
numbers.** The pad is how much catchment a region gets to *see*; the blend is
how far its answer is allowed to *reach*. The first version made them equal,
which meant 56% of the world consulted four region networks per vertex and the
carve cost **7.1 us a call** near a four-region corner against 1.6 us mid-region.
Halving the blend changed no drainage at all -- every region still routes on the
full 1,536 m -- and dropped the four-region case to about 14% of the world:
**3.8 us at the corner, 0.18 us mid-region.**

**Measured seam, three seeds.** Worst 2 m height step (2 m is the lod-0 vertex
spacing, so this is exactly the step a rendered triangle would have to draw) on
lines crossing `x = 4096`, against the same measure taken in the middle of a
region:

| seed             | at the boundary | mid-region control |
| ---------------- | --------------- | ------------------ |
| `infinite-world` | 1.591 m         | 1.851 m            |
| `soak`           | 1.779 m         | 1.865 m            |
| `beta`           | 2.068 m         | 1.550 m            |

Crossing a region boundary is not a different *kind* of event from crossing
ordinary ground. `rivers.test.ts` asserts this numerically and
`shots/river-region-seam.png` is the visual corroboration.

**The limit, stated plainly.** Accumulation is still truncated at the padded
window edge, so a river whose catchment reaches more than 1,536 m past a
boundary is under-measured by the region it flows *into*. Because the field is
continuous and combined by max, that shows as a channel slightly **shallower**
for a stretch, never one that stops. The case this cannot fix: a river whose
entire catchment lies more than 1.5 km outside the region it enters **and**
whose accumulation is near the head threshold -- the downstream region may not
see it as a channel at all, and the upstream region's contribution fades out
768 m past the boundary. That is a channel tapering to nothing over ~800 m, not
a hard edge. Fixing it properly means a second, coarser accumulation pass over a
multi-region window, which is a Phase 4-or-later trade.

### Verified

All run on 2026-08-01 in the dev container, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | **334 passed, 15 files** (289 -> 334)                               |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 597.0 kB + a 14.3 kB worker chunk      |
| `npm run shots:check`    | all 25 views byte-identical, run twice                              |
| `npm run verify:subpath` | app ready, zero failed requests, 3 workers from the nested mount, 256 nodes streamed |
| `npm run soak`           | 300s, unexplained heap trend **+2.83 MB/min**, **25/25 geometry hashes identical, water AND rivers included** |

Full 5-minute soak, 45 m/s, seed `soak`, from `(-7000, 90, -3500)`:

```
heap     72.0 MB at t=0 -> 119.6 MB peak -> 109.5 MB at t=300s
         raw trend +10.84 MB/min -- REPORTED ONLY (tracks how much sea is in view)
         UNEXPLAINED trend +2.83 MB/min (limit 6); residual 15.8 -> 23.3 MB
nodes    live 292 min / 305.5 mean / 318 max; 307 selected at the end
         lod [80 64 59 56 46 2 0], view distance 4096 m
         4170 generated, 20 cancelled, 3361 evicted, 502 cached
geometry 1,225,890 live triangles peak (budget 2,100,000)
         610,035 live vertices peak (budget 1,040,000)
         92.9 MB payload peak (budget 100 MB), 111,773 bytes per node
         288 draw calls peak (budget 500) -- 288 steep leg, 279 shallow leg
water    252 water nodes peak of 318 live; 435,586 water triangles peak
         92 water meshes DRAWN at peak (floor 30); 196 peak draws without water
         25/25 round-tripped chunks had sea in them
rivers   160 carved nodes peak of 318 live (floor 60)
         47,043 carved vertices peak
         59 carved meshes DRAWN at peak (floor 20); 59 on the shallow leg
         12/25 round-tripped chunks were carved by a river
frames   1337 drawn, worst 799.9 ms, 1244 over 20 ms
trip     out to x=-263 m and back to x=-6308 m; 25/25 geometry hashes identical
```

The steep leg peaked *above* the shallow leg this run (288 against 279), the
first time in three phases. It is a 3% difference on a route whose outbound
pitch of -18 degrees was already close enough to the horizon to reach the 4 km
rim -- Phase 2b measured 105 against 106 for the same reason. The shallow leg's
55-call floor still fires if a future change tips the canary back toward nadir.

**The leak margin, which is the tightest budget in the project.** 3a ran at
+3.62 MB/min against a limit of 6 -- a 1.66x margin. 3b measures **+2.83 MB/min,
a 2.12x margin**, despite adding a 16-entry region-network cache per JS context
(~1 MB when full). Two full runs of this phase measured +2.45 and +2.83, so
treat 2.1x as the number and the spread as the same route-sensitivity 3a
documented in its judgement call 8 -- not as headroom that has been won. It is
still the budget to fix first if a later phase makes it fire.

**Rivers cost no draw calls.** 288 peak against 3a's 292, and 279 on the shallow
leg against 292 -- flat to slightly down, because carving lives in the terrain
mesh every node already had. The only mechanism by which rivers *can* add draw
calls is an estuary turning a dry node into a water-bearing one, and 0.56% of
dry ground going under is not enough to show. Triangles and vertices are within
1% of 3a. The four geometry budgets are therefore **left exactly as 3a derived
them**; there is nothing to re-derive.

### Generation cost, before and after carving

Measured in the dev container, memo warm, seed `soak`:

```
baseHeight                       2.95 - 4.45 us per call   (= Phase 3a's cost)
riverDrop, mid-region            0.18 us per call
riverDrop, four-region corner    3.81 us per call          (worst case, ~14% of the world)
generateChunk, memo warm         10.2 - 10.4 ms per node   (Phase 2a recorded "~10 ms")
region routing, cold             54 - 59 ms per 4 km region window, ONCE per (seed, region)
```

The memo is what makes this affordable: ~1,300 height samples per node would
otherwise trigger 1,300 flow-accumulation passes. With it, steady-state node
generation is within noise of Phase 3a's, and the routing shows up as a
one-off 54 ms per region per worker -- about 500 ms of start-up per worker for
the 9 regions a 4 km view distance can touch.

**One consequence worth knowing: the first `sampleHeight` call on a new seed
routes a region synchronously on the main thread**, in the `App` constructor,
seating the cube and resolving the default camera Y. That is one 54 ms hitch
before the first frame, not per frame and not per chunk. It is the only place
the "no generation on the main thread" rule is bent, and it was already bent --
`sampleHeight` has been called there since Phase 2a.

### Budgets

| Budget                         | Status                                                    |
| ------------------------------ | --------------------------------------------------------- |
| <=1200 draw calls              | **Met.** 288 peak over open sea (3a: 292).                 |
| <=400MB heap after 5 minutes   | **Met.** 119.6 MB peak, unexplained trend +2.83 MB/min.    |
| live triangles <=2,100,000     | **Met.** 1,225,890 peak. Budget unchanged from 3a.         |
| live vertices <=1,040,000      | **Met.** 610,035 peak. Budget unchanged from 3a.           |
| chunk payload <=100 MB         | **Met.** 92.9 MB peak. Budget unchanged from 3a, 1.08x.    |
| rivers reach the sea           | **Met.** Numerically in `rivers.test.ts` (a chain is walked downstream to a node below `SEA_LEVEL`), and by eye in `river-to-the-sea`. |
| no seam at a Region boundary   | **Met.** Table above; `river-region-seam` by eye.          |
| `sampleHeight` worker parity   | **Met. Exact.** Function-to-function `===`, unchanged from 2a; float32-aware against stored vertices. |
| byte-identical regeneration    | **Met.** 25/25 geometry hashes, water and carved ground included. |
| 60fps at 1080p                 | **UNVERIFIED.** 1.6-4.4 fps at 1280x720 under SwiftShader. |
| <=16ms frame, no >4ms GC spike | **UNVERIFIED.** Worst frame 799.9 ms under SwiftShader.    |

The last two are recorded as unverified, not as passed, exactly as Phases 1, 2a,
2b and 3a did. This container has no GPU. Someone with one should open
`?pos=5024,60,6100&look=0,-6` at 1080p and read the HUD.

### Before and after, same viewpoint, same machine

Phase 3a was checked out into a worktree and built, so this is a direct
comparison rather than a recollection. `?pos=928,220,5008&look=0,-16` on the
default seed at 1280x720 -- the `river-valley` framing:

```
                   Phase 3a          Phase 3b
draw calls              100               105
triangles           248,468           257,324
programs                  4                 4     (unchanged; 3a already 4 here)
chunk geo     752,240 tris      780,044 tris
              359,631 verts     373,473 verts
water          14 nodes /        21 nodes /
                9,840 tris       14,604 tris
chunk mem           20.9 MB           21.7 MB
js heap             31.8 MB           32.2 MB
rivers                    -   106 nodes / 20,376 carved verts
river draws               -                38
```

The 3a capture of that frame is a featureless green slope; the 3b capture has a
river valley running the length of it. That is the whole phase in two images.
`programs` was already 4 at this viewpoint before the phase, so the extra
program 3a's notes mention is not a regression here.

### Screenshots: 19 of 20 baselines changed, one did not, and five were added

Every change is explained by ground that a river lowered. Measured as the
fraction of pixels that differ at all (and, in brackets, by more than 24/765):

```
chunks-aerial            29.4% (23.4%)   straight down on the origin's inland sea:
                                         a channel now runs through the shallows
chunks-wireframe         29.0% (21.2%)   the same, in wireframe
seed-canary-inland       13.8% ( 1.4%)   seed beta's uplands grew a drainage network
chunks-far-from-origin   13.1% (10.5%)   200 km out; rivers work there too
lod-rings-wireframe       7.8% ( 4.1%)
water-bay-aerial          5.9% ( 0.5%)   a channel joins the bay
cube-wireframe            5.9% ( 5.0%)
water-bay-wireframe       5.4% ( 3.1%)
chunks-radius-edge        2.3% ( 0.7%)
cube-far                  1.7% ( 0.8%)
water-coast               1.3% ( 0.1%)
lod-horizon               0.8% ( 0.0%)   distant creases only
water-shoreline-shallow   0.7% ( 0.0%)
cube-seed-alpha           0.4% ( 0.1%)
cube-default / cube-t0    0.3% ( 0.1%)   the cube is seated identically; the
                                         change is a channel at the far shore
lod-ground-horizon        0.1% ( 0.0%)
chunks-aerial-seed-beta   0.1% ( 0.0%)
terrain-wireframe-relief  0.0% ( 0.0%)
terrain-mountain-profile  BYTE-IDENTICAL -- no river within 4 km of that frame
```

`terrain-mountain-profile` coming back unchanged is the cheapest possible
confirmation that carving happens where rivers are and nowhere else.

**`cube-default` deserves a sentence of its own.** It is the parity canary: the
cube is seated with the MAIN-THREAD `sampleHeight` while the ground under it
comes from the worker. It moved 0.3% of pixels and the cube itself is in exactly
the same place, pixel for pixel, as the Phase 3a baseline. Main thread and
worker agree.

The five new views:

- **`river-valley`** (`?time=3&pos=928,220,5008&look=0,-16`) -- an inland dry
  channel at ~95 m elevation with tributaries joining it and the whole dendritic
  network of the surrounding hills visible as finer creases. A river network is
  a *tree*; a router that thresholded noise would produce disconnected
  scratches here.
- **`river-to-the-sea`** (`?time=3&pos=5024,319,6336&look=0,-16`) -- THE view of
  the phase. A full-strength river runs from the foreground through its own
  valley into the sea; the bed drops below `SEA_LEVEL` and the Phase 3a water
  surface takes over with no join and no river-specific rendering at all. Sand
  banks appear along the lower reaches because the palette's shore band is
  anchored to the same `SEA_LEVEL` the carve drains to.
- **`river-mouth-shallow`** (`?time=3&pos=5024,60,6100&look=0,-6`) -- the same
  river at 60 m and 6 degrees below the horizon. Every geometry budget is
  decided near the horizon, so the phase needs a river view at that pitch.
- **`river-mouth-wireframe`** -- the same mouth in wireframe. Shows the two
  things no shaded view can: the carve lives in the ordinary terrain lattice
  (no river mesh, no extra draw call), and the water grid follows the channel
  inland as a narrow ribbon and stops exactly where the ground rises.
- **`river-region-seam`** (`?time=3&pos=8192,560,9760&look=0,-89`) -- straight
  down onto the point where a strong river crosses `x = 8192`, a **region**
  boundary. The boundary is the vertical centre line of the frame; the channel
  crosses it diagonally and must show no change of width, depth or direction.
  Nothing else in the harness looks at a region boundary at all.

All 25 were inspected by eye before being committed. **I looked specifically
for: a straight-line discontinuity at the region boundary in `river-region-seam`
and at three further exploratory framings not kept as baselines; a channel that
stops at the coastline in `river-to-the-sea` and `river-mouth-shallow`; water
appearing over dry ground, or a channel the water failed to follow, in
`river-mouth-wireframe` and `water-bay-wireframe`; and the cube's seating in
`cube-default`.** None of them.

**`river-region-seam` is the lowest-contrast view in the set at 20 distinct
colours** (the blank-frame guard is 4, and `lod-ground-horizon` has 23). That is
inherent -- it is a nadir view of smooth green upland, which is precisely the
background against which a straight seam line would be unmissable. It is
corroboration, not the primary check: the primary check is the numeric
boundary-step table above, which is a unit test.

### Judgement calls worth knowing about

1. **`rivers.ts` does not import `height-field.ts`, and that is the whole
   layering.** It takes the pre-carve sampler as a `RiverTerrain` argument. The
   obvious alternative -- import `baseHeight` directly -- creates a cycle
   (`height-field -> rivers -> height-field`) that ES modules tolerate right up
   until someone writes a top-level `const` depending on the other module, and
   more importantly it hides the rule. Passing the sampler in states in the type
   system that routing sees the PRE-CARVE world. It also bought the synthetic
   tests: a V-shaped valley and a cone have exactly one right answer for "where
   does the water go", so the routing is *asserted* rather than described, with
   no noise in the way. The cone is the sharpest of them -- every flow line
   diverges, so the correct number of rivers is **zero**, and a router that
   thresholded noise instead of drainage would fail it.

2. **Priority flooding is not optional, and it is what "no river terminates in
   mid-air" actually means.** fBm on a 64 m lattice is full of local minima. A
   D8 router without depression filling walks a channel downhill until it finds
   one and stops, which is a ditch ending halfway up a hillside. Flooding first
   makes every cell drain to the window boundary, so within a region every
   channel either reaches ground below `SEA_LEVEL` or continues into the
   neighbouring region -- and the neighbour continues it, because both compute
   the same flow directions from the same global lattice. A unit test asserts
   every interior node has a downstream cell.

3. **The channel's water surface is `max(profile[downstream], base)`, and the
   two properties that fall out are both load-bearing.** It is monotonically
   non-increasing downstream, so a carved channel can never run uphill; and a
   chain that reaches ground below sea level *ends* below sea level, so the
   Phase 3a water surface covers the river's last stretch for free. That is why
   `river-to-the-sea` needed no river-specific rendering to build.

4. **The memo is a pure cache, it is bounded, and both halves are tested.**
   Sixteen region networks per JS context, promoted by **swapping with the entry
   in front** rather than by `splice` + `unshift` -- the lookup runs up to four
   times per vertex, i.e. ~5,000 times per node, and splice moves every element
   and allocates. The key comparison is four numeric fields plus a reference
   compare, deliberately not a template-string key: building a key string per
   call is ~1,200 short-lived strings per node, forever, on the hottest path in
   the codebase. There is a test that clears the cache and demands a
   byte-identical rebuild, one that evicts an entry twenty times over and
   demands it back unchanged, and one that asserts the entry count never exceeds
   the cap.

5. **`RIVER_PAD` and `RIVER_BLEND` were split after measuring.** See the
   region-boundary section. The short version: how much catchment a region sees
   and how far its answer reaches are different questions, and conflating them
   cost 4x on the carve path for no quality gain.

6. **`generateChunk` throws without region data rather than falling back.** It
   could have called `rivers.ts` itself and got an identical answer, because the
   memo is global -- and that is exactly the habit that makes a tier boundary
   decorative. Five call sites now build their context with
   `chunkTierContext(worldSeed)`; a bare `createTierContext(seed, 'chunk')` is a
   hard error with a message naming the fix. The region generator is
   symmetrically constrained: it is handed a `region` context, and nothing is
   coarser than a region, so **every** `coarser()` call from inside it throws.

7. **`ChunkData.riverVertices` is a scalar, and it exists for the anti-vacuity
   guard.** Water is its own submesh, so "was any sea drawn" is answerable by
   looking at the object list. A river is not a mesh -- it is a dent in the
   terrain mesh every node already had. Without a count, "the flight never went
   near a river" and "carving silently returns zero" produce identical evidence,
   and every river assertion in the soak would pass on either. Being a number
   rather than a buffer, it changes nothing about the transfer list.

8. **The soak flight did not move, and it did not need to.** 3a chose
   `(-7000, -3500)` on seed `soak` for the 3.5 km of open sea it crosses, and
   that line turns out to cross several drowned channels (cuts of 6-10 m on the
   sea floor) and carved valleys inland. Measured on the run: 160 carved nodes
   resident at peak, 59 carved meshes reaching the rasteriser, 59 of them on the
   shallow leg, and **12 of the 25 round-tripped chunks carved** -- so the
   byte-identical-regeneration check is a statement about rivers as well as
   about the sea. Five assertions turn that from an intention into a check.
   Moving the start would have re-based every Phase 3a water number for no gain.

9. **The carve is one-directional and capped.** `sampleHeight <= baseHeight`
   everywhere, asserted over 2,000 probes: carving that could *raise* ground
   could lift a sea floor out of the water and put Phase 3a's shoreline
   somewhere the mesh disagrees with. The 45 m cap exists because the profile is
   "blend the terrain toward the bed", and a channel at the foot of a cliff
   would otherwise cut the cliff down to the river. It is also what bounds
   `MIN_HEIGHT`.

10. **One height-field test was relaxed, deliberately and narrowly.** `does not
    depend on evaluation order or on unrelated work` used to do its "unrelated
    work" with 500 distinct seeds. A first call on a new seed now routes that
    seed's rivers, so that test became a three-minute test. It uses three other
    seeds now, which still evicts the region memo many times over and still
    demands the original answer back -- and `rivers.test.ts` tests eviction
    directly and much harder. No tolerance was widened anywhere.

### Known gaps, deliberately left

- **A river above sea level is a dry channel.** There is no inland water
  surface: the Phase 3a sea covers everything below `SEA_LEVEL` and nothing
  else, which is what the phase was scoped to. So a river reads as a carved
  valley inland and as water from wherever its bed drops below sea level --
  which on a coastal river is a long way up, but on an upland one is never.
  Giving inland rivers their own surface means a second water body whose height
  varies along its length, i.e. per-node water geometry that is no longer a
  plane; that is a phase, not a tweak.
- **No lakes.** A filled depression gets a flat `waterY`, and inside it the
  terrain is already below the bed so the carve does nothing -- correctly. It
  would take the same inland-water-surface machinery to render one.
- **The seam is continuous but the size is only approximately continuous.** See
  the limit stated above: a river fed entirely from more than 1.5 km outside the
  region it enters can taper rather than arrive at full width. Not observed in
  any of the framings looked at; it is a property of the algorithm, not a
  sighting.
- **The routing lattice is 64 m, so a channel's centreline is a polyline of
  64 m steps**, lightly smoothed toward its up- and downstream neighbours. At a
  30-90 m channel width that reads as meander; at a much narrower channel it
  would read as a staircase. `RIVER_CELL` is the knob, and halving it
  quadruples routing cost.
- **`Sector` is still unused.** Region and Chunk are now both real; Phase 4 is
  the phase that plausibly needs the middle tier.
- **The region memo is per JS context**, so three workers plus the main thread
  each route the same region independently. That is ~54 ms x 4 rather than
  x 1, paid once per region. Sharing it would mean shipping networks across
  `postMessage`, which is a cache-coherence problem for 200 kB of savings.
- **Popping at a level switch is still quantified but unobserved**, unchanged
  from 2b. Carving does not make it worse -- it is the same height field at
  every level.
- **Lighting is still the Phase 0 placeholder.** Phase 10 replaces it and the
  baselines will move again.
- The bundle is one 597 kB chunk plus a 14.3 kB worker (up from 8.3 kB: the
  worker now carries `rivers.ts`). Vite still warns. Not worth splitting until
  Phase 12 sets an asset budget.

### For Phase 4

- **`baseHeight` is the field roads must route on**, exactly as rivers do.
  Reading `sampleHeight` would make roads follow river valleys that the roads
  themselves then re-carve, and the result would depend on evaluation order.
  Add the road drop to `sampleHeight` alongside `riverDrop` -- probably as a
  `max` or a sum of drops, which is a decision Phase 4 has to make and state.
- **The Region-tier plumbing is built and load-bearing.** `chunkTierContext`
  attaches the region record; add roads to the same record rather than a second
  one, or `generateChunk` grows a second coarse read for no reason.
- **`rivers.ts` is the template for a Region-tier generator**: pure, handed a
  `region` `TierContext`, memoised in a bounded array keyed by
  `(terrain, seed, region)`, with `clearRiverCache()` for tests. Copy the
  shape; do not copy a second memo implementation.
- **A road crossing a river needs a bridge**, and nothing here provides one.
  A road carved into a channel will follow it down.
- **Every geometry budget is unchanged from 3a and still has ~1.7x headroom**,
  except `chunk payload bytes` at 1.08x, which is structural. Roads that add a
  mesh per node will move draw calls the way water did; re-derive with a stated
  number.
- The soak's flight start is chosen for the water AND the rivers it crosses. If
  Phase 4 needs it to pass a settlement, move it deliberately and add the
  matching anti-vacuity assertion -- and check `sea at the start` and
  `river at the start` in the report afterwards, because both go quiet without
  failing if the route stops being interesting.

---

## Phase 4a -- Settlements and the road network (done)

The roadmap's Phase 4 is "Settlements and road network", with Phase 5 owning road
meshes and Phase 6 owning lots and buildings. It was split, as Phases 2 and 3
were: **4a is settlement siting, the inter-settlement road graph and the terrain
grading; 4b is the Sector-tier street layout inside a settlement.**

There is no Phase 4 brief in this repository, and there never has been one for any
phase -- earlier phases quoted a roadmap supplied per session and committed only
their own notes. The binding spec was therefore `PROGRESS.md`'s own "For Phase 4"
handoff, `ARCHITECTURE.md`'s five rules, and the `baseHeight`/`sampleHeight`
layering. Every one of the handoff's five points is answered below.

**4a builds no road geometry.** No mesh, no draw call, no new vertex buffer, and
`SEGMENTS` is untouched. A road shows up as graded ground plus a palette band,
exactly as a river shows up as a carved channel.

### Built

- **`src/world/roads.ts`** (new, and the phase) -- settlement siting on a global
  512 m lattice with a 3x3 local-maximum rule; a Gabriel graph over the padded
  settlement set; A* path routing on a global 128 m lattice reading `baseHeight`
  only; path smoothing and a smoothed, gradient-limited elevation profile; a CSR
  bucket segment index; a bounded memo; and `RegionRoadField`, the record chunks
  read. Pure, no Three, no DOM, importing `contracts.ts`, `noise.ts` and
  `core/hash.ts` only -- and importing nothing from `rivers.ts`.
- **`src/world/cell-heap.ts`** (new) -- `CellHeap` lifted out of `rivers.ts` so
  the river flood and the road router share one implementation. Two copies of a
  heap whose ORDERING is a determinism guarantee is exactly the duplication that
  drifts. Plus `cell-heap.test.ts`.
- **`src/world/height-field.ts`** -- `RegionField` (rivers and roads together in
  the single `coarser('region')` slot), `worldRegionField`, a `habitability`
  climate score passed into the road generator by injection, `sampleHeight` gains
  the road lift, and `MIN_HEIGHT`/`MAX_HEIGHT` account for road cut and fill.
- **`src/world/contracts.ts`** -- `ChunkData.roadVertices`, a scalar;
  `CHUNK_DATA_VERSION` 4 -> 5. **No new buffer**, so `chunkDataTransferables` and
  `chunkDataBytes` are unchanged and `chunk-gen.test.ts` keeps its list length.
  `TierContext`, `ChunkCoord` and `ChunkProvider` are untouched: RULE 4 held.
- **`src/world/chunk-gen.ts`** -- the composite region record and its guards, one
  `roads.grade` call folded into the existing padded height loop, `roadVertices`,
  `SurfaceInputs.road`, and the `ROAD` swatch in `surfaceColor`.
- **`src/world/chunk-mesh.ts`, `chunk-streamer.ts`, `app.ts`** -- `roadDraws` via
  `Object3D.onBeforeRender`, a `roads` HUD line, a `road draws` HUD line, road
  counters in `perfSnapshot()`, and `sampleChunkRoads` for the soak.
- **`scripts/soak.mjs`** -- the flight start moved, five road assertions, road
  reporting.
- **`src/world/rivers.ts`** -- imports `CellHeap` instead of defining it, and
  `RIVER_CACHE_LIMIT` 16 -> 24. Nothing else.
- Five new canonical views, and 51 new unit tests (334 -> 385).

### Verified

All run on 2026-08-02 in the dev container, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | 385 passed, 17 files (334 -> 385)                                   |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 607.3 kB + a 23.5 kB worker chunk      |
| `npm run shots`          | all 30 views captured and inspected by eye (see the screenshots section) |
| `npm run shots:check`    | all 30 views byte-identical, run twice                              |
| `npm run verify:subpath` | app ready, zero failed requests, 3 workers from the nested mount, 256 chunks streamed |
| `npm run soak`           | 300s, unexplained heap trend **+2.40 MB/min**, **25/25 geometry hashes identical** |

`shots:check` now takes around ten minutes a run under software rendering, which
is why the phase's own commit history has it landing after the code: it was
still running when the code was committed, and this row was filled in once it
had passed twice. Nothing in this table is reported without having been run.

Full 5-minute soak, 45 m/s, seed `soak`, new start `(-7500, -3600)`:

```
heap     72.6 MB at t=0 -> 99.5 MB at t=300s, peak 118.7 MB (budget 400)
         raw trend +8.81 MB/min (reported only -- tracks how much sea is in view)
         UNEXPLAINED +2.40 MB/min (limit 6) -- heap minus chunk payload
nodes    live 277 min / 296.6 mean / 306 max, 300 selected at the end
         4209 generated, 3419 evicted, 490 cached
geometry 1,184,272 live triangles peak (budget 2,100,000)
         589,065 live vertices peak (budget 1,040,000)
         90.5 MB payload peak (budget 100 MB), 103,046 bytes per node
         291 draw calls peak (budget 500), shallow leg 291
water    239 nodes, 93 drawn peak, sea at the start 25/25 round-tripped chunks
rivers   161 carved nodes, 64 drawn peak, river at the start 15/25
roads    93 surfaced nodes, 15,035 surfaced vertices, 32 drawn peak,
         32 on the shallow leg, road at the start 7/25
trip     out to x=-759 m and back to x=-6608 m; 25/25 geometry hashes identical
```

### Budgets: all four geometry limits unchanged, and none re-derived

| Budget                         | Limit     | 3b measured | 4a measured |
| ------------------------------ | --------- | ----------- | ----------- |
| live triangles                 | 2,100,000 | 1,225,890   | 1,184,272   |
| live vertices                  | 1,040,000 | 610,035     | 589,065     |
| draw calls                     | 500       | 288         | 291         |
| chunk payload bytes            | 100 MB    | 92.9 MB     | 90.5 MB     |
| <=400MB heap after 5 minutes   | 400 MB    | --          | 118.7 MB peak, +2.40 MB/min |
| 60fps at 1080p                 | --        | UNVERIFIED  | **60.0 fps, VERIFIED on an Arc 140V** |
| <=16ms frame, no >4ms GC spike | --        | UNVERIFIED  | **frame PASS (p99 6.5ms); GC MISSED at 5.45ms** |

**This was stated in advance and it held.** Roads add no mesh, no draw call and
no vertex -- grading moves vertices the terrain mesh already had and surfacing
recolours them -- so the expectation was that all four geometry budgets would be
untouched, exactly as Phase 3b found for rivers. They were. The small movements
above are the flight start moving, not roads: the new line crosses less open sea,
which is why triangles and payload went slightly DOWN.

**The last two rows were finally measured on real hardware, after the phase
landed.** Every phase since 1 recorded them as unverified because the dev
container has no GPU and reports 3-7 fps from a software rasteriser. That
request -- "someone with a GPU should open `?pos=1720,107,770&look=70,-6` at
1080p and read the HUD" -- has now been carried out. See the section below.

### The frame budgets, measured on a GPU at last

Run on 2026-08-02 on Windows 11, **Intel Arc 140V (integrated), ANGLE/D3D11,
1920x1080 at 60 Hz, dpr 1**. An RTX 4050 is present in the machine but Chrome
ran on the integrated GPU, which is what RULE 5 actually specifies. The
production `dist/` build was served statically -- not the dev server -- and
driven in installed Chrome 150, because Playwright's own Chromium build fails to
start on this machine with a side-by-side configuration error.

|                            | stationary 20 s | moving 60 s @ 45 m/s |
| -------------------------- | --------------- | -------------------- |
| mean fps                   | **60.0**        | **60.0**             |
| dropped frames             | 0 of 1200       | 1 of 3600 (0.03%)    |
| main-thread p99 per task   | 6.82 ms         | 6.53 ms              |
| worst main-thread task     | 9.26 ms         | 12.02 ms             |
| tasks over 16 ms           | **0** of 7,885  | **0** of 24,154      |
| main-thread GC, worst      | 2.55 ms         | **5.45 ms**          |
| main-thread GC over 4 ms   | 0 of 46         | **3** of 75          |

- **60 fps at 1080p on integrated graphics: PASS.** Pinned to vsync, one dropped
  frame in a minute of continuous streaming flight.
- **<=16 ms main-thread frame time: PASS**, with about 9.5 ms of headroom at p99.
  Not one task over 16 ms in 32,000.
- **No GC spike above 4 ms: MISSED, and recorded as missed.** Three main-thread
  major GCs between 5.12 and 5.45 ms during the 60 s flight. None of them cost a
  frame, but 5.45 ms is over a 4 ms limit and rounding that down is exactly the
  habit these notes exist to prevent.

Alongside: the worst WORKER task was 969 ms, consistent with the ~1 s cold
road-region cost measured below, and time-to-`__worldReady` on a cold seed was
4.9-8.9 s. Both are off the main thread or paid once, and neither shows up in
the frame numbers above.

**Two measurement traps, both of which produced a confident wrong answer first.**
Anyone re-running this must avoid them:

- **rAF deltas cannot measure the 16 ms budget.** They are vsync-locked, so
  16.7 ms is the FLOOR on a 60 Hz panel, not a cost. Measured that way the first
  run reported "48% of frames over 16.7 ms, FAIL" while the app was in fact
  hitting vsync on essentially every frame. Main-thread cost has to come from
  `RunTask` durations on `CrRendererMain` in a Chrome trace -- which requires the
  `toplevel` category. Without it there are no task events at all and the check
  reports PASS while measuring an empty set, which is the same false green the
  `shots:check` anti-vacuity guards exist to catch.
- **GC has to be attributed per thread.** Counting every thread gave "worst
  24.58 ms, 52 spikes over 4 ms" -- but 4,316 of those 4,391 collections were on
  the generation workers, where a pause cannot drop a frame. Main-thread only, it
  is 75 collections with a worst of 5.45 ms.

This was measured with a throwaway script, not a committed command. **Landing it
as `npm run perf:gpu` is worth doing**, because a budget that can only be
verified by hand is a budget that goes stale again -- and these two rows have
been UNVERIFIED since Phase 1.

### The cost of a second Region-tier generator, measured

This is the number a future phase will want, and it was the hard part of the
phase.

```
road region, cold (first touch of a seed)   ~1.2 s
road region, warm (river memo populated)    ~290 ms, of which ~225 ms is
                                            4 river-region builds and ~65 ms
                                            is road work
```

The first working version cost **1.5 s per warm region, ten times the budget**,
and the profiling counters in `roads.ts` (`roadProfile()`) are what found the
cause. It was not A*: the search expands only 220-1,200 cells per region. It was
**24-28 river-region rebuilds per road region at ~56 ms each** -- the road
window is wider than a chunk, so it swept a 4x4 block of river regions plus blend
margins and overflowed the 16-entry river memo. Three changes fixed it: shrinking
`SETTLEMENT_PAD` from 4,096 m to 3,072 m so the window spans 3x3 river regions,
raising `RIVER_CACHE_LIMIT` to 24, and inflating the A* heuristic (which was a
separate ~10x on the search itself). Scratch arrays moved from per-edge to
per-region at the same time, removing ~23 MB of garbage per region.

**The main thread pays the cold cost once, in the `App` constructor**, seating
the cube and resolving the default camera Y. Phase 3b recorded that as ~56 ms;
it is now of the order of a second on a cold seed. That is a real regression in
time-to-first-frame and it is recorded rather than hidden.

### Screenshots: five new views, and every existing one changed

Every one of the 25 existing baselines is different. That is expected and
legitimate -- `sampleHeight` now grades roads and settlement pads into the ground
everywhere they occur, and the surface palette gained a band -- but it is also
the weakest form of evidence this harness produces, so the five new views exist
to say what actually changed. No existing view's `params` were edited.

- **`road-benched-hillside`** (`?time=3&pos=1720,107,770&look=70,-6`) -- the
  shallow-pitch road view, and the one that says the phase happened. A road cut
  about 10 m into a hillside in one place and carried on fill in the next.
- **`road-wireframe-bench`** (the same viewpoint, `&wireframe=1`) -- the
  structural view: the bench is a deformation of the ordinary 32x32 terrain
  lattice, with no road mesh and no extra draw call.
- **`settlement-footprint`** (`?time=3&pos=2634,465,110&look=0,-88`) -- straight
  down onto a 161 m-radius settlement with its roads radiating away. Where siting
  is judged.
- **`road-river-ford`** (`?time=3&pos=2414,94,1254&look=68,-13`) -- the
  composition rule by eye: the roadbed runs to the bank, stops, and resumes on
  the far side. What must NOT be here is a dam.
- **`road-region-seam`** (`?time=3&pos=4096,367,3505&look=0,-89`) -- the
  region-boundary canary, mirroring `river-region-seam`. A road crossing
  x = 4096 must show no kink, no step in width and no change in surfacing.

### Known gaps, deliberately left

- **No road meshes.** Phase 5. A road is currently graded ground plus a palette
  band, which is why `road-benched-hillside` and `road-wireframe-bench` both
  exist -- between them they cover the two halves of what a road IS right now.
- **No bridges: a road crossing a river is a ford.** The router pays heavily to
  cross a channel so crossings are rare, and grading yields inside one so a road
  can never dam a river, but the roadbed simply stops at the bank. Every crossing
  is recorded in `RoadNetwork.segCrossing` for Phase 5.
- **No streets inside a settlement.** Phase 4b, and the reason `SETTLEMENT_CELL`
  is `SECTOR_SIZE`.
- **`Sector` is still unused.** Phase 4b is now the phase that needs it.
- **The A* path is not provably optimal**, because the heuristic is inflated. It
  is deterministic, which is what RULE 1 requires.
- **A road across flat ground moves no earth**, so on gentle terrain it is
  visible only as surfacing. Correct engineering, but it is why `roadVertices`
  counts surfacing rather than movement.
- **Cold generation of a road region is of the order of a second**, and the main
  thread pays it once at startup. See the cost section above.
- **The test suite went from ~40 s to ~110 s**, and `shots:check` from ~5 to
  ~10 minutes, because a fresh region is now expensive and several tests sweep
  the world. Three tests had their spans trimmed with the reasons written down;
  PR #3 flagged this as worth watching before Phase 4 added more, and it is now
  worth watching harder.
- **A settlement can be sited on ground a road later grades**, since siting reads
  `baseHeight` and grading happens after. The pad and the road agree because both
  target the same altitude, but nothing enforces it.
- **Main-thread GC exceeds the 4 ms limit under movement**, at 5.45 ms worst
  across three collections in a 60 s flight. It costs no frames today -- there is
  ~9.5 ms of main-thread headroom at p99 to absorb it -- so nothing was done
  about it, but it is a real miss against RULE 5 rather than a pass. The likely
  source is per-frame allocation in the streaming path; a phase that adds
  main-thread allocation should re-measure rather than assume the headroom holds.
- **The GPU verification is not a committed command.** It was a throwaway script,
  so the numbers above can only be reproduced by writing it again. See the
  measurement section for the two traps that make a naive version report the
  wrong answer.
- **Popping at a level switch is still quantified but unobserved**, unchanged
  since 2b. **Lighting is still the Phase 0 placeholder.** The bundle is one
  607 kB chunk plus a 23.5 kB worker (up from 14.3 kB: the worker now carries
  `roads.ts`). Vite still warns.

### For Phase 4b

- **`RoadNetwork.settlements` is the input**, and `RoadNetwork.pathStart` gives
  the roads leaving each one as CSR spans over the node arrays. Both are already
  pruned to what can influence the region.
- **`SETTLEMENT_CELL` is `SECTOR_SIZE`**, deliberately, so a Sector-tier street
  layout is a strict refinement of 4a's siting rather than a second grid. A
  settlement's footprint radius is at most `SETTLEMENT_RADIUS_MAX` (186 m), which
  fits inside one 512 m sector -- but a settlement near a sector corner does not,
  so 4b has to decide whether a sector lays out the settlements whose CENTRES it
  contains (simple, and the recommendation) or clips them.
- **The Sector tier will be the first three-level read**: a sector context can
  legally `coarser('region')`, and `createTierContext` already supports it. The
  chunk context would then need both, which is the first time `CoarseData` holds
  two entries.
- **Grading composes by weighted average of targets at the strength of the
  strongest influence** (`networkGrade`). Streets must join that same blend, not
  add a third independent pass, or a street meeting a road will step.
- **Do not raise `ROAD_MAX_EDGE` without re-checking `SETTLEMENT_PAD`.** The pad
  must contain `ROAD_REACH + 1.5 * ROAD_MAX_EDGE`, and the pad is what decides
  how many river regions road generation touches -- which is where the time goes.
- **Every geometry budget is unchanged from 3a and still has ~1.7x headroom**,
  except `chunk payload bytes` at 1.10x, which is structural. Streets that add a
  mesh per node will move draw calls the way water did; re-derive with a stated
  number.
- **The frame budgets are no longer guesses**: on an Arc 140V the app holds
  60 fps at 1080p with p99 main-thread work at 6.5 ms, so there is roughly 9.5 ms
  of headroom for streets to spend. That is a real number to design against for
  the first time since Phase 1 -- and the first thing to re-measure if 4b adds
  per-frame main-thread work, since main-thread GC is already 1.4x over its 4 ms
  limit.
- The soak's flight start was chosen for the sea, the rivers AND the roads it
  crosses. If 4b needs it to pass a settlement centre, move it deliberately and
  check `sea at the start`, `river at the start` and `road at the start` in the
  report afterwards -- all three go quiet without failing.

---

## Phase 4b -- Settlement streets, and the Sector tier (done)

The roadmap's Phase 4 was split in 4a: **4a is settlement siting, the
inter-settlement road graph and the terrain grading; 4b is the Sector-tier street
layout inside a settlement.** This is 4b, and it is the phase that finally uses
the middle tier. `Sector` has been declared in `contracts.ts` since Phase 1,
`SECTOR_SIZE` has been a constant nothing read, and `Region -> Sector -> Chunk`
has been an architecture diagram with a hole in it. Phase 4a sized its settlement
lattice `SETTLEMENT_CELL = SECTOR_SIZE` precisely so that this would be a strict
refinement of its siting rather than a second grid; that is now cashed in.

The binding spec was `PROGRESS.md`'s own "For Phase 4b" handoff,
`ARCHITECTURE.md`'s five rules, and the `baseHeight`/`sampleHeight` layering.
Every one of the handoff's seven points is answered below.

**4b builds no street geometry.** No mesh, no draw call, no new vertex buffer and
no new payload array. A street shows up as graded ground plus a palette band,
exactly as a road does and a river channel does.

### The open decision, answered

The handoff left one question: does a sector lay out the settlements whose
CENTRES it contains, or clip them?

**Centres, and the alignment makes it exact rather than merely simple.** The
settlement lattice cell size IS the sector size, both lattices are global and
anchored at the world origin, and `SETTLEMENT_JITTER` (190 m) is less than half a
cell (256 m) -- so a candidate can never leave the cell that owns it, and **a
sector contains at most ONE settlement centre, which is the candidate of the
identically-indexed settlement cell**. `generateSectorStreets` throws if it ever
finds two, because that would mean the alignment everything here rests on had
broken, and quietly laying out one of them would hide it.

**Clipping was rejected on the grounds the Gabriel graph was chosen on.** A
street plan is a whole-settlement structure -- the ring has to know where every
road leaves the village so it can avoid duplicating one -- so two sectors each
owning half a settlement would each need the other half's information to decide
its own. That is exactly the non-locality 4a paid a Gabriel graph to avoid.

**The consequence: a query reads up to four sectors, and there is no blend.** A
settlement's streets overhang its own sector by up to `STREET_REACH` (derived
from the tuning, 116 m, deliberately under half a sector), so a point consults
every sector whose square inflated by that contains it -- one normally, four near
a corner. That is the shape `rivers.ts` uses, not the shape `roads.ts` uses. The
difference from rivers is worth stating precisely: rivers blend four regions by a
weighted maximum because neighbouring regions genuinely disagree about how big a
river is. Here there is nothing to disagree about, because two sectors never both
own a settlement -- what the sectors contribute is **disjoint**, so the union is
exact and no weighting is involved at all.

**One region per sector, and it is the right one.** A sector lies entirely inside
one region, and so does the settlement whose centre it contains -- and the region
containing a settlement is guaranteed to have routed every Gabriel edge incident
to it (the edge's bounding box contains the settlement, which is inside the
region, so it trivially meets that region's reach box; and `SETTLEMENT_PAD`
covers `ROAD_MAX_EDGE + ROAD_MAX_EDGE / 2` around it). So the roads a street plan
must avoid are read from the one region certain to have all of them, and every
sector that needs that settlement reads the same region.

### Built

- **`src/world/streets.ts`** (new, and the phase) -- Sector-tier street layout: a
  jittered ring at 0.58 of the footprint radius, lanes out to 0.78 and spokes in
  to the centre off alternating ring nodes, both dropped wherever a road already
  leaves the settlement on that bearing. A CSR record, a bounded memo, and the
  grading accumulation. Pure, no Three, no DOM, importing `contracts.ts`,
  `grading.ts`, `noise.ts`, `core/hash.ts` and `roads.ts` only -- and importing
  nothing from `height-field.ts`, which is what keeps the wiring one-directional.
- **`src/world/grading.ts`** (new) -- `GradeBlend`, the ONE weighted-average blend
  everything that moves the ground now joins, plus `ROAD_MAX_CUT`,
  `ROAD_MAX_FILL`, `ROAD_RIVER_YIELD` and `closestOnSegment`, all lifted out of
  `roads.ts`. Phase 4a had a single grader so the rule lived inside it; 4b adds a
  second at a different tier, and two copies of a rule whose whole job is making
  two influences meet without a step is exactly the duplication that drifts.
  `cell-heap.ts` was lifted out of `rivers.ts` for the same reason in 4a.
- **`src/world/roads.ts`** -- `networkGrade` became `accumulateNetwork`, which
  adds to a blend instead of resolving one, and `RegionRoadField` gained
  `accumulate`. `grade` / `lift` / `surface` remain as ROADS-ALONE conveniences
  for the tests, re-expressed on top of `accumulate` so there is one
  implementation. 130 lines shorter.
- **`src/world/height-field.ts`** -- `SectorField`, `gradeSurface` (the single
  composition both `sampleHeight` and `chunk-gen.ts` call), and per-seed caching
  of the Region and Sector records for the main thread.
- **`src/world/contracts.ts`** -- `ChunkData.streetVertices`, a scalar;
  `CHUNK_DATA_VERSION` 5 -> 6. **No new buffer**, so `chunkDataTransferables` and
  `chunkDataBytes` are unchanged. `TierContext`, `ChunkCoord` and `ChunkProvider`
  are untouched: RULE 4 held again.
- **`src/world/chunk-gen.ts`** -- `chunkTierContext` now attaches BOTH a region
  and a sector record, which is the first time `CoarseData` holds two entries;
  `generateChunk` reads both through `coarser()` and throws if either is missing.
- **`src/world/chunk-mesh.ts`, `chunk-streamer.ts`, `app.ts`** -- `streetDraws`
  via `Object3D.onBeforeRender`, a `streets` HUD line, a `street draws` HUD line,
  street counters in `perfSnapshot()`, and `sampleChunkStreets` for the soak. The
  hand-written river/road/pair `onBeforeRender` callbacks became a table of eight
  indexed by a feature mask, because three features is eight combinations.
- **`scripts/soak.mjs`** -- the flight start moved for the fourth time, five
  street assertions, street reporting, and two harness bugs fixed (below).
- **`src/app.ts`** -- **the autopilot no longer starts until `__worldReady`.**
- **`scripts/lib/canonical.mjs`** -- `npm` is `npm.cmd` on Windows.
- Four new canonical views, and 39 new unit tests (385 -> 424).

### Three harness bugs found, and two of them were hiding evidence

None is in Phase 4b's own code. All three were found by trying to make a Phase 4b
claim and getting an answer that could not be right.

1. **Every Phase 4a road guard in the soak was dead code.** The road block calls
   `fail(...)`; the helper is `failures.push(...)` and `fail` does not exist. The
   guards had never fired -- the 4a run satisfied all of them -- so a
   `ReferenceError` sat there in place of a failure report. The first 4b run
   tripped `road at the start === 0` and crashed the report rather than printing
   it. Ten call sites fixed.

2. **The soak's flight started up to a kilometre downrange of `?pos=`.** The
   autopilot advanced from the first rendered frame, so it was already moving
   while the world streamed in -- 8 to 20 seconds at 45 m/s on this machine,
   varying with load. Everything the soak reports "at the start" is a claim about
   the chunks around wherever the camera had drifted to, so it could not be tuned:
   Phase 4b's chosen start measures street 10/25 in the square it names, and the
   run sampled a square 760 m away with street 0/25. The autopilot now holds until
   `__worldReady`, so the origin is exactly `?pos=` on every machine, and the
   report bears it out -- `started at x=-6747 m` against a `START_X` of -6749.
   **This is why the 4a soak column below is not strictly comparable to the 4b
   one**: 4a's flight measured a different 6.75 km of world from the one its own
   constants named.

3. **`npm run shots` could not run outside the dev container.** `buildProject`
   used `execFileSync('npm', ...)`, and `npm` is `npm.cmd` on Windows -- ENOENT,
   and then EINVAL once the extension is spelled out, because Node has refused to
   spawn a `.cmd` without a shell since 20.12. `execSync` with a constant command
   fixes both. This one hid nothing; it just made the phase's own visual
   verification impossible to run.

### Verified

All run on 2026-08-02 on Windows 11, software rendering (SwiftShader).

| Check                    | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm test`               | 424 passed, 19 files (385 -> 424)                                   |
| `npm run build`          | clean `tsc --noEmit`; `dist/` 613.1 kB + a 28.6 kB worker chunk      |
| `npm run soak`           | 300s, unexplained heap trend **+1.49 MB/min** (limit 6), **25/25 geometry hashes identical**, all four "at the start" counters non-zero |
| `npm run shots`          | all 34 views captured and inspected by eye; see the screenshots section for why the whole set was re-baselined |
| `npm run shots:check`    | all 34 views byte-identical, run twice                              |
| `npm run verify:subpath` | app ready, zero failed requests, 7 workers from the nested mount, 256 chunks streamed |

Full 5-minute soak, 45 m/s, seed `soak`, new start `(-6749, -4140)`:

```
heap     37.9 MB at t=0 -> 105.7 MB at t=300s, peak 109.1 MB (budget 400)
         raw trend +6.01 MB/min (reported only -- tracks how much sea is in view)
         UNEXPLAINED +1.49 MB/min (limit 6) -- heap minus chunk payload
nodes    live 280 min / 297.4 mean / 309 max, 309 selected at the end
         4157 generated, 3346 evicted, 502 cached
geometry 1,144,318 live triangles peak (budget 2,100,000)
         567,869 live vertices peak (budget 1,040,000)
         84.8 MB payload peak (budget 100 MB), 107,774 bytes per node
         290 draw calls peak (budget 500), shallow leg 269
water    220 nodes, 92 drawn peak, sea at the start 16/25 round-tripped chunks
rivers   181 carved nodes, 76 drawn peak, river at the start 9/25
roads    104 surfaced nodes, 13,015 surfaced vertices, 39 drawn peak,
         37 on the shallow leg, road at the start 12/25
streets  44 street nodes, 1,316 street vertices, 14 drawn peak,
         14 on the shallow leg, street at the start 10/25
trip     out to x=-14 m and back to x=-6722 m; 25/25 geometry hashes identical
```

### Budgets: all four geometry limits unchanged, and none re-derived

| Budget                         | Limit     | 3b measured | 4a measured | 4b measured |
| ------------------------------ | --------- | ----------- | ----------- | ----------- |
| live triangles                 | 2,100,000 | 1,225,890   | 1,184,272   | 1,144,318   |
| live vertices                  | 1,040,000 | 610,035     | 589,065     | 567,869     |
| draw calls                     | 500       | 288         | 291         | 290         |
| chunk payload bytes            | 100 MB    | 92.9 MB     | 90.5 MB     | 84.8 MB     |
| <=400MB heap after 5 minutes   | 400 MB    | --          | 118.7 MB, +2.40 MB/min | 109.1 MB, +1.49 MB/min |
| 60fps at 1080p                 | --        | UNVERIFIED  | 60.0 fps on an Arc 140V | **not re-measured** |
| <=16ms frame, no >4ms GC spike | --        | UNVERIFIED  | frame PASS; GC MISSED at 5.45ms | **not re-measured** |

**This was stated in advance and it held.** Streets add no mesh, no draw call and
no vertex -- grading moves vertices the terrain mesh already had and surfacing
recolours them -- so the expectation was that all four geometry budgets would be
untouched, exactly as 3b found for rivers and 4a for roads. They were. The
movements in the 4b column are the flight start moving and the autopilot fix
changing which 6.75 km the run measures, not streets.

**The last two rows are honest about not having been re-measured.** Phase 4a's
GPU run is the only real measurement of them this project has, and it was taken
before this phase. 4b adds **no main-thread per-frame work** -- street layout runs
in the worker, `sampleHeight` on the main thread is called at startup and by the
cube, and the only new per-frame cost is one integer HUD line and three branches
in an `onBeforeRender` -- so there is no reason to expect them to move. That is a
reason, not a measurement, and it is recorded as such. Main-thread GC was already
1.4x over its 4 ms limit before this phase and still is.

### The cost of the Sector tier

Nothing here is close to a region build (~290 ms warm), and three things keep it
there.

**An empty sector is three zero-length arrays and one early return.** Because a
settlement must be a strict local maximum of the siting score over its 3x3
neighbourhood, no two adjacent cells can both hold one, so the overwhelming
majority of sectors are empty -- a unit test asserts over 60% of a 16x16 block
are, and the measured figure is higher.

**The record is memoised** on `(terrain, seed, sectorX, sectorZ)` with the same
move-to-front linear scan `roads.ts` and `rivers.ts` use, at `STREET_CACHE_LIMIT`
64 rather than 8, because a sector is 64 times smaller than a region and a coarse
quadtree node can span a block of them.

**A query rejects a whole village with one disc test** before it looks at a single
segment, which is what makes the per-vertex cost of a settlement-free chunk two
branches.

Total generated chunks over a 300 s soak went from 4,093 on a comparable route
without the Sector tier reached to 4,157 with it. The Sector tier does not show up
in generation throughput.

### Screenshots: four new views, 19 of 30 changed, and a platform problem found

**The committed baselines are platform-specific, and this was found rather than
assumed.** Every phase up to 4a captured them in the Linux dev container; this
phase was developed on Windows, where all thirty came back different. To tell a
platform difference from a Phase 4b difference, `terrain-mountain-profile` was
captured on THIS machine from HEAD's source, with the Phase 4b modules moved out
of the tree: it produced a third hash, different from the committed one and
**byte-identical to the Phase 4b capture**. So that view is unchanged by this
phase and differs from its baseline purely because of the platform, and the same
must be true of the rest.

`shots/` now holds the Windows set, and a run in the dev container will see all
34 differ and should re-capture there. That is a real cost and it is recorded
rather than smoothed over: the harness pins the GPU backend to SwiftShader
specifically so two machines agree, and the assumption that "SwiftShader" names
one rasteriser turns out not to survive an OS change.

**What Phase 4b actually changed was then measured properly**, by capturing all
thirty existing views twice on the same machine -- once from HEAD's source, once
from this phase's -- and diffing those against each other:

```
19 of 30 changed        11 unchanged
```

The eleven that did not change are exactly the frames with no settlement in them:
`terrain-mountain-profile`, `chunks-aerial`, `chunks-aerial-seed-beta`,
`chunks-wireframe`, `chunks-far-from-origin`, `lod-ground-horizon`,
`river-region-seam`, `road-benched-hillside`, `road-wireframe-bench`,
`seed-canary-inland` and `water-shoreline-shallow`. The nineteen that did change
are the wide and aerial framings, which at 300 m and up nearly always have a
village somewhere in them. That is the expected shape of the result -- streets
touch ground only inside a settlement disc -- and it is a stronger statement than
"every baseline moved", which is what the raw comparison would have said.

Four new views:

- **`settlement-streets`** (`?time=3&pos=2634,350,110&look=0,-88`) -- the view
  that says the phase happened. Straight down onto the same village
  `settlement-footprint` frames from 830 m, at 305 m where the plan is legible.
  The road from the south-west crosses the ring and there is deliberately no lane
  lying along it.
- **`settlement-streets-shallow`** (`?time=3&pos=2470,60,110&look=-90,-6`) -- the
  shallow-pitch view, where the grading is visible as grading and where the
  geometry budgets are actually decided.
- **`settlement-streets-wireframe`**
  (`?time=3&pos=2380,200,110&look=-90,-32&wireframe=1`) -- the structural view:
  the plan is a deformation of the ordinary lattice, with the quadtree's level
  rings around it.
- **`settlement-sector-seam`** (`?time=3&pos=2560,300,110&look=0,-89`) -- the
  SECTOR-boundary canary, mirroring `river-region-seam` and `road-region-seam`
  one tier down. This village's centre is 74 m east of x = 2560, so part of it
  lies in a sector that owns no settlement at all.

### Judgement calls worth knowing about

1. **The blend was lifted into its own module rather than left in `roads.ts`.**
   `streets.ts` could have imported `GradeBlend` from `roads.ts` -- there is no
   cycle, since streets already imports roads for `Settlement`. It was moved
   because the blend rule is a CONTINUITY GUARANTEE shared by two tiers, and
   because a Sector-tier module reaching into a Region-tier one for its grading
   arithmetic muddies the only tier story this project has. `ROAD_MAX_CUT`,
   `ROAD_MAX_FILL` and `ROAD_RIVER_YIELD` moved with it and **kept their names**:
   a street is a road, they are the same physical quantity, and renaming them
   would have broken the correspondence between the code and every paragraph in
   these two documents that reasons about `MIN_HEIGHT`.

2. **Streets accumulate; they do not resolve.** This is the handoff's "grading
   must join `networkGrade`", and it is the single most important line in the
   phase. A weighted average is not distributive, so resolving roads and streets
   separately and adding the lifts would put a ledge exactly where a street meets
   the road it joins. `gradeSurface` in `height-field.ts` is the one place both
   are combined, and `chunk-gen.test.ts` asserts the worker and `sampleHeight`
   agree with `===`.

3. **Every street node targets the settlement's own altitude**, which is the same
   target the pad uses and the same one a road leaving the settlement is pinned
   to at its first node. That makes the junction step-free by construction rather
   than by tuning, and it is why this file needs no gradient limiter of its own.
   It is also the visible content of the phase: the pad grades a disc flat, the
   streets carry that altitude out along a ring and its lanes, so a settlement's
   graded footprint is a wheel rather than a circle.

4. **There is no trigonometry anywhere, and that is a determinism requirement.** A
   street node's position decides a vertex altitude, and `Math.sin` / `Math.cos`
   are only APPROXIMATED by the ECMAScript spec. `ringDirection` walks the L1 unit
   diamond -- pure linear arithmetic -- and normalises each point onto the unit
   circle with one `Math.sqrt`, which IEEE-754 requires to be correctly rounded. A
   test asserts the results are unit to within 1e-15 and monotonic around the
   circle without ever measuring an angle.

5. **The first version looked like a cartwheel, and the fix was measured by
   looking.** With radial jitter alone the ring is a regular polygon with wobbly
   corners and a village reads as a stamp on the hillside. Jittering the nodes
   AROUND as well, by up to 0.3 of a spacing so they cannot reorder, is what turns
   it into a village. The first capture of the phase is what said so.

6. **The street shoulder is 8 m, not the 5 m first tried, and that was measured
   too.** A street holds the settlement's altitude out past the flat core of the
   pad, so at the end of a lane it can be holding ground a few metres off the
   natural surface, and the shoulder is what that difference is spent over. At
   5 m the resulting bench was measurably steeper than anything the roads and the
   pad produce on their own. The test now bounds it by the DERIVED limit --
   `1.5 * (ROAD_MAX_CUT + ROAD_MAX_FILL) / STREET_SHOULDER`, the steepest a
   smoothstep taper can be -- rather than by an observed number.

7. **`streetVertices` is a third scalar, not a wider `roadVertices`.** A
   settlement pad surfaces its whole disc, so `roadVertices` is non-zero across an
   entire village before a single street exists: "the flight never reached a
   village" and "street layout silently returns nothing" would produce identical
   evidence. This is the trap that has caught this project five times, and it was
   sprung again here, at the soak's flight start.

8. **The soak's flight start moved deliberately and all four counters were checked
   afterwards**, as the handoff instructed. The new start was found by generating
   the REAL 5x5 chunk square at every 64 m offset around every settlement within
   reach of the corridor and maximising the WORST of the four counts, rather than
   trading three away for the fourth. Sea 16/25, river 9/25, road 12/25, street
   10/25 -- the weakest of them went from 0 to 9.

### Known gaps, deliberately left

- **No street meshes.** A street is graded ground plus a palette band, exactly as
  a road is. Phase 5 owns road meshes and will have to decide whether streets get
  the same treatment; `SectorStreets.streetStart` is CSR precisely so a street can
  be walked as a polyline and extruded.
- **No buildings and no lots.** Phase 6. The streets exist to hang them off, and
  until they do a village is a graded wheel of cleared ground.
- **The plan is one shape.** Ring plus lanes plus spokes, everywhere, at every
  settlement. The jitter and the road-clearance rule make no two identical, but
  there is no linear village strung along a road, no grid town and no hilltop
  enclosure. That is a generator, not a tweak, and it belongs with Phase 6's
  buildings, where the difference would actually read.
- **A street never leaves the settlement footprint**, so a village's lanes stop at
  its own rim rather than running out to the fields. Deliberate: past the rim the
  pad is tapering off and the two would fight over the same ground.
- **Streets are only resolvable near the camera.** Surfacing is counted within
  about 2.9 m of a centreline, so a node at lod 3 or coarser rarely carries any.
  That is correct -- a 5 m lane on 64 m vertex spacing is not renderable -- but it
  does mean `streetNodes` is a near-camera quantity, and the soak's floors are set
  for a flight that passes THROUGH a village rather than near one.
- **A sector consults its own region only, which is exact but not obviously so.**
  The argument is in the header of `streets.ts` and it depends on
  `SETTLEMENT_PAD` covering `1.5 * ROAD_MAX_EDGE` around a settlement. Raising
  `ROAD_MAX_EDGE` without re-checking that pad breaks it, the same way it breaks
  4a's region-boundary agreement.
- **`STREET_CACHE_LIMIT` is 64 and the lookup is a linear scan**, up to four times
  per vertex. It does not show up against the cost of `baseHeight`, but it is the
  first memo in the project whose scan length is comparable to its hit rate, and a
  phase that adds a fifth Sector-tier query per vertex should measure it.
- **Popping at a level switch is still quantified but unobserved**, unchanged
  since 2b. **Lighting is still the Phase 0 placeholder.** The bundle is one
  613 kB chunk plus a 28.6 kB worker (up from 23.5 kB: the worker now carries
  `streets.ts` and `grading.ts`). Vite still warns.
- **The GPU verification is still not a committed command**, and Phase 4a's note
  that landing it as `npm run perf:gpu` is worth doing stands. 4b did not do it,
  and consequently did not re-measure the two frame budgets.

### For Phase 5

- **`RoadNetwork.segCrossing` is where the bridges go**, unchanged from 4a: every
  segment whose midpoint sits in a channel deeper than 1 m is flagged, and the
  roadbed currently just stops at the bank.
- **`SectorStreets` is CSR by design.** `streetStart[i] .. streetStart[i + 1]` is
  one street as an open polyline, the ring included -- it repeats its first node
  at the end rather than wrapping, so nothing downstream needs a special case.
  `nodeY` is the surface altitude and `halfWidth` the bed. That is everything a
  mesh extruder needs, and `SectorStreetField.streetsAt` hands it over without a
  region around it.
- **A mesh per road or per street WILL move draw calls**, and this is the first
  phase since 2a where that is true. All four geometry budgets have ~1.8x headroom
  except `chunk payload bytes` at 1.18x, which is structural. Re-derive with a
  stated number, as 2b did, rather than raising a limit quietly.
- **The blend is `grading.ts` and there is exactly one of it.** Anything Phase 5
  adds that moves the ground -- a bridge deck, an embankment -- joins
  `GradeBlend` rather than adding a pass, for the reason spelled out above.
- **The soak's flight start is now reproducible**, because the autopilot waits for
  `__worldReady`. If Phase 5 moves it, the four "at the start" counters can be
  tuned against the real 5x5 square and will mean what they say. Check all four
  afterwards: they go quiet without failing.
- **`shots:check` is the slowest thing in the project by a wide margin** and has
  to pass twice. Phase 4a flagged the trend as worth watching; 4b added four views
  and did not slow a single test outside them.

---

## Phase 5 -- Road meshes: the deck, and the bridge (done)

The first phase since 3a to add a MESH. Everything from 3b to 4b modified the
terrain mesh every node already had -- a river is a dent in it, a road is a bench
and a colour, a street is the same one tier down -- so none of them could cost a
draw call, and none of them could be resolved more finely than the vertex lattice
they were drawn into. A deck is separate geometry, so it costs a draw call and it
is exact at every level. Phase 4b said in advance that this is the phase whose
budgets should move; they moved, and the number is stated below rather than the
limit quietly raised.

The binding spec was `PROGRESS.md`'s own "For Phase 5" handoff, `ARCHITECTURE.md`'s
five rules, and the `baseHeight` / `sampleHeight` / `GradeBlend` layering. All
five of the handoff's points are answered here, including the open one: **streets
get the same treatment as roads, through the same extruder.**

### Built

- **`src/world/road-mesh.ts`** -- new, and the phase. Pure, no Three, importable
  from a worker and from Node like every other file in `world/`. It builds one
  node's deck: the carriageway of every road and street crossing that node, as
  its own positions, normals, colours and indices.
- **`ChunkData` gains `deckPositions`, `deckNormals`, `deckColors`,
  `deckIndices` and `bridgeVertices`.** `CHUNK_DATA_VERSION` 6 -> 7, the transfer
  list 7 buffers -> 11, and `chunkDataBytes` covers them. All four arrays are
  ZERO-LENGTH on a node no road reaches, which is most of them, and a test
  asserts that such a node still costs exactly 74,676 bytes.
- **`GradeBlend.target`**, and **`gradeTarget` in `height-field.ts`** beside
  `gradeSurface`. The blended target altitude, before the strength, the cut and
  fill caps and the river yield are applied. Nothing before this phase needed it,
  because nothing before this phase had to be PLACED at the target rather than
  moved toward it.
- **`chunk-gen.ts` gains `groundAt`** -- the ground this node actually RENDERS at
  an arbitrary point, interpolating the two triangles of a cell rather than
  bilinearly blending its four corners, because those are different surfaces
  wherever a quad is twisted and only one of them reaches the rasteriser. It also
  gains the deck palette: a dark metalled bed for a road, a lighter gravel for a
  village lane.
- **`chunk-mesh.ts` gains the deck submesh**, parented to the terrain mesh like
  the water so the streamer's add/remove/dispose carries it, with the same
  coordinate-derived `renderOrder`, a `polygonOffset` material, and a
  `deckDraws` counter off `onBeforeRender`. `hashChunkGeometry` folds
  `deckPositions` in -- the first new term since 3a.
- **`chunk-streamer.ts` gains `deckNodes`, `deckTriangles`, `bridgeVertices` and
  a CUMULATIVE `bridgeNodes`**, plus `sampleDeckTriangles` and a `decks` HUD line.
  `app.ts` gains `deckDrawCalls`, a `deck draws` HUD line, `sampleChunkDecks` and
  four `perfSnapshot` fields.
- **Two memo limits raised, on measurements rather than on taste.**
  `ROAD_CACHE_LIMIT` 8 -> 16 and `STREET_CACHE_LIMIT` 64 -> 192. See below: this
  is the largest performance change in the project since Phase 2b and it is not
  really about decks.
- **The soak holds the autopilot until its baseline is read**
  (`window.__flightReleased`, set through `context.addInitScript`). Opt-in, so a
  human opening a `?fly=` URL is unaffected.
- **`src/world/road-mesh.test.ts`**, 16 tests, plus one for `GradeBlend.target`.
- **Three new canonical views**: `road-bridge`, `road-bridge-wireframe`,
  `deck-lod-aerial`.

### The rule, and the two versions of it that were wrong

A deck station's altitude is

```
deckY = max(gradeTarget(x, z), thisNode.groundAt(x, z)) + DECK_LIFT
```

and every property of the phase falls out of it:

| where | the ground | the deck |
| ----- | ---------- | -------- |
| ordinary terrain | reached the target | flush on the ground |
| a village edge | the pad/road/street weighted average | flush, reading the same average |
| a clamped cut on a hillside | stays above the target | rides the ground |
| inside a river channel | yielded entirely (`ROAD_RIVER_YIELD`) | holds the target: **a bridge** |

**The first version used the road's own profile and floated over every village.**
`RoadNetwork.nodeY` interpolated along the segment is the road's target, not the
blended one, and inside a settlement the ground is graded to the average of the
pad's target and the road's. A deck at the road's profile therefore stood one to
three metres above its own approach on the way into every village in the world.
Reading `GradeBlend.target` -- literally the same accumulation `gradeSurface`
performs, stopped one step short of resolving -- makes flushness a property of
the composition instead of a coincidence. It also removed the second
interpolation of `nodeY`: **the deck reads no road altitude at all now**, which
is one source of truth rather than two that agree today.

**The second version hung the apron to the ground and built a dam.** Every deck
edge carries an apron below it, which does the terrain skirt's job where the deck
rests on the ground and is the side of the bridge where it does not. Hanging it
to the ground unconditionally is right for the first job and catastrophic for the
second: over a 15 m channel it produced a solid wall from bank to bank standing
in the water. That is exactly the failure `ROAD_RIVER_YIELD` exists to prevent
one layer down, and `road-river-ford` has been the canonical picture of not doing
it since Phase 4a. `DECK_BEAM` (0.8 m) bounds how far the apron may follow the
ground down, so a deck spanning a channel is a deck with a beam under it and
daylight below.

### Why per-chunk geometry, and why that is not the obvious choice

One mesh per routed road is the obvious design and is wrong here in four ways.
Three of them are the ones Phase 3a used to reject a world-sized water plane: its
extent is not a function of `(worldSeed, coord)`, so the streamer's residency,
the LRU cache and the soak's round-trip hash do not cover it; it cannot be
clipped to whatever the quadtree currently covers; and no single worker owns a
road.

The fourth is new and is the one that settles it. **A node's rendered ground is
the linear interpolation of its own vertex lattice**, which at lod 5 cuts corners
by metres. A lod-independent deck sinks into a coarse hillside and floats over a
coarse valley -- and roads are in valleys. The deck has to be fitted to the same
grid the node draws, which means it has to be built by the node, in the worker,
with the payload.

### Two neighbours agree exactly, and that is arithmetic rather than tolerance

A centreline is clipped to the node square parametrically. For the shared
boundary of two same-level neighbours the two clips solve the same equation with
opposite signs -- `(maxX - ax) / dx` against `(ax - minX) / -dx` -- and IEEE-754
makes negation exact and `x / -y === -(x / y)`, so both nodes place a station at
the same world point. Their padded height grids sample the same world positions
along that edge, so the station gets the same altitude from both. Two unit tests
assert it with `toBe`, not with a tolerance: one on the clipper directly, one on
real generated nodes.

The consequence is that the deck is PARTITIONED between nodes rather than shared
or dropped: no seam, and no double-drawn overlap to z-fight. The box is half-open
on its maximum edges, which matters only for a segment running exactly along a
boundary -- parallel to it, so no interval clips it away, and both neighbours
would otherwise emit the same strip on top of each other.

Ownership needs one more rule for roads and none for streets. Two regions both
route a road near their shared boundary and hold bit-identical copies of it, so a
segment is emitted by the region containing its MIDPOINT. Streets need nothing: a
sector lays out only the settlement whose centre it contains, so two sectors never
hold the same street.

### The performance finding, which is not about decks

The deck builder sweeps a whole node in one go, where everything before it swept
one vertex at a time. That exposed two memo limits that had been wrong since the
phases that set them, and each was wrong in the same shape: **smaller than the
working set of a single coarse node.**

A node at the root level covers a whole 4 km region. Its padded sample grid needs
a 3x3 block of ROAD networks and an 11x11 block of STREET plans.
`ROAD_CACHE_LIMIT` was 8 against nine, and `STREET_CACHE_LIMIT` 64 against 121.
One short of the working set is the worst possible size: the entry evicted is
always the one wanted next, so a sweep rebuilds every record it touches instead
of building each once.

Neither was visible before, because a VERTEX touches one region and up to four
sectors and both caches absorbed that comfortably. Measured on real work:

| measured | before | after |
| -------- | ------ | ----- |
| one root-level node, memos warm | 3.6 s -- 10.5 s with a deck | ~6 ms |
| `seed-canary-inland` to `__worldReady` | 96 s, against a 120 s harness limit | ~16 s |
| `deck-lod-aerial` to `__worldReady` | 103 s | ~20 s |

The second row is the important one: that view had been quietly costing most of a
`shots` run since Phase 4b, close enough to the timeout that the first Phase 5
capture attempt failed on it. Phase 4b's handoff asked for exactly this
measurement (**"a phase that adds a fifth Sector-tier query per vertex should
measure it"**) and this is the answer -- the scan length was never the problem,
the capacity was.

**The deck also stopped sweeping the sector grid.** Visiting every sector whose
square inflated by `STREET_REACH` meets the node is what `accumulate` does per
vertex and is correct for a vertex; for a node it is an 11x11 block. A street
plan exists only where a settlement centre is, and the region records already
list every settlement that can reach the node, so the sectors worth visiting are
enumerated exactly: none normally, one over a village.

### The soak's fifth vacuity trap, and the one that was not the flight's fault

Phase 5 adds the deck trio -- `deckNodes` resident, `deckDrawCalls` rasterised,
`deck at the start` in the round-tripped square -- mirroring water rather than
rivers, because a deck IS its own submesh. It also adds `bridgeNodes`, and that
one needed two decisions that no earlier counter did.

**Bridges are counted at lod 0 only.** A deck stands at the blended target; the
ground reaches that target only where the vertex lattice has samples inside a
2.6-6 m roadbed. At lod 0 the spacing is 2 m and several do. At lod 3 it is 16 m
and usually none, so the deck legitimately stands a metre or two above ground the
lattice cannot describe -- which is the deck doing its job and is not a bridge.
Counting it read 410 where the honest number is 60, and turned the one statistic
that says "a road crossed a river" into a statement about mesh resolution.

**And it is cumulative, not instantaneous.** A lod-0 bridge node is resident for
about seven seconds as the camera passes, against a five-second sampling
interval. An instantaneous peak is a coin flip, and a floor built on a coin flip
is a check people re-run until it goes green. `bridgeNodes` only rises. The
corridor was scanned offline before the floor was set: four chunk columns carry a
bridge, around x = -3,700, which the flight passes at about t = 68 s outbound and
t = 232 s on the return. The run measured 10.

**`__worldReady` was not enough to anchor the flight, and that cost a whole run.**
Phase 4b stopped the autopilot advancing before the world was ready, which
removed 400-900 m of drift. It could not remove the rest: readiness is observed by
POLLING from Node, and a main thread building a hundred meshes under a software
rasteriser stalls for over a second at a time, so the poll lands late. On the run
that exposed this the camera was **1,296 m downrange** by the time the baseline
was read, which put the round-tripped square out over open sea and failed three
checks that had nothing wrong with them. The soak now sets
`window.__flightReleased = false` before the document runs and clears it once
every baseline is read; the run after that started at exactly x = -6,749 and
returned to exactly x = -6,749.

### Verified

- **`npm test`: all green**, including 16 new deck tests. The ones worth naming:
  - two neighbours place the boundary station at the same altitude, **to the
    bit**, on real generated nodes;
  - the deck never sinks below the rendered surface **at lod 0 or at lod 3** --
    the second half is the one that would fail for a lod-independent deck;
  - it follows the ground rather than hovering: most stations are flush to within
    5 cm, and the altitude varies across a chunk by more than half a metre;
  - **over 90% of stations in a village are flush**, which is the regression test
    for the road-profile version that floated;
  - bridges exist, span more than `BRIDGE_CLEARANCE`, are **rare** on ordinary
    road, and are **zero at lod 3**;
  - a deck regenerates byte-identically after twelve unrelated chunks on other
    seeds have evicted every memo it reads;
  - an absent deck costs zero bytes, zero indices and zero normals.
- **`npm run soak`: green over the full 300 s.** Round trip exact: started at
  x = -6,749, returned to x = -6,749, 25/25 chunks re-resident, **25/25 geometry
  hashes identical** with `deckPositions` folded into the hash. All five "at the
  start" counters real: sea 16/25, river 9/25, road 12/25, street 10/25,
  **deck 10/25**. Unexplained heap trend +0.96 MB/min against a 6 MB/min limit.
- **`npm run shots`**: all 37 views captured, no console errors, no failed
  requests.
- **`npm run shots:check`: RED, and unresolved. See the section after next.**
- **`npm run verify:subpath`**: green; the worker now carries `road-mesh.ts` and
  is still fetched from inside the mount path.

### Budgets: one of the four re-derived, three deliberately left alone

| Budget | Limit | 4b measured | 5 measured | headroom |
| ------ | ----- | ----------- | ---------- | -------- |
| live triangles | 2,100,000 | 1,144,318 | 1,368,596 | 1.53x |
| live vertices | 1,040,000 | 567,869 | 673,805 | 1.54x |
| draw calls | **500 -> 680** | 290 | 398 | 1.71x |
| chunk payload bytes | 100 MB | 84.8 MB | 86.8 MB | 1.15x |

**Draw calls moved for two reasons and only one of them is this phase's
content.** Decks contributed **+34** at the peak frame -- the report's `draws
without it` line reads 364, which is the figure that isolates them. The other
+72 is the flight: it is not the START that moved, it is that the flight now
actually begins there rather than up to 1.3 km downrange, so every earlier number
in that column was measured over a route nobody chose. 680 is 1.71x the new peak,
the same factor Phase 2b and 3a used, and still far under RULE 5's ceiling of
1200.

**The other three were not breached and are not raised.** They still hold about
1.5x, and a limit with less slack catches a regression sooner. The payload
budget's structural ceiling does rise: a deck adds up to 28 kB to a lod-0 node
and 70 kB to a root one, so the most expensive possible node goes from 129,744 to
about 158,000 bytes and the ceiling from ~108 MB to ~131 MB. 100 MB is still
below it and still fireable.

Per-node deck cost, measured over a 13x13 lod-0 square around a village: 18 of
169 nodes carry a deck at all, averaging 477 triangles and 12.7 kB, peaking at
1,068 triangles and 28.4 kB. A root-level node carrying a whole region's roads is
2,508 triangles and 1,104 vertices.

### Screenshots: 27 of 34 changed, 7 did not, and 3 were added

*(Read the section after this one before trusting `shots:check`: the eight
wireframe views that contain a deck are not currently reproducible.)*

Captured and diffed on the same Windows machine as the committed set, which is
the only way to tell a real change from the platform difference Phase 4b found.

**The 7 that did not change** are the ones with no road or village in frame:
`chunks-aerial`, `chunks-aerial-seed-beta`, `chunks-wireframe`,
`lod-ground-horizon`, `river-region-seam`, `terrain-mountain-profile`,
`water-shoreline-shallow`. That they are stable is the useful half of the result:
a deck appears where a road is and nowhere else.

**The 3 new ones**, and what each is for:

- **`road-bridge`** -- the view that says the phase happened. A road crossing a
  tidal river, deck spanning open water bank to bank, carriageway continuing both
  sides. If `DECK_BEAM` is ever lost this frame fills in solid, which is the dam.
- **`road-bridge-wireframe`** -- the structural claim in one image: the terrain
  lattice stops at the shoreline, the water lattice covers the channel, and the
  deck crosses both as its own ladder of triangles belonging to neither. Also
  where a deck emitted twice, or a run that failed to stop at a chunk boundary,
  would show as doubled or missing rungs.
- **`deck-lod-aerial`** -- straight down from 1.6 km: two villages, the road
  joining them, the drainage network and the coast. Every node on screen is lod
  3-5, where Phase 4a's per-vertex surfacing has washed out to a stain and the
  deck has not. That is the whole argument for per-chunk geometry, visible.

**Three existing views had their `expect` text rewritten rather than their
params.** `road-river-ford` was captured in 4a specifically to show the honest gap
where a road stopped at a riverbank; the gap is gone, and the entry now says so.
`road-wireframe-bench` and `settlement-streets-wireframe` both ended with "if a
later phase gives roads/streets their own geometry, this is the view that will
show it" -- and it did. Editing the params of a canonical view destroys the only
history the harness has; editing what it claims does not.

### `shots:check` IS RED ON THE WIREFRAME VIEWS, AND PHASE 5 DID NOT FIX IT

*(Closed in Phase 6a. Left exactly as written, because the two suspects below are
the record of what was believed at the time and the first one turned out to be
right for a reason nobody guessed -- the depth tie is real, but what decided it
was GPU-process state surviving a page, which is why the isolation experiment
recommended below returns "stable" and misleads. Read Phase 6a for the answer.)*

**This is the one thing this phase is shipping broken, and it is written down
here rather than smoothed over, because a flaky screenshot harness is precisely
what this project cannot afford to wave away.**

The state, measured over three separate runs against freshly captured baselines:

| views | result |
| ----- | ------ |
| 29 shaded views | **byte-identical on every run** |
| `chunks-wireframe` -- the one wireframe view with no deck in frame | **byte-identical on every run** |
| the other 8 wireframe views, all of which contain a deck | **a DIFFERENT hash on every run** |

So the instability is real, it is confined to wireframe, and it tracks the
presence of a deck exactly. The committed baselines are one capture of those
eight; `npm run shots:check` will report `8 changed` until this is fixed, and the
29 shaded views plus `chunks-wireframe` are still doing their job in the
meantime.

**What was tried and did not work.** The obvious suspect was Phase 1's ordering
flake in its Phase 5 form: a deck shared its node's `renderOrder` with the
terrain, so the tie between one node's deck and the NEXT node's terrain would
fall back to `material.id`, i.e. to whichever worker finished first. Decks now
draw in a band strictly above every terrain mesh in the world
(`DECK_RENDER_ORDER_BASE`). The change is kept, because "a deck draws after the
ground" is a sane invariant either way -- but it did NOT fix the flake, which
also rules the mechanism out: Three's opaque sort is fully determined once
`renderOrder` differs, before `material.id` is ever consulted.

**The two remaining suspects, for whoever picks this up.**

1. **WebGL has no `POLYGON_OFFSET_LINE`.** `polygonOffset` is what keeps the deck
   in front of coplanar ground, and it applies to filled polygons only. In
   wireframe the deck's lines and the terrain's are separated by `DECK_LIFT`
   (5 cm), which is well inside one depth-buffer quantum at the 1-4 km these
   views mostly contain -- about 2 m at 4 km with `near` 0.5 and `far` 8000. So
   the two sets of lines are at an exact depth tie over most of the frame, and
   something per-run is deciding it. This is the leading candidate and it also
   explains why only wireframe is affected.
2. **The deck's interior end caps are coincident duplicate geometry.** Every
   clipped run gets a cap at each end, so two consecutive runs put two
   coincident quads -- eight coincident triangles with both windings -- at the
   same joint. In shaded rendering they are invisible; in wireframe they are
   eight coincident line sets. Draw order within one mesh is index order and
   therefore deterministic, so this should not be it, but it is worth removing
   regardless (see the known gaps) and would take the question away.

**The isolation experiment to run first**, which was started and not finished:
capture one wireframe view several times **inside a single browser process** and
compare hashes. If they differ within one process, the randomness is per-capture
and the depth tie is confirmed; if they are stable within a process and differ
between processes, it is something about process start-up and the answer is
somewhere else entirely.

### Judgement calls worth knowing about

1. **Streets get decks, through the same extruder as roads.** This was the open
   decision 4b handed over, and one extruder with two sources is the same move
   `GradeBlend` made for two tiers of grading and `cell-heap.ts` made for two
   searches. A village whose road had a carriageway and whose lanes did not would
   read as a road passing an empty clearing. They differ only in palette and
   half-width, both of which come from their own records.
2. **The deck reads `gradeTarget`, not `nodeY`.** Discussed above; the version
   that read the road's own profile floated over every village. The bonus is that
   the deck now interpolates no altitude of its own.
3. **The cross-section is horizontal.** Sampling the ground at each edge and
   tilting the deck to match would make a road across a hillside a ramp and would
   fold the two triangles of every quad against each other. A roadbed is a bench;
   the apron is what covers the resulting cut on one side and fill on the other,
   which is what an embankment is.
4. **`polygonOffset` is the z-fight fix and a world-space lift is not.** The deck
   is coplanar with ground graded to the same target, which is the textbook decal
   problem. With `near` 0.5 and `far` 8000 the depth buffer resolves about two
   metres at 4 km, so any lift big enough to win out there would visibly hover in
   the near field. `DECK_LIFT` is 5 cm and does a different job -- making the deck
   unambiguously the upper surface for Phase 8 to stand on.
5. **The apron carries both windings with a single-sided material**, for the
   reason `SKIRT_TRIANGLE_COUNT` gives: a double-sided material flips the normal
   on back faces, and the underside of a bridge would shade near-black.
6. **Deck normals come from the deck**, in a fix-up pass once the neighbouring
   stations exist, rather than from the road's profile slope. The two differ
   wherever the deck follows the ground rather than the target, which is most of
   its length.
7. **Station spacing is the node's own vertex spacing** -- 2 m at lod 0, 128 m at
   the root. Anything finer would be geometry describing detail the terrain under
   it does not have; anything coarser would stop following it.
8. **`DECK_MAX_STATIONS` is a safety valve, not a level of detail.** It has never
   fired: the busiest measured node is under 400 stations against a cap of 4,096.
   It exists because the alternative is an unbounded allocation inside the
   generator. Truncation would be deterministic -- regions, paths, sectors,
   streets, all in fixed order -- so a node that hit it would still regenerate
   byte-identically.

### Known gaps, deliberately left

- **A bridge has no piers, no parapet and no abutment.** It is a deck with a
  0.8 m beam and daylight under it. That is enough to read as a bridge at the
  distances this project renders at and it is honestly not a structure; anything
  more belongs with Phase 6's buildings, which is where placed geometry starts.
- **A deck routinely stands clear of coarse ground, and that is correct but
  visible.** At lod 3 and beyond no vertex lies inside the roadbed, so the deck
  holds the target while the lattice under it smooths across. A road on gentle
  ground therefore reads as very slightly embanked from a distance. The
  alternative is the road disappearing into the hill, which is worse; the real fix
  is a finer lattice under a road and that is not on the roadmap.
- **The settlement pad has no deck.** A village is still a graded disc with lanes
  laid on it and nothing else -- Phase 6's lots and buildings are what will make
  it read as built. `settlement-footprint` remains the sparse "before" picture.
- **The ring street's closing node gets no miter.** The ring repeats its first
  node at the end rather than wrapping, which is what makes every street an open
  polyline downstream, so its two ends are polyline ENDS and the averaged
  cross-direction that rounds off every other corner does not apply there. The
  result is a few centimetres of notch at one node of every village ring.
- **A deck overhangs its node by up to `ROAD_HALF_WIDTH_MAX`**, where `groundAt`
  clamps to the padded grid's edge. That is at most 6 m of carriageway fitted to
  the nearest ground the node knows about rather than to the neighbour's. It has
  not been observed as an artefact and it is the reason the apron exists.
- **End caps are emitted at every clipped run, including interior joints**, where
  they are coincident with the next run's cap and invisible in shaded rendering.
  About 16 triangles per segment of waste -- and a suspect in the wireframe
  instability above, so removing them is worth doing for two reasons.
- **`shots:check` is red on the eight wireframe views that contain a deck.**
  Unresolved; see its own section above for what is known, what was ruled out and
  what to try first. Everything else in the harness is byte-identical.
  *(Closed in Phase 6a: `polygonOffset` left enabled in wireframe mode.)*
- **`polygonOffset` has not been verified on a real GPU.** Every screenshot in
  this project is SwiftShader; the depth-fighting behaviour it fixes is exactly
  the kind that differs between rasterisers.
- **Popping at a level switch is still quantified but unobserved**, unchanged
  since 2b. **Lighting is still the Phase 0 placeholder.** The bundle is one
  615 kB chunk plus a 33.7 kB worker (up from 28.6 kB: the worker now carries
  `road-mesh.ts`). Vite still warns.
- **The GPU verification is still not a committed command.** Phase 4a's note that
  landing it as `npm run perf:gpu` is worth doing stands, and 5 did not do it
  either -- so the two frame budgets have not been re-measured since 4a, and this
  is the first phase since then that could plausibly move them.

### For Phase 6

- **The deck is the model for anything placed on the ground.** Per-chunk
  geometry, clipped to the node square parametrically, fitted to the node's own
  `groundAt`, zero-length arrays where there is nothing. A building is not a
  ribbon, but every one of those four properties is the reason a deck survives
  the streamer, the LRU, the quadtree and the round-trip hash.
- **`gradeTarget` exists now** and is the right thing to seat a building on: it
  is where the ground WANTS to be, before the caps and the river yield, which is
  what a floor slab should sit at.
- **Draw calls are the budget to watch, and they are at 398 of 680.** A deck is
  one extra mesh per node carrying a road; buildings will be far denser than
  roads, so per-node batching -- one mesh for every building in a node -- is
  not an optimisation to defer.
- **`SectorStreets.streetStart` is still CSR and is still the way in.** A street
  is an open polyline including the ring, `streetsAt` hands it over without a
  region around it, and `road-mesh.ts` now demonstrates walking one and clipping
  it to a node.
- **Both memo limits are sized for a root node's working set** -- 16 regions,
  192 sectors -- and a phase adding a third per-vertex tier query should re-check
  them the way this one did. The failure mode is not subtle once you look for it,
  and it is completely invisible if you do not.
- **The soak's "at the start" numbers can be trusted now.** The flight is held at
  `?pos=` until the baseline is read, so a phase that wants a new signal in the
  round-tripped square can tune for it and get what it tuned for.
- **`shots:check` is much faster than it was**, for the memo reasons above rather
  than for anything Phase 5 removed. It is still the slowest command in the
  project.
- **FIX THE WIREFRAME INSTABILITY BEFORE ADDING GEOMETRY.** Phase 6 adds
  buildings, which will sit on the ground the same way a deck does and will land
  in the same wireframe views. Debugging one flake is much cheaper than
  debugging two, and the harness cannot judge Phase 6 until this is closed. The
  section above has the evidence, the ruled-out cause and the next experiment.

## Phase 6a -- The wireframe instability, closed (done)

Phase 5's last handoff note was **"FIX THE WIREFRAME INSTABILITY BEFORE ADDING
GEOMETRY"**, so this is that, and nothing else: no new content, no new geometry,
no change to any generated byte. It is written up as its own phase rather than as
a paragraph at the top of Phase 6 because it is independently verifiable, and
because what it cost is worth recording -- **Phase 5 shipped a red harness and
listed the wrong suspect as leading.**

The bug in one line: **`polygonOffset` is a fill-mode concept, and wireframe mode
was leaving it enabled.**

### The fix

`applyWireframe` in `src/render/renderer.ts` now switches every render state that
means something in only one of the two draw modes, rather than just the
`wireframe` flag:

```ts
function setPolygonOffset(material: THREE.Material, wireframe: boolean): void {
  const requested = material.userData[OFFSET_REQUESTED] as boolean | undefined;
  if (requested === undefined) {
    if (!material.polygonOffset) return;
    material.userData[OFFSET_REQUESTED] = true;
    material.polygonOffset = !wireframe;
    return;
  }
  material.polygonOffset = requested && !wireframe;
}
```

`glPolygonOffset` is gated on `GL_POLYGON_OFFSET_FILL`. Desktop GL has a
companion `GL_POLYGON_OFFSET_LINE`; **WebGL has no such enum at all**, so what a
line primitive's depth is while the state is enabled anyway is not specified by
anything. SwiftShader's answer turned out to depend on state that outlives a page
inside the GPU process -- which is why the flake had the one shape nobody was
looking for. See the measurement section: a wireframe view captured **first** in a
browser process was byte-stable, and the same view captured after **any** shaded
view came back different every time.

Three details of the fix are deliberate:

1. **The requested value is remembered on the material, not recomputed.** The
   deck asks for an offset in `chunk-mesh.ts` and the terrain does not, so
   "restore it" has to mean "restore what this material asked for" -- and the
   first call at start-up is normally `false`, since `?wireframe=1` is the rare
   path. Recording the wireframe value as the requested one would hand the
   terrain an offset the moment wireframe went off, i.e. give the ground an offset
   against the deck that is offset against it.
2. **The magnitudes are never touched.** `polygonOffsetFactor` and
   `polygonOffsetUnits` are what the deck needs while it is filled; only the
   enable bit moves.
3. **It lives in `renderer.ts`.** A material declares what it WANTS; the graphics
   boundary decides what is legal to ask for in the mode being drawn. Putting it
   in `chunk-mesh.ts` would mean every future placed mesh -- Phase 6's buildings
   first -- has to remember to do the same thing, which is the shape of bug that
   comes back.

### How it was found, and what each step ruled out

The value here is in the order, and specifically in the fact that **the first two
steps came back clean and that was the misleading part.** A flake whose isolation
experiment says "perfectly stable" is one you can spend a long time not finding.

1. **Capture the worst view repeatedly, alone.** `road-bridge-wireframe`, three
   times in fresh browser contexts and three times on the same page, with a scene
   fingerprint alongside each capture: mesh names, `renderOrder`, material ids,
   geometry hashes, camera matrices. **Every pixel hash identical.** So the scene
   is deterministic, the geometry is deterministic, and the view is perfectly
   reproducible -- on its own. This is the experiment Phase 5 asked for, and its
   answer was "stable", which reads as good news and is the opposite.
2. **Run it under load**, concurrently with `npm test` saturating the machine.
   Same hash. Timing, scheduling and rasteriser load are not involved -- which
   also kills the comfortable theory that a software rasteriser under a heavy main
   thread is simply racy.
3. **Capture a SEQUENCE in one process**, the way `shots:check` does. This is the
   step that produced a reproducer: `cube-wireframe` is byte-stable when captured
   first, and comes back with a **different hash on every pass** as soon as a
   shaded view precedes it in the same process. The flake was never per-view or
   per-capture; it was **per-process history**, and no amount of examining one
   view in isolation was ever going to show it.
4. **Look at the differing pixels rather than the hash.** About 0.5% of them, and
   they trace the deck lines in the FAR field only -- 1 km and beyond, where 5 cm
   of `DECK_LIFT` is well inside one depth quantum. Deck, wireframe, depth tie,
   far field: that is `polygonOffset` on lines. Confirming it took one line --
   `polygonOffset: false` in `createDeckMaterial` -- which turned all eight views
   stable at once, and is also the version that had to be rejected, below.

**What was ruled out, and one of them was Phase 5's second suspect.** The deck's
coincident interior end caps are still there, unchanged, and the harness is green,
so they were never the cause -- draw order within one mesh is index order, exactly
as Phase 5 reasoned before listing them anyway. `renderOrder` was already ruled
out in Phase 5 and stays ruled out. Nothing about worker completion order, memo
eviction or chunk residency is involved: the fingerprints in step 1 were
identical across runs, including geometry hashes.

**The wrong fix, and how we know it is wrong.** Dropping `polygonOffset` from the
deck material outright also fixes the flake, and it moved **every shaded view
too** -- which is the useful half of that experiment, because it is the direct
measurement that the offset is doing real work in fill mode. That is why the fix
is mode-switched rather than removed. Raising `DECK_LIFT` until it wins in the far
field was not attempted for the reason Phase 5 already wrote down: at 4 km the
depth buffer resolves about 2 m, and a deck lifted 2 m visibly hovers in the near
field.

### Two diagnostic scripts, promoted rather than deleted

Both were written to chase this and both answer a question `shots:check`
structurally cannot, so they are committed as commands instead of being thrown
away with the session that needed them.

- **`npm run shots:repeat -- --repeat=3 [view...]`** compares a view against
  ITSELF over several passes, in ONE browser process, in order. `shots:check`
  compares against a baseline, so "this view changed" and "this view is not
  reproducible" are the same red line -- and committing one capture of an unstable
  view bakes a coin flip into the repository, which is exactly what Phase 5 did.
  Capturing the sequence in one process is load-bearing, per step 3 above: a
  checker that opened a fresh browser per view would have reported green.
- **`npm run shots:diff -- a.png b.png [mask.png]`** reports how many pixels
  differ, by how much, the bounding box they occupy, and writes a greyscale mask.
  Step 4 is what it exists for. Dependency-free: Chromium screenshots are 8-bit
  non-interlaced PNGs, so a decoder is a page of code, and adding an image library
  to a project whose only runtime dependency is Three.js is the worse trade.

`shots/.repeat/` is gitignored, and `shots:repeat` deletes it on success so the
only captures left behind are the ones that disagreed.

### Verified

- **`npm run shots:repeat -- --repeat=3 cube-default cube-wireframe`, run both
  with and without the fix.** This is the anti-vacuity half and it is the most
  important number in the phase:

| run | `cube-default` (shaded) | `cube-wireframe` |
| --- | ----------------------- | ---------------- |
| fix disabled | STABLE `ed01177232b5` | **UNSTABLE: 3 distinct hashes over 3 passes** (`b287aedd5401`, `f8b1d96d5c59`, `e0fe2f45cb61`) |
| fix in place | STABLE `ed01177232b5` | STABLE `1f80ffd7f0de` |

  The reproducer still fails without the fix, so it is testing something. And the
  shaded view's hash is **the same twelve hex digits in both runs**, which is an
  independent confirmation that filled rendering is untouched.
- **`npm run shots`, then `git status`: exactly 8 files modified**, and they are
  the 8 wireframe views containing a deck. The other 29 came back
  **byte-identical to the baselines committed in Phase 5**, which is the same
  claim from the other direction. (Those 29 are 28 shaded views plus
  `chunks-wireframe`. Phase 5's write-up calls them "29 shaded views" and then
  lists `chunks-wireframe` separately, which counts it twice and adds up to 38 of
  37 views; the harness line `8 changed, 0 missing, 29 identical` is the correct
  split.)
- **`npm run shots:check` twice in a row: `all 37 canonical views are
  byte-identical to their baselines`, both times.** Before the fix, the same
  command over two consecutive runs read `8 changed, 0 missing, 29 identical`
  with a different set of hashes each time.
- **`npm test`: 446 tests in 21 files, all green**, including 5 new ones in
  `src/render/renderer.test.ts`. `applyWireframe` is exported for them, because
  constructing a `Renderer` needs a real canvas and a WebGL context, and this rule
  needs a unit test more than most of that file: its failure mode is invisible in
  the near field and shows up as an unreproducible screenshot rather than as a
  wrong picture. Both halves are asserted -- the offset must be GONE in wireframe
  (or the flake is back) and it must COME BACK when wireframe goes off (or every
  shaded view changes) -- plus the two traps in the fix: a material that never
  asked for an offset never acquires one, and starting in filled mode does not
  record "off" as what the material wanted.
- **`npx tsc --noEmit`: clean.**
- **`npm run soak`: `soak OK` over the full 300 s**, with the numbers in the next
  section. It is included for the rule rather than because this phase could move
  it: the soak flies in fill mode and never touches the code path that changed.

### Budgets: unchanged, and unchanged for a stated reason

No budget moves, and no budget could: this phase changes one enable bit on one
material while wireframe is on, and **every canonical view is captured in fill
mode except the nine wireframe ones, which are not what the budgets measure.**
The soak was re-run anyway, because "checked every phase" is the rule and a
re-derived number is the only way to notice something unexpected.

| Budget | Limit | 5 measured | 6a measured | headroom |
| ------ | ----- | ---------- | ----------- | -------- |
| live triangles | 2,100,000 | 1,368,596 | 1,201,194 | 1.75x |
| live vertices | 1,040,000 | 673,805 | 592,964 | 1.75x |
| draw calls | 680 | 398 | 357 | 1.90x |
| chunk payload bytes | 100 MB | 86.8 MB | 87.6 MB | 1.14x |

Unexplained heap trend **+1.30 MB/min against a limit of 6** (Phase 5: +0.96).
Round trip: 25/25 chunks re-resident, **25/25 geometry hashes identical**. All
five "at the start" counters real and unchanged: sea 16/25, river 9/25, road
12/25, street 10/25, deck 10/25. `soak OK`.

**Every geometry number came in LOWER than Phase 5's, and that is not an
improvement -- it is the flight not getting as far.** The autopilot is held
whenever the world is not ready, so on a slower machine state it lags: this run
returned to **x = -6,063** against a start of x = -6,749, where Phase 5's run
returned to exactly x = -6,749. So the camera covered about 686 m less of the
return leg and the peak sample landed somewhere marginally cheaper. The route is
a subset of Phase 5's rather than a different one, which is why the numbers are
comparable at all -- and it is worth writing down that **`draw calls 357` is not
this phase reducing draw calls.** The three claims that do not depend on how far
the flight got are the ones that matter here, and all three are equal to Phase
5's: 25/25 re-resident, 25/25 hashes identical, five real counters.

The frame budget is still not measured on real hardware. This run's worst frame
is 1,766 ms and 2,737 of 3,254 frames are over 20 ms, which is SwiftShader and
has been since Phase 0; `npm run perf:gpu` is still not a command.

### Known gaps, deliberately left

- **In wireframe, a distant deck's lines are now hidden by the terrain's rather
  than drawn over them.** This is the honest resolution of a genuine depth tie:
  coplanar lines resolve by draw order, and a deck draws after the ground it sits
  on, but `DECK_LIFT` (5 cm) is inside one depth quantum past about 1 km, so the
  ground wins out there. Near the camera the deck is in front, which is the case
  an author is actually inspecting. It is stable, which is the only property the
  harness needs.
- **The deck's interior end caps are still coincident duplicate geometry**, about
  16 wasted triangles per segment. Phase 5 listed them as an instability suspect
  and they were not it, so the reason to remove them is now purely the waste --
  which makes it a Phase 6 or later cleanup rather than a correctness fix.
- **`polygonOffset` is still unverified on a real GPU**, unchanged from Phase 5,
  and this phase adds a second unverified claim of the same kind: that dropping
  the offset in wireframe is stable on hardware too. Both are SwiftShader
  observations. The GPU verification is still not a committed command
  (`npm run perf:gpu`, wanted since Phase 4a).
- **The eight baselines were re-captured, and only one of them has been read
  closely.** `road-bridge-wireframe` was checked against the claim Phase 5 made
  for it and still holds it: the terrain lattice stops at the shoreline, the water
  lattice covers the channel, and the deck crosses both as its own ladder of
  triangles belonging to neither -- which is the structural picture the view exists
  for, and it is the one place a deck is UNAMBIGUOUSLY visible in wireframe,
  because a bridge is not coplanar with anything. The other seven were only
  verified to be stable. What is lost is far-field deck lines where the deck lies
  flush, which is exactly where they were previously fighting; if a later phase
  wants those visible, it is a `depthTest`/`renderOrder` decision on the deck
  material and not a return to `polygonOffset`.

### For Phase 6

- **The harness is trustworthy again: 37 of 37, twice.** Everything Phase 5's
  handoff said about Phase 6 stands, with the blocker removed.
- **`shots:repeat` is the first thing to run on a new canonical view**, before
  committing its baseline. That is the check that would have caught Phase 5's
  problem at the moment it was introduced, and it costs one command.
- **Buildings will land in the same wireframe views, and the rule that keeps them
  reproducible is in `renderer.ts`, not in the mesh code.** A new material may ask
  for `polygonOffset` freely; `applyWireframe` will do the right thing with it.
  What a new material must NOT do is set graphics state that only applies in one
  draw mode anywhere else, because that path has no owner.
- **The wireframe views are the ones that will judge Phase 6's geometry**, and
  they are now sensitive: `settlement-streets-wireframe` and
  `road-wireframe-bench` both went from "different every run" to "one hash", so a
  building appearing in them is a real signal rather than noise.
