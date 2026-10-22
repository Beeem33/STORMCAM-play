import * as THREE from 'three';
import { getNoise2D, getNoise3D } from './NoiseTextures';
import type { StormCell } from '../weather/StormModel';

export const MAX_STORMS = 4;

/**
 * Raymarched storm sky, rendered at reduced resolution into a texture that is
 * used both as the visible sky and as the colour distant objects fade into.
 *
 * Layers (all in world space so parallax is right while driving):
 *  - hazy background sky, brightest at the horizon away from storms
 *  - high anvil shield (2D layer at ~10 km)
 *  - storm cloud mass with a lowered, rotating wall cloud and striated base
 *  - rain/hail curtains between the base and the ground
 *  - lightning illuminating the volume from inside
 */
const SKY_GLSL = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise3;
uniform sampler2D uNoise2;
uniform vec3 uCamPos;
uniform mat4 uInvViewProj;
uniform float uTime;
uniform vec4 uStormA[${MAX_STORMS}]; // x, z, radius, intensity
uniform vec4 uStormB[${MAX_STORMS}]; // dirX, dirZ, meso, seed
uniform int uStormCount;
uniform vec4 uTornado;   // x, z, radius, presence 0..1
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec4 uFlash;     // x, y, z, intensity
uniform float uSteps;
uniform float uBaseAlt;
uniform float uHaze;     // 0..1 general humidity haze
#ifdef ENV_MODE
varying vec3 vWorldDir;
#else
varying vec2 vUv;
#endif

float sstep(float a, float b, float x) { return smoothstep(a, b, x); }

// Storm-relative frame.
vec2 stormFrame(int i, vec2 p) {
  vec2 d = p - uStormA[i].xy;
  vec2 f = uStormB[i].xy;
  return vec2(dot(d, f), dot(d, vec2(-f.y, f.x)));
}

// Striation banding around the strongest mesocyclone (0..1), set by stormFields.
float gStriae = 0.5;
float gMesoNear = 0.0;

// Returns: x = base coverage, y = precip, z = base lowering (m), w = anvil.
vec4 stormFields(vec2 p) {
  float cover = 0.0, precip = 0.0, lower = 0.0, anvil = 0.0;
  gStriae = 0.5;
  gMesoNear = 0.0;
  for (int i = 0; i < ${MAX_STORMS}; i++) {
    if (i >= uStormCount) break;
    float R = uStormA[i].z;
    float I = uStormA[i].w;
    float meso = uStormB[i].z;
    vec2 l = stormFrame(i, p);
    // Base coverage ellipse.
    vec2 e = vec2((l.x - 0.45 * R) / (1.45 * R), (l.y + 0.1 * R) / (0.95 * R));
    float c = I * (1.0 - sstep(0.5, 1.0, length(e)));
    cover = max(cover, c);
    // Forward-flank precip core.
    vec2 ce = vec2((l.x - 0.75 * R) / (0.95 * R), (l.y + 0.4 * R) / (0.55 * R));
    float ffd = 1.0 - sstep(0.15, 1.0, length(ce));
    float d = length(l);
    float ring = 1.0 - sstep(0.06 * R, 0.13 * R, abs(d - 0.24 * R));
    float th = atan(l.y, l.x);
    float arc = sstep(-0.2, 0.6, -sin(th) * 0.8 - cos(th) * 0.6 + 0.35);
    precip = max(precip, I * max(ffd * ffd * 1.15, ring * arc * meso * 0.8));
    // Wall cloud / meso lowering, plus a shelf of stacked striations.
    float wall = meso * I * (1.0 - sstep(0.04 * R, 0.16 * R, d));
    float shelf = I * (1.0 - sstep(0.1 * R, 0.6 * R, d));
    float bandN = texture(uNoise2, p / 4200.0).g;
    float spiral = 0.5 + 0.5 * sin(d / (0.038 * R) - th * 1.0 + bandN * 5.0 + uTime * 0.03 * meso);
    float lw = wall * 420.0 + shelf * (150.0 + 160.0 * spiral * meso);
    if (lw > lower) {
      lower = lw;
      gStriae = mix(0.5, spiral, meso * shelf);
      gMesoNear = shelf * meso;
    }
    // Anvil.
    float along = max(0.0, l.x + 1.2 * R);
    float width = 1.2 * R + along * 0.45;
    float lat = abs(l.y + 0.2 * R) / width;
    anvil = max(anvil, I * (1.0 - sstep(0.6, 1.0, lat)) * (1.0 - sstep(7.0 * R, 10.0 * R, along)) * sstep(-1.2 * R, -0.6 * R, l.x));
  }
  // Tornado-scale tightening of the wall cloud.
  if (uTornado.w > 0.0) {
    float dt = length(p - uTornado.xy);
    lower = max(lower, uTornado.w * 560.0 * (1.0 - sstep(uTornado.z * 2.0, uTornado.z * 14.0, dt)));
  }
  return vec4(cover, precip, lower, anvil);
}

// Storm fields baked into a camera-centred texture once per frame (see FIELD_FRAG):
// x = cover, y = precip, z = base lowering / 1000, w = striation shade.
uniform sampler2D uField;
uniform vec3 uFieldInfo; // centre x, centre z, half extent
vec4 fieldAt(vec2 p) {
  vec2 uv = (p - uFieldInfo.xy) / (2.0 * uFieldInfo.z) + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0, 0.0, 0.0, 1.0);
  vec4 f = texture(uField, uv);
  f.z *= 1000.0;
  return f;
}

float baseHeight(vec2 p, float lower) {
  float n = texture(uNoise2, p * (1.0 / 5200.0)).r;
  float n2 = texture(uNoise2, p * (1.0 / 1300.0) + uTime * 0.0004).g;
  return uBaseAlt - lower + (n - 0.5) * 260.0 + (n2 - 0.5) * 110.0;
}

float cloudDensity(vec3 p, vec4 f, out float baseH) {
  baseH = baseHeight(p.xz, f.z);
  float h = p.y - baseH;
  if (h < 0.0 || f.x < 0.02) return 0.0;
  float topH = 2200.0 + 9000.0 * f.x;
  float hn = h / (topH - baseH);
  if (hn > 1.0) return 0.0;
  vec3 q = p * (1.0 / 2400.0) + vec3(uTime * 0.004, 0.0, uTime * 0.002);
  vec4 n = texture(uNoise3, q);
  float shape = n.r * 0.65 + n.b * 0.55;
  float dens = f.x * 1.25 - (1.0 - shape) * 0.85;
  dens -= (1.0 - n.g) * 0.25 * (1.0 - hn);
  dens *= sstep(0.0, 60.0, h) * (1.0 - sstep(0.75, 1.0, hn));
  return clamp(dens, 0.0, 1.0);
}

vec3 backgroundSky(vec3 rd, float anvilOverhead) {
  float up = max(rd.y, 0.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.55));
  float sunAmt = pow(max(dot(rd, uSunDir), 0.0), 6.0);
  sky += uSunColor * sunAmt * 0.35 * (1.0 - anvilOverhead);
  return sky;
}

void main() {
#ifdef ENV_MODE
  vec3 rd = normalize(vWorldDir);
#else
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 wp = uInvViewProj * ndc;
  vec3 rd = normalize(wp.xyz / wp.w - uCamPos);
#endif
  vec3 ro = uCamPos;
  float horizonFade = sstep(-0.02, 0.06, rd.y);
  rd.y = max(rd.y, 0.012);
  rd = normalize(rd);

  float jitter = texture(uNoise2, gl_FragCoord.xy / 256.0).a;

  // --- High anvil layer (2D) ---------------------------------------------
  float tAnvil = (10500.0 - ro.y) / rd.y;
  vec2 pa = ro.xz + rd.xz * min(tAnvil, 90000.0);
  vec4 fa = stormFields(pa);
  float anvilTex = texture(uNoise2, pa * (1.0 / 26000.0) + uTime * 0.00002).r;
  float anvil = clamp(fa.w * (0.6 + anvilTex * 0.9), 0.0, 1.0);
  vec4 fHere = stormFields(ro.xz);
  vec3 col = backgroundSky(rd, max(fHere.w, fHere.x));
  vec3 anvilCol = mix(uHorizon * 0.95, uZenith * 0.75, 0.5) * (0.85 + 0.25 * anvilTex);
  col = mix(col, anvilCol, anvil * 0.92 * sstep(0.0, 0.08, rd.y));

  // --- Storm volume ---------------------------------------------------------
  float lo = uBaseAlt - 900.0;
  float hi = 11000.0;
  float t0 = max(0.0, (lo - ro.y) / rd.y);
  float t1 = min((hi - ro.y) / rd.y, 60000.0);
  vec3 scat = vec3(0.0);
  float T = 1.0;
  float firstHit = -1.0;

  // Rain curtains below the base: few wide steps.
  {
    const int RS = 7;
    float tEnd = min(t0 + 400.0 / rd.y, 26000.0);
    float dtr = tEnd / float(RS);
    float t = dtr * jitter;
    for (int i = 0; i < RS; i++) {
      vec3 p = ro + rd * t;
      vec4 f = fieldAt(p.xz);
      float bh = baseHeight(p.xz, f.z);
      if (p.y < bh && f.y > 0.02) {
        float streak = texture(uNoise2, vec2(p.x, p.z) * (1.0 / 900.0) + vec2(0.0, uTime * 0.01)).g;
        float veil = f.y * (0.55 + 0.9 * streak) * sstep(0.1, 0.5, f.y);
        float sigma = veil * 0.00042;
        float a = 1.0 - exp(-sigma * dtr);
        vec3 rainCol = mix(uHorizon * 0.55, vec3(0.42, 0.5, 0.52) * 0.9, 0.5) * (0.55 + 0.45 * (1.0 - f.y));
        rainCol *= vec3(0.82, 0.95, 0.96); // faint hail-core green
        float fl = uFlash.w * exp(-length(p - uFlash.xyz) / 4000.0);
        rainCol += vec3(0.7, 0.72, 0.9) * fl * 0.4;
        scat += T * a * rainCol;
        T *= 1.0 - a;
        if (firstHit < 0.0 && a > 0.05) firstHit = t;
      }
      t += dtr;
    }
  }

  if (t1 > t0) {
    int steps = int(uSteps);
    float span = t1 - t0;
    for (int i = 0; i < 96; i++) {
      if (i >= steps || T < 0.02) break;
      float u0 = (float(i) + jitter) / float(steps);
      float u1 = (float(i) + 1.0 + jitter) / float(steps);
      float ta = t0 + span * u0 * u0;
      float tb = t0 + span * u1 * u1;
      float dt = tb - ta;
      vec3 p = ro + rd * ta;
      vec4 f = fieldAt(p.xz);
      float bh;
      float dens = cloudDensity(p, f, bh);
      if (dens > 0.001) {
        float topH = 2200.0 + 9000.0 * f.x;
        float hn = clamp((p.y - bh) / (topH - bh), 0.0, 1.0);
        // Light: optical depth toward the sun through the rest of the cloud.
        float odSun = f.x * (topH - p.y) * 0.0021 + dens * 2.0;
        float sunT = exp(-odSun);
        float powder = 1.0 - exp(-dens * 6.0);
        float phase = 0.55 + 0.9 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
        // Ambient: dark underneath, light from the sky at the sides and top.
        vec3 amb = mix(uHorizon * vec3(0.2, 0.25, 0.27), uZenith * 1.0, pow(hn, 0.7));
        float edge = 1.0 - sstep(0.15, 0.6, f.x); // thin edges catch more light
        vec3 c = amb * (0.45 + 0.7 * edge) + uSunColor * sunT * phase * powder * 2.2;
        // Texture of the base: darker thick patches, lighter scud and rolls.
        float patchy = texture(uNoise2, p.xz / 2600.0 + uTime * 0.0006).r;
        float fine = texture(uNoise2, p.xz / 480.0 - uTime * 0.002).g;
        float low = 1.0 - sstep(0.0, 0.18, hn);
        c *= mix(1.0, 0.55 + 0.75 * patchy + 0.3 * (fine - 0.5), low);
        // Stacked-plate striations around the mesocyclone: lit shelf edges, dark grooves.
        c *= mix(1.0, f.w, low);
        c *= vec3(0.84, 0.97, 1.0); // storm tint (teal-grey)
        float fl = uFlash.w * exp(-length(p - uFlash.xyz) / 2600.0);
        c += vec3(0.78, 0.8, 1.0) * fl * 0.9;
        float sigma = dens * 0.0045;
        float a = 1.0 - exp(-sigma * dt);
        scat += T * a * c;
        T *= 1.0 - a;
        if (firstHit < 0.0 && a > 0.05) firstHit = ta;
      }
    }
  }

  col = col * T + scat;

  // Aerial perspective toward the horizon.
  float dist = firstHit < 0.0 ? 40000.0 : firstHit;
  float aerial = 1.0 - exp(-dist / (32000.0 - uHaze * 18000.0));
  vec3 hz = backgroundSky(normalize(vec3(rd.x, 0.02, rd.z)), fHere.w);
  col = mix(col, hz * 0.97, aerial * 0.85);

  // Below the horizon: fade to horizon haze (fog colour for distant ground).
  col = mix(hz * 0.9, col, horizonFade);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Bakes stormFields() over the area around the camera; one texel per ~150 m. */
const FIELD_FRAG = SKY_GLSL.slice(0, SKY_GLSL.indexOf('float baseHeight(')) + /* glsl */ `
uniform vec3 uFieldInfoW;
void main() {
  vec2 p = uFieldInfoW.xy + (vUv - 0.5) * 2.0 * uFieldInfoW.z;
  vec4 f = stormFields(p);
  float stri = 1.0 + (0.62 + 0.75 * sstep(0.35, 0.85, gStriae) - 1.0) * gMesoNear;
  gl_FragColor = vec4(f.x, f.y, f.z / 1000.0, stri);
}
`;

const FIELD_SIZE = 512;
const FIELD_HALF = 40000;

export interface SkyParams {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  zenith: THREE.Color;
  horizon: THREE.Color;
  baseAlt: number;
  haze: number;
}

export class CloudSky {
  readonly target: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly invVP = new THREE.Matrix4();
  /** Resolution divisor relative to the main render. */
  divisor = 3;
  /** The sky dome mesh drawn in the main scene, showing the sky texture. */
  readonly dome: THREE.Mesh;
  private readonly fieldRT: THREE.WebGLRenderTarget;
  private readonly fieldMat: THREE.ShaderMaterial;
  private readonly fieldScene = new THREE.Scene();

  constructor() {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
    });
    const stormA = Array.from({ length: MAX_STORMS }, () => new THREE.Vector4());
    const stormB = Array.from({ length: MAX_STORMS }, () => new THREE.Vector4());
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uNoise3: { value: getNoise3D() },
        uNoise2: { value: getNoise2D() },
        uCamPos: { value: new THREE.Vector3() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uTime: { value: 0 },
        uStormA: { value: stormA },
        uStormB: { value: stormB },
        uStormCount: { value: 0 },
        uTornado: { value: new THREE.Vector4() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uFlash: { value: new THREE.Vector4() },
        uSteps: { value: 40 },
        uField: { value: null },
        uFieldInfo: { value: new THREE.Vector3(0, 0, FIELD_HALF) },
        uBaseAlt: { value: 1300 },
        uHaze: { value: 0.4 },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: SKY_GLSL,
      depthTest: false,
      depthWrite: false,
    });
    this.fieldRT = new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
    });
    this.material.uniforms.uField.value = this.fieldRT.texture;
    this.fieldMat = new THREE.ShaderMaterial({
      uniforms: { ...this.material.uniforms, uFieldInfoW: this.material.uniforms.uFieldInfo },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: FIELD_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const fq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fieldMat);
    fq.frustumCulled = false;
    this.fieldScene.add(fq);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    // Sky dome in the main scene: samples the sky texture in screen space.
    const domeMat = new THREE.ShaderMaterial({
      uniforms: { uSky: { value: this.target.texture }, uViewport: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */ `void main(){ vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `uniform sampler2D uSky; uniform vec2 uViewport; void main(){ gl_FragColor = vec4(texture2D(uSky, gl_FragCoord.xy / uViewport).rgb, 1.0); }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), domeMat);
    this.dome.scale.setScalar(50000);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
  }

  setStorms(storms: readonly StormCell[], tornado: { x: number; z: number; radius: number; presence: number } | null): void {
    const u = this.material.uniforms;
    const A = u.uStormA.value as THREE.Vector4[];
    const B = u.uStormB.value as THREE.Vector4[];
    let n = 0;
    for (const s of storms) {
      if (n >= MAX_STORMS) break;
      const sp = Math.hypot(s.vx, s.vz) || 1;
      A[n].set(s.x, s.z, s.radius, s.intensity);
      B[n].set(s.vx / sp, s.vz / sp, s.meso, s.seed);
      n++;
    }
    u.uStormCount.value = n;
    const t = u.uTornado.value as THREE.Vector4;
    if (tornado) t.set(tornado.x, tornado.z, tornado.radius, tornado.presence);
    else t.set(0, 0, 1, 0);
  }

  setParams(p: SkyParams): void {
    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(p.sunDir);
    (u.uSunColor.value as THREE.Color).copy(p.sunColor);
    (u.uZenith.value as THREE.Color).copy(p.zenith);
    (u.uHorizon.value as THREE.Color).copy(p.horizon);
    u.uBaseAlt.value = p.baseAlt;
    u.uHaze.value = p.haze;
  }

  setFlash(x: number, y: number, z: number, intensity: number): void {
    (this.material.uniforms.uFlash.value as THREE.Vector4).set(x, y, z, intensity);
  }

  setQuality(steps: number, divisor: number): void {
    this.material.uniforms.uSteps.value = steps;
    this.divisor = divisor;
  }

  resize(width: number, height: number): void {
    const w = Math.max(32, Math.round(width / this.divisor));
    const h = Math.max(18, Math.round(height / this.divisor));
    this.target.setSize(w, h);
    ((this.dome.material as THREE.ShaderMaterial).uniforms.uViewport.value as THREE.Vector2).set(width, height);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, time: number): void {
    const u = this.material.uniforms;
    camera.updateMatrixWorld();
    this.invVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    (u.uInvViewProj.value as THREE.Matrix4).copy(this.invVP);
    (u.uCamPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    u.uTime.value = time;
    this.dome.position.copy(u.uCamPos.value as THREE.Vector3);
    const prev = renderer.getRenderTarget();
    // Re-bake the storm fields around the camera (snapped to whole texels).
    const texel = (2 * FIELD_HALF) / FIELD_SIZE;
    const cp = u.uCamPos.value as THREE.Vector3;
    (u.uFieldInfo.value as THREE.Vector3).set(Math.round(cp.x / texel) * texel, Math.round(cp.z / texel) * texel, FIELD_HALF);
    renderer.setRenderTarget(this.fieldRT);
    renderer.render(this.fieldScene, this.cam);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }

  /**
   * A second material running the same sky code on a camera-centred sphere,
   * so a CubeCamera can capture it for reflections. Shares uniform objects.
   */
  createEnvMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: this.material.uniforms,
      defines: { ENV_MODE: '' },
      vertexShader: /* glsl */ `varying vec3 vWorldDir; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorldDir = w.xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: SKY_GLSL,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
  }
}
