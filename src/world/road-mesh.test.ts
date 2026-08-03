/**
 * Phase 5: the road and street deck.
 *
 * Three claims are worth more than the rest and each has a test named after it:
 *
 *  - a deck is fitted to the node's OWN rendered ground, so it neither sinks
 *    into a coarse hillside nor floats over a coarse valley;
 *  - two same-level neighbours agree EXACTLY on their shared boundary, so the
 *    clipping partitions a road rather than sharing or dropping a strip of it;
 *  - a road crossing a carved channel produces geometry standing clear of the
 *    ground -- a bridge -- and `bridgeVertices` measures that rather than
 *    repeating what `RoadNetwork.segCrossing` already said.
 *
 * As everywhere else in this project, the anti-vacuity half is explicit: a
 * suite that only ever asserts "no deck was wrong" passes perfectly on a world
 * with no decks in it.
 */

import { describe, expect, it } from 'vitest';
import { generateChunk, chunkTierContext, SEGMENTS, VERTS_PER_EDGE } from './chunk-gen';
import { CHUNK_SIZE, chunkSizeAt, type ChunkCoord, type ChunkData } from './contracts';
import { worldRegionField } from './height-field';
import { BRIDGE_CLEARANCE, clipSegmentToBox, DECK_APRON, DECK_LIFT } from './road-mesh';

const SEED = 0xc0ffee;
const context = (seed = SEED): ReturnType<typeof chunkTierContext> => chunkTierContext(seed);

/** Vertices per deck station: deck left and right, then apron left and right. */
const PER_STATION = 4;

/**
 * The ground a payload actually renders at a node-local point.
 *
 * Deliberately re-derived from `ChunkData.positions` rather than imported from
 * `chunk-gen.ts`: the claim under test is that the deck sits on the surface the
 * rasteriser draws, and reusing the generator's own sampler would only prove it
 * agrees with itself. The triangle split follows the index winding
 * `(a, c, b), (b, c, d)`, so the diagonal is the anti-diagonal.
 */
function renderedGround(data: ChunkData, localX: number, localZ: number): number {
  const size = chunkSizeAt(data.coord.lod);
  const step = size / SEGMENTS;
  const clamp = (v: number): number => (v < 0 ? 0 : v > SEGMENTS ? SEGMENTS : v);
  const cf = clamp(localX / step);
  const rf = clamp(localZ / step);
  const c0 = Math.min(SEGMENTS - 1, Math.floor(cf));
  const r0 = Math.min(SEGMENTS - 1, Math.floor(rf));
  const fx = cf - c0;
  const fz = rf - r0;
  const y = (col: number, row: number): number =>
    data.positions[(row * VERTS_PER_EDGE + col) * 3 + 1] as number;
  const h00 = y(c0, r0);
  const h10 = y(c0 + 1, r0);
  const h01 = y(c0, r0 + 1);
  const h11 = y(c0 + 1, r0 + 1);
  if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
  return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

/**
 * lod-0 chunks a road actually passes through, asked of the network rather than
 * guessed. The same approach `chunk-gen.test.ts` uses, and for the same reason:
 * a region carries about twenty roads in 16 km^2, so blind sampling finds
 * nothing and the test fails for a reason unrelated to the code.
 */
function chunksOnRoads(count: number): ChunkCoord[] {
  const net = worldRegionField(SEED).roads.networkAt(1000, 1000);
  const out: ChunkCoord[] = [];
  const seen = new Set<string>();
  for (let n = 0; n < net.nodeX.length && out.length < count; n++) {
    const x = Math.floor((net.nodeX[n] as number) / CHUNK_SIZE);
    const z = Math.floor((net.nodeZ[n] as number) / CHUNK_SIZE);
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, z, lod: 0 });
  }
  return out;
}

/** The lod-0 chunks holding the midpoint of every river crossing in one region. */
function chunksOnCrossings(): ChunkCoord[] {
  const net = worldRegionField(SEED).roads.networkAt(1000, 1000);
  const out: ChunkCoord[] = [];
  const seen = new Set<string>();
  for (let s = 0; s < net.segCrossing.length; s++) {
    if (net.segCrossing[s] !== 1) continue;
    const a = net.segNode[s * 2] as number;
    const b = net.segNode[s * 2 + 1] as number;
    const midX = ((net.nodeX[a] as number) + (net.nodeX[b] as number)) / 2;
    const midZ = ((net.nodeZ[a] as number) + (net.nodeZ[b] as number)) / 2;
    const x = Math.floor(midX / CHUNK_SIZE);
    const z = Math.floor(midZ / CHUNK_SIZE);
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, z, lod: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

describe('clipSegmentToBox', () => {
  const out = new Float64Array(2);

  it('returns the whole segment when it lies inside', () => {
    expect(clipSegmentToBox(10, 10, 50, 40, 0, 0, 64, 64, out)).toBe(true);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
  });

  it('rejects a segment that misses the box', () => {
    expect(clipSegmentToBox(100, 10, 200, 40, 0, 0, 64, 64, out)).toBe(false);
  });

  it('gives a boundary-parallel segment to exactly ONE of two neighbours', () => {
    // A segment running exactly along a shared edge is parallel to it, so no
    // interval clips it away and both neighbours would otherwise emit the same
    // strip on top of each other. The box is half-open on its maximum edges.
    expect(clipSegmentToBox(10, 64, 50, 64, 0, 0, 64, 64, out)).toBe(false);
    expect(clipSegmentToBox(10, 64, 50, 64, 0, 64, 64, 128, out)).toBe(true);
    expect(clipSegmentToBox(64, 10, 64, 50, 0, 0, 64, 64, out)).toBe(false);
    expect(clipSegmentToBox(64, 10, 64, 50, 64, 0, 128, 64, out)).toBe(true);
  });

  it('splits a crossing segment at BIT-IDENTICAL points from either side', () => {
    // THE PROPERTY THE WHOLE SEAM ARGUMENT RESTS ON. Two neighbours solve the
    // same boundary with opposite signs -- `(maxX - ax) / dx` against
    // `(ax - minX) / -dx` -- and IEEE-754 makes those exactly equal, so both
    // put a station at the same world point. `toBeCloseTo` would not be a test
    // of this; `toBe` is.
    for (const [ax, az, bx, bz] of [
      [-17.25, 3.5, 91.5, 47.125],
      [1.5, -12.5, 120.25, 30.75],
      [-3.3, -7.7, 127.9, 61.1],
    ] as const) {
      expect(clipSegmentToBox(ax, az, bx, bz, 0, 0, 64, 64, out)).toBe(true);
      const leftEnd = out[1] as number;
      expect(clipSegmentToBox(ax, az, bx, bz, 64, 0, 128, 64, out)).toBe(true);
      const rightStart = out[0] as number;
      expect(rightStart).toBe(leftEnd);
      // ...and the world point they place there is the same double.
      expect(ax + (bx - ax) * leftEnd).toBe(ax + (bx - ax) * rightStart);
      expect(az + (bz - az) * leftEnd).toBe(az + (bz - az) * rightStart);
    }
  });
});

// ---------------------------------------------------------------------------
// The deck exists, and only where it should
// ---------------------------------------------------------------------------

describe('the deck submesh', () => {
  it('is built where a road runs and is EMPTY everywhere else', () => {
    // Anti-vacuity, both halves. A deck that never appeared and a deck on every
    // node in the world are equally broken, and the second one would sail
    // through every other test in this file.
    let withDeck = 0;
    let triangles = 0;
    for (const coord of chunksOnRoads(12)) {
      const data = generateChunk(coord, context());
      if (data.deckIndices.length > 0) {
        withDeck++;
        triangles += data.deckIndices.length / 3;
      }
    }
    expect(withDeck).toBeGreaterThan(3);
    expect(triangles).toBeGreaterThan(100);

    let bare = 0;
    for (let i = 0; i < 20; i++) {
      const data = generateChunk({ x: 900 + i * 13, z: -700 - i * 11, lod: 0 }, context());
      if (data.deckPositions.length === 0) {
        bare++;
        // An absent deck must cost NOTHING, not "almost nothing": that is what
        // keeps one extra draw call off every node in the world.
        expect(data.deckIndices).toHaveLength(0);
        expect(data.deckNormals).toHaveLength(0);
        expect(data.deckColors).toHaveLength(0);
        expect(data.bridgeVertices).toBe(0);
      }
    }
    expect(bare).toBeGreaterThan(10);
  });

  it('emits well-formed geometry: indices in range, one normal and colour each', () => {
    const coord = chunksOnRoads(12).find((c) => generateChunk(c, context()).deckIndices.length > 0);
    expect(coord).toBeDefined();
    const data = generateChunk(coord as ChunkCoord, context());
    const vertices = data.deckPositions.length / 3;
    expect(vertices).toBeGreaterThan(0);
    expect(vertices % PER_STATION).toBe(0);
    expect(data.deckNormals.length).toBe(data.deckPositions.length);
    expect(data.deckColors.length).toBe(data.deckPositions.length);
    expect(data.deckIndices.length % 3).toBe(0);
    for (const index of data.deckIndices) expect(index).toBeLessThan(vertices);
    for (let i = 0; i < data.deckNormals.length; i += 3) {
      const nx = data.deckNormals[i] as number;
      const ny = data.deckNormals[i + 1] as number;
      const nz = data.deckNormals[i + 2] as number;
      expect(Math.sqrt(nx * nx + ny * ny + nz * nz)).toBeCloseTo(1, 6);
    }
  });

  it('lays a HORIZONTAL cross-section with an apron under both edges', () => {
    // A roadbed is a bench, not a ramp across its own width. The two deck
    // vertices of a station therefore share an altitude exactly, and the two
    // apron vertices below them are what covers the cut on one side and the
    // embankment on the other.
    const coord = chunksOnRoads(12).find((c) => generateChunk(c, context()).deckIndices.length > 0);
    const data = generateChunk(coord as ChunkCoord, context());
    for (let v = 0; v < data.deckPositions.length / 3; v += PER_STATION) {
      const deckLeft = data.deckPositions[v * 3 + 1] as number;
      const deckRight = data.deckPositions[(v + 1) * 3 + 1] as number;
      const apronLeft = data.deckPositions[(v + 2) * 3 + 1] as number;
      const apronRight = data.deckPositions[(v + 3) * 3 + 1] as number;
      expect(deckRight).toBe(deckLeft);
      expect(apronLeft).toBeLessThanOrEqual(deckLeft - DECK_APRON);
      expect(apronRight).toBeLessThanOrEqual(deckLeft - DECK_APRON);
    }
  });

  it('regenerates byte-identically after unrelated work (RULE 2)', () => {
    const coord = chunksOnRoads(12).find((c) => generateChunk(c, context()).deckIndices.length > 0);
    const first = generateChunk(coord as ChunkCoord, context());
    // Enough unrelated work on other seeds and regions to evict every memo the
    // deck reads: the region roads, the sector streets, and the rivers under
    // both.
    for (let i = 0; i < 12; i++) generateChunk({ x: i * 9, z: i * 6, lod: 0 }, context(SEED + i));
    const again = generateChunk(coord as ChunkCoord, context());
    expect(Array.from(again.deckPositions)).toEqual(Array.from(first.deckPositions));
    expect(Array.from(again.deckNormals)).toEqual(Array.from(first.deckNormals));
    expect(Array.from(again.deckColors)).toEqual(Array.from(first.deckColors));
    expect(Array.from(again.deckIndices)).toEqual(Array.from(first.deckIndices));
    expect(again.bridgeVertices).toBe(first.bridgeVertices);
  });
});

// ---------------------------------------------------------------------------
// The deck is fitted to THIS node's ground
// ---------------------------------------------------------------------------

describe('the deck sits on the ground the node renders', () => {
  it('never sinks below the rendered surface, at lod 0 or at lod 3', () => {
    // THE `max(profile, ground)` RULE, stated as the property that matters. If
    // the deck were built from the road profile alone this would fail at lod 3
    // and pass at lod 0, which is precisely the bug per-chunk geometry exists to
    // avoid: a coarse node interpolates its own ground across 16 m and a
    // lod-independent deck disappears into it.
    for (const lod of [0, 3]) {
      let checked = 0;
      for (const fine of chunksOnRoads(12)) {
        const coord: ChunkCoord = {
          x: Math.floor(fine.x / 2 ** lod),
          z: Math.floor(fine.z / 2 ** lod),
          lod,
        };
        const data = generateChunk(coord, context());
        if (data.deckIndices.length === 0) continue;
        const size = chunkSizeAt(lod);
        for (let v = 0; v < data.deckPositions.length / 3; v += PER_STATION) {
          // The CENTRELINE, which is what the deck is fitted to. A cross-section
          // is horizontal, so on a hillside the uphill edge is deliberately
          // below the ground -- that is the cut, and the apron is the fill on
          // the other side. Testing an edge vertex would be testing the bench.
          const x =
            ((data.deckPositions[v * 3] as number) +
              (data.deckPositions[(v + 1) * 3] as number)) /
            2;
          const z =
            ((data.deckPositions[v * 3 + 2] as number) +
              (data.deckPositions[(v + 1) * 3 + 2] as number)) /
            2;
          const y = data.deckPositions[v * 3 + 1] as number;
          // Only the part of the deck actually over this node: up to
          // `ROAD_HALF_WIDTH_MAX` of it overhangs, where the node has no ground
          // of its own and the sampler clamps to the nearest edge.
          if (x < 0 || z < 0 || x > size || z > size) continue;
          expect(y).toBeGreaterThan(renderedGround(data, x, z) - 1e-3);
          checked++;
        }
        if (checked > 200) break;
      }
      expect(checked).toBeGreaterThan(50);
    }
  });

  it('follows the ground rather than hovering at a constant height', () => {
    // The other half of the claim above, and the one a constant lift would
    // pass. A deck fitted to the ground varies in altitude across a chunk by
    // roughly what the ground does; a deck at `profile + k` would not, and a
    // deck at `groundAtOnePoint + k` would be flat.
    let varied = 0;
    for (const coord of chunksOnRoads(12)) {
      const data = generateChunk(coord, context());
      if (data.deckIndices.length === 0) continue;
      let lowest = Infinity;
      let highest = -Infinity;
      let flushWithGround = 0;
      let stations = 0;
      for (let v = 0; v < data.deckPositions.length / 3; v += PER_STATION) {
        const at = v * 3;
        const x = ((data.deckPositions[at] as number) + (data.deckPositions[at + 3] as number)) / 2;
        const z =
          ((data.deckPositions[at + 2] as number) + (data.deckPositions[at + 5] as number)) / 2;
        const y = data.deckPositions[at + 1] as number;
        if (x < 0 || z < 0 || x > CHUNK_SIZE || z > CHUNK_SIZE) continue;
        if (y < lowest) lowest = y;
        if (y > highest) highest = y;
        // Flush means "resting on the ground": exactly the lift above it, which
        // is what the `max` rule produces wherever the grading did its job.
        if (Math.abs(y - renderedGround(data, x, z) - DECK_LIFT) < 0.05) flushWithGround++;
        stations++;
      }
      if (stations >= 8 && highest - lowest > 0.5) varied++;
      if (stations >= 8) expect(flushWithGround).toBeGreaterThan(0);
    }
    expect(varied).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Two neighbours at the same level
// ---------------------------------------------------------------------------

describe('same-level neighbours', () => {
  it('place the boundary station at the same altitude, to the bit', () => {
    // A road is PARTITIONED between two nodes, not shared and not dropped: both
    // clip the crossing segment at the same parameter (see `clipSegmentToBox`)
    // and both sample the same world positions along the shared edge, so the
    // station they meet at gets the same altitude from both. Compared with
    // `toBe` rather than a tolerance, because none of that arithmetic is
    // approximate.
    //
    // Only Y is compared. X and Z necessarily differ in their last bits, and
    // that is storage rather than disagreement: the position buffer is
    // node-LOCAL float32, so the two nodes round the same world point against
    // two different origins.
    let matched = 0;
    for (const coord of chunksOnRoads(16)) {
      const left = generateChunk(coord, context());
      const right = generateChunk({ x: coord.x + 1, z: coord.z, lod: 0 }, context());
      if (left.deckIndices.length === 0 || right.deckIndices.length === 0) continue;

      /** Stations whose centreline sits on the shared edge, keyed by local Z. */
      const atBoundary = (data: ChunkData, edgeX: number): Map<number, number> => {
        const found = new Map<number, number>();
        for (let v = 0; v < data.deckPositions.length / 3; v += PER_STATION) {
          const at = v * 3;
          const cx =
            ((data.deckPositions[at] as number) + (data.deckPositions[at + 3] as number)) / 2;
          if (Math.abs(cx - edgeX) > 0.01) continue;
          const cz =
            ((data.deckPositions[at + 2] as number) + (data.deckPositions[at + 5] as number)) / 2;
          found.set(Math.round(cz * 64), data.deckPositions[at + 1] as number);
        }
        return found;
      };
      const fromLeft = atBoundary(left, CHUNK_SIZE);
      const fromRight = atBoundary(right, 0);
      for (const [key, y] of fromLeft) {
        const other = fromRight.get(key);
        if (other === undefined) continue;
        expect(other).toBe(y);
        matched++;
      }
    }
    // ...and the whole check is worthless if no road ever crossed a boundary.
    expect(matched).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

describe('bridges', () => {
  it('span a carved channel, and are counted from the geometry', () => {
    // Phase 4a left a road crossing a river as a FORD: `grading.ts` yields
    // inside a channel, so the roadbed ran to the bank and resumed on the far
    // side. The deck's `max(profile, ground)` rule spans it, and this is the
    // check that the span actually happened -- `segCrossing` said a crossing
    // was there, which is a different claim entirely.
    const crossings = chunksOnCrossings();
    expect(crossings.length).toBeGreaterThan(0);

    let bridged = 0;
    let stations = 0;
    let highest = 0;
    for (const coord of crossings) {
      const data = generateChunk(coord, context());
      if (data.bridgeVertices === 0) continue;
      bridged++;
      stations += data.bridgeVertices;
      for (let v = 0; v < data.deckPositions.length / 3; v += PER_STATION) {
        const at = v * 3;
        const x = data.deckPositions[at] as number;
        const z = data.deckPositions[at + 2] as number;
        if (x < 0 || z < 0 || x > CHUNK_SIZE || z > CHUNK_SIZE) continue;
        const clearance = (data.deckPositions[at + 1] as number) - renderedGround(data, x, z);
        if (clearance > highest) highest = clearance;
      }
    }
    expect(bridged).toBeGreaterThan(0);
    expect(stations).toBeGreaterThan(0);
    // A bridge worth the name stands clear of the channel floor, not of the
    // float noise in a bilinear sample.
    expect(highest).toBeGreaterThan(BRIDGE_CLEARANCE);
  });

  it('are rare: an ordinary stretch of road counts none', () => {
    // The other half. A `bridgeVertices` that fired everywhere would keep the
    // soak's bridge floor green while saying nothing about river crossings, and
    // would mean the deck was floating above the ground along its whole length.
    let counted = 0;
    let total = 0;
    for (const coord of chunksOnRoads(12)) {
      const data = generateChunk(coord, context());
      if (data.deckIndices.length === 0) continue;
      total++;
      if (data.bridgeVertices > 0) counted++;
    }
    expect(total).toBeGreaterThan(3);
    expect(counted).toBeLessThan(total);
  });

  it('are counted at lod 0 only, because a coarse lattice cannot resolve a bed', () => {
    // A deck stands at the blended target; the GROUND only reaches that target
    // where the vertex lattice has samples inside a 3-6 m roadbed. At lod 3 the
    // spacing is 16 m and it usually does not, so the deck legitimately stands
    // clear of ground the mesh cannot describe -- which is the deck doing its
    // job, not a bridge. Counting it turned the one number that says "a road
    // crossed a river" into a statement about mesh resolution.
    for (const fine of chunksOnRoads(12)) {
      const coarse: ChunkCoord = { x: Math.floor(fine.x / 8), z: Math.floor(fine.z / 8), lod: 3 };
      const data = generateChunk(coarse, context());
      expect(data.bridgeVertices).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Streets get the same treatment
// ---------------------------------------------------------------------------

describe('village streets', () => {
  it('are decked too, in their own colour', () => {
    // The open decision Phase 4b handed over: `SectorStreets.streetStart` is CSR
    // precisely so a street can be walked as a polyline and extruded, and this
    // is the answer -- one extruder, two sources, exactly as `GradeBlend` takes
    // both tiers. A village whose road had a carriageway and whose lanes did not
    // would read as a road passing an empty clearing.
    const settlement = worldRegionField(SEED)
      .roads.networkAt(1000, 1000)
      .settlements.slice()
      .sort((a, b) => b.radius - a.radius)[0];
    expect(settlement).toBeDefined();
    const cx = Math.floor((settlement as { x: number }).x / CHUNK_SIZE);
    const cz = Math.floor((settlement as { z: number }).z / CHUNK_SIZE);

    const colours = new Set<string>();
    let decked = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const data = generateChunk({ x: cx + dx, z: cz + dz, lod: 0 }, context());
        if (data.deckIndices.length === 0) continue;
        decked++;
        for (let i = 0; i < data.deckColors.length; i += 3) {
          colours.add(
            `${data.deckColors[i]},${data.deckColors[i + 1]},${data.deckColors[i + 2]}`,
          );
        }
      }
    }
    expect(decked).toBeGreaterThan(2);
    // Two palette entries and only two: a road bed and a village lane. More
    // would mean something was tinting the deck per vertex, which is exactly
    // what the graded surfacing under it already does.
    expect(colours.size).toBe(2);
  });

  it('lie FLUSH on the village, which a deck built from a road profile does not', () => {
    // THE REASON THE DECK READS THE BLENDED TARGET. Inside a settlement the
    // ground is the weighted average of the pad and whatever roads and streets
    // run through it, which is not any one of their profiles. The first version
    // of this phase used a road's own profile and floated a metre or two over
    // every village approach; reading the same average the ground was graded to
    // makes flushness a property of the composition rather than of tuning.
    const settlement = worldRegionField(SEED)
      .roads.networkAt(1000, 1000)
      .settlements.slice()
      .sort((a, b) => b.radius - a.radius)[0];
    const cx = Math.floor((settlement as { x: number }).x / CHUNK_SIZE);
    const cz = Math.floor((settlement as { z: number }).z / CHUNK_SIZE);

    let stations = 0;
    let flush = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const data = generateChunk({ x: cx + dx, z: cz + dz, lod: 0 }, context());
        for (let v = 0; v < data.deckPositions.length / 3; v += PER_STATION) {
          const at = v * 3;
          const x =
            ((data.deckPositions[at] as number) + (data.deckPositions[at + 3] as number)) / 2;
          const z =
            ((data.deckPositions[at + 2] as number) + (data.deckPositions[at + 5] as number)) / 2;
          if (x < 0 || z < 0 || x > CHUNK_SIZE || z > CHUNK_SIZE) continue;
          const clearance =
            (data.deckPositions[at + 1] as number) - renderedGround(data, x, z) - DECK_LIFT;
          stations++;
          if (clearance < 0.25) flush++;
        }
      }
    }
    expect(stations).toBeGreaterThan(50);
    // A village has no river through it in this seed's case, so essentially
    // every station should be resting on the ground. The margin is for the
    // handful that sit where a lane's shoulder meets the pad's taper.
    expect(flush / stations).toBeGreaterThan(0.9);
  });
});
