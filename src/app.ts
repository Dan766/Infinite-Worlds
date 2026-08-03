/**
 * Application wiring.
 *
 * Owns the object graph and nothing else: parameters in, subsystems
 * constructed, loop started. Subsystems register their own HUD lines and debug
 * toggles rather than being enumerated here, so later phases add content
 * without touching this file.
 */

import * as THREE from 'three';
import { Autopilot } from './core/autopilot';
import { CameraRig } from './core/camera-rig';
import { Loop } from './core/loop';
import { hasParam, parseParams, serializeParams, type AppParams } from './core/params';
import { FrameTimer } from './debug/frame-timer';
import { formatCount, Hud, HudOrder, readHeapMb } from './debug/hud';
import { DebugPanel } from './debug/panel';
import { Renderer } from './render/renderer';
import { CubeScene } from './scene/cube';
import { ChunkStreamer } from './world/chunk-streamer';
import {
  buildingDrawsSinceReset,
  deckDrawsSinceReset,
  propDrawsSinceReset,
  resetBuildingDraws,
  resetDeckDraws,
  resetPropDraws,
  resetRiverDraws,
  resetRoadDraws,
  resetStreetDraws,
  resetWaterDraws,
  riverDrawsSinceReset,
  roadDrawsSinceReset,
  streetDrawsSinceReset,
  waterDrawsSinceReset,
} from './world/chunk-mesh';
import { sampleHeight } from './world/height-field';

declare global {
  interface Window {
    /**
     * Set once the first frames have actually been rendered. The screenshot
     * harness waits on this instead of sleeping, so captures can never race the
     * first frame.
     */
    __worldReady?: boolean;
    /**
     * Set to `false` by a harness BEFORE the document runs to hold the
     * autopilot at `?pos=` until it says otherwise; set back to `true` to
     * release it. Absent -- the normal case, including a human opening a
     * `?fly=` URL -- means released.
     *
     * `__worldReady` alone is not enough for the soak, and Phase 5 found out
     * why. Readiness is observed by polling from Node, and the main thread
     * stalls for over a second at a time building meshes under a software
     * rasteriser, so the poll lands late and the flight has already covered
     * hundreds of metres by the time the baseline is taken. Everything the soak
     * says "at the start" is then a claim about a square nobody chose.
     */
    __flightReleased?: boolean;
    __app?: App;
  }
}

/** Frames that must render before the app declares itself ready. */
const READY_FRAME_COUNT = 2;

export class App {
  readonly params: AppParams;

  private readonly renderer: Renderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly cube: CubeScene;
  private readonly streamer: ChunkStreamer;
  private readonly autopilot: Autopilot;
  private readonly hud: Hud;
  private readonly panel: DebugPanel;
  private readonly frameTimer = new FrameTimer();
  private readonly loop: Loop;

  private renderedFrames = 0;
  /**
   * Water submeshes actually rasterised in the last frame.
   *
   * Not a cosmetic HUD line: the soak fails if this never rises above zero, so
   * a Phase 3a whose flight happens to miss the sea is a failure rather than a
   * green run that proved nothing. See `chunk-mesh.ts`.
   */
  private waterDrawCalls = 0;
  /**
   * Terrain meshes carrying river carving actually rasterised in the last
   * frame. Same role as `waterDrawCalls`, and rivers need it more: a river is
   * not its own mesh, so nothing else can tell "no river nearby" apart from
   * "carving stopped working". See `chunk-mesh.ts`.
   */
  private riverDrawCalls = 0;
  /**
   * Terrain meshes carrying road surfacing actually rasterised in the last
   * frame. Same role as `riverDrawCalls`, and needed for the same reason: a
   * road is not its own mesh either. See `chunk-mesh.ts`.
   */
  private roadDrawCalls = 0;
  /**
   * Terrain meshes carrying Phase 4b street surfacing actually rasterised in the
   * last frame. The third of the same guard; a village is a handful of nodes in
   * a 4 km region, so this is the one most likely to be quietly zero.
   */
  private streetDrawCalls = 0;
  /**
   * Phase 5 deck submeshes actually rasterised in the last frame.
   *
   * The first of these counters since Phase 3a's water that measures a mesh of
   * its own rather than a feature baked into the terrain -- which is exactly why
   * a deck is the first thing since Phase 2b that can move the draw-call budget.
   */
  private deckDrawCalls = 0;

  /**
   * Phase 6 building submeshes actually rasterised in the last frame.
   *
   * The second mesh of its own after the deck, and the sparsest thing in the
   * world: it is zero on almost every frame of a flight, and non-zero only over
   * a settlement. That is what makes it worth measuring separately rather than
   * folding into `deckDrawCalls`.
   */
  private buildingDrawCalls = 0;
  private propDrawCalls = 0;

  constructor(canvas: HTMLCanvasElement, hudElement: HTMLElement, search: string) {
    this.params = parseParams(search);

    this.renderer = new Renderer(canvas);
    // With terrain, one fixed default camera height is underground on one seed
    // and in the clouds on the next, so the DEFAULT Y is read as metres above
    // the ground. An explicit `?pos=` is always absolute -- a URL has to mean
    // exactly one thing or the whole screenshot harness stops reproducing.
    const start = hasParam(search, 'pos')
      ? this.params.pos
      : {
          ...this.params.pos,
          y: sampleHeight(this.params.pos.x, this.params.pos.z, this.params.seedHash) + this.params.pos.y,
        };
    this.rig = new CameraRig(start, this.params.look);
    this.cube = new CubeScene(this.params.seedHash);
    this.hud = new Hud(hudElement, { visible: this.params.hud });
    this.panel = new DebugPanel({ visible: this.params.panel, title: 'Infinite World' });

    // All world generation happens in workers owned by the streamer; the main
    // thread only builds meshes from the payloads they transfer back.
    this.streamer = new ChunkStreamer({
      worldSeed: this.params.seedHash,
      onSceneChanged: () => this.renderer.invalidateMaterials(),
    });
    this.autopilot = new Autopilot(this.params.fly, this.params.flyLeg);

    this.scene.add(this.cube.root, this.streamer.root);
    this.addLighting();

    this.renderer.setWireframe(this.params.wireframe);

    // `?time=` seeks to an absolute simulation tick, so the pose in a
    // screenshot is a function of the URL rather than of elapsed wall time.
    this.loop = new Loop(
      (_dt, tick) => this.cube.update(tick * (1 / 60)),
      (_alpha, wallDt) => this.renderFrame(wallDt),
      {
        startTick: Math.round(this.params.time * 60),
        paused: this.params.freeze,
      },
    );
    // Put the scene into its start state before the first frame is drawn.
    this.cube.update(this.loop.simTime);

    this.registerHudLines();
    this.buildPanel();
    this.cube.registerDebug(this.hud, this.panel);
    // Replaces the placeholder `chunks` and `worker queue` lines registered
    // above, by label. See `Hud.register`.
    this.streamer.registerDebug(this.hud, this.panel);

    this.rig.attach(canvas);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    this.onResize();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.rig.detach();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.panel.destroy();
    this.cube.dispose();
    this.streamer.dispose();
    this.renderer.dispose();
  }

  /** Current state as URL parameters, for the panel's copy-link button. */
  currentParams(): AppParams {
    return {
      ...this.params,
      pos: this.rig.position,
      look: this.rig.look,
      freeze: this.loop.paused,
      time: this.loop.simTime,
      hud: this.hud.visible,
      panel: this.panel.visible,
      wireframe: this.renderer.wireframeEnabled,
    };
  }

  /** Shareable URL reproducing exactly what is on screen. */
  currentUrl(): string {
    return `${location.origin}${location.pathname}${serializeParams(this.currentParams())}`;
  }

  /** Exposed for the screenshot harness and for manual debugging. */
  hudText(): string {
    return this.hud.render();
  }

  /**
   * Machine-readable state for `npm run soak`.
   *
   * The five-minute flat-heap budget cannot be checked by a human staring at
   * the HUD, so everything the soak test asserts on is exposed here in one
   * plain object that survives `page.evaluate`'s structured clone.
   */
  perfSnapshot(): Record<string, number | boolean> {
    const frame = this.frameTimer.stats;
    const render = this.renderer.stats();
    const chunks = this.streamer.stats();
    const camera = this.rig.position;

    return {
      nowMs: performance.now(),
      heapMb: readHeapMb() ?? -1,
      fps: frame.fps,
      avgFrameMs: frame.avgMs,
      windowMaxFrameMs: frame.maxMs,
      peakFrameMs: this.frameTimer.peakMs,
      spikes: this.frameTimer.totalSpikes,
      frames: this.frameTimer.totalFrames,
      drawCalls: render.drawCalls,
      triangles: render.triangles,
      geometries: render.geometries,
      textures: render.textures,
      liveChunks: chunks.live,
      cachedChunks: chunks.cached,
      queuedChunks: chunks.queued,
      inFlightChunks: chunks.inFlight,
      generatedChunks: chunks.generated,
      cancelledChunkRequests: chunks.cancelledRequests,
      evictedChunks: chunks.evicted,
      chunkBytes: chunks.bytes,
      // From the chunk payloads, not from the renderer: these are what the
      // world costs regardless of which GPU (or software rasteriser) draws it,
      // which is why the soak can budget them and cannot budget frame time.
      chunkTriangles: chunks.triangles,
      chunkVertices: chunks.vertices,
      // Phase 3a. `waterNodes` is what was generated and resident;
      // `waterDrawCalls` is what actually reached the rasteriser. The soak
      // needs both -- a world full of sea that is never on screen would pass
      // every water check ever written against the first number alone.
      waterNodes: chunks.waterNodes,
      waterTriangles: chunks.waterTriangles,
      waterDrawCalls: this.waterDrawCalls,
      // Phase 3b, mirroring the pair above: what was carved and resident, and
      // what actually reached the rasteriser.
      riverNodes: chunks.riverNodes,
      riverVertices: chunks.riverVertices,
      riverDrawCalls: this.riverDrawCalls,
      // Phase 4a, mirroring the pair above for exactly the same reason.
      roadNodes: chunks.roadNodes,
      roadVertices: chunks.roadVertices,
      roadDrawCalls: this.roadDrawCalls,
      // Phase 4b, the Sector tier, mirroring the trio above once more.
      streetNodes: chunks.streetNodes,
      streetVertices: chunks.streetVertices,
      streetDrawCalls: this.streetDrawCalls,
      // Phase 5. `deckNodes` is deck geometry that is resident, `deckDrawCalls`
      // what reached the rasteriser, and `bridgeVertices` how much of it is
      // standing clear of the ground -- the last being the only evidence that a
      // road crossing a river became a bridge rather than stopping at the bank.
      deckNodes: chunks.deckNodes,
      deckTriangles: chunks.deckTriangles,
      bridgeVertices: chunks.bridgeVertices,
      bridgeNodes: chunks.bridgeNodes,
      deckDrawCalls: this.deckDrawCalls,
      // Phase 6, and the same trio once more. `buildings` is what is resident,
      // `buildingDrawCalls` what reached the rasteriser, and `buildingsLevel`
      // the only one that says the houses are standing on ground a village
      // levelled rather than merely standing somewhere.
      buildingNodes: chunks.buildingNodes,
      buildings: chunks.buildings,
      buildingsMeasured: chunks.buildingsMeasured,
      buildingsLevel: chunks.buildingsLevel,
      buildingTriangles: chunks.buildingTriangles,
      buildingsSeen: chunks.buildingsSeen,
      buildingDrawCalls: this.buildingDrawCalls,
      // Phase 7a. Same trio once more: residency, rasteriser, seating.
      propNodes: chunks.propNodes,
      props: chunks.props,
      propsMeasured: chunks.propsMeasured,
      propsSeated: chunks.propsSeated,
      propTriangles: chunks.propTriangles,
      propsSeen: chunks.propsSeen,
      propDrawCalls: this.propDrawCalls,
      workers: chunks.workers,
      // Phase 2b. The quadtree's whole job is bounding these two.
      selectedNodes: chunks.selected,
      rootLod: chunks.rootLod,
      viewDistance: chunks.viewDistance,
      cameraX: camera.x,
      cameraY: camera.y,
      cameraZ: camera.z,
      cameraPitch: this.rig.look.pitch,
      settled: chunks.settled,
    };
  }

  /** Selected nodes per quadtree level, index = lod. For the soak's report. */
  lodCounts(): number[] {
    return this.streamer.stats().lodCounts;
  }

  /**
   * Aim the camera, in degrees. The soak uses this to fly one leg near the
   * horizon: draw calls and triangle counts measured from a near-nadir view are
   * a measurement of frustum culling, not of the world.
   */
  setLook(yaw: number, pitch: number): void {
    this.rig.setLook(yaw, pitch);
  }

  /** Start a fresh worst-frame window, so warm-up hitches do not skew a soak run. */
  resetFrameStats(): void {
    this.frameTimer.resetPeak();
  }

  /** True when every chunk in range is resident. `window.__worldReady` waits on this too. */
  worldSettled(): boolean {
    return this.streamer.settled;
  }

  /**
   * Colours of the chunks in a square around a world position, as actually
   * resident. `null` where the chunk is not loaded. The soak test compares the
   * result before and after a round trip.
   */
  sampleChunkColors(worldX: number, worldZ: number, radius: number): (readonly number[] | null)[] {
    return this.streamer.sampleColors(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Hashes of the position buffers of the chunks in a square around a world
   * position, as actually resident. `null` where the chunk is not loaded.
   *
   * The soak test compares this before and after a round trip. Byte-identical
   * geometry after an unload and a regeneration is the strongest statement of
   * RULE 2 available without shipping the buffers out of the page.
   */
  sampleChunkGeometry(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleGeometryHashes(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Water triangles in the chunks around a world position, as actually
   * resident. `null` where the chunk is not loaded.
   *
   * The soak asserts this is non-zero somewhere in the round-tripped square, so
   * that "geometry came back byte-identical" is a statement about the sea and
   * not only about the ground under it.
   */
  sampleChunkWater(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleWaterTriangles(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * River-carved vertices in the chunks around a world position, as actually
   * resident. `null` where the chunk is not loaded.
   *
   * The soak asserts this is non-zero somewhere in the round-tripped square, so
   * that "geometry came back byte-identical" is a statement about the river as
   * well as about the ground and the sea.
   */
  sampleChunkRivers(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleRiverVertices(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Road-surfaced vertices in the chunks around a world position, as actually
   * resident. `null` where the chunk is not loaded.
   *
   * The Phase 4a counterpart of `sampleChunkRivers`, and needed for the same
   * reason: grading and surfacing move and recolour vertices the geometry hash
   * already covers, but only if the round-tripped square had a road in it.
   */
  sampleChunkRoads(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleRoadVertices(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Street-surfaced vertices in the chunks around a world position, as actually
   * resident. `null` where the chunk is not loaded.
   *
   * The Phase 4b counterpart, and the narrowest of the four: the round-tripped
   * square has to be inside a village, not merely near a road.
   */
  sampleChunkStreets(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleStreetVertices(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Deck triangles in the chunks around a world position, as actually resident.
   * `null` where the chunk is not loaded.
   *
   * The Phase 5 counterpart, and the water one rather than the road one: the
   * geometry hash now folds `deckPositions` in, so this is what says the
   * round-tripped square had a carriageway in it at all.
   */
  sampleChunkDecks(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleDeckTriangles(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Buildings in the chunks around a world position, as actually resident.
   * `null` where the chunk is not loaded.
   *
   * The Phase 6 counterpart, and the narrowest yet: the round-tripped square has
   * to contain a building, not merely be inside a village.
   */
  sampleChunkBuildings(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleBuildings(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /**
   * Props in the chunks around a world position, as actually resident.
   * `null` where the chunk is not loaded.
   *
   * The Phase 7a counterpart: the round-tripped square has to contain vegetation,
   * not merely pass over bare ground whose empty prop buffers hash identically.
   */
  sampleChunkProps(worldX: number, worldZ: number, radius: number): (number | null)[] {
    return this.streamer.sampleProps(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /** Ground height at a world position, from the main thread. For debugging parity. */
  groundHeight(worldX: number, worldZ: number): number {
    return sampleHeight(worldX, worldZ, this.params.seedHash);
  }

  private renderFrame(wallDt: number): void {
    this.rig.update(wallDt);
    // THE FLIGHT DOES NOT START UNTIL THE WORLD IS READY, and that is a Phase 4b
    // correctness fix rather than a tidy-up. The autopilot used to advance from
    // the first rendered frame, so it was already moving while the world
    // streamed in -- on this container that is 8-20 seconds at 45 m/s, i.e. the
    // soak's flight began anywhere from 400 m to 900 m downrange of `?pos=`, by
    // an amount that depends on how loaded the machine is.
    //
    // Everything the soak says "at the start" is a claim about the chunks around
    // wherever the camera had drifted to, so choosing a start that crosses a
    // river, a road and a village was not reproducible: Phase 4b's chosen start
    // measured street 10/25 in the square it names and 0/25 in the square the
    // run actually sampled, 760 m away. Holding the flight until
    // `__worldReady` makes the origin exactly `?pos=`, on every machine.
    if (
      this.autopilot.active &&
      window.__worldReady === true &&
      window.__flightReleased !== false
    ) {
      const p = this.rig.position;
      this.rig.setPosition(this.autopilot.advance(wallDt, p.x), p.y, p.z);
    }
    this.streamer.update(this.rig.camera.position);
    this.frameTimer.sample(wallDt);
    resetWaterDraws();
    resetRiverDraws();
    resetRoadDraws();
    resetStreetDraws();
    resetDeckDraws();
    resetBuildingDraws();
    resetPropDraws();
    this.renderer.render(this.scene, this.rig.camera);
    this.waterDrawCalls = waterDrawsSinceReset();
    this.riverDrawCalls = riverDrawsSinceReset();
    this.roadDrawCalls = roadDrawsSinceReset();
    this.streetDrawCalls = streetDrawsSinceReset();
    this.deckDrawCalls = deckDrawsSinceReset();
    this.buildingDrawCalls = buildingDrawsSinceReset();
    this.propDrawCalls = propDrawsSinceReset();
    this.hud.update(wallDt);

    this.renderedFrames++;
    // Readiness now also waits for the world around the camera to be fully
    // streamed. Without that, a screenshot could catch a half-loaded world and
    // the byte-comparison harness would go flaky the moment Phase 1 landed.
    if (
      window.__worldReady !== true &&
      this.renderedFrames >= READY_FRAME_COUNT &&
      this.streamer.settled
    ) {
      window.__worldReady = true;
    }
  }

  /**
   * Placeholder lighting. Phase 10 replaces this entirely with a physical sky
   * and cascaded shadow maps; nothing should be built on top of it.
   */
  private addLighting(): void {
    const hemisphere = new THREE.HemisphereLight(0x9fc4e8, 0x2a2620, 1.1);
    const sun = new THREE.DirectionalLight(0xffe9c4, 2.2);
    sun.position.set(4, 6, 3);
    this.scene.add(hemisphere, sun);
  }

  private registerHudLines(): void {
    const hud = this.hud;

    hud.register('fps', () => this.frameTimer.stats.fps, HudOrder.frame);
    hud.register(
      'frame ms',
      () => {
        const { avgMs, maxMs, spikes } = this.frameTimer.stats;
        return `${avgMs.toFixed(1)} avg / ${maxMs.toFixed(1)} max / ${spikes} spikes`;
      },
      HudOrder.frame,
    );

    hud.register('draw calls', () => this.renderer.stats().drawCalls, HudOrder.render);
    hud.register('triangles', () => formatCount(this.renderer.stats().triangles), HudOrder.render);
    hud.register('programs', () => this.renderer.stats().programs, HudOrder.render);
    hud.register('water draws', () => this.waterDrawCalls, HudOrder.render);
    hud.register('river draws', () => this.riverDrawCalls, HudOrder.render);
    hud.register('road draws', () => this.roadDrawCalls, HudOrder.render);
    hud.register('street draws', () => this.streetDrawCalls, HudOrder.render);
    hud.register('deck draws', () => this.deckDrawCalls, HudOrder.render);
    hud.register('building draws', () => this.buildingDrawCalls, HudOrder.render);
    hud.register('prop draws', () => this.propDrawCalls, HudOrder.render);

    hud.register(
      'js heap',
      () => {
        const mb = readHeapMb();
        return mb === null ? 'n/a' : `${mb.toFixed(1)} MB`;
      },
      HudOrder.memory,
    );

    // Phase 1 owns these two. Registering by the same label replaces the
    // provider, so the streamer supplies real values without editing this file.
    hud.register('chunks', () => 0, HudOrder.world);
    hud.register('worker queue', () => 0, HudOrder.workers);

    hud.register(
      'sim',
      () => `tick ${this.loop.tick} / t ${this.loop.simTime.toFixed(2)}s${this.loop.paused ? ' (paused)' : ''}`,
      HudOrder.world,
    );

    hud.register('seed', () => `${this.params.seed} (${this.params.seedHash})`, HudOrder.misc);
    hud.register(
      'camera',
      () => {
        const p = this.rig.position;
        return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
      },
      HudOrder.misc,
    );
    hud.register('backend', () => this.renderer.backend, HudOrder.misc);
  }

  private buildPanel(): void {
    const sim = this.panel.folder('Simulation');
    sim.addToggle(
      'paused',
      () => this.loop.paused,
      (value) => (value ? this.loop.pause() : this.loop.resume()),
    );
    sim.addButton('step 1 tick', () => this.loop.step(1));
    sim.addButton('step 60 ticks', () => this.loop.step(60));

    const render = this.panel.folder('Render');
    render.addToggle(
      'wireframe',
      () => this.renderer.wireframeEnabled,
      (value) => this.renderer.setWireframe(value),
    );
    render.addToggle(
      'hud',
      () => this.hud.visible,
      (value) => this.hud.setVisible(value),
    );

    const share = this.panel.folder('Share');
    share.addButton('copy link to this view', () => {
      const url = this.currentUrl();
      void navigator.clipboard?.writeText(url);
      console.info(url);
    });
    share.addButton('log HUD text', () => console.info(this.hudText()));
  }

  private readonly onResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.resize(width, height, window.devicePixelRatio);
    this.rig.setAspect(width / Math.max(height, 1));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.code) {
      case 'Space':
        event.preventDefault();
        this.loop.togglePaused();
        break;
      case 'Period':
        this.loop.step(1);
        break;
      case 'KeyF':
        this.renderer.setWireframe(!this.renderer.wireframeEnabled);
        break;
      case 'KeyH':
        this.hud.setVisible(!this.hud.visible);
        break;
      default:
        break;
    }
  };
}
