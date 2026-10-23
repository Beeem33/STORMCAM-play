import * as THREE from 'three';
import { clamp, damp } from '../utils/MathUtils';
import { heightAt, normalAt, surfaceAt, type SurfaceKind } from '../environment/WorldShape';
import { CG_HEIGHT, WHEEL_POS, WHEEL_RADIUS } from './VehicleModel';
import type { Collider2D } from '../environment/Colliders';

export interface DriveInput {
  throttle: number; // 0..1 (W)
  brake: number; // 0..1 (S)
  steer: number; // -1 left .. 1 right
  handbrake: boolean;
}

interface Wheel {
  /** Suspension hardpoint in body space. */
  hard: THREE.Vector3;
  steered: boolean;
  driveShare: number;
  rear: boolean;
  length: number;
  prevCompression: number;
  contact: boolean;
  load: number;
  spinAngle: number;
  spinVel: number;
  slip: number;
  surface: SurfaceKind;
  /** Position of the wheel centre in body space (for visuals). */
  center: THREE.Vector3;
}

/** Surface friction (dry, fully wet). */
const MU: Record<SurfaceKind, [number, number]> = {
  asphalt: [1.0, 0.72],
  gravel: [0.68, 0.55],
  grass: [0.55, 0.38],
  mud: [0.42, 0.3],
};
/** Rolling-resistance coefficient (fraction of wheel load). Chase trucks run aired-down M/T tyres. */
const ROLL_RES: Record<SurfaceKind, number> = { asphalt: 0.013, gravel: 0.022, grass: 0.045, mud: 0.07 };
/** Surface roughness → suspension excitation amplitude (m). */
const ROUGH: Record<SurfaceKind, number> = { asphalt: 0.002, gravel: 0.01, grass: 0.014, mud: 0.018 };

const GEARS = [3.06, 1.63, 1.0, 0.7];
const REVERSE = 2.29;
const FINAL = 3.73;
const IDLE = 750;
const REDLINE = 5600;

function torqueAt(rpm: number): number {
  // Tuned 6.2 L V8 (a built chase truck), N·m.
  const pts: [number, number][] = [[600, 325], [1000, 430], [2000, 535], [3000, 580], [4000, 590], [5000, 535], [5600, 470], [6200, 260]];
  if (rpm <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (rpm <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (rpm - x0)) / (x1 - x0);
    }
  }
  return 0;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _n = { x: 0, y: 1, z: 0 };
const _m3 = new THREE.Matrix3();
const _q = new THREE.Quaternion();

export class Vehicle {
  readonly mass = 2350;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly angVel = new THREE.Vector3();
  private readonly invInertiaLocal: THREE.Vector3;
  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();

  readonly wheels: Wheel[];
  steerAngle = 0;
  steerInput = 0;
  gear = 1; // -1 reverse, 1..4
  rpm = IDLE;
  throttle = 0;
  private shiftTimer = 0;
  engineOn = true;

  /** External wind at the car (m/s, world), set by the weather/tornado systems. */
  readonly wind = new THREE.Vector3();
  wetness = 0;
  /** Grip multiplier off pavement (all-terrain tyres upgrade). */
  offroadGrip = 1;
  /** Damage multiplier (armor upgrade). */
  damageScale = 1;

  health = 100;
  destroyed = false;
  /** 0..1 how much the windshield is cracked. */
  windshieldCracks = 0;
  /** Seconds the car has been upside down / on its side. */
  private flippedTime = 0;
  airborne = 0;

  /** Smoothed body acceleration (world) — drives head motion. */
  readonly accel = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  /** Vertical jolt events for camera shake, decays. */
  jolt = 0;
  bumpiness = 0;
  tireSlip = 0;
  surface: SurfaceKind = 'asphalt';
  /** Callbacks for impacts (strength m/s). */
  /** Hard contact: speed (m/s), what kind, and where on the truck (its own frame, from the CG). */
  onImpact: ((strength: number, kind: 'collision' | 'ground', local: THREE.Vector3) => void) | null = null;

  colliders: (x: number, z: number, r: number) => Iterable<Collider2D> = () => [];

  constructor() {
    const Ixx = (this.mass / 12) * (1.6 * 1.6 + 5 * 5);
    const Iyy = (this.mass / 12) * (2 * 2 + 5 * 5);
    const Izz = (this.mass / 12) * (2 * 2 + 1.6 * 1.6);
    this.invInertiaLocal = new THREE.Vector3(1 / Ixx, 1 / Iyy, 1 / (Izz * 1.4));
    this.wheels = WHEEL_POS.map((p, i) => ({
      hard: new THREE.Vector3(p.x, p.y - CG_HEIGHT + 0.36, p.z),
      steered: i < 2,
      driveShare: i < 2 ? 0.2 : 0.3,
      rear: i >= 2,
      length: 0.36,
      prevCompression: 0.1,
      contact: false,
      load: 0,
      spinAngle: 0,
      spinVel: 0,
      slip: 0,
      surface: 'asphalt' as SurfaceKind,
      center: p.clone().setY(p.y - CG_HEIGHT),
    }));
  }

  get speed(): number {
    return this.vel.length();
  }

  /** Signed speed along the vehicle's forward axis. */
  get forwardSpeed(): number {
    _v1.set(0, 0, -1).applyQuaternion(this.quat);
    return this.vel.dot(_v1);
  }

  get gearLabel(): string {
    if (this.gear < 0) return 'R';
    if (this.forwardSpeed < 0.3 && this.throttle < 0.05) return 'D';
    return 'D' + this.gear;
  }

  /** Place the car on the ground at (x, z) facing `heading` (radians, 0 = north/-Z). */
  placeAt(x: number, z: number, heading: number): void {
    this.pos.set(x, heightAt(x, z) + CG_HEIGHT + 0.02, z);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.gear = 1;
    this.flippedTime = 0;
    this.destroyed = false;
    for (const w of this.wheels) {
      w.prevCompression = 0.1;
      w.length = 0.36;
    }
  }

  get heading(): number {
    _v1.set(0, 0, -1).applyQuaternion(this.quat);
    return Math.atan2(_v1.x, -_v1.z);
  }

  update(dt: number, input: DriveInput): void {
    const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / sub;
    this.prevVel.copy(this.vel);
    this.updateDriver(dt, input);
    let slipAcc = 0;
    let bumpAcc = 0;
    for (let i = 0; i < sub; i++) {
      const r = this.step(h, input);
      slipAcc += r.slip;
      bumpAcc += r.bump;
    }
    this.tireSlip = damp(this.tireSlip, slipAcc / sub, 10, dt);
    this.bumpiness = damp(this.bumpiness, Math.min(1, (bumpAcc / sub) * 2.5), 8, dt);
    _v1.copy(this.vel).sub(this.prevVel).divideScalar(Math.max(dt, 1e-4));
    this.accel.lerp(_v1, 1 - Math.exp(-8 * dt));
    this.jolt = Math.max(0, this.jolt - dt * 3);

    // Wheel visuals.
    for (const w of this.wheels) {
      w.spinAngle += w.spinVel * dt;
      w.center.set(w.hard.x, w.hard.y - w.length, w.hard.z);
    }

    // On its side or roof and settled: rock it back onto its wheels (a chase
    // crew would winch or push it over) rather than ending the day.
    _v1.set(0, 1, 0).applyQuaternion(this.quat);
    this.landCooldown -= dt;
    this.hitCooldown -= dt;
    if (_v1.y < 0.35 && this.vel.length() < 5) this.flippedTime += dt;
    else this.flippedTime = Math.max(0, this.flippedTime - dt * 2);
    if (this.flippedTime > 3) {
      this.placeAt(this.pos.x, this.pos.z, this.heading);
      this.damage(8);
      this.onRighted?.();
    }
    // Sustained violent wind strips trim and breaks glass.
    const windRel = Math.hypot(this.wind.x - this.vel.x, this.wind.z - this.vel.z);
    if (windRel > 55) {
      this.damage((windRel - 55) * 0.1 * dt);
    }
    // At 0% the truck is wrecked but still limps along on reduced power.
    if (this.health <= 0) this.destroyed = true;
  }

  private updateDriver(dt: number, input: DriveInput): void {
    // Steering: rate-limited, speed-sensitive lock, self-centering.
    const target = input.steer;
    const rate = Math.abs(target) > Math.abs(this.steerInput) ? 2.6 : 4.5;
    this.steerInput += clamp(target - this.steerInput, -rate * dt, rate * dt);
    const v = Math.abs(this.forwardSpeed);
    const maxA = 0.6 / (1 + v / 11);
    this.steerAngle = this.steerInput * maxA;

    // Gear logic (automatic with reverse on S at standstill).
    const fwd = this.forwardSpeed;
    if (this.gear > 0 && input.brake > 0.1 && input.throttle < 0.1 && fwd < 0.6) this.gear = -1;
    else if (this.gear < 0 && input.throttle > 0.1 && fwd > -0.6) this.gear = 1;

    // Engine speed from the driven wheels, with a torque-converter floor.
    let wheelRpm = 0;
    for (const w of this.wheels) wheelRpm += Math.abs(w.spinVel);
    wheelRpm = ((wheelRpm / 4) * 60) / (2 * Math.PI);
    const pedal = this.gear < 0 ? input.brake : input.throttle;
    this.throttle = this.engineOn ? pedal : 0;
    const ratio = this.gear < 0 ? REVERSE : GEARS[this.gear - 1];
    const coupled = wheelRpm * ratio * FINAL;
    const stall = IDLE + this.throttle * 1500;
    const targetRpm = Math.max(coupled, this.gear === 1 || this.gear < 0 ? stall * (1 - Math.min(1, coupled / 2600)) + coupled * Math.min(1, coupled / 2600) : IDLE, IDLE);
    this.rpm = damp(this.rpm, Math.min(targetRpm, REDLINE + 200), 9, dt);

    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.gear > 0 && this.shiftTimer <= 0) {
      const up = 4100 + this.throttle * 1100;
      const down = 1200 + this.throttle * 1000;
      // Never drop into a gear that would immediately want to shift up again (gear hunting cuts drive).
      const lowerRpm = this.gear > 1 ? coupled * (GEARS[this.gear - 2] / GEARS[this.gear - 1]) : Infinity;
      if (this.rpm > up && this.gear < GEARS.length) {
        this.gear++;
        this.shiftTimer = 0.3;
      } else if (this.rpm < down && this.gear > 1 && coupled < down && lowerRpm < up - 500) {
        this.gear--;
        this.shiftTimer = 0.35;
      }
    }
  }

  private step(h: number, input: DriveInput): { slip: number; bump: number } {
    const q = this.quat;
    const up = _v2.set(0, 1, 0).applyQuaternion(q).clone();
    const fwd = _v3.set(0, 0, -1).applyQuaternion(q).clone();
    this.force.set(0, -9.81 * this.mass, 0);
    this.torque.set(0, 0, 0);

    const fwdSpeed = this.vel.dot(fwd);
    const ratio = this.gear < 0 ? REVERSE : GEARS[Math.max(0, this.gear - 1)];
    const shifting = this.shiftTimer > 0 && this.gear > 0;
    const driveTorque = this.engineOn && !shifting ? torqueAt(this.rpm) * this.throttle * ratio * FINAL * 0.82 * (this.rpm > REDLINE ? 0.2 : 1) * (this.destroyed ? 0.7 : 1) : 0;
    const driveDir = this.gear < 0 ? -1 : 1;
    const braking = this.gear < 0 ? input.throttle : input.brake;

    let slipSum = 0;
    let bump = 0;
    let anyContact = false;
    const rough = ROUGH[this.surface];

    for (const w of this.wheels) {
      // Hardpoint in world.
      const H = _v1.copy(w.hard).applyQuaternion(q).add(this.pos);
      // Ray along -up to the ground (two refinement iterations on the height field).
      let d = 0.5;
      for (let it = 0; it < 3; it++) {
        const px = H.x - up.x * d;
        const pz = H.z - up.z * d;
        const g = heightAt(px, pz);
        d = (H.y - g) / Math.max(up.y, 0.2);
      }
      const restMax = 0.5;
      // Road texture: tiny height noise excites the suspension on rough surfaces.
      const surfNoise = rough * (Math.sin(H.x * 3.1 + H.z * 2.3) * Math.sin(H.z * 4.7 - H.x * 1.3));
      let len = d - WHEEL_RADIUS + surfNoise;
      if (len > restMax || up.y < 0.2) {
        w.contact = false;
        w.length = Math.min(restMax, w.length + h * 2);
        w.load = 0;
        w.prevCompression = 0;
        w.spinVel *= 0.995;
        continue;
      }
      anyContact = true;
      let bumpStop = 0;
      const minLen = 0.14;
      if (len < minLen) {
        bumpStop = minLen - len;
        len = minLen;
      }
      w.length = len;
      const comp = restMax - len;
      const compVel = (comp - w.prevCompression) / h;
      w.prevCompression = comp;
      const k = 52000;
      const c = compVel > 0 ? 4200 : 6200;
      let Fs = k * comp * 0.86 + c * compVel + bumpStop * 900000;
      if (bumpStop > 0.01) this.jolt = Math.min(1, this.jolt + bumpStop * 0.8);
      Fs = Math.max(0, Fs);
      w.load = Fs;
      bump += Math.abs(compVel) * 0.15;

      // Contact frame.
      const cx = H.x - up.x * (len + WHEEL_RADIUS);
      const cz = H.z - up.z * (len + WHEEL_RADIUS);
      const cy = H.y - up.y * (len + WHEEL_RADIUS);
      normalAt(cx, cz, _n);
      const n = _v4.set(_n.x, _n.y, _n.z);
      const surf = surfaceAt(cx, cz, this.wetness);
      w.surface = surf;
      const wf = fwd.clone();
      if (w.steered) wf.applyAxisAngle(up, -this.steerAngle);
      const f = wf.sub(n.clone().multiplyScalar(n.dot(wf))).normalize();
      const s = new THREE.Vector3().crossVectors(f, n).normalize();
      const rArm = new THREE.Vector3(cx - this.pos.x, cy - this.pos.y, cz - this.pos.z);
      const vc = new THREE.Vector3().crossVectors(this.angVel, rArm).add(this.vel);
      const vLong = vc.dot(f);
      const vLat = vc.dot(s);

      const [muDry, muWet] = MU[surf];
      const mu = (muDry + (muWet - muDry) * this.wetness) * (surf === 'asphalt' ? 1 : this.offroadGrip);
      const Fz = Fs;

      // Longitudinal.
      let Fx = (driveTorque * w.driveShare * driveDir) / WHEEL_RADIUS;
      const brakeMax = 7200 * braking * (w.rear ? 0.8 : 1.2);
      const hand = input.handbrake && w.rear;
      if (brakeMax > 0 || hand) {
        const bm = hand ? mu * Fz * 1.1 : brakeMax;
        Fx -= Math.sign(vLong) * Math.min(bm, Math.abs(vLong) * 9000);
      }
      // Parking hold.
      if (w.rear && this.throttle < 0.02 && braking < 0.02 && Math.abs(vLong) < 0.4) Fx -= vLong * 6000;
      // Rolling resistance: about constant with speed (Crr·Fz), rising gently at speed.
      Fx -= Math.sign(vLong) * ROLL_RES[surf] * Fz * (Math.min(1, Math.abs(vLong)) + Math.abs(vLong) * 0.004);

      // Lateral (simplified Pacejka).
      const alpha = Math.atan2(vLat, Math.max(Math.abs(vLong), 1.5));
      const latGrip = hand ? 0.45 : 1;
      let Fy = -mu * Fz * latGrip * Math.sin(1.45 * Math.atan(10 * alpha));

      // Friction circle.
      const lim = mu * Fz * 1.05;
      const tot = Math.hypot(Fx, Fy);
      let slip = Math.min(1, Math.abs(alpha) * 3 + (hand ? Math.min(1, Math.abs(vLong) / 8) : 0));
      if (tot > lim && tot > 1) {
        slip = Math.max(slip, Math.min(1, (tot - lim) / lim + 0.3));
        Fx *= lim / tot;
        Fy *= lim / tot;
      }
      w.slip = slip;
      slipSum += slip * Math.min(1, this.vel.length() / 4);

      // Wheel spin for visuals: rolling, locked under handbrake, spinning up under big throttle.
      w.spinVel = hand ? 0 : vLong / WHEEL_RADIUS;
      if (driveTorque > 0 && Math.abs(Fx) >= lim * 0.95) w.spinVel += driveDir * this.throttle * 6;

      const F = new THREE.Vector3()
        .addScaledVector(up, Fs)
        .addScaledVector(f, Fx)
        .addScaledVector(s, Fy);
      this.force.add(F);
      this.torque.add(new THREE.Vector3().crossVectors(rArm, F));
    }
    if (anyContact) this.airborne = 0;
    else this.airborne += h;
    this.surface = this.wheels[2].surface;

    // Aerodynamics against the (possibly violent) wind.
    const rel = new THREE.Vector3().subVectors(this.vel, this.wind);
    const inv = _q.copy(q).invert();
    const relL = rel.clone().applyQuaternion(inv);
    const rho = 1.2;
    // Cd·A per body axis: broadside ~8 m², roof ~9 m², frontal ~1.5 m².
    const dragL = new THREE.Vector3(
      -0.5 * rho * 8.0 * relL.x * Math.abs(relL.x),
      -0.5 * rho * 9.0 * relL.y * Math.abs(relL.y),
      -0.5 * rho * 1.5 * relL.z * Math.abs(relL.z),
    );
    // Body lift: air rushing over a boxy SUV (CL·A ≈ 0.35 × 10 m²), worst broadside.
    // Negligible at driving speed, decisive in a tornado.
    const cross = Math.abs(relL.x) / (Math.hypot(relL.x, relL.z) + 1e-3);
    const horiz2 = relL.x * relL.x + relL.z * relL.z;
    dragL.y += 0.5 * rho * (0.6 + 2.9 * cross) * horiz2 * (horiz2 > 400 ? 1 : horiz2 / 400);
    const drag = dragL.applyQuaternion(q);
    this.force.add(drag);
    // Centre of pressure above and slightly behind the CG: crosswind rolls and weathervanes the car.
    const cp = new THREE.Vector3(0, 0.35, 0.25).applyQuaternion(q);
    this.torque.add(new THREE.Vector3().crossVectors(cp, drag));

    // Body–ground contact (rollovers, landing on the roof or side).
    this.bodyGroundContacts(q, h);

    // Integrate.
    this.vel.addScaledVector(this.force, h / this.mass);
    const R = _m3.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    // I_world^-1 = R · I_local^-1 · Rᵀ
    const tl = this.torque.clone().applyMatrix3(R.clone().transpose());
    tl.multiply(this.invInertiaLocal);
    const angAcc = tl.applyMatrix3(R);
    this.angVel.addScaledVector(angAcc, h);
    this.angVel.multiplyScalar(1 - 0.4 * h);
    this.pos.addScaledVector(this.vel, h);
    const w = this.angVel;
    const dq = new THREE.Quaternion(w.x * h * 0.5, w.y * h * 0.5, w.z * h * 0.5, 0).multiply(q);
    q.set(q.x + dq.x, q.y + dq.y, q.z + dq.z, q.w + dq.w).normalize();

    this.resolveColliders();
    return { slip: slipSum / 4, bump };
  }

  private static readonly BODY_POINTS = [
    [-0.95, -0.42, -2.45], [0.95, -0.42, -2.45], [-0.95, -0.42, 2.45], [0.95, -0.42, 2.45],
    [-0.95, 1.1, -0.4], [0.95, 1.1, -0.4], [-0.95, 1.1, 2.3], [0.95, 1.1, 2.3],
    [-1.0, 0.3, 0], [1.0, 0.3, 0],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));

  private bodyGroundContacts(q: THREE.Quaternion, h: number): void {
    void h;
    let hit = 0;
    let hitPoint: THREE.Vector3 | null = null;
    for (const lp of Vehicle.BODY_POINTS) {
      const p = _v1.copy(lp).applyQuaternion(q).add(this.pos);
      const g = heightAt(p.x, p.z);
      const pen = g - p.y;
      if (pen <= 0) continue;
      const rArm = new THREE.Vector3().subVectors(p, this.pos);
      const vc = new THREE.Vector3().crossVectors(this.angVel, rArm).add(this.vel);
      const Fn = Math.max(0, pen * 400000 - vc.y * 30000);
      const Ft = new THREE.Vector3(-vc.x, 0, -vc.z);
      const tl = Ft.length();
      if (tl > 0) Ft.multiplyScalar(Math.min(Fn * 0.6, tl * 8000) / tl);
      const F = new THREE.Vector3(Ft.x, Fn, Ft.z);
      this.force.add(F);
      this.torque.add(new THREE.Vector3().crossVectors(rArm, F));
      if (-vc.y > hit) {
        hit = -vc.y;
        hitPoint = lp;
      }
    }
    // One landing is one impact: take the hardest point once, not every point every sub-step.
    if (hit > 6 && this.landCooldown <= 0) {
      this.damage((hit - 6) * 2.5);
      this.onImpact?.(hit, 'ground', hitPoint ?? new THREE.Vector3(0, -0.4, 0));
      this.jolt = 1;
      this.landCooldown = 0.6;
    }
  }
  private landCooldown = 0;
  private hitCooldown = 0;

  private resolveColliders(): void {
    const fwd = _v1.set(0, 0, -1).applyQuaternion(this.quat);
    for (const off of [-1.6, 0, 1.6]) {
      const cx = this.pos.x - fwd.x * off;
      const cz = this.pos.z - fwd.z * off;
      const r = 1.05;
      for (const c of this.colliders(cx, cz, r)) {
        let nx = 0, nz = 0, depth = 0;
        if (c.type === 'circle') {
          const dx = cx - c.x, dz = cz - c.z;
          const d = Math.hypot(dx, dz);
          depth = r + c.r - d;
          if (depth <= 0) continue;
          nx = dx / (d || 1);
          nz = dz / (d || 1);
        } else {
          // Oriented box.
          const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
          const lx = (cx - c.x) * cs - (cz - c.z) * sn;
          const lz = (cx - c.x) * sn + (cz - c.z) * cs;
          const qx = clamp(lx, -c.hx, c.hx);
          const qz = clamp(lz, -c.hz, c.hz);
          let dx = lx - qx, dz = lz - qz;
          let d = Math.hypot(dx, dz);
          if (d < 1e-4) {
            // Centre inside the box: push out along the shallowest axis.
            const ex = c.hx - Math.abs(lx), ez = c.hz - Math.abs(lz);
            if (ex < ez) { dx = Math.sign(lx); dz = 0; depth = ex + r; }
            else { dx = 0; dz = Math.sign(lz); depth = ez + r; }
            d = 1;
          } else {
            depth = r - d;
            if (depth <= 0) continue;
          }
          const ndx = dx / d, ndz = dz / d;
          nx = ndx * cs + ndz * sn;
          nz = -ndx * sn + ndz * cs;
        }
        if (c.yMax !== undefined && this.pos.y - CG_HEIGHT > c.yMax) continue;
        this.pos.x += nx * depth;
        this.pos.z += nz * depth;
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          const e = 0.15;
          this.vel.x -= (1 + e) * vn * nx;
          this.vel.z -= (1 + e) * vn * nz;
          // Scrub some tangential speed and add a yaw kick.
          this.vel.x *= 0.92;
          this.vel.z *= 0.92;
          this.angVel.y += vn * 0.04 * Math.sign(off || 1) * (nx * fwd.z - nz * fwd.x);
          const impact = -vn;
          if (impact > 2 && this.hitCooldown <= 0) {
            this.damage(impact > 8 ? (impact - 6) * 2.5 : 0);
            // Where it struck: the side of the body facing the obstacle, at bumper height.
            const at = new THREE.Vector3(cx - nx * r * 0.95, this.pos.y - 0.1, cz - nz * r * 0.95).sub(this.pos).applyQuaternion(_q.copy(this.quat).invert());
            this.onImpact?.(impact, 'collision', at);
            this.jolt = Math.min(1, this.jolt + impact * 0.08);
            this.hitCooldown = 0.4;
          }
          c.onHit?.(impact);
        }
      }
    }
  }

  /** Sudden velocity change (tornado gusts, big debris). */
  applyImpulse(dv: THREE.Vector3, dw: THREE.Vector3): void {
    this.vel.add(dv);
    this.angVel.add(dw);
    this.jolt = 1;
  }

  /** Called after a rolled truck has been put back on its wheels. */
  onRighted: (() => void) | null = null;

  damage(amount: number): void {
    if (amount <= 0 || this.destroyed) return;
    this.health = Math.max(0, this.health - amount * this.damageScale);
  }

  /** Body-to-world transform of the vehicle origin (CG). */
  writeTransform(obj: THREE.Object3D): void {
    obj.position.copy(this.pos);
    obj.quaternion.copy(this.quat);
  }
}
