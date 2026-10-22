/**
 * Dev-only: renders scenarios through the real AudioSystem in an
 * OfflineAudioContext (silent, faster than real time) and reports levels:
 *  - RMS dBFS and sample peak dBFS
 *  - an ungated K-weighted loudness (ITU-R BS.1770 filters) ≈ LUFS.
 * Targets are for the raw mix (dynamics bypassed); the compressor/limiter
 * then only has to tame the loudest scenes by a few dB.
 */
import * as THREE from 'three';
import type { AudioFrameState } from './AudioTypes';
import { AudioSystem } from './AudioSystem';
import { createAudioFrameState } from './frameState';

/** Re-exported so dev tools tweak the same module instance the system reads. */
export { MIX } from './mix';

export interface ProbeScenario {
  name: string;
  /** Target loudness (≈LUFS) for the measured window. */
  target?: number;
  seconds?: number;
  /** Measurement window start (s). */
  from?: number;
  setup: (s: AudioFrameState) => void;
  /** Called once at t=0 after the first update (for one-shots). */
  fire?: (sys: AudioSystem) => void;
}

export interface ProbeResult {
  name: string;
  target?: number;
  lufs: number;
  rms: number;
  peak: number;
}

const SR = 48000;

function biquad(x: Float32Array, b: readonly number[], a: readonly number[]): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const K1B = [1.53512485958697, -2.69169618940638, 1.19839281085285];
const K1A = [1, -1.69065929318241, 0.73248077421585];
const K2B = [1.0, -2.0, 1.0];
const K2A = [1, -1.99004745483398, 0.99007225036621];

function analyse(buf: AudioBuffer, from: number): { lufs: number; rms: number; peak: number } {
  const start = Math.floor(from * buf.sampleRate);
  let ms = 0;
  let kms = 0;
  let peak = 0;
  const n = buf.length - start;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const k = biquad(biquad(d, K1B, K1A), K2B, K2A);
    for (let i = start; i < buf.length; i++) {
      ms += d[i]! * d[i]!;
      kms += k[i]! * k[i]!;
      peak = Math.max(peak, Math.abs(d[i]!));
    }
  }
  const db = (x: number): number => (x > 0 ? 10 * Math.log10(x) : -120);
  return {
    rms: db(ms / (n * buf.numberOfChannels)),
    // BS.1770: sum of channel mean squares
    lufs: -0.691 + db(kms / n),
    peak: peak > 0 ? 20 * Math.log10(peak) : -120,
  };
}

export async function runScenario(sc: ProbeScenario, bypassDynamics = false): Promise<ProbeResult> {
  const seconds = sc.seconds ?? 6;
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  const sys = new AudioSystem({ context: ctx, bypassDynamics });
  sys.unlock();
  sys.setMasterVolume(1);
  const s = createAudioFrameState();
  sc.setup(s);
  const Q = 128;
  let lastQ = -1;
  let first = true;
  for (let i = 0; i < seconds * 60; i++) {
    const q = Math.round(((i / 60) * SR) / Q);
    if (q === lastQ) continue;
    lastQ = q;
    const t = (q * Q) / SR;
    if (t >= seconds - 0.01) break;
    ctx.suspend(t).then(() => {
      sys.update(s);
      if (first) {
        first = false;
        sc.fire?.(sys);
      }
      return ctx.resume();
    }).catch(() => undefined);
  }
  const buf = await ctx.startRendering();
  sys.dispose();
  return { name: sc.name, target: sc.target, ...analyse(buf, sc.from ?? 2) };
}

const tornadoAt = (d: number, inside: boolean, I = 0.8) => (s: AudioFrameState): void => {
  s.engineRunning = false;
  s.inVehicle = inside;
  s.tornado.active = true;
  s.tornado.distance = d;
  s.tornado.intensity = I;
  s.tornado.radius = 80;
  s.tornado.position.set(d * 0.5, 0, -d * 0.866);
};

export const SCENARIOS: ProbeScenario[] = [
  { name: 'silence (in car, engine off)', setup: (s) => { s.engineRunning = false; } },
  { name: 'idle in car', target: -33, setup: () => undefined },
  { name: 'cruise 25 m/s asphalt (in)', target: -25, setup: (s) => { s.engineRpm = 2200; s.engineLoad = 0.35; s.vehicleSpeed = 25; s.bumpiness = 0.08; } },
  { name: 'WOT 5000 rpm 20 m/s (in)', target: -20, setup: (s) => { s.engineRpm = 5000; s.engineLoad = 1; s.vehicleSpeed = 20; } },
  { name: 'road only 25 m/s (in, eng off)', target: -27, setup: (s) => { s.engineRunning = false; s.vehicleSpeed = 25; } },
  { name: 'engine only WOT (in)', setup: (s) => { s.engineRpm = 5000; s.engineLoad = 1; } },
  { name: 'gravel 15 m/s (in, eng off)', target: -26, setup: (s) => { s.engineRunning = false; s.surface = 'gravel'; s.vehicleSpeed = 15; s.bumpiness = 0.25; } },
  { name: 'grass 10 m/s (in, eng off)', target: -31, setup: (s) => { s.engineRunning = false; s.surface = 'grass'; s.vehicleSpeed = 10; } },
  { name: 'mud 8 m/s (in, eng off)', target: -29, setup: (s) => { s.engineRunning = false; s.surface = 'mud'; s.vehicleSpeed = 8; } },
  { name: 'skid slip 1, 15 m/s (out, eng off)', target: -21, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.tireSlip = 1; s.vehicleSpeed = 15; } },
  { name: 'rattles bump 0.6 (in, eng off)', target: -36, setup: (s) => { s.engineRunning = false; s.bumpiness = 0.6; } },
  { name: 'rain 0.25 (in, eng off)', target: -31, setup: (s) => { s.engineRunning = false; s.rain = 0.25; } },
  { name: 'rain 1 (in, eng off)', target: -20, setup: (s) => { s.engineRunning = false; s.rain = 1; } },
  { name: 'rain 1 (out)', target: -22, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.rain = 1; } },
  { name: 'hail 1 (in)', target: -16, setup: (s) => { s.engineRunning = false; s.hail = 1; } },
  { name: 'hail 1 (out)', target: -22, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.hail = 1; } },
  { name: 'wind 8 (out)', target: -34, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.windSpeed = 8; } },
  { name: 'wind 15 (out)', target: -28, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.windSpeed = 15; } },
  { name: 'wind 35 (out)', target: -18, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.windSpeed = 35; } },
  { name: 'wind 35 (in)', target: -25, setup: (s) => { s.engineRunning = false; s.windSpeed = 35; } },
  { name: 'wind 70 (out)', target: -13, setup: (s) => { s.engineRunning = false; s.inVehicle = false; s.windSpeed = 70; } },
  { name: 'tornado 3000 m (out)', target: -45, setup: tornadoAt(3000, false) },
  { name: 'tornado 1000 m (out)', target: -30, setup: tornadoAt(1000, false) },
  { name: 'tornado 400 m (out)', target: -19, setup: tornadoAt(400, false) },
  { name: 'tornado 400 m (in)', target: -26, setup: tornadoAt(400, true) },
  { name: 'tornado 100 m (out)', target: -11, setup: tornadoAt(100, false) },
  {
    name: 'thunder 300 m (out)', target: -14, seconds: 8, from: 0.5,
    setup: (s) => { s.engineRunning = false; s.inVehicle = false; },
    fire: (sys) => sys.thunder(300, 1, new THREE.Vector3(1, 0, -1)),
  },
  {
    name: 'thunder 300 m (in)', target: -21, seconds: 8, from: 0.5,
    setup: (s) => { s.engineRunning = false; },
    fire: (sys) => sys.thunder(300, 1, new THREE.Vector3(1, 0, -1)),
  },
  {
    name: 'thunder 5 km (out)', target: -28, seconds: 26, from: 14.6,
    setup: (s) => { s.engineRunning = false; s.inVehicle = false; },
    fire: (sys) => sys.thunder(5000, 1),
  },
  {
    name: 'door close + beep (peaks)', seconds: 1.2, from: 0,
    setup: (s) => { s.engineRunning = false; },
    fire: (sys) => { sys.door(false); sys.recordBeep(true); },
  },
  {
    name: 'destroyed (in)', seconds: 3, from: 0,
    setup: (s) => { s.engineRunning = false; },
    fire: (sys) => sys.vehicleDestroyed(),
  },
  {
    name: 'EVERYTHING (in, tornado 150 m)', target: -9, seconds: 5,
    setup: (s) => {
      tornadoAt(150, true, 1)(s);
      s.engineRunning = true; s.engineRpm = 4200; s.engineLoad = 1; s.vehicleSpeed = 22;
      s.surface = 'gravel'; s.bumpiness = 0.7; s.rain = 1; s.hail = 1; s.windSpeed = 75; s.windowDamage = 0.5;
    },
  },
];
