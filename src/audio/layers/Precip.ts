/**
 * Rain and hail.
 *  Rain outside: hiss of drops on fields/road (granular texture).
 *  Rain inside: drumming on roof + windscreen (dense resonant drops, plus a
 *  sparse layer of individual fat drops that carries light rain).
 *  Hail: a dense metallic bed plus discrete Poisson-scheduled stones —
 *  clanks on roof/hood inside (occasionally a heavy one or a windscreen tick),
 *  sharp ticks and bounces on the ground outside.
 */
import type * as THREE from 'three';
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';
import { MIX } from '../mix';
import { Poisson, Smoothed, chain, clamp, loopSource, makeFilter, makeGain, pick, rand, smoothstep } from '../util';

export class PrecipLayer {
  private readonly rainOut: Smoothed;
  private readonly rainOutLP: Smoothed;
  private readonly roofDense: Smoothed;
  private readonly roofSparse: Smoothed;
  private readonly hailBedIn: Smoothed;
  private readonly hailBedOut: Smoothed;
  private readonly hailClock = new Poisson();

  constructor(private readonly core: Core) {
    const { ctx, bank, bus } = core;

    // --- rain on the ground (exterior) ---
    const ro = makeGain(ctx, 0);
    const roLP = makeFilter(ctx, 'lowpass', 9000, 0.5);
    chain(loopSource(ctx, bank.rainGround), makeFilter(ctx, 'highpass', 350, 0.6), roLP, ro, bus.exterior);
    this.rainOut = new Smoothed(ctx, ro.gain, 0, 0.6);
    this.rainOutLP = new Smoothed(ctx, roLP.frequency, 9000, 0.6, 0.01, 5);

    // --- roof drumming (interior) ---
    const rd = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.roofDense), makeFilter(ctx, 'lowpass', 4200, 0.6), rd, bus.interior);
    this.roofDense = new Smoothed(ctx, rd.gain, 0, 0.6);

    // Sparse fat drops: two copies at different rates so the pattern never audibly repeats.
    const rs = makeGain(ctx, 0);
    const p1 = ctx.createStereoPanner();
    p1.pan.value = -0.3;
    const p2 = ctx.createStereoPanner();
    p2.pan.value = 0.35;
    chain(loopSource(ctx, bank.roofSparse, 1), p1, rs);
    chain(loopSource(ctx, bank.roofSparse, 0.87), p2, rs);
    rs.connect(bus.interior);
    this.roofSparse = new Smoothed(ctx, rs.gain, 0, 0.6);

    // --- hail beds ---
    const hi = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.hailBed), makeFilter(ctx, 'highpass', 300, 0.6), hi, bus.interior);
    this.hailBedIn = new Smoothed(ctx, hi.gain, 0, 0.4);
    const ho = makeGain(ctx, 0);
    chain(loopSource(ctx, bank.rainGround, 1.4), makeFilter(ctx, 'highpass', 1500, 0.6), ho, bus.exterior);
    this.hailBedOut = new Smoothed(ctx, ho.gain, 0, 0.4);
  }

  update(s: AudioFrameState, dt: number): void {
    const r = clamp(s.rain);
    const h = clamp(s.hail);
    const inside = s.inVehicle;

    this.rainOut.set(MIX.rainOut * Math.pow(r, 0.7));
    this.rainOutLP.set(5000 + 5000 * r);
    this.roofDense.set(MIX.roofDense * Math.pow(r, 1.3));
    this.roofSparse.set(MIX.roofSparse * smoothstep(0, 0.12, r) * (1 - 0.55 * r));

    this.hailBedIn.set(MIX.hailBedIn * Math.pow(h, 1.5));
    this.hailBedOut.set(MIX.hailBedOut * h);

    const rate = (inside ? 28 : 40) * Math.pow(h, 1.2);
    const now = this.core.now;
    this.hailClock.step(rate, dt, (frac) => this.stone(inside, Math.random() * (0.4 + 0.6 * h), now + 0.03 + frac * dt));
  }

  /** One hailstone. Also used by AudioSystem.impact('hail'). */
  stone(inside: boolean, strength: number, when?: number, pos?: THREE.Vector3): void {
    const { bank, bus } = this.core;
    const st = clamp(strength, 0, 1.5);
    if (inside) {
      const roll = Math.random();
      if (roll < 0.07 || st > 1) {
        this.core.play(pick(bank.hailHeavy), bus.interior, MIX.hailIn * rand(1.1, 1.6) * Math.max(0.6, st), {
          when, rate: rand(0.85, 1.1), pan: rand(-0.7, 0.7),
        });
      } else if (roll < 0.3) {
        this.core.play(pick(bank.glassTick), bus.interior, MIX.hailIn * 0.7 * (0.3 + 0.7 * st), {
          when, rate: rand(0.9, 1.2), pan: rand(-0.5, 0.5),
        });
      } else {
        this.core.play(pick(bank.hailRoof), bus.interior, MIX.hailIn * (0.25 + 0.75 * st), {
          when, rate: rand(0.85, 1.2), pan: rand(-0.8, 0.8),
        });
      }
    } else {
      const opts = pos ? { when, rate: rand(0.85, 1.25), trackPos: pos } : { when, rate: rand(0.85, 1.25), pan: rand(-0.9, 0.9) };
      this.core.play(pick(bank.hailGround), bus.exterior, MIX.hailOut * (0.25 + 0.75 * st), opts);
      // the odd stone bouncing off the (nearby) car
      if (Math.random() < 0.06) {
        this.core.play(pick(bank.hailRoof), bus.exterior, MIX.hailOut * 0.5 * st, {
          when, rate: rand(0.9, 1.1), pan: rand(-0.8, 0.8), lowpass: 5000,
        });
      }
    }
  }
}
