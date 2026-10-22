/**
 * Wind: broadband body (pink noise, brightness follows speed), low-frequency
 * buffeting (rectified random AM — the "phone mic in the wind" fluff), and
 * door-seal whistle / howl (two resonant bandpasses that sweep with gusts).
 */
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';
import { MIX } from '../mix';
import { Smoothed, chain, clamp, loopSource, makeFilter, makeGain, rand, smoothstep } from '../util';

/** WaveShaper curve that half-wave rectifies a modulator: bursts with gaps between. */
export function rectifierCurve(threshold: number, power: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.pow(Math.max(0, (x - threshold) / (1 - threshold)), power);
  }
  return c;
}

export class WindLayer {
  private readonly bodyG: Smoothed;
  private readonly bodyF: Smoothed;
  private readonly flutter: Smoothed;
  private readonly buffet: Smoothed;
  private readonly whistle: Smoothed;
  private readonly wf1: Smoothed;
  private readonly wf2: Smoothed;
  private gust = 1;
  private gustTarget = 1;
  private gustTimer = 0;

  constructor(core: Core) {
    const { ctx, bank, bus } = core;

    // Body: pink → HP → LP(brightness) → gain → exterior
    const body = makeGain(ctx, 0);
    const lp = makeFilter(ctx, 'lowpass', 400, 0.5);
    chain(loopSource(ctx, bank.pink), makeFilter(ctx, 'highpass', 45, 0.6), lp, body, bus.exterior);
    this.bodyG = new Smoothed(ctx, body.gain, 0, 0.35);
    this.bodyF = new Smoothed(ctx, lp.frequency, 400, 0.4, 0.01, 2);
    // slow flutter riding on the body gain (audio-rate, no JS)
    const fl = makeGain(ctx, 0);
    loopSource(ctx, bank.modMed, 0.3).connect(fl);
    fl.connect(body.gain);
    this.flutter = new Smoothed(ctx, fl.gain, 0, 0.35);

    // Buffeting: pink → band 40..220 Hz → VCA driven by rectified fast random
    const vca = makeGain(ctx, 0);
    chain(
      loopSource(ctx, bank.pink),
      makeFilter(ctx, 'highpass', 40, 0.7),
      makeFilter(ctx, 'lowpass', 220, 0.8),
      vca,
      bus.exterior,
    );
    const shaper = ctx.createWaveShaper();
    shaper.curve = rectifierCurve(0.1, 1.5);
    const depth = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.modFast, 0.55), shaper, depth);
    depth.connect(vca.gain);
    this.buffet = new Smoothed(ctx, depth.gain, 0, 0.25);

    // Whistle / howl: white → 2 narrow bandpasses, wobbling
    const src = loopSource(ctx, bank.white);
    const bp1 = makeFilter(ctx, 'bandpass', 900, 22);
    const bp2 = makeFilter(ctx, 'bandpass', 1460, 30);
    const wg = makeGain(ctx, 0);
    src.connect(bp1);
    src.connect(bp2);
    bp1.connect(wg);
    bp2.connect(wg);
    const wob = makeGain(ctx, 35);
    chain(loopSource(ctx, bank.modMed, 0.4), wob);
    wob.connect(bp1.frequency);
    const wob2 = makeGain(ctx, 1.6);
    wob.connect(wob2);
    wob2.connect(bp2.frequency);
    wg.connect(bus.interior); // door-seal whistle (cabin)
    const outSend = makeGain(ctx, 0.5);
    wg.connect(outSend);
    outSend.connect(bus.exterior); // howl outside
    this.whistle = new Smoothed(ctx, wg.gain, 0, 0.4);
    this.wf1 = new Smoothed(ctx, bp1.frequency, 900, 0.6, 0.01, 2);
    this.wf2 = new Smoothed(ctx, bp2.frequency, 1460, 0.6, 0.01, 2);
  }

  update(s: AudioFrameState, dt: number): void {
    const inside = s.inVehicle;
    const ambient = Math.max(0, s.windSpeed);
    // Inside, the car's own motion adds airflow noise around the body.
    const w = inside ? Math.hypot(ambient, 0.75 * Math.max(0, s.vehicleSpeed)) : ambient;

    // Gust process (slow random target, eased).
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = rand(1.2, 4.5);
      const v = 0.12 + 0.33 * clamp(ambient / 30);
      this.gustTarget = clamp(1 + (Math.random() * 2 - 1) * v + (Math.random() < 0.2 ? v : 0), 0.5, 1.7);
    }
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt / 0.9));
    const g = this.gust;

    const wn = clamp(w / 40, 0, 1.6);
    const amp = Math.min(1.4, Math.pow(wn, 0.75));

    const bodyK = inside ? 1.5 : 1; // through the car body the exterior bus already cuts ~8 dB
    this.bodyG.set(MIX.windBody * bodyK * amp * g);
    this.flutter.set(MIX.windBody * bodyK * amp * 0.25);
    this.bodyF.set(inside ? 250 + 1600 * Math.min(wn, 1) * g : 380 + 3400 * Math.min(wn, 1) * g);

    const gustiness = clamp(ambient / 25);
    this.buffet.set(MIX.windBuffet * Math.pow(amp, 1.2) * (inside ? 0.3 : 1) * (0.4 + 0.6 * gustiness) * g);

    const wh = smoothstep(10, 32, w) * clamp(0.4 + 0.9 * (g - 0.75), 0.15, 1.3);
    this.whistle.set(MIX.windWhistle * wh * (inside ? 1 : 1.4));
    const f1 = (inside ? 700 : 380) + 850 * clamp((w - 10) / 50) + 420 * (g - 1);
    this.wf1.set(Math.max(200, f1));
    this.wf2.set(Math.max(300, f1 * 1.62));
  }
}
