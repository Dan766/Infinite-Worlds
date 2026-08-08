/**
 * Three-only near-player adapter for NPC crowds. Modelled on
 * `interior-overlay.ts`: pure `npcs.ts`/`npc-mesh.ts` decide everything about
 * a crowd and a body; this file is only where that becomes GPU objects.
 *
 * ---------------------------------------------------------------------------
 * SIMULATION AND RENDERING ARE TWO SEPARATE ENTRY POINTS, ON PURPOSE
 *
 * `step(tick, ...)` must be called from the `Loop`'s FIXED update only (see
 * `app.ts`) -- it is what advances every resident crowd by one tick, and it
 * is the reason canonical screenshots stay reproducible: `freeze=1` means
 * zero fixed updates, so a paused capture never calls this and only ever
 * sees a crowd's tick-pure birth state.
 *
 * `update(...)` is called from `renderFrame` every drawn frame regardless of
 * pause state. It owns sector residency (birthing new crowds, evicting old
 * ones) and re-uploads instance transforms from whatever `step` last
 * computed -- it never advances a single agent. Rendering more or fewer
 * times than the sim ticks is exactly the same relationship `chunk-mesh.ts`
 * has with `simTime` everywhere else in this project.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE MAY CALL `sampleHeight` PER RENDERED INSTANCE AND `npcs.ts`
 * MAY NOT
 *
 * `npcs.ts`'s header explains why the SIMULATION never calls `sampleHeight`:
 * it runs every fixed tick, for every resident agent, so it would put
 * thousands of calls a second onto the hottest function in the codebase.
 * This file calls it once per VISIBLE instance per RENDERED FRAME, bounded by
 * `NPC_INSTANCE_CAP` rather than by the resident population -- the same order
 * of cost `building-mesh.ts` and `prop-mesh.ts` already pay per node, and
 * nowhere near the simulation's budget.
 */

import * as THREE from 'three';
import { collidesWithCityWall, collidesWithLots } from './collision';
import { SECTOR_SIZE } from './contracts';
import { cityPlanAt, isCity, type CityPlan } from './city';
import { CULTURES } from './culture';
import { sampleHeight, worldRegionField, worldSectorField, type RegionField, type SectorField } from './height-field';
import { buildVillagerBody, NPC_LIMB_OFFSET_X, type BodyPart } from './npc-mesh';
import {
  birthCrowd,
  ROLE_CHILD,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_VILLAGER,
  stepCrowd,
  type CrowdState,
  type NpcCollision,
} from './npcs';
import type { SectorLots } from './lots';

/** Sectors kept resident at once. A 3x3 window is 9; this leaves headroom for a corner straddling more. */
const NPC_CROWD_CACHE_LIMIT = 24;

/** Sectors around the camera's own square that are birthed/kept alive. */
const NPC_RESIDENT_SECTOR_RADIUS = 1;

/** Total instances any one body part will ever upload in a frame. 6 draw calls total, however many agents exist. */
const NPC_INSTANCE_CAP = 320;

const ROLE_COLOR: Record<number, readonly [number, number, number]> = {
  [ROLE_VILLAGER]: [0.45, 0.35, 0.22],
  [ROLE_CHILD]: [0.5, 0.42, 0.3],
  [ROLE_MERCHANT]: [0.55, 0.4, 0.18],
  [ROLE_GUARD]: [0.32, 0.34, 0.4],
};

interface CrowdEntry {
  state: CrowdState;
  readonly lots: SectorLots;
  readonly cityPlan: CityPlan | undefined;
  /** Settlement-level culture tint, computed once at birth -- see `cultureTintAt`. */
  readonly cultureTint: readonly [number, number, number];
}

/** Draw calls actually rasterised since the last reset -- the same guard `chunk-mesh.ts` uses for every other feature. */
let npcDraws = 0;
export function npcDrawsSinceReset(): number {
  return npcDraws;
}
export function resetNpcDraws(): void {
  npcDraws = 0;
}
const countNpcDraw = (): void => {
  npcDraws++;
};

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpColor = new THREE.Color();
const tmpOffset = new THREE.Vector3();
const tmpPosition = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

export class NpcOverlay {
  readonly root = new THREE.Group();

  private readonly region: RegionField;
  private readonly sectors: SectorField;
  private readonly body = buildVillagerBody();
  private readonly torso: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly armL: THREE.InstancedMesh;
  private readonly armR: THREE.InstancedMesh;
  private readonly legL: THREE.InstancedMesh;
  private readonly legR: THREE.InstancedMesh;
  private readonly allMeshes: THREE.InstancedMesh[];

  private readonly cache = new Map<string, CrowdEntry>();
  private currentTick = 0;

  /** Cumulative agent-tick move/arrival counts -- monotone, so a brief transient is never missed. See `PROGRESS.md`'s Phase 9 entry. */
  private movedTotal = 0;
  private arrivedTotal = 0;
  /** Current resident population, recomputed every `update()`. */
  private rosterCount = 0;
  private visibleCount = 0;

  constructor(private readonly worldSeed: number) {
    this.region = worldRegionField(worldSeed);
    this.sectors = worldSectorField(this.region, worldSeed);
    this.root.name = 'npcs';

    const makeMesh = (part: BodyPart): THREE.InstancedMesh => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(part.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      const material = new THREE.MeshLambertMaterial({ vertexColors: true });
      const mesh = new THREE.InstancedMesh(geometry, material, NPC_INSTANCE_CAP);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.onBeforeRender = countNpcDraw;
      return mesh;
    };

    this.torso = makeMesh(this.body.torso);
    this.head = makeMesh(this.body.head);
    this.armL = makeMesh(this.body.armL);
    this.armR = makeMesh(this.body.armR);
    this.legL = makeMesh(this.body.legL);
    this.legR = makeMesh(this.body.legR);
    this.allMeshes = [this.torso, this.head, this.armL, this.armR, this.legL, this.legR];
    this.root.add(...this.allMeshes);
  }

  /** Cumulative agent-ticks that actually moved. Zero forever means "the crowd is frozen", not "nobody is nearby". */
  get npcsMoved(): number {
    return this.movedTotal;
  }
  /** Cumulative goal completions. Zero forever means routing silently returns no path. */
  get npcsArrived(): number {
    return this.arrivedTotal;
  }
  /** Agents alive across every resident sector right now. */
  get npcsRostered(): number {
    return this.rosterCount;
  }
  /** Instances actually uploaded this frame (capped by `NPC_INSTANCE_CAP`). */
  get npcsVisible(): number {
    return this.visibleCount;
  }

  /**
   * Advance every resident crowd by exactly one fixed tick.
   *
   * MUST be called from the `Loop`'s fixed-update callback only -- see the
   * header. Never call this from `renderFrame`.
   */
  step(tick: number, playerX: number, playerZ: number): void {
    this.currentTick = tick;
    for (const entry of this.cache.values()) {
      const collision: NpcCollision = {
        blocked: (x, z, r) =>
          collidesWithLots(x, z, r, entry.lots) ||
          (entry.cityPlan !== undefined && collidesWithCityWall(x, z, r, entry.cityPlan)),
      };
      const result = stepCrowd(entry.state, tick, playerX, playerZ, collision);
      entry.state = result.state;
      this.movedTotal += result.moved;
      this.arrivedTotal += result.arrived;
    }
  }

  /**
   * Sector residency and instance upload. Called from `renderFrame` every
   * drawn frame. Never advances simulation state -- see the header.
   */
  update(cameraX: number, cameraZ: number, enabled: boolean): void {
    if (!enabled) {
      this.cache.clear();
      for (const mesh of this.allMeshes) mesh.count = 0;
      this.rosterCount = 0;
      this.visibleCount = 0;
      return;
    }

    const sx = Math.floor(cameraX / SECTOR_SIZE);
    const sz = Math.floor(cameraZ / SECTOR_SIZE);
    for (let dz = -NPC_RESIDENT_SECTOR_RADIUS; dz <= NPC_RESIDENT_SECTOR_RADIUS; dz++) {
      for (let dx = -NPC_RESIDENT_SECTOR_RADIUS; dx <= NPC_RESIDENT_SECTOR_RADIUS; dx++) {
        this.touch(sx + dx, sz + dz);
      }
    }
    while (this.cache.size > NPC_CROWD_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }

    this.upload();
  }

  dispose(): void {
    this.cache.clear();
    for (const mesh of this.allMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.root.removeFromParent();
  }

  /** Birth a sector's crowd if it is not already resident; move it to most-recently-used either way. */
  private touch(sectorX: number, sectorZ: number): void {
    const key = `${sectorX},${sectorZ}`;
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      // Map re-insertion is the move-to-MRU step; eviction below removes the
      // map's current FIRST entry, which is therefore always the least
      // recently touched -- the same discipline `lru-cache.ts` documents.
      this.cache.delete(key);
      this.cache.set(key, existing);
      return;
    }

    const streets = this.sectors.streets.streetsAt(sectorX, sectorZ);
    const lots = this.sectors.lots.lotsAt(sectorX, sectorZ);
    const site = streets.settlement;
    const cityPlan = site !== undefined && isCity(site) ? cityPlanAt(site, this.worldSeed) : undefined;
    const state = birthCrowd(this.worldSeed, sectorX, sectorZ, streets, lots, this.currentTick, cityPlan);
    const cultureTint = site !== undefined ? this.cultureTintAt(site.x, site.z) : ([1, 1, 1] as const);
    this.cache.set(key, { state, lots, cityPlan, cultureTint });
  }

  /** Settlement-level clothing tint from the culture owning this point, or neutral off any polity. */
  private cultureTintAt(x: number, z: number): readonly [number, number, number] {
    const polity = this.region.politics.polityAt(x, z);
    if (polity === undefined) return [1, 1, 1];
    const cultureId = this.region.politics.cultureOf(polity);
    const palette = CULTURES[cultureId]?.palette;
    return palette !== undefined ? palette.wallA : [1, 1, 1];
  }

  private upload(): void {
    let rostered = 0;
    let visible = 0;

    for (const mesh of this.allMeshes) mesh.count = 0;

    outer: for (const entry of this.cache.values()) {
      const state = entry.state;
      rostered += state.count;
      for (let i = 0; i < state.count; i++) {
        if (visible >= NPC_INSTANCE_CAP) break outer;

        const x = state.posX[i] as number;
        const z = state.posZ[i] as number;
        const y = sampleHeight(x, z, this.worldSeed);
        const hx = state.headX[i] as number;
        const hz = state.headZ[i] as number;
        const yaw = Math.atan2(hx, hz);
        tmpEuler.set(0, yaw, 0);
        tmpQuat.setFromEuler(tmpEuler);

        this.setInstance(this.torso, visible, x, y, z, tmpQuat, 0);
        this.setInstance(this.head, visible, x, y, z, tmpQuat, 0);
        this.setInstance(this.armL, visible, x, y, z, tmpQuat, -NPC_LIMB_OFFSET_X.arm);
        this.setInstance(this.armR, visible, x, y, z, tmpQuat, NPC_LIMB_OFFSET_X.arm);
        this.setInstance(this.legL, visible, x, y, z, tmpQuat, -NPC_LIMB_OFFSET_X.leg);
        this.setInstance(this.legR, visible, x, y, z, tmpQuat, NPC_LIMB_OFFSET_X.leg);

        const role = state.role[i] as number;
        const base = ROLE_COLOR[role] ?? ROLE_COLOR[ROLE_VILLAGER]!;
        const tint = state.tint[i] as number;
        const variance = 0.85 + tint * 0.3;
        const cr = base[0] * variance * (0.6 + 0.4 * entry.cultureTint[0]);
        const cg = base[1] * variance * (0.6 + 0.4 * entry.cultureTint[1]);
        const cb = base[2] * variance * (0.6 + 0.4 * entry.cultureTint[2]);
        tmpColor.setRGB(cr, cg, cb);
        this.torso.setColorAt(visible, tmpColor);

        visible++;
      }
    }

    for (const mesh of this.allMeshes) {
      mesh.count = visible;
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.torso.instanceColor !== null) this.torso.instanceColor.needsUpdate = true;

    this.rosterCount = rostered;
    this.visibleCount = visible;
  }

  /**
   * One instanced part's transform: the agent's world position and yaw,
   * with a body-local X offset for a left/right limb (the body geometry
   * itself is built centred on the spine -- see `npc-mesh.ts`).
   */
  private setInstance(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    rotation: THREE.Quaternion,
    localOffsetX: number,
  ): void {
    if (localOffsetX !== 0) {
      tmpOffset.set(localOffsetX, 0, 0).applyQuaternion(rotation);
      tmpPosition.set(x + tmpOffset.x, y, z + tmpOffset.z);
    } else {
      tmpPosition.set(x, y, z);
    }
    tmpMatrix.compose(tmpPosition, rotation, ONE);
    mesh.setMatrixAt(index, tmpMatrix);
  }
}
