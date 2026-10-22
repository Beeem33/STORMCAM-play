import * as THREE from 'three';
import { M, std } from './materials';
import { canvas, ctx2d, mkTex, rustyPaintTex } from './textures';
import type { PropBuild } from './types';
import { V, addPart, box, cyl, fbm3, mulberry32, part, pick, prism, projUV, quad, rand, xf } from './util';
import type { RNG } from './util';

const PAINTS = ['#5f8f8a', '#8a4a36', '#a89a78', '#5c6b4e', '#7d8a96', '#b9b4a4', '#6d5f45'];

const truckGlass = () => std('truckglass', () => {
  const W = 256, H = 256, c = canvas(W, H), x = ctx2d(c);
  const gr = x.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#5a6066'); gr.addColorStop(1, '#22262a');
  x.fillStyle = gr; x.fillRect(0, 0, W, H);
  const r = mulberry32(9);
  x.strokeStyle = 'rgba(210,214,212,0.55)'; x.lineWidth = 1.2;
  const cx = 70, cy = 90;
  for (let i = 0; i < 9; i++) { x.beginPath(); x.moveTo(cx, cy); let px = cx, py = cy; const a = r() * Math.PI * 2; for (let k = 0; k < 5; k++) { px += Math.cos(a + (r() - 0.5) * 0.6) * 30; py += Math.sin(a + (r() - 0.5) * 0.6) * 30; x.lineTo(px, py); } x.stroke(); }
  x.fillStyle = 'rgba(150,140,115,0.35)'; x.fillRect(0, H * 0.75, W, H * 0.25);
  for (let i = 0; i < 300; i++) { x.fillStyle = `rgba(160,150,130,${r() * 0.3})`; x.fillRect(r() * W, r() * H, 2, 2); }
  const map = mkTex(c, true);
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  return { map, roughness: 0.25, metalness: 0 };
});
const grassMat = () => std('tallgrass', () => ({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 }));

/** Side profile (z forward, y up) with a semicircular wheel arch cut from the bottom edge. */
function archProfile(top: [number, number][], zBackBottom: number, zFrontBottom: number, archZ: number, archR: number, yb: number): [number, number][] {
  const pts: [number, number][] = [...top, [zBackBottom, yb]];
  pts.push([archZ - archR, yb]);
  for (let i = 1; i < 8; i++) { const a = Math.PI - (i / 8) * Math.PI; pts.push([archZ + Math.cos(a) * archR, yb + Math.sin(a) * archR]); }
  pts.push([archZ + archR, yb], [zFrontBottom, yb]);
  return pts;
}

/** Rusty 1970s-style generic pickup abandoned in tall grass. Front faces +Z. */
export function buildAbandonedTruck(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'abandoned_truck';
  const W = 1.95, yb = 0.46, wr = 0.38, fz = 1.55, rz = -1.65;
  const col = pick(rng, PAINTS);
  const rust = rand(rng, 0.2, 0.55);
  const mBody = std('truckpaint:' + col + ':' + rust.toFixed(2), () => { const t = rustyPaintTex(col, rust); return { map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0 }; });
  const mChrome = std('rustychrome', () => { const t = rustyPaintTex('#a7a9a6', 0.7); return { map: t.map, roughnessMap: t.roughnessMap, roughness: 0.8, metalness: 0.2 }; });
  const sink = rand(rng, 0.05, 0.14);

  // cab + hood: one extruded side profile
  const cabTop: [number, number][] = [[2.62, yb + 0.02], [2.66, 1.02], [2.6, 1.13], [0.95, 1.17], [0.85, 1.19], [0.36, 1.78], [-0.52, 1.8], [-0.62, 1.76]];
  const cab = prism(archProfile(cabTop, -0.65, 2.62, fz, 0.5, yb).reverse(), W);
  cab.rotateY(-Math.PI / 2); // shape x (length) -> world +Z, extrusion -> X
  g.add(part('cab', projUV(cab), mBody));
  // bed walls
  const bedTop: [number, number][] = [[-0.72, 1.14], [-2.8, 1.14]];
  const bedSide = (sx: number) => {
    const s = prism(archProfile([[-0.72, yb + 0.02], ...bedTop], -2.8, -0.72, rz, 0.5, yb).reverse(), 0.06);
    s.rotateY(-Math.PI / 2);
    return xf(s, sx * (W / 2 - 0.03), 0, 0);
  };
  const bed = [bedSide(-1), bedSide(1), xf(box(W - 0.1, 0.05, 2.06), 0, 0.64, -1.77), xf(box(W, 0.55, 0.05), 0, 0.86, -0.74)];
  const gate = rng();
  if (gate < 0.55) bed.push(xf(box(W, 0.55, 0.05), 0, 0.86, -2.8));
  else if (gate < 0.8) bed.push(xf(box(W, 0.05, 0.55), 0, 0.62, -3.07, 0, 0.08));
  addPart(g, 'bed', bed.map((b) => projUV(b)), mBody);
  // glass
  const glass: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 + 0.006);
    const a = V(x, 1.24, -0.48), b = V(x, 1.24, 0.72), c = V(x, 1.7, 0.4), d = V(x, 1.7, -0.48);
    glass.push(sx > 0 ? quad(b, a, d, c) : quad(a, b, c, d));
  }
  const n = new THREE.Vector3(0, 0.45, 0.5).normalize().multiplyScalar(0.012);
  glass.push(quad(V(-W / 2 + 0.14, 1.24, 0.8).add(n), V(W / 2 - 0.14, 1.24, 0.8).add(n), V(W / 2 - 0.16, 1.72, 0.41).add(n), V(-W / 2 + 0.16, 1.72, 0.41).add(n)));
  glass.push(quad(V(0.7, 1.28, -0.656), V(-0.7, 1.28, -0.656), V(-0.7, 1.64, -0.656), V(0.7, 1.64, -0.656)));
  addPart(g, 'glass', glass, truckGlass());
  // grille, lights, bumpers, mirrors
  addPart(g, 'grille', [xf(box(1.5, 0.4, 0.04), 0, 0.83, 2.66), ...[-1, 1].map((s) => xf(cyl(0.09, 0.09, 0.05, 10), s * 0.7, 0.84, 2.66, 0, Math.PI / 2))], M.darkMetal());
  const bumpers = [xf(box(W + 0.08, 0.17, 0.13), 0, 0.56, 2.72), xf(box(W + 0.04, 0.15, 0.12), 0, 0.56, -2.86)];
  for (const s of [-1, 1]) bumpers.push(xf(box(0.04, 0.04, 0.22), s * (W / 2 + 0.08), 1.38, 0.7), xf(box(0.03, 0.18, 0.12), s * (W / 2 + 0.2), 1.42, 0.72));
  addPart(g, 'bumpers', bumpers, mChrome);
  addPart(g, 'tail_lights', [-1, 1].map((s) => xf(box(0.12, 0.22, 0.04), s * (W / 2 - 0.08), 0.9, -2.83)), M.paint('#6e2a24', 0.4));
  // wheels (one flat)
  const flat = Math.floor(rng() * 4);
  [[-1, fz], [1, fz], [-1, rz], [1, rz]].forEach(([sx, z], i) => {
    const tire = xf(cyl(wr, wr, 0.24, 16), 0, 0, 0, 0, 0, Math.PI / 2);
    tire.translate(0.12, 0, 0);
    const rim = xf(cyl(0.21, 0.21, 0.26, 10), 0, 0, 0, 0, 0, Math.PI / 2);
    rim.translate(0.13, 0, 0);
    const sy = i === flat ? 0.78 : 1;
    for (const q of [tire, rim]) { q.scale(1, sy, 1); xf(q, sx! * (W / 2 - 0.14), wr * sy - sink, z!); }
    g.add(part('tire_' + i, tire, M.rubber()));
    g.add(part('rim_' + i, rim, mChrome));
  });
  // tall grass: single-triangle blades, straw + new green
  const r = mulberry32(Math.floor(rng() * 1e6));
  const pos: number[] = [], colA: number[] = [];
  const straw = new THREE.Color('#9a8a5e'), green = new THREE.Color('#5d6b33');
  for (let i = 0; i < 520; i++) {
    const a = r() * Math.PI * 2, rr = Math.sqrt(r());
    const x = Math.cos(a) * rr * 1.9, z = Math.sin(a) * rr * 3.6;
    const h = 0.35 + r() * 0.75 * (0.6 + 0.4 * fbm3(x, 0, z, 2, 4)), w = 0.03 + r() * 0.03, ba = r() * Math.PI;
    const lx = (r() - 0.5) * 0.35, lz = (r() - 0.5) * 0.35;
    const c = straw.clone().lerp(green, r() * 0.7), k = 0.75 + r() * 0.4;
    pos.push(x - Math.cos(ba) * w, 0, z - Math.sin(ba) * w, x + Math.cos(ba) * w, 0, z + Math.sin(ba) * w, x + lx, h, z + lz);
    for (let v = 0; v < 3; v++) { const kk = v === 2 ? k * 1.15 : k * 0.55; colA.push(c.r * kk, c.g * kk, c.b * kk); }
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('color', new THREE.Float32BufferAttribute(colA, 3));
  gg.computeVertexNormals();
  const grass = part('grass', gg, grassMat(), false);
  grass.userData.groundCover = true;
  g.add(grass);
  // slight sag / tilt of the body parts
  const tiltX = rand(rng, -0.02, 0.02), tiltZ = rand(rng, -0.03, 0.03);
  for (const c of g.children) {
    if (c.name.startsWith('tire') || c.name.startsWith('rim') || c.name === 'grass') continue;
    c.position.y -= sink;
    c.rotation.x += tiltX;
    c.rotation.z += tiltZ;
  }
  g.userData.breakable = true;
  return { group: g, collider: { type: 'box', hx: 1.05, hz: 2.9 } };
}
