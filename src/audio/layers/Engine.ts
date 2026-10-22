/**
 * Older carburetted-feel V8 SUV engine.
 *  - Tonal core: one oscillator at cam frequency (rpm/120) with a custom
 *    PeriodicWave — firing order (8th harmonic = rpm/60×4) and its harmonics,
 *    plus the half/quarter orders a cross-plane V8 gets from uneven bank
 *    firing (the burble), random phases for a lumpy waveform.
 *  - Load-dependent timbre: drive into a tanh shaper + lowpass that opens
 *    with throttle and rpm.
 *  - Combustion roughness: noise amplitude-modulated by a per-bank exhaust
 *    pulse train (rpm/30) — the putt-putt texture under the tone.
 *  - Cycle-to-cycle jitter on detune (lumpy idle).
 */
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';
import { MIX } from '../mix';
import { Smoothed, chain, clamp, fin, loopSource, makeFilter, makeGain, rand } from '../util';

function v8Wave(ctx: BaseAudioContext): PeriodicWave {
  const H = 96;
  const real = new Float32Array(H + 1);
  const imag = new Float32Array(H + 1);
  for (let n = 1; n <= H; n++) {
    let a: number;
    if (n % 8 === 0) a = 1 / Math.pow(n / 8, 0.85);
    else if (n % 4 === 0) a = 0.38 / Math.pow(n / 4, 0.6);
    else if (n % 2 === 0) a = 0.2 / Math.pow(n / 2, 0.5);
    else a = (0.07 * rand(0.5, 1.5)) / Math.pow(n, 0.3);
    const ph = Math.random() * Math.PI * 2;
    real[n] = a * Math.cos(ph);
    imag[n] = a * Math.sin(ph);
  }
  // Fixed RMS (0.3) instead of peak normalisation, so random phases never change the level.
  let sumSq = 0;
  for (let n = 1; n <= H; n++) sumSq += real[n]! * real[n]! + imag[n]! * imag[n]!;
  const k = 0.3 / Math.sqrt(sumSq / 2);
  for (let n = 1; n <= H; n++) {
    real[n]! *= k;
    imag[n]! *= k;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

function pulseWave(ctx: BaseAudioContext): PeriodicWave {
  const H = 10;
  const real = new Float32Array(H + 1);
  const imag = new Float32Array(H + 1);
  for (let n = 1; n <= H; n++) real[n] = 1 - (n - 1) / (H + 2);
  return ctx.createPeriodicWave(real, imag);
}

function tanhCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

export class EngineLayer {
  private readonly freq: Smoothed;
  private readonly firing: Smoothed;
  private readonly drive: Smoothed;
  private readonly post: Smoothed;
  private readonly lp: Smoothed;
  private readonly noise: Smoothed;
  private readonly noiseF: Smoothed;
  private readonly jitter: Smoothed;
  private readonly out: Smoothed;

  constructor(core: Core) {
    const { ctx, bank, bus } = core;

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(v8Wave(ctx));
    osc.frequency.value = 750 / 120;
    const drive = makeGain(ctx, 0.6);
    const shaper = ctx.createWaveShaper();
    shaper.curve = tanhCurve(1.6);
    const post = makeGain(ctx, 1);
    const lp = makeFilter(ctx, 'lowpass', 240, 0.8);
    const boom = makeFilter(ctx, 'peaking', 115, 1.1, 4);
    const out = makeGain(ctx, 0);
    chain(osc, drive, shaper, post, lp, boom, out, bus.vehicle);

    // combustion noise, pulsed at firing rate
    const fire = ctx.createOscillator();
    fire.setPeriodicWave(pulseWave(ctx));
    fire.frequency.value = 750 / 30;
    const vca = makeGain(ctx, 0.08);
    const depth = makeGain(ctx, 1);
    fire.connect(depth);
    depth.connect(vca.gain);
    const nbp = makeFilter(ctx, 'bandpass', 700, 0.9);
    const ng = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.white), vca, nbp, ng, out);

    // jitter (cents) on both oscillators
    const jit = makeGain(ctx, 20);
    loopSource(ctx, bank.modFast, 1).connect(jit);
    jit.connect(osc.detune);
    jit.connect(fire.detune);

    osc.start();
    fire.start();

    this.freq = new Smoothed(ctx, osc.frequency, 750 / 120, 0.035, 0.002, 0.01);
    this.firing = new Smoothed(ctx, fire.frequency, 750 / 30, 0.035, 0.002, 0.05);
    this.drive = new Smoothed(ctx, drive.gain, 0.6, 0.08);
    this.post = new Smoothed(ctx, post.gain, 1, 0.08);
    this.lp = new Smoothed(ctx, lp.frequency, 240, 0.06, 0.01, 2);
    this.noise = new Smoothed(ctx, ng.gain, 0, 0.08);
    this.noiseF = new Smoothed(ctx, nbp.frequency, 700, 0.06, 0.01, 2);
    this.jitter = new Smoothed(ctx, jit.gain, 20, 0.2);
    this.out = new Smoothed(ctx, out.gain, 0, 0.12);
  }

  update(s: AudioFrameState): void {
    const rpm = clamp(fin(s.engineRpm, 750), 300, 7500);
    const load = clamp(fin(s.engineLoad));
    const rpmN = clamp((rpm - 750) / 5250);

    this.freq.set(rpm / 120);
    this.firing.set(rpm / 30);
    const drv = 0.55 + 1.5 * load + 0.4 * rpmN;
    this.drive.set(drv);
    this.post.set(1 / (0.6 + 0.4 * drv));
    this.lp.set(200 + 380 * rpmN + 1800 * load * load * (0.3 + 0.7 * rpmN));
    this.noise.set(MIX.engNoise * (0.15 + 0.85 * load) * (0.5 + 0.5 * rpmN));
    this.noiseF.set(500 + 0.25 * rpm);
    this.jitter.set(6 + 24 * (1 - rpmN));
    const level = MIX.engine * (0.45 + 0.55 * Math.pow(rpmN, 1.3)) * (0.6 + 0.4 * Math.pow(load, 1.2));
    this.out.set(s.engineRunning ? level : 0, s.engineRunning ? 0.12 : 0.35);
  }
}
