import * as THREE from 'three';
import { heightAt } from '../environment/WorldShape';
import type { VehicleParts } from '../vehicle/VehicleModel';
import type { TornadoSystem } from '../tornado/TornadoSystem';

/**
 * In-situ "turtle" probes: four instrument pods in the back of the truck.
 * The chaser opens the liftgate, carries a probe out and sets it down in the
 * tornado's path. Each probe logs the closest approach and peak wind; one the
 * core passes over gets lifted into the vortex, which is the prized
 * intercept. The data is sold at the end of the day.
 */

const OPEN_ANGLE = -1.4; // rad about the top hinge (negative swings up and out)
const REACH_GATE = 1.7; // m from RearEntry
const REACH_PROBE = 1.4; // m to pick a placed probe back up
const PLACE_AHEAD = 0.7; // m in front of the feet
export const PROBE_COST = 250; // replacing one the tornado took

export interface DeployedProbe {
  id: number;
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  /** Closest horizontal distance to the tornado's edge (m), and its centre distance then. */
  minEdge: number;
  minDist: number;
  peakWind: number;
  rating: number;
  lofted: boolean;
}

export interface ProbeReport {
  lines: string[];
  value: number;
  lost: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class ProbeSystem {
  readonly group = new THREE.Group();
  readonly deployed: DeployedProbe[] = [];
  carrying = false;
  private gateTarget = 0;
  private gateAngle = 0;
  private held: THREE.Object3D | null = null;
  private nextId = 1;
  private ledMat: THREE.MeshStandardMaterial | null = null;
  private blink = 0;
  onEvent: ((text: string, kind: 'money' | 'info') => void) | null = null;

  constructor(private readonly parts: VehicleParts, private readonly tornadoes: TornadoSystem) {
    this.group.name = 'probes';
    // Deployed probes get their own LED material so they can blink.
    const src = parts.cargo?.probes[0];
    src?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).name === 'ProbeLED') {
        this.ledMat = (m.material as THREE.MeshStandardMaterial).clone();
      }
    });
  }

  get available(): boolean {
    return !!this.parts.cargo && this.parts.cargo.probes.length > 0;
  }

  /** Probes still in the tote. */
  get inTruck(): number {
    return this.parts.cargo?.probes.filter((p) => p.visible).length ?? 0;
  }

  get gateOpen(): boolean {
    return this.gateTarget !== 0;
  }

  reset(): void {
    for (const d of this.deployed) d.obj.removeFromParent();
    this.deployed.length = 0;
    this.dropHeld();
    this.carrying = false;
    this.gateTarget = 0;
    this.gateAngle = 0;
    this.nextId = 1;
    for (const p of this.parts.cargo?.probes ?? []) p.visible = true;
    this.applyGate();
  }

  closeGate(): void {
    this.gateTarget = 0;
  }

  private rearEntryWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.parts.cargo!.rearEntry.getWorldPosition(out);
  }

  /** What E would do right now, for the on-screen prompt. Empty when nothing. */
  prompt(feet: THREE.Vector3): string {
    const a = this.action(feet);
    if (!a) return '';
    return {
      open: 'E  OPEN LIFTGATE',
      take: `E  TAKE PROBE  (${this.inTruck} LEFT)`,
      stow: 'E  PUT PROBE BACK',
      close: 'E  CLOSE LIFTGATE',
      place: 'E  SET PROBE DOWN',
      pickup: 'E  PICK UP PROBE',
    }[a];
  }

  private action(feet: THREE.Vector3): 'open' | 'take' | 'stow' | 'close' | 'place' | 'pickup' | null {
    if (!this.available) return null;
    const atGate = this.rearEntryWorld(_v).setY(feet.y).distanceTo(feet) < REACH_GATE;
    if (atGate) {
      if (!this.gateOpen) return 'open';
      if (this.carrying) return 'stow';
      if (this.inTruck > 0) return 'take';
      return 'close';
    }
    if (this.carrying) return 'place';
    if (this.nearest(feet)) return 'pickup';
    return null;
  }

  private nearest(feet: THREE.Vector3): DeployedProbe | null {
    let best: DeployedProbe | null = null;
    let bd = REACH_PROBE;
    for (const d of this.deployed) {
      if (d.lofted) continue;
      const dist = Math.hypot(d.pos.x - feet.x, d.pos.z - feet.z);
      if (dist < bd) {
        bd = dist;
        best = d;
      }
    }
    return best;
  }

  /**
   * Press E. Returns true if the probe system used the key.
   * @param place called to play the set-down animation; it calls back at touchdown.
   */
  interact(feet: THREE.Vector3, yaw: number, carryPoint: THREE.Object3D, place: (touchdown: () => void) => void): boolean {
    const a = this.action(feet);
    if (!a) return false;
    const cargo = this.parts.cargo!;
    switch (a) {
      case 'open':
        this.gateTarget = OPEN_ANGLE;
        break;
      case 'close':
        this.gateTarget = 0;
        break;
      case 'take': {
        const src = cargo.probes.find((p) => p.visible)!;
        src.visible = false;
        this.hold(src, carryPoint);
        break;
      }
      case 'stow': {
        const slot = cargo.probes.find((p) => !p.visible);
        if (slot) slot.visible = true;
        this.dropHeld();
        this.carrying = false;
        break;
      }
      case 'place': {
        const x = feet.x - Math.sin(yaw) * PLACE_AHEAD;
        const z = feet.z - Math.cos(yaw) * PLACE_AHEAD;
        this.carrying = false;
        place(() => {
          this.dropHeld();
          this.deploy(x, z, yaw);
        });
        break;
      }
      case 'pickup': {
        const d = this.nearest(feet)!;
        d.obj.removeFromParent();
        this.deployed.splice(this.deployed.indexOf(d), 1);
        this.hold(cargo.probes[0], carryPoint);
        break;
      }
    }
    return true;
  }

  /** Getting back in the truck with a probe in hand puts it back in the tote. */
  stowOnEntry(): void {
    if (!this.carrying) return;
    const slot = this.parts.cargo?.probes.find((p) => !p.visible);
    if (slot) slot.visible = true;
    this.dropHeld();
    this.carrying = false;
  }

  private hold(src: THREE.Object3D, carryPoint: THREE.Object3D): void {
    const h = this.cloneProbe(src);
    // On the hand's CarryPoint, or in front of the belly when the body has no carry pose.
    if (carryPoint.name === 'CarryPoint') h.position.set(0, 0, 0);
    else h.position.set(0, 0.92, -0.4);
    carryPoint.add(h);
    this.held = h;
    this.carrying = true;
  }

  private dropHeld(): void {
    this.held?.removeFromParent();
    this.held = null;
  }

  private cloneProbe(src: THREE.Object3D): THREE.Object3D {
    const c = src.clone(true);
    c.visible = true;
    c.position.set(0, 0, 0);
    c.quaternion.identity();
    c.traverse((o) => {
      o.visible = true;
      const m = o as THREE.Mesh;
      if (m.isMesh) m.frustumCulled = false;
    });
    return c;
  }

  private deploy(x: number, z: number, yaw: number): void {
    const src = this.parts.cargo!.probes[0];
    const obj = this.cloneProbe(src);
    const y = heightAt(x, z);
    obj.position.set(x, y, z);
    obj.rotation.set(0, yaw, 0);
    if (this.ledMat) {
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && (m.material as THREE.Material).name === 'ProbeLED') m.material = this.ledMat!;
      });
    }
    this.group.add(obj);
    this.deployed.push({ id: this.nextId++, obj, pos: new THREE.Vector3(x, y, z), minEdge: Infinity, minDist: Infinity, peakWind: 0, rating: 0, lofted: false });
    this.onEvent?.(`Probe ${this.nextId - 1} set · logging`, 'info');
  }

  update(dt: number): void {
    // Liftgate swings on its hinge.
    if (this.parts.cargo) {
      const k = 1 - Math.exp(-dt * 3.2);
      this.gateAngle += (this.gateTarget - this.gateAngle) * k;
      this.applyGate();
    }
    // LEDs blink while logging.
    this.blink += dt;
    if (this.ledMat) this.ledMat.emissiveIntensity = (this.blink % 1.2) < 0.15 ? 6 : 0.6;

    const t = this.tornadoes.tornado;
    if (!t || t.presence < 0.4) return;
    for (const d of this.deployed) {
      if (d.lofted) continue;
      const dist = Math.hypot(d.pos.x - t.position.x, d.pos.z - t.position.z);
      const edge = Math.max(0, dist - t.radius);
      if (edge < d.minEdge) {
        d.minEdge = edge;
        d.minDist = dist;
        d.rating = t.params.rating;
      }
      this.tornadoes.windAt(_v.copy(d.pos).setY(d.pos.y + 0.5), _w);
      const wind = _w.length();
      d.peakWind = Math.max(d.peakWind, wind);
      // The core passes over: the probe is torn off the ground and lofted.
      if (dist < t.radius * 0.95 && wind > 38) {
        d.lofted = true;
        d.obj.updateMatrixWorld(true);
        this.tornadoes.debris.throwObject(d.obj, _w.clone().multiplyScalar(0.35).add(new THREE.Vector3(0, 10, 0)), 6);
        this.onEvent?.(`Probe ${d.id} intercepted · ${Math.round(d.peakWind * 2.237)} mph`, 'money');
      }
    }
  }

  private applyGate(): void {
    const c = this.parts.cargo;
    if (!c) return;
    c.liftgate.quaternion.copy(c.liftgateBase).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.gateAngle));
  }

  /** What the day's probe data sells for. */
  report(): ProbeReport {
    const lines: string[] = [];
    let value = 0;
    let lostCount = 0;
    for (const d of this.deployed) {
      if (d.lofted) lostCount++;
      if (!Number.isFinite(d.minEdge)) {
        lines.push(`Probe ${d.id} · no tornado came near`);
        continue;
      }
      // Quality: an intercept is perfect; otherwise it falls off over ~500 m from the vortex edge.
      const q = d.lofted ? 1 : Math.max(0, Math.min(0.75, 1 - d.minEdge / 500));
      const v = q < 0.05 ? 0 : Math.round(((400 + 3600 * q ** 1.5) * (1 + 0.15 * Math.max(0, d.rating - 1))) / 10) * 10;
      value += v;
      const mph = Math.round(d.peakWind * 2.237);
      lines.push(
        d.lofted
          ? `Probe ${d.id} · intercepted, lofted into the vortex · peak ${mph} mph · $${v.toLocaleString('en-US')}`
          : `Probe ${d.id} · closest ${Math.round(d.minDist)} m from the centre · peak ${mph} mph · $${v.toLocaleString('en-US')}`,
      );
    }
    if (!this.deployed.length) lines.push('No probes deployed. Grab them from the back of the truck (E at the liftgate).');
    return { lines, value, lost: lostCount * PROBE_COST };
  }
}
