import * as THREE from 'three';
import type { LensProfile } from '../rendering/Renderer';
import { CG_HEIGHT, DASHCAM_POS, DRIVER_EYE } from '../vehicle/VehicleModel';
import type { Vehicle } from '../vehicle/Vehicle';
import { clamp, damp, wrapAngle } from '../utils/MathUtils';

export type CameraMode = 'driver' | 'dashcam' | 'bodycam';

/** Smooth pseudo-random signal from a few incommensurate sines. */
class Wobble {
  private readonly ph = Array.from({ length: 4 }, () => Math.random() * 100);
  constructor(private readonly freq: number) {}
  at(t: number): number {
    const f = this.freq;
    return (
      Math.sin(t * f * 1.0 + this.ph[0]) * 0.5 +
      Math.sin(t * f * 2.31 + this.ph[1]) * 0.27 +
      Math.sin(t * f * 4.67 + this.ph[2]) * 0.15 +
      Math.sin(t * f * 9.13 + this.ph[3]) * 0.08
    );
  }
}

export const LENSES: Record<CameraMode, LensProfile> = {
  driver: {
    barrel: 0.08, chroma: 0.004, noise: 1.0, sharpen: 0.35, vignette: 0.28,
    saturation: 0.9, contrast: 1.1, tint: new THREE.Color(1, 1, 1), ev: 0.82, shutter: 0.45,
  },
  dashcam: {
    barrel: 0.34, chroma: 0.014, noise: 1.6, sharpen: 0.6, vignette: 0.45,
    saturation: 0.84, contrast: 1.14, tint: new THREE.Color(0.985, 1.0, 0.97), ev: 0.8, shutter: 0.3,
  },
  // Chest-mounted body camera: very wide, fisheye-ish, crunchy sensor.
  bodycam: {
    barrel: 0.26, chroma: 0.012, noise: 1.35, sharpen: 0.55, vignette: 0.32,
    saturation: 0.86, contrast: 1.12, tint: new THREE.Color(0.99, 1.0, 0.985), ev: 0.8, shutter: 0.55,
  },
};

export interface RigContext {
  dt: number;
  time: number;
  vehicleObj: THREE.Object3D;
  vehicle: Vehicle;
  /** Walker eye position + body yaw when on foot. */
  walker: { eye: THREE.Vector3; bob: number; moving: number; animated: boolean } | null;
  mouseDX: number;
  mouseDY: number;
  wheel: number;
  zoomHeld: boolean;
  sensitivity: number;
  invertY: boolean;
  shake: number;
  fov: number;
  /** Wind speed at the camera (m/s) — buffets bodycam footage. */
  wind: number;
  /** Extra shake impulse 0..1 (thunder, debris hits). */
  impulse: number;
  /** Vertical field of view of the bodycam, degrees. */
  bodycamFov: number;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.04, 70000);
  mode: CameraMode = 'driver';
  yaw = 0;
  pitch = -0.04;
  zoom = 1;
  private readonly headOffset = new THREE.Vector3();
  private readonly roadShake = [new Wobble(23), new Wobble(19), new Wobble(29)];
  private readonly handShake = [new Wobble(0.9), new Wobble(1.1), new Wobble(0.7)];
  private readonly windShake = [new Wobble(5.5), new Wobble(6.8)];
  private rollSmooth = 0;
  /** Bodycam torso direction, chasing yaw/pitch through a spring. */
  private lookYaw = 0;
  private lookPitch = 0;
  private readonly lookVel = new THREE.Vector2();
  readonly lens: LensProfile = { ...LENSES.driver, tint: LENSES.driver.tint.clone() };
  /** Angular speed of the camera (rad/s) — used for footage stability scoring. */
  angularSpeed = 0;
  private readonly prevQuat = new THREE.Quaternion();

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === 'dashcam') {
      this.yaw = 0;
      this.pitch = 0;
    }
    if (mode === 'bodycam') {
      this.zoom = 1;
      this.lookYaw = this.yaw;
      this.lookPitch = this.pitch;
      this.lookVel.set(0, 0);
    }
    const l = LENSES[mode];
    Object.assign(this.lens, { ...l, tint: this.lens.tint.copy(l.tint) });
  }

  update(c: RigContext): void {
    const cam = this.camera;
    const sens = 0.0022 * c.sensitivity / Math.max(1, this.zoom * 0.8);
    if (this.mode !== 'dashcam') {
      this.yaw -= c.mouseDX * sens;
      this.pitch -= c.mouseDY * sens * (c.invertY ? -1 : 1);
    }

    if (this.mode === 'driver' || this.mode === 'dashcam') {
      const v = c.vehicle;
      const local = this.mode === 'driver' ? DRIVER_EYE : DASHCAM_POS;
      // Head inertia: the body lags behind the car's acceleration.
      _q.copy(v.quat).invert();
      const accL = _v.copy(v.accel).applyQuaternion(_q);
      const lag = this.mode === 'driver' ? 0.0055 : 0.0006;
      const target = new THREE.Vector3(clamp(-accL.x * lag, -0.06, 0.06), clamp(-(accL.y) * lag * 0.5, -0.04, 0.04), clamp(-accL.z * lag, -0.06, 0.06));
      this.headOffset.lerp(target, 1 - Math.exp(-6 * c.dt));

      const speed = v.speed;
      const rough = { asphalt: 0.25, gravel: 1.0, grass: 1.6, mud: 1.8 }[v.surface];
      const vib = c.shake * Math.min(1, speed / 25) * rough * (this.mode === 'driver' ? 0.004 : 0.0022) + c.shake * v.jolt * 0.03;
      const t = c.time;
      const shake = new THREE.Vector3(this.roadShake[0].at(t) * vib, this.roadShake[1].at(t) * vib * 1.4, this.roadShake[2].at(t) * vib * 0.5);

      cam.position.set(local.x, local.y - CG_HEIGHT, local.z).add(this.headOffset).add(shake);
      c.vehicleObj.localToWorld(cam.position);

      this.yaw = clamp(this.yaw, -2.5, 2.5);
      this.pitch = clamp(this.pitch, -1.0, 0.9);
      // Lean into corners a little (head stays more level than the car).
      this.rollSmooth = damp(this.rollSmooth, clamp(accL.x * 0.004, -0.05, 0.05), 5, c.dt);
      const ang = this.mode === 'dashcam' ? 0.0 : 1;
      const jitterRot = vib * 1.5;
      _e.set(
        this.pitch * ang - (this.mode === 'dashcam' ? 0.0 : 0) + this.roadShake[1].at(t + 3) * jitterRot,
        this.yaw * ang + this.roadShake[0].at(t + 7) * jitterRot * 0.5,
        this.rollSmooth * ang + this.roadShake[2].at(t + 11) * jitterRot * 0.6,
      );
      cam.quaternion.copy(v.quat).multiply(_q.setFromEuler(_e));
      cam.fov = this.mode === 'dashcam' ? 70 : c.fov;
    } else if (c.walker) {
      // Chest-mounted bodycam. The torso follows the mouse through a spring, so
      // quick looks overshoot and settle; footfalls jolt the frame.
      this.zoom = clamp(this.zoom * Math.pow(1.15, -c.wheel), 1, 4);
      if (c.zoomHeld) this.zoom = Math.max(this.zoom, 2);
      this.pitch = clamp(this.pitch, -1.4, 1.2);
      const k = 150, damping = 17;
      const dy = wrapAngle(this.yaw - this.lookYaw);
      this.lookVel.x += (dy * k - this.lookVel.x * damping) * c.dt;
      this.lookVel.y += ((this.pitch - this.lookPitch) * k - this.lookVel.y * damping) * c.dt;
      this.lookYaw += this.lookVel.x * c.dt;
      this.lookPitch += this.lookVel.y * c.dt;
      const turnRate = Math.min(4, Math.hypot(this.lookVel.x, this.lookVel.y));

      const t = c.time;
      const w = c.walker;
      const run = clamp((w.moving - 1) * 2, 0, 1);
      // Footfalls: a sharp dip at each step, heavier when running.
      const stepPhase = w.bob % Math.PI;
      const impact = Math.exp(-stepPhase * 7) * w.moving * (0.012 + run * 0.025);
      const handAmp = 0.006 * c.shake * (0.7 + this.zoom * 0.2);
      const turnAmp = 0.012 * c.shake * turnRate;
      const windAmp = c.shake * Math.min(0.03, (c.wind / 35) ** 2 * 0.03);
      const breathe = Math.sin(t * 1.6) * 0.004;
      cam.position.copy(w.eye);
      if (!w.animated) {
        // No body animation driving the mount: synthesise the gait bob.
        cam.position.y += -Math.abs(Math.sin(w.bob)) * (0.035 + run * 0.03) * w.moving - impact * 1.5 + breathe;
        cam.position.x += Math.sin(w.bob * 0.5) * (0.02 + run * 0.02) * w.moving * Math.cos(this.lookYaw);
        cam.position.z -= Math.sin(w.bob * 0.5) * (0.02 + run * 0.02) * w.moving * Math.sin(this.lookYaw);
      }
      _e.set(
        this.lookPitch + this.handShake[0].at(t) * handAmp + this.windShake[0].at(t) * windAmp - impact * 0.6 + this.roadShake[1].at(t) * turnAmp,
        this.lookYaw + this.handShake[1].at(t) * handAmp + this.windShake[1].at(t) * windAmp + Math.sin(w.bob * 0.5) * 0.012 * w.moving + this.roadShake[0].at(t) * turnAmp,
        this.handShake[2].at(t) * handAmp * 1.2 + Math.sin(w.bob * 0.5) * (0.012 + run * 0.015) * w.moving - this.lookVel.x * 0.01,
      );
      cam.quaternion.setFromEuler(_e);
      cam.fov = c.bodycamFov / this.zoom;
    }
    if (c.impulse > 0) {
      const a = c.impulse * 0.02 * c.shake;
      cam.quaternion.multiply(_q.setFromEuler(_e.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a)));
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // Angular speed (for footage stability).
    const dq = this.prevQuat.angleTo(cam.quaternion);
    this.angularSpeed = damp(this.angularSpeed, dq / Math.max(c.dt, 1e-3), 6, c.dt);
    this.prevQuat.copy(cam.quaternion);
  }

  /** Direction the bodycam wearer's torso faces (spring-smoothed yaw). */
  get torsoYaw(): number {
    return this.lookYaw;
  }

  /** How far the bodycam wearer is looking up (+) or down (-), spring-smoothed. */
  get torsoPitch(): number {
    return this.lookPitch;
  }

  /** World-space forward direction of the camera. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
  }
}
