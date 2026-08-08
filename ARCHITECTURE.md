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

   **One exception is planned, for Phase 9's NPCs, and it is named and bounded
   rather than a precedent.** An NPC's position will be a pure function of
   `(worldSeed, sector, birthTick)` plus fixed ticks elapsed since birth, not of
   `(worldSeed, coordinate)` alone — crowds are simulated agents that step once
   per fixed tick (`stepCrowd`), not closed-form functions of `simTime` the way
   `cube.ts`'s rotation and the autopilot's flight path are. Leave a village and
   come back later and the crowd re-births at the current tick rather than
   picking up where continuous simulation would have left it. This was chosen
   deliberately over a closed-form "ambient walker" design (position fixed by
   tick, only orientation/animation allowed to react) because the latter was
   judged too lifeless for what NPCs are for — see the Phase 9 entry in
   `PROGRESS.md` for the full tradeoff. Two things keep it from breaking the
   verification apparatus RULE 2 exists to protect: NPCs step from the FIXED
   update, so every canonical screenshot (`freeze=1`, zero fixed updates) sees
   only a crowd's tick-pure birth state; and NPCs are a main-thread overlay, not
   chunk content, so they add nothing to `ChunkData`, to `CHUNK_DATA_VERSION`, or
   to the chunk payload the soak's round-trip hash actually covers. RULE 2 still
   stands for everything else, including RULE 4's own precedent-immune reshape.
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

   **The two frame budgets were unverifiable from Phase 1 to Phase 4a** -- the
   dev container has no GPU -- and were measured on real hardware after 4a
   landed: 60 fps at 1080p on an Intel Arc 140V, p99 main-thread work 6.5 ms,
   worst main-thread GC 5.45 ms. The first two pass; **the GC limit does not**,
   and is recorded as missed in `PROGRESS.md`. See "Measuring the frame budgets"
   under Verification for how, and for the two ways of measuring this that give
   a confident wrong answer.

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
    player-controller.ts grounded ?walk=1 controller; gravity and mouse look
    autopilot.ts        deterministic ?fly= flight path, for the soak test
  world/
    contracts.ts        ChunkCoord / ChunkData / ChunkProvider / TierContext
    noise.ts            gradient noise, fBm, ridged multifractal, domain warp
    height-field.ts     baseHeight + sampleHeight + SEA_LEVEL + the biome fields. THE terrain.
    rivers.ts           Region-tier flow accumulation and the channel carve
    roads.ts            Region-tier settlement siting, road graph, routing, grading
    city.ts             Region-owned multi-sector CityPlan: walls/gates/districts/landmarks
                    (Settlement Visual Epic C5–C7: landmark/wall/district silhouette polish)
    streets.ts          Sector-tier street layout inside a settlement
    lots.ts             Sector-tier building lots along streets
    road-mesh.ts        the road and street DECK: carriageway geometry, per chunk
    building-mesh.ts    batched building geometry, per chunk
    wall-mesh.ts        pure batched crenellated curtain + projecting towers per chunk (gate opening cleared for landmark shell)
    collision.ts        pure terrain/building/wall/deck collision queries
    interior-mesh.ts    pure landmark interior geometry
    interior-overlay.ts Three-only near-player adapter for landmark interiors
    props.ts            world vegetation + yard prop placement (pure)
    prop-mesh.ts        batched prop / vegetation geometry, per chunk
    grading.ts          the one weighted-average blend everything that moves ground joins
    cell-heap.ts        deterministic (key, index)-ordered min-heap, shared by both
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
  shots-diff.mjs        describe how two PNGs differ; dependency-free codec
  shots-repeat.mjs      capture views repeatedly in one process; catches an unstable view
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

Being the boundary makes it the owner of one thing that is easy to put elsewhere:
**switching a draw mode means switching every render state that only means
something in one of the two modes**, not just the `wireframe` flag. Since Phase 6a
`applyWireframe` also drops and restores `polygonOffset`, because polygon offset
does not apply to line primitives and asking for it anyway is undefined -- see
Screenshots below. A material declares what it WANTS (`chunk-mesh.ts` asks for an
offset on the deck) and this file decides what is legal to ask for in the mode
being drawn.

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

`src/world/` is layered so generation remains Three-free. Three.js is confined
to upload/residency adapters (`chunk-mesh.ts`, `chunk-streamer.ts`, and the
near-player `interior-overlay.ts`):

```
contracts.ts    types only       importable from a worker and from Node
noise.ts        pure functions   no Three, no DOM, built on core/hash.ts
rivers.ts       pure functions   Region tier; imports contracts + noise ONLY
grading.ts      pure functions   the blend rule; imports noise ONLY
roads.ts        pure functions   Region tier; imports contracts + grading + noise
city.ts         pure functions   Region-owned CityPlan from one city settlement
streets.ts      pure functions   Sector tier; village plans or clipped CityPlans
lots.ts         pure functions   Sector tier; street lots + reserved city landmarks.
                                 City lots walk the full CityPlan (centre-owned per
                                 sector + margin shadow); villages keep clipped streets.
road-mesh.ts    pure functions   deck geometry; imports contracts + roads + streets
building-mesh.ts pure functions  building geometry; imports contracts + lots + roads
props.ts        pure functions   prop placement; imports contracts + height + lots + roads + streets
prop-mesh.ts    pure functions   prop geometry; imports contracts + props + lots + roads + streets
wall-mesh.ts    pure functions   per-node city crenellated curtain + tower geometry (gate mesh owned by landmarks)
collision.ts    pure functions   player collision against generated records
interior-mesh.ts pure functions  local landmark interior buffers
height-field.ts pure functions   sampleHeight; the single source of terrain truth
chunk-gen.ts    pure functions   the worker and the unit tests run the same code
worker-pool.ts  scheduling       no DOM, no Three; `spawn` is injectable
chunk-mesh.ts   Three.js         the boundary where payloads become GPU objects
interior-overlay.ts Three.js     near-player upload/disposal of pure interior buffers
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

### The tier system, finally exercised: `Region -> Chunk`

Phases 1 to 3a declared `Region (4km) -> Sector (512m) -> Chunk (64m)` and used
none of it. `TierContext.coarser()` was called only from its own unit tests,
`REGION_SIZE` was a constant nothing read, and RULE 3 was documentation.

**Phase 3b's rivers are the first content that spans chunks**, so they are the
first content that has to be decided at a tier that contains them. A river is
hundreds of chunks long; no chunk can know where it goes.

```
rivers.ts          Region tier: flow accumulation over a 4 km window,
                   from baseHeight ONLY, memoised per (terrain, seed, region)
height-field.ts    sampleHeight = baseHeight - riverDrop
chunk-gen.ts       reads the region record through coarser('region')
chunk-worker.ts    builds that context with chunkTierContext(worldSeed)
```

Two things make this a real use of the tier system rather than a decorative one:

- **`generateChunk` throws if the region record is missing.** It could have
  called `rivers.ts` itself -- the memo is global and the answer would be
  identical -- and that is exactly the habit that makes the tier boundary
  meaningless. The record arrives through `coarser('region')` or generation
  fails.
- **The region generator is handed a `region` `TierContext`, so it *cannot*
  read anything finer.** Nothing is coarser than a region, so every `coarser()`
  call from inside `generateRegionRivers` throws. RULE 3 is enforced by the
  context, not by review.

**Phase 4a adds a SECOND Region-tier generator, and that is what the single
`coarser('region')` slot had to absorb.** `CoarseData` is keyed by tier NAME, so
there is exactly one entry per tier however many generators live there. Rivers
and roads therefore travel together in one `RegionField` record
(`height-field.ts`) rather than as two coarse reads -- which is also the right
shape, since a chunk vertex needs both at the same point.

Roads read rivers. They cannot do it through `coarser('region')`, because that
throws for the generator's own tier, so the river field is an ARGUMENT to
`generateRegionRoads` -- the same injection discipline `RiverTerrain` already
uses. `roads.ts` imports nothing from `rivers.ts`; `height-field.ts` wires them
together. Rivers never read roads, so the graph stays acyclic.

**Phase 4b fills the hole in the middle: `Region -> Sector -> Chunk` is now all
three.** Street layout inside a settlement is decided at the Sector tier, a
sector context legally calls `coarser('region')` -- the first three-level read in
the project -- and `chunkTierContext` is the first place `CoarseData` holds two
entries at once. See "Streets" below.

### `baseHeight` and `sampleHeight`: the layer everything after Phase 3 sits on

Rivers carve terrain, but river routing is computed *from* terrain. That is
circular, and the resolution generalises to Phase 4's roads and to anything else
that modifies the ground:

```
baseHeight()    pure terrain, exactly Phase 3a's sampleHeight body.
                The ONLY thing routing may read -- rivers AND roads.
sampleHeight()  baseHeight, carved by rivers, then graded by roads.
                What EVERYTHING downstream reads.
```

Phase 4a's roads compose into the same split, in a stated order:

```
base   = baseHeight(x, z)
drop   = rivers.drop(x, z, base)          // >= 0, one-directional
carved = base - drop
lift   = roads.lift(x, z, carved, drop)   // SIGNED: cuts and fills
final  = carved + lift
```

**Rivers are applied first and roads yield to them.** Grading weight is
multiplied by `1 - smoothstep(0, ROAD_RIVER_YIELD, drop)`, so inside a carved
channel a road moves no ground at all. Without that, a fill across a channel
raises the bed above the Phase 3a water surface -- which is built from this very
height grid -- and the river visibly runs over the top of the dam.

Phase 3b's handoff note guessed the two would combine as a `max` or a sum of
drops. Neither works: both assume a road's effect is a downward cut, and a road
that can only cut cannot cross a dip. Grading is a signed blend toward a target
altitude, so it composes rather than accumulates. **`MIN_HEIGHT` gains
`ROAD_MAX_CUT` and `MAX_HEIGHT` gains `ROAD_MAX_FILL` -- road grading is the
first thing in the project that can RAISE the ground.**

**Nothing upstream of the carve may read `sampleHeight`.** If routing saw its own
output the answer would depend on how many times it had been evaluated, and RULE
1 would be gone. `rivers.ts` therefore never imports `height-field.ts`: it takes
the base sampler as a `RiverTerrain` argument. That keeps the dependency acyclic,
states the rule in the type system, and has the useful side effect that the
routing can be tested against synthetic terrain -- a V-shaped valley, a cone --
where the right answer is known and no noise is in the way.

`sampleHeight` kept its name and signature. Every Phase 0-3a caller -- chunk
vertices, normals, the water surface, the cube's seating, the camera's
ground-relative default Y, the parity tests -- sees rivers without changing a
line.

### Rivers: flow accumulation, and what happens at a Region boundary

Per region, on a **global** 64 m lattice covering the region plus 1,536 m of
margin (112 x 112 = 12,544 samples, about 56 ms):

1. sample `baseHeight`;
2. priority-flood to a depression-less surface, so no channel can end in a pit
   halfway up a mountain;
3. D8 flow direction by steepest descent on the filled surface, with the flood's
   own discovery edges as the fallback on flats;
4. accumulate;
5. threshold into channel nodes and segments;
6. a water-surface profile per node, `max(profile[downstream], base)`, which is
   monotonically non-increasing downstream and therefore reaches `SEA_LEVEL`
   wherever the chain reaches the coast.

The carve blends the terrain toward `profile - depth` inside a bank whose width
grows with `sqrt(accumulation)`, capped at `RIVER_MAX_CUT` so a river next to a
cliff is a river and not a canyon. It is one-directional: carving only ever cuts
down, so it can never lift a sea floor out of the water.

**The region boundary is the failure this phase is most likely to have, and
three things together prevent it:**

- The lattice is **global** (cell index is `floor(world / 64)`, not an offset
  from a region origin) and `baseHeight` is pure, so two neighbouring regions
  sample identical points and compute identical flow directions. **The path of a
  river is continuous across a boundary by construction; only its size can
  disagree.**
- Each region routes on a window padded 1,536 m beyond its own square, so a cell
  on a region's edge still sees 1.5 km of its upstream catchment.
- A query point takes the **maximum** influence over every region whose window
  contains it, each weighted by a factor that is exactly 1 over the region's own
  square and falls smoothly to exactly **0** at the edge of its padded window. A
  region contributes nothing at the moment it stops being consulted, so the
  combined field is continuous everywhere, and in the overlap band the region
  with more of the catchment wins.

The limit, stated: accumulation is still truncated at the window edge, so a river
whose catchment reaches more than 1.5 km past a boundary is under-measured by the
downstream region. Because the field is continuous and combined by max, that
shows as a channel that is slightly *shallower* for a stretch, never one that
stops.

### Roads: a Gabriel graph, A* routing, and no cross-region blend

Phase 4a is the second piece of content that spans chunks, and it is decided at
the Region tier for the same reason rivers are. Per region:

1. score a settlement candidate in every cell of a **global** 512 m lattice,
   from position-pure fields only, jittered inside its cell by `hash2i`;
2. keep a candidate iff it is a strict local maximum of that score over its
   **3x3 neighbourhood** -- which is what guarantees spacing without a global
   pass, and what makes two regions agree about every settlement they share;
3. connect the settlements with a **Gabriel graph** capped at `ROAD_MAX_EDGE`;
4. route each edge with **A\*** on a global 128 m lattice, reading `baseHeight`
   only, paying a squared slope penalty and a heavy river-crossing penalty;
5. smooth the path, then give it a **gradient-limited elevation profile**;
6. index the segments into buckets, recording where a road crosses a channel.

**Why a Gabriel graph and not a minimum spanning tree.** The graph has to be
decidable from local information, because two neighbouring regions must agree
about every road near their shared boundary or there is a 4 km seam through the
world. An MST is not local: adding one settlement at the far edge of a region's
view can re-route edges arbitrarily far away, and no amount of padding fixes
that, because the dependency is global by definition. A Gabriel edge `(a, b)`
exists iff no third settlement lies in the disc having `ab` as its diameter,
which is decided entirely by settlements near `a` and `b`. `SETTLEMENT_PAD` is
sized to contain that disc, so the answer is exact rather than approximate.

**Why there is no cross-region blend, unlike rivers.** `rivers.ts` consults up
to four networks per query and combines them by a weighted maximum, because a
region's flow ACCUMULATION is truncated at its window edge: neighbouring regions
genuinely disagree about how big a river is, and the blend is what stops that
disagreement being a step. Roads have no such quantity. A road's geometry is a
pure function of its two endpoints, every region routes every edge whose
corridor comes within `ROAD_REACH` of its square, and **each edge is routed
inside a window derived from the EDGE, never from the region**, so its path is
identical whichever region computes it. A query point lies inside exactly one
region square, and that region has routed everything that can reach it -- so
**one** region answers each query, a quarter of the lookup cost rivers pay in
their overlap bands, and continuity across a boundary is exact rather than
blended. A unit test asserts that two regions produce bit-identical node
positions for the roads either side of their shared edge.

**The A\* heuristic is deliberately inflated.** Straight-line distance is
admissible but a very weak bound once the slope penalty is in play, so plain
A\* degenerated toward Dijkstra and swept the whole search rectangle: 1.5 s per
region, ten times what this can afford. `HEURISTIC_WEIGHT` gives up the
guarantee that the path found is the globally cheapest one and buys back about
an order of magnitude. That is the right trade here and would not be everywhere:
a road's cost function is a statement of preference, not of correctness, and
nothing downstream can tell the cheapest route from one a few percent worse.
What is still guaranteed is what RULE 1 needs -- the search is a deterministic
function of its inputs, so the same edge yields the same path every time and
from every region. The frontier is keyed on ENTRIES rather than on cells, since
`CellHeap` reads its key array at comparison time and lowering an in-heap cell's
score would silently corrupt the ordering.

**A road crossing a river is a ford, not a bridge, and that is Phase 5's job.**
The router pays `RIVER_CROSSING_COST` per metre of carve, so crossings are rare
and land where a channel is narrow; the grading then yields inside the channel,
so the roadbed runs to the bank and resumes on the far side. Each crossing is
recorded in `RoadNetwork.segCrossing` so Phase 5 can put a bridge on it.

**A road on flat ground moves no earth at all, and the anti-vacuity counter had
to account for it.** The profile is smoothed and gradient-limited, but where the
terrain is already gentle it and the ground agree, so the lift is legitimately
zero -- measured on one seed, the median road node moves the ground 0.00 m while
the ninetieth percentile moves 11 m. `ChunkData.roadVertices` therefore counts
SURFACING, not movement. Counting movement would have reported "no roads" for
every road on gentle terrain, which is exactly the kind of quietly-passing check
this project has been caught by five times.

### Streets: the Sector tier, and one blend for everything that moves ground

Phase 4b is the first content decided at the **Sector** tier, which had been
declared since Phase 1 and read by nothing. Per sector:

1. find the settlement whose **centre** the sector contains -- there is at most
   one, and this is exact rather than approximate: `SETTLEMENT_CELL` **is**
   `SECTOR_SIZE`, both lattices are global and anchored at the origin, and
   `SETTLEMENT_JITTER` (190 m) is less than half a cell (256 m), so a candidate
   can never leave the cell that owns it. `generateSectorStreets` throws if it
   ever finds two, because that would mean the alignment had broken;
2. take the **bearings of the roads leaving** that settlement, from the Region
   record read through `coarser('region')`;
3. pick a **layout family** as a pure function of `(worldSeed, cellX, cellZ)` —
   ring (~52%), linear, grid, or hilltop — and emit the same CSR
   `SectorStreets` shape every family shares (`layout` is an additive scalar for
   soak / HUD; lots and decks keep walking polylines);
4. for **ring** (the Phase 4b default, still the majority): lay a ring at 0.58 of
   the footprint radius, jittered radially and angularly; hang lanes outward to
   0.78 and spokes inward, dropping any whose bearing is within about 37 degrees
   of a road. **Linear** is a spine along the primary road bearing with short
   spurs; **grid** is a small road-aligned block of lanes (centre line along the
   road omitted); **hilltop** is a smaller closed enclosure with few spokes;
5. give every node the settlement's own altitude as its grading target.

**Village ownership remains centre-only; cities are the explicit exception.**
A village sector lays out the one village whose centre it contains and does not
clip it. A medieval city is too large for that rule: `city.ts` creates one
Region-owned `CityPlan` from `(worldSeed, settlement cell)`, including its wall,
gates, districts, arteries, landmark reservations and farmland belt. Every
sector whose square intersects that city reads the same coarser plan and clips
its polylines to the sector's padded bounds. The centre sector uses this same
clip path; it never runs a village layout for a city. Visual massing for landmarks,
walls and village fabric is scheduled as the **Settlement Visual Epic** (see
`PROGRESS.md`), not as Phase 9 NPCs. Thus clipping does not ask
two sectors to independently decide halves of a whole: the Region tier already
decided the whole, and sectors only refine it.

**The consequence is that a query reads up to four sectors, and there is no
blend.** A settlement's streets overhang its sector by up to `STREET_REACH`
(derived, ~116 m, deliberately under half a sector), so a point consults every
sector whose square inflated by that contains it: one normally, four near a
corner. That is the shape `rivers.ts` uses, not the shape `roads.ts` uses -- but
unlike rivers there is nothing to reconcile, because two sectors never both own a
settlement, so what they contribute is **disjoint** and the union is exact.

**One region per sector, and it is the right one.** A sector lies entirely inside
one region, and so does the settlement whose centre it contains -- and the region
containing a settlement is guaranteed to have routed every Gabriel edge incident
to it (the edge's bounding box contains the settlement, which is inside the
region). So the roads a street plan avoids are read from the one region that has
all of them, and every sector needing that settlement reads the same region.

**Everything that moves the ground joins ONE weighted average, in `grading.ts`.**
Phase 4a had a single grader and kept the blend inside `roads.ts`; Phase 4b adds
a second at a different tier, and two copies of a rule whose whole job is making
two influences meet without a step is exactly the duplication that drifts --
`cell-heap.ts` was lifted out of `rivers.ts` for the same reason. `GradeBlend`
accumulates `(weight, target, surface)` from both tiers and resolves once:

```
target = sum(weight * target) / sum(weight)
lift   = strongest * yield * clamp(target - carved, -ROAD_MAX_CUT, +ROAD_MAX_FILL)
```

Resolving each tier separately and adding the lifts is the obvious alternative
and is wrong: a weighted average is not distributive, so the ledge would appear
exactly where a street meets the road it joins. Taking the SUM of the weights as
the strength is the other obvious alternative and is also wrong: two roads side
by side would grade harder than either alone and a crossroads would punch a hole.
The river yield is applied once, in `resolve`, so a street and its road stand
down by exactly the same amount inside a channel.

**Every street node targets the settlement's own altitude** -- the same target
the pad uses, and the same one a road leaving the settlement is pinned to at its
first node. That is what makes the junction step-free by construction rather than
by tuning, and it is also the visible content of the phase: the pad grades a disc
flat, the streets carry that altitude out along a ring and its lanes, so a
settlement's graded footprint becomes a wheel rather than a circle. The street
shoulder is 8 m rather than the 5 m first tried, because at 5 m the resulting
bench at the end of a lane was measurably steeper than anything the roads and the
pad produce on their own.

**No trigonometry, and that is a determinism requirement rather than a style.** A
street node's position decides a vertex's altitude, and `Math.sin` / `Math.cos`
are only approximated by the ECMAScript spec. `ringDirection` walks the L1 unit
diamond -- pure linear arithmetic -- and normalises each point onto the unit
circle with one `Math.sqrt`, which IEEE-754 requires to be correctly rounded.

**`ChunkData.streetVertices` is a THIRD counter, not a wider `roadVertices`.** A
settlement pad already surfaces every vertex in a village, so a combined number
is non-zero across a whole settlement with no street in it at all -- "the flight
never reached a village" and "street layout silently returns nothing" would
produce identical evidence. This counts the Sector-tier contribution alone.

### Decks: the carriageway as geometry, and the first new mesh since Phase 3a

Phase 5. Everything from 3b to 4b modified the terrain mesh every node already
had -- a river is a dent in it, a road is a bench and a colour, a street is the
same one tier down -- so none of them could cost a draw call. A deck is separate
geometry and does, which is why 4b said in advance that this is the phase whose
budgets should move.

**Why a deck at all.** Phase 4a's surfacing is a per-vertex colour on the terrain
lattice, so a road's width is quantised to that lattice. At lod 0 that is 2 m on
a 7-12 m road; by lod 4 it is 64 m and the road has washed out to a stain while
still being several pixels wide on screen. A deck's width comes from the road
record, so it is exact at every level. The second reason is the one 4a deferred:
a road crossing a river was a ford, and a deck spans it.

**A deck is per-chunk geometry, generated in the worker, exactly like water.**
One mesh per routed road is the obvious alternative and fails four ways: its
extent is not a function of `(worldSeed, coord)`, so the streamer, the LRU and
the soak's round-trip hash do not cover it; it cannot be clipped to what the
quadtree currently covers; no single worker owns a road; and — the one that
settles it — **it cannot follow the level of detail.** A node's rendered ground
is the interpolation of its own lattice, which at lod 5 cuts corners by metres, so
a lod-independent deck sinks into a coarse hillside and floats over a coarse
valley. Roads are in valleys.

**The rule is `max(blended target, this node's ground)`, and the bridge falls out
of it.** `GradeBlend.target` is the altitude everything grading a point agrees
on, before the strength, the cut and fill caps and the river yield are applied;
`gradeTarget` in `height-field.ts` is the same accumulation `gradeSurface`
performs, stopped one step short. Four cases, all wanted:

| where | ground | deck |
| ----- | ------ | ---- |
| ordinary terrain | reached the target | flush on the ground |
| village edge | the pad/road/street average | flush, because it reads the same average |
| clamped cut on a hillside | above the target | rides the ground |
| inside a river channel | yielded entirely | holds the target: a bridge |

Building the deck from a road's OWN profile was tried first and floated a metre
or two over every village approach, because the average is not any one
contributor's profile — which is the whole point of `grading.ts`.

**The apron does the terrain skirt's job and the bridge's, with one mechanism.**
Every deck edge hangs an apron below it: buried and invisible where the deck
rests on the ground, and the side of the bridge where it does not. It carries
both windings with a single-sided material, for the reason
`SKIRT_TRIANGLE_COUNT` gives. `DECK_BEAM` bounds how far it may follow the ground
down, and that bound is load-bearing: without it a deck over a 15 m channel
produced a solid wall from bank to bank standing in the water — the dam
`ROAD_RIVER_YIELD` exists to prevent, one layer up.

**Two same-level neighbours agree exactly, by arithmetic.** A centreline is
clipped to the node square parametrically, and the two sides of a shared boundary
solve the same equation with opposite signs — `(maxX - ax) / dx` against
`(ax - minX) / -dx` — which IEEE-754 makes bit-identical. Both nodes place a
station at the same world point and sample the same ground along the shared edge,
so the deck is partitioned rather than shared or dropped: no seam, no
double-drawn overlap. The box is half-open on its maximum edges so a segment
running exactly along a boundary belongs to one neighbour and not both.

**Ownership needs one rule for roads; street ownership depends on settlement class.** Two regions both
route a road near their shared boundary and hold bit-identical copies of it, so a
segment is emitted by the region containing its MIDPOINT — a purely positional
rule, so exactly one region emits each. Village streets need nothing beyond
centre ownership. City streets are clipped from one Region-owned CityPlan, so
each sector emits only the clipped segments intersecting its padded square.
City **lots** do not reuse those clipped polylines for station placement: they
walk the full CityPlan and emit only buildings whose centre falls in the sector
(with a margin shadow for overlap), so CSR joints cannot restart the abut pitch.

**The sectors a node visits are enumerated, not searched for.** Sweeping the
sector grid is what `sectorStreetField.accumulate` does per vertex and it is
correct for a vertex; for a NODE at the root level it is an 11x11 block, which
overran the street memo and cost 96 s on one canonical view. A street plan exists
only where a settlement centre is, and the region records already list every
settlement that can reach the node, so the sectors worth visiting are known
exactly: none normally, one over a village.

### Lots and buildings: Sector-tier content that reads the finished ground

Phase 6. The second Sector-tier generator, and the second mesh of its own after
the deck. Streets decide where a village's lanes go; lots decide what fronts onto
them. Buildings are the first content in the project whose placement is decided
by evaluating the *finished* height field rather than by routing from
`baseHeight` and then moving the ground.

**Everything a building is is fixed at the Sector tier.** Kind (cottage / barn /
hall), position, footprint, facing, eaves, ridge, wall and roof tint, and the
altitude of the floor are all pure functions of `(worldSeed, sector)`.
`building-mesh.ts` places geometry and decides nothing -- facade detail (door,
barn doors, chimney cap) is painted from `SectorLots.kind`, never re-rolled. That is a deliberate departure from the deck: a ribbon hundreds
of metres long must follow each node's own lattice or it sinks into a coarse
hillside; an eight-metre house that followed the lattice would jump vertically
every time the quadtree changed level under it. What varies per node is only how
far the plinth reaches down to meet *this* node's rendered ground.

**A lot is refused where the village failed to level the ground.** Acceptance
requires the rendered surface within `LOT_UNLEVEL_MAX` of `gradeTarget` at the
centre, and less than `LOT_SPREAD_MAX` of variation across the four corners.
Those two numbers subsume the river test, the steep-hillside test and the
outside-the-pad test without naming any of them: grading yields inside a channel,
so a river through the village refuses every lot that would sit in it.

**`LotGround` is injected, not imported.** `height-field.ts` imports `lots.ts` to
wire the Sector record, so `lots.ts` cannot call `sampleHeight` directly. The
same injection pattern `RiverTerrain` and `RoadTerrain` use keeps one composition
of the ground and lets a unit test drive the generator with a flat plane.

**One mesh per node, not one per building.** A village node holds dozens of
houses; a mesh each would put fifty draw calls on a node that currently costs
three. Every building whose centre lies in the node goes into one buffer with
per-vertex colour. Ownership is the centre: the building is not clipped, it may
overhang the node square, and the submesh's bounds come from the emitted
vertices so frustum culling does not cut a house in half at the screen edge.

**`SectorField` is a record of two fields, not an alias for streets.**
`CoarseData` has one slot per tier name, so streets and lots travel together the
way rivers and roads do in `RegionField`. They are not symmetric: streets grade
the ground and lots read the finished ground, so the lot field is built from an
already-built street field.

**`ChunkData.buildings` / `buildingsLevel` and the kind counters are the
anti-vacuity set.** `buildings` says houses were placed; `buildingsLevel` says
they stand on ground this lod-0 node renders within tolerance of their floor;
`buildingsCottage` / `buildingsBarn` / `buildingsHall` say the kinds variety
slice is not a cottage-only world. A regression in the
grading, in `gradeTarget` or in the lot acceptance tests leaves the count
untouched and drives levelness to zero. Levelness is measured at lod 0 only -- a
coarse lattice cannot describe an 8 m footprint, so the number would be about
mesh resolution rather than about the village.

### Props and vegetation: dense placed content on the building model

Phase 7a. One placement + batching pipeline for world trees/bushes and sparse
settlement yard props. Placement is a pure function of `(worldSeed, worldXZ)`
with node ownership by centre -- there is no Sector-tier memo for world trees,
because density is continuous across the map and a sector memo would either
overhang like streets or force an 11×11 working set. Yard props query nearby
`SectorLots` when a settlement is in reach, the same region walk buildings use.

**Base Y is LOD-independent; the stump is not.** `sampleHeight` at the centre
fixes the pose so a tree does not jump when the quadtree changes level. Each
node decides how far a short buried stump reaches down to meet *this* node's
rendered ground -- `BUILDING_FOOTING` / plinth in a different shape.

**One mesh per node, not one per tree.** A forest lod-0 node holds tens to low
hundreds; one mesh each would blow the draw-call budget. Every prop whose centre
lies in the node goes into one buffer with per-vertex colour (+1 draw call per
prop-bearing node). Nodes coarser than `PROP_MESH_MAX_LOD` (2) emit empty arrays
-- a root node would otherwise own every tree in 4 km. `props` / `propsSeated` /
`propsMeasured` are the anti-vacuity trio: placed, seated on ground this node
renders, counted at lod 0 only. Village **layout** families shipped in 7b
slice 1; building kinds in slice 2.

**Species, size class, and clustering are decided in `props.ts`; the mesh only
reads them.** `species` is a SoA column beside `kind`. Trees pick pine (~55%) /
broadleaf (~45%); bushes pick round (~55%) / tall (~45%); yard crate/post map
to `SPECIES_CRATE` / `SPECIES_POST`. Size uses sapling/adult/elder bands from
the existing scale salt inside each kind's `PROP_*_SCALE_MIN/MAX`. World props
(only) multiply the accept threshold by a grove factor over `CLUSTER_STRIDE`
(= 3) cells, softened with a 4-neighbour blend, tuned so total density stays
near the 7a baseline. `prop-mesh.ts` branches pine vs broadleaf (still 2 boxes)
and bush round vs tall (still 1 box) and exposes `pine` / `broadleaf` /
`bushRound` / `bushTall` / `yard` counters on `PropSurface`, mapped to
`ChunkData.propsPine` etc. (`CHUNK_DATA_VERSION` 12). Streamer cumulative
`propsSeen*` + HUD `prop-species` + soak floor of one each are the anti-vacuity
half: a pine-only world fails.

### The region memo is derived data, and it is bounded

Every chunk vertex needs river influence; a chunk is ~1,200 vertices and hundreds
are resident. A flow-accumulation pass per vertex would stop generation dead, so
the network is computed once per `(terrain, seed, region)` and cached.

That is not global mutable world state under RULE 2: it is a pure function of its
key that can be dropped and rebuilt byte-identically, and a unit test does
exactly that. It is capped at 16 entries with move-to-front eviction, because an
unbounded memo is a leak with a friendly name and the soak's leak check has the
thinnest margin of any budget in this project. The lookup is a linear scan over
an array rather than a `Map` keyed by a template string -- a key string per call
would allocate ~1,200 short-lived strings per chunk, forever, on the hottest path
in the codebase.

One consequence worth knowing: **the first `sampleHeight` call on a new seed
routes a region synchronously**, ~56 ms. On the main thread that happens once, in
the `App` constructor, seating the cube and resolving the default camera Y. It is
not per frame and it is not per chunk.

**Both memo sizes were wrong until Phase 5 measured them, and each was wrong in
the same shape: smaller than the working set of a single coarse node.** A node at
the root level covers a whole 4 km region, so its padded sample grid needs a 3x3
block of ROAD networks and an 11x11 block of STREET plans. `ROAD_CACHE_LIMIT` was
8 against nine, and `STREET_CACHE_LIMIT` 64 against 121 — and being one short is
the worst possible size, because the entry evicted is always the one wanted next
and a sweep rebuilds every record it touches instead of building each once.

Neither was visible before, because a VERTEX touches one region and up to four
sectors and both caches absorbed that; it took a builder that sweeps a whole node
in one go to expose it, and a measurement rather than a guess to attribute it.
The numbers, on real work rather than a microbenchmark:

| measured | before | after |
| -------- | ------ | ----- |
| one root-level node, warm | 3.6 s (10.5 s with a deck) | ~6 ms |
| `seed-canary-inland` to `__worldReady` | 96 s, against a 120 s harness limit | ~16 s |

The limits are now 16 and 192. The cost is memory (a megabyte or two per JS
context, against a 400 MB budget) and a longer linear scan — but move-to-front
keeps the handful of records a FINE node uses at the front of the array, so the
scan stays short exactly where the vertex count is high.

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

**Phase 4a's measurement on the same Arc 140V settles this.** With rivers, roads
and water all in the scene the app holds 60 fps at 1080p with p99 main-thread
work of 6.5 ms. The 2a profile's conclusion held for four more phases: frame
time is still not the problem, and `SEGMENTS` is still not the thing to cut.

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
npm run shots:diff -- <a.png> <b.png> [mask.png]   # HOW two captures differ
npm run shots:repeat -- --repeat=3 [view...]       # is a view reproducible AT ALL
```

`shots` and `shots:check` accept `--no-build` to skip the rebuild when `dist/`
is already current. They capture every view in **one Chromium process on one
reused page** (`page.goto` + `__worldReady` + screenshot per view), which drops
the per-view context teardown/startup tax while keeping the one-process
sequential order Phase 6a showed is load-bearing.

The last two were added in Phase 6a and each answers a question `shots:check`
cannot. `shots:check` compares a view against its **baseline**, so "this view
changed" and "this view is not reproducible" are the same red line, and when it
is red "changed how" is unanswerable without opening two PNGs and squinting.
`shots:repeat` compares a view against **itself** over several passes, and
`shots:diff` reports how many pixels differ, by how much, where, and will write a
greyscale mask. Between them they turned the Phase 5 instability from a mystery
into a one-line fix.

`shots:repeat` captures the whole sequence inside **one browser process**, in
order, exactly as `shots:check` does, and that is load-bearing rather than
convenient: the Phase 5 flake was invisible to a view captured on its own and
appeared only once a shaded view had preceded it in the same process. A
reproducibility checker that opened a fresh browser per view would have reported
everything green.

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

**All canonical views are reproducible again as of Phase 6a** (46 as of Phase 7b),
and the rule that keeps
them that way is stated once, in `renderer.ts`: **wireframe mode must not leave a
polygon offset enabled.** WebGL has no `GL_POLYGON_OFFSET_LINE`, so what a line
primitive's depth is while the state is on is unspecified, and SwiftShader's
answer depended on GPU-process state that outlived a page -- which made the eight
wireframe views containing a Phase 5 deck come back different on every run.
`applyWireframe` remembers the requested value on the material and restores it
when wireframe goes off, so filled rendering is bit-for-bit unchanged. Full
write-up, including what was ruled out and the reproducer that still fails
without the fix, is in `PROGRESS.md` under Phase 6a.

The general form is worth stating, because Phase 5 lost a phase to it: **a render
state that only means something in one draw mode has to be switched with the
mode.** Anything else is undefined behaviour that a byte-comparison harness will
find and a picture will not.

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
Phase 3a its **water positions and water colours** as well. Phase 3b needed no
new hash: carving moves the very vertices the position buffer already holds. It
needed a new anti-vacuity guard instead -- see below. Phase 1 compared flat
colours, which could only ever prove the coordinate hash was pure. Hashing the
vertex bits proves the thing that is actually expensive to reproduce, and it is
the direct statement of RULE 2. Keep it for every remaining phase.

**Since Phase 4a the flight also has to pass a road, and the start moved a third
time to make that true.** Roads are far sparser than rivers -- about twenty per
4 km region against hundreds of stream channels -- and the Phase 3a/3b start at
`(-7000, -3500)` passed EXACTLY ZERO of them in 6.75 km, with no road in any of
the 25 round-tripped chunks. Every road assertion would have passed without ever
meeting a road. `(-7500, -3600)` was chosen by searching the seed for a start
that keeps all three claims real at once rather than trading one away: road
11/25, river 14/25 and sea 15/25 of the round-tripped chunks, and 2.7 km of open
water still along the line. `roadNodes`, `roadVertices` and `roadDrawCalls`
mirror the river trio exactly, including the `Object3D.onBeforeRender` counter,
because a road is not its own mesh either.

**Since Phase 4b the flight also has to reach a SETTLEMENT, and the start moved
a fourth time -- because the trap had already been sprung.** Streets exist only
inside a settlement, which is a 250 m disc in a 16 km^2 region, so they are far
rarer than a road let alone a river. Measured on the Phase 4a start
`(-7500, -3600)`: sea 11/25, river 12/25, road 7/25 and **street 0/25**. Not one
of the twenty-five round-tripped chunks contained a street, so the
byte-identical-regeneration check would have said nothing whatever about the
phase that had just been written. `(-6749, -4140)` was found by generating the
real 5x5 square at every 64 m offset around every settlement within reach of the
corridor and **maximising the worst of the four counts** rather than trading
three away for the fourth: sea 16/25, river 9/25, road 12/25, street 10/25. The
weakest of the four went from 0 to 9. `streetNodes`, `streetVertices` and
`streetDrawCalls` mirror the road trio exactly, and `ChunkData.streetVertices`
counts the SECTOR-tier contribution alone -- a settlement pad already surfaces
every vertex in a village, so a combined number would be non-zero with no street
in it at all.

**Since Phase 5 the flight also has to pass a DECK and cross a BRIDGE, and the
start did not have to move a fifth time.** A deck is its own submesh, so
`deckNodes` and `deckDrawCalls` mirror the water pair rather than the river one,
and `sampleChunkDecks` says the round-tripped square had carriageway geometry in
it — which matters, because the geometry hash now folds `deckPositions` in and
would otherwise be hashing an empty array. `bridgeNodes` is the sharp one and it
is CUMULATIVE rather than instantaneous: bridges are counted at lod 0 only (see
below), so a bridge node is resident for about seven seconds as the camera passes
against a five-second sampling interval, and an instantaneous peak would be a
coin flip. A floor built on a coin flip is a check people re-run until it goes
green.

**Since Phase 6 the flight also has to see BUILDINGS, and the start did not have
to move a sixth time.** Houses exist only inside a settlement, so they are the
thinnest signal yet, but the Phase 4b start already put a village in the
round-tripped square (`houses at the start` 9/25 on the measured run).
`buildingNodes` / `buildingDrawCalls` mirror the deck pair; `buildingsSeen` is
cumulative for the bridge reason; `buildingsLevel` / `buildingsMeasured` is the
phase's own anti-vacuity number -- placed houses that stand on ground a village
actually levelled, counted at lod 0 only. The geometry hash folds
`buildingPositions` in.

**Since Phase 7a the flight also has to see PROPS, and the start did not have to
move a seventh time.** World vegetation is continuous along the corridor west of
the Phase 4b start (forest at roughly -6496,-3680, near `START_X`/`START_Z`), so
`propsSeen` / `propDrawCalls` / `propsSeated` are easier to satisfy than
buildings were -- but seating is still the anti-vacuity half that goes to zero if
the stump / `groundAt` path regresses. The geometry hash folds `propPositions`
in; `sampleChunkProps` refuses a round trip over bare ground whose empty prop
buffers would otherwise hash identically.

**Bridges are counted at lod 0 only, and that was measured rather than assumed.**
A deck stands at the blended target; the GROUND reaches that target only where
the vertex lattice has samples inside a 2.6-6 m roadbed. At lod 0 the spacing is
2 m and several do; at lod 3 it is 16 m and usually none, so the deck legitimately
stands clear of ground the lattice cannot describe. Counting that inflated the
soak's peak by roughly an order of magnitude and turned the one number that says
"a road crossed a river" into a statement about mesh resolution. The geometry is
unaffected at every level; only the statistic is taken where it means something.

**`__worldReady` was not enough to anchor the flight, and Phase 5 found out
why.** Phase 4b stopped the autopilot advancing before the world was ready, which
removed 400-900 m of drift from every "at the start" claim. What it could not
remove is the rest: readiness is observed by POLLING from Node, and a main thread
building a hundred meshes under a software rasteriser stalls for over a second at
a time, so the poll lands late — 1,296 m downrange on the run that exposed it,
which put the round-tripped square out over open sea and failed three checks that
had nothing wrong with them. The soak now sets `window.__flightReleased = false`
before the document runs and clears it once every baseline has been read. It is
opt-in, so a human opening a `?fly=` URL is unaffected.

**Since Phase 3b the flight also has to cross a river, and that needs its own
guard for a reason water did not.** Water is its own submesh, so "was any sea
drawn" is answerable by looking at the object list. A river is not a mesh -- it
is a dent in the terrain mesh every node already had, so "the flight never went
near a river" and "carving silently returns zero" produce identical evidence.
`ChunkData.riverVertices` counts the surface vertices a channel measurably
lowered; `riverDrawCalls` counts, via `Object3D.onBeforeRender`, the nodes
carrying carved ground that actually reached the rasteriser. The run fails if no
carving was generated, if too few carved nodes were resident, if carved terrain
was never drawn, if the shallow leg drew none, or if none of the round-tripped
chunks was carved.

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

| Budget                        | Limit     | 3a measured | 3b measured | 4a measured | 4b measured | 5 measured |
| ----------------------------- | --------- | ----------- | ----------- | ----------- | ----------- | ---------- |
| live triangles                | 2,100,000 | 1,229,124   | 1,225,890   | 1,184,272   | 1,144,318   | 1,368,596  |
| live vertices                 | 1,040,000 | 610,917     | 610,035     | 589,065     | 567,869     | 673,805    |
| draw calls                    | **680**   | 292         | 288         | 291         | 290         | 398        |
| chunk payload bytes           | 100 MB    | 92.5 MB     | 92.9 MB     | 90.5 MB     | 84.8 MB     | 86.8 MB    |

**Phase 3b breached none of them and re-derived none of them.** Rivers are
carved into the terrain mesh every node already had, so they add no draw call
and no vertex; the only way they *can* add one is an estuary turning a dry node
into a water-bearing one, and 0.56% of dry ground going under is not enough to
show. This is the first phase since 2a that left all four limits alone, and that
is the expected outcome for anything that modifies the height field rather than
adding geometry.

**Phase 4a breached none of them either, and said so in advance.** Roads grade
and recolour vertices the terrain mesh already had, so like rivers they add no
mesh, no draw call and no vertex. The small movements in the 4a column are the
soak's flight start moving, not roads: the new line crosses less open sea, which
is why triangles and payload went slightly DOWN. A phase whose content modifies
the height field should expect to leave all four alone; a phase that adds
geometry should expect to re-derive them with a stated number, as 3a did.

**Phase 4b breached none of them either, for the third phase running.** Streets
are graded and surfaced into the terrain mesh every node already had. The 4b
column moved for two reasons that are not streets: the flight start moved again,
and the autopilot now waits for `__worldReady`, so the run measures a different
6.75 km of world from the one 4a measured. **Phase 5's road meshes are the first
thing since 2b that should expect to move these numbers**, and the instruction is
unchanged: re-derive with a stated number rather than raising a limit quietly.

**Phase 5 moved one of the four, and said in advance that it would.** A deck is
the first geometry since Phase 3a's water to cost a draw call of its own. The
shallow-leg peak went from 292 to 398, and TWO separate things did that:

- **decks themselves, +34 at the peak frame.** `draws without it` in the report
  reads 364, which is the figure that isolates them.
- **the flight, +72** — and it is not the START that moved, it is that the flight
  now actually begins there. Before the `__flightReleased` gate the camera had
  already drifted up to 1.3 km downrange, so every earlier number in this table
  was measured over a route nobody chose.

`draw calls` is therefore re-derived at 680, which is 1.71x the new peak — the
same factor 2b and 3a used — and still far under RULE 5's ceiling of 1200. **The
other three are deliberately left alone.** None was breached, all three still hold
about 1.5x, and a limit with less slack catches a regression sooner. The payload
budget's structural ceiling does rise, because a deck adds up to 28 kB to a lod-0
node and 70 kB to a root one, so the most expensive possible node goes from
129,744 to about 158,000 bytes and the ceiling from ~108 MB to ~131 MB; 100 MB is
still comfortably below it and still fireable.

**One caveat on the screenshot baselines, found in Phase 4b.** The committed PNGs
are specific to the machine that captured them, not just to SwiftShader: the set
committed from the Linux dev container does not reproduce on Windows, and a view
this project's own code had not touched came back with a different hash there.
The baselines in `shots/` are now the Windows set. Whichever platform a phase
runs on, the way to tell a real change from a platform one is to capture the same
view twice on the SAME machine, once from the previous commit's source -- which
is how 4b established that it changed 19 of the 30 existing views and left 11
alone.

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

### Measuring the frame budgets

The soak reports fps and frame time but does not fail on them, because every
number it produces in the dev container comes from SwiftShader. RULE 5's two
frame budgets can only be judged on a machine with a GPU, and were first
measured that way after Phase 4a. There is **no committed command for this yet**
-- worth adding as `npm run perf:gpu`.

Four things make the measurement mean something, and the first two are how a
careful attempt still gets it wrong:

- **Never measure frame cost from `requestAnimationFrame` deltas.** They are
  vsync-locked, so on a 60 Hz panel 16.7 ms is the floor and the app can never
  read better than the budget however much headroom it has. Measured this way,
  an app sitting comfortably at vsync reports "48% of frames over 16.7 ms".
  Main-thread cost comes from `RunTask` events on the `CrRendererMain` thread in
  a Chrome trace, taken over CDP.
- **The trace needs the `toplevel` category** for those events to exist at all.
  `devtools.timeline` alone yields GC events but zero tasks -- and a percentile
  over an empty set reads as a comfortable pass. Assert the task count is
  non-zero, in the same spirit as the `shots:check` anti-vacuity guards.
- **Attribute GC to a thread.** The generation workers allocate far more than the
  renderer does and their collections cannot drop a frame; counting all threads
  together inflated the worst pause from 5.45 ms to 24.58 ms and the count of
  pauses over 4 ms from 3 to 52. Only `CrRendererMain` collections count.
- **Measure while moving, not parked.** The budget says "continuous movement"
  because that is when chunks stream, meshes upload and the allocator is busy.

Measure the production build served statically, not the dev server, and check
the reported WebGL renderer string before trusting anything: if it names
SwiftShader the run is worthless.

## Commands

```
npm run dev            # dev server on :5173
npm run build          # tsc --noEmit && vite build
npm run preview        # serve dist/ on :4173
npm test               # vitest (60 s per-test timeout; the streaming tests
                       #  generate hundreds of real chunks inside one `it`)
npm run shots          # write screenshot baselines
npm run shots:check    # verify nothing visual changed
npm run shots:diff     # describe HOW two captures differ, with an optional mask
npm run shots:repeat   # capture views repeatedly; fails on one that is unstable
npm run verify:subpath # verify the build survives a nested deploy path
npm run soak           # 5-minute headless flight; fails on a heap leak
```
