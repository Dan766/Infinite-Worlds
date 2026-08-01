# Architecture

Read this and `PROGRESS.md` before writing any code. Update both when done.

## What this is

An infinite, procedurally generated 3D world that runs entirely as a static
browser build. No backend, no server-side generation, no runtime asset fetching
beyond static files.

## Stack (fixed -- do not substitute)

| Concern         | Choice                                                     |
| --------------- | ---------------------------------------------------------- |
| Language        | TypeScript, strict mode                                     |
| Bundler         | Vite, target `esnext`, `base: './'`, output `/dist`          |
| Renderer        | Three.js, WebGL2, behind a `Renderer` wrapper                |
| Post-processing | `postprocessing` (pmndrs) -- **Phase 11, not yet installed** |
| Generation      | Web Workers (Phase 1); zero generation on the main thread   |
| UI              | None. Plain classes and a fixed-timestep loop.               |

No game engine, no React, no state library.

## Non-negotiable rules

1. **Determinism.** Every piece of world content is a pure function of
   `(worldSeed, coordinate)`. Same seed and coordinate produce byte-identical
   output forever, regardless of visit order or what else is loaded. Use the
   counter-based hashes in `src/core/hash.ts`; never a sequential PRNG whose
   state depends on call order.
2. **No global mutable world state.** Chunks may be unloaded and regenerated at
   any time and must come back identical.
3. **Tiered generation.** Content is generated coarse to fine:
   `Region (4km) -> Sector (512m) -> Chunk (64m)`. A finer tier may read from
   coarser tiers. A coarser tier may **never** read from a finer one. Anything
   spanning chunks -- roads, rivers, settlements -- is decided at the tier that
   fully contains it.
4. **Stable interfaces.** `src/world/contracts.ts` (Phase 1) is load-bearing. If
   a phase requires changing it, stop and explain the change before writing code.
   Adding a field to `ChunkData` is expected as terrain arrives; renaming or
   reshaping `ChunkCoord`, `ChunkProvider` or `TierContext` is not.
5. **Budgets are hard limits**, checked every phase against the perf HUD:
   60fps at 1080p on integrated graphics; <=1200 draw calls; <=400MB JS heap
   after 5 minutes of continuous movement; <=16ms main-thread frame time with no
   GC spikes above 4ms.

## Module map

```
src/
  main.ts               entry point; builds App, exposes window.__app
  app.ts                object graph and wiring; owns window.__worldReady
  core/
    hash.ts             hash2i / hash3i / hashString / rngFromHash  (RULE 1)
    loop.ts             fixed-timestep loop; pausable, single-steppable
    params.ts           URL parameters in and out
    camera-rig.ts       free-fly camera
    autopilot.ts        deterministic ?fly= flight path, for the soak test
  world/
    contracts.ts        ChunkCoord / ChunkData / ChunkProvider / TierContext
    chunk-gen.ts        pure generation; runs in the worker AND in Node tests
    chunk-worker.ts     the Web Worker entry point
    worker-protocol.ts  the main-thread <-> worker message contract
    worker-pool.ts      pool, priority queue, cancellation; is a ChunkProvider
    priority-queue.ts   keyed binary min-heap with in-place re-ranking
    lru-cache.ts        entry-capped LRU with an eviction hook
    chunk-mesh.ts       the only file in world/ that imports Three.js
    chunk-streamer.ts   load/unload by radius; owns the HUD lines and toggles
  render/
    renderer.ts         the ONLY module that touches THREE.WebGLRenderer
  scene/
    cube.ts             placeholder content; demonstrates the registries
  debug/
    hud.ts              perf HUD and its line registry
    frame-timer.ts      rolling fps / frame-time / spike statistics
    panel.ts            lil-gui debug panel and its control registry
scripts/
  shot.mjs              one screenshot of one URL
  shots.mjs             capture canonical baselines
  shots-check.mjs       re-capture and byte-compare against baselines
  verify-subpath.mjs    prove the build (and its workers) run from a nested path
  soak.mjs              5-minute headless flight; heap trend, chunk churn, frames
  lib/                  shared browser, static-server, and canonical-run helpers
shots/
  canonical.json        the fixed viewpoint list
  *.png                 committed baselines
```

## Key boundaries

### `Renderer` is the graphics API boundary

`src/render/renderer.ts` is the only file permitted to construct or touch
`THREE.WebGLRenderer`. Everything else uses `render()`, `resize()`,
`setWireframe()`, `invalidateMaterials()`, and `stats()`. That keeps a later
WebGPU swap a change to one file, and gives the HUD a single place to read
per-frame draw call and triangle counts from.

Subsystems that add meshes at runtime must call `renderer.invalidateMaterials()`
so wireframe mode reaches the new objects.

### Simulation time is an integer tick, never wall clock

`Loop` accumulates wall time and runs whole `fixedDt` steps (1/60s by default),
clamped to `maxSubSteps` so a slow frame cannot spiral. Simulation time is
always exactly `tick * fixedDt`.

Everything that animates must derive from `simTime`, never from `Date.now()` or
the rAF timestamp. This is what makes `?time=` reproduce an exact world state
and what makes two screenshots of one URL match.

The camera is deliberately *not* part of simulation state: it keeps moving while
the sim is frozen, because freezing exists so you can fly around a paused world
and inspect it.

### Registries, not hardcoded lists

Every subsystem registers its own HUD line and debug toggle rather than being
enumerated in `hud.ts`, `panel.ts`, or `app.ts`:

```ts
hud.register('chunks', () => streamer.loadedCount, HudOrder.world);
panel.folder('Streaming').addToggle('enabled', () => on, (v) => (on = v));
```

`hud.register` replaces by label, so Phase 1 supplies real values for the
placeholder `chunks` and `worker queue` lines without editing `app.ts`.

### World generation never touches the main thread

`src/world/` is layered so that only one file in it knows about Three.js:

```
contracts.ts   types only        importable from a worker and from Node
chunk-gen.ts   pure functions    the worker and the unit tests run the same code
worker-pool.ts scheduling        no DOM, no Three; `spawn` is injectable
chunk-mesh.ts  Three.js          the boundary where payloads become GPU objects
```

That layering is what lets `npm test` cover determinism, priority ordering,
cancellation and eviction with no browser at all. Keep it: the moment
`chunk-gen.ts` imports Three, the generator stops being testable in Node and
starts dragging a renderer into every worker.

Payloads cross the boundary as transferred `ArrayBuffer`s, never as clones. If
you add bulk per-vertex data to `ChunkData`, add it as a typed array and add its
buffer to `chunkDataTransferables`.

### Chunk draw order is derived from the coordinate

Three.js sorts opaque draws by `renderOrder`, then `material.id`, then depth.
Material ids are handed out in construction order, so without an explicit
`renderOrder` chunks are drawn in whatever order their workers finished --
which differs between runs. Solid quads do not care; wireframe does, because
neighbouring chunks draw their shared edge at identical depth and the first one
drawn wins. `chunk-mesh.ts` therefore sets `renderOrder` from the chunk
coordinate. Without it, `shots:check` fails intermittently on the wireframe
views.

### `window.__worldReady` waits for the world, not just for a frame

Since Phase 1 it means "two frames rendered AND every chunk in range resident".
A screenshot harness that fired on the first frame would catch a half-streamed
world and the byte comparison would go permanently flaky.

## Verification

The whole point of Phase 0. Checking later phases should cost nothing but
running a command and looking at a browser.

### Any view is a URL

| Parameter    | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `?seed=`     | world seed string; hashed to uint32            |
| `?pos=x,y,z` | camera position                                |
| `?look=`     | `yaw,pitch` in degrees                         |
| `?freeze=1`  | start paused                                   |
| `?time=`     | seek the simulation to an absolute time, in seconds |
| `?hud=0`     | hide the perf HUD                              |
| `?panel=0`   | hide the debug panel                           |
| `?wireframe=1` | start in wireframe                           |
| `?fly=`      | autopilot speed in m/s along X; 0 is off       |
| `?flyleg=`   | seconds the autopilot travels before reversing |

Malformed values fall back to defaults rather than throwing. In the browser,
`__app.currentUrl()` returns a link reproducing exactly what is on screen; the
panel's **copy link to this view** button does the same.

### Screenshots

```
npm run shots         # capture canonical baselines into shots/
npm run shots:check   # re-capture and byte-compare; exits non-zero on any change
npm run shot -- <url> <name> [--raw]
```

Three things make byte-identical comparison possible:

- **The HUD is hidden.** fps and heap can never match between two runs, so
  `canonicalizeUrl` forces `hud=0&panel=0&freeze=1` on every canonical view.
- **The GPU backend is pinned to SwiftShader.** Otherwise a machine with a real
  GPU produces different pixels from a CI container and the committed baselines
  are worthless.
- **Captures wait on `window.__worldReady`, never on a timer.** A sleep-based
  harness starts producing flaky diffs as soon as a phase adds async work.

`shots:check` also guards the two ways a screenshot harness can pass while being
broken: a frame that rendered nothing (measured as distinct-colour count), and
all canonical views collapsing to the same image. Both would otherwise sail
through a byte comparison. This is not hypothetical -- it happened during Phase 0
and the check now catches it.

`--raw` skips canonicalisation so the HUD and panel can be captured while
debugging. Never use a `--raw` shot as a baseline.

### Static subpath

```
npm run verify:subpath
```

`base: './'` means the build runs from any static host at any path depth. This
serves `dist/` from a deliberately nested mount and asserts zero failed requests
plus a rendered frame.

A literal `file://` open cannot work with this stack: Chrome blocks ES module
scripts over `file://` for CORS reasons, and Phase 1's Web Workers hit the same
wall. Serving over HTTP from an arbitrary subpath is the real, durable property.

Since Phase 1 this also checks the worker specifically, because a worker is the
likeliest thing to break a nested deploy: `new Worker('/assets/...')` passes
every localhost test and 404s under a subdirectory. The worker must be spawned
as `new Worker(new URL('./chunk-worker.ts', import.meta.url), {type:'module'})`,
which Vite rewrites to a URL resolved relative to the importing module. The
check asserts the worker asset was fetched from inside the mount path and that
chunks actually streamed -- chunks exist only if a worker answered.

### Soak

```
npm run soak                    # the 5-minute acceptance run
npm run soak -- --seconds=60    # quick smoke run while iterating
npm run soak -- --speed=90 --interval=10 --seed=whatever --no-build
```

Flies `?fly=` along a triangle wave for the requested duration and reports the
JS heap at intervals (trend, not just endpoint), live and cached chunk counts,
generation and eviction totals, worst frame time, and whether chunk colours
where the flight started match after the round trip. Heap samples are taken
after a forced `HeapProfiler.collectGarbage` over CDP, or the reading would
measure uncollected garbage rather than a leak.

It exits non-zero on a post-warmup heap slope above 6 MB/min, on a peak heap
over 400MB, on over 1200 draw calls, on a colour mismatch across the round
trip, or on any page error.

Like `shots:check`, it guards against passing while nothing happened: a soak run
over an empty world would show a beautifully flat heap. It fails if fewer than
50 chunks were ever resident, if no more chunks were generated than were ever
resident at once, if too few frames were drawn, or if the camera barely moved.

Note that a short run legitimately shows a positive heap slope, because the LRU
cache is still filling. It flattens once the cache reaches its cap, which at the
default speed takes about 40 seconds. Judge the trend on a full-length run.

Re-run this at every subsequent phase. A leak introduced in Phase 6 is far
cheaper to find in Phase 6 than in Phase 11.

## Commands

```
npm run dev            # dev server on :5173
npm run build          # tsc --noEmit && vite build
npm run preview        # serve dist/ on :4173
npm test               # vitest
npm run shots          # write screenshot baselines
npm run shots:check    # verify nothing visual changed
npm run verify:subpath # verify the build survives a nested deploy path
npm run soak           # 5-minute headless flight; fails on a heap leak
```
