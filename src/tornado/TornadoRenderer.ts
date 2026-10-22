import * as THREE from 'three';
import type { Tornado } from './Tornado';
import { getNoise3D } from '../rendering/NoiseTextures';
import { SKYFOG_GLSL, skyFogUniforms } from '../rendering/Atmosphere';

/**
 * Volumetric tornado: a raymarch through a box around the vortex.
 *
 * Density field, in a frame that follows the leaning, sinuous axis:
 *  - condensation funnel: a rotating shell whose radius flares toward the
 *    cloud base, condensed only down to the current condensation level,
 *    with helical striations from rotating 3D noise;
 *  - debris/dust cloud: a turbulent brown skirt at the ground that rises
 *    and spreads with the inflow.
 * Distance-aware step sizes let a 20 m rope funnel and a 600 m wedge share
 * one shader. The result goes through the same sky-fog as everything else, so
 * a rain-wrapped tornado fades into the curtain behind it.
 */
const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform vec3 uBase;        // ground point of the vortex
uniform vec3 uTop;         // top offset from base (x, height, z)
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform float uRadius;     // funnel radius at the ground
uniform float uTopR;       // radius at the cloud base
uniform float uCond;       // condensation 0..1 (fraction of height from the top)
uniform float uDebris;     // debris amount 0..1
uniform float uDebrisR;
uniform float uDebrisH;
uniform float uRope;
uniform float uTime;
uniform float uSpin;
uniform float uPresence;
uniform vec3 uLightDir;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColor;
uniform float uSunAmt;
uniform float uFlash;
uniform float uSteps;
${SKYFOG_GLSL}
varying vec3 vWorld;

vec2 axisAt(float h) {
  float lean = pow(h, 1.4 - 0.6 * uRope);
  vec2 c = uTop.xz * lean;
  float wig = uRope * sin(h * 3.14159);
  c += wig * vec2(sin(h * 7.0 + uTime * 0.22) * 55.0 + sin(h * 17.0 - uTime * 0.4) * 12.0,
                  cos(h * 6.0 - uTime * 0.18) * 50.0 + cos(h * 15.0 + uTime * 0.35) * 10.0);
  // A slight constant waviness even when mature.
  c += vec2(sin(h * 4.0 + uTime * 0.1), cos(h * 3.3 - uTime * 0.12)) * uRadius * 0.12;
  return c;
}

float funnelRadius(float h) {
  float r = mix(uRadius, uTopR, pow(h, 2.0 + uRope * 2.0));
  r += uTopR * 0.9 * smoothstep(0.86, 1.02, h);       // flares into the wall cloud
  // Taper to a point at the bottom of the condensed part.
  float tip = 1.0 - uCond;
  r *= mix(0.15, 1.0, smoothstep(tip, tip + 0.12 + (1.0 - uCond) * 0.2, h));
  return r;
}

// Returns density in x (funnel) and y (debris); z = distance hint for stepping.
vec3 field(vec3 p, out vec3 radial, out float hOut) {
  vec3 q = p - uBase;
  float H = uTop.y;
  float h = clamp(q.y / H, 0.0, 1.05);
  hOut = h;
  vec2 c = axisAt(h);
  vec2 dxz = q.xz - c;
  float d = length(dxz);
  radial = vec3(dxz.x, 0.0, dxz.y) / max(d, 0.001);
  float R = funnelRadius(h);

  // Rotating, rising noise in a frame that turns with the vortex.
  float ang = uTime * uSpin + h * 3.5;
  float ca = cos(ang), sa = sin(ang);
  vec2 rp = vec2(ca * dxz.x - sa * dxz.y, sa * dxz.x + ca * dxz.y);
  vec3 nq = vec3(rp / (R * 2.2 + 60.0), q.y / 420.0 - uTime * 0.035);
  vec4 n = texture(uNoise, nq);
  vec4 n2 = texture(uNoise, vec3(rp / (R * 0.9 + 20.0), q.y / 90.0 - uTime * 0.11));

  // Condensation funnel.
  float tip = 1.0 - uCond;
  float condMask = smoothstep(tip, tip + 0.05, h) * (1.0 - smoothstep(1.0, 1.05, h));
  float edge = R * (0.82 + 0.38 * n.r + 0.18 * (n2.g - 0.5));
  float funnel = (1.0 - smoothstep(edge * 0.8, edge * 1.02, d)) * condMask;
  funnel *= 0.85 + 0.4 * n2.r;

  // Debris and dust cloud: a churning, ragged sheath hugging the base and
  // climbing the funnel, thickest where the vortex scours the ground.
  float dh = q.y;
  float spread = uDebrisR * (0.5 + 0.7 * smoothstep(0.0, uDebrisH, dh));
  float skirt = (1.0 - smoothstep(spread * 0.3, spread, d + (n.b - 0.5) * spread * 0.7));
  float vert = exp(-max(dh, 0.0) / uDebrisH) * smoothstep(-6.0, 3.0, dh);
  // A tighter sheath of lofted debris wrapped around the lower funnel.
  float sheath = (1.0 - smoothstep(R * 0.9, R * 1.7 + 20.0, d)) * exp(-max(dh, 0.0) / (uDebrisH * 1.2)) * 0.6;
  float debris = uDebris * max(skirt * vert, sheath) * (0.45 + 1.5 * n.g * n2.b);

  float distHint = min(d - edge * 1.1, d - spread);
  return vec3(funnel * uPresence, debris * uPresence, distHint);
}

bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (uBoxMin - ro) * inv;
  vec3 b = (uBoxMax - ro) * inv;
  vec3 mn = min(a, b), mx = max(a, b);
  t0 = max(max(mn.x, mn.y), mn.z);
  t1 = min(min(mx.x, mx.y), mx.z);
  return t1 > max(t0, 0.0);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  float t0, t1;
  if (!boxHit(ro, rd, t0, t1)) discard;
  t0 = max(t0, 0.0);
  // Stop at the ground plane under the vortex.
  if (rd.y < 0.0) t1 = min(t1, (uBase.y - 1.0 - ro.y) / rd.y);
  if (t1 <= t0) discard;

  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float T = 1.0;
  vec3 col = vec3(0.0);
  float depthAcc = 0.0, wAcc = 0.0;
  float t = t0 + jitter * 2.0;
  int steps = int(uSteps);
  for (int i = 0; i < 160; i++) {
    if (i >= steps || t > t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    vec3 radial; float h;
    vec3 f = field(p, radial, h);
    float dens = f.x + f.y;
    float minStep = 1.0 + uRadius * 0.11 + t * 0.003;
    float stepLen = dens > 0.002 ? minStep : clamp(f.z * 0.6, minStep, 260.0);
    if (dens > 0.002) {
      // Funnel shading: lit side vs shadow side, darker low and inside.
      float lam = 0.5 + 0.5 * dot(radial, uLightDir);
      // Match the cloud base: dim grey-teal, lit side a little brighter.
      vec3 sky = uSkyHorizon * vec3(0.84, 0.97, 1.0);
      float stria = texture(uNoise, vec3(atan(radial.z, radial.x) * 0.9 + uTime * uSpin * 0.15, h * 6.0, 0.3)).r;
      // Darker than the cloud base so the funnel reads against the bright horizon.
      vec3 cf = sky * (0.09 + 0.2 * lam) * mix(0.7, 1.05, h) * (0.8 + 0.4 * stria) + uSunColor * uSunAmt * pow(lam, 4.0) * 0.08;
      // Dust: a lighter brown on the lit side, so the churning base stands out from the funnel.
      vec3 cd = vec3(0.27, 0.22, 0.17) * (0.35 + 0.65 * lam) * (0.45 + 0.6 * dot(uSkyHorizon, vec3(0.33)));
      vec3 c = (cf * f.x + cd * f.y) / dens;
      c += vec3(0.75, 0.78, 0.95) * uFlash * 0.6;
      float sigma = f.x * 0.16 + f.y * 0.11;
      float a = 1.0 - exp(-sigma * stepLen);
      col += T * a * c;
      depthAcc += T * a * t;
      wAcc += T * a;
      T *= 1.0 - a;
    }
    t += stepLen;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.003) discard;
  float dist = wAcc > 0.0 ? depthAcc / wAcc : t0;
  // Fog: blend premultiplied colour toward the sky behind by the fog factor.
  vec3 fogged = applySkyFog(col / max(alpha, 1e-4), dist) * alpha;
  gl_FragColor = vec4(fogged, alpha);
}
`;

export class TornadoRenderer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly box = new THREE.Box3();
  steps = 110;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: getNoise3D() },
        uBase: { value: new THREE.Vector3() },
        uTop: { value: new THREE.Vector3(0, 1000, 0) },
        uBoxMin: { value: new THREE.Vector3() },
        uBoxMax: { value: new THREE.Vector3() },
        uRadius: { value: 100 },
        uTopR: { value: 300 },
        uCond: { value: 1 },
        uDebris: { value: 1 },
        uDebrisR: { value: 300 },
        uDebrisH: { value: 80 },
        uRope: { value: 0 },
        uTime: { value: 0 },
        uSpin: { value: 0.5 },
        uPresence: { value: 1 },
        uLightDir: { value: new THREE.Vector3(1, 0, 0) },
        uSkyTop: { value: new THREE.Color() },
        uSkyHorizon: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunAmt: { value: 0 },
        uFlash: { value: 0 },
        uSteps: { value: this.steps },
        ...skyFogUniforms(),
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
  }

  update(
    t: Tornado | null,
    time: number,
    cam: THREE.Vector3,
    sky: { zenith: THREE.Color; horizon: THREE.Color; sunColor: THREE.Color; sunDir: THREE.Vector3 },
    sunAmt: number,
    flash: number,
  ): void {
    if (!t || !t.alive || t.presence < 0.005) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const u = this.material.uniforms;
    const P = t.params;
    const debrisR = Math.max(70, t.radius * 1.7 + 50) * (0.8 + P.debrisDensity * 0.4);
    const debrisH = 40 + t.radius * 0.35 + P.rating * 15;
    (u.uBase.value as THREE.Vector3).copy(t.position);
    (u.uTop.value as THREE.Vector3).copy(t.top);
    u.uRadius.value = t.radius;
    u.uTopR.value = P.topRadius * (1 - t.rope * 0.5);
    u.uCond.value = t.condensation;
    u.uDebris.value = t.debris * Math.max(0.6, P.debrisDensity);
    u.uDebrisR.value = debrisR;
    u.uDebrisH.value = debrisH;
    u.uRope.value = t.rope;
    u.uTime.value = time;
    u.uSpin.value = P.rotationSpeed;
    u.uPresence.value = Math.min(1, t.presence * 1.3);
    u.uSteps.value = this.steps;
    (u.uSkyTop.value as THREE.Color).copy(sky.zenith);
    (u.uSkyHorizon.value as THREE.Color).copy(sky.horizon);
    (u.uSunColor.value as THREE.Color).copy(sky.sunColor);
    u.uSunAmt.value = sunAmt;
    u.uFlash.value = flash;
    // Light comes mostly from the bright horizon side (the sun direction, flattened).
    (u.uLightDir.value as THREE.Vector3).set(sky.sunDir.x, 0, sky.sunDir.z).normalize();

    // Bounding box enclosing base skirt, leaning funnel and flared top.
    const maxR = Math.max(debrisR * 1.3, P.topRadius * 2.0 + 160);
    const b = t.position;
    this.box.min.set(Math.min(b.x, b.x + t.top.x) - maxR - 120 * t.rope, b.y - 30, Math.min(b.z, b.z + t.top.z) - maxR - 120 * t.rope);
    this.box.max.set(Math.max(b.x, b.x + t.top.x) + maxR + 120 * t.rope, b.y + t.top.y * 1.06, Math.max(b.z, b.z + t.top.z) + maxR + 120 * t.rope);
    (u.uBoxMin.value as THREE.Vector3).copy(this.box.min);
    (u.uBoxMax.value as THREE.Vector3).copy(this.box.max);
    this.box.getCenter(this.mesh.position);
    this.box.getSize(this.mesh.scale);
    const inside = this.box.containsPoint(cam);
    this.material.side = inside ? THREE.BackSide : THREE.FrontSide;
  }
}
