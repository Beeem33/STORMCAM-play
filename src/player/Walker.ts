import * as THREE from 'three';
import { heightAt } from '../environment/WorldShape';
import type { Collider2D } from '../environment/Colliders';
import { clamp, damp } from '../utils/MathUtils';

/**
 * The chaser on foot: walks/runs on the terrain, gets shoved by strong wind,
 * and can be knocked down — or killed — inside a tornado's core.
 */
export class Walker {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly eye = new THREE.Vector3();
  bob = 0;
  /** Camera height above the feet (set from the body model's chest camera). */
  camHeight = 1.48;
  moving = 0;
  /** 0..1 how hard the wind is pushing. */
  strain = 0;
  /** Seconds standing still (tripod shots). */
  stillTime = 0;
  dead = false;
  colliders: (x: number, z: number, r: number) => Iterable<Collider2D> = () => [];
  /** Extra obstacle (the vehicle) as an oriented box. */
  car: { x: number; z: number; rot: number; hx: number; hz: number } | null = null;

  placeAt(x: number, z: number): void {
    this.pos.set(x, heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    this.stillTime = 0;
  }

  update(dt: number, move: { fwd: number; right: number; run: boolean }, yaw: number, wind: THREE.Vector3): void {
    if (this.dead) return;
    const speed = move.run ? 4.2 : 1.6;
    const sx = Math.sin(yaw), cz = Math.cos(yaw);
    // Camera yaw 0 looks toward -Z.
    const wx = (-sx * move.fwd + cz * move.right) * speed;
    const wz = (-cz * move.fwd - sx * move.right) * speed;
    const len = Math.hypot(move.fwd, move.right);
    const tx = len > 1 ? wx / len : wx;
    const tz = len > 1 ? wz / len : wz;
    this.vel.x = damp(this.vel.x, tx, 8, dt);
    this.vel.z = damp(this.vel.z, tz, 8, dt);

    // Wind: above ~25 m/s it starts to push you around.
    const w = Math.hypot(wind.x, wind.z);
    this.strain = clamp((w - 22) / 40, 0, 1);
    if (w > 22) {
      const push = (w - 22) * 0.12;
      this.vel.x += (wind.x / w) * push * dt * 6;
      this.vel.z += (wind.z / w) * push * dt * 6;
    }
    if (w > 56 || wind.y > 26) this.dead = true;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.resolve();
    const g = heightAt(this.pos.x, this.pos.z);
    this.pos.y = damp(this.pos.y, g, 20, dt);

    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.moving = clamp(sp / 1.6, 0, 1.5);
    this.bob += dt * sp * 4.2;
    this.stillTime = sp < 0.15 ? this.stillTime + dt : 0;
    // Chest-mounted camera height; drops as he crouches into the wind.
    this.eye.set(this.pos.x, this.pos.y + this.camHeight - this.strain * 0.25, this.pos.z);
  }

  private resolve(): void {
    const r = 0.35;
    for (const c of this.colliders(this.pos.x, this.pos.z, r)) {
      if (c.type === 'circle') {
        const dx = this.pos.x - c.x, dz = this.pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const pen = r + c.r - d;
        if (pen > 0 && d > 1e-4) {
          this.pos.x += (dx / d) * pen;
          this.pos.z += (dz / d) * pen;
        }
      } else this.pushBox(c.x, c.z, c.rot, c.hx, c.hz, r);
    }
    if (this.car) this.pushBox(this.car.x, this.car.z, this.car.rot, this.car.hx, this.car.hz, r);
  }

  private pushBox(x: number, z: number, rot: number, hx: number, hz: number, r: number): void {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const lx = (this.pos.x - x) * cs - (this.pos.z - z) * sn;
    const lz = (this.pos.x - x) * sn + (this.pos.z - z) * cs;
    const qx = clamp(lx, -hx, hx), qz = clamp(lz, -hz, hz);
    let dx = lx - qx, dz = lz - qz;
    let d = Math.hypot(dx, dz);
    let pen: number;
    if (d < 1e-4) {
      const ex = hx - Math.abs(lx), ez = hz - Math.abs(lz);
      if (ex < ez) { dx = Math.sign(lx) || 1; dz = 0; pen = ex + r; }
      else { dx = 0; dz = Math.sign(lz) || 1; pen = ez + r; }
      d = 1;
    } else {
      pen = r - d;
      if (pen <= 0) return;
    }
    const nx = (dx / d) * cs + (dz / d) * sn;
    const nz = -(dx / d) * sn + (dz / d) * cs;
    this.pos.x += nx * pen;
    this.pos.z += nz * pen;
  }
}
