import * as THREE from 'three';
import { mount, windowGeos } from './farmhouse';
import type { Block } from './farmhouse';
import { M } from './materials';
import { DOOR, WIN } from './textures';
import type { PropBuild } from './types';
import { AX, AZ, V, addPart, box, boxAtlas, cyl, finish, offsetUV, part, pick, prism, projUV, rand, randInt, slab, xf } from './util';
import type { RNG } from './util';

const D2R = Math.PI / 180;

/** Framed leaf (board door) with X brace in trim; local, facing +Z, centred. */
function bracedLeaf(w: number, h: number, trim: THREE.BufferGeometry[], cx: number, cy: number, z: number): void {
  const tw = 0.13, td = 0.03;
  trim.push(xf(box(w, tw, td), cx, cy + h / 2 - tw / 2, z));
  trim.push(xf(box(w, tw, td), cx, cy - h / 2 + tw / 2, z));
  trim.push(xf(box(tw, h, td), cx - w / 2 + tw / 2, cy, z));
  trim.push(xf(box(tw, h, td), cx + w / 2 - tw / 2, cy, z));
  const iw = w - 2 * tw, ih = h - 2 * tw, len = Math.hypot(iw, ih), a = Math.atan2(ih, iw);
  trim.push(xf(box(len - 0.06, tw * 0.9, td), cx, cy, z, 0, 0, a));
  trim.push(xf(box(len - 0.06, tw * 0.9, td), cx, cy, z, 0, 0, -a));
}

// ============================================================ BARN

export function buildBarn(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'barn';
  const red = rng() < 0.62;
  const W = rand(rng, 10, 12.5), L = rand(rng, 14, 20), t = 0.15, base = 0.45;
  const eave = rand(rng, 4.4, 5.2);
  const lowA = rand(rng, 58, 64) * D2R, upA = rand(rng, 24, 30) * D2R;
  const lowRun = (W / 2) * rand(rng, 0.28, 0.34), kx = W / 2 - lowRun, breakY = eave + lowRun * Math.tan(lowA);
  const ridgeY = breakY + kx * Math.tan(upA);
  const mWall = M.boards(red ? 'red' : 'grey');
  const mTrim = red ? M.trim('#d6d2c7') : M.boards('grey');
  const roofKind = pick(rng, red ? ['rust', 'rust', 'galv', 'red', 'grey'] : ['rust', 'rust', 'galv', 'grey']);
  const mRoof = roofKind === 'rust' ? M.rib('rust') : roofKind === 'galv' ? M.rib('plain', '#a3a7a8') : roofKind === 'red' ? M.rib('plain', '#7a2f27') : M.rib('plain', '#6c6e6c');
  const ou = rand(rng, 0, 2);
  const trim: THREE.BufferGeometry[] = [];
  let minX = -W / 2, maxX = W / 2;
  const minZ = -L / 2, maxZ = L / 2 + 0.1;

  addPart(g, 'foundation', [xf(box(W + 0.08, base, L + 0.08), 0, base / 2, 0)], M.concrete('#b3aa98'));
  const prof = [[-W / 2, base - 0.05], [W / 2, base - 0.05], [W / 2, eave], [kx, breakY], [0, ridgeY], [-kx, breakY], [-W / 2, eave]] as const;
  addPart(g, 'wall_front', [projUV(xf(prism(prof, t), 0, 0, L / 2 - t / 2), ou, 0)], mWall);
  addPart(g, 'wall_back', [projUV(xf(prism(prof, t), 0, 0, -L / 2 + t / 2), ou, 0)], mWall);
  const sh = eave - base + 0.05;
  addPart(g, 'wall_right', [projUV(xf(box(t, sh, L - 2 * t), W / 2 - t / 2, base - 0.05 + sh / 2, 0), ou, 0)], mWall);
  addPart(g, 'wall_left', [projUV(xf(box(t, sh, L - 2 * t), -W / 2 + t / 2, base - 0.05 + sh / 2, 0), ou, 0)], mWall);

  // roof: 4 planes
  const over = 0.35, eaveO = 0.4, rt = 0.1, rl = L + 2 * over;
  for (const sx of [-1, 1]) {
    const nm = sx < 0 ? 'left' : 'right';
    addPart(g, 'roof_lower_' + nm, [offsetUV(slab(V(sx * kx, breakY, 0), V((sx * W) / 2, eave, 0), AZ, rl, rt, 0.02, eaveO / Math.cos(lowA)), ou, 0)], mRoof);
    const up = [offsetUV(slab(V(0, ridgeY, 0), V(sx * kx, breakY, 0), AZ, rl, rt, 0.03, 0.08), ou, 0)];
    if (sx > 0) up.push(xf(box(0.36, 0.06, rl), 0, ridgeY + rt / Math.cos(upA) - 0.01, 0));
    addPart(g, 'roof_upper_' + nm, up, mRoof);
  }
  // corner trim + eave fascia
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    trim.push(xf(box(0.16, eave - base, 0.03), sx * (W / 2 - 0.08), (eave + base) / 2, sz * (L / 2 + 0.015)));
    trim.push(xf(box(0.03, eave - base, 0.16), sx * (W / 2 + 0.015), (eave + base) / 2, sz * (L / 2 - 0.08)));
  }

  // hay hood
  const hoodLen = rand(rng, 1.1, 1.6), hw = 1.4, hz0 = L / 2 + over - 0.05;
  const hb = ridgeY - hw * Math.tan(upA);
  const hood = [-1, 1].map((sx) => slab(V(0, ridgeY + 0.03, hz0 + hoodLen / 2), V(sx * hw, hb + 0.03, hz0 + hoodLen / 2), AZ, hoodLen, rt, 0.03, 0.05));
  addPart(g, 'hay_hood', hood, mRoof);
  addPart(g, 'hay_hood_gable', [projUV(xf(prism([[-hw, hb], [hw, hb], [0, ridgeY]], 0.05), 0, 0, hz0 + hoodLen - 0.05))], mWall);
  trim.push(xf(box(0.16, 0.22, hoodLen + 0.6), 0, hb - 0.15, L / 2 + hoodLen / 2 + 0.2));

  // big doors front & back
  const doors = (z: number, sz: number, scale: number, name: string) => {
    const dw = rand(rng, 3.8, 4.8) * scale, dh = Math.min(eave - 0.5, rand(rng, 3.6, 4.2) * scale);
    const leaves: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const cx = (sx * dw) / 4, cy = base + dh / 2;
      leaves.push(projUV(xf(box(dw / 2 + 0.04, dh, 0.08), cx, cy, z + sz * 0.05), ou + 0.37, 0));
      const lt: THREE.BufferGeometry[] = [];
      bracedLeaf(dw / 2, dh, lt, cx, cy, z + sz * 0.105);
      if (sz < 0) lt.forEach((q) => xf(q, 0, 0, 0));
      trim.push(...lt);
    }
    addPart(g, name, leaves, mWall);
    trim.push(xf(box(dw * 1.6, 0.14, 0.12), 0, base + dh + 0.12, z + sz * 0.1));
    return dh;
  };
  const fdh = doors(L / 2, 1, 1, 'door_front');
  doors(-L / 2, -1, 0.85, 'door_back');
  // loft door
  const ly = Math.max(base + fdh + 0.6, eave + 0.3), lh = Math.min(1.9, breakY - ly + 0.6);
  addPart(g, 'loft_door', [projUV(xf(box(1.7, lh, 0.07), 0, ly + lh / 2, L / 2 + 0.04), ou + 0.2, 0)], mWall);
  bracedLeaf(1.7, lh, trim, 0, ly + lh / 2, L / 2 + 0.09);

  // side windows + walk door
  const wins: THREE.BufferGeometry[] = [];
  const n = Math.max(2, Math.floor((L - 2) / 3.5));
  const blk: Block = { cx: 0, cz: 0, hw: W / 2, hd: L / 2 };
  for (const side of ['left', 'right'] as const)
    for (let i = 0; i < n; i++) {
      const s = -L / 2 + 1.6 + ((L - 3.2) * i) / (n - 1);
      if (side === 'right' && s > L / 2 - 2.6) continue;
      wins.push(...mount(windowGeos(WIN.barn((red ? 0 : 2) + (rng() < 0.3 ? 1 : 0)), red ? WIN.casingWhite : WIN.casingGrey, 0.85, 0.85, false), blk, side, s, base + 2.0));
    }
  addPart(g, 'windows', wins, M.windows());
  const di = red ? 4 : 5;
  addPart(g, 'door_side', mount([xf(boxAtlas(1.0, 2.1, 0.06, [DOOR.side(di), DOOR.side(di), DOOR.side(di), DOOR.side(di), DOOR.cell(di), DOOR.side(di)]), 0, 0, 0.03)], blk, 'right', -L / 2 + 1.4, base + 1.05), M.doors());

  // cupolas
  if (rng() < 0.55) {
    const nc = rng() < 0.5 ? 1 : 2;
    for (let i = 0; i < nc; i++) {
      const cz = nc === 1 ? 0 : (i === 0 ? -1 : 1) * L * 0.22;
      const cb = [projUV(xf(box(1.2, 1.3, 1.2), 0, ridgeY + 0.35, cz))];
      addPart(g, 'cupola_' + i, cb, mWall);
      const cone = new THREE.ConeGeometry(1.02, 0.75, 4, 1, false, Math.PI / 4);
      addPart(g, 'cupola_roof_' + i, [projUV(xf(cone, 0, ridgeY + 1.0 + 0.375, cz))], mRoof);
      if (i === 0 && rng() < 0.6) addPart(g, 'weathervane', [xf(cyl(0.012, 0.012, 1.0, 5, true), 0, ridgeY + 1.6, cz), xf(box(0.6, 0.05, 0.015), 0, ridgeY + 2.35, cz, rand(rng, 0, 3))], M.darkMetal());
    }
  }

  // lean-to shed
  if (rng() < 0.4) {
    const sx = rng() < 0.5 ? -1 : 1, lw = rand(rng, 3.5, 5), ll = L * rand(rng, 0.5, 0.9), lz = -L / 2 + ll / 2;
    const hiY = eave - 0.3, loY = 2.7, x0 = (sx * W) / 2, x1 = sx * (W / 2 + lw);
    const end = [[0, base - 0.05], [sx * lw, base - 0.05], [sx * lw, loY], [0, hiY]] as const;
    const lwalls = [
      xf(prism(end, t), x0, 0, lz + ll / 2 - t / 2),
      xf(prism(end, t), x0, 0, lz - ll / 2 + t / 2),
      xf(box(t, loY - base + 0.05, ll), x1 - (sx * t) / 2, (loY + base - 0.05) / 2, lz),
    ].map((q) => projUV(q, ou, 0));
    addPart(g, 'leanto_walls', lwalls, mWall);
    addPart(g, 'leanto_roof', [slab(V(x0, hiY, lz), V(x1, loY, lz), AZ, ll + 0.4, rt, 0.0, 0.35)], mRoof);
    if (sx < 0) minX -= lw + 0.35; else maxX += lw + 0.35;
  }
  addPart(g, 'trim', trim, mTrim);
  return finish(g, minX, maxX, minZ, maxZ);
}

// ============================================================ MACHINE SHED

const SHED_COLORS: [string, string][] = [
  ['#c4c7c6', '#6d7070'], ['#b8b9b2', '#4f5352'], ['#c2b495', '#6b5640'], ['#d0cec6', '#5a5d5c'], ['#9aa4a8', '#4c5458'], ['#c9c6bb', '#7a2f27'],
];

export function buildMachineShed(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'machine_shed';
  const W = rand(rng, 18, 26), D = rand(rng, 12, 16), eave = rand(rng, 4.8, 5.8), pitch = rand(rng, 0.25, 0.34);
  const ridge = eave + (D / 2) * pitch, t = 0.1;
  const [wc, tc] = pick(rng, SHED_COLORS);
  const galvalume = rng() < 0.4;
  const mWall = galvalume ? M.rib('plain', '#b5babb') : M.rib('plain', wc);
  const mTrim = M.rib('plain', tc);
  const mRoof = rng() < 0.65 ? M.rib('plain', '#aeb3b4') : mWall;
  const trim: THREE.BufferGeometry[] = [];
  const dw = Math.min(W * 0.62, rand(rng, 9, 14)), dh = eave - 0.55, dx = rand(rng, -(W - dw) / 2 + 1, (W - dw) / 2 - 1);
  const ajar = rng() < 0.4;

  addPart(g, 'slab', [xf(box(W + 0.3, 0.2, D + 0.3), 0, 0.05, 0)], M.concrete());
  // front wall with door opening
  const fz = D / 2 - t / 2, fl = dx - dw / 2 - -W / 2, fr = W / 2 - (dx + dw / 2);
  const front = [
    xf(box(fl, eave, t), -W / 2 + fl / 2, eave / 2, fz),
    xf(box(fr, eave, t), W / 2 - fr / 2, eave / 2, fz),
    xf(box(dw, eave - dh, t), dx, dh + (eave - dh) / 2, fz),
  ].map((q) => projUV(q));
  addPart(g, 'wall_front', front, mWall);
  addPart(g, 'wall_back', [projUV(xf(box(W, eave, t), 0, eave / 2, -D / 2 + t / 2))], mWall);
  const gp = [[-D / 2 + t, 0], [D / 2 - t, 0], [D / 2 - t, eave], [0, ridge], [-D / 2 + t, eave]] as const;
  addPart(g, 'wall_right', [projUV(xf(prism(gp, t), W / 2 - t / 2, 0, 0, Math.PI / 2))], mWall);
  addPart(g, 'wall_left', [projUV(xf(prism(gp, t), -W / 2 + t / 2, 0, 0, -Math.PI / 2))], mWall);
  // wainscot band
  const wh = 0.95, wain: THREE.BufferGeometry[] = [
    xf(box(fl, wh, 0.03), -W / 2 + fl / 2, wh / 2, D / 2 + 0.015),
    xf(box(fr, wh, 0.03), W / 2 - fr / 2, wh / 2, D / 2 + 0.015),
    xf(box(W, wh, 0.03), 0, wh / 2, -D / 2 - 0.015),
    xf(box(0.03, wh, D), W / 2 + 0.015, wh / 2, 0),
    xf(box(0.03, wh, D), -W / 2 - 0.015, wh / 2, 0),
  ].map((q) => projUV(q));
  addPart(g, 'wainscot', wain, mTrim);
  // roof
  const eaveO = 0.3, rake = 0.3, rt = 0.08, cosT = Math.cos(Math.atan(pitch));
  addPart(g, 'roof_front', [slab(V(0, ridge, 0), V(0, eave, D / 2), AX, W + 2 * rake, rt, 0.03, eaveO / cosT)], mRoof);
  addPart(g, 'roof_back', [slab(V(0, ridge, 0), V(0, eave, -D / 2), AX, W + 2 * rake, rt, 0.03, eaveO / cosT)], mRoof);
  trim.push(xf(box(W + 2 * rake, 0.08, 0.5), 0, ridge + rt / cosT, 0));
  for (const sz of [-1, 1]) trim.push(xf(box(W + 2 * rake, 0.18, 0.05), 0, eave - eaveO * pitch - 0.02, sz * (D / 2 + eaveO)));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    trim.push(slab(V(sx * (W / 2 + rake), ridge - 0.14, 0), V(sx * (W / 2 + rake), eave - 0.14, (sz * D) / 2), AX, 0.05, 0.2, 0, eaveO / cosT));
    trim.push(xf(box(0.14, eave, 0.14), sx * (W / 2 - 0.03), eave / 2, sz * (D / 2 - 0.03)));
  }
  // sliding doors
  const leafW = dw / 2 + 0.15, open = ajar ? dw * rand(rng, 0.25, 0.45) : 0;
  const leaves: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const cx = dx + (sx * dw) / 4 + (sx < 0 ? -open : 0);
    leaves.push(projUV(xf(box(leafW, dh + 0.15, 0.06), cx, (dh + 0.15) / 2 + 0.05, D / 2 + 0.06 + (sx < 0 ? 0.07 : 0))));
    for (const yy of [0.12, dh + 0.1]) trim.push(xf(box(leafW, 0.12, 0.03), cx, yy, D / 2 + 0.11 + (sx < 0 ? 0.07 : 0)));
    for (const ex of [-1, 1]) trim.push(xf(box(0.12, dh + 0.15, 0.03), cx + (ex * leafW) / 2 - ex * 0.06, (dh + 0.15) / 2 + 0.05, D / 2 + 0.11 + (sx < 0 ? 0.07 : 0)));
  }
  addPart(g, 'door_left', [leaves[0]!], mWall);
  addPart(g, 'door_right', [leaves[1]!], mWall);
  trim.push(xf(box(dw * 2 + 0.6, 0.22, 0.2), dx, dh + 0.32, D / 2 + 0.12));
  if (ajar) g.add(part('interior_shadow', xf(box(W - 0.6, eave - 0.2, D - 0.6), 0, (eave - 0.2) / 2 + 0.05, 0), M.paint('#0f0f0e', 1), false));
  // walk door + a couple windows
  const blk: Block = { cx: 0, cz: 0, hw: W / 2, hd: D / 2 };
  const wdS = dx > 0 ? -W / 2 + 1.8 : W / 2 - 1.8;
  addPart(g, 'door_walk', mount([xf(boxAtlas(0.95, 2.1, 0.05, [DOOR.side(3), DOOR.side(3), DOOR.side(3), DOOR.side(3), DOOR.cell(3), DOOR.side(3)]), 0, 0, 0.04)], blk, 'front', wdS, 1.1), M.doors());
  const wins: THREE.BufferGeometry[] = [];
  for (const s of [-D / 4, D / 4]) wins.push(...mount(windowGeos(WIN.shed, WIN.casingWhite, 1.2, 0.9, false), blk, pick(rng, ['left', 'right'] as const), s, 2.2));
  addPart(g, 'windows', wins, M.windows());
  addPart(g, 'trim', trim, mTrim);
  return finish(g, -W / 2 - 0.15, W / 2 + 0.15, -D / 2 - 0.15, D / 2 + 0.2);
}

// ============================================================ GRAIN BIN

export function buildGrainBin(rng: RNG, diameter?: number): PropBuild {
  const g = new THREE.Group();
  g.name = 'grain_bin';
  const dia = diameter ?? pick(rng, [5.5, 7.3, 8.2, 9.1, 10.1, 11]);
  const r = dia / 2, segs = 40;
  const rings = Math.max(4, Math.min(13, Math.round(rand(rng, 5, 9) + dia * 0.18)));
  const eaveH = 0.15 + rings * 0.8128;
  const roofA = 30 * D2R, ro = r + 0.14, rise = (ro - 0.45) * Math.tan(roofA), peak = eaveH + rise;
  const tint = pick(rng, ['#ffffff', '#f2f2f0', '#e6e8e8', '#dcdcda']);
  const mBin = M.bin(tint), mRoof = M.binRoof(tint), mGalv = M.galv('#9fa3a4');

  addPart(g, 'pad', [xf(cyl(r + 0.45, r + 0.5, 0.3, segs), 0, -0.15, 0)], M.concrete());
  const wall = new THREE.CylinderGeometry(r, r, eaveH - 0.15, segs, 1, true);
  wall.translate(0, (eaveH - 0.15) / 2 + 0.15, 0);
  {
    const uv = wall.getAttribute('uv');
    const circ = Math.max(1, Math.round((Math.PI * dia) / 2.74)) * 2.74;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * (eaveH - 0.15));
  }
  g.add(part('wall', wall, mBin));
  const roof = new THREE.CylinderGeometry(0.45, ro, rise, segs, 1, true);
  roof.translate(0, eaveH + rise / 2, 0);
  {
    const uv = roof.getAttribute('uv'), panels = Math.round((Math.PI * dia) / 0.9), sl = rise / Math.sin(roofA);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * panels, uv.getY(i) * sl);
  }
  g.add(part('roof', roof, mRoof));
  addPart(g, 'roof_cap', [xf(cyl(0.5, 0.5, 0.32, 14), 0, peak - 0.05, 0), xf(cyl(0.05, 0.62, 0.32, 14), 0, peak + 0.27, 0)], mGalv);
  // roof vents
  const vents: THREE.BufferGeometry[] = [];
  const nv = dia > 8 ? 4 : 2, rm = r * 0.55, va = rand(rng, 0, Math.PI);
  for (let i = 0; i < nv; i++) {
    const a = va + (i / nv) * Math.PI * 2, yy = eaveH + (ro - rm) * Math.tan(roofA) + 0.16;
    vents.push(xf(box(0.55, 0.34, 0.5), Math.sin(a) * rm, yy, Math.cos(a) * rm, a, roofA));
    vents.push(xf(box(0.62, 0.05, 0.6), Math.sin(a) * (rm + 0.05), yy + 0.2, Math.cos(a) * (rm + 0.05), a, roofA + 0.15));
  }
  addPart(g, 'roof_vents', vents, mGalv);
  // ladders
  const la = rand(rng, 0, Math.PI * 2);
  const lad: THREE.BufferGeometry[] = [];
  const H = eaveH + 0.3;
  for (const sx of [-1, 1]) {
    lad.push(xf(box(0.05, H - 0.6, 0.05), sx * 0.22, 0.6 + (H - 0.6) / 2, r + 0.24));
    for (let y = 1.5; y < H; y += 2.2) lad.push(xf(box(0.04, 0.04, 0.24), sx * 0.22, y, r + 0.12));
  }
  for (let y = 0.9; y < H; y += 0.3) lad.push(xf(box(0.44, 0.03, 0.03), 0, y, r + 0.24));
  const sl = (ro - 0.7) / Math.cos(roofA);
  const roofLad: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) roofLad.push(xf(box(0.05, 0.05, sl), sx * 0.22, eaveH + 0.12 + ((ro - 0.7) / 2) * Math.tan(roofA), (ro + 0.7) / 2, 0, roofA));
  for (let k = 0.35; k < sl; k += 0.4) {
    const zz = ro - k * Math.cos(roofA);
    roofLad.push(xf(box(0.44, 0.03, 0.03), 0, eaveH + 0.13 + (ro - zz) * Math.tan(roofA), zz));
  }
  addPart(g, 'ladder', lad.map((q) => xf(q, 0, 0, 0, la)), mGalv);
  addPart(g, 'roof_ladder', roofLad.map((q) => xf(q, 0, 0, 0, la)), mGalv);
  // door + aeration fan
  const da = la + rand(rng, 0.8, 1.6), fa = la + Math.PI + rand(rng, -0.6, 0.6);
  addPart(g, 'door', [xf(box(0.75, 1.15, 0.05), Math.sin(da) * (r + 0.03), 0.85, Math.cos(da) * (r + 0.03), da)], M.galv('#8c9091'));
  const fan = [
    xf(box(0.75, 0.85, 0.6), 0, 0.62, r + 0.25),
    xf(cyl(0.45, 0.45, 0.6, 14), 0, 0, 0, 0, Math.PI / 2),
    xf(cyl(0.2, 0.2, 0.35, 10), 0, 0, 0, 0, Math.PI / 2),
  ];
  xf(fan[1]!, 0, 0.62, r + 0.5);
  xf(fan[2]!, 0, 0.62, r + 1.1);
  addPart(g, 'aeration_fan', fan.map((q) => xf(q, 0, 0, 0, fa)), M.paint(pick(rng, ['#9a9d9c', '#b0a46a', '#7e8a8f']), 0.6));
  g.userData.breakable = true;
  return { group: g, collider: { type: 'circle', r: r + 0.15 } };
}

// ============================================================ SILO

export function buildSilo(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'silo';
  const r = rand(rng, 2.45, 3.05), H = rand(rng, 14, 20), segs = 28;
  const dome = rng() < 0.62;
  addPart(g, 'base', [xf(cyl(r + 0.35, r + 0.4, 0.4, segs), 0, -0.2, 0)], M.concrete());
  const wall = new THREE.CylinderGeometry(r, r, H, segs, 1, !dome ? true : true);
  wall.translate(0, H / 2 + 0.2, 0);
  {
    const uv = wall.getAttribute('uv'), circ = Math.max(1, Math.round((Math.PI * 2 * r) / 1.524)) * 1.524;
    const v0 = rand(rng, 0, 6);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * H + v0);
  }
  g.add(part('staves', wall, M.staves(!dome)));
  const hoops: THREE.BufferGeometry[] = [];
  let y = 0.6, sp = 0.42;
  while (y < H - 0.2) {
    hoops.push(xf(cyl(r + 0.022, r + 0.022, 0.04, 24, true), 0, y, 0));
    y += sp;
    sp = Math.min(1.25, sp * 1.07);
  }
  addPart(g, 'hoops', hoops, M.paint('#4b3f36', 0.7));
  const domeC = pick(rng, ['#9da1a2', '#8a3a2e', '#a8acad', '#6f6f6b']);
  const top = H + 0.2;
  if (dome) {
    const s = new THREE.SphereGeometry(r + 0.06, segs, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    s.scale(1, 0.5, 1);
    xf(s, 0, top, 0);
    addPart(g, 'dome', [projUV(s), xf(cyl(0.35, 0.4, 0.3, 10), 0, top + (r + 0.06) * 0.5 - 0.05, 0)], M.galv(domeC));
  } else {
    addPart(g, 'rim', [xf(cyl(r + 0.08, r + 0.08, 0.18, segs, true), 0, top - 0.1, 0)], M.concrete('#8f8c85'));
  }
  // unloading chute + blower pipe
  const ca = rand(rng, 0, Math.PI * 2);
  const chute = [xf(box(0.85, H - 0.6, 0.6), 0, 0.6 + (H - 0.6) / 2, r + 0.28), xf(box(1.0, 0.5, 1.0), 0, top + 0.05, r + 0.15, 0, -0.35)];
  addPart(g, 'chute', chute.map((q) => projUV(xf(q, 0, 0, 0, ca))), M.galv(dome ? domeC : '#9da1a2'));
  const pa = ca + rand(rng, 0.7, 1.2);
  const pipe = [xf(cyl(0.11, 0.11, top + 0.3, 8, true), Math.sin(pa) * (r + 0.2), 0.2, Math.cos(pa) * (r + 0.2)), xf(box(0.24, 0.24, 1.0), Math.sin(pa) * (r - 0.2), top + 0.45, Math.cos(pa) * (r - 0.2), pa, 0.4)];
  addPart(g, 'blower_pipe', pipe, M.galv('#8c9091'));
  void randInt;
  g.userData.breakable = true;
  return { group: g, collider: { type: 'circle', r: r + 0.3 } };
}
