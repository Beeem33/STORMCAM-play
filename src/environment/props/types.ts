import type * as THREE from 'three';

export type Collider = { type: 'box'; hx: number; hz: number } | { type: 'circle'; r: number };

export interface PropBuild {
  group: THREE.Group;
  collider: Collider;
}

export interface InstancedAsset {
  /** one merged geometry per material, origin at ground */
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  height: number;
  radius: number;
}

export type TreeKind = 'cottonwood' | 'elm' | 'cedar' | 'osage' | 'shrub';
export type RoadSignKind = 'stop' | 'speed55' | 'crossroad' | 'countyRoad' | 'noOutlet';
