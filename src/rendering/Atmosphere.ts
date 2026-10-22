import * as THREE from 'three';

/**
 * Shared atmospheric state, exposed as uniform objects so every patched
 * material sees the same values without per-material bookkeeping.
 *
 * Aerial perspective: instead of a flat fog colour, patched materials fade
 * toward the *sky colour behind them* (sampled from the low-res sky render at
 * the same screen position). Distant farms dissolve into exactly the rain
 * curtain or bright horizon that sits behind them, which is what makes the
 * storm read as one continuous body of air.
 */
export const atmo = {
  uSkyTex: { value: null as THREE.Texture | null },
  /** Size in pixels of the render target the scene is drawn into. */
  uViewport: { value: new THREE.Vector2(1, 1) },
  /** Extinction coefficient, 1/m. ~3/visibility. */
  uFogDensity: { value: 3 / 12000 },
  /** 0..1 brown dust mixed into the fog near a tornado. */
  uDust: { value: 0 },
  uDustColor: { value: new THREE.Color(0.23, 0.2, 0.17) },
  uTime: { value: 0 },
  /** 0..1 how wet surfaces are. */
  uWetness: { value: 0 },
  /** Ambient surface wind (m/s, xz) for grass and trees. */
  uWind: { value: new THREE.Vector2(3, 0) },
  /** Lightning flash brightness added to ambient, 0..~3. */
  uFlash: { value: 0 },
};

let chunksInstalled = false;

/** Replace three's fog chunks once, before any material compiles. */
export function installAtmosphereChunks(): void {
  if (chunksInstalled) return;
  chunksInstalled = true;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = length(mvPosition.xyz);
#endif
`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  #ifdef SKYFOG
    uniform sampler2D uSkyTex;
    uniform vec2 uViewport;
    uniform float uFogDensity;
    uniform float uDust;
    uniform vec3 uDustColor;
  #endif
#endif
`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef SKYFOG
    vec3 skyBehind = texture2D(uSkyTex, gl_FragCoord.xy / uViewport).rgb;
    skyBehind = mix(skyBehind, uDustColor * (0.6 + 0.4 * dot(skyBehind, vec3(0.33))), uDust);
    float fogFactor = 1.0 - exp(-vFogDepth * uFogDensity * (1.0 + uDust * 3.0));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, skyBehind, fogFactor);
  #else
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
  #endif
#endif
`;
}

const patched = new WeakSet<THREE.Material>();

/**
 * Opt a material into sky-coloured fog. Chains any existing onBeforeCompile.
 * Call before the material first renders.
 */
export function patchMaterial(mat: THREE.Material): void {
  if (patched.has(mat)) return;
  patched.add(mat);
  const m = mat as THREE.Material & { defines?: Record<string, string> };
  m.defines = { ...(m.defines ?? {}), SKYFOG: '' };
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uSkyTex = atmo.uSkyTex;
    shader.uniforms.uViewport = atmo.uViewport;
    shader.uniforms.uFogDensity = atmo.uFogDensity;
    shader.uniforms.uDust = atmo.uDust;
    shader.uniforms.uDustColor = atmo.uDustColor;
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|skyfog';
  mat.needsUpdate = true;
}

/** Patch every material under an object. */
export function patchObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of mats) if ((mt as THREE.Material & { fog?: boolean }).fog !== false) patchMaterial(mt);
  });
}

/** Uniforms + GLSL helper for custom ShaderMaterials that want the same fog. */
export const SKYFOG_GLSL = /* glsl */ `
uniform sampler2D uSkyTex;
uniform vec2 uViewport;
uniform float uFogDensity;
uniform float uDust;
uniform vec3 uDustColor;
vec3 applySkyFog(vec3 col, float dist) {
  vec3 skyBehind = texture2D(uSkyTex, gl_FragCoord.xy / uViewport).rgb;
  skyBehind = mix(skyBehind, uDustColor * (0.6 + 0.4 * dot(skyBehind, vec3(0.33))), uDust);
  float f = 1.0 - exp(-dist * uFogDensity * (1.0 + uDust * 3.0));
  return mix(col, skyBehind, f);
}
`;

export function skyFogUniforms(): Record<string, THREE.IUniform> {
  return {
    uSkyTex: atmo.uSkyTex,
    uViewport: atmo.uViewport,
    uFogDensity: atmo.uFogDensity,
    uDust: atmo.uDust,
    uDustColor: atmo.uDustColor,
  };
}
