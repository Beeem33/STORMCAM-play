import * as THREE from 'three';
import type { LensProfile } from '../rendering/Renderer';
import { CG_HEIGHT, DASHCAM_POS, DRIVER_EYE } from '../vehicle/VehicleModel';
import type { Vehicle } from '../vehicle/Vehicle';
import { clamp, damp } from '../utils/MathUtils';

export type CameraMode = 'driver' | 'dashcam' | 'handheld';

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
  handheld: {
    barrel: 0.03, chroma: 0.003, noise: 0.85, sharpen: 0.4, vignette: 0.16,
    saturation: 0.95, contrast: 1.08, tint: new THREE.Color(1, 0.995, 0.99), ev: 0.78, shutter: 0.5,
  },
};

export interface RigContext {
  dt: number;
  time: number;
  vehicleObj: THREE.Object3D;
  vehicle: Vehicle;
  /** Walker eye position + body yaw when on foot. */
  walker: { eye: THREE.Vector3; bob: number; moving: number } | null;
  mouseDX: number;
  mouseDY: number;
  wheel: number;
  zoomHeld: boolean;
  sensitivity: number;
  invertY: boolean;
  shake: number;
  fov: number;
  /** Wind speed at the camera (m/s) — buffets handheld footage. */
  wind: number;
  /** Extra shake impulse 0..1 (thunder, debris hits). */
  impulse: number;
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
    if (mode === 'handheld') this.zoom = 1;
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
      // Handheld phone footage.
      this.zoom = clamp(this.zoom * Math.pow(1.15, -c.wheel), 1, 8);
      if (c.zoomHeld) this.zoom = Math.max(this.zoom, 2.5);
      this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      this.pitch = clamp(this.pitch, -1.3, 1.35);
      const t = c.time;
      const handAmp = 0.0045 * c.shake * (0.6 + this.zoom * 0.25);
      const windAmp = c.shake * Math.min(0.02, (c.wind / 40) ** 2 * 0.02);
      cam.position.copy(c.walker.eye);
      cam.position.y += Math.sin(c.walker.bob) * 0.03 * c.walker.moving;
      cam.position.x += Math.sin(c.walker.bob * 0.5) * 0.015 * c.walker.moving;
      _e.set(
        this.pitch + this.handShake[0].at(t) * handAmp + this.windShake[0].at(t) * windAmp + Math.abs(Math.sin(c.walker.bob)) * 0.01 * c.walker.moving,
        this.yaw + this.handShake[1].at(t) * handAmp + this.windShake[1].at(t) * windAmp,
        this.handShake[2].at(t) * handAmp * 0.8 + Math.sin(c.walker.bob * 0.5) * 0.006 * c.walker.moving,
      );
      cam.quaternion.setFromEuler(_e);
      cam.fov = 64 / this.zoom;
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

  /** World-space forward direction of the camera. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
  }
}
