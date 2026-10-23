import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { patchObject } from '../rendering/Atmosphere';
import { clamp, damp } from '../utils/MathUtils';
import type { HoldPose } from './GrassHold';

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
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();
const _vE = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const FINGERS = ['index', 'middle', 'ring', 'pinky'];

/** Turn `bone` (which points along its local +Y) to point along world `dir`, keeping its twist. */
function aimBone(bone: THREE.Object3D, dir: THREE.Vector3): void {
  if (!bone.parent || dir.lengthSq() < 1e-10) return;
  bone.parent.getWorldQuaternion(_qA);
  bone.getWorldQuaternion(_qB);
  const cur = _vA.set(0, 1, 0).applyQuaternion(_qB);
  _qC.setFromUnitVectors(cur, _vB.copy(dir).normalize());
  _qB.premultiply(_qC);
  bone.quaternion.copy(_qA.invert().multiply(_qB));
  bone.updateMatrixWorld(true);
}
const ARM_TRACK = /^(shoulder|upperarm|forearm|hand|thumb\d|index\d|middle\d|ring\d|pinky\d)_[LR]\.|^CarryPoint\./;
/** How much of the gait clips' own arm swing to keep (the rest is the relaxed Idle arms). The clips are already authored with low swing. */
const ARM_SWING = 1;

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
  private readonly bones = new Map<string, THREE.Object3D>();
  private eye: THREE.Object3D | null = null;
  /** Shoulder centre in the body's own frame (rest pose). */
  private readonly shoulderLocal = new THREE.Vector3(0, 1.45, 0);
  private readonly saved = new Map<THREE.Object3D, THREE.Quaternion>();

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
    this.eye = model.getObjectByName('Eye') ?? null;
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o);
    });
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
    const sl = this.bones.get('upperarm_L'), sr = this.bones.get('upperarm_R');
    if (sl && sr) {
      sl.getWorldPosition(_vA);
      sr.getWorldPosition(_vB);
      this.root.worldToLocal(this.shoulderLocal.copy(_vA).add(_vB).multiplyScalar(0.5));
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
  playPlace(onTouchdown: () => void, touchdownFraction = 0.633 / 1.4): boolean {
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

  /**
   * Holding on to the grass (see GrassHold): after the normal update, lay the
   * body face down along `headDir`, reach the arms to the hand targets
   * (two-bone IK), close the fingers on the grass, and kick the legs as the
   * wind lifts them. `blend` eases between standing and the hold pose.
   */
  poseHold(p: HoldPose): void {
    if (!this.loaded || !this.root.visible) return;
    const b = p.blend;
    // Body frame: +Y toward the head, -Z (the front) toward the belly.
    const back = _vC.copy(p.belly).negate();
    const right = _vD.crossVectors(p.headDir, back).normalize();
    _m.makeBasis(right, p.headDir, back);
    _qA.setFromRotationMatrix(_m);
    const prone = _qB.copy(_qA);
    const stand = _qC.setFromEuler(_e.set(0, p.standYaw, 0));
    const pos = _vE.copy(this.shoulderLocal).applyQuaternion(prone).negate().add(p.shoulders);
    this.root.quaternion.slerpQuaternions(stand, prone, b);
    this.root.position.lerpVectors(p.standPos, pos, b);
    this.root.updateMatrixWorld(true);

    // Arms. Remember the animated pose so the IK can be blended in.
    const arms = ['upperarm', 'forearm', 'hand'];
    this.saved.clear();
    for (const side of ['L', 'R']) for (const n of arms) {
      const bone = this.bones.get(`${n}_${side}`);
      if (bone) this.saved.set(bone, bone.quaternion.clone());
    }
    const sides = ['L', 'R'] as const;
    for (let i = 0; i < 2; i++) {
      const s = sides[i];
      const upper = this.bones.get(`upperarm_${s}`), fore = this.bones.get(`forearm_${s}`), hand = this.bones.get(`hand_${s}`);
      if (!upper || !fore || !hand) continue;
      const S = upper.getWorldPosition(new THREE.Vector3());
      const E0 = fore.getWorldPosition(new THREE.Vector3());
      const W0 = hand.getWorldPosition(new THREE.Vector3());
      const la = S.distanceTo(E0), lb = E0.distanceTo(W0);
      // The wrist sits a hand's length short of where the fist closes.
      const T = p.hands[i].clone();
      const st = T.clone().sub(S);
      const full = st.length();
      if (full > 1e-4) T.addScaledVector(st, -0.08 / full);
      const dirST = T.clone().sub(S);
      const d = clamp(dirST.length(), 0.05, la + lb - 1e-3);
      dirST.normalize();
      const x = (la * la - lb * lb + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, la * la - x * x));
      // Elbows bend out to the side and up off the ground.
      const out = right.clone().multiplyScalar(i === 0 ? -1 : 1);
      const pole = out.addScaledVector(back, 0.7);
      pole.addScaledVector(dirST, -pole.dot(dirST)).normalize();
      const E = S.clone().addScaledVector(dirST, x).addScaledVector(pole, h);
      const W = S.clone().addScaledVector(dirST, d);
      aimBone(upper, E.clone().sub(S));
      aimBone(fore, W.clone().sub(E));
      // Fist toward the ground.
      aimBone(hand, W.clone().sub(E).normalize().addScaledVector(p.belly, 0.6));
      // Fingers: clenched on the grass, clawing when torn loose.
      const curl = (p.gripping[i] ? 1.25 : 0.35 + 0.25 * Math.sin(p.time * 14 + i)) * b;
      for (const f of FINGERS) for (let j = 1; j <= 3; j++) {
        const fb = this.bones.get(`${f}${j}_${s}`);
        if (fb) fb.quaternion.multiply(_qA.setFromAxisAngle(_vA.set(1, 0, 0), curl * (j === 1 ? 0.8 : 1)));
      }
      const th = this.bones.get(`thumb2_${s}`);
      if (th) th.quaternion.multiply(_qA.setFromAxisAngle(_vA.set(1, 0, 0), curl * 0.6));
    }
    if (b < 1) for (const [bone, q] of this.saved) bone.quaternion.slerpQuaternions(q, bone.quaternion.clone(), b);

    // Legs: kicking and scissoring as the wind lifts them.
    const L = p.lift * b;
    if (L > 0.001) {
      for (const [s, ph] of [['L', 0], ['R', 2.1]] as const) {
        const thigh = this.bones.get(`thigh_${s}`), calf = this.bones.get(`calf_${s}`);
        if (thigh) {
          thigh.quaternion.multiply(_qA.setFromAxisAngle(_vA.set(1, 0, 0), L * 0.45 * Math.sin(p.time * 8.5 + ph)));
          thigh.quaternion.multiply(_qA.setFromAxisAngle(_vA.set(0, 0, 1), L * (s === 'L' ? -0.22 : 0.22) * (1 + 0.5 * Math.sin(p.time * 5 + ph))));
        }
        if (calf) calf.quaternion.multiply(_qA.setFromAxisAngle(_vA.set(1, 0, 0), L * (0.35 + 0.35 * Math.sin(p.time * 11 + ph))));
      }
    }
    this.root.updateMatrixWorld(true);
  }

  /** World position of the eyes (for the head view while holding on). */
  eyePosition(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.eye || !this.root.visible) return null;
    return this.eye.getWorldPosition(out);
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
