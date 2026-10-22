import * as THREE from 'three';
import type { Tornado } from './Tornado';
import { heightAt } from '../environment/WorldShape';
import { patchMaterial } from '../rendering/Atmosphere';

/**
 * Debris: a pool of small instanced fragments (boards, shingles, sheet metal,
 * clods) that the vortex lifts, orbits and flings, plus larger "thrown
 * bodies" — real meshes torn off buildings by the destruction system.
 * Everything is integrated against the tornado's wind field with a drag
 * coefficient per piece, so light pieces follow the flow and heavy ones lag.
 */

const COUNT = 4000;
const MAX_BODIES = 160;

interface Body {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  drag: number;
  life: number;
  grounded: boolean;
}

const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

export class DebrisSystem {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly vel = new Float32Array(COUNT * 3);
  private readonly rot = new Float32Array(COUNT * 3);
  private readonly spin = new Float32Array(COUNT * 3);
  private readonly size = new Float32Array(COUNT);
  private readonly drag = new Float32Array(COUNT);
  private readonly alive = new Uint8Array(COUNT);
  private readonly tint = new Float32Array(COUNT * 3);
  private readonly bodies: Body[] = [];
  private spawnAcc = 0;
  /** Called when a fragment passes close to `hitTarget`: strength 0..1. */
  onHit: ((strength: number, pos: THREE.Vector3) => void) | null = null;
  hitTarget: THREE.Vector3 | null = null;
  /** Number of fragments currently airborne (for scoring). */
  airborne = 0;

  constructor() {
    const geo = new THREE.BoxGeometry(1, 0.12, 0.55);
    const mat = new THREE.MeshStandardMaterial({ color: '#2d2822', roughness: 0.9 });
    patchMaterial(mat);
    this.mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const palette = [[0.22, 0.19, 0.16], [0.36, 0.33, 0.3], [0.16, 0.13, 0.1], [0.45, 0.43, 0.4], [0.3, 0.12, 0.09]];
    for (let i = 0; i < COUNT; i++) {
      const c = palette[i % palette.length];
      this.tint.set(c, i * 3);
      // Mostly boards, shingles and clods, with plenty of sheets of roofing and siding.
      this.size[i] = 0.35 + Math.random() ** 2.2 * 3.2;
      this.drag[i] = 1.6 / (0.4 + this.size[i]);
    }
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  /** Hand a mesh (already in world space) to the wind. */
  throwObject(obj: THREE.Object3D, vel: THREE.Vector3, mass = 1): void {
    // Keep the number of big flying objects bounded: the oldest settle out of the scene.
    if (this.bodies.length >= MAX_BODIES) {
      const old = this.bodies.shift()!;
      old.obj.removeFromParent();
    }
    this.group.attach(obj);
    this.bodies.push({
      obj,
      vel: vel.clone(),
      angVel: new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4),
      drag: 0.9 / Math.max(0.3, mass),
      life: 25 + Math.random() * 10,
      grounded: false,
    });
  }

  update(dt: number, tornado: Tornado | null): void {
    const t = tornado && tornado.alive ? tornado : null;
    // Spawn fragments at the base while the vortex has a debris cloud.
    if (t && t.debris > 0.05) {
      this.spawnAcc += dt * 480 * t.debris * Math.max(0.6, t.params.debrisDensity) * (0.5 + t.params.rating * 0.25);
      let i = 0;
      while (this.spawnAcc >= 1 && i < COUNT) {
        if (!this.alive[i]) {
          this.spawnAcc -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = t.radius * (0.4 + Math.random() * 1.6);
          const x = t.position.x + Math.cos(a) * r;
          const z = t.position.z + Math.sin(a) * r;
          this.pos[i * 3] = x;
          this.pos[i * 3 + 1] = heightAt(x, z) + 0.5;
          this.pos[i * 3 + 2] = z;
          // Ripped off the ground already moving with the flow, and kicked upward.
          t.windAt(_s.set(x, this.pos[i * 3 + 1], z), _w);
          this.vel[i * 3] = _w.x * 0.6;
          this.vel[i * 3 + 1] = 6 + Math.random() * 18;
          this.vel[i * 3 + 2] = _w.z * 0.6;
          for (let k = 0; k < 3; k++) {
            this.rot[i * 3 + k] = Math.random() * 6.28;
            this.spin[i * 3 + k] = (Math.random() - 0.5) * 12;
          }
          this.alive[i] = 1;
        }
        i++;
      }
      if (this.spawnAcc > 50) this.spawnAcc = 50;
    }

    const p = new THREE.Vector3();
    let n = 0;
    let air = 0;
    for (let i = 0; i < COUNT; i++) {
      if (!this.alive[i]) continue;
      p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      if (t) t.windAt(p, _w);
      else _w.set(0, 0, 0);
      const k = Math.min(1, this.drag[i] * dt);
      const vx = this.vel[i * 3] + (_w.x - this.vel[i * 3]) * k;
      const vy = this.vel[i * 3 + 1] + (_w.y * 0.85 - this.vel[i * 3 + 1]) * k - 9.81 * dt;
      const vz = this.vel[i * 3 + 2] + (_w.z - this.vel[i * 3 + 2]) * k;
      this.vel[i * 3] = vx;
      this.vel[i * 3 + 1] = vy;
      this.vel[i * 3 + 2] = vz;
      p.x += vx * dt;
      p.y += vy * dt;
      p.z += vz * dt;
      const g = heightAt(p.x, p.z);
      const tooHigh = p.y - g > 450 + this.size[i] * -120;
      if (p.y < g - 0.2 || (tooHigh && Math.random() < dt * 0.5) || (!t && Math.random() < dt * 0.05)) {
        this.alive[i] = 0;
        continue;
      }
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      for (let k2 = 0; k2 < 3; k2++) this.rot[i * 3 + k2] += this.spin[i * 3 + k2] * dt;
      if (p.y - g > 3) air++;
      if (this.hitTarget && Math.abs(p.x - this.hitTarget.x) < 2.6 && Math.abs(p.z - this.hitTarget.z) < 2.6 && Math.abs(p.y - this.hitTarget.y) < 1.8) {
        const sp = Math.hypot(vx, vy, vz);
        if (sp > 12) {
          this.onHit?.(Math.min(1, (sp / 70) * (0.3 + this.size[i] * 0.4)), p.clone());
          this.alive[i] = 0;
          continue;
        }
      }
      _q.setFromEuler(_e.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2]));
      const s = this.size[i];
      _s.set(s, s, s);
      _m.compose(p, _q, _s);
      this.mesh.setMatrixAt(n, _m);
      (this.mesh.instanceColor!.array as Float32Array).set(this.tint.subarray(i * 3, i * 3 + 3), n * 3);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.airborne = air;

    // Thrown bodies.
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      b.life -= dt;
      const o = b.obj;
      if (!b.grounded) {
        if (t) t.windAt(o.position, _w);
        else _w.set(0, 0, 0);
        const k = Math.min(1, b.drag * dt);
        b.vel.x += (_w.x - b.vel.x) * k;
        b.vel.y += (_w.y * 0.7 - b.vel.y) * k - 9.81 * dt;
        b.vel.z += (_w.z - b.vel.z) * k;
        o.position.addScaledVector(b.vel, dt);
        o.rotation.x += b.angVel.x * dt;
        o.rotation.y += b.angVel.y * dt;
        o.rotation.z += b.angVel.z * dt;
        const g = heightAt(o.position.x, o.position.z);
        if (o.position.y < g + 0.2) {
          o.position.y = g + 0.2;
          if (b.vel.length() < 8) b.grounded = true;
          b.vel.multiplyScalar(0.3);
          b.vel.y = Math.abs(b.vel.y) * 0.3;
        }
        if (this.hitTarget && o.position.distanceTo(this.hitTarget) < 3.2 && b.vel.length() > 10) {
          this.onHit?.(Math.min(1, b.vel.length() / 40), o.position.clone());
          b.vel.multiplyScalar(-0.3);
        }
      }
      if (b.life <= 0) {
        this.group.remove(o);
        this.bodies.splice(i, 1);
      }
    }
  }

  get bodyCount(): number {
    return this.bodies.length;
  }

  clear(): void {
    this.alive.fill(0);
    for (const b of this.bodies) this.group.remove(b.obj);
    this.bodies.length = 0;
    this.mesh.count = 0;
  }
}
