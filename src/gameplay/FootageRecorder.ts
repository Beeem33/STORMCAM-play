import * as THREE from 'three';
import type { Tornado } from '../tornado/Tornado';
import type { StormCell } from '../weather/StormModel';
import type { CameraMode } from '../camera/CameraRig';
import type { UpgradeEffects } from './Upgrades';
import { clamp, smoothstep } from '../utils/MathUtils';

/**
 * Recording and footage valuation. Recording produces metadata, not video:
 * each frame is graded on what the camera can actually see — is the tornado
 * in frame, how big, how clear through the rain and haze, how steady, through
 * which window — and the clip's market value accumulates from that. Being
 * close without filming earns nothing; filming badly earns little.
 */

export type FootageEventKind = 'tornado' | 'birth' | 'intercept' | 'lightning' | 'damage' | 'ropeout' | 'structure' | 'hail';

export interface FootageEvent {
  kind: FootageEventKind;
  label: string;
  bonus: number;
  at: number;
}

export interface Clip {
  id: number;
  start: number;
  duration: number;
  value: number;
  peakQuality: number;
  qualitySum: number;
  tornadoSeconds: number;
  events: FootageEvent[];
}

export interface RecordContext {
  dt: number;
  time: number;
  camera: THREE.PerspectiveCamera;
  mode: CameraMode;
  angularSpeed: number;
  tornado: Tornado | null;
  storms: readonly StormCell[];
  visibility: number;
  rain: number;
  hail: number;
  inVehicle: boolean;
  vehicleQuat: THREE.Quaternion;
  /** Water on the glass the camera looks through (0 clear .. 1 streaming). */
  glassWater: number;
  stationary: boolean;
  effects: UpgradeEffects;
}

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class FootageRecorder {
  recording = false;
  current: Clip | null = null;
  readonly clips: Clip[] = [];
  /** Live 0..1 grade of the current frame (shown in the HUD). */
  quality = 0;
  /** Why the current frame is weak, for the HUD ("no subject", "shaky", …). */
  hint = '';
  private nextId = 1;
  /** Total tornado seconds filmed this chase — value per second diminishes with it. */
  private sessionTornadoSeconds = 0;
  private flags = new Set<string>();
  onEvent: ((e: FootageEvent) => void) | null = null;

  toggle(time: number): boolean {
    if (this.recording) this.stop();
    else this.start(time);
    return this.recording;
  }

  start(time: number): void {
    this.recording = true;
    this.current = { id: this.nextId++, start: time, duration: 0, value: 0, peakQuality: 0, qualitySum: 0, tornadoSeconds: 0, events: [] };
    this.flags.clear();
  }

  stop(): void {
    if (!this.current) return;
    this.recording = false;
    if (this.current.duration > 1.5) this.clips.push(this.current);
    this.current = null;
  }

  reset(): void {
    this.recording = false;
    this.current = null;
    this.clips.length = 0;
    this.sessionTornadoSeconds = 0;
  }

  get totalValue(): number {
    return this.clips.reduce((a, c) => a + c.value, 0) + (this.current?.value ?? 0);
  }

  /** Project a world point; returns NDC (z > 1 means behind). */
  private project(p: THREE.Vector3, cam: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).project(cam);
  }

  /** How usable the view toward `dir` is from inside the car (windshield good, roof/dash none). */
  private windowFactor(ctx: RecordContext, dir: THREE.Vector3): number {
    if (!ctx.inVehicle || ctx.mode === 'dashcam') return 1;
    _d.copy(dir).applyQuaternion(_q.copy(ctx.vehicleQuat).invert());
    const yaw = Math.atan2(_d.x, -_d.z);
    const pitch = Math.asin(clamp(_d.y, -1, 1));
    if (pitch > 0.62) return 0.15; // looking at the headliner
    const a = Math.abs(yaw);
    if (a < 0.85) return 1 - ctx.glassWater * 0.45; // windshield
    if (a < 1.9) return 0.85; // side windows
    return 0.45; // rear privacy glass
  }

  private event(kind: FootageEventKind, label: string, bonus: number, time: number, onceKey?: string): void {
    if (!this.current) return;
    if (onceKey) {
      if (this.flags.has(onceKey)) return;
      this.flags.add(onceKey);
    }
    const e = { kind, label, bonus, at: time - this.current.start };
    this.current.events.push(e);
    this.current.value += bonus;
    this.onEvent?.(e);
  }

  update(ctx: RecordContext): void {
    const cam = ctx.camera;
    const fovV = THREE.MathUtils.degToRad(cam.fov);
    let q = 0;
    let rate = 0;
    this.hint = '';
    const stability = ctx.stationary && ctx.effects.tripod ? 1 : 1 - clamp((ctx.angularSpeed - 0.12) / 1.1, 0, 0.75);
    const camPos = cam.position;

    const t = ctx.tornado;
    if (t && t.presence > 0.05) {
      const dist = t.distanceTo(camPos);
      let framing = 0;
      for (const h of [0.02, 0.15, 0.35]) {
        _p.set(t.position.x + t.top.x * h, t.position.y + t.top.y * h, t.position.z + t.top.z * h);
        const n = this.project(_p, cam, new THREE.Vector3());
        if (n.z < 1 && Math.abs(n.x) < 0.97 && Math.abs(n.y) < 0.97) framing = Math.max(framing, 1 - 0.55 * Math.max(Math.abs(n.x), Math.abs(n.y)));
      }
      _d.subVectors(t.position, camPos).normalize();
      const win = this.windowFactor(ctx, _d);
      const width = Math.max(t.radius * 2, 30) * (0.6 + 0.4 * t.condensation + 0.3 * t.debris);
      const screenFrac = width / Math.max(dist, 1) / fovV;
      const size = 0.3 + 0.7 * smoothstep(0.01, 0.14, screenFrac);
      const clarity = Math.exp((-dist / ctx.visibility) * 1.4) * (1 - ctx.rain * 0.35);
      const visible = Math.min(1, t.condensation * 0.8 + t.debris * 0.4);
      q = framing * size * clarity * win * stability * visible * t.presence;
      const intensity = 0.4 + (t.params.rating + 1) / 6;
      const phase = t.phase === 'rope' ? 1.25 : t.phase === 'forming' ? 1.15 : 1;
      const diminishing = 1 / (1 + this.sessionTornadoSeconds / 150);
      rate = 16 * q * intensity * phase * diminishing;
      if (framing === 0) this.hint = 'TORNADO OUT OF FRAME';
      else if (clarity < 0.25) this.hint = 'TOO MUCH RAIN / HAZE';
      else if (stability < 0.55) this.hint = 'SHAKY';
      else if (win < 0.5) this.hint = 'VIEW BLOCKED';
      else if (size < 0.4) this.hint = 'TOO FAR';
      if (this.recording && this.current && q > 0.18) {
        this.current.tornadoSeconds += ctx.dt;
        this.sessionTornadoSeconds += ctx.dt;
        if (t.phase === 'forming') this.event('birth', 'Tornadogenesis', 600 * intensity, ctx.time, 'birth' + t.id);
        if (this.current.tornadoSeconds > 3) this.event('tornado', `EF${t.params.rating}-strength tornado`, 250 * intensity, ctx.time, 'tor' + t.id);
        if (dist < 420) this.event('intercept', 'Close-range intercept', 900 * intensity, ctx.time, 'int' + t.id);
        if (t.phase === 'rope' && t.rope > 0.5) this.event('ropeout', 'Rope-out stage', 350, ctx.time, 'rope' + t.id);
      }
    } else {
      // No tornado: storm structure (wall cloud, meso) is worth a little.
      let best = 0;
      for (const s of ctx.storms) {
        if (s.meso < 0.3) continue;
        _p.set(s.x, 900, s.z);
        const n = this.project(_p, cam, new THREE.Vector3());
        if (n.z >= 1 || Math.abs(n.x) > 0.95 || Math.abs(n.y) > 0.95) continue;
        const dist = Math.hypot(s.x - camPos.x, s.z - camPos.z);
        const clarity = Math.exp((-dist / ctx.visibility) * 1.2);
        best = Math.max(best, s.meso * clarity * (1 - Math.abs(n.x) * 0.4) * smoothstep(25000, 6000, dist));
      }
      q = best * 0.3 * stability;
      rate = 1.6 * q;
      if (q < 0.05) this.hint = 'NO SUBJECT';
    }
    if (ctx.hail > 0.4 && this.recording) this.event('hail', 'Hail core', 150, ctx.time, 'hail');

    this.quality = q;
    if (this.recording && this.current) {
      const c = this.current;
      c.duration += ctx.dt;
      c.value += rate * ctx.dt * ctx.effects.footageValue;
      c.peakQuality = Math.max(c.peakQuality, q);
      c.qualitySum += q * ctx.dt;
    }
  }

  /** A lightning strike happened somewhere: worth money if it was in frame. */
  noteStrike(pos: THREE.Vector3, cloudToGround: boolean, cam: THREE.Camera, time: number): void {
    if (!this.recording || !cloudToGround) return;
    const dist = Math.hypot(pos.x - cam.position.x, pos.z - cam.position.z);
    if (dist > 14000) return;
    const mid = pos.clone();
    mid.y += 500;
    const n = mid.project(cam);
    if (n.z >= 1 || Math.abs(n.x) > 0.95 || Math.abs(n.y) > 0.95) return;
    const close = 1 - dist / 14000;
    this.event('lightning', dist < 1500 ? 'Close lightning strike' : 'Lightning strike', Math.round(80 + 520 * close * close), time);
  }

  /** A structure was destroyed: worth money if it was in frame. */
  noteDestruction(pos: THREE.Vector3, label: string, cam: THREE.Camera, time: number): void {
    if (!this.recording) return;
    const dist = pos.distanceTo(cam.position);
    if (dist > 3000) return;
    const n = pos.clone().project(cam);
    if (n.z >= 1 || Math.abs(n.x) > 0.95 || Math.abs(n.y) > 0.95) return;
    this.event('damage', label, Math.round(250 + 500 * (1 - dist / 3000)), time);
  }
}

/** Letter grade for a clip from its average quality. */
export function clipGrade(c: Clip): string {
  const avg = c.duration > 0 ? c.qualitySum / c.duration : 0;
  const s = avg * 0.6 + c.peakQuality * 0.4;
  return s > 0.55 ? 'A' : s > 0.4 ? 'B' : s > 0.25 ? 'C' : s > 0.12 ? 'D' : 'F';
}
