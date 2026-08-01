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
 * GPU-INDEPENDENT BUDGETS, added in Phase 2a.
 *
 * fps and frame time cannot be judged in a container with no GPU -- see the
 * note at the bottom of this file. Geometry volume can: triangle count, vertex
 * count, draw calls and payload bytes are the same number on a workstation, in
 * CI, and on a phone. Phase 2a multiplied triangles by about a thousand, so
 * these become hard failures now rather than after Phase 2b's quadtree has
 * quietly doubled them.
 *
 * The thresholds are the measured Phase 2a peaks with headroom, not aspirations:
 * a uniform disc of 32x32-segment chunks at load radius 8 / unload radius 10.
 * Phase 2b should REDUCE these, because that is what an LOD quadtree is for.
 */
const MAX_LIVE_TRIANGLES = 900_000;
const MAX_LIVE_VERTICES = 500_000;
const MAX_DRAW_CALLS = 1200;
/** Live plus cached payload bytes held by the streamer. */
const MAX_CHUNK_BYTES = 96 * 1024 * 1024;

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
  `&fly=${SPEED}&flyleg=${legSeconds}&pos=0,90,0&look=-90,-18`;

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
    timeout: 60000,
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
  // Anchored to the camera's real position rather than a hardcoded origin,
  // because the page takes a moment to become ready and the autopilot is
  // already moving by then.
  const originX = (await page.evaluate(() => window.__app.perfSnapshot())).cameraX;
  const geometryBefore = await page.evaluate(
    (x) => window.__app.sampleChunkGeometry(x, 0, 2),
    originX,
  );
  const loadedBefore = geometryBefore.filter((h) => h !== null).length;

  // Discard start-up hitches from the worst-frame figure: the first frames
  // compile shaders and build a hundred meshes, and that is not the leak.
  await page.evaluate(() => window.__app.resetFrameStats());

  const samples = [];
  const startedAt = Date.now();
  let nextSampleAt = startedAt;

  while (Date.now() - startedAt < SECONDS * 1000) {
    const wait = nextSampleAt - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 1000));
    if (Date.now() < nextSampleAt) continue;
    nextSampleAt += INTERVAL * 1000;

    const snapshot = await sample(page, cdp);
    snapshot.t = (Date.now() - startedAt) / 1000;
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
      `fps ${snapshot.fps.toFixed(1).padStart(5)}  ` +
      `x ${Math.round(snapshot.cameraX)}`;
    console.log(line);
  }

  // The flight ends where it started, but the chunks around the origin have to
  // stream back in before their geometry can be compared.
  const returned = await waitForSettled(page, 30000);
  const finalSnapshot = await sample(page, cdp);
  const geometryAfter = await page.evaluate(
    (x) => window.__app.sampleChunkGeometry(x, 0, 2),
    originX,
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
  console.log(`  trend            ${heapSlopeMbPerMin >= 0 ? '+' : ''}${heapSlopeMbPerMin.toFixed(2)} MB/min (limit ${MAX_HEAP_SLOPE_MB_PER_MIN})`);
  if (!trendJudgeable) {
    console.log(
      `  trend NOT judged  the chunk cache never saturated in ${SECONDS}s, so the ` +
        'figure above is the cache filling, not a leak. Use the default 300s.',
    );
  }

  console.log('');
  console.log('chunks');
  console.log(`  live min/mean/max ${min(lives)} / ${mean(lives).toFixed(1)} / ${max(lives)}`);
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
  if (max(samples.map((s) => s.cameraX)) < SPEED * SECONDS * 0.2) {
    failures.push('the camera barely moved; the autopilot did not run');
  }

  if (trendJudgeable && heapSlopeMbPerMin > MAX_HEAP_SLOPE_MB_PER_MIN) {
    failures.push(
      `heap grew ${heapSlopeMbPerMin.toFixed(2)} MB/min after warm-up, over the ` +
        `${MAX_HEAP_SLOPE_MB_PER_MIN} MB/min limit. That is a leak, not noise.`,
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
