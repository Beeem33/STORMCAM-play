import * as THREE from 'three';
import {
  buildBarn,
  buildFarmhouse,
  buildGasStation,
  buildGrainBin,
  buildMachineShed,
  buildMailbox,
  buildRoadSign,
  buildSilo,
  fencePostAsset,
  hayBaleAsset,
  telephonePoleAsset,
  treeAssets,
  type InstancedAsset,
  type PropBuild,
} from './props';
import { FENCE_OFFSET, MILE, PAD, fieldTypeAt, heightAt, roadHalf } from './WorldShape';
import { ColliderGrid, type Collider2D } from './Colliders';
import { mulberry32, hash3i } from '../utils/Random';
import { patchObject } from '../rendering/Atmosphere';
import type { Tornado } from '../tornado/Tornado';
import type { DebrisSystem } from '../tornado/Debris';

/**
 * Everything standing on the land: farmsteads (house, barn, bins, silo,
 * sheds, windbreaks), the gas station, telephone poles and wires, barbed-wire
 * fences, hay bales and hedgerows. Placement is deterministic per one-mile
 * section, streamed in around the camera, and remembers what the tornado has
 * destroyed.
 */

interface Building {
  obj: THREE.Group;
  collider: Collider2D;
  label: string;
  /** Wind speed (m/s) at which it comes apart. */
  strength: number;
  destroyed: boolean;
}

interface Farmstead {
  key: string;
  group: THREE.Group;
  buildings: Building[];
  trees: number[]; // indices into the tree pool owned by this farmstead
  center: THREE.Vector2;
}

/** A pool of instances sharing one InstancedAsset (one InstancedMesh per part). */
class InstancePool {
  readonly meshes: THREE.InstancedMesh[];
  private used = 0;
  private readonly free: number[] = [];
  readonly matrices: THREE.Matrix4[] = [];

  /**
   * @param tint per-instance brightness range [min, max] — breaks up identical copies.
   */
  constructor(readonly asset: InstancedAsset, readonly capacity: number, parent: THREE.Object3D, tint: [number, number] = [0.85, 1]) {
    const colors = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) {
      const v = tint[0] + (tint[1] - tint[0]) * ((hash3i(i, 17, 3) & 1023) / 1023);
      const hue = ((hash3i(i, 5, 9) & 255) / 255 - 0.5) * 0.08;
      colors[i * 3] = v * (1 + hue);
      colors[i * 3 + 1] = v;
      colors[i * 3 + 2] = v * (1 - hue * 0.5);
    }
    this.meshes = asset.parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, capacity);
      m.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      parent.add(m);
      return m;
    });
    for (let i = 0; i < capacity; i++) this.matrices.push(new THREE.Matrix4().makeScale(0, 0, 0));
  }

  alloc(m: THREE.Matrix4): number {
    const i = this.free.length ? this.free.pop()! : this.used < this.capacity ? this.used++ : -1;
    if (i < 0) return -1;
    this.set(i, m);
    for (const mesh of this.meshes) mesh.count = Math.max(mesh.count, this.used);
    return i;
  }

  set(i: number, m: THREE.Matrix4, part = -1): void {
    if (part < 0) this.matrices[i].copy(m);
    this.meshes.forEach((mesh, k) => {
      if (part < 0 || part === k) {
        mesh.setMatrixAt(i, m);
        mesh.instanceMatrix.needsUpdate = true;
      }
    });
  }

  release(i: number): void {
    this.set(i, new THREE.Matrix4().makeScale(0, 0, 0));
    this.free.push(i);
  }

  clear(): void {
    this.used = 0;
    this.free.length = 0;
    for (const mesh of this.meshes) mesh.count = 0;
  }
}

const SECTION_RADIUS = 3; // sections each way from the camera
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _w = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class WorldProps {
  readonly group = new THREE.Group();
  readonly colliders = new ColliderGrid();
  private readonly farmsteads = new Map<string, Farmstead>();
  /** Sections whose contents the tornado destroyed (persist across streaming). */
  private readonly destroyed = new Map<string, Set<number>>();
  private readonly trees: { kind: string; pool: InstancePool }[];
  private readonly treeOwner = new Map<string, { pool: InstancePool; idx: number; x: number; z: number; stripped: boolean }[]>();
  private readonly bales: InstancePool;
  private readonly baleOwner = new Map<string, { idx: number; x: number; z: number }[]>();
  private readonly poles: InstancePool;
  private readonly posts: InstancePool;
  private readonly poleAttach: THREE.Vector3[];
  private readonly wires: THREE.LineSegments;
  private readonly fenceWires: THREE.LineSegments;
  private readonly brokenPoles = new Set<string>();
  private readonly brokenPosts = new Set<string>();
  private lastSection = '';
  private lastLineCenter = new THREE.Vector2(1e9, 1e9);
  private lastFenceCenter = new THREE.Vector2(1e9, 1e9);
  private poleIndex: { key: string; x: number; z: number; rot: number; idx: number }[] = [];
  private postIndex: { key: string; x: number; z: number; idx: number }[] = [];
  private station: PropBuild | null = null;
  private destroyTimer = 0;
  /** Fired when the tornado destroys something (for footage scoring and audio). */
  onDestroyed: ((pos: THREE.Vector3, label: string) => void) | null = null;

  constructor(private readonly debris: DebrisSystem) {
    this.trees = treeAssets().map((t) => ({ kind: t.kind, pool: new InstancePool(t.asset, 2600, this.group, [0.5, 0.78]) }));
    this.bales = new InstancePool(hayBaleAsset(), 600, this.group);
    const pole = telephonePoleAsset();
    this.poleAttach = pole.wireAttach;
    this.poles = new InstancePool(pole, 900, this.group);
    this.posts = new InstancePool(fencePostAsset(), 2400, this.group);
    for (const p of [...this.trees.map((t) => t.pool), this.bales, this.poles, this.posts]) for (const m of p.meshes) patchObject(m);

    const wireMat = new THREE.LineBasicMaterial({ color: 0x15171a, transparent: true, opacity: 0.8 });
    this.wires = new THREE.LineSegments(new THREE.BufferGeometry(), wireMat);
    this.wires.frustumCulled = false;
    const fenceMat = new THREE.LineBasicMaterial({ color: 0x2a2724, transparent: true, opacity: 0.45 });
    this.fenceWires = new THREE.LineSegments(new THREE.BufferGeometry(), fenceMat);
    this.fenceWires.frustumCulled = false;
    patchObject(this.wires);
    patchObject(this.fenceWires);
    this.group.add(this.wires, this.fenceWires);
    this.placeStation();
  }

  // ------------------------------------------------------------------ gas station
  private placeStation(): void {
    const st = buildGasStation();
    st.group.position.set(PAD.cx, heightAt(PAD.cx, PAD.cz), PAD.cz + 6);
    patchObject(st.group);
    this.group.add(st.group);
    this.station = st;
    // The station's own collider covers the whole apron; collide with its structures instead.
    const parts = (st.group.userData.colliders ?? []) as ({ x: number; z: number } & PropBuild['collider'])[];
    for (const c of parts) {
      const x = st.group.position.x + c.x;
      const z = st.group.position.z + c.z;
      this.colliders.add(c.type === 'circle' ? { type: 'circle', x, z, r: c.r, owner: 'station' } : { type: 'box', x, z, hx: c.hx, hz: c.hz, rot: 0, owner: 'station' });
    }
    // Signs at the junction.
    const stop = buildRoadSign('stop');
    stop.group.position.set(-6.5, heightAt(-6.5, -9), -9);
    const sp = buildRoadSign('speed55');
    sp.group.position.set(7, heightAt(7, 90), 90);
    sp.group.rotation.y = Math.PI;
    for (const g of [stop.group, sp.group]) {
      patchObject(g);
      this.group.add(g);
    }
  }

  /** Where the player starts: parked on the lot, nose toward the highway. */
  get startPose(): { x: number; z: number; heading: number } {
    return { x: PAD.cx - 12, z: PAD.cz + 17, heading: Math.PI };
  }

  private addCollider(obj: THREE.Object3D, c: PropBuild['collider'], owner: string): Collider2D {
    const col: Collider2D =
      c.type === 'circle'
        ? { type: 'circle', x: obj.position.x, z: obj.position.z, r: c.r, owner }
        : { type: 'box', x: obj.position.x, z: obj.position.z, hx: c.hx, hz: c.hz, rot: obj.rotation.y, owner };
    this.colliders.add(col);
    return col;
  }

  // ------------------------------------------------------------------ streaming
  update(dt: number, cam: THREE.Vector3, tornado: Tornado | null): void {
    const si = Math.floor(cam.x / MILE);
    const sj = Math.floor(cam.z / MILE);
    const key = si + ',' + sj;
    if (key !== this.lastSection) {
      this.lastSection = key;
      const want = new Set<string>();
      for (let i = si - SECTION_RADIUS; i <= si + SECTION_RADIUS; i++)
        for (let j = sj - SECTION_RADIUS; j <= sj + SECTION_RADIUS; j++) {
          const k = i + ',' + j;
          want.add(k);
          if (!this.farmsteads.has(k) && !this.treeOwner.has(k)) this.buildSection(i, j);
        }
      for (const k of [...this.treeOwner.keys()]) if (!want.has(k)) this.dropSection(k);
    }
    if (Math.hypot(cam.x - this.lastLineCenter.x, cam.z - this.lastLineCenter.y) > 250) {
      this.lastLineCenter.set(cam.x, cam.z);
      this.rebuildPoles(cam);
    }
    if (Math.hypot(cam.x - this.lastFenceCenter.x, cam.z - this.lastFenceCenter.y) > 60) {
      this.lastFenceCenter.set(cam.x, cam.z);
      this.rebuildFences(cam);
    }
    this.destroyTimer -= dt;
    if (tornado && tornado.presence > 0.2 && this.destroyTimer <= 0) {
      this.destroyTimer = 0.15;
      this.applyTornado(tornado);
    }
  }

  private buildSection(i: number, j: number): void {
    const k = i + ',' + j;
    const rng = mulberry32(hash3i(i, j, 77));
    const destroyed = this.destroyed.get(k) ?? new Set<number>();
    const trees: { pool: InstancePool; idx: number; x: number; z: number; stripped: boolean }[] = [];
    this.treeOwner.set(k, trees);
    const x0 = i * MILE, z0 = j * MILE;
    const addTree = (kind: string, x: number, z: number, scale: number) => {
      const t = this.trees.find((tt) => tt.kind === kind) ?? this.trees[0];
      const id = trees.length;
      const stripped = destroyed.has(1000 + id);
      _q.setFromAxisAngle(UP, rng() * Math.PI * 2);
      _s.setScalar(scale);
      _m.compose(_p.set(x, heightAt(x, z) - 0.2, z), _q, _s);
      const idx = t.pool.alloc(_m);
      if (idx < 0) return;
      trees.push({ pool: t.pool, idx, x, z, stripped });
      if (stripped) this.stripTree(trees[trees.length - 1]);
      this.colliders.add({ type: 'circle', x, z, r: 0.45 * scale, owner: 'tree:' + k });
    };

    // Farmstead.
    if (rng() < 0.42 && !(i === 0 && j === -1)) {
      const side = Math.floor(rng() * 4); // which road edge it fronts
      const along = 250 + rng() * (MILE - 500);
      const setback = 55 + rng() * 45;
      // Local frame: front faces the road.
      let cx: number, cz: number, rot: number;
      if (side === 0) { cx = x0 + along; cz = z0 + setback; rot = Math.PI; } // fronts north road (z0), faces -z
      else if (side === 1) { cx = x0 + along; cz = z0 + MILE - setback; rot = 0; }
      else if (side === 2) { cx = x0 + setback; cz = z0 + along; rot = -Math.PI / 2; }
      else { cx = x0 + MILE - setback; cz = z0 + along; rot = Math.PI / 2; }
      const fs: Farmstead = { key: k, group: new THREE.Group(), buildings: [], trees: [], center: new THREE.Vector2(cx, cz) };
      const fwd = new THREE.Vector2(Math.sin(rot), Math.cos(rot)); // local +Z (toward road)
      const rgt = new THREE.Vector2(Math.cos(rot), -Math.sin(rot)); // local +X
      const place = (b: PropBuild, lx: number, lz: number, yaw: number, label: string, strength: number) => {
        const id = fs.buildings.length;
        const x = cx + rgt.x * lx + fwd.x * lz;
        const z = cz + rgt.y * lx + fwd.y * lz;
        // Sit on the lowest corner so nothing floats on slopes.
        const g = Math.min(heightAt(x, z), heightAt(x + 4, z + 4), heightAt(x - 4, z - 4), heightAt(x + 4, z - 4), heightAt(x - 4, z + 4));
        b.group.position.set(x, g, z);
        b.group.rotation.y = rot + yaw;
        const bld: Building = { obj: b.group, collider: this.addCollider(b.group, b.collider, 'farm:' + k), label, strength, destroyed: false };
        fs.buildings.push(bld);
        if (destroyed.has(id)) this.ruin(bld, false);
        else fs.group.add(b.group);
      };
      place(buildFarmhouse(rng), -14 + rng() * 6, 8, 0, 'Farmhouse destroyed', 62 + rng() * 10);
      if (rng() < 0.75) place(buildBarn(rng), 26 + rng() * 10, -28 - rng() * 12, Math.PI / 2 * Math.floor(rng() * 2), 'Barn destroyed', 52 + rng() * 8);
      if (rng() < 0.6) {
        const n = 1 + Math.floor(rng() * 3);
        for (let b = 0; b < n; b++) place(buildGrainBin(rng, 8 + rng() * 6), 52 + b * 13, -8 + rng() * 3, 0, 'Grain bin torn apart', 50);
      }
      if (rng() < 0.3) place(buildSilo(rng), 40, -48, 0, 'Silo damaged', 75);
      if (rng() < 0.5) place(buildMachineShed(rng), -30, -40, Math.PI / 2, 'Machine shed destroyed', 48);
      const mb = buildMailbox(rng);
      place(mb, -6, setback - 7, 0, 'Mailbox', 40);
      // Windbreak: rows of cedars along the back and the west side, plus yard trees.
      for (let r = 0; r < 2; r++)
        for (let t = -60; t <= 80; t += 5.5) {
          const lx = t + (rng() - 0.5) * 2, lz = -78 - r * 6 + (rng() - 0.5) * 2;
          addTree(r === 0 ? 'cedar' : 'elm', cx + rgt.x * lx + fwd.x * lz, cz + rgt.y * lx + fwd.y * lz, 0.8 + rng() * 0.5);
        }
      for (let t = -70; t <= 0; t += 6) {
        const lx = -62 + (rng() - 0.5) * 2, lz = t;
        addTree('cedar', cx + rgt.x * lx + fwd.x * lz, cz + rgt.y * lx + fwd.y * lz, 0.8 + rng() * 0.4);
      }
      for (let n = 0; n < 6; n++) {
        const lx = -30 + rng() * 40, lz = -10 + rng() * 26;
        if (Math.abs(lx + 12) < 9 && Math.abs(lz - 8) < 8) continue;
        addTree(rng() < 0.5 ? 'cottonwood' : 'elm', cx + rgt.x * lx + fwd.x * lz, cz + rgt.y * lx + fwd.y * lz, 0.9 + rng() * 0.6);
      }
      patchObject(fs.group);
      this.group.add(fs.group);
      this.farmsteads.set(k, fs);
    }

    // Hedgerow along one fence line of the section.
    if (rng() < 0.25) {
      const alongX = rng() < 0.5;
      const off = FENCE_OFFSET + 3;
      for (let t = 40; t < MILE - 40; t += 7 + rng() * 6) {
        if (rng() < 0.15) continue;
        const x = alongX ? x0 + t : x0 + off;
        const z = alongX ? z0 + off : z0 + t;
        addTree('osage', x, z, 0.7 + rng() * 0.5);
      }
    }
    // Lone cottonwoods in pastures / along draws.
    const lone = Math.floor(rng() * 4);
    for (let n = 0; n < lone; n++) addTree('cottonwood', x0 + 80 + rng() * (MILE - 160), z0 + 80 + rng() * (MILE - 160), 1 + rng() * 0.5);

    // Round bales in hay fields.
    const bales: { idx: number; x: number; z: number }[] = [];
    for (let q = 0; q < 4; q++) {
      const qx = x0 + (q % 2) * (MILE / 2) + MILE / 4;
      const qz = z0 + Math.floor(q / 2) * (MILE / 2) + MILE / 4;
      const ft = fieldTypeAt(qx, qz);
      if ((ft === 1 || ft === 4) && rng() < 0.45) {
        const n = 6 + Math.floor(rng() * 14);
        const dir = rng() * Math.PI;
        for (let b = 0; b < n; b++) {
          const id = 5000 + q * 100 + b;
          if (destroyed.has(id)) continue;
          const x = qx + Math.cos(dir) * (b - n / 2) * 22 + (rng() - 0.5) * 30;
          const z = qz + Math.sin(dir) * (b - n / 2) * 22 + (rng() - 0.5) * 30;
          _q.setFromAxisAngle(UP, rng() * Math.PI);
          _m.compose(_p.set(x, heightAt(x, z), z), _q, _s.setScalar(1));
          const idx = this.bales.alloc(_m);
          if (idx >= 0) bales.push({ idx, x, z });
        }
      }
    }
    this.baleOwner.set(k, bales);
  }

  private dropSection(k: string): void {
    const fs = this.farmsteads.get(k);
    if (fs) {
      this.group.remove(fs.group);
      this.colliders.removeOwner('farm:' + k);
      this.farmsteads.delete(k);
    }
    for (const t of this.treeOwner.get(k) ?? []) t.pool.release(t.idx);
    this.treeOwner.delete(k);
    this.colliders.removeOwner('tree:' + k);
    for (const b of this.baleOwner.get(k) ?? []) this.bales.release(b.idx);
    this.baleOwner.delete(k);
  }

  // ------------------------------------------------------------------ lines
  private rebuildPoles(cam: THREE.Vector3): void {
    this.poles.clear();
    this.poleIndex = [];
    this.colliders.removeOwner('pole');
    const R = 2600;
    const spacing = 58;
    const add = (x: number, z: number, rot: number, key: string) => {
      const g = heightAt(x, z);
      _q.setFromAxisAngle(UP, rot);
      if (this.brokenPoles.has(key)) {
        const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.35);
        _q.multiply(tilt);
      }
      _m.compose(_p.set(x, g - 0.1, z), _q, _s.setScalar(1));
      const idx = this.poles.alloc(_m);
      if (idx < 0) return;
      this.poleIndex.push({ key, x, z, rot, idx });
      if (!this.brokenPoles.has(key)) {
        const col: Collider2D = { type: 'circle', x, z, r: 0.18, owner: 'pole' };
        col.onHit = (impact) => {
          if (impact < 11 || this.brokenPoles.has(key)) return;
          this.brokenPoles.add(key);
          this.colliders.remove(col);
          this.lastLineCenter.set(1e9, 1e9);
        };
        this.colliders.add(col);
      }
    };
    const i0 = Math.round((cam.x - R) / MILE), i1 = Math.round((cam.x + R) / MILE);
    const j0 = Math.round((cam.z - R) / MILE), j1 = Math.round((cam.z + R) / MILE);
    for (let i = i0; i <= i1; i++) {
      const side = (i & 1) === 0 ? 1 : -1;
      const x = i * MILE + side * (roadHalf(i) + 7.5);
      for (let z = Math.ceil((cam.z - R) / spacing) * spacing; z < cam.z + R; z += spacing) {
        const nearJ = Math.abs(z - Math.round(z / MILE) * MILE);
        if (nearJ < 18) continue;
        add(x, z, 0, `ns${i}:${z}`);
      }
    }
    for (let j = j0; j <= j1; j++) {
      const side = (j & 1) === 0 ? -1 : 1;
      const z = j * MILE + side * (roadHalf(j) + 7.5);
      for (let x = Math.ceil((cam.x - R) / spacing) * spacing; x < cam.x + R; x += spacing) {
        const nearI = Math.abs(x - Math.round(x / MILE) * MILE);
        if (nearI < 18) continue;
        add(x, z, Math.PI / 2, `ew${j}:${x}`);
      }
    }
    this.rebuildWires();
  }

  private rebuildWires(): void {
    const pts: number[] = [];
    const byLine = new Map<string, { x: number; z: number; rot: number; key: string; along: number }[]>();
    for (const p of this.poleIndex) {
      const [line, a] = p.key.split(':');
      let arr = byLine.get(line);
      if (!arr) byLine.set(line, (arr = []));
      arr.push({ ...p, along: Number(a) });
    }
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    for (const arr of byLine.values()) {
      arr.sort((a, b) => a.along - b.along);
      for (let n = 1; n < arr.length; n++) {
        const a = arr[n - 1], b = arr[n];
        if (b.along - a.along > 70 || this.brokenPoles.has(a.key) || this.brokenPoles.has(b.key)) continue;
        const ga = heightAt(a.x, a.z), gb = heightAt(b.x, b.z);
        for (const att of this.poleAttach) {
          const ca = Math.cos(a.rot), sa = Math.sin(a.rot);
          A.set(a.x + att.x * ca + att.z * sa, ga + att.y, a.z - att.x * sa + att.z * ca);
          B.set(b.x + att.x * ca + att.z * sa, gb + att.y, b.z - att.x * sa + att.z * ca);
          // Catenary sag in 8 segments.
          const seg = 8;
          for (let s = 0; s < seg; s++) {
            const t0 = s / seg, t1 = (s + 1) / seg;
            const sag = (t: number) => -1.1 * 4 * t * (1 - t);
            pts.push(
              A.x + (B.x - A.x) * t0, A.y + (B.y - A.y) * t0 + sag(t0), A.z + (B.z - A.z) * t0,
              A.x + (B.x - A.x) * t1, A.y + (B.y - A.y) * t1 + sag(t1), A.z + (B.z - A.z) * t1,
            );
          }
        }
      }
    }
    this.wires.geometry.dispose();
    this.wires.geometry = new THREE.BufferGeometry();
    this.wires.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  private rebuildFences(cam: THREE.Vector3): void {
    this.posts.clear();
    this.postIndex = [];
    const R = 380;
    const spacing = 5;
    const wire: number[] = [];
    const lineAlong = (fixed: number, axis: 'x' | 'z', from: number, to: number, keyBase: string, crossHalf: (n: number) => number) => {
      let prev: THREE.Vector3 | null = null;
      for (let a = Math.ceil(from / spacing) * spacing; a < to; a += spacing) {
        // Gaps at intersections and at the gas station lot.
        const cross = Math.round(a / MILE);
        if (Math.abs(a - cross * MILE) < crossHalf(cross) + FENCE_OFFSET + 2) {
          prev = null;
          continue;
        }
        const x = axis === 'x' ? a : fixed;
        const z = axis === 'x' ? fixed : a;
        if (x > PAD.x0 - 6 && x < PAD.x1 + 6 && z > PAD.z0 - 6 && z < PAD.z1 + 6) {
          prev = null;
          continue;
        }
        const key = `${keyBase}:${a}`;
        const h = hash3i(Math.round(x), Math.round(z), 5);
        const g = heightAt(x, z);
        const broken = this.brokenPosts.has(key);
        // Old posts lean a little (and a few lean a lot).
        const lean = ((h & 255) / 255 - 0.5) * 0.12 + ((h >>> 8) % 23 === 0 ? 0.25 : 0);
        _q.setFromEuler(new THREE.Euler(broken ? 1.4 : lean, ((h >>> 16) & 255) / 40, ((h >>> 4) & 255) / 255 * 0.08 - 0.04));
        _m.compose(_p.set(x, g - 0.05, z), _q, _s.set(1, 0.9 + ((h >>> 12) & 15) / 60, 1));
        const idx = this.posts.alloc(_m);
        if (idx >= 0) this.postIndex.push({ key, x, z, idx });
        const cur = new THREE.Vector3(x, g, z);
        if (prev && !broken) for (const y of [0.55, 0.85, 1.15]) wire.push(prev.x, prev.y + y, prev.z, cur.x, cur.y + y - 0.03, cur.z);
        prev = broken ? null : cur;
      }
    };
    const i0 = Math.round((cam.x - R) / MILE), i1 = Math.round((cam.x + R) / MILE);
    const j0 = Math.round((cam.z - R) / MILE), j1 = Math.round((cam.z + R) / MILE);
    for (let i = i0; i <= i1; i++)
      for (const side of [-1, 1]) lineAlong(i * MILE + side * FENCE_OFFSET, 'z', cam.z - R, cam.z + R, `fns${i}${side}`, (n) => roadHalf(n));
    for (let j = j0; j <= j1; j++)
      for (const side of [-1, 1]) lineAlong(j * MILE + side * FENCE_OFFSET, 'x', cam.x - R, cam.x + R, `few${j}${side}`, (n) => roadHalf(n));
    this.fenceWires.geometry.dispose();
    this.fenceWires.geometry = new THREE.BufferGeometry();
    this.fenceWires.geometry.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
  }

  // ------------------------------------------------------------------ destruction
  private applyTornado(t: Tornado): void {
    const reach = t.radius * 2.6 + 80;
    const tp = t.position;
    // Buildings.
    for (const fs of this.farmsteads.values()) {
      if (Math.hypot(fs.center.x - tp.x, fs.center.y - tp.z) > reach + 150) continue;
      fs.buildings.forEach((b, id) => {
        if (b.destroyed) return;
        _p.set(b.obj.position.x, b.obj.position.y + 3, b.obj.position.z);
        const w = t.windAt(_p, _w).length();
        if (w > b.strength) {
          this.ruin(b, true, t);
          let set = this.destroyed.get(fs.key);
          if (!set) this.destroyed.set(fs.key, (set = new Set()));
          set.add(id);
          this.onDestroyed?.(b.obj.position.clone(), b.label);
        }
      });
    }
    // Trees.
    for (const [k, trees] of this.treeOwner) {
      trees.forEach((tr, id) => {
        if (tr.stripped || Math.abs(tr.x - tp.x) > reach || Math.abs(tr.z - tp.z) > reach) return;
        _p.set(tr.x, heightAt(tr.x, tr.z) + 4, tr.z);
        if (t.windAt(_p, _w).length() > 48) {
          this.stripTree(tr);
          let set = this.destroyed.get(k);
          if (!set) this.destroyed.set(k, (set = new Set()));
          set.add(1000 + id);
        }
      });
    }
    // Hay bales get picked up and thrown.
    for (const bales of this.baleOwner.values()) {
      for (let n = bales.length - 1; n >= 0; n--) {
        const b = bales[n];
        if (Math.abs(b.x - tp.x) > reach || Math.abs(b.z - tp.z) > reach) continue;
        _p.set(b.x, heightAt(b.x, b.z) + 1, b.z);
        const w = t.windAt(_p, _w);
        if (w.length() > 40) {
          const mesh = new THREE.Group();
          for (const part of this.bales.asset.parts) mesh.add(new THREE.Mesh(part.geometry, part.material));
          this.bales.matrices[b.idx].decompose(mesh.position, mesh.quaternion, mesh.scale);
          this.group.add(mesh);
          this.debris.throwObject(mesh, w.clone().multiplyScalar(0.4), 3);
          this.bales.release(b.idx);
          bales.splice(n, 1);
        }
      }
    }
    // Poles and fence posts snap.
    let wiresDirty = false;
    for (const p of this.poleIndex) {
      if (this.brokenPoles.has(p.key) || Math.abs(p.x - tp.x) > reach || Math.abs(p.z - tp.z) > reach) continue;
      _p.set(p.x, heightAt(p.x, p.z) + 6, p.z);
      const w = t.windAt(_p, _w);
      if (w.length() > 45) {
        this.brokenPoles.add(p.key);
        const yaw = Math.atan2(w.x, w.z);
        _q.setFromEuler(new THREE.Euler(1.3, yaw, 0, 'YXZ'));
        _m.compose(_p.set(p.x, heightAt(p.x, p.z), p.z), _q, _s.setScalar(1));
        this.poles.set(p.idx, _m);
        wiresDirty = true;
      }
    }
    if (wiresDirty) this.rebuildWires();
    for (const p of this.postIndex) {
      if (this.brokenPosts.has(p.key) || Math.abs(p.x - tp.x) > reach || Math.abs(p.z - tp.z) > reach) continue;
      _p.set(p.x, heightAt(p.x, p.z) + 1, p.z);
      if (t.windAt(_p, _w).length() > 38) {
        this.brokenPosts.add(p.key);
        this.lastFenceCenter.set(1e9, 1e9); // rebuild next frame
      }
    }
  }

  private stripTree(tr: { pool: InstancePool; idx: number; stripped: boolean }): void {
    tr.stripped = true;
    const base = tr.pool.matrices[tr.idx].clone();
    // Keep the trunk (part 0), drop the crown and other parts.
    tr.pool.meshes.forEach((_mesh, k) => {
      if (k === 0) {
        const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
        base.decompose(pos, q, s);
        s.multiplyScalar(0.85);
        tr.pool.set(tr.idx, new THREE.Matrix4().compose(pos, q, s), 0);
      } else tr.pool.set(tr.idx, new THREE.Matrix4().makeScale(0, 0, 0), k);
    });
  }

  /** Tear a building apart: its child meshes become debris, a slab remains. */
  private ruin(b: Building, animate: boolean, t?: Tornado): void {
    b.destroyed = true;
    this.colliders.remove(b.collider);
    const parent = b.obj.parent;
    if (animate && t && parent) {
      b.obj.updateMatrixWorld(true);
      const parts: THREE.Object3D[] = [];
      b.obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) parts.push(o);
      });
      for (const o of parts) {
        o.getWorldPosition(_p);
        const w = t.windAt(_p, _w).clone();
        // Heavier, lower parts get less of the wind.
        const box = new THREE.Box3().setFromObject(o);
        const size = box.getSize(new THREE.Vector3());
        const mass = Math.max(0.5, (size.x * size.y * size.z) / 6);
        this.debris.throwObject(o, w.multiplyScalar(0.25 + Math.random() * 0.3).add(new THREE.Vector3(0, 6 + Math.random() * 10, 0)), mass);
      }
    }
    if (parent) parent.remove(b.obj);
    // Foundation slab left behind.
    const c = b.collider;
    const hx = c.type === 'box' ? c.hx : c.r;
    const hz = c.type === 'box' ? c.hz : c.r;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.4, hz * 2), new THREE.MeshStandardMaterial({ color: '#6d6a64', roughness: 0.95 }));
    slab.position.copy(b.obj.position).setY(b.obj.position.y + 0.1);
    slab.rotation.y = b.obj.rotation.y;
    patchObject(slab);
    this.group.add(slab);
  }

  /** Query colliders (vehicle / walker). */
  query = (x: number, z: number, r: number): Iterable<Collider2D> => this.colliders.query(x, z, r);
}
