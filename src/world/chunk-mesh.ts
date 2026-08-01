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
import { skirtDepthOf } from './chunk-gen';
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
 * PHASE 2b FOLDS `lod` IN. A quadtree node and its parent share `(x, z)` for
 * the child at the parent's minimum corner, and both can be resident at once
 * while a split or a merge is still streaming. Without `lod` in the key those
 * two collide and the tie falls back to material id, i.e. to worker completion
 * order, which is exactly the flake this function exists to remove.
 *
 * `(z * 2^22 + x) * 8 + lod` is injective for |x|,|z| < 2^21 (about 134,000 km
 * at lod 0) and lod < 8, and its largest magnitude is 2^46 -- comfortably
 * inside the exactly-representable integers, so distinct nodes never collide.
 * Multiplying by 8 and adding a constant preserves the Phase 2a ordering
 * exactly for a lod-0-only scene.
 */
function chunkRenderOrder(coord: ChunkCoord): number {
  return (coord.z * 4194304 + coord.x) * 8 + coord.lod;
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
  // Single-sided, deliberately. The skirt needs to be opaque from both sides
  // and gets there by carrying both windings in its index buffer -- see
  // `SKIRT_TRIANGLE_COUNT` in `chunk-gen.ts` for why a double-sided material is
  // the wrong tool for it.
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
  //
  // `minY` is the SURFACE minimum; the skirt hangs below it. The bounds must
  // include the apron or frustum culling drops it exactly when it is doing its
  // job -- at a level boundary running off the bottom of the screen.
  const size = chunkSizeAt(data.coord.lod);
  const half = size / 2;
  const floorY = data.minY - skirtDepthOf(data.positions);
  const midY = (floorY + data.maxY) / 2;
  const halfY = (data.maxY - floorY) / 2;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, floorY, 0),
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
