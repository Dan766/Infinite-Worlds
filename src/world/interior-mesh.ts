import {
  LANDMARK_CATHEDRAL,
  LANDMARK_GATEHOUSE,
  LANDMARK_GUILD,
  LANDMARK_KEEP,
  LANDMARK_TOWNHALL,
} from './city';

export interface InteriorSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

type Rgb = readonly [number, number, number];

/**
 * Pure landmark interior geometry. Coordinates are landmark-local, with Y
 * relative to its floor; the Three-only overlay places the batch in the world.
 */
export function buildInteriorSurface(kind: number, halfW: number, halfD: number): InteriorSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const stone: Rgb = kind === LANDMARK_CATHEDRAL ? [0.56, 0.54, 0.5] : [0.42, 0.4, 0.36];
  const floor: Rgb = [0.25, 0.2, 0.14];
  const height =
    kind === LANDMARK_KEEP ? 10 :
    kind === LANDMARK_CATHEDRAL ? 13 :
    kind === LANDMARK_GATEHOUSE ? 8 :
    kind === LANDMARK_TOWNHALL ? 7 :
    kind === LANDMARK_GUILD ? 6 : 5;

  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    nx: number,
    ny: number,
    nz: number,
    color: Rgb,
  ): void => {
    const first = positions.length / 3;
    for (const point of [a, b, c, d]) {
      positions.push(point[0], point[1], point[2]);
      normals.push(nx, ny, nz);
      colors.push(color[0], color[1], color[2]);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };

  quad([-halfW, 0.03, -halfD], [halfW, 0.03, -halfD], [halfW, 0.03, halfD], [-halfW, 0.03, halfD], 0, 1, 0, floor);
  quad([-halfW, 0, -halfD], [-halfW, 0, halfD], [-halfW, height, halfD], [-halfW, height, -halfD], 1, 0, 0, stone);
  quad([halfW, 0, halfD], [halfW, 0, -halfD], [halfW, height, -halfD], [halfW, height, halfD], -1, 0, 0, stone);
  quad([-halfW, 0, halfD], [halfW, 0, halfD], [halfW, height, halfD], [-halfW, height, halfD], 0, 0, -1, stone);
  // Back wall leaves a centred 3 m passage/door.
  const door = Math.min(1.7, halfW * 0.3);
  quad([-halfW, 0, -halfD], [-door, 0, -halfD], [-door, height, -halfD], [-halfW, height, -halfD], 0, 0, 1, stone);
  quad([door, 0, -halfD], [halfW, 0, -halfD], [halfW, height, -halfD], [door, height, -halfD], 0, 0, 1, stone);

  // Naves and halls get a deterministic central aisle marked in lighter stone.
  if (kind !== LANDMARK_GATEHOUSE) {
    const aisle = Math.min(2.2, halfW * 0.35);
    quad([-aisle, 0.05, -halfD], [aisle, 0.05, -halfD], [aisle, 0.05, halfD], [-aisle, 0.05, halfD], 0, 1, 0, [0.46, 0.42, 0.34]);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
  };
}
