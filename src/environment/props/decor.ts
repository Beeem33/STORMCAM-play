import * as THREE from 'three';
import { hayBaleAsset } from './instanced';
import { M, std } from './materials';
import { binTex, memo, rustyPaintTex } from './textures';
import type { PropBuild } from './types';
import { V, addPart, box, cyl, finish, part, pick, prism, rand, randInt, rod, strut, xf } from './util';
import type { RNG } from './util';

const rustyPaint = (hex: string, amt = 0.5) => std('rustypaint:' + hex + ':' + amt, () => {
  const t = rustyPaintTex(hex, amt);
  return { map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0 };
});
const tankMat = () => std('stocktank', () => {
  const t = binTex();
  return { map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0.05, side: THREE.DoubleSide };
});
const waterMat = () => std('tankwater', () => ({ color: '#2b3127', roughness: 0.12, metalness: 0 }));

/** Adds a round galvanized stock tank (wall, rim, water) centred at (x,z). */
function addStockTank(g: THREE.Group, x: number, z: number, r: number, prefix = 'tank'): void {
  const h = 0.62, segs = 30;
  const wall = new THREE.CylinderGeometry(r, r, h, segs, 1, true);
  wall.translate(x, h / 2, z);
  const uv = wall.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * h);
  g.add(part(prefix + '_wall', wall, tankMat()));
  addPart(g, prefix + '_rim', [xf(cyl(r + 0.025, r + 0.025, 0.05, segs, true), x, h - 0.03, z)], M.galv('#9fa3a3'));
  const w = new THREE.CircleGeometry(r - 0.01, segs);
  w.rotateX(-Math.PI / 2);
  g.add(part(prefix + '_water', xf(w, x, h - 0.12, z), waterMat(), false));
}

// ============================================================ STOCK TANK

export function buildStockTank(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'stock_tank';
  const r = rand(rng, 1.2, 1.55);
  addStockTank(g, 0, 0, r);
  if (rng() < 0.5) addPart(g, 'float_valve', [xf(box(0.3, 0.25, 0.3), r - 0.2, 0.62, 0), xf(rod(V(r - 0.2, 0.0, 0), V(r - 0.2, 0.62, 0), 0.025, 6), 0, 0, 0)], M.galv('#7d8282'));
  g.userData.breakable = true;
  return { group: g, collider: { type: 'circle', r: r + 0.05 } };
}

// ============================================================ WINDMILL

/** Aermotor-style windmill. Child 'Head' yaws about Y; its child 'Rotor' spins about local Z (= axle, faces +Z). */
export function buildWindmill(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'windmill';
  const H = rand(rng, 10, 12), b0 = rand(rng, 1.05, 1.3), bt = 0.22;
  const mTower = M.galv('#9a9e9f');
  const corner = (y: number, i: number) => {
    const h = b0 + (bt - b0) * (y / H);
    return V((i === 0 || i === 3 ? -1 : 1) * h, y, (i < 2 ? -1 : 1) * h);
  };
  const legs: THREE.BufferGeometry[] = [], braces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) legs.push(strut(corner(-0.2, i), corner(H, i), 0.075));
  const levels = 6, ys = Array.from({ length: levels + 1 }, (_, k) => 0.3 + (H - 0.5) * Math.pow(k / levels, 0.92));
  for (let k = 0; k <= levels; k++)
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      braces.push(strut(corner(ys[k]!, i), corner(ys[k]!, j), 0.045));
      if (k < levels) {
        braces.push(strut(corner(ys[k]!, i), corner(ys[k + 1]!, j), 0.022));
        braces.push(strut(corner(ys[k]!, j), corner(ys[k + 1]!, i), 0.022));
      }
    }
  addPart(g, 'tower_legs', legs, mTower);
  addPart(g, 'tower_braces', braces, mTower);
  addPart(g, 'footings', [0, 1, 2, 3].map((i) => { const c = corner(0, i); return xf(cyl(0.22, 0.25, 0.3, 8), c.x, -0.1, c.z); }), M.concrete());
  const py = H - 0.9, po = 0.85, pi = 0.3, pw = po - pi;
  addPart(g, 'platform', [
    xf(box(po * 2, 0.05, pw), 0, py, (po + pi) / 2), xf(box(po * 2, 0.05, pw), 0, py, -(po + pi) / 2),
    xf(box(pw, 0.05, pi * 2), (po + pi) / 2, py, 0), xf(box(pw, 0.05, pi * 2), -(po + pi) / 2, py, 0),
  ], M.wood('#8a8476'));
  // pump rod + pump at the base + pipe to the stock tank
  const tankR = rand(rng, 1.2, 1.5), tx = b0 + tankR + 0.9, tz = rand(rng, -0.5, 0.8);
  addPart(g, 'pump', [
    rod(V(0, 0.9, 0), V(0, H + 0.9, 0), 0.02, 5),
    xf(cyl(0.1, 0.1, 1.0, 10), 0, 0, 0),
    rod(V(0, 0.75, 0), V(tx - tankR + 0.1, 0.75, tz), 0.04, 6),
    xf(box(0.12, 0.12, 0.3), 0, 0.85, 0.15),
  ], M.galv('#7b7f80'));
  addStockTank(g, tx, tz, tankR);

  // head assembly (yaws about Y)
  const head = new THREE.Group();
  head.name = 'Head';
  head.position.set(0, H, 0);
  head.rotation.y = rand(rng, -0.6, 0.6);
  addPart(head as unknown as THREE.Group, 'mast', [xf(cyl(0.07, 0.08, 1.0, 8), 0, 0, 0), xf(cyl(0.16, 0.16, 0.12, 10), 0, 0.85, 0)], M.galv('#8e9293'));
  const vaneC = pick(rng, ['#8e9293', '#8e9293', '#7a3a2e', '#c9c6bb']);
  addPart(head as unknown as THREE.Group, 'gearbox', [xf(box(0.4, 0.42, 0.72), 0, 1.15, 0.12), xf(box(0.28, 0.12, 0.5), 0, 1.42, 0.05)], rustyPaint('#7c8183', 0.4));
  addPart(head as unknown as THREE.Group, 'tail_boom', [strut(V(0, 1.2, -0.2), V(0, 1.5, -2.6), 0.05), strut(V(0, 1.0, -0.2), V(0, 1.25, -2.3), 0.035)], M.galv('#8e9293'));
  addPart(head as unknown as THREE.Group, 'tail_vane', [xf(box(0.02, 0.95, 1.55), 0, 1.6, -2.95)], rustyPaint(vaneC, 0.45));
  const rotor = new THREE.Group();
  rotor.name = 'Rotor';
  rotor.position.set(0, 1.25, 0.62);
  const blades: THREE.BufferGeometry[] = [];
  const nb = 18;
  for (let k = 0; k < nb; k++) {
    const b = box(0.21, 0.85, 0.012);
    b.rotateY(0.55);
    b.translate(0, 0.77, 0);
    b.rotateZ((k / nb) * Math.PI * 2);
    blades.push(b);
  }
  const frame: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.36, 0.014, 3, 24), new THREE.TorusGeometry(0.78, 0.012, 3, 30), new THREE.TorusGeometry(1.19, 0.014, 3, 36)];
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; frame.push(strut(V(0, 0, -0.05), V(Math.cos(a) * 1.19, Math.sin(a) * 1.19, 0), 0.025)); }
  frame.push(xf(cyl(0.12, 0.12, 0.26, 10), 0, 0, -0.13, 0, Math.PI / 2));
  addPart(rotor as unknown as THREE.Group, 'blades', blades, M.galv('#a2a6a7'));
  addPart(rotor as unknown as THREE.Group, 'wheel_frame', frame, M.galv('#868a8b'));
  head.add(rotor);
  g.add(head);
  g.userData.breakable = true;
  return finish(g, -b0 - 0.25, tx + tankR + 0.05, -Math.max(b0, tankR - tz) - 0.25, Math.max(b0, tz + tankR) + 0.25);
}

// ============================================================ PUMPJACK

interface PumpjackData { R: number; Lp: number; eY: number; eZ: number; rc: number; rodY: number }

/** Poses a pumpjack for crank angle phi (radians): rotates Crank, solves Beam, aims Pitman, slides PolishedRod. */
export function posePumpjack(group: THREE.Object3D, phi: number): void {
  const d = group.userData.pumpjack as PumpjackData | undefined;
  const beam = group.getObjectByName('Beam'), crank = group.getObjectByName('Crank');
  const pit = group.getObjectByName('Pitman'), rodN = group.getObjectByName('PolishedRod');
  if (!d || !beam || !crank || !pit || !rodN) return;
  crank.rotation.x = phi;
  const py = crank.position.y - d.rc * Math.sin(phi), pz = crank.position.z + d.rc * Math.cos(phi);
  const E = (t: number): [number, number] => [
    beam.position.y + d.eY * Math.cos(t) - d.eZ * Math.sin(t),
    beam.position.z + d.eY * Math.sin(t) + d.eZ * Math.cos(t),
  ];
  let lo = -0.7, hi = 0.7;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2, [ey, ez] = E(mid);
    if (Math.hypot(ey - py, ez - pz) > d.Lp) hi = mid; else lo = mid;
  }
  const th = (lo + hi) / 2;
  beam.rotation.x = th;
  const [ey, ez] = E(th);
  pit.position.set(pit.position.x, ey, ez);
  pit.rotation.x = Math.atan2(-(pz - ez), -(py - ey));
  rodN.position.y = d.rodY - d.R * th;
}

/** Oil pumpjack, horsehead/wellhead toward +Z. Animate with posePumpjack(group, crankAngle). */
export function buildPumpjack(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'pumpjack';
  const Hp = rand(rng, 4.0, 4.8), R = rand(rng, 2.8, 3.3), Ab = rand(rng, 2.2, 2.6), rc = 0.75, yc = 1.45;
  const col = pick(rng, ['#4b4d48', '#5a6670', '#6a6750', '#7a3d30', '#55524a']);
  const mPaint = rustyPaint(col, 0.55), mHead = rustyPaint(pick(rng, ['#3a3a37', col]), 0.5), mRust = rustyPaint('#5f4b3a', 0.9);
  const mSteel = M.galv('#7d8182');
  const z0 = -Ab - 2.0, z1 = R - 0.7;
  addPart(g, 'skid', [xf(box(1.7, 0.32, z1 - z0), 0, 0.16, (z0 + z1) / 2), xf(box(2.1, 0.12, z1 - z0 + 0.4), 0, 0.04, (z0 + z1) / 2)], M.concrete('#a8a59d'));
  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    legs.push(strut(V(sx * 0.7, 0.32, -0.75), V(sx * 0.2, Hp - 0.3, 0), 0.16, 0.12));
    legs.push(strut(V(sx * 0.7, 0.32, 0.85), V(sx * 0.2, Hp - 0.3, 0), 0.16, 0.12));
    legs.push(strut(V(sx * 0.62, 1.6, -0.48), V(sx * 0.62, 1.6, 0.56), 0.08));
  }
  legs.push(xf(box(0.55, 0.3, 0.45), 0, Hp - 0.2, 0));
  addPart(g, 'samson_post', legs, mPaint);
  // gearbox, motor, belt guard (static)
  addPart(g, 'gearbox', [xf(box(1.0, 1.0, 1.2), 0, yc - 0.15, -Ab), xf(box(0.8, yc - 0.95, 1.0), 0, 0.32 + (yc - 0.97) / 2, -Ab)], mPaint);
  addPart(g, 'motor', [xf(cyl(0.3, 0.3, 0.7, 12), 0, 0.85, -Ab - 1.6, 0, 0, Math.PI / 2), xf(box(0.7, 0.3, 0.7), 0, 0.55, -Ab - 1.6)], rustyPaint('#4c5a52', 0.4));
  addPart(g, 'belt_guard', [xf(box(0.12, 0.9, 1.9), 0.62, 1.05, -Ab - 0.85, 0, -0.25)], mPaint);
  // wellhead + flowline
  addPart(g, 'wellhead', [
    xf(box(1.2, 0.2, 1.2), 0, 0.1, R), xf(cyl(0.13, 0.13, 0.75, 10), 0, 0.2, R), xf(cyl(0.09, 0.09, 0.35, 8), 0, 0.95, R),
    rod(V(0, 0.55, R), V(-1.2, 0.55, R), 0.05, 6), rod(V(-1.2, 0.55, R), V(-1.2, 0.08, R), 0.05, 6), rod(V(-1.2, 0.08, R), V(-6, 0.08, R + 1.5), 0.05, 6),
  ], mSteel);

  // walking beam (pivots about local X at the Samson post top)
  const beam = new THREE.Group();
  beam.name = 'Beam';
  beam.position.set(0, Hp, 0);
  const bg = beam as unknown as THREE.Group;
  addPart(bg, 'walking_beam', [xf(box(0.3, 0.5, Ab + R - 0.2), 0, 0.15, (R - 0.5 - Ab) / 2 + 0.05), xf(box(1.35, 0.22, 0.28), 0, -0.14, -Ab), xf(box(0.5, 0.15, 0.6), 0, -0.05, 0)], mPaint);
  const arc: [number, number][] = [];
  for (let i = 0; i <= 7; i++) { const a = 0.22 - (i / 7) * 0.95; arc.push([R * Math.cos(a), R * Math.sin(a)]); }
  const headPts: [number, number][] = [...arc, [R - 1.05, R * Math.sin(-0.73) + 0.15], [R - 1.2, 0.35]];
  const hh = prism(headPts, 0.46);
  hh.rotateY(-Math.PI / 2);
  addPart(bg, 'horsehead', [hh], mHead);
  g.add(beam);

  // crank + counterweights (rotate about local X)
  const crank = new THREE.Group();
  crank.name = 'Crank';
  crank.position.set(0, yc, -Ab);
  const cg = crank as unknown as THREE.Group;
  const arms: THREE.BufferGeometry[] = [xf(cyl(0.1, 0.1, 1.5, 10), -0.75, 0, 0, 0, 0, -Math.PI / 2)];
  const cw: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    arms.push(xf(box(0.12, 0.3, rc + 1.25), sx * 0.64, 0, (rc - 1.25) / 2));
    arms.push(xf(cyl(0.07, 0.07, 0.22, 8), sx * 0.64 - 0.11 * sx, 0, rc, 0, 0, Math.PI / 2));
    const wedge = prism([[-0.55, -0.15], [0.55, -0.15], [0.35, 0.55], [-0.35, 0.55]], 0.22);
    wedge.rotateY(Math.PI / 2);
    wedge.rotateX(Math.PI / 2);
    cw.push(xf(wedge, sx * 0.79, 0, -1.05));
  }
  addPart(cg, 'crank_arms', arms, mPaint);
  addPart(cg, 'counterweights', cw, mRust);
  g.add(crank);

  // pitman arms (aimed each frame by posePumpjack)
  const pit = new THREE.Group();
  pit.name = 'Pitman';
  const Lp = Hp - 0.25 - yc;
  addPart(pit as unknown as THREE.Group, 'pitman_arms', [-1, 1].map((sx) => strut(V(sx * 0.64, 0, 0), V(sx * 0.64, -Lp, 0), 0.1, 0.14)), mPaint);
  pit.position.set(0, Hp - 0.25, -Ab);
  g.add(pit);

  // polished rod + bridle (slides vertically)
  const rodG = new THREE.Group();
  rodG.name = 'PolishedRod';
  addPart(rodG as unknown as THREE.Group, 'polished_rod', [
    rod(V(0.07, Hp - 1.7, R), V(0.07, Hp + 0.05, R), 0.012, 4), rod(V(-0.07, Hp - 1.7, R), V(-0.07, Hp + 0.05, R), 0.012, 4),
    xf(box(0.4, 0.1, 0.12), 0, Hp - 1.75, R), rod(V(0, 0.75, R), V(0, Hp - 1.7, R), 0.022, 6),
  ], mSteel);
  g.add(rodG);

  g.userData.pumpjack = { R, Lp, eY: -0.25, eZ: -Ab, rc, rodY: 0 } satisfies PumpjackData;
  g.userData.breakable = true;
  const pb = finish(g, -0.9, 0.9, z0 - 0.2, R + 0.7);
  posePumpjack(g, rand(rng, 0, Math.PI * 2));
  return pb;
}

// ============================================================ CENTER PIVOT

/** Center-pivot irrigation system: pivot at origin, spans (~55 m) extend along +X. */
export function buildCenterPivot(rng: RNG, spans = 4): PropBuild {
  const g = new THREE.Group();
  g.name = 'center_pivot';
  const SL = 55, pipeH = 3.9, arch = 0.8, mG = M.galv('#a9adae'), mHose = M.rubber();
  const mBox = rustyPaint(pick(rng, ['#8f8a6a', '#6f7a5d', '#9a9c98']), 0.35);
  // pivot tower
  const pv: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pv.push(strut(V(sx * 1.6, 0.3, sz * 1.6), V(sx * 0.22, pipeH + 0.5, sz * 0.22), 0.08));
  for (const y of [1.4, 2.8]) { const h = 1.6 - (1.38 * (y - 0.3)) / (pipeH + 0.2); for (let i = 0; i < 4; i++) { const a = [[-1, -1], [1, -1], [1, 1], [-1, 1]][i]!, b = [[-1, -1], [1, -1], [1, 1], [-1, 1]][(i + 1) % 4]!; pv.push(strut(V(a[0]! * h, y, a[1]! * h), V(b[0]! * h, y, b[1]! * h), 0.05)); } }
  pv.push(rod(V(0, 0.3, 0), V(0, pipeH + 1.1, 0), 0.11, 10), rod(V(0, pipeH + 0.9, 0), V(0.5, pipeH, 0), pipeH > 0 ? 0.09 : 0.09, 8), xf(box(0.5, 0.4, 0.5), 0, pipeH + 1.2, 0));
  addPart(g, 'pivot_tower', pv, mG);
  addPart(g, 'pivot_pad', [xf(box(4.0, 0.3, 4.0), 0, 0.0, 0)], M.concrete());
  addPart(g, 'pivot_panel', [xf(box(0.6, 0.9, 0.32), 1.0, 1.6, 1.0, Math.PI / 4)], mBox);
  const colliders: { type: string; x: number; z: number; r: number }[] = [];
  const yAt = (t: number) => pipeH + arch * Math.sin(Math.PI * t);
  for (let s = 0; s < spans; s++) {
    const x0 = 0.5 + s * SL, x1 = x0 + SL;
    const truss: THREE.BufferGeometry[] = [], drops: THREE.BufferGeometry[] = [], wheels: THREE.BufferGeometry[] = [], tower: THREE.BufferGeometry[] = [];
    const n = 10;
    const P = (k: number) => V(x0 + (SL * k) / n, yAt(k / n), 0);
    const Bc = (k: number, sz: number) => { const t = k / n; return V(x0 + SL * t, pipeH + (arch - 2.3) * Math.sin(Math.PI * t), sz * 0.8 * Math.sin(Math.PI * t) + sz * 0.05); };
    for (let k = 0; k < n; k++) {
      truss.push(rod(P(k), P(k + 1), 0.085, 8));
      for (const sz of [-1, 1]) {
        truss.push(strut(Bc(k, sz), Bc(k + 1, sz), 0.03));
        if (k > 0) { truss.push(strut(P(k), Bc(k, sz), 0.035)); truss.push(strut(P(k), Bc(k + 1, sz), 0.022)); }
      }
      if (k > 0) truss.push(strut(Bc(k, -1), Bc(k, 1), 0.03));
    }
    for (let k = 1; k < 22; k++) {
      const t = k / 22, x = x0 + SL * t, y = yAt(t);
      drops.push(strut(V(x, y - 0.08, 0), V(x, 1.35, 0), 0.025));
      drops.push(xf(box(0.09, 0.12, 0.09), x, 1.3, 0));
    }
    // A-frame drive tower at x1
    for (const sz of [-1, 1]) {
      tower.push(strut(V(x1, pipeH - 0.05, 0), V(x1, 0.72, sz * 1.75), 0.09));
      tower.push(strut(V(x1, 2.0, sz * 0.9), V(x1 - 0.9, 0.72, sz * 1.3), 0.05));
    }
    tower.push(strut(V(x1, 0.7, -2.0), V(x1, 0.7, 2.0), 0.14), xf(box(0.35, 0.3, 0.3), x1, pipeH - 0.05, 0));
    tower.push(rod(V(x1, 0.72, -0.1), V(x1, 0.72, -1.8), 0.03, 6), rod(V(x1, 0.72, 0.1), V(x1, 0.72, 1.8), 0.03, 6));
    for (const sz of [-1, 1]) {
      wheels.push(xf(cyl(0.62, 0.62, 0.42, 14), x1 - 0.21, 0.62, sz * 2.0, 0, 0, -Math.PI / 2));
      tower.push(xf(cyl(0.34, 0.34, 0.44, 10), x1 - 0.22, 0.62, sz * 2.0, 0, 0, -Math.PI / 2));
    }
    addPart(g, 'span_' + s, truss, mG);
    addPart(g, 'tower_' + s, tower, mG);
    addPart(g, 'wheels_' + s, wheels, M.rubber());
    addPart(g, 'drops_' + s, drops, mHose);
    addPart(g, 'tower_box_' + s, [xf(box(0.45, 0.45, 0.3), x1, 0.72 + 0.35, 0), xf(box(0.3, 0.55, 0.22), x1 + 0.1, 2.2, 0.25)], mBox);
    colliders.push({ type: 'circle', x: x1, z: 0, r: 2.3 });
  }
  // overhang + end gun
  const xe = 0.5 + spans * SL, ov = rand(rng, 12, 18);
  addPart(g, 'overhang', [
    rod(V(xe, pipeH, 0), V(xe + ov, pipeH - 0.3, 0), 0.07, 8), rod(V(xe, pipeH, 0), V(xe, pipeH + 2.0, 0), 0.05, 6),
    strut(V(xe, pipeH + 2.0, 0), V(xe + ov, pipeH - 0.25, 0), 0.015), strut(V(xe, pipeH + 2.0, 0), V(xe + ov * 0.5, pipeH - 0.1, 0), 0.015),
    rod(V(xe + ov, pipeH - 0.3, 0), V(xe + ov + 0.6, pipeH + 0.1, 0), 0.05, 6),
  ], mG);
  void randInt;
  g.userData.breakable = true;
  g.userData.colliders = colliders;
  g.userData.length = xe + ov + 0.6;
  return { group: g, collider: { type: 'circle', r: 2.2 } };
}

// ============================================================ HAY STACK

/** Pyramid stack of 6-12 round bales (axes along Z), each bale a separate mesh. */
export function buildHayStack(rng: RNG): PropBuild {
  const g = new THREE.Group();
  g.name = 'hay_stack';
  const geo = memo('geo:bale_centered', () => {
    const b = hayBaleAsset().parts[0]!.geometry.clone();
    b.translate(0, -0.86, 0);
    b.rotateY(Math.PI / 2);
    b.computeBoundingSphere();
    return b;
  });
  const mat = M.bale();
  const n = randInt(rng, 6, 12), rows = n >= 9 ? 2 : 1, per = Math.ceil(n / rows);
  const bottom = Math.ceil((per + 1) / 2);
  let placed = 0, maxX = 0;
  for (let r = 0; r < rows; r++) {
    const z = (r - (rows - 1) / 2) * 1.56;
    const cnt = Math.min(per, n - placed);
    const b0 = Math.min(bottom, cnt), top = cnt - b0;
    const xs: [number, number][] = [];
    for (let i = 0; i < b0; i++) xs.push([(i - (b0 - 1) / 2) * 1.72, 0.84]);
    for (let i = 0; i < top; i++) xs.push([(i - (top - 1) / 2) * 1.72, 0.84 + 1.46]);
    for (const [x, y] of xs) {
      const m = new THREE.Mesh(geo, mat);
      m.name = 'bale_' + placed++;
      m.position.set(x + rand(rng, -0.06, 0.06), y, z + rand(rng, -0.08, 0.08));
      m.rotation.set(0, rand(rng, -0.05, 0.05), rand(rng, 0, Math.PI * 2));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      maxX = Math.max(maxX, Math.abs(x) + 0.86);
    }
  }
  g.userData.breakable = true;
  return { group: g, collider: { type: 'box', hx: maxX, hz: (rows * 1.56) / 2 } };
}
