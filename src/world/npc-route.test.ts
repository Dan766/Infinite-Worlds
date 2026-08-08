/**
 * Tests for the NPC street graph: pure arithmetic, no world involved, in the
 * spirit of `streets.test.ts`'s `ringDirection` tests -- `buildStreetGraph`,
 * `shortestPath` and `appendGraphNodes` each have one right answer on a
 * synthetic street plan with a known shape.
 */

import { describe, expect, it } from 'vitest';
import type { RoadTerrain, Settlement } from './roads';
import type { SectorStreets } from './streets';
import { appendGraphNodes, buildStreetGraph, nearestGraphNode, shortestPath } from './npc-route';

const TERRAIN: RoadTerrain = { id: 'npc-route-test', seaLevel: 0, height: () => 0 };

const SITE: Settlement = {
  cellX: 0,
  cellZ: 0,
  x: 5,
  z: 5,
  y: 0,
  score: 1,
  radius: 20,
  class: 0,
  wallRadius: 0,
  farmRadius: 0,
};

/**
 * A closed 4-node square ring (one street) plus one spoke from the centre to
 * the ring's first node (a second street) -- exactly the shape `layoutRing`
 * produces, small enough to reason about by hand. Ring: (0,0)-(10,0)-(10,10)-
 * (0,10)-(0,0). Spoke: (5,5)-(0,0).
 */
function ringAndSpoke(): SectorStreets {
  const nodeX = Float64Array.from([0, 10, 10, 0, 0, /* spoke */ 5, 0]);
  const nodeZ = Float64Array.from([0, 0, 10, 10, 0, /* spoke */ 5, 0]);
  const nodeY = new Float64Array(nodeX.length);
  const streetStart = Int32Array.from([0, 5, 7]);
  return {
    terrain: TERRAIN,
    worldSeed: 1,
    sectorX: 0,
    sectorZ: 0,
    settlement: SITE,
    nodeX,
    nodeZ,
    nodeY,
    streetStart,
    streetCount: 2,
    segCount: 5,
    halfWidth: 2.6,
    reachRadius: 20,
    layout: 0,
  };
}

describe('buildStreetGraph', () => {
  it('dedupes the ring closure and the spoke-shared endpoint into single nodes', () => {
    const graph = buildStreetGraph(ringAndSpoke());
    // 4 distinct ring corners + 1 centre = 5 nodes, not the 7 raw points.
    expect(graph.count).toBe(5);
  });

  it('is a pure function of the record', () => {
    const streets = ringAndSpoke();
    const a = buildStreetGraph(streets);
    const b = buildStreetGraph(streets);
    expect(Array.from(a.nodeX)).toEqual(Array.from(b.nodeX));
    expect(Array.from(a.adjTo)).toEqual(Array.from(b.adjTo));
  });

  it('finds the graph node nearest the settlement centre', () => {
    const graph = buildStreetGraph(ringAndSpoke());
    expect(graph.centerNode).toBeGreaterThanOrEqual(0);
    expect(graph.nodeX[graph.centerNode]).toBeCloseTo(5, 5);
    expect(graph.nodeZ[graph.centerNode]).toBeCloseTo(5, 5);
  });

  it('returns the shared empty graph for a sector with no streets', () => {
    const empty: SectorStreets = {
      ...ringAndSpoke(),
      settlement: undefined,
      nodeX: new Float64Array(0),
      nodeZ: new Float64Array(0),
      nodeY: new Float64Array(0),
      streetStart: new Int32Array(1),
      streetCount: 0,
      segCount: 0,
      reachRadius: 0,
      layout: -1,
    };
    const graph = buildStreetGraph(empty);
    expect(graph.count).toBe(0);
  });
});

describe('nearestGraphNode', () => {
  it('picks the closest node and ties break toward the lowest index', () => {
    const graph = buildStreetGraph(ringAndSpoke());
    // (0.4, 0.4) is closest to the (0, 0) ring corner.
    const n = nearestGraphNode(graph, 0.4, 0.4);
    expect(graph.nodeX[n]).toBeCloseTo(0, 5);
    expect(graph.nodeZ[n]).toBeCloseTo(0, 5);
  });

  it('returns -1 on an empty graph', () => {
    expect(nearestGraphNode({ ...buildStreetGraph(ringAndSpoke()), count: 0 }, 0, 0)).toBe(-1);
  });
});

describe('shortestPath', () => {
  const graph = buildStreetGraph(ringAndSpoke());
  const centre = graph.centerNode;
  const cornerNear00 = nearestGraphNode(graph, 0, 0);
  const cornerNear1010 = nearestGraphNode(graph, 10, 10);

  it('returns a single-node path when the endpoints coincide', () => {
    const p = shortestPath(graph, centre, centre);
    expect(Array.from(p)).toEqual([centre]);
  });

  it('routes through the spoke rather than off the graph', () => {
    const p = shortestPath(graph, centre, cornerNear1010);
    expect(p[0]).toBe(centre);
    expect(p[p.length - 1]).toBe(cornerNear1010);
    // Must pass through the (0,0) corner -- the only door off the spoke.
    expect(Array.from(p)).toContain(cornerNear00);
  });

  it('is a pure function of (graph, from, to)', () => {
    const a = shortestPath(graph, centre, cornerNear1010);
    const b = shortestPath(graph, centre, cornerNear1010);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('stands still (returns [from]) when the target is unreachable', () => {
    const isolated = appendGraphNodes(graph, [500, 520], [500, 500], []); // two new, disconnected nodes
    const p = shortestPath(isolated, centre, isolated.count - 1);
    expect(Array.from(p)).toEqual([centre]);
  });
});

describe('appendGraphNodes', () => {
  it('leaves existing node indices and their paths unchanged', () => {
    const base = buildStreetGraph(ringAndSpoke());
    const beforePath = shortestPath(base, base.centerNode, nearestGraphNode(base, 10, 10));

    const augmented = appendGraphNodes(base, [100, 112], [100, 100], [[0, 1]]);
    expect(augmented.count).toBe(base.count + 2);
    const afterPath = shortestPath(
      augmented,
      augmented.centerNode,
      nearestGraphNode(base, 10, 10) /* same index space for pre-existing nodes */,
    );
    expect(Array.from(afterPath)).toEqual(Array.from(beforePath));
  });

  it('connects the appended pair with a real, traversable edge', () => {
    const base = buildStreetGraph(ringAndSpoke());
    const augmented = appendGraphNodes(base, [100, 112], [100, 100], [[0, 1]]);
    const from = base.count;
    const to = base.count + 1;
    const p = shortestPath(augmented, from, to);
    expect(Array.from(p)).toEqual([from, to]);
  });

  it('is a no-op on an empty extra list', () => {
    const base = buildStreetGraph(ringAndSpoke());
    expect(appendGraphNodes(base, [], [], [])).toBe(base);
  });
});
