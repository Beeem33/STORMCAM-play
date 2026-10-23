/**
 * The chaser screaming as the vortex carries him. A synthesised voice: a
 * glottal buzz (sawtooth with jitter) through three vowel formants for a raw
 * "aaah", pitch rising and cracking with vibrato, each scream 1.4–2.6 s with
 * a ragged gasp between. Direct bus — it's his own voice, right at the mic.
 */
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';

interface Voice {
  osc: OscillatorNode;
  noise: AudioBufferSourceNode;
  noiseGain: GainNode;
  out: GainNode;
}

export class ScreamLayer {
  private v: Voice | null = null;
  private t = 0;
  /** Time left in the current scream (>0) or gasp (<0 → counting up to 0). */
  private phase = 0;
  private screamLen = 2;
  private base = 440;
  private active = false;

  constructor(private readonly core: Core) {}

  private build(): Voice {
    const ctx = this.core.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.core.bus.direct);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 440;
    // Vowel "ah": three formants, summed.
    const formants: [number, number, number][] = [[820, 6, 1], [1250, 8, 0.55], [2850, 10, 0.25]];
    const pre = ctx.createGain();
    pre.gain.value = 0.6;
    osc.connect(pre);
    for (const [f, q, g] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const gg = ctx.createGain();
      gg.gain.value = g * 3;
      pre.connect(bp);
      bp.connect(gg);
      gg.connect(out);
    }
    // Breath and rasp.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1600;
    nf.Q.value = 0.8;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(nf);
    nf.connect(noiseGain);
    noiseGain.connect(out);
    osc.start();
    noise.start();
    return { osc, noise, noiseGain, out };
  }

  update(s: AudioFrameState, dt: number): void {
    const want = (s.screaming ?? 0) > 0.5;
    if (!want && !this.active) return;
    if (!this.v) this.v = this.build();
    const v = this.v;
    const now = this.core.now;
    if (!want) {
      this.active = false;
      v.out.gain.setTargetAtTime(0, now, 0.05);
      return;
    }
    if (!this.active) {
      this.active = true;
      this.phase = 0;
    }
    this.t += dt;
    if (this.phase <= 0) {
      this.phase += dt;
      if (this.phase >= 0) {
        // Start a new scream.
        this.screamLen = 1.4 + Math.random() * 1.2;
        this.phase = this.screamLen;
        this.base = 380 + Math.random() * 140;
      }
      // Gasp: breath noise, voice off.
      v.out.gain.setTargetAtTime(0.55, now, 0.02);
      v.noiseGain.gain.setTargetAtTime(0.5, now, 0.02);
      v.osc.frequency.setTargetAtTime(this.base * 0.6, now, 0.05);
      return;
    }
    this.phase -= dt;
    const k = 1 - this.phase / this.screamLen; // 0 → 1 through the scream
    // Pitch: a fast rise, a strained top with vibrato and jitter, a crack near the end.
    let f = this.base * (1 + 0.35 * Math.min(1, k * 4)) * (1 + 0.025 * Math.sin(this.t * 38)) * (1 + (Math.random() - 0.5) * 0.04);
    if (k > 0.8) f *= 1 + 0.25 * Math.sin((k - 0.8) * 40);
    v.osc.frequency.setTargetAtTime(f, now, 0.015);
    const env = Math.min(1, k * 12) * Math.min(1, (1 - k) * 8);
    v.out.gain.setTargetAtTime(0.42 * env, now, 0.02);
    v.noiseGain.gain.setTargetAtTime(0.18 * env, now, 0.02);
    if (this.phase <= 0) this.phase = -(0.25 + Math.random() * 0.25); // gasp next
  }
}
