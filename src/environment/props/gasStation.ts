import * as THREE from 'three';
import { M, std } from './materials';
import { DOOR, canvas, ctx2d, grime, memo, mkTex, rectPx, text } from './textures';
import type { PropBuild } from './types';
import { addPart, box, boxAtlas, cyl, merge, part, projUV, xf } from './util';
import type { Rect } from './util';

const NAME = 'PRAIRIE STOP';
const STRIPE = '#3e6152';

function canvasMat(key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D, emissive: boolean) => void, p: THREE.MeshStandardMaterialParameters = {}, withEmissive = false): THREE.MeshStandardMaterial {
  return std(key, () => {
    const c = canvas(w, h);
    draw(ctx2d(c), false);
    const map = mkTex(c, true);
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    let emissiveMap: THREE.Texture | null = null;
    if (withEmissive) {
      const e = canvas(w, h), ex = ctx2d(e);
      ex.fillStyle = '#000';
      ex.fillRect(0, 0, w, h);
      draw(ex, true);
      emissiveMap = mkTex(e, true);
      emissiveMap.wrapS = emissiveMap.wrapT = THREE.ClampToEdgeWrapping;
    }
    return { map, roughness: 0.55, metalness: 0, ...(emissiveMap ? { emissiveMap, emissive: '#ffffff', emissiveIntensity: 1.4 } : {}), ...p };
  });
}
const FULL: Rect = [0, 0, 1, 1];
const EDGE: Rect = [0.002, 0.5, 0.004, 0.52];

function fasciaMat(named: boolean): THREE.MeshStandardMaterial {
  return canvasMat('gs:fascia:' + named, 2048, 128, (c) => {
    c.fillStyle = '#dcdbd5';
    c.fillRect(0, 0, 2048, 128);
    c.fillStyle = STRIPE;
    c.fillRect(0, 86, 2048, 22);
    c.fillStyle = '#b9b8b2';
    c.fillRect(0, 0, 2048, 5);
    c.fillRect(0, 122, 2048, 6);
    if (named) text(c, NAME, 1024, 46, 64, STRIPE, { squeeze: 0.95 });
    grime(c, 2048, 128, 3, 2);
  });
}
function priceSignMat(): THREE.MeshStandardMaterial {
  return canvasMat('gs:price', 512, 768, (c, E) => {
    if (!E) {
      c.fillStyle = '#d8d7d0'; c.fillRect(0, 0, 512, 768);
      c.fillStyle = STRIPE; c.fillRect(14, 14, 484, 150);
      text(c, 'PRAIRIE', 256, 62, 66, '#e8e6de', { squeeze: 0.9 });
      text(c, 'STOP', 256, 126, 66, '#e8e6de', { squeeze: 0.9 });
      c.fillStyle = '#dcdbd4'; c.fillRect(14, 172, 484, 110);
      text(c, 'GAS', 256, 228, 92, '#2d2d2b');
      c.fillStyle = '#1b1b1a'; c.fillRect(14, 292, 484, 382);
    }
    const rows = [['UNLEADED', '3.29'], ['SUPER', '3.69'], ['DIESEL', '3.79']];
    rows.forEach(([lab, p], i) => {
      const y = 350 + i * 120;
      if (!E) text(c, lab!, 120, y, 34, '#dedcd4', { maxW: 190 });
      text(c, p!, 380, y, 84, E ? '#ff5a3c' : '#c8402c', { family: '"Courier New", monospace' });
      text(c, '9', 478, y - 22, 30, E ? '#ff5a3c' : '#c8402c', { family: '"Courier New", monospace' });
    });
    if (!E) {
      c.fillStyle = STRIPE; c.fillRect(14, 684, 484, 70);
      text(c, 'FOOD  ·  ICE  ·  BAIT', 256, 719, 34, '#e8e6de');
      grime(c, 512, 768, 9, 1.2);
    }
  }, {}, true);
}
function pumpMat(): THREE.MeshStandardMaterial {
  return canvasMat('gs:pump', 256, 512, (c) => {
    c.fillStyle = '#d3d2cc'; c.fillRect(0, 0, 256, 512);
    c.fillStyle = STRIPE; c.fillRect(0, 0, 256, 60);
    text(c, NAME, 128, 30, 30, '#e8e6de', { maxW: 220 });
    c.fillStyle = '#2b2c2b'; c.fillRect(30, 80, 196, 90);
    text(c, '24.517', 128, 108, 30, '#9fb79a', { family: '"Courier New", monospace' });
    text(c, '$ 80.67', 128, 148, 28, '#9fb79a', { family: '"Courier New", monospace' });
    c.fillStyle = '#3a3a38'; c.fillRect(40, 190, 70, 50);
    c.fillStyle = '#5b5b58'; c.fillRect(140, 190, 76, 50);
    ['87', '89', '93'].forEach((s, i) => { c.fillStyle = '#e9e7df'; c.fillRect(30 + i * 68, 262, 60, 36); text(c, s, 60 + i * 68, 280, 22, '#2b2b2a'); });
    c.fillStyle = '#b3b2ab'; c.fillRect(0, 320, 256, 4);
    c.fillStyle = '#c4c3bc'; c.fillRect(16, 336, 224, 160);
    c.fillStyle = STRIPE; c.fillRect(16, 460, 224, 14);
    text(c, 'UNLEADED', 128, 380, 30, '#3a3a38');
    grime(c, 256, 512, 5, 0.8);
  });
}
function iceMat(): THREE.MeshStandardMaterial {
  return canvasMat('gs:ice', 256, 160, (c) => {
    c.fillStyle = '#dcdcd8'; c.fillRect(0, 0, 256, 160);
    c.fillStyle = '#3d5f86'; c.fillRect(0, 108, 256, 30);
    text(c, 'ICE', 128, 60, 82, '#3d5f86');
    text(c, 'PACKAGED ICE', 128, 123, 18, '#e2e2de');
    grime(c, 256, 160, 4, 0.6);
  });
}
function cageMat(): THREE.MeshStandardMaterial {
  return canvasMat('gs:cage', 256, 256, (c) => {
    c.fillStyle = '#1d1d1c'; c.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
      const x = 16 + i * 60, y = 40 + row * 108;
      c.fillStyle = '#9da0a1'; c.fillRect(x, y + 14, 44, 78);
      c.fillStyle = '#b8bbbb'; c.fillRect(x + 6, y + 14, 10, 78);
      c.fillStyle = '#6d6f70'; c.fillRect(x + 14, y, 16, 16);
    }
    c.fillStyle = '#d0cfca';
    for (let x = 0; x < 256; x += 12) c.fillRect(x, 0, 3, 256);
    c.fillRect(0, 0, 256, 10); c.fillRect(0, 124, 256, 8); c.fillRect(0, 246, 256, 10);
    c.fillStyle = '#7a2f27'; c.fillRect(60, 14, 136, 30);
    text(c, 'PROPANE', 128, 29, 22, '#e6e2d8');
  });
}
function storeSignMat(): THREE.MeshStandardMaterial {
  return canvasMat('gs:storesign', 1024, 128, (c) => {
    c.fillStyle = STRIPE; c.fillRect(0, 0, 1024, 128);
    text(c, NAME, 420, 64, 76, '#e6e4dc', { squeeze: 0.95 });
    text(c, 'FOOD · FUEL · ICE', 845, 64, 30, '#d9d6c9');
    grime(c, 1024, 128, 6, 1);
  });
}
function storefrontMat(): THREE.MeshStandardMaterial {
  return canvasMat('gs:storefront', 1024, 256, (c, E) => {
    if (!E) {
      const g = c.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#5e6266'); g.addColorStop(0.4, '#3d4043'); g.addColorStop(1, '#2a2b2c');
      c.fillStyle = g; c.fillRect(0, 0, 1024, 256);
      for (let i = 0; i < 6; i++) { c.fillStyle = 'rgba(70,64,56,0.9)'; c.fillRect(40 + i * 170, 120, 120, 136); c.fillStyle = 'rgba(120,96,70,0.6)'; for (let s = 0; s < 4; s++) c.fillRect(44 + i * 170, 128 + s * 30, 112, 8); }
      const posters = [['#b7a35a', 'COLD'], ['#7a2f27', 'LOTTO'], ['#3d5f86', 'COFFEE'], ['#5c6b3a', 'BAIT']];
      posters.forEach(([col, s], i) => { const x = 60 + i * 250; c.fillStyle = col!; c.fillRect(x, 150, 74, 96); text(c, s!, x + 37, 190, 18, '#ece8dc', { maxW: 66 }); });
    }
    c.fillStyle = E ? '#9a968a' : '#cfcabb';
    for (let i = 0; i < 8; i++) c.fillRect(30 + i * 128, 10, 80, 10);
    c.fillStyle = E ? '#ff3a28' : '#d2523f';
    c.font = 'bold 34px Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText('OPEN', 900, 90);
    if (!E) {
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.beginPath(); c.moveTo(100, 0); c.lineTo(420, 0); c.lineTo(160, 256); c.lineTo(-100, 256); c.fill();
    }
  }, { roughness: 0.08, emissiveIntensity: 0.9 }, true);
}

function faceBox(w: number, h: number, d: number, front: Rect, back: Rect | null, edge: Rect = EDGE): THREE.BufferGeometry {
  return boxAtlas(w, h, d, [edge, edge, edge, edge, front, back ?? edge]);
}

function apronMat(): THREE.MeshStandardMaterial {
  return memo('m:gs:apron', () => {
    const W = 1024, H = 1024, c = canvas(W, H), x = ctx2d(c);
    x.fillStyle = '#9e9c95'; x.fillRect(0, 0, W, H);
    const r = (s: number) => { let a = s; return () => ((a = (a * 16807) % 2147483647) / 2147483647); };
    const rnd = r(77);
    for (let i = 0; i < 1600; i++) { x.fillStyle = `rgba(${rnd() < 0.5 ? '60,58,54' : '190,188,180'},${0.03 + rnd() * 0.05})`; const s = 10 + rnd() * 70; x.beginPath(); x.arc(rnd() * W, rnd() * H, s, 0, 7); x.fill(); }
    // map world (x,z) -> canvas
    const px = (wx: number) => ((wx + 22.5) / 45) * W, pz = (wz: number) => (1 - (wz + 17.5) / 35) * H;
    const stain = (wx: number, wz: number, rad: number, a: number) => {
      for (let i = 0; i < 6; i++) {
        const g = x.createRadialGradient(px(wx + (rnd() - 0.5) * rad), pz(wz + (rnd() - 0.5) * rad), 0, px(wx), pz(wz), (rad / 45) * W * (0.5 + rnd()));
        g.addColorStop(0, `rgba(30,28,25,${a})`); g.addColorStop(1, 'rgba(30,28,25,0)');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
      }
    };
    for (const ix of [-0.5, 8.5]) for (const sx of [-1, 1]) { stain(ix + sx * 2.2, 6.5, 2.2, 0.18); x.fillStyle = 'rgba(35,33,30,0.08)'; x.fillRect(px(ix + sx * 2.2) - 30, pz(17.5), 60, pz(-4) - pz(17.5)); }
    for (let i = 0; i < 6; i++) stain(-12.5 + i * 2.8, -2.5, 1.2, 0.14);
    x.strokeStyle = 'rgba(225,222,205,0.55)'; x.lineWidth = 3;
    for (let i = 0; i <= 6; i++) { x.beginPath(); x.moveTo(px(-14 + i * 2.8), pz(-4.6)); x.lineTo(px(-14 + i * 2.8), pz(-0.2)); x.stroke(); }
    x.strokeStyle = 'rgba(50,48,44,0.7)'; x.lineWidth = 2;
    for (let gx = -22.5; gx <= 22.5; gx += 4.5) { x.beginPath(); x.moveTo(px(gx), 0); x.lineTo(px(gx), H); x.stroke(); }
    for (let gz = -17.5; gz <= 17.5; gz += 5) { x.beginPath(); x.moveTo(0, pz(gz)); x.lineTo(W, pz(gz)); x.stroke(); }
    x.strokeStyle = 'rgba(40,38,34,0.6)'; x.lineWidth = 1.2;
    for (let i = 0; i < 14; i++) { let cx = rnd() * W, cy = rnd() * H; x.beginPath(); x.moveTo(cx, cy); for (let k = 0; k < 8; k++) { cx += (rnd() - 0.5) * 40; cy += (rnd() - 0.5) * 40; x.lineTo(cx, cy); } x.stroke(); }
    const map = mkTex(c, true, 45, 35);
    map.offset.set(0.5, 0.5);
    const conc = M.concrete();
    return new THREE.MeshStandardMaterial({ name: 'prop:gs:apron', map, normalMap: conc.normalMap, roughness: 0.9, metalness: 0 });
  });
}

/** Rural convenience store + fuel canopy. Front (pumps, road) faces +Z. Apron 45 x 35 m. */
export function buildGasStation(): PropBuild {
  const g = new THREE.Group();
  g.name = 'gas_station';
  const mWhite = M.paint('#d9d8d2', 0.6), mSteel = M.galv('#a3a6a6'), mYellow = M.paint('#b59a3a', 0.6), mCurb = M.concrete('#c4c1b8');
  const mBronze = M.paint('#3f3a33', 0.4);

  // apron (metric UV top so the unique map uses repeat 1/45,1/35 and offset .5)
  const apron = box(45, 0.32, 35);
  xf(apron, 0, -0.14, 0);
  const auv = apron.getAttribute('uv'), ap = apron.getAttribute('position');
  for (let i = 0; i < auv.count; i++) auv.setXY(i, ap.getX(i), ap.getZ(i));
  g.add(part('apron', apron, apronMat(), false));

  // islands, pumps, bollards
  const islands: THREE.BufferGeometry[] = [], pumps: THREE.Mesh[] = [], bollards: THREE.BufferGeometry[] = [], hoses: THREE.BufferGeometry[] = [];
  const pm = pumpMat();
  let pi = 0;
  for (const ix of [-0.5, 8.5]) {
    islands.push(xf(box(1.3, 0.2, 7.2), ix, 0.1, 6.5));
    for (const pz of [4.7, 8.3]) {
      const body = [xf(boxAtlas(0.55, 1.95, 1.05, [FULL, FULL, EDGE, EDGE, EDGE, EDGE]), ix, 0.2 + 0.975, pz), xf(boxAtlas(0.6, 0.12, 1.12, [EDGE, EDGE, EDGE, EDGE, EDGE, EDGE]), ix, 2.2, pz)];
      pumps.push(part('pump_' + ++pi, merge(body), pm));
      for (const sx of [-1, 1]) {
        hoses.push(xf(box(0.04, 1.2, 0.04), ix + sx * 0.33, 1.15, pz + 0.3, 0, 0, sx * 0.12));
        hoses.push(xf(box(0.08, 0.22, 0.12), ix + sx * 0.3, 1.35, pz - 0.3));
      }
    }
    for (const bz of [2.6, 10.4]) bollards.push(xf(cyl(0.1, 0.1, 1.0, 8), ix, 0.2, bz));
  }
  addPart(g, 'islands', islands.map((q) => projUV(q)), mCurb);
  g.add(...pumps);
  addPart(g, 'pump_hoses', hoses, M.rubber());
  addPart(g, 'bollards', bollards, mYellow);

  // canopy 20 x 10, 5 m clearance
  const cx = 4, cz = 6.5, cw = 20, cd = 10, cy = 5.0, fh = 0.9;
  const cols = [-0.5, 8.5].flatMap((ix) => [3.4, 9.6].map((z) => xf(box(0.42, cy, 0.42), ix, cy / 2 + 0.2, z)));
  addPart(g, 'canopy_columns', cols.map((q) => projUV(q)), mWhite);
  addPart(g, 'canopy_deck', [xf(box(cw - 0.1, 0.5, cd - 0.1), cx, cy + 0.3, cz)], M.paint('#c9c8c2', 0.7));
  const fn = fasciaMat(true), fp = fasciaMat(false);
  g.add(part('canopy_fascia_front', xf(faceBox(cw, fh, 0.1, FULL, null), cx, cy + fh / 2, cz + cd / 2), fn));
  g.add(part('canopy_fascia_back', xf(faceBox(cw, fh, 0.1, FULL, null), cx, cy + fh / 2, cz - cd / 2, Math.PI), fn));
  addPart(g, 'canopy_fascia_sides', [xf(faceBox(cd, fh, 0.1, FULL, null), cx + cw / 2, cy + fh / 2, cz, Math.PI / 2), xf(faceBox(cd, fh, 0.1, FULL, null), cx - cw / 2, cy + fh / 2, cz, -Math.PI / 2)], fp);
  const lights: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
    const p = new THREE.PlaneGeometry(0.7, 0.7);
    p.rotateX(Math.PI / 2);
    lights.push(xf(p, cx - 8 + i * 3.2, cy + 0.04, cz - 3 + j * 3));
  }
  addPart(g, 'canopy_lights', lights, M.emissive('#fff6e6', 2.2), false);

  // store 16 x 12 at back-left; front at z = -4.5
  const sx0 = -14, sx1 = 2, sz0 = -16.5, sz1 = -4.5, sh = 4.3, par = 4.9;
  const mCmu = M.cmu();
  const wall = (w: number, h: number, d: number, x: number, y: number, z: number) => projUV(xf(box(w, h, d), x, y, z));
  addPart(g, 'store_wall_back', [wall(16, par, 0.25, -6, par / 2, sz0 + 0.125)], mCmu);
  addPart(g, 'store_wall_left', [wall(0.25, par, 11.5, sx0 + 0.125, par / 2, -10.5)], mCmu);
  addPart(g, 'store_wall_right', [wall(0.25, par, 11.5, sx1 - 0.125, par / 2, -10.5)], mCmu);
  const gl0 = -11.5, gl1 = -1.0, gTop = 3.0;
  addPart(g, 'store_wall_front', [
    wall(gl0 - sx0, par, 0.25, (sx0 + gl0) / 2, par / 2, sz1 - 0.125),
    wall(sx1 - gl1, par, 0.25, (gl1 + sx1) / 2, par / 2, sz1 - 0.125),
    wall(gl1 - gl0, 0.5, 0.25, (gl0 + gl1) / 2, 0.25, sz1 - 0.125),
    wall(gl1 - gl0, par - gTop, 0.25, (gl0 + gl1) / 2, gTop + (par - gTop) / 2, sz1 - 0.125),
  ], mCmu);
  const doorX = -6.2;
  const glassL = xf(faceBox(gl1 - gl0, gTop - 0.5, 0.04, FULL, null), (gl0 + gl1) / 2, 0.5 + (gTop - 0.5) / 2, sz1 - 0.2);
  g.add(part('store_glass', glassL, storefrontMat()));
  const mull: THREE.BufferGeometry[] = [];
  for (let i = 0; i <= 6; i++) { const x = gl0 + ((gl1 - gl0) * i) / 6; mull.push(xf(box(0.08, gTop - 0.5, 0.12), x, 0.5 + (gTop - 0.5) / 2, sz1 - 0.16)); }
  for (const y of [0.52, gTop - 0.02]) mull.push(xf(box(gl1 - gl0, 0.08, 0.12), (gl0 + gl1) / 2, y, sz1 - 0.16));
  addPart(g, 'store_mullions', mull, mBronze);
  addPart(g, 'store_door', [xf(boxAtlas(1.8, 2.3, 0.06, [DOOR.side(6), DOOR.side(6), DOOR.side(6), DOOR.side(6), DOOR.cell(6), DOOR.side(6)]), doorX, 0.5 + 1.15, sz1 - 0.08)], M.doors());
  addPart(g, 'store_back_door', [xf(boxAtlas(1.0, 2.15, 0.05, [DOOR.side(7), DOOR.side(7), DOOR.side(7), DOOR.side(7), DOOR.cell(7), DOOR.side(7)]), -3, 1.08, sz0 - 0.03, Math.PI)], M.doors());
  addPart(g, 'store_roof', [xf(box(15.5, 0.2, 11.5), -6, sh, -10.5)], M.paint('#6f6e69', 0.9));
  addPart(g, 'store_parapet_cap', [
    xf(box(16.1, 0.08, 0.35), -6, par + 0.04, sz1 - 0.125), xf(box(16.1, 0.08, 0.35), -6, par + 0.04, sz0 + 0.125),
    xf(box(0.35, 0.08, 12), sx0 + 0.125, par + 0.04, -10.5), xf(box(0.35, 0.08, 12), sx1 - 0.125, par + 0.04, -10.5),
  ], M.paint('#8b8a84', 0.5));
  g.add(part('store_sign', xf(faceBox(8, 1.0, 0.12, FULL, null), (gl0 + gl1) / 2, 3.85, sz1 + 0.06), storeSignMat()));
  addPart(g, 'store_awning', [xf(box(gl1 - gl0 + 0.6, 0.14, 1.4), (gl0 + gl1) / 2, 3.15, sz1 + 0.7)], M.paint(STRIPE, 0.6));
  addPart(g, 'rooftop_units', [
    xf(box(2.1, 1.1, 1.3), -9, sh + 0.65, -12), xf(box(1.8, 1.0, 1.2), -3.5, sh + 0.6, -9),
    xf(cyl(0.35, 0.35, 0.5, 10), -6, sh + 0.1, -14), xf(cyl(0.08, 0.08, 1.0, 6), -1.5, sh, -13),
  ].map((q) => projUV(q)), mSteel);
  addPart(g, 'downspouts', [xf(box(0.1, par, 0.1), sx0 - 0.05, par / 2, sz0 + 0.3), xf(box(0.1, par, 0.1), sx1 + 0.05, par / 2, sz0 + 0.3)], mWhite);

  // extras: ice chest, propane cage, trash cans, dumpster
  const ice = xf(faceBox(1.8, 1.25, 0.8, FULL, null), -2.3, 0.65, sz1 + 0.45);
  g.add(part('ice_chest', ice, iceMat()));
  const cage = [xf(boxAtlas(1.6, 1.7, 0.85, [FULL, FULL, EDGE, EDGE, FULL, FULL]), 0, 0.88, 0)];
  g.add(part('propane_cage', xf(cage[0]!, sx1 + 0.55, 0, -8, Math.PI / 2), cageMat()));
  const cans: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-0.5, 2.0], [8.5, 11.0], [-8.8, -4.0]] as const) { cans.push(xf(cyl(0.3, 0.28, 0.95, 10), x, x === -8.8 ? 0.02 : 0.2, z)); cans.push(xf(cyl(0.33, 0.33, 0.08, 10), x, (x === -8.8 ? 0.02 : 0.2) + 0.95, z)); }
  addPart(g, 'trash_cans', cans, M.paint('#4a5545', 0.7));
  addPart(g, 'dumpster', [projUV(xf(box(1.9, 1.3, 1.5), 5.2, 0.7, -14)), xf(box(2.0, 0.08, 1.6), 5.2, 1.38, -14.05, 0, 0.1)], M.rib('plain', '#3f4d3f'));

  // price sign near road corner (faces +/-X toward traffic)
  addPart(g, 'price_sign_pole', [xf(cyl(0.18, 0.2, 6.2, 12), 19.5, 0.02, 15)], mSteel);
  g.add(part('price_sign', xf(boxAtlas(0.45, 3.6, 2.4, [FULL, FULL, EDGE, EDGE, EDGE, EDGE]), 19.5, 6.2 + 1.8, 15), priceSignMat()));
  // light poles
  const lp: THREE.BufferGeometry[] = [], heads: THREE.BufferGeometry[] = [];
  for (const [x, z, dir] of [[-21, 15.5, 1], [21, -16, -1]] as const) {
    lp.push(xf(cyl(0.45, 0.5, 0.6, 8), x, -0.1, z));
    lp.push(xf(box(0.16, 9, 0.16), x, 0.5 + 4.5, z));
    lp.push(xf(box(1.2, 0.1, 0.1), x + dir * 0.6, 9.3, z));
    lp.push(xf(box(0.75, 0.2, 0.45), x + dir * 1.3, 9.25, z));
    const lens = new THREE.PlaneGeometry(0.62, 0.36);
    lens.rotateX(Math.PI / 2);
    heads.push(xf(lens, x + dir * 1.3, 9.14, z));
  }
  addPart(g, 'light_poles', lp.map((q) => projUV(q)), mSteel);
  addPart(g, 'light_lenses', heads, M.emissive('#fff3dc', 2.0), false);

  g.userData.breakable = true;
  g.userData.colliders = [
    { type: 'box', x: -6, z: -10.5, hx: 8.1, hz: 6.1 },
    ...[-0.5, 8.5].map((ix) => ({ type: 'box', x: ix, z: 6.5, hx: 0.7, hz: 3.9 })),
    { type: 'circle', x: 19.5, z: 15, r: 0.3 },
    { type: 'circle', x: -21, z: 15.5, r: 0.4 },
    { type: 'circle', x: 21, z: -16, r: 0.4 },
  ];
  return { group: g, collider: { type: 'box', hx: 22.5, hz: 17.5 } };
}

void rectPx;
