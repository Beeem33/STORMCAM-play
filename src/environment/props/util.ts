import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropBuild } from './types';

// ---------------------------------------------------------------- RNG / math

export type RNG = () => number;

export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rand = (rng: RNG, a: number, b: number): number => a + (b - a) * rng();
export const randInt = (rng: RNG, a: number, b: number): number => Math.min(b, a + Math.floor((b - a + 1) * rng()));
export function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))] as T;
}
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- noise

export function hash4(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1) ^ Math.imul((s | 0) + 0x3c6ef372, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const fade = (t: number): number => t * t * (3 - 2 * t);

/** 3D value noise in [0,1). */
export function vnoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi);
  const c000 = hash4(xi, yi, zi, seed), c100 = hash4(xi + 1, yi, zi, seed);
  const c010 = hash4(xi, yi + 1, zi, seed), c110 = hash4(xi + 1, yi + 1, zi, seed);
  const c001 = hash4(xi, yi, zi + 1, seed), c101 = hash4(xi + 1, yi, zi + 1, seed);
  const c011 = hash4(xi, yi + 1, zi + 1, seed), c111 = hash4(xi + 1, yi + 1, zi + 1, seed);
  const x00 = lerp(c000, c100, fx), x10 = lerp(c010, c110, fx), x01 = lerp(c001, c101, fx), x11 = lerp(c011, c111, fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}
export function fbm3(x: number, y: number, z: number, oct = 3, seed = 0): number {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise3(x * f, y * f, z * f, seed + o * 17);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}
/** Tileable 2D value noise; x,y in lattice units, periodic in px,py. */
export function tnoise2(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash4(x0, y0, 0, seed), b = hash4(x1, y0, 0, seed), c = hash4(x0, y1, 0, seed), d = hash4(x1, y1, 0, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Tileable fBm over the unit square (u,v in [0,1)); fx,fy integer base cell counts. */
export function tfbm2(u: number, v: number, fx: number, fy: number, oct: number, seed: number): number {
  let a = 1, s = 0, n = 0, mx = fx, my = fy;
  for (let o = 0; o < oct; o++) {
    s += a * tnoise2(u * mx, v * my, mx, my, seed + o * 31);
    n += a;
    a *= 0.5;
    mx *= 2;
    my *= 2;
  }
  return s / n;
}

// ---------------------------------------------------------------- geometry helpers

export type Rect = readonly [number, number, number, number]; // u0,v0,u1,v1
export const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
export const AX = V(1, 0, 0);
export const AZ = V(0, 0, 1);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);

/** Apply rotation (Euler YXZ) then translation. */
export function xf<T extends THREE.BufferGeometry>(g: T, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): T {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _m.compose(_p, _q, _one);
  g.applyMatrix4(_m);
  return g;
}

/** Box with UVs in metres on every face (v = up on side faces). */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv');
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = dims[f]!;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  return g;
}

/** Box whose faces (px,nx,py,ny,pz,nz) map into atlas rects. */
export function boxAtlas(w: number, h: number, d: number, faces: readonly Rect[]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv');
  for (let f = 0; f < 6; f++) {
    const r = faces[f]!;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, r[0] + uv.getX(k) * (r[2] - r[0]), r[1] + uv.getY(k) * (r[3] - r[1]));
    }
  }
  return g;
}

/** Cylinder standing on y=0 with metric UVs (caps planar). */
export function cyl(rTop: number, rBot: number, h: number, segs: number, open = false, hSegs = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, segs, hSegs, open);
  g.translate(0, h / 2, 0);
  const uv = g.getAttribute('uv'), n = g.getAttribute('normal'), p = g.getAttribute('position');
  const circ = Math.PI * (rTop + rBot);
  const slant = Math.hypot(h, rBot - rTop);
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(n.getY(i)) > 0.999) uv.setXY(i, p.getX(i), p.getZ(i));
    else uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * slant);
  }
  return g;
}

/** Planar box-projected metric UVs from current positions & normals. */
export function projUV(g: THREE.BufferGeometry, ou = 0, ov = 0): THREE.BufferGeometry {
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  if (!g.hasAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.count * 2), 2));
  const uv = g.getAttribute('uv');
  for (let i = 0; i < p.count; i++) {
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let u: number, v: number;
    if (ay > ax && ay > az) { u = x; v = -z; }
    else if (ax > az) { u = nx > 0 ? -z : z; v = y; }
    else { u = nz > 0 ? x : -x; v = y; }
    uv.setXY(i, u + ou, v + ov);
  }
  uv.needsUpdate = true;
  return g;
}

export function offsetUV(g: THREE.BufferGeometry, du: number, dv: number): THREE.BufferGeometry {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
  return g;
}

/** Extruded polygon in the XY plane, thickness centred on z=0. */
export function prism(pts: readonly (readonly [number, number])[], thick: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, steps: 1, curveSegments: 1 });
  g.translate(0, 0, -thick / 2);
  return g;
}

/**
 * Roof slab whose underside lies on the line A (upper) -> B (lower), running `len` along `along`.
 * Extends overA beyond A and overB beyond B. Top-face UVs are metric with v pointing up-slope.
 */
export function slab(A: THREE.Vector3, B: THREE.Vector3, along: THREE.Vector3, len: number, thick: number, overA: number, overB: number): THREE.BufferGeometry {
  const d = B.clone().sub(A);
  const segLen = d.length();
  d.normalize();
  const e1 = along.clone().normalize();
  const e2 = new THREE.Vector3().crossVectors(d, e1);
  if (e2.y < 0) { e1.negate(); e2.negate(); }
  const g = box(len, thick, segLen + overA + overB);
  const m = new THREE.Matrix4().makeBasis(e1, e2, d);
  const mid = A.clone().addScaledVector(d, (segLen + overB - overA) / 2).addScaledVector(e2, thick / 2);
  m.setPosition(mid);
  g.applyMatrix4(m);
  return g;
}

/** Merge geometries (all indexed -> indexed, else non-indexed) keeping position/normal/uv(/color). */
export function merge(list: THREE.BufferGeometry[], color = false): THREE.BufferGeometry {
  const keep = color ? ['position', 'normal', 'uv', 'color'] : ['position', 'normal', 'uv'];
  const indexed = list.every((g) => g.index !== null);
  const prepared = list.map((g0) => {
    const g = indexed ? g0 : g0.index ? g0.toNonIndexed() : g0;
    if (!g.hasAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('position').count;
    if (!g.hasAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (color && !g.hasAttribute('color')) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    g.clearGroups();
    g.morphAttributes = {};
    return g;
  });
  const out = mergeGeometries(prepared, false);
  if (!out) throw new Error('props: mergeGeometries failed');
  return out;
}

/** Mesh with its pivot at the geometry's bbox centre (nicer for debris physics). */
export function part(name: string, geo: THREE.BufferGeometry, mat: THREE.Material, castShadow = true): THREE.Mesh {
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.position.copy(c);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

/** Add a merged part if the list is non-empty. */
export function addPart(group: THREE.Group, name: string, geos: THREE.BufferGeometry[], mat: THREE.Material, castShadow = true): void {
  if (geos.length === 0) return;
  group.add(part(name, geos.length === 1 ? geos[0]! : merge(geos), mat, castShadow));
}

/** Re-centre a building group on its footprint and produce a box collider. */
export function finish(group: THREE.Group, minX: number, maxX: number, minZ: number, maxZ: number): PropBuild {
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (const c of group.children) {
    c.position.x -= cx;
    c.position.z -= cz;
  }
  group.userData.breakable = true;
  return { group, collider: { type: 'box', hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 } };
}

export function geoTris(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
export function triCount(o: THREE.Object3D): number {
  let t = 0;
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) t += geoTris(m.geometry);
  });
  return t;
}

const _UP = new THREE.Vector3(0, 1, 0);
/** Box strut (w x d cross-section) from a to b, metric UVs. */
export function strut(a: THREE.Vector3, b: THREE.Vector3, w: number, d = w): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = Math.max(1e-4, dir.length());
  const g = box(w, len, d);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_UP, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}
/** Round rod from a to b. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, segs = 6, open = true, r2 = r): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = Math.max(1e-4, dir.length());
  const g = cyl(r2, r, len, segs, open);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_UP, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}
/** Single quad a,b,c,d (counter-clockwise seen from the front) with uv 0..1. */
export function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: Rect = [0, 0, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}
