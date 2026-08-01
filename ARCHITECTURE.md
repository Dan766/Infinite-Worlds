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

   **One reshape was authorised, in Phase 2a, and is now settled.** `ChunkCoord`
   gained `readonly lod`, `chunkKey` became `x,z,lod`, `chunkSizeAt(lod)` was
   added, and `worldToChunk` / `chunkOrigin` / `chunkCenter` became lod-aware.
   It was done at the phase that forced it rather than in Phase 2b, which is
   what actually varies `lod`, because a chunk key is a cached, cross-thread
   identity: adding a component to it later would silently alias a lod-0 chunk
   with a coarser node over the same square, and the symptom would be a
   corrupted cache rather than a compile error. Throughout Phase 2a `lod` is
   always 0. This is not a precedent — RULE 4 still stands.

   **Phase 2b, which is what actually varies `lod`, changed nothing here.**
   That was the point of doing it early, and it worked.
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
    noise.ts            gradient noise, fBm, ridged multifractal, domain warp
    height-field.ts     sampleHeight + SEA_LEVEL + the four biome fields. THE terrain.
    chunk-gen.ts        pure generation; runs in the worker AND in Node tests
    chunk-worker.ts     the Web Worker entry point
    worker-protocol.ts  the main-thread <-> worker message contract
    worker-pool.ts      pool, priority queue, cancellation; is a ChunkProvider
    priority-queue.ts   keyed binary min-heap with in-place re-ranking
    lru-cache.ts        entry-capped LRU with an eviction hook
    quadtree.ts         node selection: pure arithmetic, no state, no Three
    chunk-mesh.ts       the only file in world/ that imports Three.js
    chunk-streamer.ts   quadtree residency; owns the HUD lines and toggles
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
contracts.ts    types only       importable from a worker and from Node
noise.ts        pure functions   no Three, no DOM, built on core/hash.ts
height-field.ts pure functions   sampleHeight; the single source of terrain truth
chunk-gen.ts    pure functions   the worker and the unit tests run the same code
worker-pool.ts  scheduling       no DOM, no Three; `spawn` is injectable
chunk-mesh.ts   Three.js         the boundary where payloads become GPU objects
```

That layering is what lets `npm test` cover determinism, priority ordering,
cancellation and eviction with no browser at all. Keep it: the moment
`chunk-gen.ts` imports Three, the generator stops being testable in Node and
starts dragging a renderer into every worker.

Payloads cross the boundary as transferred `ArrayBuffer`s, never as clones. If
you add bulk per-vertex data to `ChunkData`, add it as a typed array and add its
buffer to `chunkDataTransferables`. A buffer left off that list is not a missed
optimisation: it gets structured-cloned instead, copying the whole mesh on the
worker thread and again on the main thread, for every chunk, forever.
`chunk-gen.test.ts` asserts the list is complete.

### `sampleHeight` is the only description of the ground

`src/world/height-field.ts` owns the shape of the world. The chunk generator
calls it per vertex inside a worker; `src/scene/cube.ts` and `App`'s default
camera call it on the main thread. There is deliberately no second, cheaper
copy: the moment two exist they drift, and the symptom is objects floating
above or sinking into ground that renders correctly.

Two consequences worth keeping:

- **Nothing on the path from `(x, z)` to a stored vertex may use `Math.pow`,
  `Math.sin`, `Math.cos` or `Math.exp`.** ECMAScript only *approximates* those,
  so two engines may disagree in the last bits, and that value ends up in a
  buffer RULE 2 says must come back identical. `Math.sqrt` and the `Math.SQRT2`
  / `Math.SQRT1_2` constants are exact and are fine.
- **Normals come from the height field, not from the triangles.** Triangle
  normals are discontinuous at every chunk border, and the seam would be a
  lighting crease along every 64 m boundary in the world. `chunk-gen.ts`
  samples a one-cell MARGIN beyond the node and takes central differences, so
  two neighbouring chunks compute the same normal at a shared vertex because
  they evaluate the same function at the same world position.

### The quadtree bounds NODE COUNT, not triangle count

Phase 2b's design follows from a profile of Phase 2a on real hardware (Intel
Arc 140V, 1080p): **1.46 ms median GPU render for the entire scene**, about 11x
headroom, while a 3 km flat-LOD radius cost **1,834 draw calls and 504 MB of
heap**. Frame time was never the problem. Draw calls and memory were.

`SEGMENTS` is therefore fixed at 32 for every level, so **a node costs the same
74,676 bytes and 2,560 triangles whatever area it covers**. That is the whole
trick: it makes node count the only quantity worth bounding, and a quadtree
bounds it to about 300 for 4 km of terrain where a flat lod-0 disc would need
12,000.

Do not lower `SEGMENTS` because the dev container renders slowly. The container
has no GPU; its numbers come from SwiftShader and are a measurement artifact.

Three properties hold this together:

- **Selection is a pure function of camera position.** `selectQuadtree` takes
  `(cameraX, cameraZ, viewDistance, splitFactor)` and nothing else -- not call
  history, not what is resident, not the direction of approach. Split while
  `distance(camera, nodeCentre) < splitFactor * nodeSize`; keep any node whose
  square comes within `viewDistance`.
- **The split test has no hysteresis, deliberately.** A hysteretic split test
  makes the resident SET depend on the route taken to a position. Per-node
  content stays deterministic either way, but a settled screenshot and the
  soak's round trip would both go path-dependent, and no byte comparison can
  tell that apart from a real regression.
- **Unload hysteresis is conditioned on residency, not distance.** A node that
  stops being selected survives until whatever replaced it is in the scene --
  a parent until its four children are up, four children until their parent is.
  Retire on deselection instead and a hole flashes through the ground for every
  frame a split takes to stream; use a distance margin instead (the obvious
  design, and Phase 1's) and a ring of stale nodes lingers whose contents depend
  on where the camera has been. Conditioning on residency gives a margin that is
  transient by construction: **once nothing is streaming, live == selected,
  exactly.** The LRU cache is what makes that affordable.

Horizontal distance, not 3D: using the camera's height would push the ground
under your own feet to lod 2 while standing on a 300 m peak, and it bounds node
count no better.

### Cracks are closed with skirts, never with stitched edges

Two nodes at different levels sample their shared edge at different rates, so a
crack opens between the coarse node's straight line and the fine node's terrain.
The textbook fix -- stitching the fine edge down to the coarse sample rate --
is rejected here for two concrete reasons:

1. It makes a node's index buffer a function of its **neighbours' levels**, so
   the same node comes back with different bytes depending on what was next to
   it. That is a direct RULE 2 violation and the soak would catch it.
2. It forces a main-thread mesh rebuild every time any neighbour changes level.

Instead every node carries an apron hanging straight down from its border, built
in the worker, depending on nothing but `(seed, coord)`. Its depth is three
times the largest step between adjacent border vertices -- proportional to the
local terrain, so a plain gets 1 m and a 1 km mountain node gets ~20 m, rather
than a fixed fraction of relief that would hang a 200 m curtain off every node.

The apron carries **both windings** and the material stays single-sided. A
double-sided material is the obvious alternative and is wrong: Three.js flips
the normal on back faces, the apron copies the surface normal, and the flipped
copy shades near-black -- so two same-level neighbours, whose aprons are
coincident, z-fight a lit face against a black one along every node boundary in
the world. That was visible in the first Phase 2b capture. With both windings
present, whichever copy faces the camera is drawn with the surface's own normal
and the coincident aprons are bit-identical, so their z-fight is invisible.

Popping is handled by threshold tuning alone -- no geomorphing, no custom
shader, so Phase 11 is free to replace the material outright.

### `SEA_LEVEL` is one constant, and the water is per-chunk geometry

Sea level was implicit at height 0 until Phase 3a: `sampleHeight` returned
negative values in basins and `surfaceColor` faded silt into sand somewhere
near zero, with nothing connecting the two. `height-field.ts` now exports
`SEA_LEVEL`, and the surface palette's altitude bands, the snow line and the
water surface all read it. Changing it moves the coastline coherently. It lives
with the height field rather than with the mesher because it is a property of
the world -- Phase 3b's rivers drain to it and Phase 8's swimming test is
against it.

**Water is generated per chunk, in the worker, like everything else.** A single
plane the size of the view distance is the obvious alternative and is worse in
three specific ways: it has to be clipped to whatever the quadtree currently
covers, it cannot carry per-vertex depth shading, and its extent is a function
of camera position, which is exactly the state RULE 2 keeps out of chunk
content. Per-chunk geometry gets all three for free -- water exists exactly
where chunks do -- and the soak's round-trip hash covers it.

Two things terrain needs and water does not:

- **No skirt.** A crack at a level boundary exists because two nodes sample a
  *curved* surface at different rates. The water surface is the plane
  `y = SEA_LEVEL` at every level, so neighbours agree on their shared edge
  exactly and there is nothing to crack.
- **No normal in the payload.** Every water normal is +Y; `chunk-mesh.ts` fills
  the attribute in on the main thread rather than shipping 1,089 copies of a
  constant through `postMessage` for every coastal node in the world.

**The one discipline that keeps this inside budget: a node with no ground below
sea level emits zero water vertices and gets no water mesh at all.** About nine
tenths of the world is inland. An empty water plane on every node would cost a
draw call each to draw nothing, and draw calls are the budget this project is
actually near.

The water grid is the terrain grid, at full `SEGMENTS` resolution, which looks
wasteful for a flat surface and is not negotiable. A quad is emitted when any of
its four corners is below sea level, and the rendered terrain inside a quad is
the linear interpolation of those same four corners -- so that test is exactly
"rendered ground dips below the sea here". Two properties follow: no ground that
renders below sea level is left uncovered, and every emitted quad has at least
one submerged corner and therefore some non-zero alpha. A coarser water grid
breaks the second (a quad whose corners are all dry shades to alpha 0 and leaves
a patch of bare sea floor), and every repair for that either reintroduces a hard
edge at the shore or makes a vertex's colour depend on which side of a chunk
border it was computed from, which is a seam along every boundary in the world.

**The shoreline is soft because alpha is exactly zero at zero depth.** Opacity
is `WATER_ALPHA_MAX * sqrt(depth / WATER_ALPHA_FULL_DEPTH)`, so the sea fades
out as the floor rises to meet it instead of stopping at some minimum opacity.
That, and not a shader, is what stops the intersection reading as a line. It
also means the water plane may overlap the beach harmlessly: where the ground is
above sea level the water is both occluded and transparent.

**Water is the project's first transparent geometry, and it carries the same
coordinate-derived `renderOrder` the terrain does.** Three sorts transparent
draws by `renderOrder`, then view depth, then *object id* -- construction order,
i.e. whichever worker finished first. A perfectly flat surface makes depth ties
easy to arrange, so without an explicit order `shots:check` would go
intermittently red exactly as it did in Phase 1. Ordering water back-to-front is
neither needed nor attempted: the sea is one plane cut into disjoint squares, so
no two water fragments overlap and blend order between nodes is unobservable.

### Surface colour is baked in the worker, not in a shader

Per-vertex colours by slope, altitude and climate, computed in `chunk-gen.ts`
and uploaded as a `color` attribute against a `vertexColors` material. The
roadmap's triplanar splat is Phase 11. Keeping the palette here means
`chunk-gen.ts` stays the single testable source of truth for what the world
looks like — a Node test asserts that a cliff is grey and a cold peak is white
without a GPU — and leaves the material dumb enough for Phase 11 to replace
outright.

### Chunk draw order is derived from the coordinate

Three.js sorts opaque draws by `renderOrder`, then `material.id`, then depth.
Material ids are handed out in construction order, so without an explicit
`renderOrder` chunks are drawn in whatever order their workers finished --
which differs between runs. Solid quads do not care; wireframe does, because
neighbouring chunks draw their shared edge at identical depth and the first one
drawn wins. `chunk-mesh.ts` therefore sets `renderOrder` from the chunk
coordinate. Without it, `shots:check` fails intermittently on the wireframe
views.

Since Phase 2b the order folds in `lod` too: a node and its parent share
`(x, z)` for one of the four children, and both are resident while a split
streams in, so `(x, z)` alone would let them collide and fall back to material
id -- i.e. to worker completion order -- which is precisely the flake this
exists to remove.

### `window.__worldReady` waits for the world, not just for a frame

Since Phase 1 it means "two frames rendered AND every chunk in range resident".
Since Phase 2b that is the stronger statement "every SELECTED node is in the
scene", not merely "nothing is outstanding" -- with several levels arriving
asynchronously, the weaker form would let a capture fire while a coarse node was
still standing in for four fine ones.
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

One asymmetry, added in Phase 2a: when `pos` is **absent**, the default `y` is
read as metres above the ground rather than as an absolute altitude, because a
fixed default height is underground on one seed and in the clouds on the next.
An explicit `?pos=` is always absolute — a URL has to mean exactly one thing or
the screenshot harness stops reproducing. `__app.currentUrl()` serialises the
resolved absolute position, so copying a link is unaffected.

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

Captures wait up to 120 s for `window.__worldReady` (raised from 30 s in Phase
3a). That is a wall-clock allowance for a software rasteriser, not a correctness
threshold -- waiting on readiness is what makes the byte comparison meaningful,
so a generous limit loosens nothing, while a harness that goes red under load
teaches people to re-run until green.

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
generation and eviction totals, worst frame time, geometry volume, and whether
the chunks where the flight started come back **byte-identical** afterwards.
Heap samples are taken after a forced `HeapProfiler.collectGarbage` over CDP, or
the reading would measure uncollected garbage rather than a leak.

**Two legs, two camera pitches, since Phase 2b.** The outbound leg keeps Phase
2a's angle; at the turn-around the camera drops to 3 degrees below the horizon
and the return leg is where every geometry budget is judged. This is not
decoration. Phase 2a's budgets were set from a steeply pitched flight, where
frustum culling throws most of the world away, so the draw-call budget read 105
against a limit of 1200 and **could not have failed however bad things got**.
The run now also fails if the shallow leg produced fewer than 3 samples or
peaked under 55 draw calls, so a canary pointed at nothing is a failure rather
than a pass.

The round-trip check hashes each chunk's uploaded **position buffer**, and since
Phase 3a its **water positions and water colours** as well. Phase 1 compared flat
colours, which could only ever prove the coordinate hash was pure. Hashing the
vertex bits proves the thing that is actually expensive to reproduce, and it is
the direct statement of RULE 2. Keep it for every remaining phase.

**The flight starts over water, and that is load-bearing.** The autopilot flies
along X from a fixed start; on seed `soak` the line `z = 0` is dry for all
6.75 km of it, so every water assertion the phase added would have passed by
never encountering any sea. The start moved to `(-7000, -3500)`, which is 3.5 km
of open water with a coastline and mountains beyond it, and the run now fails if
no water was generated, if no water was ever *drawn*, if the shallow leg drew
none, or if the round-tripped chunks contained no sea. Water existing and water
rendering are different claims; `waterDrawCalls` is counted from
`Object3D.onBeforeRender`, so it measures the second one.

It exits non-zero on a post-warmup slope above 6 MB/min in the heap NOT
accounted for by chunk payload, on a peak heap over 400MB, on a geometry budget breach, on a geometry mismatch across the round
trip, or on any page error.

**GPU-independent budgets are hard failures since Phase 2a**, because they are
the only budgets this container can honestly judge:

| Budget                        | Limit     | Phase 3a measured (over water)  |
| ----------------------------- | --------- | ------------------------------- |
| live triangles                | 2,100,000 | 1,229,124 peak                  |
| live vertices                 | 1,040,000 | 610,917 peak                    |
| draw calls                    | 500       | 292 peak (199 terrain + 93 water) |
| chunk payload bytes           | 100 MB    | 92.5 MB peak                    |

The first three are the Phase 3a peaks with roughly 1.7x headroom, measured on
a flight whose shallow-pitch leg crosses 3.5 km of open sea. They are still far
tighter than the project ceiling of 1200 draw calls: the ceiling says what the
hardware can take, these say what the world costs today, so a regression fails
instead of quietly consuming slack.

**All four Phase 2b limits were breached on purpose, and 2b said so in
advance.** Water is one extra mesh per submerged node, so draw calls roughly
double over open sea, and a node entirely at sea carries 55,068 bytes and 2,048
triangles more than an inland one. The instruction was to re-derive with a
stated number rather than raise them quietly; the numbers are above.

`chunk payload bytes` is the one that cannot have 1.7x headroom, and pretending
otherwise would make it unfireable -- the mistake Phase 2a made and 2b caught.
It is structurally capped: 512 cached nodes over a live set of ~318, at 129,744
bytes for the most expensive possible node, puts the absolute ceiling near
108 MB. 100 MB is 1.08x the measured peak and below that ceiling, so a per-node
size regression still trips it. The cost of that tightness is real: a flight
spending its whole length over open ocean rather than half of it would
legitimately approach 104 MB. `bytes per chunk` in the soak report is the figure
that separates a genuine regression from a wetter route.

**The heap trend is fitted on heap MINUS chunk payload since Phase 3a.** The
resident payload now depends on where the camera is -- a node at sea costs 74%
more than an inland one -- so on a flight that starts at sea, crosses a coast
and comes back, the raw heap is a V. A least-squares line through a V whose
warm-up window clips one arm reported +13.3 MB/min on a run that ended 8 MB
above where it started. Nothing was wrong with the window; the quantity was
wrong. A leak is heap the streamer is not knowingly holding, so that is what
gets the trend line, and the payload keeps its own hard budget. This is a
stronger leak detector, not a weaker one: a retained mesh whose cache entry has
already been evicted -- exactly what explicit disposal exists to prevent --
leaves the streamer's byte count and stays in the heap, so it shows up here and
in nothing else. The raw trend is still printed.

fps and frame time are deliberately NOT failures: see below.

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
npm test               # vitest (60 s per-test timeout; the streaming tests
                       #  generate hundreds of real chunks inside one `it`)
npm run shots          # write screenshot baselines
npm run shots:check    # verify nothing visual changed
npm run verify:subpath # verify the build survives a nested deploy path
npm run soak           # 5-minute headless flight; fails on a heap leak
```
