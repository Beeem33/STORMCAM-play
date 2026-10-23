import * as THREE from 'three';
import type { DebrisSystem } from '../tornado/Debris';

/**
 * Bolt-on parts that can be torn off the truck: doors, hood, mirrors, brush
 * guard, roof rack, bumpers, flares. Each has a little strength; hits near it
 * wear it down until it rips away and is handed to the debris system, which
 * flies it on the wind. Violent wind in the core can strip parts on its own.
 * Everything is bolted back on for the next day.
 */

const NAMES = [
  'Door_FL', 'Door_FR', 'Door_RL', 'Door_RR',
  'Hood', 'BrushGuard', 'RoofRack', 'Mirror_L', 'Mirror_R', 'Mirrors',
  'Bumper_F', 'Bumper_R', 'FenderFlare_FL', 'FenderFlare_FR', 'FenderFlare_RL', 'FenderFlare_RR', 'Anemometer',
];
/** How hard each kind of part is to rip off (1 = average). */
const TOUGH: Record<string, number> = { Door_FL: 1.8, Door_FR: 1.8, Door_RL: 1.8, Door_RR: 1.8, Hood: 1.8, BrushGuard: 2.4, RoofRack: 1.4, Bumper_F: 2.2, Bumper_R: 2.2, FenderFlare_FL: 1.1, FenderFlare_FR: 1.1, FenderFlare_RL: 1.1, FenderFlare_RR: 1.1, Mirrors: 0.6, Mirror_L: 0.5, Mirror_R: 0.5, Anemometer: 0.5 };

interface Part {
  name: string;
  obj: THREE.Object3D;
  parent: THREE.Object3D;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  /** Centre of the part in the truck's frame (from the CG). */
  center: THREE.Vector3;
  mass: number;
  hp: number;
  gone: boolean;
}

const _b = new THREE.Box3();
const _v = new THREE.Vector3();

export class BreakableParts {
  private readonly parts: Part[] = [];
  onBreak: ((name: string) => void) | null = null;

  /** @param root the truck model; @param truck the object at the truck's CG */
  constructor(root: THREE.Object3D, truck: THREE.Object3D, private readonly debris: DebrisSystem) {
    truck.updateMatrixWorld(true);
    const inv = truck.matrixWorld.clone().invert();
    for (const name of NAMES) {
      const obj = root.getObjectByName(name);
      if (!obj || !obj.parent) continue;
      _b.setFromObject(obj);
      if (_b.isEmpty()) continue;
      const size = _b.getSize(new THREE.Vector3());
      this.parts.push({
        name,
        obj,
        parent: obj.parent,
        pos: obj.position.clone(),
        quat: obj.quaternion.clone(),
        scale: obj.scale.clone(),
        center: _b.getCenter(new THREE.Vector3()).applyMatrix4(inv),
        mass: Math.max(0.5, size.x * size.y * size.z * 8),
        hp: TOUGH[name] ?? 1,
        gone: false,
      });
    }
  }

  get names(): string[] {
    return this.parts.map((p) => p.name);
  }

  /**
   * Something struck the truck at `local` (truck frame) with 0..1 severity.
   * Parts within reach take the hit; any that give way fly off with `vel` (world).
   */
  hit(local: THREE.Vector3, severity: number, vel: THREE.Vector3): void {
    for (const p of this.parts) {
      if (p.gone) continue;
      const d = p.center.distanceTo(local);
      if (d > 1.6) continue;
      p.hp -= severity * (1.0 - d * 0.5);
      if (p.hp <= 0) this.tear(p, vel);
    }
  }

  /** Violent wind across the truck: random parts tear loose. */
  wind(dt: number, windRel: number, truckVel: THREE.Vector3, wind: THREE.Vector3): void {
    if (windRel < 62) return;
    const rate = (windRel - 62) * 0.0012;
    for (const p of this.parts) {
      if (p.gone || Math.random() > dt * rate / (TOUGH[p.name] ?? 1)) continue;
      this.tear(p, _v.copy(truckVel).lerp(wind, 0.4));
    }
  }

  private tear(p: Part, vel: THREE.Vector3): void {
    p.gone = true;
    p.obj.updateMatrixWorld(true);
    const v = vel.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 3 + Math.random() * 5, (Math.random() - 0.5) * 6));
    this.debris.throwObject(p.obj, v, p.mass);
    this.onBreak?.(p.name);
    // The anemometer is mounted on the rack.
    if (p.name === 'RoofRack') {
      const a = this.parts.find((q) => q.name === 'Anemometer' && !q.gone);
      if (a) this.tear(a, vel);
    }
  }

  /** New day: everything bolted back on. */
  reset(): void {
    for (const p of this.parts) {
      if (!p.gone) continue;
      p.obj.removeFromParent();
      p.parent.add(p.obj);
      p.obj.position.copy(p.pos);
      p.obj.quaternion.copy(p.quat);
      p.obj.scale.copy(p.scale);
      p.obj.visible = true;
      p.gone = false;
    }
    for (const p of this.parts) p.hp = TOUGH[p.name] ?? 1;
  }
}
