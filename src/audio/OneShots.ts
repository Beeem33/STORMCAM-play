/**
 * Event sounds: thunder, impacts, wipers, doors, camera beeps, UI, wreck.
 * Each creates a few short-lived nodes that disconnect themselves.
 */
import * as THREE from 'three';
import type { ImpactKind } from './AudioTypes';
import type { Core, PlayOpts } from './Core';
import type { PrecipLayer } from './layers/Precip';
import { MIX } from './mix';
import { addBurst, addGlide, fadeTail, normPeak } from './SoundBank';
import { clamp, expRand, fin, lerp, makeFilter, makeGain, pick, rand } from './util';

/** Renders the close-strike crack: explosive blast + tearing crackle. */
function renderCrack(ctx: BaseAudioContext, close: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = 0.5 + 0.6 * close + rand(0, 0.3);
  const b = ctx.createBuffer(1, Math.round(len * sr), sr);
  const d = b.getChannelData(0);
  const bright = 0.45 + 0.5 * close;
  addBurst(d, 0, 0.012, 0.003, 1, sr, bright);
  addGlide(d, 0, rand(55, 70), rand(28, 34), 0.09, 0.8, sr, false, 0.002);
  const tearTau = 0.09 + 0.2 * close;
  let t = 0.004;
  // a couple of "rips": brief density spikes later in the tear
  const rips = [rand(0.05, 0.2), rand(0.15, 0.4)];
  while (t < len - 0.03) {
    const env = Math.exp(-t / tearTau);
    let density = 40 + 2600 * env;
    for (const r of rips) density += 1800 * Math.exp(-(((t - r) / 0.025) ** 2));
    const amp = (0.15 + 0.85 * Math.random() ** 2) * Math.max(env, 0.08 * Math.exp(-t / 0.5));
    addBurst(d, t * sr, rand(0.0003, 0.003), rand(0.0002, 0.001), amp, sr, bright * rand(0.6, 1));
    t += expRand() / density;
  }
  normPeak(b, 1);
  fadeTail(b, 0.05);
  return b;
}

/** Rolling-thunder gain envelope (peak 1), sampled at 60 Hz. */
function rumbleCurve(dur: number, near: boolean, close: number): Float32Array<ArrayBuffer> {
  const rate = 60;
  const n = Math.max(8, Math.ceil(dur * rate));
  const c = new Float32Array(n);
  const attack = near ? 0.03 + 0.12 * (1 - close) : rand(0.35, 1.1);
  const decay = dur * (near ? 0.32 : 0.4);
  const swells: [number, number, number][] = [];
  if (near) swells.push([rand(0.08, 0.25), rand(0.25, 0.5), 1.0]);
  const k = 3 + Math.floor(Math.random() * 4);
  for (let i = 0; i < k; i++) swells.push([rand(0.08, 0.85) * dur, rand(0.25, 1.2), rand(0.35, 1)]);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let sw = 0;
    for (const [ct, w, a] of swells) sw += a * Math.exp(-(((t - ct) / w) ** 2));
    const env = (1 - Math.exp(-t / attack)) * Math.exp(-t / decay);
    const tail = clamp((dur - t) / (dur * 0.12));
    const v = env * Math.pow(0.35 + sw, 0.8) * tail;
    c[i] = v;
    peak = Math.max(peak, v);
  }
  if (peak > 0) for (let i = 0; i < n; i++) c[i]! /= peak;
  c[0] = 0;
  c[n - 1] = 0;
  return c;
}

export class OneShots {
  rain = 0;
  private readonly tmpDir = new THREE.Vector3();

  constructor(private readonly core: Core, private readonly precip: PrecipLayer) {}

  thunder(distance: number, strength: number, direction?: THREE.Vector3): void {
    const { ctx, bank, bus, spatial } = this.core;
    const d = Math.max(30, fin(distance, 3000));
    const s = clamp(fin(strength, 1), 0, 1.5);
    if (s <= 0) return;
    const t0 = ctx.currentTime + d / 343 + 0.02;
    const loud = s * Math.min(1.4, Math.pow(300 / d, 0.6));
    const near = d < 800;
    const close = clamp(1 - d / 800);

    const dir = new THREE.Vector3();
    if (direction && direction.lengthSq() > 1e-8) dir.copy(direction).normalize();
    else {
      const a = Math.random() * Math.PI * 2;
      dir.copy(spatial.fwd).multiplyScalar(Math.cos(a)).addScaledVector(spatial.right, Math.sin(a));
    }

    const dur = near ? rand(4.5, 7) : rand(6, 9) + Math.min(6, d / 2000);

    // Rumble: brown → LP (closing over time) + pink → BP (mid "roll"), shared envelope.
    const env = makeGain(ctx, 0);
    const pan = ctx.createStereoPanner();
    const width = near ? 0.6 : 0.45;
    pan.pan.value = spatial.panForDir(dir) * width;
    env.connect(pan);
    pan.connect(bus.exterior);
    spatial.track(pan, t0 + dur + 0.2, width, undefined, dir);

    const brown = ctx.createBufferSource();
    brown.buffer = bank.brown;
    brown.loop = true;
    const lp = makeFilter(ctx, 'lowpass', 400, 0.6);
    const c0 = near ? lerp(380, 1500, close) : 120 + 380 * Math.exp(-(d - 800) / 2500);
    const c1 = near ? 170 : 85;
    lp.frequency.setValueAtTime(c0, t0);
    lp.frequency.setTargetAtTime(c1, t0 + 0.1, dur * 0.3);
    const g1 = makeGain(ctx, MIX.thunderRumble);
    const sub = makeFilter(ctx, 'highpass', 45, 0.7); // keep sub-bass from eating headroom
    brown.connect(sub);
    sub.connect(lp);
    lp.connect(g1);
    g1.connect(env);

    const pink = ctx.createBufferSource();
    pink.buffer = bank.pink;
    pink.loop = true;
    const bp = makeFilter(ctx, 'bandpass', near ? 260 : 160, 0.8);
    if (near) {
      bp.frequency.setValueAtTime(260, t0);
      bp.frequency.setTargetAtTime(160, t0 + 0.2, dur * 0.3);
    }
    const g2 = makeGain(ctx, MIX.thunderMid * (near ? 1 : 0.6));
    pink.connect(bp);
    bp.connect(g2);
    g2.connect(env);

    env.gain.setValueAtTime(0, ctx.currentTime);
    env.gain.setValueCurveAtTime(rumbleCurve(dur, near, close).map((v) => v * loud), t0, dur);
    brown.start(t0, Math.random() * (bank.brown.duration - 0.5));
    pink.start(t0, Math.random() * (bank.pink.duration - 0.5));
    brown.stop(t0 + dur + 0.05);
    pink.stop(t0 + dur + 0.05);
    brown.onended = () => {
      for (const n of [brown, pink, sub, lp, bp, g1, g2, env, pan]) n.disconnect();
    };

    // Crack for close strikes.
    if (near) {
      const crack = renderCrack(ctx, close);
      this.core.play(crack, bus.exterior, MIX.thunderCrack * s * Math.sqrt(close), {
        when: t0, trackDir: dir, trackWidth: 0.9, highpass: 90,
      });
    }
  }

  impact(kind: ImpactKind, strength: number, position?: THREE.Vector3): void {
    const { bank, bus, spatial } = this.core;
    const s = clamp(fin(strength, 0.5), 0, 1.5);
    if (s <= 0) return;
    const inside = spatial.inVehicle;
    let dist = 0;
    let att = 1;
    if (position) {
      dist = position.distanceTo(spatial.pos);
      att = Math.min(1, 10 / (dist + 6));
    }
    const onCar = !position || dist < 4;
    const ext = (extra: PlayOpts = {}): PlayOpts =>
      position ? { trackPos: position, lowpass: dist > 25 ? 3500 : undefined, ...extra } : { pan: rand(-0.4, 0.4), ...extra };

    switch (kind) {
      case 'hail':
        this.precip.stone(inside && onCar, s, undefined, position);
        break;
      case 'debris': {
        if (inside && onCar) {
          this.core.play(pick(bank.bodyHit), bus.interior, MIX.body * 0.8 * s, { rate: rand(0.9, 1.25), pan: rand(-0.6, 0.6) });
          this.core.play(pick(bank.debrisScatter), bus.exterior, MIX.debris * 0.6 * s, { pan: rand(-0.6, 0.6) });
        } else {
          const r = Math.random();
          const buf = r < 0.4 ? pick(bank.debrisWood) : r < 0.7 ? pick(bank.debrisScatter) : pick(bank.debrisMetal);
          this.core.play(buf, bus.exterior, MIX.debris * s * att, ext({ rate: rand(0.8, 1.2) }));
        }
        break;
      }
      case 'collision': {
        const dest = inside ? bus.interior : bus.exterior;
        const o = inside ? { pan: rand(-0.3, 0.3) } : ext();
        this.core.play(pick(bank.crunch), dest, MIX.collision * s * (inside ? 1 : att), { ...o, rate: rand(0.85, 1.1) });
        if (inside) this.core.play(pick(bank.bodyHit), bus.interior, MIX.body * s, { rate: rand(0.8, 1) });
        if (s > 0.6) this.core.play(pick(bank.glassCrack), dest, MIX.glass * s * (inside ? 1 : att), { ...o, when: this.core.now + 0.01 });
        break;
      }
      case 'glass': {
        const dest = inside ? bus.interior : bus.exterior;
        const buf = s < 0.55 ? pick(bank.glassCrack) : pick(bank.shatter);
        this.core.play(buf, dest, MIX.glass * (0.4 + 0.6 * s) * (inside ? 1 : att), inside ? { pan: rand(-0.6, 0.6) } : ext({ rate: rand(0.9, 1.1) }));
        break;
      }
      case 'body': {
        const dest = inside && onCar ? bus.interior : bus.exterior;
        this.core.play(pick(bank.bodyHit), dest, MIX.body * s * (inside && onCar ? 1 : att), inside && onCar ? { pan: rand(-0.6, 0.6), rate: rand(0.85, 1.2) } : ext({ rate: rand(0.85, 1.2) }));
        break;
      }
    }
  }

  wiperStroke(): void {
    const { bank, bus, spatial } = this.core;
    const wet = this.rain > 0.12;
    const buf = wet ? pick(bank.wiperWet) : pick(bank.wiperDry);
    this.core.play(buf, spatial.inVehicle ? bus.interior : bus.exterior, MIX.wiper * (spatial.inVehicle ? 1 : 0.4), {
      rate: rand(0.95, 1.05), pan: rand(-0.15, 0.15),
    });
  }

  door(open: boolean): void {
    const { bank, bus } = this.core;
    this.core.play(pick(open ? bank.doorOpen : bank.doorClose), bus.direct, MIX.door, { rate: rand(0.96, 1.04), pan: -0.35 });
  }

  /**
   * Grass and roots tearing out of the ground under his fist: a run of dry
   * crackles over a ripping noise, then the clod's thump.
   */
  grassRip(): void {
    const { ctx, bank, bus } = this.core;
    const now = ctx.currentTime;
    const rip = (when: number, dur: number, freq: number, gain: number): void => {
      const src = ctx.createBufferSource();
      src.buffer = bank.white;
      src.playbackRate.value = rand(0.9, 1.1);
      const f = makeFilter(ctx, 'bandpass', freq, 0.9);
      const g = makeGain(ctx, 0);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(gain, when + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
      src.connect(f);
      f.connect(g);
      g.connect(bus.direct);
      src.start(when, Math.random() * 3, dur + 0.05);
      src.onended = () => g.disconnect();
    };
    rip(now, 0.32, 1800, 0.55);
    for (let i = 0; i < 9; i++) rip(now + Math.random() * 0.28, 0.03 + Math.random() * 0.04, rand(2500, 5500), rand(0.3, 0.6));
    rip(now + 0.05, 0.18, 300, 0.5);
  }

  /** His hand slapping down and closing on a fresh patch of grass. */
  grassGrab(): void {
    const { ctx, bank, bus } = this.core;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = bank.pink;
    const f = makeFilter(ctx, 'lowpass', 1400, 0.7);
    const g = makeGain(ctx, 0);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.8, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.22);
    src.connect(f);
    f.connect(g);
    g.connect(bus.direct);
    src.start(now, Math.random() * 3, 0.3);
    src.onended = () => g.disconnect();
  }

  recordBeep(start: boolean): void {
    const { bank, bus } = this.core;
    this.core.play(start ? bank.beepStart : bank.beepStop, bus.direct, MIX.beep);
  }

  uiClick(): void {
    const { bank, bus } = this.core;
    this.core.play(pick(bank.uiClick), bus.direct, MIX.ui, { rate: rand(0.97, 1.03) });
  }

  vehicleDestroyed(): void {
    const { ctx, bank, bus, spatial } = this.core;
    const dest = spatial.inVehicle ? bus.interior : bus.exterior;
    const now = ctx.currentTime;
    const P = (buf: AudioBuffer, gain: number, dt: number, rate = 1, pan = rand(-0.4, 0.4)): void =>
      this.core.play(buf, dest, gain, { when: now + dt, rate, pan });

    P(pick(bank.crunch), MIX.collision * 1.2, 0, 0.8);
    P(pick(bank.bodyHit), MIX.body * 1.1, 0.03, 0.75);
    P(pick(bank.shatter), MIX.glass * 1.2, 0.02, 1, -0.5);
    P(pick(bank.crunch), MIX.collision * 0.7, 0.12, 0.65);
    P(pick(bank.shatter), MIX.glass * 0.6, 0.35, 1.15, 0.6);
    P(pick(bank.debrisScatter), MIX.debris * 0.8, 0.25, 0.9);
    for (let i = 0; i < 12; i++) {
      const t = 0.4 + Math.random() * 1.8;
      P(pick(bank.glassTick), MIX.glass * 0.35 * Math.exp(-(t - 0.4) / 0.9), t, rand(1.1, 1.6), rand(-0.8, 0.8));
    }

    // Metal groan: brown noise through a sliding resonant band.
    const src = ctx.createBufferSource();
    src.buffer = bank.brown;
    src.loop = true;
    const bp = makeFilter(ctx, 'bandpass', 210, 9);
    bp.frequency.setValueAtTime(rand(200, 240), now + 0.15);
    bp.frequency.exponentialRampToValueAtTime(rand(110, 140), now + 1.7);
    const g = makeGain(ctx, 0);
    g.gain.setValueAtTime(0, now + 0.15);
    g.gain.linearRampToValueAtTime(MIX.collision * 1.6, now + 0.45);
    g.gain.setTargetAtTime(0, now + 0.9, 0.35);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(now + 0.15, Math.random() * 3);
    src.stop(now + 2.8);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
  }
}
