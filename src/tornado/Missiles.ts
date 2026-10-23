import * as THREE from 'three';
import type { Tornado } from './Tornado';
import type { DebrisSystem } from './Debris';
import { heightAt } from '../environment/WorldShape';
import { patchMaterial } from '../rendering/Atmosphere';

/**
 * Wind-borne missiles: near a tornado the air is full of heavy junk. When the
 * truck is within a few vortex-widths, objects are flung across its path from
 * upwind — boards, roofing sheets, fence posts, oil drums, branches, now and
 * then a whole hay bale — and handed to the debris system, which flies them
 * on the wind field and reports hits on the truck.
 */

interface Kind {
  label: string;
  lethal: boolean;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  mass: number;
  weight: number;
}

export class Missiles {
  private readonly kinds: Kind[];
  private acc = 0;

  constructor(private readonly debris: DebrisSystem) {
    const m = (color: string, rough: number, metal = 0) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
      patchMaterial(mat);
      return mat;
    };
    const wood = m('#6b5238', 0.9);
    const greyWood = m('#77706a', 0.92);
    const tin = m('#9aa1a6', 0.45, 0.7);
    const rustTin = m('#7a4a32', 0.7, 0.3);
    const drum = m('#8f2a1e', 0.55, 0.4);
    const bark = m('#3d3024', 0.95);
    const hay = m('#b8994f', 1);
    const post = new THREE.CylinderGeometry(0.07, 0.08, 2.2, 6);
    post.rotateZ(Math.PI / 2);
    const branch = new THREE.CylinderGeometry(0.05, 0.12, 3.2, 5);
    branch.rotateZ(Math.PI / 2);
    this.kinds = [
      { label: 'a two-by-eight', lethal: true, geo: new THREE.BoxGeometry(3.6, 0.04, 0.2), mat: wood, mass: 1.2, weight: 3 }, // 2x8 board
      { label: 'a fence board', lethal: false, geo: new THREE.BoxGeometry(2.4, 0.03, 0.15), mat: greyWood, mass: 0.8, weight: 3 }, // fence board
      { label: 'a sheet of roofing', lethal: true, geo: new THREE.BoxGeometry(2.4, 0.01, 0.9), mat: tin, mass: 1.5, weight: 3 }, // roofing sheet
      { label: 'a sheet of rusted tin', lethal: true, geo: new THREE.BoxGeometry(1.8, 0.01, 1.1), mat: rustTin, mass: 1.3, weight: 2 }, // rusty sheet
      { label: 'a fence post', lethal: true, geo: post, mat: wood, mass: 2.5, weight: 2 }, // fence post
      { label: 'a tree limb', lethal: true, geo: branch, mat: bark, mass: 3, weight: 2 }, // tree limb
      { label: 'an oil drum', lethal: true, geo: new THREE.CylinderGeometry(0.29, 0.29, 0.88, 12), mat: drum, mass: 6, weight: 1 }, // oil drum
      { label: 'a round hay bale', lethal: false, geo: new THREE.CylinderGeometry(0.75, 0.75, 1.2, 14), mat: hay, mass: 12, weight: 0.4 }, // round bale
    ];
  }

  /**
   * @param target the truck's position (missiles only fly while it's near)
   */
  update(dt: number, t: Tornado | null, target: THREE.Vector3, active: boolean): void {
    if (!t || !active || t.presence < 0.5) return;
    const R = Math.max(30, t.radius);
    const d = Math.hypot(target.x - t.position.x, target.z - t.position.z);
    const near = 1 - (d - R) / (R * 3);
    if (near <= 0) return;
    // A few a second at the edge of the danger zone, a barrage close in.
    this.acc += dt * (0.6 + 5 * Math.min(1, near) ** 1.5) * (0.6 + t.params.rating * 0.15);
    while (this.acc >= 1) {
      this.acc -= 1;
      this.launch(t, target);
    }
  }

  /**
   * One heavy object flung straight at `target` (the chaser's face) from
   * `back` metres out along `from`→target, fast. Returns it and what it is.
   */
  /** A heavy object, not yet flying (the caller flies it), with what it is. */
  makeLethal(): { obj: THREE.Mesh; label: string; mass: number } {
    const lethal = this.kinds.filter((k) => k.lethal);
    const k = lethal[Math.floor(Math.random() * lethal.length)];
    const mesh = new THREE.Mesh(k.geo, k.mat);
    mesh.frustumCulled = false;
    return { obj: mesh, label: k.label, mass: k.mass };
  }

  launchAt(target: THREE.Vector3, from: THREE.Vector3, speed = 55): { obj: THREE.Object3D; label: string } {
    const lethal = this.kinds.filter((k) => k.lethal);
    const k = lethal[Math.floor(Math.random() * lethal.length)];
    const mesh = new THREE.Mesh(k.geo, k.mat);
    mesh.position.copy(from);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    mesh.frustumCulled = false;
    mesh.updateMatrixWorld(true);
    const dist = target.distanceTo(from);
    const vel = target.clone().sub(from).normalize().multiplyScalar(speed);
    vel.y += 9.81 * (dist / speed) * 0.5; // aim off for the drop
    this.debris.throwObject(mesh, vel, 20);
    return { obj: mesh, label: k.label };
  }

  private launch(t: Tornado, target: THREE.Vector3): void {
    const w = t.windAt(target, new THREE.Vector3());
    const ws = Math.hypot(w.x, w.z) || 1;
    const dir = new THREE.Vector3(w.x / ws, 0, w.z / ws);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    // From upwind, aimed to cross the truck's position give or take a few metres.
    const back = 25 + Math.random() * 25;
    const lat = (Math.random() - 0.5) * 26;
    const p = target.clone().addScaledVector(dir, -back).addScaledVector(side, lat);
    p.y = heightAt(p.x, p.z) + 1.5 + Math.random() * 8;
    // Most fly past close enough to see; some find the truck.
    const aim = target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, 0.6 + Math.random() * 2.5, (Math.random() - 0.5) * 12));
    const speed = Math.min(70, ws * (0.7 + Math.random() * 0.4));
    const vel = aim.sub(p).normalize().multiplyScalar(speed);
    vel.y += 2 + Math.random() * 4;

    let pick = Math.random() * this.kinds.reduce((a, k) => a + k.weight, 0);
    const k = this.kinds.find((kk) => (pick -= kk.weight) <= 0) ?? this.kinds[0];
    const mesh = new THREE.Mesh(k.geo, k.mat);
    mesh.position.copy(p);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    mesh.frustumCulled = false;
    mesh.updateMatrixWorld(true);
    this.debris.throwObject(mesh, vel, k.mass);
  }
}
