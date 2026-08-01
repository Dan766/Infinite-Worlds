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
import { hashCombine } from '../core/hash';
import { chunkDataBytes, chunkOrigin, chunkSizeAt, type ChunkCoord, type ChunkData } from './contracts';

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
 *
 * Phase 2a keeps this even though the terrain is no longer coplanar: the
 * wireframe views still draw shared chunk edges at identical depth, and a
 * non-deterministic draw order is exactly what made `shots:check` flaky before.
 */
function chunkRenderOrder(coord: ChunkCoord): number {
  return coord.z * 67108864 + coord.x;
}

/**
 * Phase 2a: a lit material reading per-vertex colour.
 *
 * The surface colour is decided in `chunk-gen.ts` and baked into the `color`
 * attribute, so this material stays deliberately dumb -- no maps, no custom
 * shader, nothing that would need a second implementation of the terrain rules.
 * Lambert rather than Standard because there is no roughness or metalness to
 * express yet and Lambert is markedly cheaper to shade; Phase 11 replaces this
 * material outright.
 *
 * One material per chunk rather than one shared instance: it keeps the disposal
 * path genuinely exercised (a shared material would make `disposeChunkMesh` a
 * no-op that nobody notices until it matters), and Three caches the compiled
 * program across identical materials anyway, so the cost is a JS object.
 */
function createChunkMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

function createChunkGeometry(data: ChunkData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  // Set bounds by hand rather than letting Three scan the vertex buffer: the
  // horizontal extents are known analytically and the vertical extents came
  // back with the payload. Frustum culling is what keeps draw calls
  // proportional to what is on screen rather than to what is resident.
  const size = chunkSizeAt(data.coord.lod);
  const half = size / 2;
  const midY = (data.minY + data.maxY) / 2;
  const halfY = (data.maxY - data.minY) / 2;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, data.minY, 0),
    new THREE.Vector3(size, data.maxY, size),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(half, midY, half),
    Math.sqrt(half * half + half * half + halfY * halfY),
  );
  return geometry;
}

/**
 * A hash of the vertex positions actually uploaded to the GPU.
 *
 * RULE 2 says a chunk that is unloaded and regenerated must come back
 * byte-identical. Comparing a flat colour before and after a round trip -- what
 * Phase 1 did -- only ever proved the coordinate hash was pure. Hashing the raw
 * bit patterns of the position buffer proves the geometry itself is
 * reproducible, which is a far stronger statement and the one that matters now
 * that the geometry means something.
 *
 * Read as uint32 words rather than as floats so the comparison is over exact
 * bits, including the sign of a zero.
 */
export function hashPositions(positions: Float32Array): number {
  const words = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < words.length; i++) hash = hashCombine(hash, words[i] as number);
  return hash >>> 0;
}

export interface ChunkMesh {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshLambertMaterial;
  /** Stable per-chunk identity colour, sRGB. Not what the surface is painted with. */
  readonly color: readonly [number, number, number];
  /** Hash of the uploaded position buffer, for the RULE 2 round-trip check. */
  readonly positionsHash: number;
  /** Bytes of vertex data held by this chunk. */
  readonly bytes: number;
  /** Triangles in this chunk's geometry. */
  readonly triangles: number;
  /** Vertices in this chunk's geometry. */
  readonly vertices: number;
}

export function createChunkMesh(data: ChunkData): ChunkMesh {
  const geometry = createChunkGeometry(data);
  const material = createChunkMaterial();
  const mesh = new THREE.Mesh(geometry, material);

  // X and Z are node-local; the mesh is placed by translating it, which keeps
  // float precision usable a long way from the origin. Y is already absolute.
  const origin = chunkOrigin(data.coord);
  mesh.position.set(origin.x, 0, origin.z);
  mesh.name = `chunk ${data.coord.x},${data.coord.z},${data.coord.lod}`;
  mesh.renderOrder = chunkRenderOrder(data.coord);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    geometry,
    material,
    color: data.color,
    positionsHash: hashPositions(data.positions),
    bytes: chunkDataBytes(data),
    triangles: data.indices.length / 3,
    vertices: data.positions.length / 3,
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
