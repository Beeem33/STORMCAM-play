import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M } from './materials';
import { memo } from './textures';
import type { InstancedAsset, TreeKind } from './types';
import { V, clamp, fbm3, merge, mulberry32, rand, smoothstep } from './util';
import type { RNG } from './util';

interface Lobe { c: THREE.Vector3; r: THREE.Vector3 }
interface Spec { leaf: string; bark: string; tipYellow: number }
const SPECS: Record<TreeKind, Spec> = {
  cottonwood: { leaf: '#5f6d36', bark: '#857f73', tipYellow: 0.18 },
  elm: { leaf: '#4d5a32', bark: '#6d665b', tipYellow: 0.08 },
  osage: { leaf: '#4e5a2b', bark: '#7d6650', tipYellow: 0.12 },
  cedar: { leaf: '#36463a', bark: '#76574a', tipYellow: 0.0 },
  shrub: { leaf: '#56612f', bark: '#5d4c40', tipYellow: 0.1 },
};

const UP = V(0, 1, 0);
/** Tapered open tube from a to b with vertex colour and metric bark UVs. */
function tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, segs: number, col: THREE.Color): THREE.BufferGeometry {
  const dir = b.clone().sub(a), len = dir.length();
  const g = new THREE.CylinderGeometry(rb, ra, len, segs, 1, true);
  g.translate(0, len / 2, 0);
  const uv = g.getAttribute('uv');
  const circ = Math.PI * (ra + rb);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * len + a.y);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  const n = g.getAttribute('position').count, c = new Float32Array(n * 3), p = g.getAttribute('position');
  for (let i = 0; i < n; i++) {
    const k = 0.75 + 0.25 * smoothstep(0, 3, p.getY(i));
    c[i * 3] = col.r * k; c[i * 3 + 1] = col.g * k; c[i * 3 + 2] = col.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Crown surface = union of ellipsoid lobes ray-cast from `center`, plus noise. */
function unionCrown(center: THREE.Vector3, lobes: Lobe[], detail: number, amp: number, freq: number, seed: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.getAttribute('position');
  const d = new THREE.Vector3();
  const reach = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    d.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    let best = 0;
    for (const L of lobes) {
      const ox = (center.x - L.c.x) / L.r.x, oy = (center.y - L.c.y) / L.r.y, oz = (center.z - L.c.z) / L.r.z;
      const dx = d.x / L.r.x, dy = d.y / L.r.y, dz = d.z / L.r.z;
      const A = dx * dx + dy * dy + dz * dz, B = 2 * (ox * dx + oy * dy + oz * dz), C = ox * ox + oy * oy + oz * oz - 1;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const t = (-B + Math.sqrt(disc)) / (2 * A);
      if (t > best) best = t;
    }
    if (best <= 0) best = 0.5;
    reach[i] = best;
    const px = center.x + d.x * best, py = center.y + d.y * best, pz = center.z + d.z * best;
    const nn = (fbm3(px * freq, py * freq, pz * freq, 3, seed) - 0.5) * 2;
    const rr = best * (1 + amp * nn);
    p.setXYZ(i, center.x + d.x * rr, center.y + d.y * rr, center.z + d.z * rr);
  }
  let mean = 0;
  for (let i = 0; i < reach.length; i++) mean += reach[i]!;
  mean /= reach.length;
  g.computeVertexNormals();
  g.userData.reach = reach;
  g.userData.mean = mean;
  return g;
}

/** Vertex colours (sky-lit top, dark underside/crevices, patchy) + projected foliage UVs. */
function shadeCrown(g: THREE.BufferGeometry, spec: Spec, yMin: number, yMax: number, seed: number): void {
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  const base = new THREE.Color(spec.leaf), yel = new THREE.Color('#7d7a3a');
  const reach = g.userData.reach as Float32Array | undefined, mean = (g.userData.mean as number | undefined) ?? 1;
  const col = new Float32Array(p.count * 3), uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const up = n.getY(i), h = clamp((y - yMin) / (yMax - yMin), 0, 1);
    let ao = 0.55 + 0.28 * (up * 0.5 + 0.5) + 0.25 * h;
    if (reach) ao *= clamp(0.62 + 0.42 * (reach[i]! / mean), 0.55, 1.15);
    const patch = fbm3(x * 0.45, y * 0.45, z * 0.45, 2, seed + 3);
    ao *= 0.8 + 0.4 * patch;
    const ty = spec.tipYellow * smoothstep(0.55, 1, ao) * (0.5 + patch);
    const k = 1.75 * ao;
    col[i * 3] = (base.r + (yel.r - base.r) * ty) * k;
    col[i * 3 + 1] = (base.g + (yel.g - base.g) * ty) * k;
    col[i * 3 + 2] = (base.b + (yel.b - base.b) * ty) * k * (1.05 - 0.15 * h);
    uv[i * 2] = (x - z) * 0.72;
    uv[i * 2 + 1] = y + (x + z) * 0.3;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function blob(c: THREE.Vector3, r: THREE.Vector3, detail: number, seed: number): THREE.BufferGeometry {
  return unionCrown(c, [{ c, r }], detail, 0.12, 0.6, seed);
}

/** Grow a crooked limb as several tube segments; returns the end point. */
function limb(out: THREE.BufferGeometry[], rng: RNG, start: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number, nSeg: number, wander: number, col: THREE.Color, segs = 6): THREE.Vector3 {
  let p = start.clone();
  const d = dir.clone().normalize();
  for (let i = 0; i < nSeg; i++) {
    const t0 = i / nSeg, t1 = (i + 1) / nSeg;
    d.add(V(rand(rng, -wander, wander), rand(rng, -wander * 0.5, wander * 0.5), rand(rng, -wander, wander))).normalize();
    const q = p.clone().addScaledVector(d, len / nSeg);
    out.push(tube(p, q, r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1, segs, col));
    p = q;
  }
  return p;
}

function buildTree(kind: TreeKind, seed: number): InstancedAsset {
  const rng = mulberry32(seed);
  const spec = SPECS[kind];
  const bark = new THREE.Color(spec.bark);
  const wood: THREE.BufferGeometry[] = [];
  const leaves: THREE.BufferGeometry[] = [];
  let height = 0, radius = 0;

  const addCrown = (center: THREE.Vector3, lobes: Lobe[], detail: number, amp: number) => {
    const g = unionCrown(center, lobes, detail, amp, 0.42, seed + leaves.length * 13);
    leaves.push(g);
  };
  const spray = (n: number, c: THREE.Vector3, rx: number, ry: number, size: number, yBias = 0) => {
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, e = rand(rng, -0.6, 0.5) + yBias;
      const pc = V(c.x + Math.cos(a) * rx * Math.cos(e), c.y + Math.sin(e) * ry, c.z + Math.sin(a) * rx * Math.cos(e));
      const s = size * rand(rng, 0.6, 1.2);
      leaves.push(blob(pc, V(s, s * 0.75, s), 0, seed + 100 + i));
    }
  };

  if (kind === 'cottonwood') {
    const fork = rand(rng, 4.0, 5.0);
    const top = limb(wood, rng, V(0, -0.3, 0), V(rand(rng, -0.08, 0.08), 1, rand(rng, -0.08, 0.08)), fork + 0.3, 0.55, 0.42, 2, 0.04, bark, 9);
    wood.push(tube(V(0, -0.3, 0), V(0, 0.9, 0), 0.75, 0.5, 9, bark));
    const a0 = rng() * Math.PI * 2;
    for (let i = 0; i < 3; i++) {
      const a = a0 + (i / 3) * Math.PI * 2 + rand(rng, -0.3, 0.3), lean = rand(rng, 0.32, 0.55);
      const len = rand(rng, 9, 12) * (i === 0 ? 1.1 : 0.9);
      const e = limb(wood, rng, top, V(Math.cos(a) * lean, 1, Math.sin(a) * lean), len, 0.32, 0.1, 3, 0.1, bark, 6);
      const mid = top.clone().lerp(e, 0.45);
      const side = limb(wood, rng, mid, V(Math.cos(a + 0.9) * 1.3, 0.55, Math.sin(a + 0.9) * 1.3), rand(rng, 3.5, 5), 0.13, 0.04, 1, 0.1, bark, 5);
      const c = e.clone().add(V(0, -1.2, 0));
      const lobes: Lobe[] = [
        { c: c.clone(), r: V(rand(rng, 3.6, 4.4), rand(rng, 3.6, 4.4), rand(rng, 3.6, 4.4)) },
        { c: c.clone().lerp(top, 0.35).add(V(0, 0.5, 0)), r: V(3.2, 3.0, 3.2) },
        { c: side.clone(), r: V(2.6, 2.2, 2.6) },
        { c: c.clone().add(V(rand(rng, -1.5, 1.5), 1.8, rand(rng, -1.5, 1.5))), r: V(2.6, 2.4, 2.6) },
      ];
      addCrown(c.clone().lerp(top, 0.15), lobes, 3, 0.12);
    }
    spray(9, V(0, fork + 6.5, 0), 6.0, 4.5, 1.3);
    height = fork + 15;
    radius = 7.5;
  } else if (kind === 'elm') {
    const fork = rand(rng, 2.2, 3.0);
    const top = limb(wood, rng, V(0, -0.3, 0), V(0, 1, 0), fork + 0.3, 0.36, 0.3, 2, 0.04, bark, 8);
    wood.push(tube(V(0, -0.3, 0), V(0, 0.7, 0), 0.5, 0.34, 8, bark));
    const ends: THREE.Vector3[] = [];
    const a0 = rng() * Math.PI * 2;
    for (let i = 0; i < 4; i++) {
      const a = a0 + (i / 4) * Math.PI * 2 + rand(rng, -0.25, 0.25);
      ends.push(limb(wood, rng, top, V(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55), rand(rng, 6.5, 8), 0.2, 0.06, 3, 0.1, bark, 6));
    }
    const lobes: Lobe[] = [{ c: V(0, fork + 6.8, 0), r: V(4.6, 3.4, 4.6) }];
    ends.forEach((e) => lobes.push({ c: e.clone().add(V(0, -0.4, 0)), r: V(rand(rng, 2.8, 3.6), rand(rng, 2.4, 3.0), rand(rng, 2.8, 3.6)) }));
    addCrown(V(0, fork + 6.2, 0), lobes, 4, 0.11);
    spray(7, V(0, fork + 5.2, 0), 5.6, 3.2, 1.1, -0.2);
    height = fork + 11;
    radius = 6.3;
  } else if (kind === 'osage') {
    const nt = 3, a0 = rng() * Math.PI * 2;
    const crownC: THREE.Vector3[] = [];
    for (let i = 0; i < nt; i++) {
      const a = a0 + (i / nt) * Math.PI * 2 + rand(rng, -0.4, 0.4), lean = rand(rng, 0.35, 0.7);
      const e = limb(wood, rng, V(Math.cos(a) * 0.15, -0.3, Math.sin(a) * 0.15), V(Math.cos(a) * lean, 1, Math.sin(a) * lean), rand(rng, 4.5, 6), 0.2, 0.08, 4, 0.22, bark, 6);
      crownC.push(e);
      limb(wood, rng, e.clone().lerp(V(0, 0, 0), 0.4), V(Math.cos(a) * 1.5, -0.1, Math.sin(a) * 1.5), rand(rng, 2.5, 3.5), 0.07, 0.03, 2, 0.2, bark, 5);
    }
    wood.push(tube(V(0, -0.3, 0), V(0, 0.8, 0), 0.4, 0.22, 7, bark));
    for (let k = 0; k < 2; k++) {
      const lobes: Lobe[] = [{ c: V(0, 4.6, 0), r: V(4.6, 2.6, 4.6) }];
      crownC.forEach((e) => lobes.push({ c: e.clone().add(V(rand(rng, -0.6, 0.6), 0.2, rand(rng, -0.6, 0.6))), r: V(rand(rng, 2.6, 3.4), rand(rng, 1.9, 2.4), rand(rng, 2.6, 3.4)) }));
      if (k === 1) lobes.forEach((l) => { l.c.y += 0.7; l.r.multiplyScalar(0.85); });
      addCrown(V(0, 4.8 + k * 0.6, 0), lobes, 3, 0.16);
    }
    spray(10, V(0, 4.0, 0), 5.4, 2.4, 1.0, -0.3);
    height = 8.6;
    radius = 6.6;
  } else if (kind === 'shrub') {
    // wild plum / sumac thicket: a few stems and two offset, irregular clumps that reach the ground
    const a0 = rng() * Math.PI * 2;
    for (let k = 0; k < 2; k++) {
      const a = a0 + k * Math.PI + rand(rng, -0.5, 0.5), d = k === 0 ? 0.35 : 1.1, hgt = k === 0 ? rand(rng, 1.9, 2.4) : rand(rng, 1.3, 1.7);
      const c = V(Math.cos(a) * d, hgt * 0.55, Math.sin(a) * d);
      limb(wood, rng, V(c.x * 0.6, -0.1, c.z * 0.6), V(rand(rng, -0.3, 0.3), 1, rand(rng, -0.3, 0.3)), hgt * 0.8, 0.05, 0.015, 2, 0.25, bark, 4);
      const lobes: Lobe[] = [
        { c: c.clone(), r: V(rand(rng, 0.9, 1.2), hgt * 0.5, rand(rng, 0.9, 1.2)) },
        { c: c.clone().add(V(rand(rng, -0.6, 0.6), hgt * 0.25, rand(rng, -0.6, 0.6))), r: V(0.7, hgt * 0.32, 0.7) },
        { c: c.clone().add(V(rand(rng, -0.8, 0.8), -hgt * 0.2, rand(rng, -0.8, 0.8))), r: V(0.8, hgt * 0.3, 0.8) },
      ];
      addCrown(c, lobes, 2, 0.22);
    }
    spray(3, V(0, 1.0, 0), 1.6, 0.6, 0.4, 0);
    height = 2.4;
    radius = 2.4;
  } else {
    // eastern red cedar: dense narrow cone
    const H = rand(rng, 7.2, 8.6);
    wood.push(tube(V(0, -0.3, 0), V(0, 1.6, 0), 0.24, 0.16, 7, bark));
    const prof: THREE.Vector2[] = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = 0.5 + t * (H - 0.5);
      const r = i === n ? 0.05 : 1.9 * Math.pow(1 - t, 0.62) * (0.8 + 0.2 * Math.sin(Math.min(1, t * 4) * Math.PI * 0.5));
      prof.push(new THREE.Vector2(Math.max(0.02, r), y));
    }
    prof.unshift(new THREE.Vector2(0.02, 0.45));
    let g: THREE.BufferGeometry = new THREE.LatheGeometry(prof, 14);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.32 * (fbm3(x * 0.9 + seed, y * 0.7, z * 0.9, 3, seed) - 0.5) * 2;
      p.setXYZ(i, x * k, y, z * k);
    }
    g.computeVertexNormals();
    let mean = 0;
    const reach = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) { reach[i] = Math.hypot(p.getX(i), p.getZ(i)) + 0.4; mean += reach[i]!; }
    g.userData.reach = reach;
    g.userData.mean = mean / p.count;
    leaves.push(g);
    for (let i = 0; i < 9; i++) {
      const t = rand(rng, 0.1, 0.7), y = 0.5 + t * (H - 0.5), r = 1.9 * Math.pow(1 - t, 0.62), a = rng() * Math.PI * 2;
      leaves.push(blob(V(Math.cos(a) * r * 0.62, y, Math.sin(a) * r * 0.62), V(0.7, 1.0, 0.7).multiplyScalar(rand(rng, 0.7, 1.0)), 1, seed + 50 + i));
    }
    height = H;
    radius = 2.1;
  }
  let yMin = Infinity, yMax = -Infinity;
  for (const l of leaves) { l.computeBoundingBox(); yMin = Math.min(yMin, l.boundingBox!.min.y); yMax = Math.max(yMax, l.boundingBox!.max.y); }
  leaves.forEach((l, i) => shadeCrown(l, spec, yMin, yMax, seed + i));
  return {
    parts: [
      { geometry: merge(wood, true), material: M.bark() },
      { geometry: merge(leaves, true), material: M.foliage() },
    ],
    height,
    radius,
  };
}

/** One instanced asset per species (shared bark + foliage materials, vertex coloured). */
export function treeAssets(): { kind: TreeKind; asset: InstancedAsset }[] {
  return memo('asset:trees', () =>
    (['cottonwood', 'elm', 'cedar', 'osage', 'shrub'] as const).map((kind, i) => ({ kind, asset: buildTree(kind, 1201 + i * 977) })),
  );
}
