import * as THREE from 'three';
import { cityPlanAt, isCity } from './city';
import { sampleHeight, worldRegionField } from './height-field';
import { buildInteriorSurface } from './interior-mesh';

const ENTER_DISTANCE = 26;

/** Main-thread, near-player adapter for pure landmark interior buffers. */
export class InteriorOverlay {
  readonly root = new THREE.Group();
  private readonly roads;
  private readonly entered = new Set<string>();
  private activeKey = '';

  constructor(private readonly worldSeed: number) {
    this.roads = worldRegionField(worldSeed).roads;
    this.root.name = 'landmark interiors';
  }

  get interiorsEntered(): number {
    return this.entered.size;
  }

  update(x: number, z: number, enabled: boolean): void {
    if (!enabled) {
      this.clear();
      return;
    }
    const net = this.roads.networkAt(x, z);
    let best = ENTER_DISTANCE * ENTER_DISTANCE;
    let selected:
      | { key: string; kind: number; x: number; z: number; halfW: number; halfD: number }
      | undefined;
    for (const site of net.settlements) {
      if (!isCity(site)) continue;
      const plan = cityPlanAt(site, this.worldSeed);
      if (plan === undefined) continue;
      for (let i = 0; i < plan.landmarkCount; i++) {
        const lx = plan.landmarkX[i] as number;
        const lz = plan.landmarkZ[i] as number;
        const dx = x - lx;
        const dz = z - lz;
        const distance = dx * dx + dz * dz;
        if (distance >= best) continue;
        best = distance;
        selected = {
          key: `${site.cellX},${site.cellZ}:${i}`,
          kind: plan.landmarkKind[i] as number,
          x: lx,
          z: lz,
          halfW: plan.landmarkHalfW[i] as number,
          halfD: plan.landmarkHalfD[i] as number,
        };
      }
    }
    if (selected === undefined) {
      this.clear();
      return;
    }
    this.entered.add(selected.key);
    if (selected.key === this.activeKey) return;
    this.clear();
    const surface = buildInteriorSurface(selected.kind, selected.halfW, selected.halfD);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(selected.x, sampleHeight(selected.x, selected.z, this.worldSeed), selected.z);
    mesh.name = `interior ${selected.key}`;
    this.root.add(mesh);
    this.activeKey = selected.key;
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }

  private clear(): void {
    for (const child of [...this.root.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.root.remove(mesh);
    }
    this.activeKey = '';
  }
}
