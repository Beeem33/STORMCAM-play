import * as THREE from 'three';
import { WORLD_GLSL } from './WorldShape';
import { atmo, patchMaterial } from '../rendering/Atmosphere';

/**
 * Real grass around the camera, out to ~0.1 mile: single-triangle blades in
 * three tiles that wrap around the viewer — dense underfoot, medium out to
 * ~30 m, and a sparse ring of bigger clumps out to ~160 m — so the near
 * ground has depth and the far fields still shimmer, at a fixed cost. Each blade looks up the ground height and field type on the GPU
 * (the same world-shape functions the terrain uses): tall golden-green wheat,
 * short pasture, tall mixed prairie, sparse young row crops, nothing on
 * plowed ground or the roads. Blades bend and pump with the wind.
 */

const COUNT_NEAR = 35000;
const COUNT_MID = 35000;
const COUNT_FAR = 45000;
const COUNT = COUNT_NEAR + COUNT_MID + COUNT_FAR;
const TILE = 64;
const TILE_NEAR = 16;
/** The far ring: blades out to ~160 m (0.1 mile), fading in past the mid tile. */
const TILE_FAR = 330;

export class Grass {
  readonly mesh: THREE.Mesh;
  private readonly uCam = { value: new THREE.Vector3() };
  /** World → vehicle local, to flatten the grass under the truck. */
  private readonly uCarInv = { value: new THREE.Matrix4() };
  /** Grass pressed flat by the chaser lying in it: centre x, z, radius, amount 0..1. */
  private readonly uFlat = { value: new THREE.Vector4(0, 0, 1, 0) };

  constructor() {
    const pos = new Float32Array(COUNT * 9);
    const blade = new Float32Array(COUNT * 12);
    const col = new Float32Array(COUNT * 9);
    for (let i = 0; i < COUNT; i++) {
      // Near tile (dense underfoot), mid tile, far ring. The tile is packed into r:
      // negative = near, 0..1 = mid, 2..3 = far.
      const near = i < COUNT_NEAR;
      const far = i >= COUNT_NEAR + COUNT_MID;
      const tile = near ? TILE_NEAR : far ? TILE_FAR : TILE;
      const x = Math.random() * tile, z = Math.random() * tile, yaw = Math.random() * Math.PI * 2;
      const r = (0.001 + Math.random() * 0.998) * (near ? -1 : 1) + (far ? 2 : 0);
      // Triangle: two base corners and the tip; x = across (-0.5..0.5), y = up (0..1).
      const rr = far ? r - 2 : r;
      pos.set([-0.5, 0, 0, 0.5, 0, 0, 0.1 * (rr - 0.5), 1, 0], i * 9);
      for (let k = 0; k < 3; k++) blade.set([x, z, r, yaw], i * 12 + k * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBlade', new THREE.BufferAttribute(blade, 4));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
    patchMaterial(mat);
    const prev = mat.onBeforeCompile.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.uniforms.uGrassCam = this.uCam;
      shader.uniforms.uGrassCarInv = this.uCarInv;
      shader.uniforms.uGrassFlat = this.uFlat;
      shader.uniforms.uGrassWind = atmo.uWind;
      shader.uniforms.uGrassTime = atmo.uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aBlade;
uniform vec3 uGrassCam;
uniform mat4 uGrassCarInv;
uniform vec4 uGrassFlat;
uniform vec2 uGrassWind;
uniform float uGrassTime;
${WORLD_GLSL}
vec3 gGrassPos;
vec3 gGrassCol;
vec3 gGrassN;
float gGrassH;`,
        )
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
{
  bool nearTile = aBlade.z < 0.0;
  bool farTile = aBlade.z > 1.5;
  float T = nearTile ? ${TILE_NEAR.toFixed(1)} : farTile ? ${TILE_FAR.toFixed(1)} : ${TILE.toFixed(1)};
  vec2 wp = uGrassCam.xz + mod(aBlade.xy - uGrassCam.xz + 0.5 * T, T) - 0.5 * T;
  float r = farTile ? aBlade.z - 2.0 : abs(aBlade.z);
  float dist = length(wp - uGrassCam.xz);
  // The near tile fades out at its edge; the mid one fades with distance as the far ring takes over,
  // and the far ring ends at ~0.1 mile.
  float keep = nearTile ? 1.0 - smoothstep(5.5, 7.8, max(abs(wp.x - uGrassCam.x), abs(wp.y - uGrassCam.z)))
    : farTile ? smoothstep(22.0, 30.0, dist) * (1.0 - smoothstep(125.0, 161.0, dist))
    : 1.0 - smoothstep(20.0, 30.0, dist);
  // Field type and roads decide what grows here.
  int ft = w_fieldType(wp);
  vec4 rd = w_roads(wp);
  float roadClear = min(abs(rd.y) - w_roadHalf(rd.x), abs(rd.w) - w_roadHalf(rd.z));
  float H; vec3 c;
  float hue = fract(r * 7.13);
  if (ft == 0) { H = 0.75; c = mix(vec3(0.30, 0.31, 0.12), vec3(0.44, 0.38, 0.17), hue); }        // wheat
  else if (ft == 1) { H = 0.28; c = mix(vec3(0.17, 0.26, 0.08), vec3(0.26, 0.31, 0.12), hue); }   // pasture
  else if (ft == 2) { H = 0.34; c = mix(vec3(0.15, 0.25, 0.07), vec3(0.24, 0.3, 0.11), hue); }    // fallow: grass
  else if (ft == 3) { H = 0.26 + 0.14 * step(0.55, fract(wp.x / 0.76)); c = mix(vec3(0.14, 0.26, 0.07), vec3(0.2, 0.29, 0.09), hue); } // grass between crop rows
  else { H = 0.62; c = mix(vec3(0.17, 0.23, 0.08), vec3(0.36, 0.33, 0.17), hue * hue); }          // prairie
  // Ditches and verges: shaggy grass right up to the road edge.
  if (roadClear < 14.0) { H = 0.5; c = mix(vec3(0.15, 0.22, 0.07), vec3(0.3, 0.29, 0.14), hue); }
  if (roadClear < 1.2 || w_padDistance(wp) < 2.0) H = 0.0;
  vec3 carL = (uGrassCarInv * vec4(wp.x, 0.0, wp.y, 1.0)).xyz;
  if (abs(carL.x) < 1.25 && abs(carL.z) < 2.9) H = 0.0; // flattened under the truck
  // Pressed flat where he's lying in it.
  H *= 1.0 - 0.8 * uGrassFlat.w * (1.0 - smoothstep(uGrassFlat.z * 0.6, uGrassFlat.z, length(wp - uGrassFlat.xy)));
  H *= (0.55 + 0.7 * r) * keep * (farTile ? 1.15 : 1.0);
  gGrassH = H;
  // Dark down in the stand, lit at the tips.
  gGrassCol = c * (0.28 + 0.9 * position.y * position.y);
  float yaw = aBlade.w;
  vec2 across = vec2(cos(yaw), sin(yaw)) * (0.018 + 0.022 * r) * (farTile ? 3.0 : 1.0) * (H > 0.0 ? 1.0 : 0.0);
  // Wind: lean downwind, pump with the gusts, flutter.
  float ws = length(uGrassWind);
  vec2 wdir = ws > 0.1 ? uGrassWind / ws : vec2(1.0, 0.0);
  float gust = 0.7 + 0.3 * sin(uGrassTime * 1.7 + dot(wp, vec2(0.21, 0.13)));
  float lean = min(0.85, (0.08 + ws * ws * 0.0012) * gust) + 0.12 * sin(uGrassTime * (3.0 + ws * 0.1) + r * 40.0) * min(1.0, ws / 12.0);
  float v = position.y;
  // Each blade also has its own resting tilt, so the stand isn't ruler-straight.
  vec2 own = vec2(cos(r * 91.0), sin(r * 91.0)) * (0.12 + 0.25 * fract(r * 13.7));
  vec2 tip = (wdir * lean + own) * H * v * v;
  gGrassN = normalize(vec3(-sin(yaw) * 0.6 + own.x, 1.0, cos(yaw) * 0.6 + own.y));
  vec2 q = wp + across * position.x + tip;
  gGrassPos = vec3(q.x, w_height(wp) + H * v * (1.0 - 0.35 * lean * lean), q.y);
}
  vColor.rgb = gGrassCol;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec3 objectNormal = gGrassN;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gGrassPos;');
    };
    const prevKey = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => prevKey() + '|grass';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'grass';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** @param flat where the chaser is lying in the grass (x, z, radius, amount), or null */
  update(cam: THREE.Vector3, car: THREE.Object3D, flat: THREE.Vector4 | null = null): void {
    this.uCam.value.copy(cam);
    if (flat) this.uFlat.value.copy(flat);
    else this.uFlat.value.w = 0;
    // Only the horizontal footprint matters: ignore the car's pitch, roll and height.
    const yaw = Math.atan2(car.matrixWorld.elements[8], car.matrixWorld.elements[10]);
    this.uCarInv.value.makeRotationY(yaw).setPosition(car.position.x, 0, car.position.z).invert();
  }
}
