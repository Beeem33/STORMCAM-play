import * as THREE from 'three';
import { M } from './materials';
import { DOOR, WIN } from './textures';
import type { PropBuild } from './types';
import { AX, AZ, V, addPart, box, boxAtlas, cyl, finish, offsetUV, pick, prism, projUV, rand, slab, xf } from './util';
import type { RNG, Rect } from './util';

export type Side = 'front' | 'back' | 'left' | 'right';
export interface Block { cx: number; cz: number; hw: number; hd: number }

/** Position/rotation for something mounted on a block wall. s = offset to the viewer's right when facing the wall. */
export function wallXform(b: Block, side: Side, s: number, out: number): { x: number; z: number; ry: number } {
  switch (side) {
    case 'front': return { x: b.cx + s, z: b.cz + b.hd + out, ry: 0 };
    case 'back': return { x: b.cx - s, z: b.cz - b.hd - out, ry: Math.PI };
    case 'right': return { x: b.cx + b.hw + out, z: b.cz - s, ry: Math.PI / 2 };
    case 'left': return { x: b.cx - b.hw - out, z: b.cz + s, ry: -Math.PI / 2 };
  }
}

/** Window box (front face = atlas cell, sides = casing) + sill, in local space facing +Z. */
export function windowGeos(cell: Rect, side: Rect, w: number, h: number, sill = true): THREE.BufferGeometry[] {
  const depth = 0.07;
  const out = [xf(boxAtlas(w, h, depth, [side, side, side, side, cell, side]), 0, 0, depth / 2)];
  if (sill) out.push(xf(boxAtlas(w + 0.12, 0.05, 0.13, [side, side, side, side, side, side]), 0, -h / 2 - 0.02, 0.065));
  return out;
}
export function mount(geos: THREE.BufferGeometry[], b: Block, side: Side, s: number, y: number, out = 0): THREE.BufferGeometry[] {
  const p = wallXform(b, side, s, out);
  return geos.map((g) => xf(g, p.x, y, p.z, p.ry));
}

const SIDING = ['#dcd9d0', '#d8d2bf', '#cfc8a6', '#b6bcb9', '#b9b9a0', '#cbc5b6', '#a5aeb0', '#d3cfc4', '#8d4235'];
const ROOFS = ['#4b4b4a', '#5a5550', '#3e3f3f', '#5b5244', '#4c5250', '#6a5d4f'];
const FOUND = ['#b9b6ae', '#b8ae98', '#a9a59c', '#c2b8a2'];

export function buildFarmhouse(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'farmhouse';
  const two = rng() < 0.62;
  const W = rand(rng, 8.8, 11.6), D = rand(rng, 6.4, 7.8);
  const F = rand(rng, 0.45, 0.72), SH = 2.75, t = 0.16;
  const eave = two ? F + 2 * SH + 0.2 : F + SH + 1.05;
  const pitch = two ? rand(rng, 0.62, 0.92) : rand(rng, 0.95, 1.15);
  const rise = (D / 2) * pitch, ridge = eave + rise;
  const y0 = F - 0.1;
  const mSiding = M.siding(pick(rng, SIDING)), mRoof = M.shingles(pick(rng, ROOFS)), mTrim = M.trim();
  const mWin = M.windows(), mDoor = M.doors(), mFound = M.concrete(pick(rng, FOUND));
  const ou = rand(rng, 0, 3);
  const main: Block = { cx: 0, cz: 0, hw: W / 2, hd: D / 2 };
  const trim: THREE.BufferGeometry[] = [];
  const wins: Record<Side, THREE.BufferGeometry[]> = { front: [], back: [], left: [], right: [] };
  const cellR = (): Rect => WIN.dh(Math.floor(rng() * 6));
  let minX = -W / 2, maxX = W / 2, minZ = -D / 2, maxZ = D / 2;

  // ---------------- wing (rear ell, one storey)
  const hasWing = rng() < 0.65;
  const ww = rand(rng, 4.6, 6.0), wd = rand(rng, 4.0, 5.8);
  const wx = (rng() < 0.5 ? -1 : 1) * rand(rng, 0, Math.max(0, (W - ww) / 2));
  const wEave = F + SH + 0.1;
  let wPitch = pitch;
  if (wEave + (ww / 2) * wPitch > ridge - 0.5) wPitch = (ridge - 0.5 - wEave) / (ww / 2);
  const wRidge = wEave + (ww / 2) * wPitch;
  const wing: Block = { cx: wx, cz: -D / 2 - wd / 2, hw: ww / 2, hd: wd / 2 };
  const inWing = (x: number) => hasWing && Math.abs(x - wx) < ww / 2 + 0.55;

  // ---------------- foundation
  const found = [xf(box(W + 0.06, F, D + 0.06), 0, F / 2, 0)];
  if (hasWing) found.push(xf(box(ww + 0.06, F, wd + 0.06), wx, F / 2, -D / 2 - wd / 2));
  addPart(g, 'foundation', found, mFound);

  // ---------------- walls
  const wallH = eave - y0;
  const gable = [[-D / 2, y0], [D / 2, y0], [D / 2, eave], [0, ridge], [-D / 2, eave]] as const;
  addPart(g, 'wall_front', [projUV(xf(box(W - 2 * t, wallH, t), 0, y0 + wallH / 2, D / 2 - t / 2), ou, 0)], mSiding);
  addPart(g, 'wall_back', [projUV(xf(box(W - 2 * t, wallH, t), 0, y0 + wallH / 2, -D / 2 + t / 2), ou, 0)], mSiding);
  addPart(g, 'wall_right', [projUV(xf(prism(gable, t), W / 2 - t / 2, 0, 0, Math.PI / 2), ou, 0)], mSiding);
  addPart(g, 'wall_left', [projUV(xf(prism(gable, t), -W / 2 + t / 2, 0, 0, -Math.PI / 2), ou, 0)], mSiding);

  // corner boards + frieze
  const cb = (x: number, z: number, h: number, base: number) => {
    const sx = Math.sign(x), sz = Math.sign(z);
    trim.push(xf(box(0.14, h, 0.03), x - sx * 0.07, base + h / 2, z + sz * 0.015));
    trim.push(xf(box(0.03, h, 0.14), x + sx * 0.015, base + h / 2, z - sz * 0.07));
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cb((sx * W) / 2, (sz * D) / 2, eave - y0, y0);
  for (const sz of [-1, 1]) trim.push(xf(box(W, 0.2, 0.03), 0, eave - 0.12, sz * (D / 2 + 0.015)));

  // ---------------- roof
  const rakeO = 0.3, eaveO = rand(rng, 0.3, 0.45), rt = 0.12, cosT = Math.cos(Math.atan(pitch));
  const A = V(0, ridge, 0), rl = W + 2 * rakeO;
  const ruo = rand(rng, 0, 2);
  addPart(g, 'roof_front', [offsetUV(slab(A, V(0, eave, D / 2), AX, rl, rt, 0.04, eaveO / cosT), ruo, 0)], mRoof);
  addPart(g, 'roof_back', [offsetUV(slab(A, V(0, eave, -D / 2), AX, rl, rt, 0.04, eaveO / cosT), ruo, 0.3), xf(box(rl, 0.07, 0.34), 0, ridge + rt / cosT - 0.01, 0)], mRoof);
  const eaveY = eave - eaveO * pitch;
  for (const sz of [-1, 1]) {
    trim.push(xf(box(rl, 0.2, 0.04), 0, eaveY - 0.06, sz * (D / 2 + eaveO)));
    trim.push(xf(box(rl + 0.04, 0.12, 0.12), 0, eaveY - 0.1, sz * (D / 2 + eaveO + 0.08)));
    trim.push(xf(box(W, 0.02, eaveO), 0, eaveY - 0.15, sz * (D / 2 + eaveO / 2)));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const dz = 0.17 / cosT;
    trim.push(slab(V(sx * (W / 2 + rakeO - 0.02), ridge - dz, 0), V(sx * (W / 2 + rakeO - 0.02), eave - dz, (sz * D) / 2), AX, 0.04, 0.2, 0, eaveO / cosT));
  }
  // downspouts on two corners
  for (const [sx, sz] of [[-1, 1], [1, -1]] as const) {
    trim.push(xf(box(0.075, eaveY - 0.15, 0.075), sx * (W / 2 + 0.1), (eaveY - 0.15) / 2, sz * (D / 2 + 0.08)));
    trim.push(xf(box(0.075, 0.075, eaveO), sx * (W / 2 + 0.1), eaveY - 0.12, sz * (D / 2 + eaveO / 2 + 0.05)));
  }

  // ---------------- porch
  const PD = rand(rng, 2.1, 2.6);
  const full = rng() < 0.5;
  const porchW = full ? W : rand(rng, 4.2, W * 0.72);
  const porchX = full ? 0 : (rng() < 0.5 ? -1 : 1) * rand(rng, 0, (W - porchW) / 2);
  const pf = F - 0.12;
  const pz0 = D / 2, pz1 = D / 2 + PD;
  // front door location: within porch
  const nSlots = Math.max(2, Math.floor((W - 1.2) / 2.3));
  const slots = Array.from({ length: nSlots }, (_, i) => -W / 2 + 1.05 + ((W - 2.1) * i) / (nSlots - 1));
  let doorSlot = nSlots % 2 === 1 ? (nSlots - 1) / 2 : rng() < 0.5 ? 1 : nSlots - 2;
  let doorX = slots[doorSlot]!;
  if (Math.abs(doorX - porchX) > porchW / 2 - 0.8) { doorX = porchX; doorSlot = -1; }
  const steps = Math.max(2, Math.ceil(pf / 0.19));
  const stepD = (steps - 1) * 0.28;
  maxZ = pz1 + stepD;
  addPart(g, 'porch_floor', [xf(box(porchW, 0.14, PD), porchX, pf - 0.07, pz0 + PD / 2)], M.paint('#8f918c', 0.85));
  const skirt = [xf(box(porchW, pf - 0.14, 0.03), porchX, (pf - 0.14) / 2, pz1 - 0.04)];
  for (const sx of [-1, 1]) skirt.push(xf(box(0.03, pf - 0.14, PD), porchX + (sx * porchW) / 2 - sx * 0.02, (pf - 0.14) / 2, pz0 + PD / 2));
  addPart(g, 'porch_skirt', skirt.map((s) => projUV(s)), M.lattice());
  const stepGeos: THREE.BufferGeometry[] = [];
  for (let k = 0; k < steps - 1; k++) {
    const top = ((k + 1) * pf) / steps, dep = (steps - 1 - k) * 0.28;
    stepGeos.push(xf(box(1.6, top, dep), doorX, top / 2, pz1 + dep / 2));
  }
  addPart(g, 'porch_steps', stepGeos, M.concrete());
  const yA = Math.min(eave - 0.25, F + SH + 0.35), pPitch = 0.27;
  addPart(g, 'porch_roof', [slab(V(porchX, yA, pz0), V(porchX, yA - PD * pPitch, pz1), AX, porchW + 0.4, 0.1, 0, 0.3)], mRoof);
  const beamY = yA - (PD - 0.15) * pPitch - 0.13;
  const nPosts = Math.max(2, Math.round(porchW / 2.4) + 1);
  const postXs = Array.from({ length: nPosts }, (_, i) => porchX - porchW / 2 + 0.15 + ((porchW - 0.3) * i) / (nPosts - 1));
  const posts = postXs.map((x) => xf(box(0.14, beamY - 0.11 - pf, 0.14), x, (beamY - 0.11 + pf) / 2, pz1 - 0.15));
  addPart(g, 'porch_posts', posts, mTrim);
  addPart(g, 'porch_beam', [xf(box(porchW + 0.1, 0.22, 0.16), porchX, beamY, pz1 - 0.15), xf(box(porchW, 0.03, PD), porchX, beamY + 0.1 + (PD / 2) * pPitch * 0.5, pz0 + PD / 2)], mTrim);
  if (rng() < 0.55) {
    const rail: THREE.BufferGeometry[] = [];
    const span = (xa: number, xb: number, za: number, zb: number) => {
      const len = Math.hypot(xb - xa, zb - za), ry = Math.atan2(xb - xa, zb - za) - Math.PI / 2;
      const mx = (xa + xb) / 2, mz = (za + zb) / 2;
      rail.push(xf(box(len, 0.06, 0.09), mx, pf + 0.9, mz, ry));
      rail.push(xf(box(len, 0.05, 0.06), mx, pf + 0.12, mz, ry));
      const n = Math.floor(len / 0.3);
      for (let i = 1; i < n; i++) {
        const f = i / n;
        rail.push(xf(box(0.04, 0.75, 0.04), xa + (xb - xa) * f, pf + 0.51, za + (zb - za) * f, ry));
      }
    };
    for (let i = 0; i < nPosts - 1; i++) {
      const xa = postXs[i]! + 0.07, xb = postXs[i + 1]! - 0.07;
      if (doorX > xa - 0.9 && doorX < xb + 0.9) {
        if (doorX - 0.85 - xa > 0.4) span(xa, doorX - 0.85, pz1 - 0.15, pz1 - 0.15);
        if (xb - doorX - 0.85 > 0.4) span(doorX + 0.85, xb, pz1 - 0.15, pz1 - 0.15);
      } else span(xa, xb, pz1 - 0.15, pz1 - 0.15);
    }
    for (const x of [postXs[0]!, postXs[nPosts - 1]!]) span(x, x, pz0 + 0.05, pz1 - 0.22);
    addPart(g, 'porch_rail', rail, mTrim);
  }

  // ---------------- windows & doors on the main block
  const winGeo = (cell: Rect, w = 0.92, h = 1.62) => windowGeos(cell, WIN.casingWhite, w, h);
  const yG = F + 1.55, yU = F + SH + 1.5;
  for (let i = 0; i < nSlots; i++) {
    const x = slots[i]!;
    if (i !== doorSlot && Math.abs(x - doorX) > 1.1) wins.front.push(...mount(winGeo(cellR()), main, 'front', x, yG));
    if (two) wins.front.push(...mount(winGeo(cellR()), main, 'front', x, yU));
    // back wall (s = -x)
    if (!inWing(x)) {
      wins.back.push(...mount(winGeo(cellR()), main, 'back', -x, yG));
      if (two) wins.back.push(...mount(winGeo(cellR()), main, 'back', -x, yU));
    }
  }
  for (const side of ['left', 'right'] as const) {
    for (const s of [-D / 4, D / 4]) {
      wins[side].push(...mount(winGeo(cellR()), main, side, s, yG));
      wins[side].push(...mount(winGeo(cellR(), two ? 0.92 : 0.82, two ? 1.62 : 1.3), main, side, s, two ? yU : F + SH + 1.4));
    }
  }
  const doorGeo = (i: number, w = 1.0, h = 2.12) => [xf(boxAtlas(w, h, 0.06, [DOOR.side(i), DOOR.side(i), DOOR.side(i), DOOR.side(i), DOOR.cell(i), DOOR.side(i)]), 0, 0, 0.03)];
  addPart(g, 'door_front', mount(doorGeo(pick(rng, [0, 1, 2])), main, 'front', doorX, F + 1.06), mDoor);

  // ---------------- chimney
  const brick: THREE.BufferGeometry[] = [];
  const extSide = rng() < 0.4 ? (rng() < 0.5 ? -1 : 1) : 0;
  if (extSide !== 0) {
    const xo = extSide * (W / 2 + 0.31);
    brick.push(xf(box(0.62, eave - 1.0, 1.3), xo, (eave - 1.0) / 2, 0));
    const top = ridge + rand(rng, 0.6, 1.0);
    brick.push(xf(box(0.6, top - eave + 1.0, 0.72), xo, (top + eave - 1.0) / 2, 0));
    brick.push(xf(box(0.7, 0.08, 0.82), xo, top + 0.04, 0));
    if (extSide < 0) minX -= 0.65; else maxX += 0.65;
  } else {
    const cx = (rng() < 0.5 ? -1 : 1) * rand(rng, Math.max(0, W / 2 - 2.2), W / 2 - 1.1), cz = rand(rng, -0.5, 0.4);
    const top = ridge + rand(rng, 0.7, 1.1), bot = eave - 0.5;
    brick.push(xf(box(0.62, top - bot, 0.74), cx, (top + bot) / 2, cz));
    brick.push(xf(box(0.72, 0.08, 0.84), cx, top + 0.04, cz));
  }
  addPart(g, 'chimney', brick.map((b) => projUV(b)), M.brick());
  // attic windows (two-storey gables without exterior chimney on that side)
  if (two && rise > 2.1) for (const side of ['left', 'right'] as const) {
    if ((side === 'left' && extSide < 0) || (side === 'right' && extSide > 0)) continue;
    wins[side].push(...mount(windowGeos(WIN.attic, WIN.casingWhite, 0.7, 0.7, false), main, side, 0, eave + rise * 0.4));
  }

  // ---------------- wing
  if (hasWing) {
    minZ = -D / 2 - wd;
    const wy0 = y0, wH = wEave - wy0, zb = -D / 2 - wd;
    const wgable = [[-ww / 2, wy0], [ww / 2, wy0], [ww / 2, wEave], [0, wRidge], [-ww / 2, wEave]] as const;
    const wWalls = [
      xf(prism(wgable, t), wx, 0, zb + t / 2),
      xf(box(t, wH, wd - t), wx - ww / 2 + t / 2, wy0 + wH / 2, -D / 2 - (wd - t) / 2 + 0.0),
      xf(box(t, wH, wd - t), wx + ww / 2 - t / 2, wy0 + wH / 2, -D / 2 - (wd - t) / 2 + 0.0),
    ].map((w) => projUV(w, ou, 0));
    addPart(g, 'wing_wall_back', [wWalls[0]!], mSiding);
    addPart(g, 'wing_wall_left', [wWalls[1]!], mSiding);
    addPart(g, 'wing_wall_right', [wWalls[2]!], mSiding);
    const ext = Math.min(D / 2, Math.max(0.05, wRidge > eave ? D / 2 + (wRidge - ridge) / pitch + 0.35 : 0.05));
    const zc = (-D / 2 + ext + zb - 0.3) / 2, len = ext + wd + 0.3;
    const wcos = Math.cos(Math.atan(wPitch));
    addPart(g, 'wing_roof_left', [slab(V(wx, wRidge, zc), V(wx - ww / 2, wEave, zc), AZ, len, rt, 0.04, eaveO / wcos)], mRoof);
    addPart(g, 'wing_roof_right', [slab(V(wx, wRidge, zc), V(wx + ww / 2, wEave, zc), AZ, len, rt, 0.04, eaveO / wcos), xf(box(0.34, 0.07, len), wx, wRidge + rt / wcos - 0.01, zc)], mRoof);
    const wEaveY = wEave - eaveO * wPitch;
    for (const sx of [-1, 1]) {
      trim.push(xf(box(0.04, 0.2, len), wx + sx * (ww / 2 + eaveO), wEaveY - 0.06, zc));
      trim.push(xf(box(0.12, 0.12, len), wx + sx * (ww / 2 + eaveO + 0.08), wEaveY - 0.1, zc));
      trim.push(xf(box(0.14, wH, 0.03), wx + sx * (ww / 2 - 0.07), wy0 + wH / 2, zb - 0.015));
      trim.push(xf(box(0.03, wH, 0.14), wx + sx * (ww / 2 + 0.015), wy0 + wH / 2, zb + 0.07));
    }
    const wwins: THREE.BufferGeometry[] = [];
    wwins.push(...mount(winGeo(cellR()), wing, 'back', 0, yG));
    wwins.push(...mount(winGeo(cellR(), 0.7, 0.7), wing, 'back', 0, wEave + (wRidge - wEave) * 0.35));
    const outer: Side = wx >= 0 ? 'right' : 'left';
    const inner: Side = wx >= 0 ? 'left' : 'right';
    wwins.push(...mount(winGeo(cellR()), wing, outer, outer === 'right' ? wd / 4 : -wd / 4, yG));
    wwins.push(...mount(winGeo(cellR()), wing, inner, inner === 'right' ? -wd / 5 : wd / 5, yG));
    addPart(g, 'wing_windows', wwins, mWin);
    const ds = outer === 'right' ? -wd / 2 + 1.0 : wd / 2 - 1.0;
    const bd = mount(doorGeo(pick(rng, [0, 3])), wing, outer, ds, F + 1.06);
    const stoopP = wallXform(wing, outer, ds, 0.6);
    bd.push(xf(box(1.4, F, 1.2), stoopP.x, F / 2, stoopP.z, stoopP.ry));
    addPart(g, 'door_back', bd, mDoor);
  } else {
    const bx = slots[Math.floor(rng() * nSlots)]!;
    const bd = mount(doorGeo(pick(rng, [0, 3])), main, 'back', -bx + (bx > 0 ? -0.6 : 0.6), F + 1.06);
    addPart(g, 'door_back', bd, mDoor);
  }
  addPart(g, 'trim', trim, mTrim);
  for (const side of ['front', 'back', 'left', 'right'] as const) addPart(g, 'windows_' + side, wins[side], mWin);

  // ---------------- extras: TV antenna, propane tank, AC unit
  if (rng() < 0.5) {
    const ax = (rng() < 0.5 ? -1 : 1) * (W / 2 - 1.2), az = -0.7;
    const base = ridge - 0.7 * pitch - 0.2, top = ridge + rand(rng, 2.0, 3.2);
    const ant: THREE.BufferGeometry[] = [xf(cyl(0.022, 0.022, top - base, 6, true), ax, base, az)];
    const ry = rand(rng, 0, Math.PI);
    ant.push(xf(box(0.03, 0.03, 2.3), ax, top - 0.2, az, ry));
    for (let i = 0; i < 7; i++) ant.push(xf(box(1.1 - i * 0.08, 0.015, 0.015), ax + Math.sin(ry) * (i * 0.32 - 1.0), top - 0.2, az + Math.cos(ry) * (i * 0.32 - 1.0), ry));
    addPart(g, 'antenna', ant, M.galv('#7d8182'));
  }
  if (rng() < 0.5) {
    const sx = rng() < 0.5 ? -1 : 1, along = rng() < 0.5;
    const tank = new THREE.CapsuleGeometry(0.47, 2.2, 4, 12);
    xf(tank, sx * (W / 2 + rand(rng, 3.5, 6)), 0.75, rand(rng, -D / 2, D / 2), along ? 0 : Math.PI / 2, Math.PI / 2);
    tank.computeBoundingBox();
    const bb = tank.boundingBox!;
    const tx = (bb.min.x + bb.max.x) / 2, tz = (bb.min.z + bb.max.z) / 2;
    const legs = [-0.8, 0.8].map((o) => xf(box(along ? 0.5 : 0.12, 0.35, along ? 0.12 : 0.5), tx + (along ? 0 : o), 0.17, tz + (along ? o : 0)));
    const dome = xf(cyl(0.16, 0.16, 0.18, 10), tx, 1.2, tz);
    addPart(g, 'propane_tank', [tank, ...legs, dome], M.paint('#d6d4cc', 0.55));
  }
  if (rng() < 0.6) {
    const sx = rng() < 0.5 ? -1 : 1, az = rand(rng, -D / 2 + 1, D / 2 - 1);
    addPart(g, 'ac_unit', [xf(box(0.75, 0.75, 0.75), sx * (W / 2 + 0.6), 0.47, az), xf(box(0.85, 0.1, 0.85), sx * (W / 2 + 0.6), 0.05, az)], M.galv('#8f9290'));
  }
  return finish(g, minX, maxX, minZ, maxZ);
}
