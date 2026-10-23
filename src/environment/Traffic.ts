import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MAP_HALF, MILE, heightAt, normalAt, roadHalf } from './WorldShape';
import { mergeByMaterial } from './mergeStatic';
import { patchObject } from '../rendering/Atmosphere';
import type { ColliderGrid, Collider2D } from './Colliders';
import type { DebrisSystem } from '../tornado/Debris';
import type { Tornado } from '../tornado/Tornado';

/**
 * Abandoned cars, farm pickups and police cruisers left on the road
 * shoulders (some nosed into the ditch), re-scattered every day. They block
 * the truck like any obstacle until the tornado's winds reach them: then
 * they're picked up and thrown, and fly as heavy debris that can hit you.
 * Police light bars keep flashing.
 */

const URL_GLB = `${import.meta.env.BASE_URL}models/traffic.glb`;
const PAINTS = ['#e8e8e4', '#b9bcc0', '#5a1f22', '#1f2c45', '#c9b892', '#2e3b2c', '#7a7d80', '#2a2a2c', '#8a3a1c'];

interface Parked {
  obj: THREE.Object3D;
  collider: Collider2D;
  thrown: boolean;
  /** Wind (m/s) that lifts it. */
  liftAt: number;
}

export class Traffic {
  readonly group = new THREE.Group();
  private templates: Record<string, THREE.Object3D> = {};
  private readonly parked: Parked[] = [];
  private lightRed: THREE.MeshStandardMaterial | null = null;
  private lightBlue: THREE.MeshStandardMaterial | null = null;
  private time = 0;
  loaded = false;

  constructor(private readonly colliders: ColliderGrid, private readonly debris: DebrisSystem) {
    this.group.name = 'traffic';
  }

  async load(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(URL_GLB);
    for (const name of ['Sedan', 'Pickup', 'PoliceCruiser']) {
      const o = gltf.scene.getObjectByName(name);
      if (o) this.templates[name] = o;
    }
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name === 'LightRed') this.lightRed = mat;
      if (mat.name === 'LightBlue') this.lightBlue = mat;
    });
    // The lenses export with no glow colour; give them one to flash.
    this.lightRed?.emissive.set('#ff1a10');
    this.lightBlue?.emissive.set('#1c4dff');
    patchObject(gltf.scene);
    this.loaded = Object.keys(this.templates).length > 0;
  }

  /** New day: clear yesterday's wrecks and scatter a fresh set. */
  scatter(avoid: { x: number; z: number }): void {
    for (const p of this.parked) {
      p.obj.removeFromParent();
      if (!p.thrown) this.colliders.remove(p.collider);
    }
    this.parked.length = 0;
    if (!this.loaded) return;
    const kinds: string[] = [];
    for (let i = 0; i < 7; i++) kinds.push(Math.random() < 0.55 ? 'Sedan' : 'Pickup');
    for (let i = 0; i < 2 + (Math.random() < 0.5 ? 1 : 0); i++) kinds.push('PoliceCruiser');
    for (const kind of kinds) {
      const t = this.templates[kind] ?? this.templates.Sedan;
      if (!t) continue;
      for (let tries = 0; tries < 12; tries++) {
        // A road inside the chase area, a spot along it, then the shoulder or the ditch.
        const k = Math.floor(Math.random() * 3) - 1;
        const ns = Math.random() < 0.5;
        const along = (Math.random() * 2 - 1) * (MAP_HALF - 150);
        if (Math.abs(along - Math.round(along / MILE) * MILE) < 40) continue;
        const side = Math.random() < 0.5 ? -1 : 1;
        const inDitch = kind !== 'PoliceCruiser' && Math.random() < 0.35;
        const off = roadHalf(k) + (inDitch ? 5.5 : 1.9);
        const x = ns ? k * MILE + side * off : along;
        const z = ns ? along : k * MILE + side * off;
        if (Math.hypot(x - avoid.x, z - avoid.z) < 60 || this.parked.some((p) => Math.hypot(p.obj.position.x - x, p.obj.position.z - z) < 15)) continue;
        // Facing along the road (either way); ditched ones skewed and tipped.
        let yaw = (ns ? 0 : Math.PI / 2) + (Math.random() < 0.5 ? 0 : Math.PI);
        if (inDitch) yaw += (Math.random() - 0.5) * 0.9;
        this.place(kind, t, x, z, yaw, inDitch);
        break;
      }
    }
  }

  private place(kind: string, template: THREE.Object3D, x: number, z: number, yaw: number, ditched: boolean): void {
    const c = template.clone(true);
    c.position.set(0, 0, 0);
    c.rotation.set(0, 0, 0);
    // Each civilian car gets its own paint.
    if (kind !== 'PoliceCruiser') {
      const paint = new THREE.Color(PAINTS[Math.floor(Math.random() * PAINTS.length)]);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (/Paint$/.test(mat.name)) {
          const own = mat.clone();
          own.color.copy(paint);
          m.material = own;
        }
      });
    }
    const merged = mergeByMaterial(c);
    const holder = new THREE.Group();
    holder.add(merged);
    // Sit on the ground, tilted with the slope (and more if it's in the ditch).
    const n = normalAt(x, z, { x: 0, y: 1, z: 0 });
    holder.position.set(x, heightAt(x, z) + 0.02, z);
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n.x, n.y, n.z));
    holder.rotateY(yaw);
    if (ditched) holder.rotateZ((Math.random() - 0.5) * 0.3);
    this.group.add(holder);
    const collider: Collider2D = { type: 'box', x, z, hx: 1.0, hz: kind === 'Pickup' ? 2.8 : 2.5, rot: yaw, owner: 'traffic' };
    this.colliders.add(collider);
    this.parked.push({ obj: holder, collider, thrown: false, liftAt: kind === 'Pickup' ? 46 : 42 });
  }

  update(dt: number, t: Tornado | null): void {
    this.time += dt;
    // Police light bars: alternate red/blue flashes.
    const ph = (this.time * 2.4) % 1;
    if (this.lightRed) this.lightRed.emissiveIntensity = ph < 0.5 && (ph * 8) % 1 < 0.6 ? 10 : 0.3;
    if (this.lightBlue) this.lightBlue.emissiveIntensity = ph >= 0.5 && (ph * 8) % 1 < 0.6 ? 10 : 0.3;
    if (!t || t.presence < 0.5) return;
    const w = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const car of this.parked) {
      if (car.thrown) continue;
      const o = car.obj.position;
      if (Math.abs(o.x - t.position.x) > t.radius * 3 + 100 || Math.abs(o.z - t.position.z) > t.radius * 3 + 100) continue;
      t.windAt(p.copy(o).setY(o.y + 1), w);
      if (w.length() < car.liftAt) continue;
      // Picked up and thrown.
      car.thrown = true;
      this.colliders.remove(car.collider);
      car.obj.updateMatrixWorld(true);
      const vel = w.clone().multiplyScalar(0.45);
      vel.y = 12 + Math.random() * 14;
      // Light enough in the flow to be carried up and around the vortex, heavy enough to hurt.
      this.debris.throwObject(car.obj, vel, 3.5);
    }
  }
}
