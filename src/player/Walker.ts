import * as THREE from 'three';
import { heightAt } from '../environment/WorldShape';
import type { Collider2D } from '../environment/Colliders';
import { clamp, damp, smoothstep } from '../utils/MathUtils';

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
  /** Picked up by the vortex: carried and thrown until it kills him. */
  caught = false;
  caughtTime = 0;
  /** Camera tumble while caught (rad), and how fast it's spinning. */
  readonly tumble = new THREE.Euler();
  private readonly spin = new THREE.Vector3();
  private airTime = 0;
  /** The vortex he's caught in (centre and core radius), so it can keep him in orbit. */
  vortex: { x: number; z: number; r: number } | null = null;
  /** Steady the tumble (the camera settles to look ahead), e.g. for the last moment. */
  steady = false;
  colliders: (x: number, z: number, r: number) => Iterable<Collider2D> = () => [];
  /** Extra obstacle (the vehicle) as an oriented box. */
  car: { x: number; z: number; rot: number; hx: number; hz: number } | null = null;

  placeAt(x: number, z: number): void {
    this.pos.set(x, heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    this.caught = false;
    this.caughtTime = 0;
    this.tumble.set(0, 0, 0);
    this.stillTime = 0;
  }

  /** Torn loose by the vortex at `vel` (m/s): from here the wind has him. */
  liftOff(vel: THREE.Vector3): void {
    if (vel !== this.vel) this.vel.copy(vel);
    this.caught = true;
    this.caughtTime = 0;
    this.airTime = 0;
    this.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6);
    this.tumble.set(0, 0, 0);
  }

  /** In the vortex: the wind carries him; gravity and the ground do the rest. */
  private updateCaught(dt: number, wind: THREE.Vector3): void {
    this.caughtTime += dt;
    // The vortex takes him over several seconds, not in an instant: at first
    // he's dragged and tumbled along low down, then lifted and drawn in.
    const ramp = smoothstep(0, 7, this.caughtTime);
    const feel = 0.45 + 0.55 * ramp;
    const k = Math.min(1, dt * (0.6 + ramp));
    this.vel.x += (wind.x * feel - this.vel.x) * k;
    this.vel.y += (wind.y * 0.9 * feel - this.vel.y) * k - 9.81 * dt;
    this.vel.z += (wind.z * feel - this.vel.z) * k;
    // The vortex keeps him: drawn toward a wandering orbit around the core,
    // swung up and down between ~15 and ~100 m.
    if (this.vortex) {
      const dx = this.pos.x - this.vortex.x, dz = this.pos.z - this.vortex.z;
      const d = Math.hypot(dx, dz) || 1;
      const want = this.vortex.r * 0.7 + 12 + 30 * Math.sin(this.caughtTime * 0.23);
      const pull = clamp((want - d) * 1.4, -9, 9) * ramp * dt;
      this.vel.x += (dx / d) * pull;
      this.vel.z += (dz / d) * pull;
      const g0 = heightAt(this.pos.x, this.pos.z);
      const targetH = g0 + ramp * (52 + 35 * Math.sin(this.caughtTime * 0.37) + 12 * Math.sin(this.caughtTime * 1.1));
      this.vel.y += clamp((targetH - this.pos.y) * 0.9, -12, 12) * dt;
    }
    // Gusts inside the core fling him about.
    this.vel.x += (Math.random() - 0.5) * 48 * dt;
    this.vel.y += (Math.random() - 0.4) * 30 * dt;
    this.vel.z += (Math.random() - 0.5) * 48 * dt;
    this.pos.addScaledVector(this.vel, dt);
    // Buildings, trees and the truck: below roof height he bounces off them instead of passing through.
    if (this.pos.y - heightAt(this.pos.x, this.pos.z) < 10) {
      const bx = this.pos.x, bz = this.pos.z;
      this.resolve();
      const dx = this.pos.x - bx, dz = this.pos.z - bz;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        const nx = dx / d, nz = dz / d;
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          this.vel.x -= 1.5 * vn * nx;
          this.vel.z -= 1.5 * vn * nz;
          this.vel.multiplyScalar(0.7);
        }
      }
    }
    const g = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < g) {
      const hit = -this.vel.y;
      this.pos.y = g;
      this.vel.y = Math.abs(this.vel.y) * 0.3;
      this.vel.x *= 0.5;
      this.vel.z *= 0.5;
      this.airTime = 0;
    } else this.airTime += dt;
    // Tumbling: the spin keeps changing as he's thrown around.
    this.spin.x += (Math.random() - 0.5) * 16 * dt;
    this.spin.y += (Math.random() - 0.5) * 12 * dt;
    this.spin.z += (Math.random() - 0.5) * 16 * dt;
    this.spin.clampLength(0, 3.5);
    if (this.steady) {
      this.spin.multiplyScalar(Math.max(0, 1 - dt * 6));
      this.tumble.x *= Math.max(0, 1 - dt * 5);
      this.tumble.z *= Math.max(0, 1 - dt * 5);
    }
    this.tumble.x += this.spin.x * dt;
    this.tumble.y += this.spin.y * dt;
    this.tumble.z += this.spin.z * dt;
    this.strain = 1;
    this.moving = 0;
    this.eye.set(this.pos.x, this.pos.y + 1.2, this.pos.z);
  }

  /**
   * @param coreRatio distance to the funnel in core radii (Infinity with no tornado):
   *   strong wind shoves him about anywhere, but only the vortex itself lifts him.
   */
  update(dt: number, move: { fwd: number; right: number; run: boolean }, yaw: number, wind: THREE.Vector3, coreRatio = Infinity): void {
    if (this.dead) return;
    if (this.caught) {
      this.updateCaught(dt, wind);
      return;
    }
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
    if (((w > 50 || wind.y > 22) && coreRatio < 1.3) || w > 75) {
      // Lifted off his feet.
      this.liftOff(this.vel.set(wind.x * 0.4, 6, wind.z * 0.4));
      return;
    }

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
