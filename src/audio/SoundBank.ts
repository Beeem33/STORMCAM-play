/**
 * Procedurally synthesised buffers, generated once per sample rate:
 *  - looping noise beds (white / pink / brown), smooth control-rate modulators,
 *  - looping textures (rain on ground, rain on roof, hail bed, gravel crunch),
 *  - banks of short one-shots (hail clanks, rattles, debris, glass, doors...).
 *
 * Everything is plain JS DSP (modal resonators, noise bursts) written straight
 * into AudioBuffers — no sample files, no network.
 */
import { clamp, expRand, pick, rand } from './util';

const TAU = Math.PI * 2;

export interface SoundBank {
  sr: number;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** Smooth random control signals in [-1, 1] (low sample rate). */
  modSlow: AudioBuffer;
  modMed: AudioBuffer;
  modFast: AudioBuffer;

  rainGround: AudioBuffer;
  roofDense: AudioBuffer;
  roofSparse: AudioBuffer;
  hailBed: AudioBuffer;
  gravel: AudioBuffer;

  hailRoof: AudioBuffer[];
  hailHeavy: AudioBuffer[];
  hailGround: AudioBuffer[];
  glassTick: AudioBuffer[];
  rattleClick: AudioBuffer[];
  rattleCreak: AudioBuffer[];
  rattleKnock: AudioBuffer[];
  thud: AudioBuffer[];
  pebble: AudioBuffer[];
  splat: AudioBuffer[];
  debrisWood: AudioBuffer[];
  debrisMetal: AudioBuffer[];
  debrisScatter: AudioBuffer[];
  bodyHit: AudioBuffer[];
  glassCrack: AudioBuffer[];
  shatter: AudioBuffer[];
  crunch: AudioBuffer[];
  wiperDry: AudioBuffer[];
  wiperWet: AudioBuffer[];
  doorOpen: AudioBuffer[];
  doorClose: AudioBuffer[];
  beepStart: AudioBuffer;
  beepStop: AudioBuffer;
  uiClick: AudioBuffer[];
}

// ---------------------------------------------------------------------------
// DSP primitives (write into Float32Arrays, optionally wrapping for loops)
// ---------------------------------------------------------------------------

/** Exponentially decaying sinusoid (one resonant mode), via a 2-pole recurrence. */
export function addMode(
  out: Float32Array, start: number, f: number, tau: number, amp: number, sr: number, wrap = false, lenTaus = 6.9,
): void {
  const N = out.length;
  if (f <= 0 || f >= sr * 0.47 || amp === 0) return;
  start = Math.floor(start);
  const w = (TAU * f) / sr;
  const r = Math.exp(-1 / (tau * sr));
  const c = 2 * r * Math.cos(w);
  const r2 = r * r;
  let len = Math.ceil(tau * sr * lenTaus);
  len = Math.min(len, wrap ? N : N - start);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < len; i++) {
    const y = i === 0 ? 0 : i === 1 ? amp * r * Math.sin(w) : c * y1 - r2 * y2;
    y2 = y1;
    y1 = y;
    let idx = start + i;
    if (idx >= N) idx -= N;
    out[idx]! += y;
  }
}

/** Decaying sine with an exponential frequency glide (bubbles, thumps, squeaks). */
export function addGlide(
  out: Float32Array, start: number, f0: number, f1: number, tau: number, amp: number, sr: number,
  wrap = false, attack = 0.0005,
): void {
  const N = out.length;
  start = Math.floor(start);
  let len = Math.ceil(tau * sr * 6.9);
  len = Math.min(len, wrap ? N : N - start);
  if (len <= 0) return;
  // Rotating phasor; the rotation is refreshed every 16 samples as the pitch glides.
  const ratio16 = Math.pow(f1 / f0, 16 / len);
  const dec = Math.exp(-1 / (tau * sr));
  const att = Math.max(1, attack * sr);
  let f = f0;
  let cr = 1;
  let sr1 = 0;
  let x = 1;
  let y = 0;
  let e = amp;
  for (let i = 0; i < len; i++) {
    if ((i & 15) === 0) {
      const w = (TAU * f) / sr;
      cr = Math.cos(w);
      sr1 = Math.sin(w);
      f *= ratio16;
    }
    const nx = x * cr - y * sr1;
    y = x * sr1 + y * cr;
    x = nx;
    const a = i < att ? i / att : 1;
    let idx = start + i;
    if (idx >= N) idx -= N;
    out[idx]! += y * e * a;
    e *= dec;
  }
}

/** Decaying noise burst through a one-pole lowpass (lp = 1 → raw, 0.05 → dull). */
export function addBurst(
  out: Float32Array, start: number, dur: number, tau: number, amp: number, sr: number,
  lp = 1, wrap = false,
): void {
  const N = out.length;
  start = Math.floor(start);
  let len = Math.ceil(dur * sr);
  len = Math.min(len, wrap ? N : N - start);
  const dec = Math.exp(-1 / (Math.max(1e-5, tau) * sr));
  let e = amp;
  let y = 0;
  for (let i = 0; i < len; i++) {
    y += lp * ((Math.random() * 2 - 1) * e - y);
    e *= dec;
    let idx = start + i;
    if (idx >= N) idx -= N;
    out[idx]! += y;
  }
}

/** Noise swell with a raised-sine envelope (swishes, wet sweeps). */
function addSwell(out: Float32Array, start: number, dur: number, amp: number, sr: number, lp = 0.3, hp = 0): void {
  const N = out.length;
  start = Math.floor(start);
  const len = Math.min(Math.ceil(dur * sr), N - start);
  let y = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const env = Math.sin((Math.PI * i) / len) ** 2;
    y += lp * ((Math.random() * 2 - 1) - y);
    const v = hp > 0 ? y - prev * (1 - hp) : y;
    prev = y;
    out[start + i]! += v * env * amp;
  }
}

/** Stick-slip friction: a jittered pulse train exciting a resonance (creaks, rubber squeaks). */
function addStickSlip(
  out: Float32Array, start: number, dur: number, rate0: number, rate1: number,
  fRes: number, amp: number, sr: number, jitter = 0.15,
): void {
  let t = 0;
  while (t < dur) {
    const u = t / dur;
    const env = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 1.5;
    const rate = rate0 + (rate1 - rate0) * u;
    addMode(out, start + t * sr, fRes * rand(0.97, 1.03), 0.0022, amp * env * rand(0.6, 1), sr);
    addMode(out, start + t * sr, fRes * 2.31, 0.0012, amp * env * 0.35, sr);
    t += (1 / rate) * (1 + (Math.random() * 2 - 1) * jitter);
  }
}

function rms(d: Float32Array): number {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i]! * d[i]!;
  return Math.sqrt(s / Math.max(1, d.length));
}

function normRms(buf: AudioBuffer, target: number): void {
  let s = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const r = rms(buf.getChannelData(c));
    s += r * r;
    n++;
  }
  const cur = Math.sqrt(s / n);
  if (cur <= 0) return;
  const k = target / cur;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i]! *= k;
  }
}

export function normPeak(buf: AudioBuffer, target: number): void {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]!));
  }
  if (p <= 0) return;
  const k = target / p;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i]! *= k;
  }
}

/** Fades the last few ms of a one-shot to zero so truncation never clicks. */
export function fadeTail(buf: AudioBuffer, seconds = 0.02): void {
  const n = Math.min(buf.length, Math.floor(seconds * buf.sampleRate));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[d.length - 1 - i]! *= i / n;
  }
}

function mk(ctx: BaseAudioContext, channels: number, seconds: number, sr = ctx.sampleRate): AudioBuffer {
  return ctx.createBuffer(channels, Math.max(2, Math.round(seconds * sr)), sr);
}

/** Generates `len + fade` samples with gen() and folds the tail into the head for a seamless loop. */
function seamless(len: number, fade: number, gen: (n: number) => Float32Array, out: Float32Array): void {
  const raw = gen(len + fade);
  for (let i = 0; i < len; i++) out[i] = raw[i]!;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.sin(t * Math.PI * 0.5);
    const b = Math.cos(t * Math.PI * 0.5);
    out[i] = raw[i]! * a + raw[len + i]! * b;
  }
}

// ---------------------------------------------------------------------------
// Noise beds
// ---------------------------------------------------------------------------

function whiteBed(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = mk(ctx, 2, seconds);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  normRms(b, 0.25);
  return b;
}

function pinkBed(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = mk(ctx, 2, seconds);
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let c = 0; c < 2; c++) {
    seamless(b.length, fade, (n) => {
      const o = new Float32Array(n);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        o[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
      return o;
    }, b.getChannelData(c));
  }
  normRms(b, 0.25);
  return b;
}

function brownBed(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = mk(ctx, 2, seconds);
  const fade = Math.floor(ctx.sampleRate * 0.25);
  // Leaky integrator (corner ~20 Hz) + DC blocker (~3 Hz).
  const leak = Math.exp((-TAU * 20) / ctx.sampleRate);
  const dcR = Math.exp((-TAU * 3) / ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    seamless(b.length, fade, (n) => {
      const o = new Float32Array(n);
      let y = 0;
      let x1 = 0;
      let h = 0;
      for (let i = 0; i < n; i++) {
        y = leak * y + (Math.random() * 2 - 1);
        h = y - x1 + dcR * h;
        x1 = y;
        o[i] = h;
      }
      return o;
    }, b.getChannelData(c));
  }
  normRms(b, 0.25);
  return b;
}

let modRateCache = 0;
/** Control-rate buffers want a low sample rate; old WebKit only accepts >= 22050 Hz. */
function modRate(ctx: BaseAudioContext): number {
  if (modRateCache) return modRateCache;
  try {
    ctx.createBuffer(1, 16, 8000);
    modRateCache = 8000;
  } catch {
    modRateCache = 22050;
  }
  return modRateCache;
}

/** Smooth value-noise in [-1,1]; seamless loop. Played into AudioParams as a modulator. */
function modBed(ctx: BaseAudioContext, seconds: number, octaves: readonly (readonly [number, number])[]): AudioBuffer {
  const sr = modRate(ctx);
  const b = ctx.createBuffer(1, Math.round(seconds * sr), sr);
  const d = b.getChannelData(0);
  for (const [hz, amp] of octaves) {
    const count = Math.max(2, Math.round(seconds * hz));
    const pts = new Float32Array(count);
    for (let i = 0; i < count; i++) pts[i] = Math.random() * 2 - 1;
    const spp = d.length / count;
    for (let i = 0; i < d.length; i++) {
      const x = i / spp;
      const i0 = Math.floor(x) % count;
      const i1 = (i0 + 1) % count;
      const t = x - Math.floor(x);
      const s = t * t * (3 - 2 * t);
      d[i]! += (pts[i0]! * (1 - s) + pts[i1]! * s) * amp;
    }
  }
  normPeak(b, 1);
  return b;
}

// ---------------------------------------------------------------------------
// Looping textures
// ---------------------------------------------------------------------------

function rainGround(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = mk(ctx, 2, 4);
  const density = 2400;
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    const N = d.length;
    // A diffuse floor of fine spray.
    let y = 0;
    for (let i = 0; i < N; i++) {
      y += 0.55 * ((Math.random() * 2 - 1) - y);
      d[i] = y * 0.12;
    }
    const count = Math.round(density * (N / sr));
    for (let k = 0; k < count; k++) {
      const s = Math.random() * N;
      const a = clamp(0.04 + 0.35 * expRand() ** 1.4, 0, 2);
      if (Math.random() < 0.9) {
        addBurst(d, s, rand(0.0006, 0.003), rand(0.0002, 0.0009), a, sr, rand(0.25, 0.9), true);
      } else {
        const f0 = rand(1300, 3600);
        addGlide(d, s, f0, f0 * rand(1.25, 1.8), rand(0.002, 0.005), a * 0.4, sr, true);
      }
    }
  }
  normRms(b, 0.25);
  return b;
}

const ROOF_MODES = [104, 147, 196, 262, 338, 452, 588, 776, 1020, 1350, 1790, 2380] as const;

function roofDrop(d: Float32Array, s: number, a: number, sr: number, lowBias: number, wrap: boolean): void {
  addBurst(d, s, rand(0.0004, 0.0012), 0.0003, a * 0.5, sr, rand(0.4, 0.85), wrap);
  for (let m = 0; m < 2; m++) {
    const idx = Math.floor(Math.pow(Math.random(), lowBias) * ROOF_MODES.length);
    const f = ROOF_MODES[Math.min(idx, ROOF_MODES.length - 1)]! * rand(0.93, 1.07);
    const tau = clamp(0.006 * Math.sqrt(400 / f) * rand(0.7, 1.4), 0.002, 0.03);
    addMode(d, s, f, tau, a * rand(0.25, 0.6), sr, wrap, 4.6);
  }
}

function roofDense(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = mk(ctx, 2, 3.5);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    const N = d.length;
    const count = Math.round(650 * (N / sr));
    for (let k = 0; k < count; k++) {
      roofDrop(d, Math.random() * N, 0.2 + 0.8 * Math.random() ** 2, sr, 1.3, true);
    }
  }
  normRms(b, 0.25);
  return b;
}

function roofSparse(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = mk(ctx, 2, 9.7);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    const N = d.length;
    const count = Math.round(14 * (N / sr));
    for (let k = 0; k < count; k++) {
      const s = Math.random() * N;
      let a = 0.3 + 0.7 * Math.random();
      if (Math.random() < 0.7) {
        if (Math.random() < 0.1) {
          a *= 1.8;
          addMode(d, s, rand(88, 130), 0.025, a * 0.8, sr, true);
        }
        roofDrop(d, s, a, sr, 1.9, true);
        roofDrop(d, s + rand(2, 30), a * 0.5, sr, 1.5, true);
      } else {
        // a drop on the windscreen: brighter tick, glassy ring
        addBurst(d, s, 0.0008, 0.00025, a * 0.5, sr, 0.9, true);
        addMode(d, s, rand(2200, 4200), rand(0.0015, 0.003), a * 0.3, sr, true);
        addMode(d, s, rand(600, 900), 0.004, a * 0.2, sr, true);
      }
    }
  }
  normPeak(b, 0.9);
  return b;
}

function hailBed(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = mk(ctx, 2, 3.3);
  const metal = [1100, 1750, 2600, 3500, 4700] as const;
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    const N = d.length;
    const count = Math.round(240 * (N / sr));
    for (let k = 0; k < count; k++) {
      const s = Math.random() * N;
      const a = 0.15 + 0.85 * Math.random() ** 2.5;
      addBurst(d, s, 0.0008, 0.0003, a * 0.6, sr, 0.8, true);
      addMode(d, s, pick(metal) * rand(0.9, 1.1), rand(0.004, 0.02), a * 0.4, sr, true, 4.6);
      addMode(d, s, pick(metal) * rand(0.9, 1.1), rand(0.003, 0.012), a * 0.25, sr, true, 4.6);
      if (Math.random() < 0.3) addMode(d, s, rand(120, 260), 0.015, a * 0.3, sr, true, 4.6);
    }
  }
  normRms(b, 0.25);
  return b;
}

function gravelBed(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = mk(ctx, 2, 3);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    const N = d.length;
    const count = Math.round(900 * (N / sr));
    for (let k = 0; k < count; k++) {
      const s = Math.random() * N;
      const a = clamp(0.1 + 0.4 * expRand() ** 1.5, 0, 1.2);
      addBurst(d, s, rand(0.001, 0.006), rand(0.0005, 0.002), a, sr, rand(0.3, 0.9), true);
      if (Math.random() < 0.06) addMode(d, s, rand(1500, 4000), 0.003, a * 0.4, sr, true);
    }
  }
  normRms(b, 0.25);
  return b;
}

// ---------------------------------------------------------------------------
// One-shot banks (mono)
// ---------------------------------------------------------------------------

function bank(ctx: BaseAudioContext, n: number, seconds: number, peak: number, fill: (d: Float32Array, sr: number, i: number) => void): AudioBuffer[] {
  const out: AudioBuffer[] = [];
  for (let i = 0; i < n; i++) {
    const b = mk(ctx, 1, seconds);
    fill(b.getChannelData(0), b.sampleRate, i);
    normPeak(b, peak);
    fadeTail(b);
    out.push(b);
  }
  return out;
}

const METAL_RATIOS = [1, 1.47, 2.09, 2.56, 3.24, 4.1] as const;

function clank(d: Float32Array, s: number, sr: number, f0: number, tauScale: number, amp: number): void {
  addBurst(d, s, 0.0015, 0.0004, 0.9 * amp, sr, 0.85);
  METAL_RATIOS.forEach((r, j) => {
    const f = f0 * r * rand(0.97, 1.03);
    addMode(d, s, f, (rand(0.03, 0.09) * tauScale) / (1 + j * 0.35), (amp * rand(0.3, 0.8)) / (1 + j * 0.4), sr);
  });
}

function glassShard(d: Float32Array, s: number, sr: number, a: number): void {
  addBurst(d, s, 0.0005, 0.00015, a * 0.5, sr, 1);
  addMode(d, s, rand(2500, 9000), rand(0.003, 0.025), a * 0.5, sr);
  addMode(d, s, rand(3000, 8000), rand(0.002, 0.012), a * 0.3, sr);
}

function tone(d: Float32Array, start: number, dur: number, f: number, amp: number, sr: number): void {
  const s0 = Math.floor(start * sr);
  const len = Math.floor(dur * sr);
  const att = Math.floor(0.003 * sr);
  const rel = Math.floor(0.008 * sr);
  for (let i = 0; i < len && s0 + i < d.length; i++) {
    const env = Math.min(1, i / att, (len - i) / rel);
    const ph = (TAU * f * i) / sr;
    // piezo-ish: odd harmonics
    d[s0 + i]! += amp * env * (Math.sin(ph) + 0.28 * Math.sin(3 * ph) + 0.1 * Math.sin(5 * ph));
  }
}

let cache: { sr: number; bank: SoundBank } | null = null;

/** Builds (or returns the cached) sound bank for the context's sample rate. ~100 ms of JS work. */
export function getSoundBank(ctx: BaseAudioContext): SoundBank {
  if (cache && cache.sr === ctx.sampleRate) return cache.bank;
  const sr = ctx.sampleRate;

  const b: SoundBank = {
    sr,
    white: whiteBed(ctx, 4),
    pink: pinkBed(ctx, 5),
    brown: brownBed(ctx, 7),
    modSlow: modBed(ctx, 48, [[0.18, 1], [0.45, 0.5], [1.1, 0.22]]),
    modMed: modBed(ctx, 24, [[3, 1], [7, 0.4]]),
    modFast: modBed(ctx, 12, [[9, 1], [21, 0.4]]),

    rainGround: rainGround(ctx),
    roofDense: roofDense(ctx),
    roofSparse: roofSparse(ctx),
    hailBed: hailBed(ctx),
    gravel: gravelBed(ctx),

    hailRoof: bank(ctx, 10, 0.4, 0.9, (d, sr) => {
      clank(d, 0, sr, rand(650, 1250), 1, 1);
      addMode(d, 0, rand(85, 170), rand(0.02, 0.04), 0.6, sr);
    }),
    hailHeavy: bank(ctx, 5, 0.7, 1, (d, sr) => {
      clank(d, 0, sr, rand(380, 700), 1.8, 1);
      addMode(d, 0, rand(65, 110), 0.06, 1.1, sr);
      addBurst(d, 0, 0.02, 0.008, 0.5, sr, 0.3);
    }),
    hailGround: bank(ctx, 10, 0.25, 0.8, (d, sr) => {
      addBurst(d, 0, rand(0.001, 0.003), 0.0005, 0.8, sr, 0.6);
      addMode(d, 0, rand(2500, 6000), 0.0015, 0.3, sr);
      let t = rand(0.04, 0.12);
      let a = 0.35;
      while (t < 0.22 && Math.random() < 0.8) {
        addBurst(d, t * sr, 0.001, 0.0004, a, sr, 0.6);
        addMode(d, t * sr, rand(2500, 6000), 0.001, a * 0.3, sr);
        t += rand(0.03, 0.07);
        a *= 0.5;
      }
    }),
    glassTick: bank(ctx, 6, 0.15, 0.85, (d, sr) => {
      addBurst(d, 0, 0.0008, 0.0002, 0.7, sr, 1);
      addMode(d, 0, rand(2300, 5200), rand(0.004, 0.012), 0.5, sr);
      addMode(d, 0, rand(2300, 5200), rand(0.004, 0.012), 0.35, sr);
      addMode(d, 0, rand(1200, 1600), 0.006, 0.25, sr);
    }),
    rattleClick: bank(ctx, 6, 0.08, 0.8, (d, sr) => {
      addBurst(d, 0, 0.001, 0.0003, 0.6, sr, 0.7);
      addMode(d, 0, rand(1800, 4000), rand(0.003, 0.006), 0.5, sr);
      addMode(d, 0, rand(700, 1200), 0.004, 0.3, sr);
      if (Math.random() < 0.5) {
        const t = rand(0.012, 0.03) * sr;
        addBurst(d, t, 0.001, 0.0003, 0.3, sr, 0.7);
        addMode(d, t, rand(1800, 4000), 0.004, 0.25, sr);
      }
    }),
    rattleCreak: bank(ctx, 5, 0.3, 0.7, (d, sr) => {
      const dur = rand(0.08, 0.22);
      addStickSlip(d, 0, dur, rand(90, 200), rand(150, 300), rand(650, 1500), 0.5, sr);
    }),
    rattleKnock: bank(ctx, 5, 0.15, 0.8, (d, sr) => {
      addBurst(d, 0, 0.0015, 0.0005, 0.5, sr, 0.5);
      addMode(d, 0, rand(150, 350), rand(0.012, 0.025), 0.9, sr);
      addMode(d, 0, rand(600, 900), 0.006, 0.35, sr);
    }),
    thud: bank(ctx, 4, 0.5, 0.95, (d, sr) => {
      addGlide(d, 0, rand(70, 85), rand(45, 52), 0.09, 1, sr, false, 0.004);
      addBurst(d, 0, 0.05, 0.02, 0.6, sr, 0.08);
      for (let i = 0; i < 4; i++) {
        const t = rand(0.005, 0.12) * sr;
        addMode(d, t, rand(1500, 3000), 0.004, rand(0.05, 0.15), sr);
      }
    }),
    pebble: bank(ctx, 8, 0.2, 0.85, (d, sr) => {
      addBurst(d, 0, 0.0008, 0.0002, 0.6, sr, 0.9);
      if (Math.random() < 0.65) {
        const f = rand(1800, 4500);
        addMode(d, 0, f, rand(0.008, 0.025), 0.6, sr);
        addMode(d, 0, f * 2.7, 0.006, 0.2, sr);
      } else {
        addMode(d, 0, rand(450, 900), rand(0.006, 0.01), 0.8, sr);
      }
    }),
    splat: bank(ctx, 4, 0.3, 0.85, (d, sr) => {
      addBurst(d, 0, 0.12, 0.04, 1, sr, 0.15);
      for (let i = 0; i < 5; i++) addBurst(d, rand(0, 0.06) * sr, 0.01, 0.004, 0.3, sr, 0.4);
      addGlide(d, rand(0.01, 0.03) * sr, rand(280, 360), rand(130, 170), 0.03, 0.4, sr);
    }),
    debrisWood: bank(ctx, 5, 0.6, 0.95, (d, sr) => {
      const hit = (t: number, a: number): void => {
        const s = t * sr;
        addBurst(d, s, 0.002, 0.0006, a, sr, 0.8);
        const f0 = rand(180, 420);
        [1, 2.3, 3.9, 5.6].forEach((r, j) => addMode(d, s, f0 * r * rand(0.96, 1.04), rand(0.015, 0.045) / (1 + j * 0.6), (a * 0.7) / (1 + j * 0.5), sr));
        addBurst(d, s, 0.025, 0.008, a * 0.6, sr, 0.6);
      };
      hit(0, 1);
      if (Math.random() < 0.7) hit(rand(0.08, 0.2), rand(0.3, 0.5));
    }),
    debrisMetal: bank(ctx, 5, 1.1, 0.95, (d, sr) => {
      addBurst(d, 0, 0.002, 0.0006, 0.8, sr, 0.9);
      for (let i = 0; i < 8; i++) {
        const f = 140 * Math.pow(1600 / 140, Math.random());
        addMode(d, 0, f, rand(0.12, 0.45) * Math.sqrt(300 / f), rand(0.1, 0.5), sr);
      }
      const t = rand(0.15, 0.4) * sr;
      clank(d, t, sr, rand(300, 600), 1.2, 0.4);
    }),
    debrisScatter: bank(ctx, 4, 0.8, 0.9, (d, sr) => {
      addBurst(d, 0, 0.3, 0.1, 0.3, sr, 0.5);
      const n = Math.floor(rand(15, 40));
      for (let i = 0; i < n; i++) {
        const t = Math.min(0.7, expRand() * 0.12) * sr;
        const a = rand(0.15, 0.6);
        addBurst(d, t, 0.001, 0.0004, a, sr, 0.7);
        if (Math.random() < 0.5) addMode(d, t, rand(1500, 5000), 0.002, a * 0.4, sr);
        else addMode(d, t, rand(250, 700), 0.006, a * 0.5, sr);
      }
    }),
    bodyHit: bank(ctx, 4, 0.6, 0.95, (d, sr) => {
      addGlide(d, 0, rand(85, 100), rand(50, 60), 0.07, 1, sr, false, 0.002);
      const f0 = rand(110, 220);
      [1, 1.6, 2.3, 3.1].forEach((r, j) => addMode(d, 0, f0 * r, rand(0.05, 0.15) / (1 + j * 0.4), 0.4 / (1 + j * 0.3), sr));
      addBurst(d, 0, 0.002, 0.0006, 0.5, sr, 0.8);
      addBurst(d, 0, 0.02, 0.008, 0.4, sr, 0.3);
    }),
    glassCrack: bank(ctx, 4, 0.3, 0.95, (d, sr) => {
      addBurst(d, 0, 0.0015, 0.0003, 1, sr, 1);
      for (let i = 0; i < 4; i++) addMode(d, 0, rand(3000, 8000), rand(0.005, 0.015), 0.35, sr);
      const n = Math.floor(rand(3, 8));
      for (let i = 0; i < n; i++) {
        const t = rand(0.005, 0.08) * sr;
        addBurst(d, t, 0.0006, 0.0002, rand(0.2, 0.5), sr, 1);
        addMode(d, t, rand(3000, 8000), 0.004, 0.15, sr);
      }
    }),
    shatter: bank(ctx, 4, 1.6, 0.95, (d, sr) => {
      addBurst(d, 0, 0.0015, 0.0003, 1, sr, 1);
      addBurst(d, 0, 0.06, 0.02, 0.7, sr, 0.9);
      for (let i = 0; i < 4; i++) addMode(d, 0, rand(3000, 8000), rand(0.005, 0.015), 0.35, sr);
      for (let i = 0; i < 140; i++) {
        const late = Math.random() < 0.2;
        const t = late ? rand(0.2, 1.4) : expRand() * 0.12;
        const a = (late ? rand(0.05, 0.25) : rand(0.15, 0.6)) * Math.exp(-t / 0.6);
        glassShard(d, Math.min(1.5, t) * sr, sr, a);
      }
    }),
    crunch: bank(ctx, 4, 1, 0.95, (d, sr) => {
      addGlide(d, 0, rand(85, 95), rand(32, 40), 0.12, 1, sr, false, 0.002);
      for (let i = 0; i < 250; i++) {
        const t = rand(0, 0.35);
        addBurst(d, t * sr, rand(0.002, 0.01), rand(0.001, 0.004), 0.5 * Math.exp(-t / 0.12) * rand(0.3, 1), sr, rand(0.1, 0.5));
      }
      for (let i = 0; i < 6; i++) addMode(d, rand(0, 0.05) * sr, rand(120, 900), rand(0.2, 0.5), rand(0.08, 0.2), sr);
    }),
    wiperDry: bank(ctx, 3, 0.4, 0.8, (d, sr) => {
      addStickSlip(d, 0, rand(0.07, 0.1), rand(600, 900), rand(350, 500), rand(1500, 2600), 0.35, sr, 0.08);
      const t = rand(0.085, 0.11) * sr;
      addMode(d, t, rand(120, 160), 0.025, 0.6, sr);
      addBurst(d, t, 0.006, 0.002, 0.35, sr, 0.4);
    }),
    wiperWet: bank(ctx, 3, 0.45, 0.8, (d, sr) => {
      addSwell(d, 0, 0.16, 0.45, sr, 0.35);
      addStickSlip(d, 0.08 * sr, 0.04, 500, 380, rand(1400, 2000), 0.08, sr, 0.1);
      const t = rand(0.13, 0.15) * sr;
      addMode(d, t, rand(120, 160), 0.025, 0.6, sr);
      addBurst(d, t, 0.006, 0.002, 0.3, sr, 0.4);
    }),
    doorOpen: bank(ctx, 2, 0.9, 0.85, (d, sr) => {
      addBurst(d, 0, 0.002, 0.0005, 0.7, sr, 0.9);
      [1100, 2050, 3300].forEach((f) => addMode(d, 0, f * rand(0.95, 1.05), rand(0.01, 0.025), 0.3, sr));
      addMode(d, 0.02 * sr, rand(65, 80), 0.03, 0.4, sr);
      addSwell(d, 0.03 * sr, 0.38, 0.18, sr, 0.25);
      addStickSlip(d, 0.15 * sr, 0.2, 60, 45, rand(500, 800), 0.06, sr, 0.25);
    }),
    doorClose: bank(ctx, 2, 0.9, 0.95, (d, sr) => {
      addGlide(d, 0, rand(68, 75), rand(43, 48), 0.1, 1, sr, false, 0.003);
      addBurst(d, 0, 0.12, 0.05, 0.9, sr, 0.06);
      const t = 0.008 * sr;
      addBurst(d, t, 0.002, 0.0005, 0.35, sr, 0.9);
      [900, 1700, 2600].forEach((f) => addMode(d, t, f * rand(0.95, 1.05), 0.012, 0.18, sr));
      addMode(d, 0, rand(170, 200), 0.08, 0.2, sr);
    }),
    beepStart: (() => {
      const bb = mk(ctx, 1, 0.2);
      tone(bb.getChannelData(0), 0.005, 0.15, 2400, 0.5, sr);
      return bb;
    })(),
    beepStop: (() => {
      const bb = mk(ctx, 1, 0.25);
      tone(bb.getChannelData(0), 0.005, 0.07, 2400, 0.5, sr);
      tone(bb.getChannelData(0), 0.135, 0.07, 2400, 0.5, sr);
      return bb;
    })(),
    uiClick: bank(ctx, 3, 0.03, 0.6, (d, sr) => {
      addBurst(d, 0, 0.001, 0.0003, 0.6, sr, 0.8);
      addMode(d, 0, rand(3500, 4500), 0.0015, 0.4, sr);
      addMode(d, 0, rand(1100, 1300), 0.002, 0.2, sr);
    }),
  };
  cache = { sr, bank: b };
  return b;
}
