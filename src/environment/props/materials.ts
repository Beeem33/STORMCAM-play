import * as THREE from 'three';
import * as T from './textures';
import { memo } from './textures';

type P = THREE.MeshStandardMaterialParameters;

/** Cached MeshStandardMaterial (params evaluated once per key). */
export function std(key: string, make: () => P): THREE.MeshStandardMaterial {
  return memo('m:' + key, () => {
    const m = new THREE.MeshStandardMaterial(make());
    m.name = 'prop:' + key;
    return m;
  });
}
function ts(s: T.TexSet, p: P): P {
  return { map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, roughness: 1, metalness: 0, ...p };
}

/** All prop materials. Keys include colour so 30 farmhouses share a handful of materials. */
export const M = {
  siding: (c: string) => std('siding:' + c, () => ts(T.sidingTex(), { color: c })),
  shingles: (c: string) => std('shingle:' + c, () => ts(T.shingleTex(), { color: c })),
  trim: (c = '#dedbd2') => std('trim:' + c, () => ts(T.paintTex(), { color: c })),
  paint: (c: string, rough = 1) => std('paint:' + c + ':' + rough, () => ts(T.paintTex(), { color: c, roughness: rough })),
  windows: () => std('windows', () => { const t = T.windowAtlas(); return { map: t.map, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0 }; }),
  doors: () => std('doors', () => { const t = T.doorAtlas(); return { map: t.map, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0 }; }),
  concrete: (c = '#b9b6ae') => std('concrete:' + c, () => ts(T.concreteTex(), { color: c })),
  brick: () => std('brick', () => ts(T.brickTex(), {})),
  lattice: () => std('lattice', () => ts(T.latticeTex(), {})),
  wood: (c: string) => std('wood:' + c, () => ts(T.woodTex(), { color: c })),
  boards: (k: 'red' | 'grey') => std('boards:' + k, () => ts(T.boardsTex(k), {})),
  rib: (k: 'plain' | 'rust', c = '#ffffff') => std('rib:' + k + ':' + c, () => ts(T.ribTex(k), { color: c, metalness: 0.05 })),
  bin: (c = '#ffffff') => std('bin:' + c, () => ts(T.binTex(), { color: c, metalness: 0.05 })),
  binRoof: (c = '#ffffff') => std('binroof:' + c, () => ts(T.binRoofTex(), { color: c, metalness: 0.05 })),
  staves: (doubleSide = false) => std('stave:' + doubleSide, () => ts(T.staveTex(), { side: doubleSide ? THREE.DoubleSide : THREE.FrontSide })),
  cmu: () => std('cmu', () => ts(T.cmuTex(), {})),
  galv: (c = '#a9adae') => std('galv:' + c, () => ts(T.paintTex(), { color: c, metalness: 0.1, roughness: 0.7 })),
  darkMetal: () => std('darkmetal', () => ({ color: '#2e2d2a', roughness: 0.6, metalness: 0.3 })),
  glass: () => std('glass', () => ({ color: '#1d2124', roughness: 0.08, metalness: 0 })),
  rubber: () => std('rubber', () => ({ color: '#1c1c1b', roughness: 0.9 })),
  bark: () => std('bark', () => ts(T.barkTex(), { vertexColors: true })),
  foliage: () => std('foliage', () => ts(T.foliageTex(), { vertexColors: true, roughness: 0.92 })),
  bale: () => std('bale', () => ts(T.baleTex(), {})),
  emissive: (c: string, intensity: number) => std('emit:' + c + ':' + intensity, () => ({ color: '#f2f0ea', emissive: c, emissiveIntensity: intensity, roughness: 0.4 })),
};
