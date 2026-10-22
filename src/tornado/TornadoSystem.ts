import * as THREE from 'three';
import { Tornado, type TornadoParams } from './Tornado';
import { TornadoRenderer } from './TornadoRenderer';
import { DebrisSystem } from './Debris';
import type { StormCell } from '../weather/StormModel';

/**
 * Owns the active tornado (the prototype supports one at a time), its volume
 * renderer and debris, and answers "what is the wind here?" for everything
 * else.
 */
export class TornadoSystem {
  tornado: Tornado | null = null;
  readonly renderer = new TornadoRenderer();
  readonly debris = new DebrisSystem();
  readonly group = new THREE.Group();
  onEnded: ((storm: StormCell) => void) | null = null;
  onSpawn: ((t: Tornado) => void) | null = null;

  constructor() {
    this.group.add(this.renderer.mesh, this.debris.group);
  }

  spawn(storm: StormCell, params: Partial<TornadoParams> = {}): Tornado {
    this.tornado = new Tornado(storm, params);
    this.onSpawn?.(this.tornado);
    return this.tornado;
  }

  update(dt: number, baseAlt: number): void {
    const t = this.tornado;
    if (t) {
      t.update(dt, baseAlt);
      if (!t.alive) {
        this.onEnded?.(t.storm);
        this.tornado = null;
      }
    }
    this.debris.update(dt, this.tornado);
  }

  windAt(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!this.tornado) return out.set(0, 0, 0);
    return this.tornado.windAt(p, out);
  }

  clear(): void {
    this.tornado = null;
    this.debris.clear();
    this.renderer.mesh.visible = false;
  }
}
