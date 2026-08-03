#!/usr/bin/env node
/**
 * Automated soak test: fly a deterministic path in headless Chromium and prove
 * the heap stays flat.
 *
 *   npm run soak                       # the full 5-minute acceptance run
 *   npm run soak -- --seconds=60       # a quick smoke run while iterating
 *   npm run soak -- --speed=60 --interval=10 --seed=whatever
 *
 * Phase 1's acceptance criterion is "fly in a straight line for five minutes,
 * heap flat, chunk count stable, and the origin looks the same when you get
 * back". That is unverifiable without a human staring at a screen, so it is a
 * command instead -- and it must be re-run at every later phase, because a leak
 * introduced in Phase 6 is far cheaper to find in Phase 6 than in Phase 11.
 *
 * How the flight happens: `?fly=<m/s>&flyleg=<seconds>` drives the camera along
 * a triangle wave on X (see `src/core/autopilot.ts`). `flyleg` is set to half
 * the run duration, so the camera is exactly back where it started at the end.
 * Nothing here drives the camera from Node, because a 10Hz poke from outside is
 * not a flight, it is a slideshow.
 *
 * TWO LEGS, TWO PITCHES, added in Phase 2b. The outbound leg keeps Phase 2a's
 * camera angle. At the turn-around the camera drops to the horizon, and the
 * return leg is where every geometry budget is judged -- because a budget
 * measured from a steeply pitched camera is a measurement of frustum culling
 * and cannot fail however bad the world gets. The pitch change does not touch
 * the flight path, so the round-trip determinism check is unaffected.
 *
 * A CAUTION LEARNED IN PHASE 0: a byte-comparison harness once reported five
 * green screenshots while the app rendered nothing at all. The same trap
 * applies here -- a soak run over an empty world would show a beautifully flat
 * heap. So this asserts that chunks actually streamed, that the camera actually
 * travelled, and that frames were actually drawn, and fails if any of those
 * look like "nothing happened".
 */

import { launchBrowser, openPage } from './lib/browser.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { buildProject, DIST_DIR } from './lib/canonical.mjs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const match = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  if (match === undefined) return fallback;
  const value = match.slice(name.length + 3);
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && typeof fallback === 'number' ? asNumber : value;
}

const SECONDS = Math.max(10, arg('seconds', 300));
const INTERVAL = Math.max(1, arg('interval', 5));
const SPEED = arg('speed', 45);
const SEED = String(arg('seed', 'soak'));
const SKIP_BUILD = process.argv.includes('--no-build');

/** Minimum fraction of the run discarded before the heap trend is fitted. */
const WARMUP_FRACTION = 0.25;
/** Samples needed after warm-up before a heap trend means anything. */
const MIN_TREND_SAMPLES = 6;
/** Fail above this. Over a 5-minute run that is ~30MB of unexplained growth. */
const MAX_HEAP_SLOPE_MB_PER_MIN = 6;
/** The project's hard budget. */
const MAX_HEAP_MB = 400;
/** Below this many chunks the run proved nothing, whatever the heap did. */
const MIN_CHUNKS_STREAMED = 50;

/**
 * GPU-INDEPENDENT BUDGETS.
 *
 * fps and frame time cannot be judged in a container with no GPU -- see the
 * note at the bottom of this file. Geometry volume can: triangle count, vertex
 * count, draw calls and payload bytes are the same number on a workstation, in
 * CI, and on a phone.
 *
 * RE-DERIVED IN PHASE 3a, AND THE PHASE 2b NUMBERS WERE ALL BREACHED ON
 * PURPOSE. Water roughly doubles draw calls over open sea -- one extra mesh per
 * submerged node -- and adds up to 55,068 bytes and 2,048 triangles to a node
 * that is entirely at sea. Phase 2b said so in advance and said the limit
 * firing was the intended outcome rather than a reason to raise it quietly.
 *
 * Measured on the 300 s run over the (-7000, -3500) flight, whose shallow leg
 * crosses 3.5 km of open water:
 *
 *   draw calls        292 peak  =  199 terrain-only  +  93 water
 *   live triangles    1,229,124 peak  (428,796 of it water)
 *   live vertices     610,917 peak
 *   payload           92.5 MB peak, averaging 111,684 bytes a node
 *
 * The first three get ~1.7x headroom, matching the factor Phase 2b used. They
 * remain far under the project ceiling of 1200 draw calls: the ceiling says
 * what the hardware can take, these say what the world costs today.
 */
const MAX_LIVE_TRIANGLES = 2_100_000; // 3a measured 1,229,124 -- 5 measured 1,368,596, 1.53x
const MAX_LIVE_VERTICES = 1_040_000; //  3a measured   610,917 -- 5 measured   673,805, 1.54x
/**
 * RE-DERIVED IN PHASE 5, AND IT IS THE ONLY ONE OF THE FOUR THAT MOVED.
 *
 * A deck is the first geometry since Phase 3a's water to cost a draw call of its
 * own, and Phase 4b said in advance that this phase should expect to move these
 * numbers rather than raise a limit quietly. The measured shallow-leg peak went
 * from 292 to 398. TWO SEPARATE THINGS DID THAT and they are worth keeping
 * apart, because only one of them is this phase's content:
 *
 *   decks themselves     +34 at the peak frame (`draws without it` reads 364)
 *   the flight moved     +72, and it is not the START that moved -- it is that
 *                        the flight now actually begins there. The autopilot is
 *                        held until the soak has read its baseline (see
 *                        `holdFlight`), and before that the camera had already
 *                        drifted up to 1.3 km downrange while Node polled for
 *                        readiness. Every earlier number in this column was
 *                        measured over a route nobody chose.
 *
 * 680 is 1.71x the new peak -- the same factor Phase 2b and 3a used -- and still
 * a long way under RULE 5's ceiling of 1200. The ceiling says what the hardware
 * can take; this says what the world costs today, so a regression fails instead
 * of quietly consuming slack. The other three limits are deliberately NOT
 * raised: they were not breached, they still hold 1.5x, and a limit with less
 * slack catches a regression sooner.
 */
const MAX_DRAW_CALLS = 680; //           3a measured       292 -- 5 measured       398, 1.71x
/**
 * Live plus cached payload bytes held by the streamer. Measured 92.5 MB peak.
 *
 * THIS ONE CANNOT HAVE 1.7x HEADROOM, and pretending otherwise would make it
 * unfireable -- the mistake Phase 2a made and Phase 2b caught. It is
 * structurally capped: the LRU holds 512 nodes over a live set of ~318, and the
 * most expensive possible node is one entirely at sea at 129,744 bytes, so the
 * absolute ceiling is about 108 MB. Anything above that could never fire.
 *
 * PHASE 5 RAISES THAT CEILING AND LEAVES THE BUDGET WHERE IT IS. A deck adds up
 * to about 28 kB to a node at lod 0 and 70 kB to one at the root level, so the
 * worst possible node is now nearer 158 kB and the structural ceiling nearer
 * 131 MB. The measured peak barely moved -- 84.8 MB to 86.8 MB -- because decks
 * are sparse and the flight is mostly over sea and empty hillside, which is the
 * whole reason an absent deck is required to cost exactly zero bytes.
 *
 * 100 MB is 1.15x the measured peak and comfortably below 131, so a per-node
 * size regression -- the thing this budget actually guards -- still trips it.
 * Be aware of the cost of that tightness: a flight spending its whole length
 * over open ocean rather than half of it would legitimately land nearer 104 MB.
 * If this fires, check `bytes per chunk` in the report before assuming a bug;
 * that figure is the one that isolates a real regression from a wetter route.
 */
/**
 * Peak transferable bytes across live + cached chunks.
 *
 * Phase 7a measured 106.5 MB with forests resident (prop submeshes on lod 0-2).
 * Re-derived from that run rather than raised quietly: 120 MB leaves ~12%
 * headroom over the measured peak without inviting unbounded growth.
 */
const MAX_CHUNK_BYTES = 120 * 1024 * 1024;

/**
 * Pitch in degrees for the two legs of the flight.
 *
 * The outbound leg keeps Phase 2a's angle so the two runs stay comparable; the
 * return leg drops to the horizon, which is where the quadtree's outer rings
 * enter the frustum and where every geometry budget above is actually decided.
 */
const OUTBOUND_PITCH = -18;
const SHALLOW_PITCH = -3;

/**
 * Below this many draw calls on the shallow leg, the canary is not looking at
 * the world and its budgets prove nothing. This is the anti-vacuity guard for
 * the whole geometry section: Phase 2a's canary passed at 105 draw calls
 * against a limit of 1200 and would have passed at 105 forever.
 */
const MIN_SHALLOW_DRAW_CALLS = 55;

/**
 * WHERE THE FLIGHT STARTS, AND WHY IT IS NOT THE ORIGIN ANY MORE.
 *
 * Phase 3a's third vacuity trap, and the sharpest one this project has hit. The
 * autopilot flies along X from a fixed start; on seed "soak" the line z = 0 is
 * DRY FOR ALL 6.75 km OF IT. Every water assertion in this file -- water
 * generated, water drawn, water byte-identical after a round trip -- would have
 * passed by never encountering any, and the phase would have shipped green
 * having verified nothing.
 *
 * (-7000, -3500) was 3.5 km of open sea on that seed, with a coastline and
 * mountains beyond it, so a single flight crossed deep water, a shoreline and
 * dry land, and the 5x5 square of lod-0 chunks around the start was submerged
 * and carved.
 *
 * PHASE 4a MOVED IT AGAIN, AND FOR THE THIRD TIME THE REASON IS THE SAME TRAP.
 * Roads are far sparser than rivers -- about twenty per 4 km region against
 * hundreds of stream channels -- and the (-7000, -3500) line passed EXACTLY
 * ZERO of them in 6.75 km, with no road in any of the 25 round-tripped chunks.
 * Every road assertion below would have passed without ever meeting a road.
 *
 * (-7500, -3600) was chosen by searching the seed for a start that keeps all
 * three claims real at once, rather than by trading one away:
 *
 *   round-tripped 5x5 square   road 11/25   river 14/25   sea 15/25
 *   along the 6.75 km line     road  5/140  river 19/140  sea 80/140
 *
 * Sea along the line drops from 108 samples to 80 -- still 2.7 km of open
 * water -- and the river count is essentially unchanged.
 *
 * PHASE 4b MOVED IT A FOURTH TIME, AND THE TRAP WAS ALREADY SPRUNG. Streets
 * exist only inside a settlement, and a settlement is a 250 m disc in a 16 km^2
 * region -- far rarer than a road, let alone a river. Measured on the
 * (-7500, -3600) square: sea 11/25, river 12/25, road 7/25 and street 0/25. Not
 * one of the twenty-five round-tripped chunks contained a street, so the
 * byte-identical-regeneration check would have said nothing whatever about the
 * phase that had just been written.
 *
 * (-6749, -4140) was found by generating the real 5x5 square at every 64 m
 * offset around every settlement within reach of the corridor and MAXIMISING
 * THE WORST of the four counts, rather than by trading three away for the
 * fourth. It sits just off a coastal village at y = 4.2 m:
 *
 *   round-tripped 5x5 square   sea 16/25   river 9/25   road 12/25   street 10/25
 *
 * Every one of the four is better than or comparable to what the Phase 4a start
 * gave, and the weakest of them went from 0 to 9. Check `sea at the start`,
 * `river at the start`, `road at the start` and `street at the start` in the
 * report after any future move: all four go quiet without failing if the route
 * stops being interesting.
 */
// Seed `soak`, city cell (-19, 4). Starts at its keep (city centre + 0.08R)
// so walls, city streets and one interior cannot pass vacuously.
const START_X = -9603;
const START_Z = 2310;

/**
 * Water submeshes that must actually reach the rasteriser at some point, and
 * on the shallow leg specifically.
 *
 * `waterNodes` alone is not enough: a run could hold three hundred nodes of sea
 * in memory with the camera pointed at a mountain and call it a pass.
 * `waterDrawCalls` is counted from `Object3D.onBeforeRender`, so it is a
 * measurement of pixels-were-attempted rather than of residency.
 */
const MIN_WATER_DRAW_CALLS = 30; //         measured 93 peak
const MIN_SHALLOW_WATER_DRAW_CALLS = 25; // measured 93 peak

/**
 * PHASE 3b: THE SAME GUARD FOR RIVERS, AND IT MATTERS MORE.
 *
 * Water is its own submesh, so "was any sea drawn" is answerable by looking at
 * the object list. A river is not a mesh -- it is a dent in the terrain mesh
 * every node already had. Without a counter, "the flight never went near a
 * river" and "carving silently returns zero" produce identical evidence, and
 * every river assertion in this file would pass on either.
 *
 * `riverNodes` is carved terrain that is resident; `riverDrawCalls` comes from
 * `Object3D.onBeforeRender` on nodes whose payload reported carved vertices, so
 * it measures carved ground that reached the rasteriser. Both are needed, and
 * the shallow leg is checked separately because that is the leg the geometry
 * budgets are decided on.
 *
 * On seed "soak" the flight from (-7000, -3500) crosses several drowned
 * channels on the sea floor and a carved valley inland; the 5x5 square of
 * lod-0 chunks it round-trips contains carved ground, which is what makes the
 * byte-identical-regeneration check a statement about rivers as well.
 */
const MIN_RIVER_NODES = 60; //              measured 174 peak of 318 live
const MIN_RIVER_DRAW_CALLS = 20; //         measured  64 peak
const MIN_SHALLOW_RIVER_DRAW_CALLS = 20; // measured  61 peak

/**
 * PHASE 4a: THE SAME GUARD AGAIN, FOR ROADS.
 *
 * A road is not a mesh either -- it is surfacing and grading applied to the
 * terrain mesh every node already had -- so it needs its own counter for
 * exactly the reason rivers do.
 *
 * ROADS ARE MUCH SPARSER THAN RIVERS, AND THE FLOORS SAY SO. A region carries
 * about twenty roads in 16 km^2 against hundreds of stream channels, so a
 * flight crosses far fewer of them and the floors here are a fraction of the
 * river ones. They are still floors, not decoration: a run that touches no road
 * at all has verified nothing about Phase 4a, however green it looks.
 *
 * `roadNodes` is surfaced terrain that is resident; `roadDrawCalls` comes from
 * `Object3D.onBeforeRender`, so it measures surfaced ground that reached the
 * rasteriser. Both are needed, and the shallow leg is checked separately
 * because that is the leg the geometry budgets are decided on.
 */
const MIN_ROAD_NODES = 25; //              measured  86 peak of 306 live
const MIN_ROAD_DRAW_CALLS = 8; //          measured  25 peak
const MIN_SHALLOW_ROAD_DRAW_CALLS = 8; //  measured  25 peak

/**
 * PHASE 4b: THE SAME GUARD ONCE MORE, FOR SECTOR-TIER STREETS, AND THIS IS THE
 * SPARSEST SIGNAL IN THE FILE.
 *
 * A street is not a mesh either. It is also far more local than a road: roads
 * run for kilometres between settlements, streets exist only INSIDE one, so a
 * node carries street surfacing only while the camera is close enough for the
 * quadtree to keep that ground at a fine level. `ChunkData.streetVertices`
 * counts the SECTOR-tier contribution alone and not the settlement pad, which
 * matters -- the pad already surfaces every vertex in the village, so a
 * combined count would be non-zero with no streets in it at all.
 *
 * The floors are therefore small, and small is not the same as decorative: the
 * whole point is that a run which never reaches a village has verified nothing
 * about Phase 4b however green it looks. They are set at roughly a third of a
 * measured run, which is the same margin the road floors use.
 */
const MIN_STREET_NODES = 12; //             measured  44 peak of 309 live
const MIN_STREET_DRAW_CALLS = 4; //         measured  14 peak
const MIN_SHALLOW_STREET_DRAW_CALLS = 4; // measured  14 peak

/**
 * PHASE 5: THE SAME GUARD FOR DECKS, AND THE FIRST ONE SINCE PHASE 3a WHERE
 * "DRAWN" AND "RESIDENT" ARE DIFFERENT OBJECTS RATHER THAN THE SAME ONE.
 *
 * Rivers, roads and streets are all features of the terrain mesh, so their
 * `*DrawCalls` counters come off `onBeforeRender` on that mesh. A deck is its
 * own submesh, like water, so `deckDrawCalls` counts the deck being submitted.
 * Both halves still matter for the same reason they do for water: a world full
 * of carriageway that never enters the frustum would pass every check written
 * against residency alone.
 *
 * `bridgeNodes` is the sharpest of them and the one this phase actually turns
 * on. A road crossing a river was a FORD until now -- `grading.ts` yields inside
 * a channel, so the roadbed ran to the bank and stopped. The deck spans it, and
 * this is the only number in the run that says the span happened: it is measured
 * off the GEOMETRY (deck stations standing clear of the ground), not off
 * `RoadNetwork.segCrossing`, which said a crossing was there long before
 * anything was built over it.
 *
 * IT IS CUMULATIVE, AND THAT IS NOT A CONVENIENCE. Bridges are counted at lod 0
 * only (see `BRIDGE_COUNT_LOD`), so a bridge node is resident for about seven
 * seconds as the camera passes it, against a five-second sampling interval --
 * an instantaneous peak would be a coin flip, and a floor built on a coin flip
 * is a check people re-run until it goes green. `bridgeNodes` only rises, so it
 * cannot be missed between two samples. The instantaneous vertex count is still
 * reported, because it is what says how big the bridge was.
 *
 * Measured on the corridor offline before the floor was set: four chunk columns
 * carry a bridge, around x = -3,700, which the flight passes at about t = 68 s
 * outbound and t = 232 s on the return.
 */
const MIN_DECK_NODES = 20; //              measured  89 peak of 304 live
const MIN_DECK_DRAW_CALLS = 8; //          measured  24 peak
const MIN_SHALLOW_DECK_DRAW_CALLS = 8; //  measured  24 peak
const MIN_BRIDGE_NODES = 2; //             measured  10 over the run

/**
 * PHASE 6: THE SAME GUARD FOR BUILDINGS, AND THE THINNEST SIGNAL YET.
 *
 * A building exists only inside a settlement, and a settlement is a couple of
 * hundred metres across in a 4 km region. The flight passes two of them, for a
 * few seconds each, so this phase has the weakest evidence of any so far and
 * needs the most care about what the numbers actually claim:
 *
 *  - `buildingsSeen` is CUMULATIVE, for the reason `bridgeNodes` is. Village
 *    nodes are resident for a handful of seconds against a five-second sampling
 *    interval, so an instantaneous peak is a coin flip and a floor on one is a
 *    check that gets re-run until it goes green.
 *  - `buildingDrawCalls` is what says a house REACHED THE RASTERISER. Every
 *    other number here is satisfied by geometry sitting in a buffer nobody drew.
 *  - `buildingsLevel` is the one that says the houses are standing on ground a
 *    village LEVELLED rather than merely standing somewhere. It is the only
 *    number in the run that goes to zero if the grading, `gradeTarget` or the
 *    lot acceptance tests regress: the buildings would still be placed, still be
 *    drawn, and still round-trip identically, half-buried in a hillside.
 *
 * Floors at roughly a third of a measured run, the margin every other phase's
 * floors use.
 */
const MIN_BUILDING_NODES = 12; //            measured    42 peak of 309 live
const MIN_BUILDINGS_SEEN = 3000; //          measured 12,012 over the run
const MIN_BUILDING_DRAW_CALLS = 4; //        measured    12 peak
const MIN_BUILDINGS_LEVEL_FRACTION = 0.6; // measured  0.96 of lod-0 building-samples
const MIN_CITIES_SEEN = 1;
const MIN_WALL_NODES = 1;
const MIN_INTERIORS_ENTERED = 1;

/**
 * PHASE 7a: THE SAME GUARD FOR PROPS, ON DENSER CONTENT.
 *
 * World vegetation is continuous across the map, so residency and draw-call
 * halves are easier to satisfy than they were for buildings -- but seating is
 * the anti-vacuity number that goes to zero if the stump / groundAt path
 * regresses while props keep being placed and drawn. Floors start conservative
 * and are re-derived from a measured 300 s run; do not raise quietly.
 *
 *  - `propsSeen` is CUMULATIVE.
 *  - `propDrawCalls` says a canopy REACHED THE RASTERISER.
 *  - `propsSeated` says props sit on ground THIS node renders.
 */
const MIN_PROP_NODES = 60; //                 measured   201 peak of 309 live
const MIN_PROPS_SEEN = 20000; //              measured 66,719 over the run
const MIN_PROP_DRAW_CALLS = 20; //            measured    68 peak
const MIN_PROPS_SEATED_FRACTION = 0.7; //     measured  1.00 of lod-0 prop-samples

/**
 * PHASE 7b: EACH VILLAGE LAYOUT FAMILY MUST APPEAR.
 *
 * Street vertices alone cannot tell a ring-only world from a mixed one. The
 * streamer counts chunks generated per `streetLayout` family; a floor of one
 * on each is the anti-vacuity half. Re-derive after a measured run if the
 * flight corridor stops hitting a family.
 */
const MIN_LAYOUT_SEEN = 1;
/** Per building kind. A cottage-only world must fail, not pass on total count. */
const MIN_KIND_SEEN = 1;
/** Per prop species / yard role. A pine-only world must fail, not pass on total. */
const MIN_PROP_SPECIES_SEEN = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Least-squares slope of y against x. */
function slope(points) {
  const n = points.length;
  if (n < 3) return 0;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const min = (values) => values.reduce((a, b) => Math.min(a, b), Infinity);
const max = (values) => values.reduce((a, b) => Math.max(a, b), -Infinity);
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/**
 * Collect a garbage-free heap reading.
 *
 * `usedJSHeapSize` without a preceding collection measures uncollected garbage
 * as much as it measures a leak, and a soak test that cannot tell those apart
 * is worthless. `HeapProfiler.collectGarbage` over CDP is the only way to force
 * the issue from outside the page.
 */
async function sample(page, cdp) {
  try {
    await cdp.send('HeapProfiler.collectGarbage');
  } catch {
    // Best effort: still worth sampling if the domain is unavailable.
  }
  return page.evaluate(() => window.__app.perfSnapshot());
}

async function waitForSettled(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__app.worldSettled())) return true;
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (!SKIP_BUILD) buildProject();

const server = await startStaticServer(DIST_DIR);
const browser = await launchBrowser({
  // Without this Chrome quantises usedJSHeapSize into coarse buckets, which
  // hides exactly the slow growth this test is looking for.
  extraArgs: ['--enable-precise-memory-info'],
});

const legSeconds = SECONDS / 2;
const url =
  `${server.url}?seed=${encodeURIComponent(SEED)}&panel=0&hud=1` +
  // yaw -90 faces +X, which is the direction the autopilot travels, so chunks
  // stream in ahead of the camera rather than behind it.
  `&fly=${SPEED}&flyleg=${legSeconds}&walk=1&pos=${START_X},90,${START_Z}&look=-90,${OUTBOUND_PITCH}`;

let exitCode = 0;
const failures = [];
const warnings = [];
/**
 * Whether this run was long enough to judge the heap trend at all. Reported in
 * the final line, so a short run can never be mistaken for a leak check that
 * passed -- the soak's headline purpose.
 */
let heapTrendJudged = false;

console.log('');
console.log(`soak: ${SECONDS}s at ${SPEED} m/s, seed "${SEED}", sampling every ${INTERVAL}s`);
console.log(`      ${url}`);
console.log('');

try {
  const { context, page, consoleErrors, failedRequests } = await openPage(browser, url, {
    // Match READY_TIMEOUT_MS in browser.mjs -- 60s was a coin flip under a
    // loaded SwiftShader host once building kind variety raised first-frame work.
    timeout: 120000,
    // The flight stays parked at `?pos=` until every baseline below has been
    // read. See `holdFlight` in `lib/browser.mjs` for the run that made this
    // necessary and for why `__worldReady` alone was not enough.
    holdFlight: true,
  });
  const cdp = await context.newCDPSession(page);

  // Baseline GEOMETRY where the flight starts, read from the chunks that are
  // actually resident: a hash of each chunk's uploaded position buffer.
  //
  // Phase 1 compared flat colours here. That could only ever prove the
  // coordinate hash was pure. Hashing the vertex bits proves the thing that is
  // actually expensive to reproduce -- the mesh -- is byte-identical after an
  // unload and a regeneration, which is what RULE 2 claims.
  //
  // Anchored to the camera's real position rather than to `START_X` / `START_Z`
  // directly, which is belt and braces: since Phase 4b the autopilot does not
  // begin until `__worldReady`, so the two are the same point. They used not to
  // be. The flight advanced from the first rendered frame, so by the time this
  // ran the camera had drifted 400-900 m downrange depending on how long the
  // world took to stream -- which meant every "at the start" claim below was
  // about a square nobody had chosen, and could not be tuned reproducibly.
  // Phase 4b found this by picking a start with a village in it and measuring
  // street 0/25 in the run. See `App.renderFrame`.
  const origin = await page.evaluate(() => window.__app.perfSnapshot());
  const originX = origin.cameraX;
  const originZ = origin.cameraZ;
  const geometryBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkGeometry(x, z, 2),
    [originX, originZ],
  );
  const loadedBefore = geometryBefore.filter((h) => h !== null).length;
  // How much of the round-tripped square is sea. The geometry hash folds the
  // water buffers in, so this is what says that hash was a claim about water
  // and not only about the ground under it.
  const waterBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkWater(x, z, 2),
    [originX, originZ],
  );
  const waterChunksAtStart = waterBefore.filter((t) => t !== null && t > 0).length;
  // ...and how much of it a river carved. Same role: the geometry hash covers
  // carved ground automatically, because carving moves the very vertices it
  // hashes -- but only if the round-tripped square had a river in it.
  const riverBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkRivers(x, z, 2),
    [originX, originZ],
  );
  const riverChunksAtStart = riverBefore.filter((v) => v !== null && v > 0).length;

  // ...and whether a road reached it. Same role again: grading and surfacing
  // move and recolour vertices the geometry hash already covers, but only if
  // the round-tripped square had a road in it.
  const roadBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkRoads(x, z, 2),
    [originX, originZ],
  );
  const roadChunksAtStart = roadBefore.filter((v) => v !== null && v > 0).length;

  // ...and whether a STREET reached it. The narrowest of the four claims: the
  // square has to be inside a village, not merely near a road.
  const streetBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkStreets(x, z, 2),
    [originX, originZ],
  );
  const streetChunksAtStart = streetBefore.filter((v) => v !== null && v > 0).length;

  // ...and whether a DECK reached it. Phase 5 folds `deckPositions` into the
  // geometry hash, so without a carriageway in the round-tripped square that
  // half of the hash is the hash of an empty array and RULE 2 says nothing
  // whatever about the phase that was just written.
  const deckBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkDecks(x, z, 2),
    [originX, originZ],
  );
  const deckChunksAtStart = deckBefore.filter((t) => t !== null && t > 0).length;

  // ...and whether a BUILDING stands in it. Phase 6 folds `buildingPositions`
  // into the geometry hash, and the narrowest claim of the five: the square has
  // to contain a house, not merely be inside a village. Without one, that term
  // of the hash is the hash of an empty array on every chunk compared.
  const buildingsBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkBuildings(x, z, 2),
    [originX, originZ],
  );
  const buildingChunksAtStart = buildingsBefore.filter((b) => b !== null && b > 0).length;

  // ...and whether a PROP stands in it. Phase 7a folds `propPositions` into the
  // geometry hash. Without vegetation in the round-tripped square that term is
  // the hash of an empty array on every chunk compared.
  const propsBefore = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkProps(x, z, 2),
    [originX, originZ],
  );
  const propChunksAtStart = propsBefore.filter((p) => p !== null && p > 0).length;

  // Discard start-up hitches from the worst-frame figure: the first frames
  // compile shaders and build a hundred meshes, and that is not the leak.
  await page.evaluate(() => window.__app.resetFrameStats());

  // Every baseline above was read with the camera parked exactly at `?pos=`.
  // Release the flight only now, so "at the start" means the square this file
  // names rather than wherever the camera drifted to while Node was polling.
  await page.evaluate(() => {
    window.__flightReleased = true;
  });

  const samples = [];
  const startedAt = Date.now();
  let nextSampleAt = startedAt;
  let shallow = false;

  while (Date.now() - startedAt < SECONDS * 1000) {
    const wait = nextSampleAt - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 1000));
    if (Date.now() < nextSampleAt) continue;
    nextSampleAt += INTERVAL * 1000;

    // Halfway through -- exactly where the autopilot turns around -- drop the
    // camera to the horizon for the return leg. Draw calls and triangle counts
    // read off a steeply pitched view measure frustum culling, not the world,
    // and a budget measured there can never fail.
    if (!shallow && Date.now() - startedAt >= (SECONDS * 1000) / 2) {
      await page.evaluate((pitch) => window.__app.setLook(-90, pitch), SHALLOW_PITCH);
      shallow = true;
      console.log(`  --- pitch to ${SHALLOW_PITCH} deg: shallow leg begins ---`);
    }

    const snapshot = await sample(page, cdp);
    snapshot.t = (Date.now() - startedAt) / 1000;
    snapshot.shallow = shallow;
    samples.push(snapshot);

    const line =
      `  t=${String(Math.round(snapshot.t)).padStart(4)}s  ` +
      `heap ${snapshot.heapMb.toFixed(1).padStart(6)} MB  ` +
      `live ${String(snapshot.liveChunks).padStart(4)}  ` +
      `cached ${String(snapshot.cachedChunks).padStart(4)}  ` +
      `gen ${String(snapshot.generatedChunks).padStart(6)}  ` +
      `cancel ${String(snapshot.cancelledChunkRequests).padStart(5)}  ` +
      `evict ${String(snapshot.evictedChunks).padStart(6)}  ` +
      `draws ${String(snapshot.drawCalls).padStart(4)}  ` +
      `water ${String(snapshot.waterDrawCalls).padStart(3)}/${String(snapshot.waterNodes).padStart(3)}  ` +
      `river ${String(snapshot.riverDrawCalls).padStart(3)}/${String(snapshot.riverNodes).padStart(3)}  ` +
      `road ${String(snapshot.roadDrawCalls).padStart(3)}/${String(snapshot.roadNodes).padStart(3)}  ` +
      `street ${String(snapshot.streetDrawCalls).padStart(3)}/${String(snapshot.streetNodes).padStart(3)}  ` +
      `deck ${String(snapshot.deckDrawCalls).padStart(3)}/${String(snapshot.deckNodes).padStart(3)}  ` +
      `fps ${snapshot.fps.toFixed(1).padStart(5)}  ` +
      `x ${Math.round(snapshot.cameraX)}${snapshot.shallow ? '  shallow' : ''}`;
    console.log(line);
  }

  // The flight ends where it started, but the chunks around the origin have to
  // stream back in before their geometry can be compared.
  const returned = await waitForSettled(page, 60000);
  const finalSnapshot = await sample(page, cdp);
  const finalLod = await page.evaluate(() => window.__app.lodCounts());
  const geometryAfter = await page.evaluate(
    ([x, z]) => window.__app.sampleChunkGeometry(x, z, 2),
    [originX, originZ],
  );

  await context.close();

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  const heaps = samples.map((s) => s.heapMb);
  const lives = samples.map((s) => s.liveChunks);
  const draws = samples.map((s) => s.drawCalls);
  const liveTris = samples.map((s) => s.chunkTriangles);
  const liveVerts = samples.map((s) => s.chunkVertices);
  const chunkBytes = samples.map((s) => s.chunkBytes);
  // The shallow leg is where the geometry budgets are actually decided; the
  // steep one is kept only so the two halves can be compared in the report.
  const shallowSamples = samples.filter((s) => s.shallow === true);
  const shallowDraws = shallowSamples.map((s) => s.drawCalls);
  const waterDraws = samples.map((s) => s.waterDrawCalls);
  const waterNodes = samples.map((s) => s.waterNodes);
  const waterTris = samples.map((s) => s.waterTriangles);
  const shallowWaterDraws = shallowSamples.map((s) => s.waterDrawCalls);
  const riverDraws = samples.map((s) => s.riverDrawCalls);
  const riverNodes = samples.map((s) => s.riverNodes);
  const riverVerts = samples.map((s) => s.riverVertices);
  const shallowRiverDraws = shallowSamples.map((s) => s.riverDrawCalls);
  const roadDraws = samples.map((s) => s.roadDrawCalls);
  const roadNodes = samples.map((s) => s.roadNodes);
  const roadVerts = samples.map((s) => s.roadVertices);
  const shallowRoadDraws = shallowSamples.map((s) => s.roadDrawCalls);
  const streetDraws = samples.map((s) => s.streetDrawCalls);
  const streetNodes = samples.map((s) => s.streetNodes);
  const streetVerts = samples.map((s) => s.streetVertices);
  const shallowStreetDraws = shallowSamples.map((s) => s.streetDrawCalls);
  const deckDraws = samples.map((s) => s.deckDrawCalls);
  const deckNodes = samples.map((s) => s.deckNodes);
  const deckTris = samples.map((s) => s.deckTriangles);
  const bridgeVerts = samples.map((s) => s.bridgeVertices);
  const shallowDeckDraws = shallowSamples.map((s) => s.deckDrawCalls);
  const buildingDraws = samples.map((s) => s.buildingDrawCalls);
  const buildingNodes = samples.map((s) => s.buildingNodes);
  const buildingsLive = samples.map((s) => s.buildings);
  const buildingTris = samples.map((s) => s.buildingTriangles);
  // Levelness is only measured at lod 0, so the fraction is taken against
  // `buildingsMeasured` -- the lod-0 buildings of the SAME sample -- and not
  // against `buildings`, which counts a village resident at four levels at once.
  const measuredBuildings = samples.reduce((sum, s) => sum + s.buildingsMeasured, 0);
  const levelBuildings = samples.reduce((sum, s) => sum + s.buildingsLevel, 0);
  const levelFraction = measuredBuildings === 0 ? 0 : levelBuildings / measuredBuildings;
  const propDraws = samples.map((s) => s.propDrawCalls);
  const propNodes = samples.map((s) => s.propNodes);
  const propsLive = samples.map((s) => s.props);
  const propTris = samples.map((s) => s.propTriangles);
  const measuredProps = samples.reduce((sum, s) => sum + s.propsMeasured, 0);
  const seatedProps = samples.reduce((sum, s) => sum + s.propsSeated, 0);
  const seatedFraction = measuredProps === 0 ? 0 : seatedProps / measuredProps;
  const steepDraws = samples.filter((s) => s.shallow !== true).map((s) => s.drawCalls);
  // Where the heap trend window starts.
  //
  // The heap ramps while the LRU cache fills toward its cap, and that fill takes
  // a fixed wall-clock time set by generation throughput -- NOT a fixed fraction
  // of the run. Discarding a fraction alone works at the default 300s and
  // silently fits the trend straight through the ramp at 90s, reporting a leak
  // that is not there. Steady state is observable rather than guessable: it
  // begins once the cache has saturated and eviction is recycling entries.
  const byFraction = Math.floor(samples.length * WARMUP_FRACTION);
  const firstEviction = samples.findIndex((s) => s.evictedChunks > 0);
  const saturated = firstEviction >= 0;
  const warmupCount = saturated ? Math.max(byFraction, firstEviction) : byFraction;

  const trendSamples = samples.slice(warmupCount);
  const heapSlopeMbPerMin = slope(trendSamples.map((s) => [s.t / 60, s.heapMb]));

  /**
   * WHAT THE TREND IS FITTED ON, AND WHY IT IS NO LONGER THE RAW HEAP.
   *
   * Phase 3a made the resident payload depend on WHERE THE CAMERA IS. A node
   * entirely at sea carries 129,744 bytes against an inland node's 74,676, so
   * the heap now rises and falls by tens of megabytes purely as a function of
   * how much sea is within the view distance. The Phase 3a flight starts over
   * open water, crosses a coast into mountains, and comes back, which makes the
   * raw heap a V -- and a least-squares line through a V whose warm-up window
   * clips one arm reports a steep, entirely fictional "leak". The first run
   * measured +13.3 MB/min this way, on a heap that ended 8 MB above where it
   * started after covering 13.5 km.
   *
   * Discarding more warm-up does not fix it; nothing about the window is wrong.
   * What is wrong is the quantity. A leak is heap that is NOT accounted for by
   * the chunk payload the streamer is knowingly holding, so that is what gets
   * the trend line: heap minus the streamer's own byte count. The payload
   * itself is not unwatched -- it has its own hard budget (MAX_CHUNK_BYTES),
   * structurally capped by the LRU, and a per-node figure in the report.
   *
   * This is strictly a better leak detector than the raw fit, not a weaker one.
   * A retained mesh whose entry has already been evicted -- the exact failure
   * disposal exists to prevent -- leaves the streamer's byte count and stays in
   * the heap, so it shows up here and nowhere else. The raw trend is still
   * printed, because it is what a human watching the numbers expects to see.
   */
  const residualOf = (s) => s.heapMb - s.chunkBytes / 1048576;
  const residualSlopeMbPerMin = slope(trendSamples.map((s) => [s.t / 60, residualOf(s)]));

  // A trend fitted before the cache saturates measures the cache filling, not a
  // leak. Say so instead of accusing the code of leaking -- a check that cries
  // wolf on a short run is a check people stop reading.
  const trendJudgeable = saturated && trendSamples.length >= MIN_TREND_SAMPLES;
  heapTrendJudged = trendJudgeable;

  const firstThird = heaps.slice(warmupCount, warmupCount + Math.ceil(trendSamples.length / 3));
  const lastThird = heaps.slice(-Math.ceil(trendSamples.length / 3));

  console.log('');
  console.log('heap');
  console.log(`  samples          ${samples.length} over ${SECONDS}s`);
  console.log(`  first / last     ${heaps[0]?.toFixed(1)} MB -> ${heaps.at(-1)?.toFixed(1)} MB`);
  console.log(`  min / mean / max ${min(heaps).toFixed(1)} / ${mean(heaps).toFixed(1)} / ${max(heaps).toFixed(1)} MB`);
  console.log(`  early / late avg ${mean(firstThird).toFixed(1)} MB -> ${mean(lastThird).toFixed(1)} MB (post-warmup)`);
  console.log(
    `  raw trend        ${heapSlopeMbPerMin >= 0 ? '+' : ''}${heapSlopeMbPerMin.toFixed(2)} MB/min ` +
      '(reported only: since Phase 3a this tracks how much sea is in view)',
  );
  console.log(
    `  UNEXPLAINED      ${residualSlopeMbPerMin >= 0 ? '+' : ''}${residualSlopeMbPerMin.toFixed(2)} MB/min ` +
      `(limit ${MAX_HEAP_SLOPE_MB_PER_MIN}) -- heap minus chunk payload; THIS is the leak check`,
  );
  console.log(
    `  residual         ${residualOf(samples[0]).toFixed(1)} MB -> ${residualOf(samples.at(-1)).toFixed(1)} MB`,
  );
  if (!trendJudgeable) {
    console.log(
      `  trend NOT judged  the chunk cache never saturated in ${SECONDS}s, so the ` +
        'figure above is the cache filling, not a leak. Use the default 300s.',
    );
  }

  console.log('');
  console.log('chunks');
  console.log(`  live min/mean/max ${min(lives)} / ${mean(lives).toFixed(1)} / ${max(lives)}`);
  console.log(`  selected at end   ${finalSnapshot.selectedNodes} nodes, lod [${finalLod.join(' ')}]`);
  console.log(`  view distance     ${finalSnapshot.viewDistance} m (root lod ${finalSnapshot.rootLod})`);
  console.log(`  cached at end     ${finalSnapshot.cachedChunks}`);
  console.log(`  generated total   ${finalSnapshot.generatedChunks}`);
  console.log(`  cancelled total   ${finalSnapshot.cancelledChunkRequests}`);
  console.log(`  evicted total     ${finalSnapshot.evictedChunks}`);
  console.log(`  workers           ${finalSnapshot.workers}`);

  console.log('');
  console.log('geometry (GPU-independent, hard budgets)');
  console.log(`  live triangles    ${max(liveTris)} peak (budget ${MAX_LIVE_TRIANGLES})`);
  console.log(`  live vertices     ${max(liveVerts)} peak (budget ${MAX_LIVE_VERTICES})`);
  console.log(
    `  payload bytes     ${(max(chunkBytes) / 1048576).toFixed(1)} MB peak (budget ${MAX_CHUNK_BYTES / 1048576} MB)`,
  );
  console.log(`  draw calls        ${max(draws)} peak (budget ${MAX_DRAW_CALLS})`);
  console.log(
    `  bytes per chunk   ${Math.round(finalSnapshot.chunkBytes / Math.max(1, finalSnapshot.liveChunks + finalSnapshot.cachedChunks))}`,
  );
  console.log(
    `  steep leg peak    ${steepDraws.length === 0 ? 'n/a' : max(steepDraws)} draw calls at ${OUTBOUND_PITCH} deg`,
  );
  console.log(
    `  SHALLOW leg peak  ${shallowDraws.length === 0 ? 'n/a' : max(shallowDraws)} draw calls at ${SHALLOW_PITCH} deg` +
      ` (${shallowSamples.length} samples, floor ${MIN_SHALLOW_DRAW_CALLS})`,
  );

  console.log('');
  console.log('water (Phase 3a)');
  console.log(`  live water nodes  ${max(waterNodes)} peak of ${max(lives)} live nodes`);
  console.log(`  water triangles   ${max(waterTris)} peak`);
  console.log(`  water DRAWN       ${max(waterDraws)} peak (floor ${MIN_WATER_DRAW_CALLS})`);
  console.log(
    `  ...on shallow leg ${shallowWaterDraws.length === 0 ? 'n/a' : max(shallowWaterDraws)} peak` +
      ` (floor ${MIN_SHALLOW_WATER_DRAW_CALLS})`,
  );
  console.log(
    `  draws without it  ${max(draws.map((d, i) => d - waterDraws[i]))} peak terrain-only draw calls`,
  );
  console.log(`  sea at the start  ${waterChunksAtStart}/${waterBefore.length} round-tripped chunks`);

  console.log('');
  console.log('rivers (Phase 3b)');
  console.log(`  carved nodes      ${max(riverNodes)} peak of ${max(lives)} live nodes (floor ${MIN_RIVER_NODES})`);
  console.log(`  carved vertices   ${max(riverVerts)} peak`);
  console.log(`  carved DRAWN      ${max(riverDraws)} peak (floor ${MIN_RIVER_DRAW_CALLS})`);
  console.log(
    `  ...on shallow leg ${shallowRiverDraws.length === 0 ? 'n/a' : max(shallowRiverDraws)} peak` +
      ` (floor ${MIN_SHALLOW_RIVER_DRAW_CALLS})`,
  );
  console.log(`  river at the start ${riverChunksAtStart}/${riverBefore.length} round-tripped chunks`);

  console.log('roads (Phase 4a)');
  console.log(`  surfaced nodes    ${max(roadNodes)} peak of ${max(lives)} live nodes (floor ${MIN_ROAD_NODES})`);
  console.log(`  surfaced vertices ${max(roadVerts)} peak`);
  console.log(`  surfaced DRAWN    ${max(roadDraws)} peak (floor ${MIN_ROAD_DRAW_CALLS})`);
  console.log(
    `  ...on shallow leg ${shallowRoadDraws.length === 0 ? 'n/a' : max(shallowRoadDraws)} peak` +
      ` (floor ${MIN_SHALLOW_ROAD_DRAW_CALLS})`,
  );
  console.log(`  road at the start ${roadChunksAtStart}/${roadBefore.length} round-tripped chunks`);

  console.log('streets (Phase 4b, Sector tier)');
  console.log(`  street nodes      ${max(streetNodes)} peak of ${max(lives)} live nodes (floor ${MIN_STREET_NODES})`);
  console.log(`  street vertices   ${max(streetVerts)} peak`);
  console.log(`  streets DRAWN     ${max(streetDraws)} peak (floor ${MIN_STREET_DRAW_CALLS})`);
  console.log(
    `  ...on shallow leg ${shallowStreetDraws.length === 0 ? 'n/a' : max(shallowStreetDraws)} peak` +
      ` (floor ${MIN_SHALLOW_STREET_DRAW_CALLS})`,
  );
  console.log(
    `  street at the start ${streetChunksAtStart}/${streetBefore.length} round-tripped chunks`,
  );

  console.log('decks and bridges (Phase 5)');
  console.log(`  deck nodes        ${max(deckNodes)} peak of ${max(lives)} live nodes (floor ${MIN_DECK_NODES})`);
  console.log(`  deck triangles    ${max(deckTris)} peak`);
  console.log(`  decks DRAWN       ${max(deckDraws)} peak (floor ${MIN_DECK_DRAW_CALLS})`);
  console.log(
    `  ...on shallow leg ${shallowDeckDraws.length === 0 ? 'n/a' : max(shallowDeckDraws)} peak` +
      ` (floor ${MIN_SHALLOW_DECK_DRAW_CALLS})`,
  );
  console.log(
    `  draws without it  ${max(draws.map((d, i) => d - deckDraws[i]))} peak deck-free draw calls`,
  );
  console.log(`  BRIDGE nodes      ${finalSnapshot.bridgeNodes} over the run (floor ${MIN_BRIDGE_NODES})`);
  console.log(`  bridge vertices   ${max(bridgeVerts)} peak live`);
  console.log(`  deck at the start ${deckChunksAtStart}/${deckBefore.length} round-tripped chunks`);

  console.log('buildings (Phase 6)');
  console.log(
    `  building nodes    ${max(buildingNodes)} peak of ${max(lives)} live nodes (floor ${MIN_BUILDING_NODES})`,
  );
  console.log(`  buildings live    ${max(buildingsLive)} peak`);
  console.log(`  building tris     ${max(buildingTris)} peak`);
  console.log(
    `  buildings DRAWN   ${max(buildingDraws)} peak (floor ${MIN_BUILDING_DRAW_CALLS})`,
  );
  console.log(
    `  draws without it  ${max(draws.map((d, i) => d - buildingDraws[i]))} peak building-free draw calls`,
  );
  console.log(
    `  LEVEL             ${levelBuildings}/${measuredBuildings} lod-0 building-samples` +
      ` = ${(levelFraction * 100).toFixed(0)}% (floor ${(MIN_BUILDINGS_LEVEL_FRACTION * 100).toFixed(0)}%)`,
  );
  console.log(
    `  buildings SEEN    ${finalSnapshot.buildingsSeen} over the run (floor ${MIN_BUILDINGS_SEEN})`,
  );
  console.log(
    `  houses at the start ${buildingChunksAtStart}/${buildingsBefore.length} round-tripped chunks`,
  );
  console.log('medieval cities (C1)');
  console.log(`  city nodes SEEN   ${finalSnapshot.citiesSeen} (floor ${MIN_CITIES_SEEN})`);
  console.log(`  city layouts SEEN ${finalSnapshot.layoutSeenCity}`);
  console.log(`  wall nodes live   ${finalSnapshot.wallNodes}`);
  console.log(`  walls SEEN        ${finalSnapshot.wallsSeen} (floor ${MIN_WALL_NODES})`);
  console.log(
    `  interiors ENTERED ${finalSnapshot.interiorsEntered} (floor ${MIN_INTERIORS_ENTERED})`,
  );

  console.log('props (Phase 7a)');
  console.log(
    `  prop nodes        ${max(propNodes)} peak of ${max(lives)} live nodes (floor ${MIN_PROP_NODES})`,
  );
  console.log(`  props live        ${max(propsLive)} peak`);
  console.log(`  prop tris         ${max(propTris)} peak`);
  console.log(`  props DRAWN       ${max(propDraws)} peak (floor ${MIN_PROP_DRAW_CALLS})`);
  console.log(
    `  draws without it  ${max(draws.map((d, i) => d - propDraws[i]))} peak prop-free draw calls`,
  );
  console.log(
    `  SEATED            ${seatedProps}/${measuredProps} lod-0 prop-samples` +
      ` = ${(seatedFraction * 100).toFixed(0)}% (floor ${(MIN_PROPS_SEATED_FRACTION * 100).toFixed(0)}%)`,
  );
  console.log(`  props SEEN        ${finalSnapshot.propsSeen} over the run (floor ${MIN_PROPS_SEEN})`);
  console.log(
    `  props at the start ${propChunksAtStart}/${propsBefore.length} round-tripped chunks`,
  );

  console.log('village layouts (Phase 7b)');
  console.log(
    `  ring / linear / grid / hilltop seen  ` +
      `${finalSnapshot.layoutSeenRing} / ${finalSnapshot.layoutSeenLinear} / ` +
      `${finalSnapshot.layoutSeenGrid} / ${finalSnapshot.layoutSeenHilltop}` +
      ` (floor ${MIN_LAYOUT_SEEN} each)`,
  );
  console.log('building kinds (Phase 7b)');
  console.log(
    `  cottage / barn / hall seen  ` +
      `${finalSnapshot.buildingsSeenCottage} / ${finalSnapshot.buildingsSeenBarn} / ` +
      `${finalSnapshot.buildingsSeenHall}` +
      ` (floor ${MIN_KIND_SEEN} each)`,
  );
  console.log('prop species (Phase 7c / 7b slice 3)');
  console.log(
    `  pine / broadleaf / bushR / bushT / yard seen  ` +
      `${finalSnapshot.propsSeenPine} / ${finalSnapshot.propsSeenBroadleaf} / ` +
      `${finalSnapshot.propsSeenBushRound} / ${finalSnapshot.propsSeenBushTall} / ` +
      `${finalSnapshot.propsSeenYard}` +
      ` (floor ${MIN_PROP_SPECIES_SEEN} each)`,
  );

  console.log('');
  console.log('frames');
  console.log(`  frames drawn      ${finalSnapshot.frames}`);
  console.log(`  worst frame       ${finalSnapshot.peakFrameMs.toFixed(1)} ms`);
  console.log(`  frames over 20ms  ${finalSnapshot.spikes}`);
  console.log(`  last-window fps   ${finalSnapshot.fps.toFixed(1)}`);

  console.log('');
  console.log('round trip');
  console.log(`  started at        x=${Math.round(originX)} m`);
  console.log(`  travelled to      x=${Math.round(max(samples.map((s) => s.cameraX)))} m`);
  console.log(`  returned to       x=${Math.round(finalSnapshot.cameraX)} m`);
  console.log(
    `  start chunks re-resident: ${geometryAfter.filter((h) => h !== null).length}/${geometryAfter.length}`,
  );
  console.log(
    `  geometry hashes identical: ${geometryBefore.filter((h, i) => h !== null && h === geometryAfter[i]).length}/${loadedBefore}`,
  );

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------

  if (samples.length < 3) failures.push('too few samples to judge a trend');

  // Guard against a green run over an empty world.
  if (max(lives) < MIN_CHUNKS_STREAMED) {
    failures.push(
      `only ${max(lives)} chunks were ever resident (need ${MIN_CHUNKS_STREAMED}). ` +
        'A flat heap over an empty world proves nothing.',
    );
  }
  if (finalSnapshot.generatedChunks <= max(lives)) {
    failures.push(
      `${finalSnapshot.generatedChunks} chunks generated for a peak of ${max(lives)} resident: ` +
        'the camera never streamed anything new, so this was not a flight.',
    );
  }
  if (finalSnapshot.frames < SECONDS * 2) {
    failures.push(`only ${finalSnapshot.frames} frames drawn in ${SECONDS}s; rendering stalled`);
  }
  // Distance TRAVELLED, not absolute X: the flight no longer starts at the
  // origin (see START_X), and an absolute test would have failed the moment
  // the start moved west of it -- for a run that flew perfectly.
  const travelled = max(samples.map((s) => s.cameraX)) - min(samples.map((s) => s.cameraX));
  if (travelled < SPEED * SECONDS * 0.2) {
    failures.push(
      `the camera travelled ${Math.round(travelled)} m in ${SECONDS}s; the autopilot did not run`,
    );
  }

  if (trendJudgeable && residualSlopeMbPerMin > MAX_HEAP_SLOPE_MB_PER_MIN) {
    failures.push(
      `heap not accounted for by chunk payload grew ${residualSlopeMbPerMin.toFixed(2)} MB/min ` +
        `after warm-up, over the ${MAX_HEAP_SLOPE_MB_PER_MIN} MB/min limit. ` +
        'That is a leak, not noise: the streamer let go of those bytes and the ' +
        'heap did not.',
    );
  }
  if (!trendJudgeable) {
    warnings.push(
      `the heap trend was NOT checked: the chunk cache did not saturate within ` +
        `${SECONDS}s. This run cannot detect a leak. Re-run at the default 300s.`,
    );
  }
  if (max(heaps) > MAX_HEAP_MB) {
    failures.push(`peak heap ${max(heaps).toFixed(1)} MB exceeds the ${MAX_HEAP_MB} MB budget`);
  }
  if (max(draws) > MAX_DRAW_CALLS) {
    failures.push(`peak draw calls ${max(draws)} exceeds the ${MAX_DRAW_CALLS} budget`);
  }
  if (max(liveTris) > MAX_LIVE_TRIANGLES) {
    failures.push(
      `peak live triangles ${max(liveTris)} exceeds the ${MAX_LIVE_TRIANGLES} budget`,
    );
  }
  if (max(liveVerts) > MAX_LIVE_VERTICES) {
    failures.push(`peak live vertices ${max(liveVerts)} exceeds the ${MAX_LIVE_VERTICES} budget`);
  }
  if (max(chunkBytes) > MAX_CHUNK_BYTES) {
    failures.push(
      `peak chunk payload ${(max(chunkBytes) / 1048576).toFixed(1)} MB exceeds the ` +
        `${MAX_CHUNK_BYTES / 1048576} MB budget`,
    );
  }
  // Guard the geometry budgets against passing on an empty world: a run that
  // drew nothing would have a beautifully small triangle count.
  if (max(liveTris) < 100_000 || max(liveVerts) < 50_000) {
    failures.push(
      `only ${max(liveTris)} triangles / ${max(liveVerts)} vertices were ever live; ` +
        'the terrain never streamed, so the geometry budgets proved nothing',
    );
  }
  // ...and against passing while pointed at nothing. Phase 2a's canary read 105
  // draw calls against a 1200 limit from a near-nadir view: green forever,
  // whatever the world did. These two make that impossible to repeat.
  if (shallowSamples.length < 3) {
    failures.push(
      `only ${shallowSamples.length} samples were taken on the shallow-pitch leg; ` +
        'the geometry budgets were never measured where they are near their limits',
    );
  } else if (max(shallowDraws) < MIN_SHALLOW_DRAW_CALLS) {
    failures.push(
      `the shallow leg peaked at ${max(shallowDraws)} draw calls, under the ` +
        `${MIN_SHALLOW_DRAW_CALLS} floor. The camera was not looking at the world, ` +
        'so the draw-call budget proved nothing.',
    );
  }

  // ---- water, and the vacuity guards around it --------------------------
  //
  // Every one of these exists because "the flight never went near the sea" is
  // indistinguishable from "water works" to any check that only looks at
  // whether something failed.
  if (max(waterTris) === 0) {
    failures.push(
      'no water geometry was generated at any point in the flight. Either the ' +
        'water surface is broken or the flight path never crossed any sea -- ' +
        'in which case every water check in this run passed vacuously.',
    );
  }
  if (max(waterDraws) < MIN_WATER_DRAW_CALLS) {
    failures.push(
      `water was drawn at most ${max(waterDraws)} times in a frame (floor ` +
        `${MIN_WATER_DRAW_CALLS}). Water existing and water RENDERING are ` +
        'different claims; this run only made the first one.',
    );
  }
  if (shallowSamples.length >= 3 && max(shallowWaterDraws) < MIN_SHALLOW_WATER_DRAW_CALLS) {
    failures.push(
      `the shallow-pitch leg drew water at most ${max(shallowWaterDraws)} times ` +
        `(floor ${MIN_SHALLOW_WATER_DRAW_CALLS}). The draw-call budget is decided ` +
        'on that leg, so it was measured without the thing this phase added.',
    );
  }
  if (waterChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks had water in them, so the ' +
        'byte-identical-regeneration check said nothing about the sea. Move the ' +
        'flight start (START_X / START_Z) over water.',
    );
  }

  // ---- rivers, and the vacuity guards around them -----------------------
  if (max(riverVerts) === 0) {
    failures.push(
      'no river carving was generated at any point in the flight. Either ' +
        'carving is broken or the flight path never went near a river -- in ' +
        'which case every river check in this run passed vacuously.',
    );
  }
  if (max(riverNodes) < MIN_RIVER_NODES) {
    failures.push(
      `only ${max(riverNodes)} carved nodes were ever resident (floor ` +
        `${MIN_RIVER_NODES}). The flight barely touched a river.`,
    );
  }
  if (max(riverDraws) < MIN_RIVER_DRAW_CALLS) {
    failures.push(
      `carved terrain was drawn at most ${max(riverDraws)} times in a frame ` +
        `(floor ${MIN_RIVER_DRAW_CALLS}). Rivers existing and rivers REACHING ` +
        'THE SCREEN are different claims; this run only made the first one.',
    );
  }
  if (shallowSamples.length >= 3 && max(shallowRiverDraws) < MIN_SHALLOW_RIVER_DRAW_CALLS) {
    failures.push(
      `the shallow-pitch leg drew carved terrain at most ${max(shallowRiverDraws)} ` +
        `times (floor ${MIN_SHALLOW_RIVER_DRAW_CALLS}). The draw-call budget is ` +
        'decided on that leg, so it was measured without this phase in it.',
    );
  }
  // ---- roads, and the vacuity guards around them ------------------------
  if (max(roadVerts) === 0) {
    failures.push(
      'no road surfacing was generated at any point in the flight. Either ' +
        'grading is broken or the flight path never passed a road -- in which ' +
        'case every road check in this run passed vacuously.',
    );
  }
  if (max(roadNodes) < MIN_ROAD_NODES) {
    failures.push(
      `only ${max(roadNodes)} surfaced nodes were ever resident (floor ` +
        `${MIN_ROAD_NODES}). The flight barely passed a road.`,
    );
  }
  if (max(roadDraws) < MIN_ROAD_DRAW_CALLS) {
    failures.push(
      `surfaced terrain was drawn at most ${max(roadDraws)} times in a frame ` +
        `(floor ${MIN_ROAD_DRAW_CALLS}). Roads existing and roads REACHING the ` +
        'rasteriser are different claims.',
    );
  }
  if (shallowSamples.length >= 3 && max(shallowRoadDraws) < MIN_SHALLOW_ROAD_DRAW_CALLS) {
    failures.push(
      `the shallow-pitch leg drew surfaced terrain at most ${max(shallowRoadDraws)} ` +
        `times in a frame (floor ${MIN_SHALLOW_ROAD_DRAW_CALLS}).`,
    );
  }
  if (roadChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks carried a road, so the ' +
        'byte-identical-regeneration check said nothing about roads. Move the ' +
        'flight start, deliberately, rather than dropping this check.',
    );
  }
  // ---- streets, and the vacuity guards around them ----------------------
  if (max(streetVerts) === 0) {
    failures.push(
      'no street surfacing was generated at any point in the flight. Either ' +
        'the Sector tier is broken or the flight never reached a settlement -- ' +
        'in which case every street check in this run passed vacuously.',
    );
  }
  if (max(streetNodes) < MIN_STREET_NODES) {
    failures.push(
      `only ${max(streetNodes)} street-bearing nodes were ever resident (floor ` +
        `${MIN_STREET_NODES}). The flight barely reached a village.`,
    );
  }
  if (max(streetDraws) < MIN_STREET_DRAW_CALLS) {
    failures.push(
      `street-surfaced terrain was drawn at most ${max(streetDraws)} times in a ` +
        `frame (floor ${MIN_STREET_DRAW_CALLS}). Streets existing and streets ` +
        'REACHING the rasteriser are different claims.',
    );
  }
  if (shallowSamples.length >= 3 && max(shallowStreetDraws) < MIN_SHALLOW_STREET_DRAW_CALLS) {
    failures.push(
      `the shallow-pitch leg drew street-surfaced terrain at most ` +
        `${max(shallowStreetDraws)} times in a frame (floor ` +
        `${MIN_SHALLOW_STREET_DRAW_CALLS}).`,
    );
  }
  if (streetChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks carried a street, so the ' +
        'byte-identical-regeneration check said nothing about the Sector tier. ' +
        'Move the flight start, deliberately, rather than dropping this check.',
    );
  }

  // ---- decks and bridges, and the vacuity guards around them ------------
  if (max(deckTris) === 0) {
    failures.push(
      'no deck geometry was generated at any point in the flight. Either the ' +
        'carriageway builder is broken or the flight never passed a road -- in ' +
        'which case every deck check in this run passed vacuously.',
    );
  }
  if (max(deckNodes) < MIN_DECK_NODES) {
    failures.push(
      `only ${max(deckNodes)} deck-bearing nodes were ever resident (floor ` +
        `${MIN_DECK_NODES}). The flight barely passed a road.`,
    );
  }
  if (max(deckDraws) < MIN_DECK_DRAW_CALLS) {
    failures.push(
      `decks were drawn at most ${max(deckDraws)} times in a frame (floor ` +
        `${MIN_DECK_DRAW_CALLS}). A deck existing and a deck RENDERING are ` +
        'different claims; this run only made the first one.',
    );
  }
  if (shallowSamples.length >= 3 && max(shallowDeckDraws) < MIN_SHALLOW_DECK_DRAW_CALLS) {
    failures.push(
      `the shallow-pitch leg drew decks at most ${max(shallowDeckDraws)} times ` +
        `(floor ${MIN_SHALLOW_DECK_DRAW_CALLS}). The draw-call budget is decided ` +
        'on that leg, and a deck is the first thing since Phase 3a to cost one, ' +
        'so it was measured without the thing this phase added.',
    );
  }
  if (finalSnapshot.bridgeNodes < MIN_BRIDGE_NODES) {
    failures.push(
      `only ${finalSnapshot.bridgeNodes} nodes carrying bridge geometry were ` +
        `generated in the whole flight (floor ${MIN_BRIDGE_NODES}). A road ` +
        'crossing a river was a ford before this phase and the deck is what ' +
        'spans it, so this is the ONLY number in the run that says a bridge was ' +
        'built. Either the max(target, ground) rule regressed or the flight ' +
        'crossed no channel with a road over it.',
    );
  }
  if (deckChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks carried a deck, so the ' +
        'byte-identical-regeneration check said nothing about the carriageway ' +
        'geometry the hash now covers. Move the flight start, deliberately, ' +
        'rather than dropping this check.',
    );
  }

  // ---- buildings, and the vacuity guards around them ---------------------
  if (max(buildingTris) === 0) {
    failures.push(
      'no building geometry was generated at any point in the flight. Either ' +
        'lot siting is broken or the flight never reached a settlement -- in ' +
        'which case every building check in this run passed vacuously.',
    );
  }
  if (max(buildingNodes) < MIN_BUILDING_NODES) {
    failures.push(
      `only ${max(buildingNodes)} building-bearing nodes were ever resident (floor ` +
        `${MIN_BUILDING_NODES}). The flight barely reached a village with houses.`,
    );
  }
  if (finalSnapshot.buildingsSeen < MIN_BUILDINGS_SEEN) {
    failures.push(
      `only ${finalSnapshot.buildingsSeen} buildings were generated in the whole ` +
        `flight (floor ${MIN_BUILDINGS_SEEN}). A village is a couple of hundred ` +
        'metres across in a 4 km region, so this is cumulative deliberately -- a ' +
        'number this low means lot acceptance is refusing nearly everything, not ' +
        'that the sampling missed it.',
    );
  }
  if (max(buildingDraws) < MIN_BUILDING_DRAW_CALLS) {
    failures.push(
      `buildings were drawn at most ${max(buildingDraws)} times in a frame (floor ` +
        `${MIN_BUILDING_DRAW_CALLS}). A building existing and a building RENDERING ` +
        'are different claims; this run only made the first one.',
    );
  }
  if (measuredBuildings === 0) {
    failures.push(
      'no building had its levelness measured: every village node resident at a ' +
        'sample was coarser than lod 0. The one number that says houses stand on ' +
        'ground a village levelled has no denominator.',
    );
  } else if (levelFraction < MIN_BUILDINGS_LEVEL_FRACTION) {
    failures.push(
      `only ${(levelFraction * 100).toFixed(0)}% of lod-0 buildings stood within ` +
        `tolerance of their own floor (floor ${(MIN_BUILDINGS_LEVEL_FRACTION * 100).toFixed(0)}%). ` +
        'THE ANTI-VACUITY NUMBER OF PHASE 6: the buildings would still be placed, ' +
        'still be drawn and still round-trip identically while half-buried in a ' +
        'hillside. Look at the grading, gradeTarget, or the lot acceptance tests.',
    );
  }
  if (buildingChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks contained a building, so the ' +
        'byte-identical-regeneration check said nothing about the building ' +
        'geometry the hash now covers. Move the flight start, deliberately, ' +
        'rather than dropping this check.',
    );
  }
  if (finalSnapshot.citiesSeen < MIN_CITIES_SEEN) {
    failures.push(
      `the flight generated ${finalSnapshot.citiesSeen} city-touching nodes (floor ` +
        `${MIN_CITIES_SEEN}); all city checks would otherwise be vacuous.`,
    );
  }
  if (finalSnapshot.wallsSeen < MIN_WALL_NODES) {
    failures.push(
      `only ${finalSnapshot.wallsSeen} wall primitives were generated (floor ` +
        `${MIN_WALL_NODES}); the flight did not exercise city walls.`,
    );
  }
  if (finalSnapshot.interiorsEntered < MIN_INTERIORS_ENTERED) {
    failures.push(
      `the walk flight entered ${finalSnapshot.interiorsEntered} interiors (floor ` +
        `${MIN_INTERIORS_ENTERED}); the landmark overlay was not exercised.`,
    );
  }

  // ---- props, and the vacuity guards around them -------------------------
  if (max(propTris) === 0) {
    failures.push(
      'no prop geometry was generated at any point in the flight. Either ' +
        'vegetation placement is broken or the flight never reached growable ' +
        'ground -- in which case every prop check in this run passed vacuously.',
    );
  }
  if (max(propNodes) < MIN_PROP_NODES) {
    failures.push(
      `only ${max(propNodes)} prop-bearing nodes were ever resident (floor ` +
        `${MIN_PROP_NODES}). The flight barely reached a forest.`,
    );
  }
  if (finalSnapshot.propsSeen < MIN_PROPS_SEEN) {
    failures.push(
      `only ${finalSnapshot.propsSeen} props were generated in the whole ` +
        `flight (floor ${MIN_PROPS_SEEN}). Vegetation is continuous across the ` +
        'map, so a number this low means the accept gate is refusing nearly ' +
        'everything, not that the sampling missed it.',
    );
  }
  if (max(propDraws) < MIN_PROP_DRAW_CALLS) {
    failures.push(
      `props were drawn at most ${max(propDraws)} times in a frame (floor ` +
        `${MIN_PROP_DRAW_CALLS}). A prop existing and a prop RENDERING are ` +
        'different claims; this run only made the first one.',
    );
  }
  if (measuredProps === 0) {
    failures.push(
      'no prop had its seating measured: every prop-bearing node resident at a ' +
        'sample was coarser than lod 0. The one number that says vegetation sits ' +
        'on ground the world made has no denominator.',
    );
  } else if (seatedFraction < MIN_PROPS_SEATED_FRACTION) {
    failures.push(
      `only ${(seatedFraction * 100).toFixed(0)}% of lod-0 props sat within ` +
        `tolerance of their own base (floor ${(MIN_PROPS_SEATED_FRACTION * 100).toFixed(0)}%). ` +
        'THE ANTI-VACUITY NUMBER OF PHASE 7a: props would still be placed, still ' +
        'be drawn and still round-trip identically while floating over grass. ' +
        'Look at the stump / groundAt path.',
    );
  }
  if (propChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks contained a prop, so the ' +
        'byte-identical-regeneration check said nothing about the prop ' +
        'geometry the hash now covers. Move the flight start, deliberately, ' +
        'rather than dropping this check.',
    );
  }

  // ---- village layouts (Phase 7b) ----------------------------------------
  const kindSeen = [
    ['cottage', finalSnapshot.buildingsSeenCottage],
    ['barn', finalSnapshot.buildingsSeenBarn],
    ['hall', finalSnapshot.buildingsSeenHall],
  ];
  for (const [name, count] of kindSeen) {
    if (count < MIN_KIND_SEEN) {
      failures.push(
        `building kind '${name}' was seen only ${count} time(s) ` +
          `(floor ${MIN_KIND_SEEN}). A cottage-only world would pass every building ` +
          'budget while proving nothing about kinds.',
      );
    }
  }

  const propSpeciesSeen = [
    ['pine', finalSnapshot.propsSeenPine],
    ['broadleaf', finalSnapshot.propsSeenBroadleaf],
    ['bush-round', finalSnapshot.propsSeenBushRound],
    ['bush-tall', finalSnapshot.propsSeenBushTall],
    ['yard', finalSnapshot.propsSeenYard],
  ];
  for (const [name, count] of propSpeciesSeen) {
    if (count < MIN_PROP_SPECIES_SEEN) {
      failures.push(
        `prop species '${name}' was seen only ${count} time(s) ` +
          `(floor ${MIN_PROP_SPECIES_SEEN}). A pine-only world would pass every prop ` +
          'budget while proving nothing about species variety.',
      );
    }
  }

  const layoutSeen = [
    ['ring', finalSnapshot.layoutSeenRing],
    ['linear', finalSnapshot.layoutSeenLinear],
    ['grid', finalSnapshot.layoutSeenGrid],
    ['hilltop', finalSnapshot.layoutSeenHilltop],
  ];
  for (const [name, count] of layoutSeen) {
    if (count < MIN_LAYOUT_SEEN) {
      failures.push(
        `village layout '${name}' was seen on only ${count} generated chunk(s) ` +
          `(floor ${MIN_LAYOUT_SEEN}). A ring-only world would pass every street ` +
          'and building check while proving nothing about layout variety — look ' +
          'at layoutFamily / generateSectorStreets, or move the flight corridor.',
      );
    }
  }

  if (riverChunksAtStart === 0) {
    failures.push(
      'none of the round-tripped chunks was carved by a river, so the ' +
        'byte-identical-regeneration check said nothing about rivers. Move the ' +
        'flight start (START_X / START_Z) onto a channel.',
    );
  }

  if (!returned) failures.push('the world never settled after the return leg');
  if (loadedBefore === 0) failures.push("no chunks were resident where the flight started");
  if (JSON.stringify(geometryBefore) !== JSON.stringify(geometryAfter)) {
    failures.push(
      'chunk geometry differs before and after the round trip: ' +
        'generation is not byte-identical across unload and reload (RULE 2)',
    );
  }

  for (const error of consoleErrors) failures.push(`console error: ${error}`);
  for (const request of failedRequests) failures.push(`failed request: ${request}`);

  // Reported, not fatal: SwiftShader in a container cannot hold 16ms, so
  // failing on it would make this command permanently red and therefore
  // ignored. The number is printed above; read it on real hardware.
  if (finalSnapshot.peakFrameMs > 100) {
    warnings.push(
      `worst frame ${finalSnapshot.peakFrameMs.toFixed(1)} ms, above the 16 ms budget. ` +
        'Expected under software rendering; check on a real GPU before trusting it.',
    );
  }
} catch (error) {
  failures.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
} finally {
  await browser.close();
  await server.close();
}

console.log('');
for (const warning of warnings) console.warn(`WARN  ${warning}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
if (failures.length > 0) exitCode = 1;

console.log('');
if (exitCode !== 0) {
  console.log('soak FAILED');
} else if (heapTrendJudged) {
  console.log('soak OK');
} else {
  console.log('soak OK -- but the heap trend was NOT judged; this run cannot detect a leak');
}
console.log('');
process.exit(exitCode);
