/**
 * Thin wrapper around the WebGL2 renderer.
 *
 * This is the ONLY module in the project permitted to construct or touch
 * `THREE.WebGLRenderer`. Everything else -- the app, the HUD, subsystems --
 * talks to the surface below. That boundary is what makes a later WebGPU swap a
 * change to one file rather than a rewrite, and it is also where per-frame
 * render statistics are captured for the perf HUD.
 */

import * as THREE from 'three';

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
}

const EMPTY_STATS: RenderStats = {
  drawCalls: 0,
  triangles: 0,
  programs: 0,
  geometries: 0,
  textures: 0,
};

export interface RendererOptions {
  antialias: boolean;
  /** Upper bound on device pixel ratio, so 3x phones do not melt. */
  maxPixelRatio: number;
}

const DEFAULT_OPTIONS: RendererOptions = {
  antialias: true,
  maxPixelRatio: 2,
};

export class Renderer {
  private readonly gl: THREE.WebGLRenderer;
  private readonly maxPixelRatio: number;

  private lastStats: RenderStats = { ...EMPTY_STATS };
  private wireframe = false;
  private materialsDirty = true;

  constructor(canvas: HTMLCanvasElement, options: Partial<RendererOptions> = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.maxPixelRatio = opts.maxPixelRatio;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: opts.antialias,
      // Deterministic screenshots need a buffer we can read back reliably.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.gl.setClearColor(0x0d1218, 1);
  }

  /** Which backend is live. Reported in the HUD so a WebGPU swap is visible. */
  get backend(): string {
    return 'webgl2';
  }

  /** Underlying canvas, for sizing against its client box. */
  get domElement(): HTMLCanvasElement {
    return this.gl.domElement as HTMLCanvasElement;
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    this.gl.setPixelRatio(Math.min(devicePixelRatio, this.maxPixelRatio));
    this.gl.setSize(width, height, false);
  }

  /**
   * Toggle wireframe across the scene. Applied lazily on the next render so
   * toggling is free when nothing changed.
   */
  setWireframe(enabled: boolean): void {
    if (this.wireframe === enabled) return;
    this.wireframe = enabled;
    this.materialsDirty = true;
  }

  get wireframeEnabled(): boolean {
    return this.wireframe;
  }

  /**
   * Tell the renderer that new objects entered the scene, so wireframe state is
   * re-applied on the next frame. Subsystems that add meshes at runtime (chunk
   * streaming, from Phase 1 on) must call this.
   */
  invalidateMaterials(): void {
    this.materialsDirty = true;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.materialsDirty) {
      applyWireframe(scene, this.wireframe);
      this.materialsDirty = false;
    }

    // `info.render` is reset at the start of each render, so it must be read
    // immediately after -- hence caching it here rather than in `stats()`.
    this.gl.render(scene, camera);

    const info = this.gl.info;
    this.lastStats = {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  /** Statistics from the most recent `render()` call. */
  stats(): RenderStats {
    return this.lastStats;
  }

  dispose(): void {
    this.gl.dispose();
  }
}

function applyWireframe(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>;
    if (mesh.material === undefined) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if ('wireframe' in material) {
        (material as THREE.MeshStandardMaterial).wireframe = enabled;
      }
    }
  });
}
