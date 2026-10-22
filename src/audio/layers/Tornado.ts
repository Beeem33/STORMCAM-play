/**
 * Tornado: a continuous deep "freight train" rumble (brown noise with a slow
 * rolling chug), a broadband roar whose brightness rises as it gets close,
 * a 150–300 Hz growl band (what you hear on small speakers) and, very close,
 * a turbulent jet-like whoosh. Panned by direction, centred inside the core.
 * Random debris impacts are scheduled when within 4 core radii.
 */
import * as THREE from 'three';
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';
import { MIX } from '../mix';
import { Poisson, Smoothed, chain, clamp, dbToGain, interpTable, loopSource, makeFilter, makeGain, rand, smoothstep } from '../util';
import { rectifierCurve } from './Wind';

/** Level vs horizontal distance (m → dB). Audible from ~3 km, overwhelming inside ~400 m. */
const LEVEL_DB: readonly (readonly [number, number])[] = [
  [0, 0],
  [150, 0],
  [400, -6.5],
  [1000, -15],
  [2000, -24],
  [3000, -31],
  [4000, -45],
  [4600, -90],
];

export type DebrisFn = (pos: THREE.Vector3, strength: number, nearCar: boolean) => void;

export class TornadoLayer {
  private readonly master: Smoothed;
  private readonly roar: Smoothed;
  private readonly roarLP: Smoothed;
  private readonly rumble: Smoothed;
  private readonly growl: Smoothed;
  private readonly jet: Smoothed;
  private readonly shadow: Smoothed;
  private readonly pan: Smoothed;
  private readonly chug: Smoothed;
  private readonly debrisClock = new Poisson();
  private readonly bodyClock = new Poisson();
  private readonly dir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly core: Core, private readonly onDebris: DebrisFn) {
    const { ctx, bank, bus } = core;

    const mix = makeGain(ctx, 1);
    const level = makeGain(ctx, 0);
    const swellVca = makeGain(ctx, 1);
    const shadowLP = makeFilter(ctx, 'lowpass', 16000, 0.5);
    const panner = ctx.createStereoPanner();
    chain(mix, level, swellVca, shadowLP, panner, bus.exterior);
    this.master = new Smoothed(ctx, level.gain, 0, 0.5);
    this.shadow = new Smoothed(ctx, shadowLP.frequency, 16000, 0.3, 0.01, 10);
    this.pan = new Smoothed(ctx, panner.pan, 0, 0.2, 0, 0.01);
    // slow swelling of the whole vortex sound (±20 %, audio-rate, no JS)
    const swell = makeGain(ctx, 0.2);
    loopSource(ctx, bank.modSlow, 1.6).connect(swell);
    swell.connect(swellVca.gain);

    // Roar: pink → LP (brightness by proximity)
    const roar = makeGain(ctx, 0);
    const roarLP = makeFilter(ctx, 'lowpass', 300, 0.6);
    chain(loopSource(ctx, bank.pink), makeFilter(ctx, 'highpass', 35, 0.6), roarLP, roar, mix);
    this.roar = new Smoothed(ctx, roar.gain, 0, 0.5);
    this.roarLP = new Smoothed(ctx, roarLP.frequency, 300, 0.6, 0.01, 2);

    // Rumble: brown → LP 95 Hz → VCA with a rolling "chug"
    const rumble = makeGain(ctx, 0);
    const rumbleVca = makeGain(ctx, 0.75);
    chain(loopSource(ctx, bank.brown), makeFilter(ctx, 'highpass', 30, 0.7), makeFilter(ctx, 'lowpass', 95, 0.9), rumbleVca, rumble, mix);
    const sh = ctx.createWaveShaper();
    sh.curve = rectifierCurve(-0.3, 1.2);
    const chugDepth = makeGain(ctx, 0.4);
    chain(loopSource(ctx, bank.modMed, 1.4), sh, chugDepth);
    chugDepth.connect(rumbleVca.gain);
    this.rumble = new Smoothed(ctx, rumble.gain, 0, 0.5);
    this.chug = new Smoothed(ctx, chugDepth.gain, 0.4, 0.5);

    // Growl: pink → BP ~220 Hz (audible on laptop speakers)
    const growl = makeGain(ctx, 0);
    const gbp = makeFilter(ctx, 'bandpass', 220, 1.2);
    chain(loopSource(ctx, bank.pink), gbp, growl, mix);
    const gw = makeGain(ctx, 40);
    loopSource(ctx, bank.modMed, 0.7).connect(gw);
    gw.connect(gbp.frequency);
    this.growl = new Smoothed(ctx, growl.gain, 0, 0.5);

    // Jet: white → BP ~1.2 kHz, only very close
    const jet = makeGain(ctx, 0);
    const jbp = makeFilter(ctx, 'bandpass', 1200, 2);
    chain(loopSource(ctx, bank.white), jbp, jet, mix);
    const jw = makeGain(ctx, 300);
    loopSource(ctx, bank.modMed, 0.9).connect(jw);
    jw.connect(jbp.frequency);
    this.jet = new Smoothed(ctx, jet.gain, 0, 0.4);
  }

  update(s: AudioFrameState, dt: number): void {
    const t = s.tornado;
    if (!t || !t.active) {
      this.master.set(0, 0.8);
      return;
    }
    const d = Math.max(0, Number.isFinite(t.distance) ? t.distance : 1e5);
    const I = clamp(t.intensity);
    const R = Math.max(5, Number.isFinite(t.radius) ? t.radius : 50);

    const db = interpTable(LEVEL_DB, d);
    const lvl = db <= -89 ? 0 : dbToGain(db) * (0.35 + 0.65 * I);
    // proximity 0 at 3 km → 1 at 100 m (log scale)
    const p = clamp(1 - Math.log(Math.max(d, 100) / 100) / Math.log(30));

    this.master.set(lvl);
    this.roar.set(MIX.tornRoar);
    this.roarLP.set(160 + 2600 * Math.pow(p, 1.6));
    this.rumble.set(MIX.tornRumble * (0.6 + 0.4 * (1 - p)));
    this.growl.set(MIX.tornGrowl);
    this.jet.set(MIX.tornJet * smoothstep(0.55, 1, p) * (0.3 + 0.7 * I));
    this.chug.set(0.25 + 0.25 * (1 - p));

    // Direction: pan, and a gentle head-shadow lowpass when it is behind.
    this.dir.subVectors(t.position, this.core.spatial.pos);
    const width = clamp((d - R) / (2 * R));
    const pan = this.core.spatial.panForDir(this.dir) * width;
    this.pan.set(pan);
    const front = this.core.spatial.frontForDir(this.dir);
    this.shadow.set(front >= 0 ? 16000 : 16000 - 10000 * (-front) * width);

    // Debris within 4 radii.
    if (d < R * 4) {
      const near = 1 - d / (R * 4);
      const rate = (1.5 + 9 * I) * Math.pow(near, 1.2);
      this.debrisClock.step(rate, dt, () => {
        // somewhere around the listener, biased toward the vortex
        const ang = Math.atan2(this.dir.z, this.dir.x) + rand(-1.4, 1.4);
        const r = rand(4, 45) * (0.4 + 0.6 * (1 - near));
        this.tmp.set(Math.cos(ang) * r, rand(-1, 4), Math.sin(ang) * r).add(this.core.spatial.pos);
        this.onDebris(this.tmp, rand(0.25, 1) * (0.4 + 0.6 * I), false);
      });
      // inside the core: things hitting the car itself
      if (d < R * 1.3 && s.inVehicle) {
        this.bodyClock.step(1.5 * I * (1 - d / (R * 1.3)) + 0.3, dt, () => {
          this.tmp.copy(this.core.spatial.pos);
          this.onDebris(this.tmp, rand(0.4, 1) * (0.5 + 0.5 * I), true);
        });
      }
    }
  }
}
