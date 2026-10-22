import * as THREE from 'three';
import { getNoise3D } from '../rendering/NoiseTextures';
import { atmo } from '../rendering/Atmosphere';

/**
 * Makes the solid tree crowns read as foliage: 3D-noise leaf clumps break the
 * silhouette into ragged, see-through edges (alpha-tested), clump shading
 * darkens the gaps between masses of leaves, and the crown is rendered from
 * both sides so the holes show inner foliage rather than empty space.
 * Works with BatchedMesh and InstancedMesh.
 */
const patched = new WeakSet<THREE.Material>();

export function patchFoliage(mat: THREE.MeshStandardMaterial): void {
  if (patched.has(mat)) return;
  patched.add(mat);
  mat.side = THREE.DoubleSide;
  mat.alphaTest = 0.5;
  const noise = getNoise3D();
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uLeafNoise = { value: noise };
    shader.uniforms.uTreeWind = atmo.uWind;
    shader.uniforms.uTreeTime = atmo.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafPos;\nvarying vec3 vLeafN;\nuniform vec2 uTreeWind;\nuniform float uTreeTime;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 lp = vec4(transformed, 1.0);
  vec3 ln = objectNormal;
  #ifdef USE_BATCHING
    lp = batchingMatrix * lp;
    ln = mat3(batchingMatrix) * ln;
  #endif
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
    ln = mat3(instanceMatrix) * ln;
  #endif
  vLeafPos = (modelMatrix * lp).xyz;
  vLeafN = normalize(mat3(modelMatrix) * ln);
  // Wind: the crown leans downwind (more for taller parts), pumps with the
  // gusts and flutters; each tree is out of phase with its neighbours.
  float ws = length(uTreeWind);
  if (ws > 0.5) {
    vec3 tb = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #ifdef USE_BATCHING
      tb = (modelMatrix * batchingMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    #ifdef USE_INSTANCING
      tb = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    float hgt = max(0.0, vLeafPos.y - tb.y);
    float phase = dot(tb.xz, vec2(0.11, 0.07));
    float gust = 0.75 + 0.25 * sin(uTreeTime * 0.9 + phase) + 0.15 * sin(uTreeTime * 2.3 + phase * 1.7);
    float bend = min(3.0, ws * ws * 0.0011 * gust) * pow(hgt / 10.0, 1.5);
    vec2 dir = uTreeWind / ws;
    float flutter = sin(uTreeTime * (5.0 + ws * 0.15) + dot(vLeafPos, vec3(0.9, 0.6, 1.3))) * min(0.35, ws * 0.008) * min(1.0, hgt / 4.0);
    // Leaf clumps stay pinned to the rest position (vLeafPos), so they don't crawl.
    vec3 wp = vLeafPos;
    wp.xz += dir * bend + vec2(-dir.y, dir.x) * flutter;
    wp.y -= bend * bend * 0.08;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
precision highp sampler3D;
uniform sampler3D uLeafNoise;
varying vec3 vLeafPos;
varying vec3 vLeafN;
float gLeaf;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  // Two scales of leaf clumps in world space.
  float clump = texture(uLeafNoise, vLeafPos * 0.11).g;
  float leaf = texture(uLeafNoise, vLeafPos * 0.55).a;
  gLeaf = clump * 0.65 + leaf * 0.35;
  vec3 V = normalize(cameraPosition - vLeafPos);
  float edge = 1.0 - abs(dot(normalize(vLeafN), V));
  float dist = length(cameraPosition - vLeafPos);
  // Ragged edges: holes open where the surface turns away from the eye; fade out with distance.
  float cut = mix(0.12, 0.62, edge) * (1.0 - smoothstep(250.0, 700.0, dist));
  diffuseColor.a = gLeaf > cut ? 1.0 : 0.0;
  // Gaps between clumps are darker; back faces (inside the crown) darker still.
  diffuseColor.rgb *= mix(0.55, 1.15, smoothstep(0.25, 0.75, gLeaf));
  if (!gl_FrontFacing) diffuseColor.rgb *= 0.5;
}`,
      );
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|foliage';
  mat.needsUpdate = true;
}
