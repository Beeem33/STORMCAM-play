import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M, std } from './materials';
import { memo } from './textures';
import type { InstancedAsset } from './types';
import { box, cyl, fbm3, merge, mulberry32, xf } from './util';

/**
 * ~10.7 m wooden distribution pole. Crossarm spans local X (wires run along local Z).
 * wireAttach: tops of the 3 insulators (two crossarm ends + pole-top pin).
 */
export function telephonePoleAsset(): InstancedAsset & { wireAttach: THREE.Vector3[] } {
  return memo('asset:pole', () => {
    const H = 10.7, armY = H - 0.55;
    const wood = [
      xf(cyl(0.11, 0.155, H + 0.3, 8, false), 0, -0.3, 0),
      xf(box(2.44, 0.1, 0.09), 0, armY, 0.14),
    ];
    const hw = [
      xf(box(0.9, 0.04, 0.01), -0.42, armY - 0.35, 0.1, 0, 0, 0.72),
      xf(box(0.9, 0.04, 0.01), 0.42, armY - 0.35, 0.1, 0, 0, -0.72),
      xf(box(0.02, H - 0.4, 0.02), 0, (H - 0.4) / 2, -0.13),
    ];
    const ins: THREE.BufferGeometry[] = [];
    const pts = [new THREE.Vector3(-1.08, armY + 0.05, 0.14), new THREE.Vector3(1.08, armY + 0.05, 0.14), new THREE.Vector3(0, H + 0.02, 0.16)];
    const prof = [new THREE.Vector2(0.001, 0), new THREE.Vector2(0.056, 0.045), new THREE.Vector2(0.036, 0.11), new THREE.Vector2(0.001, 0.17)];
    for (const p of pts) {
      hw.push(xf(cyl(0.012, 0.012, 0.12, 5, true), p.x, p.y - 0.1, p.z));
      ins.push(xf(new THREE.LatheGeometry(prof, 6), p.x, p.y, p.z));
    }
    hw.push(xf(box(0.06, 0.25, 0.08), 0, H - 0.1, 0.12));
    const wireAttach = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.11, p.z));
    return {
      parts: [
        { geometry: merge(wood), material: M.wood('#6e5f4d') },
        { geometry: merge(hw), material: M.galv('#7f8383') },
        { geometry: merge(ins), material: std('insulator', () => ({ color: '#7f9a92', roughness: 0.18, metalness: 0 })) },
      ],
      height: H + 0.2,
      radius: 1.25,
      wireAttach,
    };
  });
}

/** Weathered wooden fence post, 1.3 m above ground (0.15 m buried), irregular. <= 60 tris. */
export function fencePostAsset(): InstancedAsset {
  return memo('asset:post', () => {
    const g = new THREE.CylinderGeometry(0.052, 0.064, 1.45, 7, 2, false);
    g.translate(0, 1.45 / 2 - 0.15, 0);
    const p = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.18 * (fbm3(Math.cos(a) * 2, y * 1.5, Math.sin(a) * 2, 2, 5) - 0.5) * 2;
      let ny = y;
      if (y > 1.25) ny = 1.3 + x * 0.35 + 0.01 * Math.sin(a * 3);
      p.setXYZ(i, x * k + y * 0.012, ny, z * k + y * 0.006);
      uv.setXY(i, uv.getX(i) * 0.36, uv.getY(i) * 1.45);
    }
    g.computeVertexNormals();
    return { parts: [{ geometry: g, material: M.wood('#8d877c') }], height: 1.32, radius: 0.08 };
  });
}

/** Round bale 1.7 m dia x 1.5 m wide, lying on its side, axis along X; one atlas material. */
export function hayBaleAsset(): InstancedAsset {
  return memo('asset:bale', () => {
    const R = 0.86, segs = 20;
    const sideProf = [new THREE.Vector2(0.76, -0.71), new THREE.Vector2(0.845, -0.6), new THREE.Vector2(0.86, 0), new THREE.Vector2(0.845, 0.6), new THREE.Vector2(0.76, 0.71)];
    const side = new THREE.LatheGeometry(sideProf, segs);
    {
      const uv = side.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5, uv.getY(i));
    }
    const ends: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const prof = s > 0
        ? [new THREE.Vector2(0.76, 0.71), new THREE.Vector2(0.45, 0.755), new THREE.Vector2(0.001, 0.77)]
        : [new THREE.Vector2(0.001, -0.77), new THREE.Vector2(0.45, -0.755), new THREE.Vector2(0.76, -0.71)];
      const e = new THREE.LatheGeometry(prof, segs);
      const p = e.getAttribute('position'), uv = e.getAttribute('uv');
      for (let i = 0; i < p.count; i++) uv.setXY(i, 0.75 + (p.getX(i) / R) * 0.25 * s, 0.5 + (p.getZ(i) / R) * 0.5);
      ends.push(e);
    }
    const g = merge([side, ...ends]);
    // lathe axis Y -> X, then sag the bottom and add straw lumps
    g.rotateZ(-Math.PI / 2);
    const p = g.getAttribute('position');
    const rnd = mulberry32(3);
    void rnd;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const lump = 1 + 0.035 * (fbm3(x * 2 + 5, y * 2, z * 2, 2, 9) - 0.5) * 2;
      let ny = y * lump, nz = z * lump;
      if (ny < -0.78) ny = -0.78 + (ny + 0.78) * 0.25;
      p.setXYZ(i, x, ny + 0.795, nz);
    }
    g.computeVertexNormals();
    const ig = g.index ? g : mergeVertices(g);
    return { parts: [{ geometry: ig, material: M.bale() }], height: 1.72, radius: 1.15 };
  });
}
