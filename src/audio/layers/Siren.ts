/**
 * Outdoor warning sirens: a distant mechanical wail rising and falling over
 * the plains while a tornado is down. Two slightly detuned tones through a
 * band-pass (the horn), swept slowly up and down, with a gentle waver as the
 * sound carries over a couple of miles. Exterior bus, so it's muffled in the
 * truck.
 */
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';
import { clamp, fin } from '../util';

export class SirenLayer {
  private nodes: { osc: OscillatorNode[]; gain: GainNode } | null = null;
  private level = 0;
  private phase = Math.random() * 10;

  constructor(private readonly core: Core) {}

  private build(): { osc: OscillatorNode[]; gain: GainNode } {
    const ctx = this.core.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const horn = ctx.createBiquadFilter();
    horn.type = 'bandpass';
    horn.frequency.value = 700;
    horn.Q.value = 1.2;
    // Distance: the top end is gone by the time it reaches you.
    const far = ctx.createBiquadFilter();
    far.type = 'lowpass';
    far.frequency.value = 1500;
    horn.connect(far);
    far.connect(gain);
    gain.connect(this.core.bus.exterior);
    const osc = [0, 7].map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 420;
      o.detune.value = cents;
      o.connect(horn);
      o.start();
      return o;
    });
    return { osc, gain };
  }

  update(s: AudioFrameState, dt: number): void {
    const want = clamp(fin(s.siren ?? 0));
    this.level += (want - this.level) * (1 - Math.exp(-dt / 2.5));
    if (this.level < 0.002 && !this.nodes) return;
    if (!this.nodes) this.nodes = this.build();
    this.phase += dt;
    // Wail: ~8 s cycle, slow rise to the top note, long fall.
    const cyc = (this.phase % 8) / 8;
    const sweep = cyc < 0.45 ? Math.sin((cyc / 0.45) * Math.PI * 0.5) : Math.cos(((cyc - 0.45) / 0.55) * Math.PI * 0.5);
    const f = 380 + sweep * 430 + Math.sin(this.phase * 0.7) * 6;
    const now = this.core.now;
    for (const o of this.nodes.osc) o.frequency.setTargetAtTime(f, now, 0.05);
    // Carried on the wind: the level swells and fades a little.
    const carry = 0.75 + 0.25 * Math.sin(this.phase * 0.31) * Math.sin(this.phase * 0.17 + 1.1);
    this.nodes.gain.gain.setTargetAtTime(this.level * 0.07 * carry * (0.5 + 0.5 * sweep), now, 0.08);
  }
}
