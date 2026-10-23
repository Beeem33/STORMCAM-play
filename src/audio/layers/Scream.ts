/**
 * The chaser screaming as the vortex carries him. Recorded male screams
 * (public/audio/scream-*.mp3) played one after another in random order with
 * a ragged breath between, each slightly re-pitched so repeats don't sound
 * identical. Until the recordings have loaded (or if they fail) it falls back
 * to a synthesised voice: a glottal buzz (sawtooth with jitter) through male
 * vowel formants for a raw "aaah", pitch rising and cracking. Direct bus —
 * it's his own voice, right at the mic.
 */
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';

/** Recorded screams, relative to the site root. */
const SCREAM_FILES = ['audio/scream-1.mp3', 'audio/scream-2.mp3', 'audio/scream-3.mp3'];

interface Voice {
  osc: OscillatorNode;
  noise: AudioBufferSourceNode;
  noiseGain: GainNode;
  out: GainNode;
}

export class ScreamLayer {
  private v: Voice | null = null;
  private samples: AudioBuffer[] = [];
  private loading = false;
  private current: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private lastPick = -1;
  /** Seconds until the next recorded scream starts (the breath between). */
  private nextIn = 0;
  private t = 0;
  /** Time left in the current scream (>0) or gasp (<0 → counting up to 0). */
  private phase = 0;
  private screamLen = 2;
  private base = 440;
  private active = false;

  constructor(private readonly core: Core) {}

  /** Fetch and decode the recordings once, in the background. */
  private load(): void {
    if (this.loading) return;
    this.loading = true;
    const ctx = this.core.ctx;
    const base = import.meta.env.BASE_URL;
    for (const f of SCREAM_FILES) {
      fetch(base + f)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${f}: ${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => this.samples.push(buf))
        .catch(() => undefined);
    }
  }

  /** Recorded screams back to back while `want`; returns false if there are none to play. */
  private updateSamples(want: boolean, dt: number): boolean {
    if (this.samples.length === 0) return false;
    const ctx = this.core.ctx;
    const now = this.core.now;
    if (!want) {
      if (this.current) {
        this.current.gain.gain.setTargetAtTime(0, now, 0.04);
        this.current.src.stop(now + 0.3);
        this.current = null;
      }
      this.nextIn = 0;
      return true;
    }
    this.nextIn -= dt;
    if (this.nextIn > 0) return true;
    let pick = Math.floor(Math.random() * this.samples.length);
    if (pick === this.lastPick && this.samples.length > 1) pick = (pick + 1) % this.samples.length;
    this.lastPick = pick;
    const buf = this.samples[pick];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = 0.94 + Math.random() * 0.1;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = 0.95;
    src.connect(gain);
    gain.connect(this.core.bus.direct);
    src.start(now);
    src.onended = () => gain.disconnect();
    this.current = { src, gain };
    this.nextIn = buf.duration / rate + 0.15 + Math.random() * 0.35;
    return true;
  }

  private build(): Voice {
    const ctx = this.core.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.core.bus.direct);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 440;
    // Vowel "ah": three formants, summed.
    const formants: [number, number, number][] = [[750, 7, 1], [1150, 9, 0.5], [2500, 12, 0.22], [3400, 14, 0.1]];
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
    this.load();
    if (this.updateSamples(want, dt)) {
      if (this.active && this.v) this.v.out.gain.setTargetAtTime(0, this.core.now, 0.05);
      this.active = false;
      return;
    }
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
        this.base = 210 + Math.random() * 70;
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
