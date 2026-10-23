import * as THREE from 'three';
import { fieldTypeAt, heightAt, padDistance, surfaceAt } from '../environment/WorldShape';
import { clamp, damp } from '../utils/MathUtils';

/**
 * Last resort on foot: drop flat on the grass and hang on. Face down, both
 * hands fisted in the grass, head into the wind. As the vortex closes in the
 * wind gets under him and lifts his legs, until he's streaming off his hands
 * like a flag. Every few seconds a hand tears loose with a fistful of grass
 * and he has a moment (slow motion) to grab another patch with the mouse —
 * miss it and the tornado takes him.
 *
 * Only on grass: there's nothing to hold on a road, gravel or plowed dirt.
 */

export type HoldPhase = 'down' | 'holding' | 'up';

/** What the body needs to pose itself, in world space. */
export interface HoldPose {
  /** 0..1: blend from standing (0) to the hold pose (1). */
  blend: number;
  /** Where the standing body was (feet) and faced (yaw), to blend from. */
  standPos: THREE.Vector3;
  standYaw: number;
  /** Shoulder centre, head direction (unit, toward the hands) and belly direction (unit). */
  shoulders: THREE.Vector3;
  headDir: THREE.Vector3;
  belly: THREE.Vector3;
  /** Hand targets, left and right; `gripping` false = that hand is flailing. */
  hands: [THREE.Vector3, THREE.Vector3];
  gripping: [boolean, boolean];
  /** 0..1 how far the legs are lifted, and a running clock for the flailing. */
  lift: number;
  time: number;
}

interface Target {
  pos: THREE.Vector3;
  obj: THREE.Group;
  ring: THREE.Mesh;
}

interface Flyer {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _ndc = new THREE.Vector3();

/** Can you get a grip here? Grass or pasture, not road, gravel, mud, bare plowed ground or the gas station's concrete. */
export function grippable(x: number, z: number, wetness: number): boolean {
  return surfaceAt(x, z, wetness) === 'grass' && fieldTypeAt(x, z) !== 2 && padDistance(x, z) > 1.5;
}

const GRASS_COLORS = [0x6f7d3a, 0x7d8a44, 0x8c8a4a, 0x5d6b31];

/** A small tuft of grass blades (with a clod of dirt when `roots`). */
function makeTuft(roots: boolean): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const h = 0.14 + Math.random() * 0.12;
    const blade = new THREE.Mesh(
      new THREE.ConeGeometry(0.008, h, 3),
      new THREE.MeshLambertMaterial({ color: GRASS_COLORS[i % GRASS_COLORS.length] }),
    );
    blade.position.set((Math.random() - 0.5) * 0.06, h / 2, (Math.random() - 0.5) * 0.06);
    blade.rotation.set((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6);
    g.add(blade);
  }
  if (roots) {
    const clod = new THREE.Mesh(new THREE.DodecahedronGeometry(0.035, 0), new THREE.MeshLambertMaterial({ color: 0x3b2f22 }));
    clod.scale.set(1.2, 0.7, 1);
    g.add(clod);
  }
  return g;
}

export class GrassHold {
  active = false;
  phase: HoldPhase = 'down';
  /** Seconds in the current phase. */
  private t = 0;
  private time = 0;
  /** Set when he lost his last grip: the game hands him to the vortex. */
  failed = false;
  /** Seconds left to keep screaming after a hand tore loose. */
  scream = 0;
  /** True while the grab window is open (the game runs in slow motion). */
  get grabbing(): boolean {
    return this.qte !== null;
  }
  /** 0..1 of the grab window left, and whether the crosshair is on a patch. */
  grabLeft = 0;
  grabHover = false;
  /** 0..1 how far the wind has lifted his legs. */
  lift = 0;
  /** Calm long enough to stand back up. */
  get canGetUp(): boolean {
    return this.phase === 'holding' && this.calm > 1.5 && !this.qte;
  }
  /** Slips survived this hold. */
  saves = 0;

  readonly group = new THREE.Group();
  private readonly grips: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly gripping: [boolean, boolean] = [true, true];
  /** Downwind (feet direction), horizontal unit. */
  private readonly flag = new THREE.Vector3(0, 0, 1);
  private readonly standPos = new THREE.Vector3();
  private standYaw = 0;
  private flutter = 0;
  private nextSlip = 3;
  private calm = 0;
  private qte: { left: number; window: number; hand: 0 | 1; targets: Target[] } | null = null;
  private readonly flyers: Flyer[] = [];
  /** A fist of torn grass travels with the flailing hand until it's flung away. */
  private clump: { obj: THREE.Group; hand: 0 | 1; t: number } | null = null;
  /** Camera look offsets (rad) from where the head faces. */
  lookYaw = 0;
  lookPitch = 0;
  readonly pose: HoldPose = {
    blend: 0,
    standPos: new THREE.Vector3(),
    standYaw: 0,
    shoulders: new THREE.Vector3(),
    headDir: new THREE.Vector3(),
    belly: new THREE.Vector3(),
    hands: [new THREE.Vector3(), new THREE.Vector3()],
    gripping: [true, true],
    lift: 0,
    time: 0,
  };
  /** Sound cues for the game to play this frame. */
  readonly cues = { rip: false, grab: false, thud: false };

  constructor() {
    this.group.name = 'grass-hold';
  }

  /**
   * Drop flat at the walker's spot, head into the wind. Returns false if
   * there's no grass to hold within reach.
   */
  start(pos: THREE.Vector3, yaw: number, wind: THREE.Vector3, wetness: number): boolean {
    const wl = Math.hypot(wind.x, wind.z);
    if (wl > 0.5) this.flag.set(wind.x / wl, 0, wind.z / wl);
    else this.flag.set(Math.sin(yaw), 0, Math.cos(yaw)); // no wind: lie down facing where he looked
    // Hands land ~0.9 m upwind of where he stood.
    const ax = pos.x - this.flag.x * 0.9, az = pos.z - this.flag.z * 0.9;
    const left = _v.crossVectors(_up, _w.copy(this.flag).negate()).normalize();
    const gl = this.grips[0].set(ax + left.x * 0.22, 0, az + left.z * 0.22);
    const gr = this.grips[1].set(ax - left.x * 0.22, 0, az - left.z * 0.22);
    if (!grippable(gl.x, gl.z, wetness) || !grippable(gr.x, gr.z, wetness)) return false;
    gl.y = heightAt(gl.x, gl.z);
    gr.y = heightAt(gr.x, gr.z);
    this.active = true;
    this.phase = 'down';
    this.t = 0;
    this.failed = false;
    this.lift = 0;
    this.calm = 0;
    this.saves = 0;
    this.scream = 0;
    this.gripping[0] = this.gripping[1] = true;
    this.nextSlip = 2 + Math.random() * 2;
    this.standPos.copy(pos);
    this.standYaw = yaw;
    // Start looking along the body at the hands.
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.clearTargets();
    this.cues.thud = true;
    return true;
  }

  /** Drop everything (new day, back in the truck). */
  reset(): void {
    this.active = false;
    this.failed = false;
    this.scream = 0;
    this.lift = 0;
    this.clearTargets();
    if (this.clump) this.clump.obj.removeFromParent();
    this.clump = null;
    for (const f of this.flyers) f.obj.removeFromParent();
    this.flyers.length = 0;
  }

  /** Get back up (once the wind has dropped). */
  getUp(): void {
    if (this.phase !== 'holding') return;
    this.phase = 'up';
    this.t = 0;
  }

  /** Where he stands up: under his hips. */
  standSpot(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pose.shoulders).addScaledVector(this.pose.headDir, -0.6).setY(0);
  }

  /** Mouse look while down: free to look round over a shoulder at his legs and the funnel. */
  look(dx: number, dy: number, sens: number, invertY: boolean): void {
    this.lookYaw = clamp(this.lookYaw - dx * sens, -2.6, 2.6);
    this.lookPitch = clamp(this.lookPitch - dy * sens * (invertY ? -1 : 1), -0.9, 1.4);
  }

  /**
   * @param dt simulation step (slowed during a grab)
   * @param realDt real frame time (the grab window runs on it)
   * @param wind wind at his body (m/s)
   * @param click the player clicked this frame
   * @param camera the view, to pick a patch under the crosshair
   */
  update(dt: number, realDt: number, wind: THREE.Vector3, click: boolean, camera: THREE.Camera, wetness: number): void {
    for (const k of Object.keys(this.cues) as (keyof typeof this.cues)[]) this.cues[k] = false;
    this.updateFlyers(dt, wind);
    if (!this.active) return;
    this.t += dt;
    this.time += dt;
    this.scream = Math.max(0, this.scream - realDt);
    const w = Math.hypot(wind.x, wind.z);

    // The body streams downwind off his hands like a flag.
    if (w > 3) {
      _v.set(wind.x / w, 0, wind.z / w);
      this.flag.lerp(_v, 1 - Math.exp(-dt * (this.phase === 'holding' ? 1.2 : 0.3))).normalize();
    }
    // The wind gets under him from ~24 m/s; by ~60 m/s he's up off the ground, legs high.
    const hands = (this.gripping[0] ? 1 : 0) + (this.gripping[1] ? 1 : 0);
    let target = this.phase === 'holding' ? clamp((w - 24) / 36, 0, 1) : 0;
    if (hands === 1) target = Math.min(1, target + 0.18); // one hand: he swings up further
    this.lift = damp(this.lift, target, target > this.lift ? 2.2 : 0.8, dt);
    this.flutter = Math.sin(this.time * 6.3) * 0.5 + Math.sin(this.time * 10.7 + 1.3) * 0.3 + Math.sin(this.time * 3.1) * 0.2;
    this.calm = this.lift < 0.04 && w < 22 ? this.calm + dt : 0;

    if (this.phase === 'down' && this.t >= 0.7) {
      this.phase = 'holding';
      this.t = 0;
    } else if (this.phase === 'up' && this.t >= 0.8) {
      this.active = false;
      this.clearTargets();
    }

    if (this.phase === 'holding') {
      if (this.qte) this.updateGrab(realDt, click, camera);
      else if (this.lift > 0.25) {
        // The harder it pulls, the sooner a hand gives.
        this.nextSlip -= dt * (0.6 + this.lift);
        if (this.nextSlip <= 0) this.slip(wetness);
      } else this.nextSlip = Math.max(this.nextSlip, 1.5);
    }
    if (this.clump) {
      this.clump.t += dt;
      if (this.clump.t > 0.7) {
        // Let go of the torn grass: it goes with the wind.
        const o = this.clump.obj;
        this.flyers.push({ obj: o, vel: new THREE.Vector3(wind.x * 0.5, 3, wind.z * 0.5), spin: new THREE.Vector3(9, 5, 7), life: 2.5 });
        this.clump = null;
      }
    }
    this.updatePose(dt);
    if (this.clump) this.clump.obj.position.copy(this.pose.hands[this.clump.hand]);
  }

  /** A hand tears out of the grass: open the grab window. */
  private slip(wetness: number): void {
    const hand: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    const keep = 1 - hand;
    this.gripping[hand] = false;
    this.cues.rip = true;
    this.scream = 1.3;
    // A fistful of grass and dirt comes up with it, and a spray of torn blades.
    const clump = makeTuft(true);
    clump.position.copy(this.grips[hand]);
    this.group.add(clump);
    this.clump = { obj: clump, hand, t: 0 };
    for (let i = 0; i < 14; i++) {
      const b = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.12, 3), new THREE.MeshLambertMaterial({ color: GRASS_COLORS[i % 4] }));
      b.position.copy(this.grips[hand]).y += 0.03;
      this.group.add(b);
      this.flyers.push({
        obj: b,
        vel: new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3),
        spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20),
        life: 1.5 + Math.random(),
      });
    }
    // Patches within reach of the hand that's still holding: upwind of it and to either side.
    const g = this.grips[keep];
    const head = _v.copy(this.flag).negate();
    const left = _w.crossVectors(_up, head).normalize();
    const targets: Target[] = [];
    for (let tries = 0; targets.length < 3 && tries < 40; tries++) {
      const a = (targets.length - 1) * 0.55 + (Math.random() - 0.5) * 0.3; // spread across
      const r = 0.32 + Math.random() * 0.3;
      const x = g.x + head.x * Math.cos(a) * r + left.x * Math.sin(a) * r * 1.4;
      const z = g.z + head.z * Math.cos(a) * r + left.z * Math.sin(a) * r * 1.4;
      if (!grippable(x, z, wetness)) continue;
      if (targets.some((t) => Math.hypot(t.pos.x - x, t.pos.z - z) < 0.22)) continue;
      const pos = new THREE.Vector3(x, heightAt(x, z), z);
      const obj = makeTuft(false);
      obj.scale.setScalar(1.6);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.075, 0.1, 28),
        new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, fog: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      ring.renderOrder = 5;
      obj.add(ring);
      obj.position.copy(pos);
      this.group.add(obj);
      targets.push({ pos, obj, ring });
    }
    if (targets.length === 0) {
      // Nothing left to grab within reach.
      this.failed = true;
      return;
    }
    // Less time the harder it's pulling: ~1.8 s at the edge of it, ~0.9 s at the core.
    const window = THREE.MathUtils.lerp(1.8, 0.9, this.lift);
    this.qte = { left: window, window, hand, targets };
  }

  private updateGrab(realDt: number, click: boolean, camera: THREE.Camera): void {
    const q = this.qte!;
    q.left -= realDt;
    this.grabLeft = clamp(q.left / q.window, 0, 1);
    // The patch nearest the crosshair (on screen), if it's close enough.
    let best: Target | null = null;
    let bestD = 0.11;
    const aspect = (camera as THREE.PerspectiveCamera).aspect ?? 1;
    for (const t of q.targets) {
      _ndc.copy(t.pos).project(camera);
      if (_ndc.z > 1) continue;
      const d = Math.hypot(_ndc.x * aspect, _ndc.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    this.grabHover = best !== null;
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 18);
    for (const t of q.targets) {
      const m = t.ring.material as THREE.MeshBasicMaterial;
      const on = t === best;
      m.color.setHex(on ? 0xffffff : 0xffe14d);
      m.opacity = on ? 1 : 0.55 + 0.35 * pulse;
      t.ring.scale.setScalar(on ? 1.35 : 0.9 + 0.15 * pulse);
    }
    if (click && best) {
      // Got it: the hand slams into the new patch.
      this.grips[q.hand].copy(best.pos);
      this.gripping[q.hand] = true;
      this.cues.grab = true;
      this.saves++;
      this.qte = null;
      this.clearTargets();
      this.nextSlip = (2.2 + Math.random() * 2.5) * (1.4 - this.lift * 0.6);
      return;
    }
    if (q.left <= 0) {
      // Too slow: the other hand can't hold him alone.
      this.qte = null;
      this.clearTargets();
      this.gripping[0] = this.gripping[1] = false;
      this.failed = true;
      this.active = false;
    }
  }

  private clearTargets(): void {
    if (this.qte) for (const t of this.qte.targets) t.obj.removeFromParent();
    this.qte = null;
    this.grabHover = false;
    this.grabLeft = 0;
  }

  private updateFlyers(dt: number, wind: THREE.Vector3): void {
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      f.life -= dt;
      f.vel.x += (wind.x * 0.8 - f.vel.x) * Math.min(1, dt * 2);
      f.vel.z += (wind.z * 0.8 - f.vel.z) * Math.min(1, dt * 2);
      f.vel.y += (Math.max(0, wind.y) * 0.3 - 4) * dt;
      f.obj.position.addScaledVector(f.vel, dt);
      f.obj.rotation.x += f.spin.x * dt;
      f.obj.rotation.y += f.spin.y * dt;
      f.obj.rotation.z += f.spin.z * dt;
      if (f.life <= 0) {
        f.obj.removeFromParent();
        this.flyers.splice(i, 1);
      }
    }
  }

  /** Lay out the body for this frame (see HoldPose). */
  private updatePose(dt: number): void {
    const p = this.pose;
    p.standPos.copy(this.standPos);
    p.standYaw = this.standYaw;
    const k = this.phase === 'down' ? clamp(this.t / 0.7, 0, 1) : this.phase === 'up' ? 1 - clamp(this.t / 0.8, 0, 1) : 1;
    p.blend = k * k * (3 - 2 * k);
    p.lift = this.lift;
    p.time = this.time;
    p.gripping[0] = this.gripping[0];
    p.gripping[1] = this.gripping[1];
    // Pivot on the hands: both, or the one still holding.
    const g0 = this.grips[0], g1 = this.grips[1];
    const anchor = _v;
    if (this.gripping[0] && this.gripping[1]) anchor.copy(g0).add(g1).multiplyScalar(0.5);
    else if (this.gripping[0]) anchor.copy(g0).lerp(g1, 0.25);
    else anchor.copy(g1).lerp(g0, 0.25);
    // Legs up to ~75° off the ground, fluttering in the gusts.
    const theta = clamp(this.lift * 1.25 + this.flutter * 0.12 * this.lift, 0, 1.38);
    const feet = _w.copy(this.flag).multiplyScalar(Math.cos(theta)).addScaledVector(_up, Math.sin(theta));
    p.headDir.copy(feet).negate();
    // Belly: the part of "down" across the body.
    p.belly.set(0, -1, 0).addScaledVector(p.headDir, p.headDir.y);
    if (p.belly.lengthSq() < 1e-6) p.belly.copy(this.flag);
    p.belly.normalize();
    const want = anchor.clone().addScaledVector(feet, 0.52).addScaledVector(_up, 0.13 * Math.cos(theta));
    if (this.phase === 'down' || p.shoulders.lengthSq() === 0) p.shoulders.copy(want);
    else p.shoulders.lerp(want, 1 - Math.exp(-dt * 8));
    // Hands: on their grips, or (torn loose) flung back along the body in the wind.
    for (const i of [0, 1] as const) {
      if (this.gripping[i]) p.hands[i].copy(this.grips[i]).y += 0.03;
      else {
        const side = i === 0 ? 1 : -1;
        const left = new THREE.Vector3().crossVectors(_up, p.headDir).normalize();
        p.hands[i].copy(p.shoulders)
          .addScaledVector(feet, 0.25 + 0.15 * Math.sin(this.time * 9))
          .addScaledVector(left, side * (0.35 + 0.1 * Math.sin(this.time * 7 + 1)))
          .addScaledVector(p.belly, -0.2 - 0.15 * Math.sin(this.time * 11));
      }
    }
  }

  /** The head-mounted view while down: position from the body's eye, looking along the body at the hands. */
  cameraPose(eye: THREE.Vector3, cam: THREE.PerspectiveCamera, shake: number, impulse = 0): void {
    const p = this.pose;
    // Chin up, looking ahead past the fists at the grass and the horizon (the hands sit low in frame).
    const f = _v.copy(this.flag).negate().setY(-0.42).normalize();
    const yaw = Math.atan2(-f.x, -f.z);
    const pitch = Math.asin(clamp(f.y, -1, 1));
    const a = (0.01 + this.lift * 0.05 + impulse * 0.05) * shake;
    const t = this.time;
    cam.position.copy(eye).addScaledVector(p.headDir, 0.06);
    cam.position.x += Math.sin(t * 23) * a * 0.3;
    cam.position.y += Math.sin(t * 19 + 1) * a * 0.3;
    cam.rotation.set(
      clamp(pitch + this.lookPitch, -1.5, 1.5) + Math.sin(t * 17) * a,
      yaw + this.lookYaw + Math.sin(t * 13 + 2) * a,
      Math.sin(t * 7) * a * 2 + this.flutter * this.lift * 0.08,
      'YXZ',
    );
    cam.updateMatrixWorld();
  }
}
