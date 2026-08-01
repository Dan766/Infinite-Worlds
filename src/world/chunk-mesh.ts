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
import { skirtDepthOf, WATER_COLOR_COMPONENTS } from './chunk-gen';
import { SEA_LEVEL } from './height-field';
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

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * Water meshes actually rasterised since the last reset.
 *
 * THE THIRD ANTI-VACUITY GUARD IN THIS PROJECT, and the reason it is a counter
 * rather than an assumption. Phase 0 shipped a screenshot harness that compared
 * five blank frames byte-for-byte and called it a pass; Phase 2a's soak
 * measured draw calls from a camera pointed at the ground; Phase 2b's draw-call
 * budget could not fire. The equivalent failure here is a phase whose every
 * water check passes because the flight never went near the sea, and no
 * geometry test can rule that out -- generating water and RENDERING water are
 * different claims.
 *
 * `Object3D.onBeforeRender` fires once per object that survives frustum culling
 * and is actually submitted, so counting it is a direct measurement of "water
 * reached the screen". The soak fails if this stays at zero.
 *
 * It is a module-level counter, not world state: nothing generated depends on
 * it, and resetting it cannot change a single vertex.
 */
let waterDraws = 0;

/** Water meshes drawn since `resetWaterDraws`. Read straight after a render. */
export function waterDrawsSinceReset(): number {
  return waterDraws;
}

/** Call immediately before `renderer.render` to scope the count to one frame. */
export function resetWaterDraws(): void {
  waterDraws = 0;
}

const countWaterDraw = (): void => {
  waterDraws++;
};

/**
 * Terrain meshes carrying Phase 3b river carving, actually rasterised since the
 * last reset.
 *
 * THE SAME GUARD AS `waterDraws`, for the same reason, and rivers need it more.
 * Water is its own submesh, so "was any water drawn" is answerable by looking at
 * the object list. A river is not a mesh: it is a dent in the terrain mesh every
 * node already had. Without a counter, "the flight never went near a river" and
 * "carving silently returns zero" are the same observation, and every river
 * assertion in the soak would pass on either.
 *
 * A node is counted when its payload reported at least one measurably lowered
 * vertex, so this is "carved ground reached the screen", not "a node that might
 * contain a river was on screen".
 */
let riverDraws = 0;

/** Carved-terrain meshes drawn since `resetRiverDraws`. Read straight after a render. */
export function riverDrawsSinceReset(): number {
  return riverDraws;
}

/** Call immediately before `renderer.render` to scope the count to one frame. */
export function resetRiverDraws(): void {
  riverDraws = 0;
}

const countRiverDraw = (): void => {
  riverDraws++;
};

/**
 * Phase 3a: the water surface material.
 *
 * `transparent` with a four-component vertex colour is the entire depth-fade
 * mechanism: Three defines `USE_COLOR_ALPHA` when the colour attribute's
 * itemSize is 4 and multiplies the fragment's alpha by it, so opacity comes
 * from `waterColor(depth)` in the worker and there is no custom shader to keep
 * in step with it.
 *
 * `depthWrite: false` because a transparent surface that writes depth occludes
 * whatever is drawn after it. Nothing else in the scene is transparent yet, so
 * this costs nothing today and stops Phase 7's foliage or Phase 10's
 * atmosphere from being mysteriously clipped by the sea.
 *
 * `DoubleSide` is safe here in a way it explicitly was NOT for the Phase 2b
 * skirt. The skirt broke because two same-level neighbours put coincident
 * aprons in one plane and a lit front face z-fought a normal-flipped black back
 * face. The water surface has no coincident partner -- adjacent nodes abut, they
 * do not overlap -- so the only thing double-siding changes is that a camera
 * below sea level sees the underside of the sea instead of seeing straight
 * through it into the sky.
 *
 * Lambert rather than Basic so the sea is lit by the same lights as the ground
 * and follows Phase 10 when it replaces them. The surface is flat, so this is
 * a constant factor over the whole world -- which is exactly what makes it safe
 * to leave the normal off the payload (see `createWaterGeometry`).
 */
function createWaterMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * The water submesh's geometry, or `null` when this node has no water.
 *
 * `null` is not a tidiness detail: it is what makes an inland node cost zero
 * draw calls. Roughly nine tenths of the world is inland, so building an empty
 * mesh "for uniformity" would double the project's draw calls to draw nothing.
 *
 * THE NORMAL IS BUILT HERE, NOT SHIPPED. Every water normal is +Y, so sending
 * 1,089 copies of it through `postMessage` for every coastal node in the world
 * would be pure redundancy in the one budget (payload bytes) this project
 * actually measures. It is filled in on the main thread instead -- the same
 * heap either way, but nothing crosses the worker boundary and nothing has to
 * be accounted for in `chunkDataBytes`.
 */
function createWaterGeometry(data: ChunkData): THREE.BufferGeometry | null {
  if (data.waterIndices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.waterPositions, 3));
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(data.waterColors, WATER_COLOR_COMPONENTS),
  );
  geometry.setAttribute('normal', upNormals(data.waterPositions.length / 3));
  geometry.setIndex(new THREE.BufferAttribute(data.waterIndices, 1));

  // Bounds from the vertices that were actually emitted rather than from the
  // node square: a node with one submerged corner has water over one corner,
  // and telling the frustum test the truth is what keeps its draw call
  // proportional to what is on screen.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const p = data.waterPositions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] as number;
    const z = p[i + 2] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(minX, SEA_LEVEL, minZ),
    new THREE.Vector3(maxX, SEA_LEVEL, maxZ),
  );
  const halfX = (maxX - minX) / 2;
  const halfZ = (maxZ - minZ) / 2;
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(minX + halfX, SEA_LEVEL, minZ + halfZ),
    Math.sqrt(halfX * halfX + halfZ * halfZ),
  );
  return geometry;
}

/** A `normal` attribute of `count` copies of +Y. */
function upNormals(count: number): THREE.BufferAttribute {
  const normals = new Float32Array(count * 3);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  return new THREE.BufferAttribute(normals, 3);
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
  return hashFloats(0x811c9dc5 >>> 0, positions);
}

function hashFloats(seed: number, values: Float32Array): number {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let hash = seed >>> 0;
  for (let i = 0; i < words.length; i++) hash = hashCombine(hash, words[i] as number);
  return hash >>> 0;
}

/**
 * One hash covering everything about a node that is expensive to reproduce:
 * the terrain vertices, the water vertices, and the water's depth shading.
 *
 * The soak compares this before and after a round trip. Water is folded in
 * deliberately -- if it were left out, the RULE 2 check would keep passing
 * while the sea came back a different shape, and Phase 3b is about to start
 * cutting river channels through exactly this ground. `waterPositions` is what
 * encodes WHICH cells the shoreline covered; `waterColors` is what encodes how
 * deep it thought they were.
 */
export function hashChunkGeometry(data: ChunkData): number {
  let hash = hashPositions(data.positions);
  hash = hashFloats(hash, data.waterPositions);
  hash = hashFloats(hash, data.waterColors);
  return hash >>> 0;
}

export interface ChunkMesh {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshLambertMaterial;
  /** The water submesh, or null on a node with no ground below sea level. */
  readonly waterMesh: THREE.Mesh | null;
  readonly waterGeometry: THREE.BufferGeometry | null;
  readonly waterMaterial: THREE.MeshLambertMaterial | null;
  /** Stable per-chunk identity colour, sRGB. Not what the surface is painted with. */
  readonly color: readonly [number, number, number];
  /** Hash of the uploaded terrain and water buffers, for the RULE 2 round trip. */
  readonly geometryHash: number;
  /** Bytes of vertex data held by this chunk, terrain and water. */
  readonly bytes: number;
  /** Triangles in this chunk's geometry, terrain and water. */
  readonly triangles: number;
  /** Vertices in this chunk's geometry, terrain and water. */
  readonly vertices: number;
  /** Triangles in the water submesh alone. Zero on an inland node. */
  readonly waterTriangles: number;
  /** Surface vertices a Phase 3b river channel lowered. Zero on most nodes. */
  readonly riverVertices: number;
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
  // Only on a node that actually carries carved ground, so the counter means
  // "a river reached the screen" rather than "terrain reached the screen".
  if (data.riverVertices > 0) mesh.onBeforeRender = countRiverDraw;

  const waterGeometry = createWaterGeometry(data);
  let waterMesh: THREE.Mesh | null = null;
  let waterMaterial: THREE.MeshLambertMaterial | null = null;
  if (waterGeometry !== null) {
    waterMaterial = createWaterMaterial();
    waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
    waterMesh.name = `water ${data.coord.x},${data.coord.z},${data.coord.lod}`;

    // WHY WATER GETS AN EXPLICIT renderOrder TOO, AND WHY IT IS THE SAME
    // FUNCTION. Three sorts TRANSPARENT draws by groupOrder, then renderOrder,
    // then view depth, then OBJECT ID -- and object ids are handed out in
    // construction order, which is whichever worker finished first. Two water
    // meshes at equal depth (trivially arranged: any two nodes symmetric about
    // the view axis, on a surface that is perfectly flat by construction) would
    // therefore fall back to a run-to-run coin flip. That is precisely the
    // flake Phase 1 chased down on the wireframe views and Phase 2b had to fix
    // again when a node and its parent collided.
    //
    // Ordering water back-to-front is not needed and not attempted: the sea is
    // one plane cut into disjoint squares, so no two water fragments ever
    // overlap and blend order between nodes cannot be observed.
    waterMesh.renderOrder = chunkRenderOrder(data.coord);
    waterMesh.matrixAutoUpdate = false;
    waterMesh.updateMatrix();
    waterMesh.onBeforeRender = countWaterDraw;

    // Parented to the terrain mesh rather than added to the scene separately,
    // so every add/remove/dispose the streamer already does carries the water
    // with it. Frustum culling still tests each mesh against its own bounds --
    // Three projects children whether or not the parent survived the cull.
    mesh.add(waterMesh);
  }

  return {
    mesh,
    geometry,
    material,
    waterMesh,
    waterGeometry,
    waterMaterial,
    color: data.color,
    geometryHash: hashChunkGeometry(data),
    bytes: chunkDataBytes(data),
    triangles: (data.indices.length + data.waterIndices.length) / 3,
    vertices: (data.positions.length + data.waterPositions.length) / 3,
    waterTriangles: data.waterIndices.length / 3,
    riverVertices: data.riverVertices,
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
  if (entry.waterMesh !== null) entry.waterMesh.removeFromParent();
  entry.waterGeometry?.dispose();
  if (entry.waterMaterial !== null) disposeMaterial(entry.waterMaterial);
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
