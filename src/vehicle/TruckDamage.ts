import * as THREE from 'three';

/**
 * Visible crash damage on the truck: each hard impact leaves a dent where it
 * landed — body panels pushed in around the contact point, the black paint
 * scraped through to grey primer and bare metal. Dents live in the truck's
 * own frame and are pushed to the GPU as world positions each frame.
 */

const MAX = 14;

interface Dent {
  local: THREE.Vector3;
  radius: number;
  depth: number;
}

const _w = new THREE.Vector3();

export class TruckDamage {
  private readonly dents: Dent[] = [];
  private readonly uPos = { value: Array.from({ length: MAX }, () => new THREE.Vector4(0, -1e6, 0, 0.001)) };
  private readonly uDepth = { value: new Array<number>(MAX).fill(0) };

  /** Patch the truck's exterior materials (by name) to show dents and scrapes. */
  constructor(root: THREE.Object3D) {
    const names = /^(Paint|Trim|Bumper|Flare|Grille|HeadlightHousing|LEDHousing|Chassis)$/;
    const done = new Set<THREE.Material>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (done.has(mat) || !names.test(mat.name) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
        done.add(mat);
        this.patch(mat as THREE.MeshStandardMaterial);
      }
    });
  }

  /** A hit at `local` (truck frame, metres from the centre of gravity), 0..1 severity. */
  add(local: THREE.Vector3, severity: number): void {
    const s = THREE.MathUtils.clamp(severity, 0, 1);
    if (s < 0.05) return;
    // Hits close to an existing dent deepen it instead of adding another.
    const near = this.dents.find((d) => d.local.distanceTo(local) < d.radius * 0.6);
    if (near) {
      near.depth = Math.min(0.22, near.depth + 0.05 * s);
      near.radius = Math.min(0.95, near.radius + 0.08 * s);
      return;
    }
    if (this.dents.length >= MAX) this.dents.shift();
    this.dents.push({ local: local.clone(), radius: 0.35 + 0.45 * s, depth: 0.05 + 0.12 * s });
  }

  clear(): void {
    this.dents.length = 0;
  }

  /** Move the dents with the truck. */
  update(truck: THREE.Object3D): void {
    for (let i = 0; i < MAX; i++) {
      const d = this.dents[i];
      if (!d) {
        this.uPos.value[i].set(0, -1e6, 0, 0.001);
        this.uDepth.value[i] = 0;
        continue;
      }
      _w.copy(d.local).applyMatrix4(truck.matrixWorld);
      this.uPos.value[i].set(_w.x, _w.y, _w.z, d.radius);
      this.uDepth.value[i] = d.depth;
    }
  }

  private patch(mat: THREE.MeshStandardMaterial): void {
    const prev = mat.onBeforeCompile.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.uniforms.uDentPos = this.uPos;
      shader.uniforms.uDentDepth = this.uDepth;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
#define DENTS ${MAX}
uniform vec4 uDentPos[DENTS];
uniform float uDentDepth[DENTS];
varying float vDent;
varying vec3 vDentPos;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  float push = 0.0;
  for (int i = 0; i < DENTS; i++) {
    float d = distance(wp.xyz, uDentPos[i].xyz);
    float f = 1.0 - smoothstep(0.0, uDentPos[i].w, d);
    // Creased, not smooth: a little noise on the crumple.
    float crease = 0.75 + 0.25 * sin(wp.x * 23.0 + wp.y * 17.0) * sin(wp.z * 19.0 - wp.y * 11.0);
    push += uDentDepth[i] * f * f * crease;
  }
  transformed -= normalize(objectNormal) * push;
  vDent = push;
  vDentPos = wp.xyz;
}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDent;\nvarying vec3 vDentPos;')
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
{
  // Scraped paint: long diagonal scratches through to grey primer and, in the
  // deepest part, bright bare metal; the crumples sit in shadow.
  float scr = smoothstep(0.012, 0.07, vDent);
  float lines = sin(dot(vDentPos, vec3(31.0, 47.0, 23.0)) + sin(dot(vDentPos, vec3(3.1, 5.3, 2.7))) * 4.0);
  float scratch = smoothstep(0.55, 0.95, lines) * scr;
  float metal = smoothstep(0.08, 0.14, vDent) * smoothstep(0.2, 0.9, lines);
  diffuseColor.rgb *= 1.0 - 0.35 * scr;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.35, 0.33), scratch * 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.62, 0.64), metal);
  roughnessFactor = mix(roughnessFactor, 0.8, scr);
}`,
        );
    };
    const prevKey = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => prevKey() + '|dents';
    mat.needsUpdate = true;
  }
}
