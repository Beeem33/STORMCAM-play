import * as THREE from 'three';
import type { StormCell } from '../weather/StormModel';
import { heightAt } from '../environment/WorldShape';
import { clamp, damp, smoothstep } from '../utils/MathUtils';
import { mulberry32 } from '../utils/Random';

export type TornadoPhase = 'forming' | 'mature' | 'rope' | 'dissipating' | 'dead';

/** Peak wind by Enhanced Fujita rating (m/s, mid-range of each class). */
export const EF_WIND = [33, 44, 56, 68, 83, 98];

/**
 * Every tunable a designer may want, per the spec: position, motion, funnel
 * size, rotation, wind, debris, visibility and lifetime.
 */
export interface TornadoParams {
  rating: number;
  /** Radius of maximum winds / condensation funnel at the ground, m. */
  coreRadius: number;
  /** Funnel radius where it meets the cloud base, m. */
  topRadius: number;
  /** Cloud base height above the ground, m. */
  height: number;
  /** Visual spin of the funnel surface, rad/s. */
  rotationSpeed: number;
  /** Peak tangential wind, m/s. */
  maxWind: number;
  /** 0..1 how much dirt and debris the vortex lofts. */
  debrisDensity: number;
  /** 0..1 how condensed/visible the funnel is (rain-wrapped tornadoes are low). */
  visibility: number;
  /** Seconds in the mature phase. */
  matureTime: number;
}

const _tmp = new THREE.Vector3();

/**
 * One tornado: its life cycle, track and the wind field it imposes. The
 * renderer reads the derived shape values (condensation, rope, tilt…).
 */
export class Tornado {
  readonly params: TornadoParams;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Top of the funnel relative to the base (x, height, z). */
  readonly top = new THREE.Vector3();
  phase: TornadoPhase = 'forming';
  phaseTime = 0;
  age = 0;
  /** 0..1 overall strength envelope. */
  presence = 0;
  /** 0..1 how far down from the cloud base the funnel is condensed. */
  condensation = 0;
  /** 0..1 dust whirl at the ground. */
  debris = 0;
  /** 0..1 thin and sinuous. */
  rope = 0;
  /** How far down the funnel condenses once mature: to the ground unless it's rain-wrapped. */
  get groundCond(): number {
    return this.params.visibility >= 0.5 ? 1 : this.params.visibility;
  }
  /** Current funnel radius at ground. */
  radius: number;
  private readonly offset = new THREE.Vector2(); // storm-relative (ahead, right)
  private readonly rng: () => number;
  readonly id: number;
  private static nextId = 1;

  constructor(readonly storm: StormCell, params: Partial<TornadoParams> = {}, seed = Math.random() * 1e9) {
    this.rng = mulberry32(seed);
    const r = this.rng;
    const roll = r();
    const rating = params.rating ?? (roll < 0.22 ? 1 : roll < 0.52 ? 2 : roll < 0.8 ? 3 : roll < 0.96 ? 4 : 5);
    const core = params.coreRadius ?? 35 + rating * rating * 14 + r() * 40;
    this.params = {
      rating,
      coreRadius: core,
      topRadius: params.topRadius ?? core * (2.4 + r() * 1.2) + 120,
      height: params.height ?? 1000,
      rotationSpeed: params.rotationSpeed ?? 0.35 + rating * 0.06,
      maxWind: params.maxWind ?? EF_WIND[rating],
      debrisDensity: params.debrisDensity ?? 0.55 + rating * 0.09,
      visibility: params.visibility ?? 0.86 + r() * 0.14,
      // Long enough to drive in and lay a line of probes across its path.
      matureTime: params.matureTime ?? 420 + rating * 60 + r() * 120,
    };
    this.radius = core * 0.4;
    this.id = Tornado.nextId++;
    // Starts under the meso, a little to the right-rear (where the RFD wraps in).
    this.offset.set(-0.03 * storm.radius, 0.02 * storm.radius);
    this.syncPosition();
  }

  get alive(): boolean {
    return this.phase !== 'dead';
  }

  private syncPosition(): void {
    const s = this.storm;
    const sp = Math.hypot(s.vx, s.vz) || 1;
    const fx = s.vx / sp, fz = s.vz / sp;
    const x = s.x + fx * this.offset.x + -fz * this.offset.y;
    const z = s.z + fz * this.offset.x + fx * this.offset.y;
    this.position.set(x, heightAt(x, z), z);
  }

  update(dt: number, baseAlt: number): void {
    this.age += dt;
    this.phaseTime += dt;
    const P = this.params;
    const s = this.storm;
    const prev = _tmp.copy(this.position);

    // Drift relative to the parent meso: meander, then occlude to the rear-left as it ropes out.
    const meander = Math.sin(this.age * 0.021 + P.coreRadius) * 0.6 + Math.sin(this.age * 0.047) * 0.4;
    let da = meander * 2.5;
    let db = Math.cos(this.age * 0.033) * 2.0;
    if (this.phase === 'rope' || this.phase === 'dissipating') {
      da -= 6.5;
      db -= 4.5;
    }
    this.offset.x += da * dt;
    this.offset.y += db * dt;
    this.syncPosition();
    this.velocity.subVectors(this.position, prev).divideScalar(Math.max(dt, 1e-4));
    // Guard against teleports (storm repositioned): real tornadoes translate at < ~30 m/s.
    if (this.velocity.length() > 35) this.velocity.setLength(35);

    P.height = Math.max(500, baseAlt - 420);
    // Phase machine.
    switch (this.phase) {
      case 'forming': {
        const T = 30;
        const k = this.phaseTime / T;
        this.debris = smoothstep(0.0, 0.5, k);
        this.condensation = smoothstep(0.15, 1.0, k) * this.groundCond;
        this.presence = smoothstep(0, 0.6, k);
        this.radius = P.coreRadius * (0.35 + 0.65 * smoothstep(0.3, 1, k));
        this.rope = 0;
        if (k >= 1) this.setPhase('mature');
        break;
      }
      case 'mature': {
        const k = this.phaseTime / P.matureTime;
        this.presence = 1;
        this.debris = 1;
        // Breathe: the funnel widens and narrows over minutes.
        const breathe = 1 + 0.18 * Math.sin(this.age * 0.05 + 1.3) + 0.08 * Math.sin(this.age * 0.17);
        this.radius = damp(this.radius, P.coreRadius * breathe, 0.2, dt);
        this.condensation = damp(this.condensation, this.groundCond * (0.97 + 0.03 * Math.sin(this.age * 0.09)), 0.3, dt);
        if (k >= 1) this.setPhase('rope');
        break;
      }
      case 'rope': {
        const T = 75;
        const k = this.phaseTime / T;
        this.rope = smoothstep(0, 0.7, k);
        this.radius = damp(this.radius, 14 + P.coreRadius * 0.08, 0.06, dt);
        this.debris = 1 - smoothstep(0.3, 1.0, k) * 0.75;
        this.condensation = damp(this.condensation, Math.min(1, P.visibility + 0.2), 0.5, dt);
        this.presence = 1 - k * 0.4;
        if (k >= 1) this.setPhase('dissipating');
        break;
      }
      case 'dissipating': {
        const T = 28;
        const k = this.phaseTime / T;
        this.condensation = (1 - smoothstep(0, 1, k)) * P.visibility;
        this.debris = Math.max(0, 0.25 - k * 0.4);
        this.presence = 0.6 * (1 - k);
        if (k >= 1) this.setPhase('dead');
        break;
      }
    }

    // The top of the funnel stays under the meso while the base wanders, so it
    // leans toward the meso — strongly once it ropes out and the base lags behind.
    const mx = s.x - this.position.x;
    const mz = s.z - this.position.z;
    const ml = Math.hypot(mx, mz) || 1;
    const lean = clamp(ml * 0.8, 40, 200 + this.rope * 1400);
    this.top.set((mx / ml) * lean, P.height, (mz / ml) * lean);
  }

  private setPhase(p: TornadoPhase): void {
    this.phase = p;
    this.phaseTime = 0;
  }

  /** Current EF-equivalent intensity 0..1 for audio/scoring. */
  get intensity01(): number {
    return clamp(((this.params.rating + 0.5) / 5.5) * this.presence * (1 - this.rope * 0.4), 0, 1);
  }

  /**
   * Wind induced by the vortex at a world point (m/s), cyclonic rotation,
   * radial inflow near the ground and a strong updraft in the core.
   */
  windAt(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    if (this.presence <= 0.01) return out;
    const P = this.params;
    const h = clamp((p.y - this.position.y) / P.height, 0, 1);
    // Axis position at this height.
    const ax = this.position.x + this.top.x * Math.pow(h, 1.4);
    const az = this.position.z + this.top.z * Math.pow(h, 1.4);
    const dx = p.x - ax;
    const dz = p.z - az;
    const d = Math.hypot(dx, dz) + 0.01;
    const Rc = Math.max(10, this.radius * 1.1);
    const vmax = P.maxWind * this.presence * (1 - this.rope * 0.35);
    const vt = d < Rc ? vmax * (d / Rc) : vmax * Math.pow(Rc / d, 0.75);
    // Cyclonic (counter-clockwise seen from above, north = -z): tangent (dz, -dx)/d.
    const tx = dz / d, tz = -dx / d;
    const nearGround = 1 - smoothstep(30, 250, p.y - this.position.y);
    const inflow = (d < Rc * 0.8 ? 0.15 : 0.5) * vt * (0.3 + 0.7 * nearGround);
    out.x = tx * vt - (dx / d) * inflow;
    out.z = tz * vt - (dz / d) * inflow;
    out.y = vmax * 0.85 * Math.exp(-((d / (Rc * 1.3)) ** 2)) * (0.55 + 0.45 * smoothstep(0, 40, p.y - this.position.y + 5));
    // Turbulence: suction vortices and gusts that swing direction, strongest near the core.
    const turb = vmax * 0.38 * Math.exp(-((d / (Rc * 1.8)) ** 2));
    if (turb > 0.5) {
      const ph = this.age * 1.7 + d * 0.05;
      out.x += turb * Math.sin(ph * 1.3 + p.z * 0.02);
      out.z += turb * Math.cos(ph * 1.1 + p.x * 0.02);
      out.y += turb * 0.6 * Math.max(0, Math.sin(ph * 0.9 + 1.7));
    }
    // The whole vortex translates.
    const carry = Math.exp(-d / (Rc * 6));
    out.x += this.velocity.x * carry;
    out.z += this.velocity.z * carry;
    return out;
  }

  /** Horizontal distance from a point to the funnel axis at ground level. */
  distanceTo(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.position.x, p.z - this.position.z);
  }
}
