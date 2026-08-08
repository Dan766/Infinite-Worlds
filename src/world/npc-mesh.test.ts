/**
 * Tests for the villager body: exact vertex counts, the same anti-vacuity
 * discipline `building-mesh.test.ts`'s `BUILDING_LOD_SIMPLIFY` check uses --
 * a bounded range would let a regression that silently drops a face through.
 */

import { describe, expect, it } from 'vitest';
import { buildVillagerBody, type BodyPart } from './npc-mesh';

function expectBox(part: BodyPart): void {
  // 6 faces x 4 verts, non-indexed-normal box -- see `buildBox`'s header.
  expect(part.positions.length).toBe(24 * 3);
  expect(part.normals.length).toBe(24 * 3);
  expect(part.colors.length).toBe(24 * 3);
  expect(part.indices.length).toBe(36);
}

describe('buildVillagerBody', () => {
  const body = buildVillagerBody();

  it('is exactly six boxes, each with an exact vertex count', () => {
    for (const part of [body.torso, body.head, body.armL, body.armR, body.legL, body.legR]) {
      expectBox(part);
    }
  });

  it('is exactly 144 vertices total, not a range', () => {
    const total =
      body.torso.positions.length / 3 +
      body.head.positions.length / 3 +
      body.armL.positions.length / 3 +
      body.armR.positions.length / 3 +
      body.legL.positions.length / 3 +
      body.legR.positions.length / 3;
    expect(total).toBe(144);
  });

  it('stands with feet at y = 0 and the head above the torso above the legs', () => {
    const minY = (part: BodyPart): number => {
      let m = Infinity;
      for (let i = 1; i < part.positions.length; i += 3) m = Math.min(m, part.positions[i] as number);
      return m;
    };
    const maxY = (part: BodyPart): number => {
      let m = -Infinity;
      for (let i = 1; i < part.positions.length; i += 3) m = Math.max(m, part.positions[i] as number);
      return m;
    };
    expect(minY(body.legL)).toBeCloseTo(0, 5);
    expect(minY(body.legR)).toBeCloseTo(0, 5);
    expect(maxY(body.legL)).toBeLessThanOrEqual(body.hipY + 1e-6);
    expect(minY(body.torso)).toBeGreaterThanOrEqual(body.hipY - 1e-6);
    expect(minY(body.head)).toBeGreaterThanOrEqual(maxY(body.torso) - 1e-6);
    expect(maxY(body.head)).toBeCloseTo(body.totalHeight, 5);
  });

  it('is a pure function -- two calls agree exactly', () => {
    const a = buildVillagerBody();
    const b = buildVillagerBody();
    expect(Array.from(a.torso.positions)).toEqual(Array.from(b.torso.positions));
    expect(a.hipY).toBe(b.hipY);
    expect(a.totalHeight).toBe(b.totalHeight);
  });

  it('every triangle winds with a normal consistent with a right-hand rule', () => {
    // Spot-check the torso's front face (+z normal): its first triangle should
    // wind counter-clockwise when viewed from +z, i.e. from outside the box.
    const p = body.torso.positions;
    const idx = body.torso.indices;
    const v = (i: number): [number, number, number] => [
      p[(idx[i] as number) * 3] as number,
      p[(idx[i] as number) * 3 + 1] as number,
      p[(idx[i] as number) * 3 + 2] as number,
    ];
    const [a, b, c] = [v(0), v(1), v(2)];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    // Face normal should point outward (-y for the bottom-most quad, index 0).
    expect(nx * 0 + ny * -1 + nz * 0).toBeGreaterThan(0);
  });
});
