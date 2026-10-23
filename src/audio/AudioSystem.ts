/**
 * STORMCAM procedural audio. The world is fully synthesised with Web Audio —
 * see layers/ for each sound source. The one recording is the menu music,
 * which skips the world's dynamics and goes straight to the master volume.
 *
 * Graph:
 *   exterior bus → LP (car-body muffling) → cabin-boom peak → gain ┐
 *   interior bus → gain (0 when outside) ──────────────────────────┤
 *   vehicle bus  → LP (firewall/floor) → gain ─────────────────────┼→ mix → HP 24 Hz
 *   direct bus ────────────────────────────────────────────────────┘
 *   → world level → compressor (glue) → trim → limiter → master volume/mute → destination
 *   menu music → music gain ───────────────────────────────┘
 */
import type * as THREE from 'three';
import type { AudioFrameState, ImpactKind } from './AudioTypes';
import { Core, Spatial } from './Core';
import { CabinLayer } from './layers/Cabin';
import { EngineLayer } from './layers/Engine';
import { PrecipLayer } from './layers/Precip';
import { TornadoLayer } from './layers/Tornado';
import { TyreLayer } from './layers/Tyres';
import { WindLayer } from './layers/Wind';
import { ScreamLayer } from './layers/Scream';
import { OneShots } from './OneShots';
import { getSoundBank } from './SoundBank';
import { Smoothed, clamp, dbToGain, fin, lerp, makeFilter, makeGain } from './util';

export interface AudioSystemOptions {
  /** Use an existing context (e.g. an OfflineAudioContext for level measurement). */
  context?: BaseAudioContext;
  /** Skip compressor/limiter (measurement only). */
  bypassDynamics?: boolean;
}

/** Gain that undoes the compressor's automatic makeup gain (spec: (1/fullRangeGain)^0.6). */
const COMP_TRIM_DB = -4.2;

interface Graph {
  core: Core;
  wind: WindLayer;
  precip: PrecipLayer;
  tornado: TornadoLayer;
  engine: EngineLayer;
  tyres: TyreLayer;
  cabin: CabinLayer;
  scream: ScreamLayer;
  shots: OneShots;
  extLP: Smoothed;
  extBoom: Smoothed;
  extGain: Smoothed;
  intGain: Smoothed;
  vehLP: Smoothed;
  vehGain: Smoothed;
  world: Smoothed;
  volume: Smoothed;
  output: AudioNode;
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

export class AudioSystem {
  private ctx: BaseAudioContext | null = null;
  /** The context we created ourselves (resume/close it); null for an injected context. */
  private live: AudioContext | null = null;
  private g: Graph | null = null;
  private volume = 0.8;
  private muted = false;
  private disposed = false;
  private failed = false;
  private music: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private musicBuf: Promise<AudioBuffer | null> | null = null;
  private musicWanted = false;

  constructor(private readonly opts: AudioSystemOptions = {}) {}

  /** Called from a user gesture; creates/resumes the AudioContext. Idempotent. */
  unlock(): void {
    if (this.disposed || this.failed) return;
    try {
      if (!this.ctx) {
        if (this.opts.context) {
          this.ctx = this.opts.context;
        } else {
          const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
          const Ctor = w.AudioContext ?? w.webkitAudioContext;
          if (!Ctor) {
            this.failed = true;
            return;
          }
          this.live = new Ctor({ latencyHint: 'interactive' });
          this.ctx = this.live;
        }
        this.g = this.build(this.ctx);
      }
      const live = this.live;
      if (live && live.state !== 'running' && live.state !== 'closed') {
        live.resume().catch(() => undefined);
      }
    } catch (e) {
      console.warn('[audio] unlock failed', e);
      this.failed = true;
    }
  }

  setMasterVolume(v: number): void {
    this.volume = clamp(fin(v, 0.8));
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    this.muted = !!m;
    this.applyVolume();
  }

  /**
   * Start the menu music (looping, fading in). Call after unlock(). Does
   * nothing if it's already playing; the file is fetched once and kept.
   */
  playMusic(url: string, fadeIn = 2): void {
    const g = this.g;
    if (!g || this.music) {
      this.musicWanted = !!g;
      return;
    }
    this.musicWanted = true;
    this.musicBuf ??= fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => g.core.ctx.decodeAudioData(b))
      .catch((e) => {
        this.warn(e);
        return null;
      });
    void this.musicBuf.then((buf) => {
      if (!buf || !this.musicWanted || this.music || this.g !== g) return;
      const ctx = g.core.ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.9, ctx.currentTime, fadeIn / 3);
      gain.connect(g.output);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start();
      this.music = { src, gain };
    });
  }

  /** Fade the menu music out and stop it. */
  stopMusic(fadeOut = 1.5): void {
    this.musicWanted = false;
    const m = this.music;
    if (!m || !this.g) return;
    this.music = null;
    const now = this.g.core.ctx.currentTime;
    m.gain.gain.cancelScheduledValues(now);
    m.gain.gain.setTargetAtTime(0, now, fadeOut / 4);
    this.safe(() => m.src.stop(now + fadeOut + 0.5));
  }

  /** Level of the game world (everything but the music): 0 for the intro, low under the menu, 1 in play. */
  setWorldLevel(v: number, tau = 0.6): void {
    this.safe(() => this.g!.world.set(clamp(fin(v, 1)), tau));
  }

  /** Called every frame. Cheap; a no-op before unlock(). */
  update(s: AudioFrameState): void {
    const g = this.g;
    if (!g) return;
    try {
      this.step(g, s);
    } catch (e) {
      this.warn(e);
    }
  }

  private step(g: Graph, s: AudioFrameState): void {
    const dt = clamp(fin(s.dt, 1 / 60), 0, 0.1);
    const core = g.core;
    core.spatial.setPose(s.listenerPos, s.listenerForward, s.listenerUp);
    core.spatial.inVehicle = !!s.inVehicle;

    // inside / outside
    const wd = clamp(fin(s.windowDamage));
    const nyq = core.ctx.sampleRate * 0.45;
    if (s.inVehicle) {
      g.extLP.set(lerp(850, 9000, Math.pow(wd, 0.8)));
      g.extBoom.set(2.5 * (1 - wd));
      g.extGain.set(lerp(0.42, 0.9, wd));
      g.intGain.set(1);
      g.vehLP.set(lerp(2000, 7000, wd));
      g.vehGain.set(1);
    } else {
      g.extLP.set(Math.min(18000, nyq));
      g.extBoom.set(0);
      g.extGain.set(1);
      g.intGain.set(0);
      g.vehLP.set(Math.min(9000, nyq));
      g.vehGain.set(0.55);
    }

    g.wind.update(s, dt);
    g.precip.update(s, dt);
    g.tornado.update(s, dt);
    g.scream.update(s, dt);
    g.engine.update(s);
    g.tyres.update(s, dt);
    g.cabin.update(s, dt);
    g.shots.rain = clamp(fin(s.rain));
    core.spatial.update(core.ctx.currentTime);
  }

  /** Thunder heard after distance/343 s. Close (<800 m): crack + heavy rumble; far: low rolling rumble. */
  thunder(distance: number, strength: number, direction?: THREE.Vector3): void {
    this.safe(() => this.g?.shots.thunder(distance, strength, direction));
  }

  impact(kind: ImpactKind, strength: number, position?: THREE.Vector3): void {
    this.safe(() => this.g?.shots.impact(kind, strength, position));
  }

  wiperStroke(): void {
    this.safe(() => this.g?.shots.wiperStroke());
  }

  door(open: boolean): void {
    this.safe(() => this.g?.shots.door(open));
  }

  grassRip(): void {
    this.safe(() => this.g?.shots.grassRip());
  }

  grassGrab(): void {
    this.safe(() => this.g?.shots.grassGrab());
  }

  recordBeep(start: boolean): void {
    this.safe(() => this.g?.shots.recordBeep(start));
  }

  uiClick(): void {
    this.safe(() => this.g?.shots.uiClick());
  }

  vehicleDestroyed(): void {
    this.safe(() => this.g?.shots.vehicleDestroyed());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const live = this.live;
    if (this.g) {
      this.g.core.spatial.clear();
      try {
        this.g.output.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.g = null;
    this.ctx = null;
    this.live = null;
    if (live && live.state !== 'closed') {
      live.close().catch(() => undefined);
    }
  }

  /** Debug/dev: the context (null before unlock). */
  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  /** Debug/dev: final output node (post volume), for meters. */
  get outputNode(): AudioNode | null {
    return this.g?.output ?? null;
  }

  // -------------------------------------------------------------------------

  private warned = 0;

  /** Audio must never take the game down: log (a few times) and carry on. */
  private warn(e: unknown): void {
    if (this.warned++ < 3) console.warn('[audio]', e);
  }

  private safe(fn: () => void): void {
    if (!this.g) return;
    try {
      fn();
    } catch (e) {
      this.warn(e);
    }
  }

  private applyVolume(): void {
    this.g?.volume.set(this.muted ? 0 : this.volume, 0.05);
  }

  private build(ctx: BaseAudioContext): Graph {
    const bank = getSoundBank(ctx);
    const nyq = ctx.sampleRate * 0.45;

    // master chain
    const volume = makeGain(ctx, 0);
    volume.connect(ctx.destination);
    const mix = makeGain(ctx, 1);
    const world = makeGain(ctx, 1);
    const hp = makeFilter(ctx, 'highpass', 24, 0.7);
    mix.connect(world);
    world.connect(hp);
    if (this.opts.bypassDynamics) {
      hp.connect(volume);
    } else {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 2.5;
      comp.attack.value = 0.02;
      comp.release.value = 0.4;
      const trim = makeGain(ctx, dbToGain(COMP_TRIM_DB));
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -1.5;
      lim.knee.value = 0;
      lim.ratio.value = 20;
      lim.attack.value = 0.002;
      lim.release.value = 0.1;
      hp.connect(comp);
      comp.connect(trim);
      trim.connect(lim);
      lim.connect(volume);
    }

    // buses
    const extIn = makeGain(ctx, 1);
    const extLP = makeFilter(ctx, 'lowpass', 850, 0.6);
    const extBoom = makeFilter(ctx, 'peaking', 120, 1, 2.5);
    const extOut = makeGain(ctx, 0.42);
    extIn.connect(extLP);
    extLP.connect(extBoom);
    extBoom.connect(extOut);
    extOut.connect(mix);

    const intIn = makeGain(ctx, 1);
    const intOut = makeGain(ctx, 1);
    intIn.connect(intOut);
    intOut.connect(mix);

    const vehIn = makeGain(ctx, 1);
    const vehLP = makeFilter(ctx, 'lowpass', 2000, 0.6);
    const vehOut = makeGain(ctx, 1);
    vehIn.connect(vehLP);
    vehLP.connect(vehOut);
    vehOut.connect(mix);

    const dirIn = makeGain(ctx, 1);
    dirIn.connect(mix);

    const spatial = new Spatial();
    const core = new Core(ctx, bank, { exterior: extIn, interior: intIn, vehicle: vehIn, direct: dirIn }, spatial);

    const precip = new PrecipLayer(core);
    const shots = new OneShots(core, precip);
    const g: Graph = {
      core,
      wind: new WindLayer(core),
      precip,
      tornado: new TornadoLayer(core, (pos, strength, nearCar) =>
        shots.impact(nearCar ? 'body' : 'debris', strength, nearCar ? undefined : pos),
      ),
      engine: new EngineLayer(core),
      tyres: new TyreLayer(core),
      cabin: new CabinLayer(core),
      scream: new ScreamLayer(core),
      shots,
      extLP: new Smoothed(ctx, extLP.frequency, 850, 0.08, 0.01, 5),
      extBoom: new Smoothed(ctx, extBoom.gain, 2.5, 0.08, 0.01, 0.05),
      extGain: new Smoothed(ctx, extOut.gain, 0.42, 0.08),
      intGain: new Smoothed(ctx, intOut.gain, 1, 0.08),
      vehLP: new Smoothed(ctx, vehLP.frequency, Math.min(2000, nyq), 0.08, 0.01, 5),
      vehGain: new Smoothed(ctx, vehOut.gain, 1, 0.08),
      world: new Smoothed(ctx, world.gain, 1, 0.6, 0.001, 1e-4),
      volume: new Smoothed(ctx, volume.gain, 0, 0.05, 0.001, 1e-5),
      output: volume,
    };
    this.g = g;
    this.applyVolume();
    return g;
  }
}
