import * as THREE from 'three';
import { getNoise3D } from '../rendering/NoiseTextures';

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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafPos;\nvarying vec3 vLeafN;')
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
