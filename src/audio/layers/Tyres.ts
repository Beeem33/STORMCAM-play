/**
 * Tyres / road: asphalt roar (+ wet hiss), gravel crunch texture whose grain
 * rate follows speed with stones pinging the wheel wells, grass swish, mud
 * squelch with splatter, sub rumble from uneven ground, and skid squeal on
 * asphalt (narrow resonant noise with a chaotic wobble).
 */
import type { AudioFrameState, Surface } from '../AudioTypes';
import type { Core } from '../Core';
import { MIX } from '../mix';
import { Poisson, Smoothed, chain, clamp, fin, loopSource, makeFilter, makeGain, pick, rand, smoothstep } from '../util';

export class TyreLayer {
  private readonly roar: Smoothed;
  private readonly roarF: Smoothed;
  private readonly rumble: Smoothed;
  private readonly wet: Smoothed;
  private readonly gravel: Smoothed;
  private readonly gravelRate: Smoothed;
  private readonly grass: Smoothed;
  private readonly mud: Smoothed;
  private readonly squeal: Smoothed;
  private readonly sq1: Smoothed;
  private readonly sq2: Smoothed;
  private readonly w: Record<Surface, number> = { asphalt: 1, gravel: 0, grass: 0, mud: 0 };
  private readonly pebbleClock = new Poisson();
  private readonly splatClock = new Poisson();

  constructor(private readonly core: Core) {
    const { ctx, bank, bus } = core;
    const out = bus.vehicle;

    const roar = makeGain(ctx, 0);
    const rbp = makeFilter(ctx, 'bandpass', 600, 0.6);
    chain(loopSource(ctx, bank.pink), rbp, roar, out);
    this.roar = new Smoothed(ctx, roar.gain, 0, 0.15);
    this.roarF = new Smoothed(ctx, rbp.frequency, 600, 0.2, 0.01, 2);

    const rumble = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.brown), makeFilter(ctx, 'lowpass', 110, 0.8), rumble, out);
    this.rumble = new Smoothed(ctx, rumble.gain, 0, 0.1);

    const wet = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.white), makeFilter(ctx, 'bandpass', 2000, 0.5), wet, out);
    this.wet = new Smoothed(ctx, wet.gain, 0, 0.2);

    const gsrc = loopSource(ctx, bank.gravel);
    const gravel = makeGain(ctx, 0);
    chain(gsrc, makeFilter(ctx, 'bandpass', 1800, 0.5), gravel, out);
    this.gravel = new Smoothed(ctx, gravel.gain, 0, 0.12);
    this.gravelRate = new Smoothed(ctx, gsrc.playbackRate, 1, 0.2, 0.01, 0.01);

    // grass swish: pink → BP 2.5 kHz → VCA swept by random mod
    const grass = makeGain(ctx, 0);
    const gvca = makeGain(ctx, 0.7);
    chain(loopSource(ctx, bank.pink), makeFilter(ctx, 'bandpass', 2500, 0.8), gvca, grass, out);
    const gm = makeGain(ctx, 0.45);
    loopSource(ctx, bank.modMed, 1.3).connect(gm);
    gm.connect(gvca.gain);
    this.grass = new Smoothed(ctx, grass.gain, 0, 0.15);

    // mud squelch: pink → BP 500 Hz, wobbling filter
    const mud = makeGain(ctx, 0);
    const mbp = makeFilter(ctx, 'bandpass', 500, 1.5);
    const mvca = makeGain(ctx, 0.7);
    chain(loopSource(ctx, bank.pink), mbp, mvca, mud, out);
    const mm = makeGain(ctx, 160);
    loopSource(ctx, bank.modMed, 2).connect(mm);
    mm.connect(mbp.frequency);
    const ma = makeGain(ctx, 0.4);
    loopSource(ctx, bank.modFast, 0.6).connect(ma);
    ma.connect(mvca.gain);
    this.mud = new Smoothed(ctx, mud.gain, 0, 0.15);

    // skid squeal: white → two narrow BPs with chaotic pitch wobble
    const sq = makeGain(ctx, 0);
    const src = loopSource(ctx, bank.white);
    const b1 = makeFilter(ctx, 'bandpass', 1150, 25);
    const b2 = makeFilter(ctx, 'bandpass', 2300, 25);
    src.connect(b1);
    src.connect(b2);
    const b2g = makeGain(ctx, 0.5);
    b1.connect(sq);
    b2.connect(b2g);
    b2g.connect(sq);
    sq.connect(out);
    const wob = makeGain(ctx, 45);
    loopSource(ctx, bank.modFast, 1.5).connect(wob);
    wob.connect(b1.frequency);
    const wob2 = makeGain(ctx, 2);
    wob.connect(wob2);
    wob2.connect(b2.frequency);
    this.squeal = new Smoothed(ctx, sq.gain, 0, 0.06);
    this.sq1 = new Smoothed(ctx, b1.frequency, 1150, 0.2, 0.01, 2);
    this.sq2 = new Smoothed(ctx, b2.frequency, 2300, 0.2, 0.01, 2);
  }

  update(s: AudioFrameState, dt: number): void {
    const v = Math.max(0, fin(s.vehicleSpeed));
    const slip = clamp(fin(s.tireSlip));
    const bump = clamp(fin(s.bumpiness));
    const k = 1 - Math.exp(-dt / 0.12);
    for (const key of ['asphalt', 'gravel', 'grass', 'mud'] as const) {
      this.w[key] += ((s.surface === key ? 1 : 0) - this.w[key]) * k;
    }
    const { asphalt, gravel, grass, mud } = this.w;
    const vN = clamp(v / 35, 0, 1.3);
    const moving = smoothstep(0.2, 2, v);
    const wetness = clamp(fin(s.rain) * 3);

    this.roar.set(MIX.road * Math.pow(vN, 1.3) * (asphalt + 0.35 * (gravel + grass + mud)));
    this.roarF.set(180 + 22 * Math.min(v, 45));
    this.rumble.set(MIX.roadRumble * vN * (0.5 + 1.5 * bump) * (1 + 0.6 * (gravel + grass + mud)));
    this.wet.set(MIX.wet * wetness * Math.pow(vN, 1.2) * (asphalt + 0.4 * (1 - asphalt)));

    this.gravel.set(MIX.gravel * Math.pow(clamp(v / 18), 0.9) * gravel * (1 + 0.8 * slip) * moving);
    this.gravelRate.set(clamp(0.7 + v / 30, 0.7, 1.6));
    this.grass.set(MIX.grass * clamp(v / 15) * grass * (1 + 0.5 * slip) * moving);
    this.mud.set(MIX.mud * clamp(v / 12) * mud * (1 + 0.7 * slip) * moving);

    const sq = smoothstep(0.3, 0.8, slip) * smoothstep(1.5, 6, v) * asphalt;
    this.squeal.set(MIX.squeal * sq);
    this.sq1.set(1050 + 250 * slip);
    this.sq2.set((1050 + 250 * slip) * 2.02);

    const now = this.core.now;
    const { bank, bus } = this.core;
    this.pebbleClock.step(gravel * moving * ((v / 20) * 5 + slip * 6), dt, (f) => {
      this.core.play(pick(bank.pebble), bus.vehicle, MIX.pebble * rand(0.3, 1), {
        when: now + 0.02 + f * dt, rate: rand(0.85, 1.2), pan: rand(-0.7, 0.7),
      });
    });
    this.splatClock.step(mud * moving * ((v / 20) * 3 + slip * 3), dt, (f) => {
      this.core.play(pick(bank.splat), bus.vehicle, MIX.splat * rand(0.3, 1), {
        when: now + 0.02 + f * dt, rate: rand(0.8, 1.2), pan: rand(-0.6, 0.6),
      });
    });
  }
}
