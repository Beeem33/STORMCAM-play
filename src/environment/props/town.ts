import * as THREE from 'three';
import { mount, windowGeos } from './farmhouse';
import type { Block } from './farmhouse';
import { M, std } from './materials';
import { DOOR, WIN, canvas, ctx2d, grime, mkTex, slipformTex, text } from './textures';
import type { PropBuild } from './types';
import { AX, AZ, V, addPart, box, boxAtlas, cyl, finish, mulberry32, part, pick, prism, projUV, rand, randInt, rod, slab, strut, xf } from './util';
import type { RNG, Rect } from './util';

const FULL: Rect = [0, 0, 1, 1];
const EDGE: Rect = [0.002, 0.5, 0.004, 0.52];

function canvasMat(key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, p: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return std(key, () => {
    const c = canvas(w, h);
    draw(ctx2d(c));
    const map = mkTex(c, true);
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    return { map, roughness: 0.7, metalness: 0, ...p };
  });
}
/** Faded painted lettering with eroded edges; transparent canvas used as an alpha-tested decal. */
function paintedText(key: string, w: number, h: number, s: string, color: string, px: number): THREE.MeshStandardMaterial {
  return std('decal:' + key, () => {
    const c = canvas(w, h), x = ctx2d(c);
    text(x, s, w / 2, h / 2, px, color, { maxW: w * 0.96, family: '"Arial Black", "Helvetica Neue", Arial, sans-serif', weight: '900' });
    const r = mulberry32(s.length * 31 + w);
    x.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < (w * h) / 220; i++) { x.fillStyle = `rgba(0,0,0,${0.3 + r() * 0.7})`; const sz = 1 + r() * 5; x.fillRect(r() * w, r() * h, sz, sz * (1 + r() * 3)); }
    x.globalCompositeOperation = 'source-over';
    const map = mkTex(c, true);
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    return { map, alphaTest: 0.45, roughness: 0.85, metalness: 0 };
  });
}

// ============================================================ GRAIN ELEVATOR

const TOWNS = ['CEDAR FLATS CO-OP', 'PRAIRIE VIEW CO-OP', 'WILLOW CREEK GRAIN', 'HADLEY FARMERS CO-OP', 'BLUESTEM GRAIN CO.'];

/** Small-town slipform concrete elevator: row of silos along X, head house, gallery, metal annex, painted name (front +Z). */
export function buildGrainElevator(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'grain_elevator';
  const n = randInt(rng, 3, 6), D = rand(rng, 7, 8.2), r = D / 2, H = rand(rng, 30, 35);
  const name = pick(rng, TOWNS);
  const sm = std('slipform', () => { const t = slipformTex(); return { map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0 }; });
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * D);
  const circ = Math.round((Math.PI * D) / 4) * 4;
  xs.forEach((x, i) => {
    const s = new THREE.CylinderGeometry(r, r, H, 36, 1, false);
    s.translate(x, H / 2, 0);
    const uv = s.getAttribute('uv'), nn = s.getAttribute('normal'), p = s.getAttribute('position');
    for (let k = 0; k < uv.count; k++) {
      if (Math.abs(nn.getY(k)) > 0.99) uv.setXY(k, p.getX(k), p.getZ(k));
      else uv.setXY(k, uv.getX(k) * circ + i * 1.3, uv.getY(k) * H);
    }
    g.add(part('silo_' + i, s, sm));
  });
  addPart(g, 'footing', [xf(box(n * D + 1.2, 0.5, D + 1.2), 0, 0.0, 0)], M.concrete());
  const xL = xs[0]! - r, xR = xs[n - 1]! + r;
  addPart(g, 'gallery', [projUV(xf(box(xR - xL - 1.0, 3.2, 4.2), 0, H + 1.6, 0))], sm);
  const hi = rng() < 0.5 ? 0 : n - 1, hx = xs[hi]!, hh = rand(rng, 10, 13);
  addPart(g, 'head_house', [projUV(xf(box(D * 0.92, hh, D * 1.02), hx, H + hh / 2, 0)), projUV(xf(box(3.2, 3.0, 3.2), hx, H + hh + 1.5, 0))], sm);
  const hb: Block = { cx: hx, cz: 0, hw: (D * 0.92) / 2, hd: (D * 1.02) / 2 };
  const hw: THREE.BufferGeometry[] = [];
  for (const yy of [H + 3.5, H + 7.5]) for (const s of [-1.5, 1.5]) hw.push(...mount(windowGeos(WIN.shed, WIN.casingGrey, 1.1, 0.9, false), hb, 'front', s, yy));
  addPart(g, 'head_windows', hw, M.windows());
  // name decal across the silo fronts (planar projected)
  const bandH = Math.min(4.2, D * 0.5), y0 = H * 0.7;
  const decal: THREE.BufferGeometry[] = [];
  const tW = xR - xL;
  xs.forEach((x) => {
    const d = new THREE.CylinderGeometry(r + 0.04, r + 0.04, bandH, 18, 1, true, -1.25, 2.5);
    d.translate(x, y0 + bandH / 2, 0);
    const uv = d.getAttribute('uv'), p = d.getAttribute('position');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (p.getX(k) - xL) / tW, (p.getY(k) - y0) / bandH);
    decal.push(d);
  });
  addPart(g, 'name_paint', decal, paintedText('elev:' + name, 2048, Math.round((2048 * bandH) / tW), name, '#e4e1d6', Math.round((2048 * bandH) / tW) * 0.82), false);
  // metal annex at the far end + spouts + driveway shed
  const side = hi === 0 ? 1 : -1, aw = rand(rng, 8, 12), ah = H * rand(rng, 0.45, 0.6), ax = (side > 0 ? xR : xL) + side * (aw / 2 - 0.2);
  const mRib = M.rib('plain', '#b4b8b8');
  const ag = [[-D / 2, 0], [D / 2, 0], [D / 2, ah], [0, ah + D * 0.15], [-D / 2, ah]] as const;
  addPart(g, 'annex_walls', [
    projUV(xf(box(aw, ah, 0.12), ax, ah / 2, D / 2 - 0.06)), projUV(xf(box(aw, ah, 0.12), ax, ah / 2, -D / 2 + 0.06)),
    projUV(xf(prism(ag, 0.12), ax + side * (aw / 2 - 0.06), 0, 0, Math.PI / 2)),
  ], mRib);
  addPart(g, 'annex_roof', [slab(V(ax, ah + D * 0.15, 0), V(ax, ah, D / 2), AX, aw + 0.3, 0.08, 0.02, 0.3), slab(V(ax, ah + D * 0.15, 0), V(ax, ah, -D / 2), AX, aw + 0.3, 0.08, 0.02, 0.3)], M.rib('plain', '#a2a6a7'));
  const mG = M.galv('#8f9394');
  addPart(g, 'spouts', [
    rod(V(hx, H + 5, D / 2 + 0.2), V(hx + side * 7, 5.5, D / 2 + 3.2), 0.16, 8), rod(V(hx, H + 6, D / 2 + 0.2), V(hx - side * 5, 6.0, D / 2 + 2.6), 0.14, 8),
    rod(V(hx, H + hh - 0.5, 0), V(ax, ah + 1.0, 0), 0.18, 8),
  ], mG);
  const sx = hx + side * 3, sz = D / 2 + 3.4;
  addPart(g, 'driveway_shed', [
    ...[-1, 1].flatMap((a) => [-1, 1].map((b) => xf(box(0.2, 5, 0.2), sx + a * 2.6, 2.5, sz + b * 2.8))),
    slab(V(sx, 5.9, sz), V(sx - 2.9, 5.0, sz), AZ, 6.2, 0.08, 0.02, 0.3), slab(V(sx, 5.9, sz), V(sx + 2.9, 5.0, sz), AZ, 6.2, 0.08, 0.02, 0.3),
  ], M.rib('plain', '#a9adae'));
  g.userData.breakable = true;
  const minX = Math.min(xL, ax - aw / 2) - 0.6, maxX = Math.max(xR, ax + aw / 2) + 0.6;
  return finish(g, minX, maxX, -r - 0.6, sz + 3.1);
}

// ============================================================ WATER TOWER

/** Legged steel water tower (~35 m) with the town name painted on the tank (reads from +Z and -Z). */
export function buildWaterTower(rng: RNG, townName: string): PropBuild {
  const g = new THREE.Group();
  g.name = 'water_tower';
  const Rt = rand(rng, 5.3, 6.3), ye = rand(rng, 27, 30), legs = Rt > 5.9 ? 6 : 4, Rg = Rt + 1.2;
  const paint = pick(rng, ['#cdd0cd', '#c3cbd0', '#d2d0c6', '#b9c3c4']);
  const letter = pick(rng, ['#2c4866', '#3a3a38', '#5a2a24']);
  // tank profile (r, y)
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) { const t = (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(Math.max(0.05, Rt * Math.sin(t)), ye - 0.62 * Rt * Math.cos(t))); }
  prof.push(new THREE.Vector2(Rt, ye + 2.6), new THREE.Vector2(Rt + 0.15, ye + 2.65));
  for (let i = 1; i <= 4; i++) { const t = i / 4; prof.push(new THREE.Vector2((Rt + 0.15) * (1 - t) + 0.35 * t, ye + 2.65 + Rt * 0.52 * Math.pow(t, 0.9))); }
  prof.push(new THREE.Vector2(0.12, ye + 2.65 + Rt * 0.52 + 0.5), new THREE.Vector2(0.03, ye + 2.65 + Rt * 0.52 + 1.4));
  const top = ye + 2.65 + Rt * 0.52 + 1.4;
  const tank = new THREE.LatheGeometry(prof, 40, Math.PI);
  // arc-length v
  const cum = [0];
  for (let i = 1; i < prof.length; i++) cum.push(cum[i - 1]! + prof[i]!.distanceTo(prof[i - 1]!));
  const total = cum[cum.length - 1]!;
  const uv = tank.getAttribute('uv');
  for (let k = 0; k < uv.count; k++) { const j = k % prof.length; uv.setY(k, cum[j]! / total); }
  const vEq = cum[6]! / total, vTop = cum[7]! / total;
  const mTank = std('watertower:' + townName + ':' + paint + letter, () => {
    const W = 2048, Hc = 1024, c = canvas(W, Hc), x = ctx2d(c);
    x.fillStyle = paint; x.fillRect(0, 0, W, Hc);
    const rr = mulberry32(townName.length * 17);
    for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(110,72,44,${0.05 + rr() * 0.12})`; const xx = rr() * W, y = (1 - vTop) * Hc - 10; x.fillRect(xx, y + rr() * 40, 2 + rr() * 5, 80 + rr() * 380); }
    const yMid = (1 - (vEq + vTop) / 2) * Hc - 10, fs = ((vTop - vEq) * Hc + 60) * 0.95;
    for (const cx of [W / 2, 0, W]) text(x, townName.toUpperCase(), cx, yMid, fs, letter, { maxW: W * 0.38, family: '"Arial Black", "Helvetica Neue", Arial, sans-serif', weight: '900' });
    grime(x, W, Hc, 21, 3);
    const map = mkTex(c, true);
    map.wrapT = THREE.ClampToEdgeWrapping;
    return { map, roughness: 0.55, metalness: 0.05 };
  });
  g.add(part('tank', tank, mTank));
  const mLeg = M.paint(paint, 0.6);
  const legG: THREE.BufferGeometry[] = [], brace: THREE.BufferGeometry[] = [];
  const legPt = (i: number, y: number) => { const a = (i / legs) * Math.PI * 2 + Math.PI / legs, rr = Rg + (Rt - 0.1 - Rg) * (y / ye); return V(Math.sin(a) * rr, y, Math.cos(a) * rr); };
  for (let i = 0; i < legs; i++) legG.push(rod(legPt(i, -0.2), legPt(i, ye), 0.3, 10, true, 0.26));
  const lv = [0, ye * 0.36, ye * 0.68];
  for (let i = 0; i < legs; i++) {
    const j = (i + 1) % legs;
    for (let k = 1; k < 3; k++) brace.push(strut(legPt(i, lv[k]!), legPt(j, lv[k]!), 0.16));
    for (let k = 0; k < 2; k++) {
      brace.push(strut(legPt(i, lv[k]! + 0.6), legPt(j, lv[k + 1]!), 0.04));
      brace.push(strut(legPt(j, lv[k]! + 0.6), legPt(i, lv[k + 1]!), 0.04));
    }
  }
  addPart(g, 'legs', legG, mLeg);
  addPart(g, 'bracing', brace, mLeg);
  addPart(g, 'footings', Array.from({ length: legs }, (_, i) => { const p = legPt(i, 0); return xf(cyl(0.7, 0.8, 0.5, 8), p.x, -0.2, p.z); }), M.concrete());
  addPart(g, 'riser', [xf(cyl(0.75, 0.75, ye - 0.62 * Rt + 0.3, 14, true), 0, 0, 0)], mLeg);
  const deck = new THREE.LatheGeometry([new THREE.Vector2(Rt - 0.05, ye - 0.1), new THREE.Vector2(Rt + 1.0, ye - 0.1), new THREE.Vector2(Rt + 1.0, ye), new THREE.Vector2(Rt - 0.05, ye)], 40);
  addPart(g, 'balcony', [deck, xf(cyl(Rt + 1.0, Rt + 1.0, 0.07, 40, true), 0, ye + 1.0, 0), xf(cyl(Rt + 1.0, Rt + 1.0, 0.05, 40, true), 0, ye + 0.5, 0)], mLeg);
  const lp = legPt(0, 0), lt = legPt(0, ye);
  const ld = lt.clone().sub(lp).normalize(), side = V(ld.z, 0, -ld.x).normalize().multiplyScalar(0.22), out = V(lp.x, 0, lp.z).normalize().multiplyScalar(0.4);
  const lad: THREE.BufferGeometry[] = [strut(lp.clone().add(side).add(out), lt.clone().add(side).add(out), 0.04), strut(lp.clone().sub(side).add(out), lt.clone().sub(side).add(out), 0.04)];
  const steps = Math.floor(ye / 0.75);
  for (let k = 1; k < steps; k++) { const p = lp.clone().lerp(lt, k / steps).add(out); lad.push(strut(p.clone().sub(side), p.clone().add(side), 0.025)); }
  addPart(g, 'ladder', lad, mLeg);
  void top;
  g.userData.breakable = true;
  return { group: g, collider: { type: 'box', hx: Rg + 0.6, hz: Rg + 0.6 } };
}

// ============================================================ CHURCH

function churchWindowMat(): THREE.MeshStandardMaterial {
  return std('churchwin', () => {
    const W = 256, H = 512;
    const paint = (x: CanvasRenderingContext2D, R: boolean) => {
      const f = (c: string, r: number) => { x.fillStyle = R ? `rgb(${Math.round(r * 255)},${Math.round(r * 255)},${Math.round(r * 255)})` : c; };
      f('#dcd9d0', 0.6); x.fillRect(0, 0, W, H);
      const arch = (ins: number) => { x.beginPath(); x.moveTo(ins, H - ins - 20); x.lineTo(ins, 170); x.quadraticCurveTo(ins, ins + 30, W / 2, ins); x.quadraticCurveTo(W - ins, ins + 30, W - ins, 170); x.lineTo(W - ins, H - ins - 20); x.closePath(); };
      f('#c4c1b8', 0.6); arch(16); x.fill();
      const cols = ['#5e5a3c', '#4a5640', '#6b4a3c', '#3e4a5a', '#6a6040'];
      x.save(); arch(28); x.clip();
      for (let r = 0; r < 12; r++) for (let c = 0; c < 4; c++) { f(cols[(r * 3 + c) % cols.length]!, 0.08); x.fillRect(28 + c * 50, 20 + r * 40, 48, 38); }
      if (!R) { const gr = x.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)'); x.fillStyle = gr; x.fillRect(0, 0, W, H); }
      f('#d0cdc4', 0.6); for (let c = 1; c < 4; c++) x.fillRect(26 + c * 50, 0, 4, H); for (let r = 1; r < 12; r++) x.fillRect(0, 18 + r * 40, W, 3);
      x.restore();
      f('#c9c6bc', 0.6); x.fillRect(0, H - 26, W, 26);
    };
    const c1 = canvas(W, H); paint(ctx2d(c1), false);
    const c2 = canvas(W, H); paint(ctx2d(c2), true);
    const map = mkTex(c1, true), rough = mkTex(c2, false);
    return { map, roughnessMap: rough, roughness: 1, metalness: 0 };
  });
}

/** White clapboard country church, gable front (+Z) with a centred steeple. */
export function buildChurch(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'church';
  const W = rand(rng, 7, 8.5), L = rand(rng, 12, 15), F = 0.6, wallH = rand(rng, 4.2, 4.8), pitch = rand(rng, 0.95, 1.15), t = 0.16;
  const eave = F + wallH, rise = (W / 2) * pitch, ridge = eave + rise;
  const mS = M.siding('#dedbd2'), mRoof = M.shingles(pick(rng, ['#4b4b4a', '#5a5550', '#55605a', '#6b4a40'])), mTrim = M.trim();
  addPart(g, 'foundation', [xf(box(W + 0.06, F, L + 0.06), 0, F / 2, 0)], M.concrete('#b8b2a2'));
  const gp = [[-W / 2, F - 0.1], [W / 2, F - 0.1], [W / 2, eave], [0, ridge], [-W / 2, eave]] as const;
  addPart(g, 'wall_front', [projUV(xf(prism(gp, t), 0, 0, L / 2 - t / 2))], mS);
  addPart(g, 'wall_back', [projUV(xf(prism(gp, t), 0, 0, -L / 2 + t / 2))], mS);
  const sh = eave - F + 0.1;
  addPart(g, 'wall_left', [projUV(xf(box(t, sh, L - 2 * t), -W / 2 + t / 2, F - 0.1 + sh / 2, 0))], mS);
  addPart(g, 'wall_right', [projUV(xf(box(t, sh, L - 2 * t), W / 2 - t / 2, F - 0.1 + sh / 2, 0))], mS);
  const ov = 0.3, ct = Math.cos(Math.atan(pitch));
  addPart(g, 'roof_left', [slab(V(0, ridge, 0), V(-W / 2, eave, 0), AZ, L + 2 * ov, 0.12, 0.04, ov / ct)], mRoof);
  addPart(g, 'roof_right', [slab(V(0, ridge, 0), V(W / 2, eave, 0), AZ, L + 2 * ov, 0.12, 0.04, ov / ct), xf(box(0.32, 0.07, L + 2 * ov), 0, ridge + 0.12 / ct - 0.01, 0)], mRoof);
  const trim: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    trim.push(xf(box(0.15, sh, 0.03), sx * (W / 2 - 0.075), F - 0.1 + sh / 2, sz * (L / 2 + 0.015)));
    trim.push(xf(box(0.03, sh, 0.15), sx * (W / 2 + 0.015), F - 0.1 + sh / 2, sz * (L / 2 - 0.075)));
    trim.push(slab(V(sx * 0.0, ridge - 0.17 / ct, sz * (L / 2 + ov - 0.02)), V(sx * (W / 2), eave - 0.17 / ct, sz * (L / 2 + ov - 0.02)), AZ, 0.04, 0.2, 0, ov / ct));
  }
  for (const sx of [-1, 1]) trim.push(xf(box(0.04, 0.2, L + 2 * ov), sx * (W / 2 + ov), eave - ov * pitch - 0.06, 0));
  // steeple tower in front of the gable
  const Tw = 2.6, tz = L / 2 + Tw / 2 - 0.1, tTop = ridge + 0.6;
  addPart(g, 'tower', [projUV(xf(box(Tw, tTop, Tw), 0, tTop / 2, tz))], mS);
  const bh = 2.3, bw = Tw - 0.3;
  addPart(g, 'belfry', [projUV(xf(box(bw, bh, bw), 0, tTop + bh / 2, tz))], M.siding('#9d9b94'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) trim.push(xf(box(0.16, bh + 0.1, 0.16), sx * (bw / 2), tTop + bh / 2, tz + sz * (bw / 2)));
  trim.push(xf(box(Tw + 0.2, 0.18, Tw + 0.2), 0, tTop + 0.05, tz), xf(box(bw + 0.3, 0.2, bw + 0.3), 0, tTop + bh, tz));
  const spH = rand(rng, 6.5, 8.5);
  const spire = new THREE.CylinderGeometry(0.03, (bw + 0.2) / Math.SQRT2 * 1.0, spH, 8, 1, false);
  spire.rotateY(Math.PI / 8);
  spire.translate(0, tTop + bh + 0.1 + spH / 2, tz);
  addPart(g, 'spire', [projUV(spire)], mRoof);
  const cy = tTop + bh + 0.1 + spH;
  addPart(g, 'cross', [xf(box(0.09, 1.3, 0.09), 0, cy + 0.6, tz), xf(box(0.7, 0.09, 0.09), 0, cy + 0.85, tz)], M.paint('#d8d4c8', 0.5));
  // windows, doors, steps
  const blk: Block = { cx: 0, cz: 0, hw: W / 2, hd: L / 2 };
  const cw = churchWindowMat(), wins: THREE.BufferGeometry[] = [];
  const nw = Math.max(3, Math.floor((L - 2) / 3));
  for (const s of ['left', 'right'] as const) for (let i = 0; i < nw; i++) {
    const zz = -L / 2 + 1.6 + ((L - 3.2) * i) / (nw - 1);
    wins.push(...mount([xf(boxAtlas(1.0, 2.4, 0.06, [EDGE, EDGE, EDGE, EDGE, FULL, EDGE]), 0, 0, 0.03)], blk, s, s === 'left' ? zz : -zz, F + 2.3));
  }
  const tb: Block = { cx: 0, cz: tz, hw: Tw / 2, hd: Tw / 2 };
  wins.push(...mount([xf(boxAtlas(0.8, 1.9, 0.06, [EDGE, EDGE, EDGE, EDGE, FULL, EDGE]), 0, 0, 0.03)], tb, 'front', 0, F + 4.6));
  addPart(g, 'windows', wins, cw);
  const di = pick(rng, [2, 0]);
  const dr = (k: number) => DOOR.cell(k), ds = (k: number) => DOOR.side(k);
  addPart(g, 'doors', [-0.5, 0.5].flatMap((o) => mount([xf(boxAtlas(0.98, 2.3, 0.06, [ds(di), ds(di), ds(di), ds(di), dr(di), ds(di)]), 0, 0, 0.03)], tb, 'front', o, F + 1.15)), M.doors());
  const steps: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) { const top = ((k + 1) * F) / 3, dep = (2 - k) * 0.32 + 0.3; steps.push(xf(box(2.6, top, dep), 0, top / 2, tz + Tw / 2 + dep / 2)); }
  addPart(g, 'steps', steps, M.concrete());
  addPart(g, 'trim', trim, mTrim);
  addPart(g, 'chimney', [projUV(xf(box(0.55, 2.2, 0.55), W / 4, ridge - 0.6, -L / 2 + 1.2))], M.brick());
  // yard sign
  const sign = canvasMat('churchsign', 512, 256, (c) => {
    c.fillStyle = '#e2dfd6'; c.fillRect(0, 0, 512, 256);
    c.strokeStyle = '#3a4a3a'; c.lineWidth = 10; c.strokeRect(10, 10, 492, 236);
    text(c, 'PRAIRIE HOME', 256, 80, 54, '#2f3d30', { family: 'Georgia, serif', weight: 'bold' });
    text(c, 'CHURCH', 256, 140, 54, '#2f3d30', { family: 'Georgia, serif', weight: 'bold' });
    text(c, 'EST. 1889 · SUNDAY 10:30', 256, 205, 26, '#3a3a38', { family: 'Georgia, serif' });
    grime(c, 512, 256, 33, 0.6);
  });
  const sz = tz + Tw / 2 + 5;
  g.add(part('yard_sign', xf(boxAtlas(1.6, 0.8, 0.06, [EDGE, EDGE, EDGE, EDGE, FULL, FULL]), 3.2, 1.2, sz), sign));
  addPart(g, 'yard_sign_posts', [xf(box(0.08, 1.6, 0.08), 3.2 - 0.7, 0.8, sz - 0.05), xf(box(0.08, 1.6, 0.08), 3.2 + 0.7, 0.8, sz - 0.05)], M.wood('#7e7869'));
  g.userData.breakable = true;
  return finish(g, -W / 2 - ov, W / 2 + ov, -L / 2 - ov, tz + Tw / 2 + 1.0);
}

// ============================================================ BILLBOARD

const ADS = 5;
function adMat(i: number): THREE.MeshStandardMaterial {
  return canvasMat('billboard:' + i, 1536, 470, (c) => {
    const W = 1536, H = 470, serif = 'Georgia, "Times New Roman", serif', sans = '"Arial Black", "Helvetica Neue", Arial, sans-serif';
    if (i === 0) {
      c.fillStyle = '#4f6a3a'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#d8c46a'; c.fillRect(0, 300, W, 170);
      text(c, 'HOFFMAN SEED & FEED', W / 2, 130, 120, '#ece6cf', { family: sans, maxW: 1400 });
      text(c, 'Alfalfa · Milo · Wheat · Since 1952', W / 2, 235, 54, '#e8e0c0', { family: serif });
      text(c, 'EXIT 12 · 2 MILES →', W / 2, 385, 90, '#3d4a2a', { family: sans });
    } else if (i === 1) {
      c.fillStyle = '#d9b641'; c.fillRect(0, 0, W, H);
      text(c, 'FIREWORKS', W / 2, 160, 210, '#a8322b', { family: sans, maxW: 1450 });
      c.fillStyle = '#a8322b'; c.fillRect(0, 300, W, 170);
      text(c, 'OPEN JUNE 27 – JULY 5 · 3 MILES AHEAD', W / 2, 385, 66, '#f0e6c8', { family: sans, maxW: 1450 });
    } else if (i === 2) {
      c.fillStyle = '#e6dcc2'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#7a4a2e'; c.beginPath(); c.arc(1260, 250, 150, Math.PI, 0); c.fill(); c.fillStyle = '#c99a5a'; c.fillRect(1110, 250, 300, 50);
      text(c, "DOT'S CAFE", 620, 150, 170, '#7a2f27', { family: serif, maxW: 1100 });
      text(c, 'Homemade Pie · Hot Coffee', 620, 280, 64, '#4a3a2a', { family: serif });
      text(c, '12 MILES AHEAD', 620, 390, 84, '#2e4a5a', { family: sans });
    } else if (i === 3) {
      c.fillStyle = '#2e4a63'; c.fillRect(0, 0, W, H);
      text(c, 'PRAIRIE WIND MOTEL', W / 2, 140, 130, '#efe9da', { family: sans, maxW: 1450 });
      text(c, 'CABLE TV · TRUCK PARKING', W / 2, 260, 66, '#d8cf9a', { family: sans });
      c.fillStyle = '#b8402e'; c.fillRect(470, 320, 600, 110);
      text(c, 'VACANCY', W / 2, 377, 86, '#f2e8d8', { family: sans });
    } else {
      c.fillStyle = '#efeadc'; c.fillRect(0, 0, W, H);
      text(c, 'ALFALFA HAY', W / 2, 140, 170, '#3c5a2e', { family: sans, maxW: 1400 });
      text(c, 'FOR SALE · SMALL & ROUND BALES', W / 2, 270, 62, '#3a3a38', { family: sans });
      text(c, 'CALL 555-0147', W / 2, 380, 96, '#7a2f27', { family: sans });
    }
    const r = mulberry32(400 + i);
    c.fillStyle = 'rgba(232,228,214,0.28)'; c.fillRect(0, 0, W, H);
    for (let k = 0; k < 9; k++) {
      const x = r() * W, w = 60 + r() * 200, y = r() * H * 0.6, h = 60 + r() * 260;
      c.fillStyle = r() < 0.5 ? 'rgba(214,214,206,0.92)' : 'rgba(120,140,160,0.85)';
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y + r() * 30); c.lineTo(x + w * 0.8, y + h); c.lineTo(x + w * 0.1, y + h * 0.9); c.fill();
    }
    for (let k = 1; k < 6; k++) { c.fillStyle = 'rgba(40,36,30,0.18)'; c.fillRect((W * k) / 6, 0, 2, H); }
    grime(c, W, H, 50 + i, 3);
  }, { roughness: 0.85 });
}

/** Weathered roadside billboard (~9.8 x 3 m face) facing +Z. */
export function buildBillboard(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'billboard';
  const steel = rng() < 0.35, bw = 9.8, bh = 3.0, by = steel ? rand(rng, 5, 6.5) : rand(rng, 2.8, 4.0);
  const ad = adMat(Math.floor(rng() * ADS));
  const back = M.boards('grey');
  const face = boxAtlas(bw, bh, 0.1, [EDGE, EDGE, EDGE, EDGE, FULL, EDGE]);
  g.add(part('face', xf(face, 0, by + bh / 2, 0), ad));
  addPart(g, 'backing', [projUV(xf(box(bw, bh, 0.04), 0, by + bh / 2, -0.07))], back);
  const frame: THREE.BufferGeometry[] = [];
  for (const y of [by + 0.3, by + bh / 2, by + bh - 0.3]) frame.push(xf(box(bw, 0.12, 0.1), 0, y, -0.15));
  if (steel) {
    addPart(g, 'column', [xf(box(0.45, by + 0.2, 0.32), 0, (by + 0.2) / 2, -0.4), xf(box(2.0, 0.3, 0.3), 0, by + 0.1, -0.35)], M.galv('#7d8282'));
    addPart(g, 'catwalk', [xf(box(bw, 0.05, 0.8), 0, by - 0.1, 0.45), xf(box(bw, 0.04, 0.04), 0, by + 0.9, 0.8)], M.galv('#8a8e8f'));
    addPart(g, 'lamps', [-3, 0, 3].flatMap((x) => [strut(V(x, by - 0.1, 0.4), V(x, by - 0.4, 1.4), 0.05), xf(box(0.4, 0.15, 0.25), x, by - 0.45, 1.45)]), M.darkMetal());
  } else {
    const poles: THREE.BufferGeometry[] = [];
    for (const x of [-3.6, 0, 3.6]) {
      poles.push(xf(cyl(0.13, 0.16, by + bh + 0.3, 8), x, -0.2, -0.3));
      frame.push(strut(V(x, by + 0.4, -0.35), V(x, 0, -2.2), 0.1));
    }
    addPart(g, 'poles', poles, M.wood('#6e604e'));
  }
  addPart(g, 'frame', frame, M.wood('#7d7466'));
  g.userData.breakable = true;
  return { group: g, collider: { type: 'box', hx: bw / 2 + 0.2, hz: steel ? 0.8 : 1.3 } };
}

// ============================================================ BARRICADE

function stripeMat(): THREE.MeshStandardMaterial {
  return canvasMat('barricade:stripe', 1216, 64, (c) => {
    c.fillStyle = '#e2e0d8'; c.fillRect(0, 0, 1216, 64);
    c.fillStyle = '#d4642a';
    for (let x = -64; x < 1216 + 64; x += 96) { c.beginPath(); c.moveTo(x, 64); c.lineTo(x + 48, 64); c.lineTo(x + 112, 0); c.lineTo(x + 64, 0); c.fill(); }
    grime(c, 1216, 64, 12, 0.8);
  }, { roughness: 0.4 });
}
function closedSignMat(line2: string): THREE.MeshStandardMaterial {
  return canvasMat('barricade:sign:' + line2, 512, 320, (c) => {
    c.fillStyle = '#e4e3dd'; c.fillRect(0, 0, 512, 320);
    c.strokeStyle = '#1d1d1c'; c.lineWidth = 10; c.strokeRect(14, 14, 484, 292);
    text(c, 'ROAD', 256, 112, 110, '#1d1d1c', { squeeze: 0.85 });
    text(c, line2, 256, 222, 110, '#1d1d1c', { squeeze: 0.85, maxW: 440 });
    grime(c, 512, 320, 77, 0.6);
  }, { roughness: 0.38 });
}

/** Type III barricade set blocking a two-lane road (~8 m 'roadClosed', ~12 m 'endOfMap'); faces +Z. */
export function buildBarricade(kind: 'roadClosed' | 'endOfMap'): PropBuild {
  const g = new THREE.Group();
  g.name = 'barricade_' + kind;
  const units = kind === 'roadClosed' ? [-2.05, 2.05] : [-4.1, 0, 4.1], uw = 3.8;
  const sm = stripeMat(), mWhite = M.paint('#dcdbd5', 0.6), mBag = M.paint('#8a7a5a', 1);
  const rails: THREE.BufferGeometry[] = [], posts: THREE.BufferGeometry[] = [], feet: THREE.BufferGeometry[] = [], bags: THREE.BufferGeometry[] = [];
  const e: Rect = [0.001, 0.4, 0.003, 0.42];
  for (const cx of units) {
    for (const y of [0.62, 1.02, 1.42]) rails.push(xf(boxAtlas(uw, 0.2, 0.035, [e, e, e, e, FULL, FULL]), cx, y, 0));
    for (const s of [-1, 1]) {
      posts.push(xf(box(0.09, 1.58, 0.09), cx + s * (uw / 2 - 0.35), 0.79, -0.07));
      feet.push(xf(box(0.09, 0.09, 1.3), cx + s * (uw / 2 - 0.35), 0.045, -0.07));
      bags.push(xf(box(0.5, 0.16, 0.34), cx + s * (uw / 2 - 0.35), 0.17, 0.42, 0.1 * s), xf(box(0.5, 0.16, 0.34), cx + s * (uw / 2 - 0.35), 0.17, -0.55, -0.1 * s));
    }
  }
  addPart(g, 'rails', rails, sm);
  addPart(g, 'posts', posts, mWhite);
  addPart(g, 'feet', feet, M.galv('#8a8e8f'));
  addPart(g, 'sandbags', bags, mBag);
  const sign = boxAtlas(1.2, 0.75, 0.03, [EDGE, EDGE, EDGE, EDGE, FULL, EDGE]);
  g.add(part('sign_road_closed', xf(sign, 0, 1.55 + 0.375 + 0.1, 0.03), closedSignMat('CLOSED')));
  addPart(g, 'sign_posts', [xf(box(0.06, 0.9, 0.04), -0.4, 1.75, -0.03), xf(box(0.06, 0.9, 0.04), 0.4, 1.75, -0.03)], M.galv('#9ea2a3'));
  let hx = (units.length * (uw + 0.3)) / 2;
  if (kind === 'endOfMap') {
    const sub = canvasMat('barricade:thru', 512, 160, (c) => { c.fillStyle = '#e4e3dd'; c.fillRect(0, 0, 512, 160); c.strokeStyle = '#1d1d1c'; c.lineWidth = 8; c.strokeRect(10, 10, 492, 140); text(c, 'NO THRU TRAFFIC', 256, 82, 62, '#1d1d1c', { squeeze: 0.85, maxW: 460 }); });
    g.add(part('sign_no_thru', xf(boxAtlas(1.2, 0.38, 0.03, [EDGE, EDGE, EDGE, EDGE, FULL, EDGE]), units[2]!, 1.95, 0.03), sub));
    addPart(g, 'sign_no_thru_post', [xf(box(0.06, 0.6, 0.04), units[2]!, 1.75, -0.03)], M.galv('#9ea2a3'));
    addPart(g, 'warning_lights', [units[0]! - uw / 2 + 0.35, units[2]! + uw / 2 - 0.35].map((x) => xf(cyl(0.11, 0.11, 0.08, 10), x, 1.62, 0.02, 0, Math.PI / 2)), M.emissive('#ffb030', 1.6), false);
    const drums: THREE.BufferGeometry[] = [], bands: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      drums.push(xf(cyl(0.29, 0.3, 0.95, 12), s * (hx + 0.8), 0, 0.2));
      for (const y of [0.42, 0.68]) bands.push(xf(cyl(0.303, 0.303, 0.12, 12, true), s * (hx + 0.8), y, 0.2));
    }
    addPart(g, 'drums', drums, M.paint('#cf5f27', 0.45));
    addPart(g, 'drum_bands', bands, mWhite);
    hx += 1.2;
  }
  g.userData.breakable = true;
  return { group: g, collider: { type: 'box', hx, hz: 0.7 } };
}
