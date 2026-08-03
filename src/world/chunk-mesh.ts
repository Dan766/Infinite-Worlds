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
import { BUILDING_LEVEL_LOD } from './building-mesh';
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
 * Phase 5: decks draw after ALL terrain, not merely after their own node's.
 *
 * A deck lies on ground graded to the same target, so the two are coplanar over
 * most of their length. `polygonOffset` settles that for filled polygons -- but
 * WebGL exposes no `POLYGON_OFFSET_LINE`, so in WIREFRAME the deck's lines and
 * the terrain's sit at exactly the same depth and the first one drawn wins. Give
 * a deck the same `renderOrder` as its own node and the tie between one node's
 * deck and the NEXT node's terrain falls back to material id, i.e. to whichever
 * worker finished first, and `shots:check` goes intermittent on every wireframe
 * view. That is the Phase 1 flake exactly, and Phase 3a's note said a wireframe
 * view going intermittent would be the first place to look. It was.
 *
 * `chunkRenderOrder` is bounded by 2^46, so adding 2^48 puts every deck after
 * every terrain mesh in the world while preserving the coordinate ordering among
 * decks. The largest value is under 2^53 and therefore exact.
 */
const DECK_RENDER_ORDER_BASE = 2 ** 48;

/**
 * Phase 6: buildings draw after every terrain mesh AND every deck.
 *
 * A building is not coplanar with anything, so it has none of the decal problem
 * the deck has -- but its plinth passes THROUGH the ground and its walls meet a
 * street deck at the setback, so in wireframe there are lines at very nearly the
 * same depth as both. The deck's argument applies unchanged: with no explicit
 * order the tie falls back to material id, i.e. to whichever worker finished
 * first, and a wireframe screenshot goes intermittent.
 *
 * A third band rather than sharing the deck's, so a building always draws over
 * the lane it fronts. 2^49 + 2^46 is still far inside the exactly-representable
 * integers.
 */
const BUILDING_RENDER_ORDER_BASE = 2 ** 49;

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

/**
 * Terrain meshes carrying Phase 4a road surfacing, actually rasterised since
 * the last reset.
 *
 * Exactly the same guard as `riverDraws`, and for exactly the same reason: a
 * road is not a mesh either, it is surfacing and grading applied to the terrain
 * mesh every node already had. Without this, "the flight never passed a road"
 * and "grading silently returns zero" are the same observation.
 */
let roadDraws = 0;

/** Road-bearing terrain meshes drawn since `resetRoadDraws`. Read straight after a render. */
export function roadDrawsSinceReset(): number {
  return roadDraws;
}

/** Call immediately before `renderer.render` to scope the count to one frame. */
export function resetRoadDraws(): void {
  roadDraws = 0;
}

/**
 * Terrain meshes carrying Phase 4b street surfacing, actually rasterised since
 * the last reset. The third of the same guard, and the one with the weakest
 * signal to protect: a village is a handful of nodes in a 4 km region.
 */
let streetDraws = 0;

/** Street-bearing terrain meshes drawn since `resetStreetDraws`. Read straight after a render. */
export function streetDrawsSinceReset(): number {
  return streetDraws;
}

/** Call immediately before `renderer.render` to scope the count to one frame. */
export function resetStreetDraws(): void {
  streetDraws = 0;
}

/**
 * Phase 5 DECK submeshes actually rasterised since the last reset.
 *
 * This one is the same guard as `waterDraws` rather than as `riverDraws`, and
 * the distinction is worth keeping straight: a deck IS its own mesh, so its
 * presence in the object list is already evidence it was generated. What that
 * cannot tell you is whether it reached the screen -- and a deck that renders
 * behind the terrain it is supposed to sit on, because the polygon offset was
 * lost, would still be in the object list and still be counted here. The check
 * that catches THAT is a screenshot; this one catches "the flight never passed a
 * road", which is the failure the soak can see.
 */
let deckDraws = 0;

/** Deck submeshes drawn since `resetDeckDraws`. Read straight after a render. */
export function deckDrawsSinceReset(): number {
  return deckDraws;
}

/** Call immediately before `renderer.render` to scope the count to one frame. */
export function resetDeckDraws(): void {
  deckDraws = 0;
}

const countDeckDraw = (): void => {
  deckDraws++;
};

/**
 * Phase 6 BUILDING submeshes actually rasterised since the last reset.
 *
 * `deckDraws`' guard, on the sparsest content in the project: buildings exist
 * only inside settlements, and a settlement is a handful of nodes in a 4 km
 * region. Every other building check the soak can make -- payload counts, the
 * levelness count, the round trip -- is satisfied by a flight that never saw
 * one, and this is the only one that is not.
 */
let buildingDraws = 0;

/** Building submeshes drawn since `resetBuildingDraws`. Read straight after a render. */
export function buildingDrawsSinceReset(): number {
  return buildingDraws;
}

/** Call immediately before `renderer.render` to scope the count to one frame. */
export function resetBuildingDraws(): void {
  buildingDraws = 0;
}

const countBuildingDraw = (): void => {
  buildingDraws++;
};

/**
 * One `onBeforeRender` callback per combination of features a node can carry.
 *
 * Phase 4a hand-wrote the two single counters and the one pair, which is fine
 * for two features and is eight functions for three. A table indexed by a
 * feature mask is built once at module load instead: still allocation-free, and
 * a fourth feature is one more bit rather than eight more hand-written
 * combinations.
 *
 * Index 0 is deliberately absent: a node with no feature at all gets no
 * `onBeforeRender` hook, so the common case pays nothing per draw.
 */
const FEATURE_RIVER = 1;
const FEATURE_ROAD = 2;
const FEATURE_STREET = 4;

const FEATURE_COUNTERS: readonly (() => void)[] = Array.from({ length: 8 }, (_, mask) => () => {
  if ((mask & FEATURE_RIVER) !== 0) riverDraws++;
  if ((mask & FEATURE_ROAD) !== 0) roadDraws++;
  if ((mask & FEATURE_STREET) !== 0) streetDraws++;
});

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

// ---------------------------------------------------------------------------
// The road and street deck
// ---------------------------------------------------------------------------

/**
 * Phase 5: the carriageway material.
 *
 * `polygonOffset` IS THE MECHANISM, and a world-space lift is not. The deck sits
 * on ground that was graded to the same profile it was built from, so the two
 * surfaces are coplanar over most of their length -- which is the textbook decal
 * problem. A fixed vertical offset cannot solve it across this project's depth
 * range: with `near` 0.5 and `far` 8000 the depth buffer resolves roughly two
 * metres at 4 km, so any lift large enough to win out there would have the deck
 * visibly hovering in the near field. `polygonOffset` is applied in DEPTH units
 * after projection, so one constant works at every distance.
 *
 * `DECK_LIFT` in `road-mesh.ts` is 5 cm and does a different job: it makes the
 * deck unambiguously the upper surface when something walks on it in Phase 8.
 *
 * Single-sided, like the terrain: the apron carries both windings instead, for
 * the reason `SKIRT_TRIANGLE_COUNT` gives -- a double-sided material flips the
 * normal on back faces and the underside of a bridge would shade near-black.
 *
 * Lambert and vertex-coloured for the same reason everything else here is:
 * Phase 11 replaces the material outright, so nothing may depend on it.
 */
function createDeckMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
}

/**
 * The deck submesh's geometry, or `null` when no road or street reaches this
 * node.
 *
 * `null` is what keeps this phase inside the draw-call budget: a deck is the
 * first thing since Phase 3a's water to cost a draw call of its own, and roads
 * are far sparser than sea. Building an empty mesh "for uniformity" would put
 * one extra draw call on every node in the world to draw nothing.
 *
 * Bounds come from the emitted vertices rather than from the node square,
 * exactly as the water's do: a deck clipping one corner of a node should be
 * culled when that corner is off screen.
 */
function createDeckGeometry(data: ChunkData): THREE.BufferGeometry | null {
  if (data.deckIndices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.deckPositions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.deckNormals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.deckColors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.deckIndices, 1));
  setBoundsFromPositions(geometry, data.deckPositions);
  return geometry;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * Phase 6: the building material.
 *
 * DELIBERATELY WITHOUT `polygonOffset`, which is the one thing that separates it
 * from the deck's material and is worth stating rather than leaving as an
 * omission. The deck needs it because it is coplanar with the ground by
 * construction. A building is a box standing ON the ground: its walls are
 * vertical and its plinth is buried, so nothing it draws is coplanar with
 * anything, and offsetting it would only push the whole house toward the camera.
 *
 * Single-sided, like the terrain and the deck. A closed box is never seen from
 * inside, and `building-mesh.ts` derives each face's winding from an outward
 * hint rather than assuming one -- so single-sided is also the setting that
 * makes a winding mistake VISIBLE (a hole in the house) instead of silently
 * correct from one side and black from the other.
 */
function createBuildingMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/**
 * The building submesh's geometry, or `null` on a node with no building centre
 * in it -- which is all but a handful of nodes in the world.
 *
 * The `null` discipline again, and this phase leans on it hardest: every node
 * everywhere would otherwise carry an empty mesh so that a few dozen village
 * nodes could carry a real one.
 *
 * Bounds from the emitted vertices, and here that is load-bearing rather than
 * merely tidy. A building is owned by the node holding its CENTRE and is not
 * clipped, so this submesh genuinely reaches outside the node square; bounding
 * it by the square would cull a house exactly when half of it is on screen.
 */
function createBuildingGeometry(data: ChunkData): THREE.BufferGeometry | null {
  if (data.buildingIndices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.buildingPositions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.buildingNormals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.buildingColors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.buildingIndices, 1));
  setBoundsFromPositions(geometry, data.buildingPositions);
  return geometry;
}

/** Box and sphere bounds over an xyz position buffer. */
function setBoundsFromPositions(geometry: THREE.BufferGeometry, p: Float32Array): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] as number;
    const y = p[i + 1] as number;
    const z = p[i + 2] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ),
  );
  const halfX = (maxX - minX) / 2;
  const halfY = (maxY - minY) / 2;
  const halfZ = (maxZ - minZ) / 2;
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(minX + halfX, minY + halfY, minZ + halfZ),
    Math.sqrt(halfX * halfX + halfY * halfY + halfZ * halfZ),
  );
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
 *
 * PHASE 5 FOLDS THE DECK IN, and it is the first phase since 3a that had to.
 * Rivers, roads and streets all moved vertices this hash already covered, so
 * they needed no new term. A deck is separate geometry: leave it out and the
 * RULE 2 check would keep passing while a road came back a different shape, in
 * a different place, or not at all.
 *
 * PHASE 6 FOLDS THE BUILDINGS IN, for the deck's reason and one more. Buildings
 * are separate geometry, so they need their own term -- and they are also the
 * first content whose PLACEMENT depends on an evaluation of the finished height
 * field rather than on a coordinate hash alone. A lot is accepted or refused by
 * comparing the ground against the grading target, so anything that made either
 * order-dependent would move a house without moving a single terrain vertex,
 * and every other term in this hash would be unchanged.
 */
export function hashChunkGeometry(data: ChunkData): number {
  let hash = hashPositions(data.positions);
  hash = hashFloats(hash, data.waterPositions);
  hash = hashFloats(hash, data.waterColors);
  hash = hashFloats(hash, data.deckPositions);
  hash = hashFloats(hash, data.buildingPositions);
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
  /** The Phase 5 deck submesh, or null on a node no road or street reaches. */
  readonly deckMesh: THREE.Mesh | null;
  readonly deckGeometry: THREE.BufferGeometry | null;
  readonly deckMaterial: THREE.MeshLambertMaterial | null;
  /** The Phase 6 building submesh, or null on a node with no building in it. */
  readonly buildingMesh: THREE.Mesh | null;
  readonly buildingGeometry: THREE.BufferGeometry | null;
  readonly buildingMaterial: THREE.MeshLambertMaterial | null;
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
  /** Triangles in the deck submesh alone. Zero on a node no road reaches. */
  readonly deckTriangles: number;
  /** Triangles in the building submesh alone. Zero on all but village nodes. */
  readonly buildingTriangles: number;
  /** Buildings whose centre lies in this node. Zero on all but village nodes. */
  readonly buildings: number;
  /**
   * Buildings here whose levelness was actually MEASURED -- i.e. `buildings` on
   * a lod-0 node and zero on any coarser one.
   *
   * The denominator `buildingsLevel` is a fraction of, and it is a separate
   * number rather than an inference because getting it wrong is silent: a
   * village is resident at several levels at once, so dividing by `buildings`
   * would compare a lod-0 count against an all-levels count and report a
   * perfectly graded village as a third level.
   */
  readonly buildingsMeasured: number;
  /** Of those, how many stand level on this node's own ground. See `BUILDING_LEVEL_LOD`. */
  readonly buildingsLevel: number;
  /** Deck stations standing clear of the ground: bridge geometry. Zero on most. */
  readonly bridgeVertices: number;
  /** Surface vertices a Phase 3b river channel lowered. Zero on most nodes. */
  readonly riverVertices: number;
  /** Surface vertices Phase 4a road surfacing covers. Zero on most nodes. */
  readonly roadVertices: number;
  /** Surface vertices Phase 4b street surfacing covers. Zero on almost all nodes. */
  readonly streetVertices: number;
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
  // Only on a node that actually carries carved or surfaced ground, so the
  // counters mean "a river/road/street reached the screen" rather than "terrain
  // reached the screen". `onBeforeRender` is a single slot, so a node carrying
  // several features gets the one callback that counts all of them rather than
  // silently losing the rest.
  const features =
    (data.riverVertices > 0 ? FEATURE_RIVER : 0) |
    (data.roadVertices > 0 ? FEATURE_ROAD : 0) |
    (data.streetVertices > 0 ? FEATURE_STREET : 0);
  if (features !== 0) mesh.onBeforeRender = FEATURE_COUNTERS[features] as () => void;

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

  const deckGeometry = createDeckGeometry(data);
  let deckMesh: THREE.Mesh | null = null;
  let deckMaterial: THREE.MeshLambertMaterial | null = null;
  if (deckGeometry !== null) {
    deckMaterial = createDeckMaterial();
    deckMesh = new THREE.Mesh(deckGeometry, deckMaterial);
    deckMesh.name = `deck ${data.coord.x},${data.coord.z},${data.coord.lod}`;
    // The coordinate-derived order, lifted clear of every terrain mesh in the
    // world. See `DECK_RENDER_ORDER_BASE`: sharing the terrain's band made
    // `shots:check` go intermittent on the wireframe views, which is the Phase 1
    // flake in its Phase 5 form.
    deckMesh.renderOrder = DECK_RENDER_ORDER_BASE + chunkRenderOrder(data.coord);
    deckMesh.matrixAutoUpdate = false;
    deckMesh.updateMatrix();
    deckMesh.onBeforeRender = countDeckDraw;
    // Parented to the terrain mesh, like the water, so every add, remove and
    // dispose the streamer already performs carries the deck with it.
    mesh.add(deckMesh);
  }

  const buildingGeometry = createBuildingGeometry(data);
  let buildingMesh: THREE.Mesh | null = null;
  let buildingMaterial: THREE.MeshLambertMaterial | null = null;
  if (buildingGeometry !== null) {
    buildingMaterial = createBuildingMaterial();
    buildingMesh = new THREE.Mesh(buildingGeometry, buildingMaterial);
    buildingMesh.name = `buildings ${data.coord.x},${data.coord.z},${data.coord.lod}`;
    buildingMesh.renderOrder = BUILDING_RENDER_ORDER_BASE + chunkRenderOrder(data.coord);
    buildingMesh.matrixAutoUpdate = false;
    buildingMesh.updateMatrix();
    buildingMesh.onBeforeRender = countBuildingDraw;
    // Parented to the terrain mesh, like the water and the deck, so the
    // streamer's existing add, remove and dispose carry it without knowing it
    // exists.
    mesh.add(buildingMesh);
  }

  return {
    mesh,
    geometry,
    material,
    waterMesh,
    waterGeometry,
    waterMaterial,
    deckMesh,
    deckGeometry,
    deckMaterial,
    buildingMesh,
    buildingGeometry,
    buildingMaterial,
    color: data.color,
    geometryHash: hashChunkGeometry(data),
    bytes: chunkDataBytes(data),
    triangles:
      (data.indices.length +
        data.waterIndices.length +
        data.deckIndices.length +
        data.buildingIndices.length) /
      3,
    vertices:
      (data.positions.length +
        data.waterPositions.length +
        data.deckPositions.length +
        data.buildingPositions.length) /
      3,
    waterTriangles: data.waterIndices.length / 3,
    deckTriangles: data.deckIndices.length / 3,
    buildingTriangles: data.buildingIndices.length / 3,
    buildings: data.buildings,
    buildingsMeasured: data.coord.lod === BUILDING_LEVEL_LOD ? data.buildings : 0,
    buildingsLevel: data.buildingsLevel,
    bridgeVertices: data.bridgeVertices,
    riverVertices: data.riverVertices,
    roadVertices: data.roadVertices,
    streetVertices: data.streetVertices,
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
  if (entry.deckMesh !== null) entry.deckMesh.removeFromParent();
  entry.deckGeometry?.dispose();
  if (entry.deckMaterial !== null) disposeMaterial(entry.deckMaterial);
  if (entry.buildingMesh !== null) entry.buildingMesh.removeFromParent();
  entry.buildingGeometry?.dispose();
  if (entry.buildingMaterial !== null) disposeMaterial(entry.buildingMaterial);
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
