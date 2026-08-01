/**
 * Turning a `ChunkData` payload into a Three.js mesh, and destroying it again.
 *
 * This is the only place in `src/world/` that imports Three.js, so the
 * generator, the pool and the contracts stay usable from a worker and from
 * Node. Everything created here has a matching disposal in `disposeChunkMesh`.
 *
 * Explicit disposal is not optional: Three.js holds GPU buffers and textures
 * behind JS objects that the garbage collector cannot free on its own, so a
 * chunk that is merely dropped from a Map leaks VRAM until the context is lost.
 */

import * as THREE from 'three';
import { CHUNK_SIZE, chunkOrigin, type ChunkCoord, type ChunkData } from './contracts';

/**
 * A draw order that depends on the coordinate and nothing else.
 *
 * Three.js sorts opaque draws by `groupOrder`, then `renderOrder`, then
 * `material.id`, then depth. Material ids are handed out in construction order,
 * so without an explicit `renderOrder` the draw order of chunks is the order
 * their workers happened to finish -- which differs run to run.
 *
 * That is invisible for solid coplanar quads, and very visible in wireframe:
 * two neighbouring chunks draw their shared edge at exactly the same depth, and
 * whichever is drawn first wins the depth test. It made `shots:check` fail
 * intermittently on the wireframe views, which is precisely the kind of flake
 * that destroys trust in a screenshot harness.
 *
 * `z * 2^26 + x` is exactly representable as a double for |x|,|z| < 2^26, i.e.
 * out to about 4 billion metres, so distinct chunks can never collide.
 */
function chunkRenderOrder(coord: ChunkCoord): number {
  return coord.z * 67108864 + coord.x;
}

/**
 * Phase 1 renders unlit flat colour on purpose.
 *
 * `MeshBasicMaterial` means what you see is exactly the coordinate hash, with
 * no lighting in between, so a screenshot is a direct read-out of determinism.
 * It also sidesteps the placeholder lighting in `app.ts`, which Phase 10
 * replaces wholesale.
 */
function createChunkMaterial(data: ChunkData): THREE.MeshBasicMaterial {
  const [r, g, b] = data.color;
  const material = new THREE.MeshBasicMaterial();
  material.color.setRGB(r, g, b, THREE.SRGBColorSpace);
  return material;
}

function createChunkGeometry(data: ChunkData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  // Set bounds by hand rather than letting Three scan the vertex buffer: the
  // extents are known analytically, and frustum culling is what keeps draw
  // calls proportional to what is on screen rather than to what is resident.
  const half = CHUNK_SIZE / 2;
  const midY = (data.minY + data.maxY) / 2;
  const halfY = (data.maxY - data.minY) / 2;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, data.minY, 0),
    new THREE.Vector3(CHUNK_SIZE, data.maxY, CHUNK_SIZE),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(half, midY, half),
    Math.sqrt(half * half + half * half + halfY * halfY),
  );
  return geometry;
}

export interface ChunkMesh {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshBasicMaterial;
  /** sRGB colour, kept for the determinism round-trip check. */
  readonly color: readonly [number, number, number];
  /** Bytes of vertex data held by this chunk. */
  readonly bytes: number;
}

export function createChunkMesh(data: ChunkData): ChunkMesh {
  const geometry = createChunkGeometry(data);
  const material = createChunkMaterial(data);
  const mesh = new THREE.Mesh(geometry, material);

  // Positions are chunk-local; the mesh is placed by translating it, which
  // keeps float precision usable a long way from the origin.
  const origin = chunkOrigin(data.coord);
  mesh.position.set(origin.x, 0, origin.z);
  mesh.name = `chunk ${data.coord.x},${data.coord.z}`;
  mesh.renderOrder = chunkRenderOrder(data.coord);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    geometry,
    material,
    color: data.color,
    bytes: data.positions.byteLength + data.indices.byteLength,
  };
}

/**
 * Release every GPU resource a chunk owns.
 *
 * Textures are walked generically even though Phase 1 has none, so later phases
 * that add maps to the chunk material get disposal for free rather than
 * discovering a VRAM leak in Phase 11.
 */
export function disposeChunkMesh(entry: ChunkMesh): void {
  entry.mesh.removeFromParent();
  entry.geometry.dispose();
  disposeMaterial(entry.material);
}

function disposeMaterial(material: THREE.Material): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value !== null && typeof value === 'object' && (value as THREE.Texture).isTexture === true) {
      (value as THREE.Texture).dispose();
    }
  }
  material.dispose();
}
