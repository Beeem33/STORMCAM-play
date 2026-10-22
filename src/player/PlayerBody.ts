import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { patchObject } from '../rendering/Atmosphere';
import { clamp, damp } from '../utils/MathUtils';

/**
 * The chaser's own body, seen from his chest-mounted bodycam: rigged mesh
 * from `models/chaser_person_build.py`, head hidden in first person, animation
 * blended from walking speed and wind strain. The camera rides the `ChestCam`
 * empty, so the walk cycle moves the shot the way a real body camera moves.
 *
 * Each clip is split into an arms layer and a body layer, so the arms can
 * hold a probe (`Carry`) over any gait, and the gait's arm swing can be
 * toned down without touching the legs.
 */

const URL_GLB = `${import.meta.env.BASE_URL}models/chaser_person.glb`;
const _qRoot = new THREE.Quaternion();
const ARM_TRACK = /^(shoulder|upperarm|forearm|hand|thumb\d|index\d|middle\d|ring\d|pinky\d)_[LR]\.|^CarryPoint\./;
/** How much of the gait clips' own arm swing to keep (the rest is the relaxed Idle arms). */
const ARM_SWING = 0.35;

interface Layered {
  body: THREE.AnimationAction;
  arms: THREE.AnimationAction | null;
}

export class PlayerBody {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly clips = new Map<string, Layered>();
  private chestCam: THREE.Object3D | null = null;
  /** Where a carried probe sits (on the right hand), or the body root as a fallback. */
  carryPoint: THREE.Object3D = this.root;
  hasCarryPose = false;
  private carryW = 0;
  private place: { action: THREE.AnimationAction; t: number; touchdown: number; done: (() => void) | null } | null = null;
  private yaw = 0;
  loaded = false;

  constructor() {
    this.root.name = 'player-body';
    this.root.visible = false;
  }

  async load(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(URL_GLB);
    const model = gltf.scene;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.frustumCulled = false; // skinned bounds don't follow the animation
      if (/PersonHead/i.test(m.name) || /PersonHead/i.test(m.parent?.name ?? '')) m.visible = false;
      // The lens can't see its own housing.
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (/^Cam/.test(mat.name)) mat.visible = false;
    });
    patchObject(model);
    this.root.add(model);
    this.chestCam = model.getObjectByName('ChestCam') ?? model.getObjectByName('Eye') ?? null;
    const cp = model.getObjectByName('CarryPoint');
    if (cp) this.carryPoint = cp;
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const name = clip.name.toLowerCase();
      if (name.includes('place')) {
        const a = this.mixer.clipAction(clip);
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        this.clips.set('place', { body: a, arms: null });
        continue;
      }
      const armTracks = clip.tracks.filter((t) => ARM_TRACK.test(t.name));
      const bodyTracks = clip.tracks.filter((t) => !ARM_TRACK.test(t.name));
      const body = this.mixer.clipAction(new THREE.AnimationClip(clip.name + ':body', clip.duration, bodyTracks));
      const arms = armTracks.length ? this.mixer.clipAction(new THREE.AnimationClip(clip.name + ':arms', clip.duration, armTracks)) : null;
      for (const a of [body, arms]) {
        if (!a) continue;
        a.play();
        a.setEffectiveWeight(0);
      }
      this.clips.set(name, { body, arms });
    }
    this.hasCarryPose = this.clips.has('carry');
    this.setWeights({ idle: 1 }, { idle: 1 });
    // Reference chest orientation: standing still at the start of Idle.
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
    if (this.chestCam) {
      this.root.getWorldQuaternion(_qRoot).invert();
      this.chestRest = this.chestCam.getWorldQuaternion(new THREE.Quaternion()).premultiply(_qRoot).invert();
    }
    this.loaded = true;
  }

  private setWeights(body: Record<string, number>, arms: Record<string, number>): void {
    for (const [name, l] of this.clips) {
      if (name === 'place') continue;
      l.body.setEffectiveWeight(body[name] ?? 0);
      l.arms?.setEffectiveWeight(arms[name] ?? 0);
    }
  }

  /** Bend down and set the carried probe on the ground; `onTouchdown` fires when it touches. */
  playPlace(onTouchdown: () => void, touchdownFraction = 0.55): boolean {
    const p = this.clips.get('place');
    if (!p || !this.loaded) {
      onTouchdown();
      return false;
    }
    p.body.reset().play();
    p.body.setEffectiveWeight(1);
    this.place = { action: p.body, t: 0, touchdown: p.body.getClip().duration * touchdownFraction, done: onTouchdown };
    return true;
  }

  /** True while a one-shot action (placing a probe) has the body. */
  get busy(): boolean {
    return this.place !== null;
  }

  /**
   * @param pos feet position
   * @param lookYaw where the torso faces (bodycam yaw)
   * @param speed horizontal speed m/s
   * @param strain 0..1 how hard the wind is pushing
   * @param carrying holding a probe in both hands
   */
  update(dt: number, visible: boolean, pos: THREE.Vector3, lookYaw: number, speed: number, strain: number, carrying = false): void {
    this.root.visible = visible && this.loaded;
    if (!this.loaded || !visible || !this.mixer) return;
    this.yaw = lookYaw;
    this.root.position.copy(pos);
    this.root.rotation.set(0, this.yaw, 0);
    const walk = clamp(speed / 1.6, 0, 1);
    const run = clamp((speed - 2.2) / 2, 0, 1);
    const brace = carrying ? 0 : clamp(strain * 1.4, 0, 1);
    const moving = Math.max(walk, run);
    const wIdle = (1 - moving) * (1 - brace);
    const wWalk = walk * (1 - run) * (1 - brace * 0.6);
    const wRun = run * (1 - brace * 0.6);
    this.carryW = damp(this.carryW, carrying && this.hasCarryPose ? 1 : 0, 10, dt);
    // A one-shot place takes the whole body while it plays.
    let placeW = 0;
    if (this.place) {
      const p = this.place;
      p.t += dt;
      if (p.done && p.t >= p.touchdown) {
        p.done();
        p.done = null;
      }
      const dur = p.action.getClip().duration;
      placeW = clamp(Math.min(p.t / 0.15, (dur - p.t) / 0.25), 0, 1);
      p.action.setEffectiveWeight(placeW);
      if (p.t >= dur) {
        p.action.stop();
        this.place = null;
        placeW = 0;
      }
    }
    const k = 1 - placeW;
    const c = this.carryW;
    // Arms: most of the gait's swing is swapped for relaxed Idle arms; a probe in hand overrides both.
    const free = 1 - c;
    this.setWeights(
      { idle: wIdle * k, walk: wWalk * k, run: wRun * k, brace: brace * k },
      {
        idle: (wIdle + (wWalk + wRun) * (1 - ARM_SWING)) * free * k,
        walk: wWalk * ARM_SWING * free * k,
        run: wRun * ARM_SWING * free * k,
        brace: brace * free * k,
        carry: c * k,
      },
    );
    // Play the gait at the speed we're actually moving.
    for (const [name, rate] of [['walk', speed / 1.6], ['run', speed / 4.2]] as const) {
      const l = this.clips.get(name);
      if (!l) continue;
      const ts = damp(l.body.timeScale, Math.max(name === 'walk' ? 0.6 : 0.7, rate), 6, dt);
      l.body.timeScale = ts;
      if (l.arms) l.arms.timeScale = ts;
    }
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
  }

  /** World position of the chest camera this frame (after animation). */
  chestCamPosition(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.chestCam || !this.root.visible) return null;
    return this.chestCam.getWorldPosition(out);
  }

  /**
   * How the chest mount is tilted by the gait right now, relative to its rest
   * pose, in the body's own frame: the lean and roll a real chest camera picks
   * up from each stride.
   */
  chestSway(out: THREE.Quaternion): THREE.Quaternion | null {
    if (!this.chestCam || !this.chestRest || !this.root.visible) return null;
    this.root.getWorldQuaternion(_qRoot).invert();
    this.chestCam.getWorldQuaternion(out).premultiply(_qRoot);
    return out.multiply(this.chestRest);
  }
  private chestRest: THREE.Quaternion | null = null;
}
