/**
 * NPC crowds: simulated agents at the SECTOR tier.
 *
 * Phase 9a/9b. Every other moving thing in this project is a closed-form
 * function of `simTime` (`cube.ts`'s rotation, the autopilot's flight path):
 * evaluate it at any tick, in any order, and get the same answer, which is
 * what RULE 1 asks for. NPCs are deliberately NOT that. `birthCrowd` mints a
 * roster and a start pose from `(worldSeed, sector, birthTick)`; `stepCrowd`
 * then advances it ONE FIXED TICK AT A TIME, folding in avoidance, arrival and
 * collision, so a crowd's pose after `n` ticks depends on the whole sequence
 * of ticks it lived through, not on `n` alone. That is a real, named exception
 * to RULE 2 -- see `ARCHITECTURE.md` -- and it buys the thing a tick-pure
 * "ambient walker" cannot: an NPC that reroutes around another NPC, the
 * player, or a building that was not there when its path was planned.
 *
 * Two things keep this from taking the verification apparatus down with it:
 *
 *   - `stepCrowd` is called from the Loop's FIXED update only (see `app.ts`),
 *     never from `renderFrame`. Every canonical screenshot forces `freeze=1`,
 *     and a paused `Loop` runs zero fixed updates, so every canonical capture
 *     sees a crowd's tick-pure BIRTH state and nothing else.
 *   - This module adds nothing to `ChunkData`. A crowd lives in
 *     `npc-overlay.ts`'s own capped cache, keyed by sector, not in the chunk
 *     payload the soak's round-trip hash covers.
 *
 * ---------------------------------------------------------------------------
 * WHY AGENTS READ THE STREET GRAPH'S `nodeY`, NEVER `sampleHeight`
 *
 * A resident village might hold a few dozen agents, each stepped once per
 * fixed tick at 60 Hz. Calling `sampleHeight` per agent per tick would put
 * thousands of calls a second onto the single hottest function in the
 * codebase for a number the street plan has already computed: `nodeY` is the
 * altitude the street SURFACE holds at that node, the same value the deck
 * itself renders flush with. An agent standing at a graph node is standing on
 * ground `sampleHeight` already agrees with, by construction of `grading.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY UPDATE ORDER IS SEQUENTIAL BY AGENT INDEX
 *
 * Agent `i`'s avoidance reads every OTHER agent's position for the CURRENT
 * tick. Agents `0..i-1` have already been advanced this call, so `i` avoids
 * where they ARE NOW; agents `i+1..n-1` have not, so `i` avoids where they
 * WERE last tick. That asymmetry is deliberate and is the determinism rule,
 * not an artefact: it is cheap (no double buffer), and it is a PURE function
 * of `(state, tick, player position)` regardless of how it is described, so
 * replaying the same tick sequence from the same birth reproduces the same
 * crowd exactly. A later "optimisation" that parallelises this loop would
 * silently break that replay guarantee.
 */

import { hash3i } from '../core/hash';
import { hashUnit, lerp } from './noise';
import { SECTOR_SIZE } from './contracts';
import { isCity, type CityPlan } from './city';
import type { SectorLots } from './lots';
import type { SectorStreets } from './streets';
import {
  appendGraphNodes,
  buildStreetGraph,
  nearestGraphNode,
  shortestPath,
  type StreetGraph,
} from './npc-route';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Simulation step. Matches `Loop`'s default `fixedDt` -- see `core/loop.ts`. */
export const NPC_FIXED_DT = 1 / 60;

export const NPC_WALK_SPEED_MIN = 1.0;
export const NPC_WALK_SPEED_MAX = 1.6;
export const NPC_CHILD_SPEED_SCALE = 0.82;
export const NPC_GUARD_SPEED_SCALE = 0.85;

/** Collision radius, metres. A person is not a point. */
export const NPC_RADIUS = 0.35;

/** Distance to a waypoint, in metres, at which an agent counts as arrived. */
export const NPC_ARRIVE_EPS = 0.4;

/** Position change, in metres, above which a tick counts toward `npcsMoved`. */
export const NPC_MOVE_EPS = 1e-4;

/** Radius other agents are steered away from, and the cap on that steering. */
export const NPC_AVOID_RADIUS = 2.2;
export const NPC_AVOID_STRENGTH = 0.6;
export const NPC_PLAYER_AVOID_RADIUS = 1.6;

/** How long an agent stands at a goal before picking the next one, in ticks. */
export const NPC_LOITER_TICKS_MIN = 90;
export const NPC_LOITER_TICKS_MAX = 300;

export const NPC_MAX_VILLAGERS_PER_SECTOR = 24;
export const NPC_MAX_CITY_PER_SECTOR = 40;

/** Role mix. Children and merchants are drawn first; the remainder is villagers. */
export const NPC_CHILD_FRACTION = 0.16;
export const NPC_MERCHANT_FRACTION_CITY = 0.18;

export const ROLE_VILLAGER = 0;
export const ROLE_CHILD = 1;
export const ROLE_MERCHANT = 2;
export const ROLE_GUARD = 3;
export const ROLE_COUNT = 4;

/**
 * How far a gate guard's beat runs along the wall tangent from the gate
 * itself, metres. A guard cycles between the gate and this station rather
 * than walking the whole curtain -- a full wall-walk patrol needs its own
 * graph over the wall polyline, which is a separately-scoped piece of work
 * (see the Phase 9 entry in `PROGRESS.md`), not a 9b deliverable.
 */
const GUARD_STATION_DIST = 12;

/** Salts, one per independently-rolled quantity. See `lots.ts`'s header for why distinct salts matter. */
const ROLE_SALT = 0x4e_70_52_6c;
const SPEED_SALT = 0x4e_70_53_70;
const TINT_SALT = 0x4e_70_54_6e;
const LOITER_SALT = 0x4e_70_4c_74;

function unitAt(worldSeed: number, sectorX: number, sectorZ: number, index: number, salt: number): number {
  return hashUnit(hash3i(sectorX, sectorZ, index, (worldSeed ^ salt) >>> 0));
}

// ---------------------------------------------------------------------------
// Collision, injected
// ---------------------------------------------------------------------------

/**
 * The obstacles an agent may not walk into, as this module sees them.
 *
 * Injected rather than imported for the same reason `LotGround` is injected
 * into `lots.ts`: `npc-overlay.ts` already has a `SectorLots` (and, for a
 * city sector, a `CityPlan`) in hand, and `collision.ts`'s
 * `collidesWithLots` / `collidesWithCityWall` are already the one true
 * implementation of "is this point inside a building or a wall". A second
 * one here would be exactly the kind of duplication that drifts.
 */
export interface NpcCollision {
  blocked(x: number, z: number, radius: number): boolean;
}

export const NO_COLLISION: NpcCollision = { blocked: () => false };

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/**
 * One sector's living NPCs.
 *
 * Everything bulk is a typed array, like `SectorLots` and `SectorStreets`:
 * this lives in `npc-overlay.ts`'s own capped cache, one entry per resident
 * sector. `goalList` and `path` are arrays of small `Int32Array`s rather than
 * one flat CSR buffer -- unlike `SectorStreets`/`SectorLots` this is never
 * memoised by `(seed, sector)` alone (a crowd's state depends on its whole
 * tick history), so there is no cache-hit path for a flat layout to protect,
 * and a plain array keeps `stepCrowd` simple.
 */
export interface CrowdState {
  readonly worldSeed: number;
  readonly sectorX: number;
  readonly sectorZ: number;
  readonly graph: StreetGraph;
  readonly birthTick: number;
  readonly tick: number;
  readonly count: number;
  readonly posX: Float64Array;
  readonly posZ: Float64Array;
  /**
   * Unit facing direction, retained across ticks an agent does not move
   * (waiting, blocked, loitering) so `npc-overlay.ts` never has to guess
   * which way an idle agent is looking.
   */
  readonly headX: Float64Array;
  readonly headZ: Float64Array;
  readonly role: Uint8Array;
  readonly speed: Float64Array;
  /** Birth-fixed unit value in [0, 1) per agent, for clothing/culture tint. */
  readonly tint: Float64Array;
  /** Per-agent cyclic list of graph node goals. Length varies (2 for a guard, up to 3 otherwise). */
  readonly goalList: readonly Int32Array[];
  /** Index into `goalList[i]` of the goal currently being walked toward. */
  readonly goalCursor: Int32Array;
  /** Remaining waypoint node indices toward `goalList[i][goalCursor[i]]`. Empty means "pick the next goal". */
  readonly path: readonly Int32Array[];
  readonly waitTicks: Int32Array;
}

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);

function emptyCrowd(
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
  graph: StreetGraph,
  tick: number,
): CrowdState {
  return {
    worldSeed,
    sectorX,
    sectorZ,
    graph,
    birthTick: tick,
    tick,
    count: 0,
    posX: EMPTY_F64,
    posZ: EMPTY_F64,
    headX: EMPTY_F64,
    headZ: EMPTY_F64,
    role: EMPTY_U8,
    speed: EMPTY_F64,
    tint: EMPTY_F64,
    goalList: [],
    goalCursor: new Int32Array(0),
    path: [],
    waitTicks: new Int32Array(0),
  };
}

/** Drop consecutive duplicate goals (a degenerate settlement where two stops coincide). */
function dedupeGoals(goals: number[]): number[] {
  const out: number[] = [];
  for (const g of goals) {
    if (out.length === 0 || (out[out.length - 1] as number) !== g) out.push(g);
  }
  if (out.length > 1 && (out[0] as number) === (out[out.length - 1] as number)) out.pop();
  return out;
}

/** Unit tangent of the wall at one gate's wall-polyline index, from its two neighbours. */
function gateTangent(plan: CityPlan, gateWallIndex: number): { x: number; z: number } {
  const ringCount = plan.wallCount - 1; // last point duplicates the first
  const prev = gateWallIndex === 0 ? ringCount - 1 : gateWallIndex - 1;
  const next = (gateWallIndex + 1) % ringCount;
  const tx = (plan.wallX[next] as number) - (plan.wallX[prev] as number);
  const tz = (plan.wallZ[next] as number) - (plan.wallZ[prev] as number);
  const len = Math.sqrt(tx * tx + tz * tz);
  return len > 0.01 ? { x: tx / len, z: tz / len } : { x: 1, z: 0 };
}

/**
 * Birth a sector's crowd at `tick`.
 *
 * Pure function of `(worldSeed, sector, streets, lots, tick, cityPlan)` --
 * the ONLY place a crowd's roster is decided. One agent per building lot
 * (villages and city townhouses alike) up to a cap; a city sector adds one
 * guard per gate WHOSE POSITION FALLS INSIDE THIS SECTOR'S SQUARE, the same
 * ownership-by-position rule `road-mesh.ts` uses for a road crossing a
 * region boundary, so exactly one sector births each gate's guard. Everything
 * about an agent that never changes again -- home, role, speed, tint, its
 * cyclic goal list -- is fixed here from a hash, exactly the discipline
 * `lots.ts`'s `pickBuildingKind` uses.
 */
export function birthCrowd(
  worldSeed: number,
  sectorX: number,
  sectorZ: number,
  streets: SectorStreets,
  lots: SectorLots,
  tick: number,
  cityPlan?: CityPlan,
): CrowdState {
  const seed = worldSeed >>> 0;
  let graph = buildStreetGraph(streets);
  const site = streets.settlement;
  if (site === undefined || (graph.count < 2 && lots.count === 0)) {
    return emptyCrowd(seed, sectorX, sectorZ, graph, tick);
  }

  const cityMode = isCity(site);
  const cap = cityMode ? NPC_MAX_CITY_PER_SECTOR : NPC_MAX_VILLAGERS_PER_SECTOR;
  const n = graph.count >= 2 ? Math.min(lots.count, cap) : 0;

  const posX: number[] = [];
  const posZ: number[] = [];
  const role: number[] = [];
  const speed: number[] = [];
  const tint: number[] = [];
  const goalList: Int32Array[] = [];
  const goalCursor: number[] = [];
  const path: Int32Array[] = [];

  for (let i = 0; i < n; i++) {
    const homeX = lots.centerX[i] as number;
    const homeZ = lots.centerZ[i] as number;
    const homeNode = nearestGraphNode(graph, homeX, homeZ);

    const roleRoll = unitAt(seed, sectorX, sectorZ, i, ROLE_SALT);
    let r = ROLE_VILLAGER;
    if (roleRoll < NPC_CHILD_FRACTION) r = ROLE_CHILD;
    else if (cityMode && roleRoll < NPC_CHILD_FRACTION + NPC_MERCHANT_FRACTION_CITY) r = ROLE_MERCHANT;

    const otherLot = n > 1 ? (i + Math.max(1, Math.floor(n / 2))) % n : i;
    const otherNode = nearestGraphNode(graph, lots.centerX[otherLot] as number, lots.centerZ[otherLot] as number);
    const goals = dedupeGoals(
      graph.centerNode >= 0 ? [homeNode, graph.centerNode, otherNode] : [homeNode, otherNode],
    );
    const goalsArr = Int32Array.from(goals.length > 0 ? goals : [homeNode]);

    let sp = lerp(NPC_WALK_SPEED_MIN, NPC_WALK_SPEED_MAX, unitAt(seed, sectorX, sectorZ, i, SPEED_SALT));
    if (r === ROLE_CHILD) sp *= NPC_CHILD_SPEED_SCALE;

    posX.push(graph.nodeX[homeNode] as number);
    posZ.push(graph.nodeZ[homeNode] as number);
    role.push(r);
    speed.push(sp);
    tint.push(unitAt(seed, sectorX, sectorZ, i, TINT_SALT));
    goalList.push(goalsArr);
    const startCursor = goalsArr.length > 1 ? 1 : 0;
    goalCursor.push(startCursor);
    path.push(shortestPath(graph, goalsArr[0] as number, goalsArr[startCursor] as number).slice(1));
  }

  // City gate guards: one per gate this sector's square contains. Their beat
  // is two ad hoc nodes (the gate, and a station along the wall tangent)
  // appended to the graph -- not part of the street plan, so they need their
  // own edge rather than a `nearestGraphNode` lookup into the street ring.
  if (cityMode && cityPlan !== undefined) {
    const minX = sectorX * SECTOR_SIZE;
    const minZ = sectorZ * SECTOR_SIZE;
    const maxX = minX + SECTOR_SIZE;
    const maxZ = minZ + SECTOR_SIZE;
    const extraX: number[] = [];
    const extraZ: number[] = [];
    const extraEdges: [number, number][] = [];
    const guardGateNode: number[] = [];
    const guardStationNode: number[] = [];

    for (let g = 0; g < cityPlan.gateCount; g++) {
      const wi = cityPlan.gateIndex[g] as number;
      const gx = cityPlan.wallX[wi] as number;
      const gz = cityPlan.wallZ[wi] as number;
      if (gx < minX || gx >= maxX || gz < minZ || gz >= maxZ) continue;
      const tangent = gateTangent(cityPlan, wi);
      const localGate = extraX.length;
      extraX.push(gx);
      extraZ.push(gz);
      const localStation = extraX.length;
      extraX.push(gx + tangent.x * GUARD_STATION_DIST);
      extraZ.push(gz + tangent.z * GUARD_STATION_DIST);
      extraEdges.push([localGate, localStation]);
      guardGateNode.push(localGate);
      guardStationNode.push(localStation);
    }

    if (extraX.length > 0) {
      graph = appendGraphNodes(graph, extraX, extraZ, extraEdges);
      for (let g = 0; g < guardGateNode.length; g++) {
        const gateNode = graph.count - extraX.length + (guardGateNode[g] as number);
        const stationNode = graph.count - extraX.length + (guardStationNode[g] as number);
        const goalsArr = Int32Array.from([gateNode, stationNode]);
        posX.push(graph.nodeX[gateNode] as number);
        posZ.push(graph.nodeZ[gateNode] as number);
        role.push(ROLE_GUARD);
        speed.push(
          lerp(NPC_WALK_SPEED_MIN, NPC_WALK_SPEED_MAX, unitAt(seed, sectorX, sectorZ, 900 + g, SPEED_SALT)) *
            NPC_GUARD_SPEED_SCALE,
        );
        tint.push(unitAt(seed, sectorX, sectorZ, 900 + g, TINT_SALT));
        goalList.push(goalsArr);
        goalCursor.push(1);
        path.push(shortestPath(graph, gateNode, stationNode).slice(1));
      }
    }
  }

  const total = posX.length;
  const headX = new Array<number>(total);
  const headZ = new Array<number>(total);
  for (let i = 0; i < total; i++) {
    const p = path[i] as Int32Array;
    if (p.length > 0) {
      const tx = graph.nodeX[p[0] as number] as number;
      const tz = graph.nodeZ[p[0] as number] as number;
      const dx = tx - (posX[i] as number);
      const dz = tz - (posZ[i] as number);
      const len = Math.sqrt(dx * dx + dz * dz);
      headX[i] = len > 1e-6 ? dx / len : 1;
      headZ[i] = len > 1e-6 ? dz / len : 0;
    } else {
      headX[i] = 1;
      headZ[i] = 0;
    }
  }

  return {
    worldSeed: seed,
    sectorX,
    sectorZ,
    graph,
    birthTick: tick,
    tick,
    count: total,
    posX: Float64Array.from(posX),
    posZ: Float64Array.from(posZ),
    headX: Float64Array.from(headX),
    headZ: Float64Array.from(headZ),
    role: Uint8Array.from(role),
    speed: Float64Array.from(speed),
    tint: Float64Array.from(tint),
    goalList,
    goalCursor: Int32Array.from(goalCursor),
    path,
    waitTicks: new Int32Array(total),
  };
}

/** Deterministic loiter duration for one agent's arrival at one tick. Folds `tick` in so replays vary by history. */
function loiterTicks(worldSeed: number, sectorX: number, sectorZ: number, agent: number, tick: number): number {
  const u = hashUnit(hash3i(sectorX, sectorZ, agent, (worldSeed ^ LOITER_SALT ^ (tick | 0)) >>> 0));
  return NPC_LOITER_TICKS_MIN + Math.floor(u * (NPC_LOITER_TICKS_MAX - NPC_LOITER_TICKS_MIN));
}

export interface StepResult {
  readonly state: CrowdState;
  /** Agents that completed a goal (path exhausted) this tick. */
  readonly arrived: number;
  /** Agents whose position changed by more than `NPC_MOVE_EPS` this tick. */
  readonly moved: number;
}

/**
 * Advance a crowd by exactly one fixed tick.
 *
 * Called once per `Loop` fixed update, per resident sector -- see the header.
 * Builds entirely new arrays rather than mutating `state` in place, so the
 * input remains valid for a caller that wants to compare before/after (the
 * replay-identity test does exactly that).
 */
export function stepCrowd(
  state: CrowdState,
  tick: number,
  playerX: number,
  playerZ: number,
  collision: NpcCollision,
): StepResult {
  const n = state.count;
  if (n === 0) return { state: { ...state, tick }, arrived: 0, moved: 0 };

  const graph = state.graph;
  const posX = Float64Array.from(state.posX);
  const posZ = Float64Array.from(state.posZ);
  const headX = Float64Array.from(state.headX);
  const headZ = Float64Array.from(state.headZ);
  const goalCursor = Int32Array.from(state.goalCursor);
  const waitTicks = Int32Array.from(state.waitTicks);
  const path: Int32Array[] = state.path.map((p) => p);

  let arrived = 0;
  let moved = 0;

  for (let i = 0; i < n; i++) {
    if ((waitTicks[i] as number) > 0) {
      waitTicks[i] = (waitTicks[i] as number) - 1;
      continue;
    }

    let p = path[i] as Int32Array;
    if (p.length === 0) {
      const goals = state.goalList[i] as Int32Array;
      const cursor = goalCursor[i] as number;
      const nextCursor = goals.length > 1 ? (cursor + 1) % goals.length : cursor;
      const fromNode = goals[cursor] as number;
      const toNode = goals[nextCursor] as number;
      goalCursor[i] = nextCursor;
      p = shortestPath(graph, fromNode, toNode).slice(1);
      path[i] = p;
      if (p.length === 0) {
        // Nowhere new to walk to (a one-goal roster, or an unreachable pick):
        // loiter rather than spin every tick recomputing the same empty path.
        waitTicks[i] = loiterTicks(state.worldSeed, state.sectorX, state.sectorZ, i, tick);
        continue;
      }
    }

    const targetNode = p[0] as number;
    const tx = graph.nodeX[targetNode] as number;
    const tz = graph.nodeZ[targetNode] as number;
    const px = posX[i] as number;
    const pz = posZ[i] as number;
    const dx = tx - px;
    const dz = tz - pz;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= NPC_ARRIVE_EPS) {
      const rest = p.subarray(1);
      path[i] = rest;
      if (rest.length === 0) {
        arrived++;
        waitTicks[i] = loiterTicks(state.worldSeed, state.sectorX, state.sectorZ, i, tick);
      }
      continue;
    }

    const speed = state.speed[i] as number;
    const stepLen = Math.min(dist, speed * NPC_FIXED_DT);
    const vx = (dx / dist) * stepLen;
    const vz = (dz / dist) * stepLen;

    // Avoidance: agents 0..i-1 already moved this tick (their NEW position),
    // i+1..n-1 have not (last tick's) -- see the header for why that
    // asymmetry is the determinism rule rather than a bug.
    let avoidX = 0;
    let avoidZ = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const ox = px - (posX[j] as number);
      const oz = pz - (posZ[j] as number);
      const d2 = ox * ox + oz * oz;
      if (d2 >= NPC_AVOID_RADIUS * NPC_AVOID_RADIUS || d2 <= 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (1 - d / NPC_AVOID_RADIUS) * NPC_AVOID_STRENGTH * stepLen;
      avoidX += (ox / d) * push;
      avoidZ += (oz / d) * push;
    }
    {
      const ox = px - playerX;
      const oz = pz - playerZ;
      const d2 = ox * ox + oz * oz;
      if (d2 < NPC_PLAYER_AVOID_RADIUS * NPC_PLAYER_AVOID_RADIUS && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (1 - d / NPC_PLAYER_AVOID_RADIUS) * NPC_AVOID_STRENGTH * stepLen;
        avoidX += (ox / d) * push;
        avoidZ += (oz / d) * push;
      }
    }

    let nx = px + vx + avoidX;
    let nz = pz + vz + avoidZ;
    if (collision.blocked(nx, nz, NPC_RADIUS)) {
      nx = px + vx;
      nz = pz + vz;
      if (collision.blocked(nx, nz, NPC_RADIUS)) {
        waitTicks[i] = 1;
        continue;
      }
    }

    const movedX = nx - px;
    const movedZ = nz - pz;
    if (Math.abs(movedX) > NPC_MOVE_EPS || Math.abs(movedZ) > NPC_MOVE_EPS) {
      moved++;
      const movedLen = Math.sqrt(movedX * movedX + movedZ * movedZ);
      headX[i] = movedX / movedLen;
      headZ[i] = movedZ / movedLen;
    }
    posX[i] = nx;
    posZ[i] = nz;
  }

  return {
    state: {
      ...state,
      tick,
      posX,
      posZ,
      headX,
      headZ,
      goalCursor,
      waitTicks,
      path,
    },
    arrived,
    moved,
  };
}
