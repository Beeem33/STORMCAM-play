import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { patchObject } from '../rendering/Atmosphere';
import { clamp, damp } from '../utils/MathUtils';

/**
 * The chaser's own body, seen from his chest-mounted bodycam: rigged mesh
 * from `models/chaser_person_build.py`, head hidden in first person, animation
 * blended from walking speed and wind strain. The camera rides the `ChestCam`
 * empty, so the walk cycle moves the shot the way a real body camera moves.
 */

const URL_GLB = `${import.meta.env.BASE_URL}models/chaser_person.glb`;

export class PlayerBody {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private chestCam: THREE.Object3D | null = null;
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
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.actions.set(clip.name.toLowerCase(), a);
    }
    this.weight('idle', 1);
    this.loaded = true;
  }

  private weight(name: string, w: number): void {
    const a = [...this.actions.entries()].find(([k]) => k.includes(name))?.[1];
    if (a) a.setEffectiveWeight(w);
  }

  /**
   * @param pos feet position
   * @param lookYaw where the torso faces (bodycam yaw)
   * @param speed horizontal speed m/s
   * @param strain 0..1 how hard the wind is pushing
   */
  update(dt: number, visible: boolean, pos: THREE.Vector3, lookYaw: number, speed: number, strain: number): void {
    this.root.visible = visible && this.loaded;
    if (!this.loaded || !visible || !this.mixer) return;
    this.yaw = lookYaw;
    this.root.position.copy(pos);
    this.root.rotation.set(0, this.yaw, 0);
    const walk = clamp(speed / 1.6, 0, 1);
    const run = clamp((speed - 2.2) / 2, 0, 1);
    const brace = clamp(strain * 1.4, 0, 1);
    const moving = Math.max(walk, run);
    this.weight('idle', (1 - moving) * (1 - brace));
    this.weight('walk', walk * (1 - run) * (1 - brace * 0.6));
    this.weight('run', run * (1 - brace * 0.6));
    this.weight('brace', brace);
    // Play the gait at the speed we're actually moving.
    const walkA = [...this.actions.entries()].find(([k]) => k.includes('walk'))?.[1];
    const runA = [...this.actions.entries()].find(([k]) => k.includes('run'))?.[1];
    if (walkA) walkA.timeScale = damp(walkA.timeScale, Math.max(0.6, speed / 1.6), 6, dt);
    if (runA) runA.timeScale = damp(runA.timeScale, Math.max(0.7, speed / 4.2), 6, dt);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
  }

  /** World position of the chest camera this frame (after animation). */
  chestCamPosition(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.chestCam || !this.root.visible) return null;
    return this.chestCam.getWorldPosition(out);
  }
}
