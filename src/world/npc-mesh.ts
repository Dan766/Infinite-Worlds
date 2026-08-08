/**
 * Pure NPC body geometry: six boxes (torso, head, two arms, two legs), the
 * same low-poly-humanoid shape every part reuses.
 *
 * Modelled directly on `interior-mesh.ts`: coordinates are body-local (feet
 * at y = 0), a Three-only overlay (`npc-overlay.ts`) uploads each part ONCE
 * as shared geometry and reuses it across every instance via `InstancedMesh`,
 * so this module never runs per agent, only per archetype. Colours baked
 * here are neutral defaults (skin, cloth, leather); `npc-overlay.ts` layers a
 * per-instance tint on top via `InstancedMesh.setColorAt` for role and
 * culture variety (Phase 9b), which is a GPU-side multiply against these
 * vertex colours rather than a second geometry per variant.
 */

export interface BodyPart {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

export interface NpcBody {
  readonly torso: BodyPart;
  readonly head: BodyPart;
  readonly armL: BodyPart;
  readonly armR: BodyPart;
  readonly legL: BodyPart;
  readonly legR: BodyPart;
  /** Y of the hip / shoulder, body-local -- swing pivots for `npc-overlay.ts`'s gait. */
  readonly hipY: number;
  readonly shoulderY: number;
  readonly totalHeight: number;
}

type Rgb = readonly [number, number, number];

/**
 * One axis-aligned box, `hw`/`hd` half-extents in x/z, `h` full height,
 * centred at world-local `(0, cy, 0)`. Six quads, four verts each -- SHARED
 * verts would halve the count but give every face the same averaged normal,
 * which is wrong for a box; this is the same per-face-4-vert construction
 * `interior-mesh.ts`'s `quad` helper uses, so the exact count (24 positions,
 * 36 indices) is a stated, tested property rather than an accident of
 * whichever box builder ran first.
 */
function buildBox(hw: number, h: number, hd: number, cy: number, color: Rgb): BodyPart {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;

  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    nx: number,
    ny: number,
    nz: number,
  ): void => {
    const first = positions.length / 3;
    for (const p of [a, b, c, d]) {
      positions.push(p[0], p[1], p[2]);
      normals.push(nx, ny, nz);
      colors.push(color[0], color[1], color[2]);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };

  quad([-hw, y0, -hd], [hw, y0, -hd], [hw, y0, hd], [-hw, y0, hd], 0, -1, 0);
  quad([-hw, y1, hd], [hw, y1, hd], [hw, y1, -hd], [-hw, y1, -hd], 0, 1, 0);
  quad([-hw, y0, hd], [hw, y0, hd], [hw, y1, hd], [-hw, y1, hd], 0, 0, 1);
  quad([hw, y0, -hd], [-hw, y0, -hd], [-hw, y1, -hd], [hw, y1, -hd], 0, 0, -1);
  quad([-hw, y0, -hd], [-hw, y0, hd], [-hw, y1, hd], [-hw, y1, -hd], -1, 0, 0);
  quad([hw, y0, hd], [hw, y0, -hd], [hw, y1, -hd], [hw, y1, hd], 1, 0, 0);

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
  };
}

const SKIN: Rgb = [0.85, 0.7, 0.56];
const TUNIC: Rgb = [0.45, 0.35, 0.22];
const TROUSERS: Rgb = [0.32, 0.29, 0.26];

const LEG_H = 0.85;
const LEG_HW = 0.12;
const LEG_HD = 0.14;
const LEG_OFFSET_X = 0.14;

const TORSO_H = 0.6;
const TORSO_HW = 0.24;
const TORSO_HD = 0.16;

const HEAD_H = 0.22;
const HEAD_HW = 0.14;
const HEAD_HD = 0.14;

const ARM_H = 0.55;
const ARM_HW = 0.08;
const ARM_HD = 0.09;
const ARM_OFFSET_X = TORSO_HW + ARM_HW;

/** Hip height: top of the legs, where they meet the torso. Also the leg-swing pivot. */
const HIP_Y = LEG_H;
const SHOULDER_Y = LEG_H + TORSO_H - ARM_H * 0.5;
const TORSO_CENTER_Y = LEG_H + TORSO_H / 2;
const HEAD_CENTER_Y = LEG_H + TORSO_H + HEAD_H / 2;

/**
 * One villager-archetype body, in body-local space with feet at y = 0.
 *
 * Exactly 144 vertices (24 per part x 6 parts) -- an EXACT count, not a
 * range, the same anti-vacuity discipline `BUILDING_LOD_SIMPLIFY`'s
 * `addSimplifiedCap` uses: there is no per-role or per-culture variance in
 * the geometry itself (that lives in the per-instance tint), so the count
 * cannot legitimately vary and a test asserting it is exact rather than
 * bounded catches a real regression instead of only a gross one.
 */
export function buildVillagerBody(): NpcBody {
  return {
    legL: buildBox(LEG_HW, LEG_H, LEG_HD, LEG_H / 2, TROUSERS),
    legR: buildBox(LEG_HW, LEG_H, LEG_HD, LEG_H / 2, TROUSERS),
    torso: buildBox(TORSO_HW, TORSO_H, TORSO_HD, TORSO_CENTER_Y, TUNIC),
    head: buildBox(HEAD_HW, HEAD_H, HEAD_HD, HEAD_CENTER_Y, SKIN),
    armL: buildBox(ARM_HW, ARM_H, ARM_HD, SHOULDER_Y, SKIN),
    armR: buildBox(ARM_HW, ARM_H, ARM_HD, SHOULDER_Y, SKIN),
    hipY: HIP_Y,
    shoulderY: SHOULDER_Y,
    totalHeight: LEG_H + TORSO_H + HEAD_H,
  };
}

/** X offset of each left/right part from the body's centreline, body-local. */
export const NPC_LIMB_OFFSET_X = { leg: LEG_OFFSET_X, arm: ARM_OFFSET_X };
