/**
 * Shared plumbing for the audio layers: the routing buses, the listener pose
 * (stereo panning from world positions/directions) and the one-shot player.
 */
import * as THREE from 'three';
import type { SoundBank } from './SoundBank';
import { clamp } from './util';

export interface Buses {
  /** Outside world: muffled by the car body when inVehicle. */
  exterior: AudioNode;
  /** Cabin-only sounds (roof drumming, rattles, seal whistle): silent when outside. */
  interior: AudioNode;
  /** Own vehicle (engine, tyres): firewall/floor filtered inside, distant-ish outside. */
  vehicle: AudioNode;
  /** Unprocessed (UI, camera beep, doors). */
  direct: AudioNode;
}

interface Voice {
  panner: StereoPannerNode;
  pos: THREE.Vector3 | null;
  dir: THREE.Vector3 | null;
  width: number;
  end: number;
  last: number;
}

export class Spatial {
  readonly pos = new THREE.Vector3();
  readonly fwd = new THREE.Vector3(0, 0, -1);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly right = new THREE.Vector3(1, 0, 0);
  inVehicle = true;
  private readonly voices: Voice[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();

  setPose(p: THREE.Vector3, f: THREE.Vector3, u: THREE.Vector3): void {
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) this.pos.copy(p);
    if (f.lengthSq() > 1e-8 && u.lengthSq() > 1e-8) {
      this.tmpR.crossVectors(f, u);
      if (this.tmpR.lengthSq() > 1e-8) {
        this.fwd.copy(f).normalize();
        this.up.copy(u).normalize();
        this.right.copy(this.tmpR).normalize();
      }
    }
  }

  /** Stereo pan (-1..1) for a world-space direction from the listener. */
  panForDir(dir: THREE.Vector3): number {
    const t = this.tmp.copy(dir);
    t.addScaledVector(this.up, -t.dot(this.up));
    const l = t.length();
    if (l < 1e-6) return 0;
    return clamp(t.dot(this.right) / l, -1, 1) * (this.inVehicle ? 0.75 : 1);
  }

  /** 1 = straight ahead, -1 = directly behind. */
  frontForDir(dir: THREE.Vector3): number {
    const t = this.tmp.copy(dir);
    t.addScaledVector(this.up, -t.dot(this.up));
    const l = t.length();
    if (l < 1e-6) return 1;
    return clamp(t.dot(this.fwd) / l, -1, 1);
  }

  panForPos(p: THREE.Vector3): number {
    return this.panForDir(this.tmpR.subVectors(p, this.pos));
  }

  /** Keeps a long one-shot's pan correct while the listener turns. */
  track(panner: StereoPannerNode, end: number, width: number, pos?: THREE.Vector3, dir?: THREE.Vector3): void {
    if (!pos && !dir) return;
    this.voices.push({
      panner,
      pos: pos ? pos.clone() : null,
      dir: dir ? dir.clone() : null,
      width,
      end,
      last: panner.pan.value,
    });
  }

  update(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i]!;
      if (now > v.end) {
        this.voices.splice(i, 1);
        continue;
      }
      const p = (v.pos ? this.panForPos(v.pos) : this.panForDir(v.dir!)) * v.width;
      if (Math.abs(p - v.last) < 0.01) continue;
      v.last = p;
      v.panner.pan.setTargetAtTime(p, now, 0.08);
    }
  }

  clear(): void {
    this.voices.length = 0;
  }
}

export interface PlayOpts {
  when?: number;
  rate?: number;
  pan?: number;
  /** Track this world position for the voice lifetime (long sounds). */
  trackPos?: THREE.Vector3;
  trackDir?: THREE.Vector3;
  trackWidth?: number;
  /** Optional filter inserted after the gain. */
  lowpass?: number;
  highpass?: number;
}

export class Core {
  constructor(
    readonly ctx: BaseAudioContext,
    readonly bank: SoundBank,
    readonly bus: Buses,
    readonly spatial: Spatial,
  ) {}

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Fire-and-forget buffer playback. Nodes disconnect themselves when done. */
  play(buf: AudioBuffer, dest: AudioNode, gain: number, o: PlayOpts = {}): void {
    if (!(gain > 1e-5)) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = o.rate ?? 1;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    const nodes: AudioNode[] = [src, g];
    let last: AudioNode = g;
    if (o.lowpass !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      last.connect(f);
      last = f;
      nodes.push(f);
    }
    if (o.highpass !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = o.highpass;
      last.connect(f);
      last = f;
      nodes.push(f);
    }
    const when = Math.max(ctx.currentTime, o.when ?? ctx.currentTime);
    const needsPan = o.pan !== undefined || o.trackPos || o.trackDir;
    if (needsPan) {
      const p = ctx.createStereoPanner();
      let pan = o.pan ?? 0;
      if (o.trackPos) pan = this.spatial.panForPos(o.trackPos) * (o.trackWidth ?? 1);
      else if (o.trackDir) pan = this.spatial.panForDir(o.trackDir) * (o.trackWidth ?? 1);
      p.pan.value = clamp(pan, -1, 1);
      last.connect(p);
      last = p;
      nodes.push(p);
      const dur = buf.duration / rate;
      if (dur > 0.6 && (o.trackPos || o.trackDir)) {
        this.spatial.track(p, when + dur, o.trackWidth ?? 1, o.trackPos, o.trackDir);
      }
    }
    last.connect(dest);
    src.onended = () => {
      for (const n of nodes) n.disconnect();
    };
    src.start(when);
  }
}
