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
import { sampleHeight } from './world/height-field';

declare global {
  interface Window {
    /**
     * Set once the first frames have actually been rendered. The screenshot
     * harness waits on this instead of sleeping, so captures can never race the
     * first frame.
     */
    __worldReady?: boolean;
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
      workers: chunks.workers,
      cameraX: camera.x,
      cameraZ: camera.z,
      settled: chunks.settled,
    };
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
    return this.streamer.samplePositionHashes(ChunkStreamer.coordsAround(worldX, worldZ, radius));
  }

  /** Ground height at a world position, from the main thread. For debugging parity. */
  groundHeight(worldX: number, worldZ: number): number {
    return sampleHeight(worldX, worldZ, this.params.seedHash);
  }

  private renderFrame(wallDt: number): void {
    this.rig.update(wallDt);
    if (this.autopilot.active) {
      const p = this.rig.position;
      this.rig.setPosition(this.autopilot.advance(wallDt, p.x), p.y, p.z);
    }
    this.streamer.update(this.rig.camera.position);
    this.frameTimer.sample(wallDt);
    this.renderer.render(this.scene, this.rig.camera);
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
