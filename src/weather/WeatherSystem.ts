import * as THREE from 'three';
import {
  stormAnvil,
  stormCover,
  stormHail,
  stormPrecip,
  stormWind,
  type StormCell,
  type StormStage,
} from './StormModel';
import { mulberry32 } from '../utils/Random';
import { clamp, damp, smoothstep } from '../utils/MathUtils';

/** Weather at one point, sampled each frame for the player. */
export interface LocalWeather {
  cover: number;
  anvil: number;
  rain: number;
  hail: number;
  /** Storm-scale wind (m/s, world xz in x/z). */
  wind: THREE.Vector3;
  /** Is the low sun hidden behind cloud? 0..1 */
  sunBlocked: number;
  /** Meteorological visibility, metres. */
  visibility: number;
}

export interface DayScenario {
  seed: number;
  /** 1..∞, harder days spawn stronger, faster storms. */
  day: number;
}

const LABELS = 'ABCDEFGH';

/**
 * Drives storm cells through their life cycle — developing, mature,
 * tornadic, dissipating — moving them across the map. Storms evolve on their
 * own clock; nothing is scripted to the player's position, so a chase can be
 * missed, cut off by the core, or simply never produce.
 */
export class WeatherSystem {
  storms: StormCell[] = [];
  readonly local: LocalWeather = {
    cover: 0, anvil: 0, rain: 0, hail: 0, wind: new THREE.Vector3(), sunBlocked: 0, visibility: 20000,
  };
  wetness = 0;
  /** Seconds since the chase started. */
  clock = 0;
  private rng = mulberry32(1);
  /** Fired when a storm reaches the tornadic stage; return false if no tornado could be spawned. */
  onTornadogenesis: ((s: StormCell) => boolean) | null = null;

  /** Build the day's storm setup. Storms fire 10–20 km to the west/south-west. */
  startDay(sc: DayScenario, start: { x: number; z: number }): void {
    this.rng = mulberry32(sc.seed);
    const r = this.rng;
    this.storms = [];
    this.clock = 0;
    this.wetness = 0.05;
    const count = 2 + (r() < 0.5 ? 1 : 0);
    // Steering flow from the south-west, 8–12 m/s.
    const flowAng = THREE.MathUtils.degToRad(40 + r() * 25); // bearing the storms move TOWARD (NE-ish)
    const speed = 7.5 + r() * 3 + Math.min(3, sc.day * 0.3);
    const tornadicIdx = Math.floor(r() * count);
    for (let i = 0; i < count; i++) {
      const bearing = THREE.MathUtils.degToRad(205 + i * 28 + (r() - 0.5) * 20); // where it sits, from the player
      const dist = 9000 + r() * 6000 + i * 1500;
      const x = start.x + Math.sin(bearing) * dist;
      const z = start.z - Math.cos(bearing) * dist;
      const tornadic = i === tornadicIdx || r() < 0.18;
      const s: StormCell = {
        id: i + 1,
        label: LABELS[i],
        x, z,
        vx: Math.sin(flowAng) * speed * (0.9 + r() * 0.2),
        vz: -Math.cos(flowAng) * speed * (0.9 + r() * 0.2),
        radius: 5200 + r() * 1800,
        intensity: 0.35 + r() * 0.2,
        meso: 0.1,
        stage: 'developing',
        age: 0,
        stageTimer: (i === tornadicIdx ? 90 : 160) + r() * 120,
        tornadic,
        hasTornado: false,
        seed: r(),
      };
      this.storms.push(s);
    }
  }

  private setStage(s: StormCell, st: StormStage): void {
    s.stage = st;
    const r = this.rng;
    if (st === 'mature') s.stageTimer = s.tornadic ? 150 + r() * 150 : 500 + r() * 300;
    else if (st === 'tornadic') {
      s.stageTimer = 9999; // ends when its tornado dies
      s.hasTornado = true;
      if (this.onTornadogenesis && !this.onTornadogenesis(s)) {
        // Only one tornado at a time in this prototype: try again later.
        s.hasTornado = false;
        s.stage = 'mature';
        s.stageTimer = 90 + this.rng() * 90;
      }
    } else if (st === 'dissipating') s.stageTimer = 9999;
  }

  /** Called by the tornado system when a storm's tornado has finished. */
  tornadoEnded(s: StormCell): void {
    s.hasTornado = false;
    // Cyclic supercells can try again; most weaken afterwards.
    if (this.rng() < 0.35) {
      s.stage = 'mature';
      s.stageTimer = 200 + this.rng() * 200;
    } else this.setStage(s, 'dissipating');
  }

  update(dt: number, at: THREE.Vector3): void {
    this.clock += dt;
    for (const s of this.storms) {
      s.age += dt;
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      s.stageTimer -= dt;
      switch (s.stage) {
        case 'developing':
          s.intensity = Math.min(0.9, s.intensity + dt * 0.0035);
          s.meso = Math.min(0.45, s.meso + dt * 0.002);
          if (s.stageTimer <= 0) this.setStage(s, 'mature');
          break;
        case 'mature':
          s.intensity = damp(s.intensity, 0.97, 0.01, dt);
          s.meso = damp(s.meso, s.tornadic ? 1 : 0.65, 0.008, dt);
          if (s.stageTimer <= 0) this.setStage(s, s.tornadic ? 'tornadic' : 'dissipating');
          break;
        case 'tornadic':
          s.intensity = damp(s.intensity, 1, 0.02, dt);
          s.meso = damp(s.meso, 1, 0.05, dt);
          break;
        case 'dissipating':
          s.intensity -= dt * 0.0022;
          s.meso = Math.max(0, s.meso - dt * 0.004);
          break;
      }
    }
    this.storms = this.storms.filter((s) => s.intensity > 0.05);

    // Local weather at the player.
    const L = this.local;
    let cover = 0, anvil = 0, rain = 0, hail = 0;
    const w = { x: 0, z: 0 };
    L.wind.set(4 + Math.sin(this.clock * 0.05) * 1.5, 0, -2.5); // ambient southerly breeze
    for (const s of this.storms) {
      cover = Math.max(cover, stormCover(s, at.x, at.z));
      anvil = Math.max(anvil, stormAnvil(s, at.x, at.z));
      rain = Math.max(rain, stormPrecip(s, at.x, at.z));
      hail = Math.max(hail, stormHail(s, at.x, at.z));
      stormWind(s, at.x, at.z, w);
      L.wind.x += w.x;
      L.wind.z += w.z;
    }
    // Rain arrives with gust fronts — smooth it so it builds and eases.
    L.cover = damp(L.cover, cover, 0.6, dt);
    L.anvil = damp(L.anvil, anvil, 0.6, dt);
    L.rain = damp(L.rain, smoothstep(0.05, 0.9, rain), 0.8, dt);
    L.hail = damp(L.hail, hail > 0.35 ? smoothstep(0.35, 0.9, hail) : 0, 1.5, dt);
    // Gusts.
    const gust = 1 + 0.35 * Math.sin(this.clock * 0.9) * Math.sin(this.clock * 0.37 + 1.3);
    L.wind.multiplyScalar(gust);

    // Sun: low in the WSW, so it hides when cloud lies ~3–5 km in that direction.
    let blocked = anvil * 0.7;
    const sx = -0.94, sz = -0.34; // horizontal direction to the sun
    for (const s of this.storms) {
      for (const d of [2500, 4500]) blocked = Math.max(blocked, stormCover(s, at.x + sx * d, at.z + sz * d) * 1.2, stormAnvil(s, at.x + sx * d * 3, at.z + sz * d * 3) * 0.9);
    }
    L.sunBlocked = damp(L.sunBlocked, clamp(blocked, 0, 1), 0.5, dt);
    // Visibility collapses in heavy rain and hail.
    L.visibility = 32000 / (1 + L.rain * L.rain * 26 + L.rain * 2 + L.hail * 14) * (1 - L.cover * 0.2);

    // Surfaces get wet quickly in rain and dry slowly.
    if (L.rain > 0.05) this.wetness = Math.min(1, this.wetness + dt * L.rain * 0.06);
    else this.wetness = Math.max(0.05, this.wetness - dt * 0.002);
  }

  precipAt(x: number, z: number): number {
    let p = 0;
    for (const s of this.storms) p = Math.max(p, stormPrecip(s, x, z));
    return p;
  }

  coverAt(x: number, z: number): number {
    let p = 0;
    for (const s of this.storms) p = Math.max(p, stormCover(s, x, z));
    return p;
  }
}
