# Progress

One phase per session, fresh context. This file plus `ARCHITECTURE.md` is how
state moves between sessions. Update both at the end of every phase.

| Phase | Title                              | Status |
| ----- | ---------------------------------- | ------ |
| 0     | Scaffold and verification harness  | Done   |
| 1     | Chunk streaming skeleton           | Done   |
| 2a    | Terrain heightfield                | Done   |
| 2b    | Quadtree LOD                       | Done   |
| 3     | Water                              | Next   |
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
