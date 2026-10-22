import * as THREE from 'three';
import { M, std } from './materials';
import { canvas, ctx2d, grime, mkTex, text } from './textures';
import type { PropBuild, RoadSignKind } from './types';
import { addPart, box, boxAtlas, cyl, mulberry32, part, pick, prism, projUV, rand, xf } from './util';
import type { RNG, Rect } from './util';

const RED = '#a8302c', WHITE = '#e1e0da', YELLOW = '#d6b23e', BLACK = '#1d1d1c', GREEN = '#1f5e43';

function bulletHoles(c: CanvasRenderingContext2D, w: number, h: number, seed: number, n: number): void {
  const r = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const x = w * (0.2 + r() * 0.6), y = h * (0.2 + r() * 0.6);
    c.fillStyle = 'rgba(200,200,195,0.9)';
    c.beginPath(); c.arc(x, y, 7, 0, 7); c.fill();
    c.fillStyle = '#2a2826';
    c.beginPath(); c.arc(x, y, 3.5, 0, 7); c.fill();
  }
}
function signMat(key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.MeshStandardMaterial {
  return std('sign:' + key, () => {
    const cv = canvas(w, h), c = ctx2d(cv);
    draw(c);
    const map = mkTex(cv, true);
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    return { map, roughness: 0.38, metalness: 0 };
  });
}
function polyPath(c: CanvasRenderingContext2D, pts: [number, number][]): void {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
}
function octPts(cx: number, cy: number, half: number): [number, number][] {
  const R = half / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, k) => {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    return [cx + Math.cos(a) * R, cy + Math.sin(a) * R] as [number, number];
  });
}
function diaPts(cx: number, cy: number, half: number): [number, number][] {
  return [[cx, cy - half], [cx + half, cy], [cx, cy + half], [cx - half, cy]];
}

/** Flat sign face (shape in metres, centred) with UVs spanning its bounding square/rect. */
function faceGeo(pts: [number, number][], w: number, h: number): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ShapeGeometry(s);
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  return g;
}

function uChannel(height: number): THREE.BufferGeometry {
  const pts: [number, number][] = [[-0.04, 0], [0.04, 0], [0.04, 0.035], [0.03, 0.035], [0.03, 0.008], [-0.03, 0.008], [-0.03, 0.035], [-0.04, 0.035]];
  const g = prism(pts, height);
  g.rotateX(Math.PI / 2);
  g.translate(0, height / 2 - 0.3, -0.04);
  return projUV(g);
}

function blade(label: string, len: number): THREE.MeshStandardMaterial {
  return signMat('blade:' + label, 768, 160, (c) => {
    c.fillStyle = GREEN; c.fillRect(0, 0, 768, 160);
    c.strokeStyle = WHITE; c.lineWidth = 8; c.strokeRect(10, 10, 748, 140);
    text(c, label, 384, 84, 110, WHITE, { maxW: 700 });
    grime(c, 768, 160, label.length * 7, 0.6);
    void len;
  });
}

/** MUTCD-style sign on a galvanized U-channel post. Faces +Z (toward approaching traffic). */
export function buildRoadSign(kind: RoadSignKind, label?: string): PropBuild {
  const g = new THREE.Group();
  g.name = 'sign_' + kind;
  const mBack = M.galv('#9ea2a3');
  let face: THREE.BufferGeometry, back: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial, topY: number;
  const hole = (c: CanvasRenderingContext2D, w: number, h: number, seed: number) => bulletHoles(c, w, h, seed, seed % 3);
  if (kind === 'stop') {
    const s = 0.76;
    const pts = octPts(0, 0, s / 2);
    face = faceGeo(pts, s, s);
    mat = signMat('stop', 512, 512, (c) => {
      polyPath(c, octPts(256, 256, 256)); c.fillStyle = WHITE; c.fill();
      polyPath(c, octPts(256, 256, 236)); c.fillStyle = RED; c.fill();
      text(c, 'STOP', 256, 262, 168, WHITE, { squeeze: 0.86 });
      grime(c, 512, 512, 11, 0.8); hole(c, 512, 512, 4);
    });
    topY = 2.1;
    back = faceGeo(pts, s, s);
  } else if (kind === 'speed55') {
    const w = 0.61, h = 0.76, pts: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    face = faceGeo(pts, w, h);
    mat = signMat('speed55', 384, 480, (c) => {
      c.fillStyle = WHITE; c.fillRect(0, 0, 384, 480);
      c.strokeStyle = BLACK; c.lineWidth = 9; c.strokeRect(12, 12, 360, 456);
      text(c, 'SPEED', 192, 92, 74, BLACK, { squeeze: 0.85 });
      text(c, 'LIMIT', 192, 170, 74, BLACK, { squeeze: 0.85 });
      text(c, '55', 192, 330, 210, BLACK, { squeeze: 0.85 });
      grime(c, 384, 480, 12, 0.8); hole(c, 384, 480, 5);
    });
    topY = 2.2;
    back = faceGeo(pts, w, h);
  } else if (kind === 'crossroad' || kind === 'noOutlet') {
    const s = 0.76, half = s / 2, pts = diaPts(0, 0, half).map(([x, y]) => [x, -y] as [number, number]);
    face = faceGeo(pts, s, s);
    mat = signMat(kind, 512, 512, (c) => {
      polyPath(c, diaPts(256, 256, 256)); c.fillStyle = YELLOW; c.fill();
      polyPath(c, diaPts(256, 256, 236)); c.strokeStyle = BLACK; c.lineWidth = 9; c.stroke();
      if (kind === 'crossroad') { c.fillStyle = BLACK; c.fillRect(232, 100, 48, 312); c.fillRect(100, 232, 312, 48); }
      else { text(c, 'NO', 256, 210, 92, BLACK, { squeeze: 0.85 }); text(c, 'OUTLET', 256, 300, 92, BLACK, { squeeze: 0.8 }); }
      grime(c, 512, 512, 13, 0.8); hole(c, 512, 512, 6);
    });
    topY = 2.35;
    back = faceGeo(pts, s, s);
  } else {
    // county road: green street-name blades crossed on top of the post
    const lab = label ?? 'RD 14';
    const len = Math.min(1.2, 0.35 + lab.length * 0.085);
    const bm = blade(lab, len);
    const r: Rect = [0, 0, 1, 1], e: Rect = [0.004, 0.5, 0.006, 0.52];
    g.add(part('blade_a', xf(boxAtlas(len, 0.2, 0.012, [e, e, e, e, r, r]), 0, 2.65, 0.02), bm));
    g.add(part('blade_b', xf(boxAtlas(len, 0.2, 0.012, [e, e, e, e, r, r]), 0, 2.88, 0.02, Math.PI / 2), bm));
    addPart(g, 'post', [uChannel(3.3), xf(box(0.06, 0.06, 0.06), 0, 2.97, -0.02)], M.galv('#a5a9aa'));
    g.userData.breakable = true;
    return { group: g, collider: { type: 'circle', r: 0.1 } };
  }
  // face on front, galvanized back
  face.computeBoundingBox();
  const fh = face.boundingBox!.max.y - face.boundingBox!.min.y;
  const cy = topY - fh / 2;
  g.add(part('sign_face', xf(face, 0, cy, 0.006), mat));
  back.rotateY(Math.PI);
  g.add(part('sign_back', xf(projUV(back), 0, cy, 0.002), mBack));
  addPart(g, 'post', [uChannel(topY + 0.15)], M.galv('#a5a9aa'));
  if (kind === 'stop' && label) {
    const len = Math.min(1.2, 0.35 + label.length * 0.085), bm = blade(label, len);
    const r: Rect = [0, 0, 1, 1], e: Rect = [0.004, 0.5, 0.006, 0.52];
    addPart(g, 'post_ext', [xf(box(0.06, 0.5, 0.03), 0, topY + 0.3, -0.03)], M.galv('#a5a9aa'));
    g.add(part('blade_a', xf(boxAtlas(len, 0.2, 0.012, [e, e, e, e, r, r]), 0, topY + 0.35, -0.03), bm));
    g.add(part('blade_b', xf(boxAtlas(len, 0.2, 0.012, [e, e, e, e, r, r]), 0, topY + 0.56, -0.03, Math.PI / 2), bm));
  }
  g.userData.breakable = true;
  return { group: g, collider: { type: 'circle', r: 0.1 } };
}

/** Rural tunnel mailbox on a wood post or steel pipe; door faces +Z (road). */
export function buildMailbox(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'mailbox';
  const boxH = rand(rng, 1.0, 1.15);
  const color = pick(rng, ['#2a2a29', '#2a2a29', '#8e9192', '#c9c8c2', '#3d4a3b', '#6b5a48']);
  const mBox = color === '#8e9192' ? M.galv(color) : M.paint(color, 0.55);
  // tunnel profile: flat bottom, vertical sides, half-round top
  const w = 0.17, sideH = 0.12, prof: [number, number][] = [[-w / 2, 0], [w / 2, 0], [w / 2, sideH]];
  for (let i = 1; i < 10; i++) { const a = (i / 10) * Math.PI; prof.push([Math.cos(a) * (w / 2), sideH + Math.sin(a) * (w / 2)]); }
  prof.push([-w / 2, sideH]);
  const body = prism(prof, 0.48);
  xf(body, 0, boxH, 0.04);
  addPart(g, 'box', [projUV(body), xf(box(w + 0.01, 0.22, 0.012), 0, boxH + 0.11, 0.285)], mBox);
  addPart(g, 'flag', [xf(box(0.008, 0.2, 0.025), w / 2 + 0.01, boxH + 0.14, -0.05), xf(box(0.008, 0.06, 0.09), w / 2 + 0.01, boxH + 0.22, -0.02)], M.paint('#9c3329', 0.5));
  if (rng() < 0.7) {
    const post = [xf(box(0.09, boxH + 0.3, 0.09), 0, (boxH + 0.3) / 2 - 0.3, -0.1), xf(box(0.09, 0.07, 0.5), 0, boxH - 0.035, 0.04)];
    addPart(g, 'post', post.map((q) => projUV(q)), M.wood(pick(rng, ['#8b8579', '#77705f', '#9a917f'])));
  } else {
    addPart(g, 'post', [xf(cyl(0.035, 0.035, boxH + 0.3, 8), 0, -0.3, -0.05), xf(box(0.06, 0.04, 0.44), 0, boxH - 0.02, 0.04)], M.galv('#6e6a62'));
  }
  g.userData.breakable = true;
  return { group: g, collider: { type: 'circle', r: 0.15 } };
}
