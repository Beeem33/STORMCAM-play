import * as THREE from 'three';
import { SKYFOG_GLSL, skyFogUniforms } from '../rendering/Atmosphere';

/**
 * Falling rain and hail around the camera, fully on the GPU: each instance
 * wraps inside a camera-centred box, falls with the wind, and is stretched
 * into a streak along its velocity *relative to the camera* — so driving into
 * rain turns it into the familiar horizontal streaks. Particles inside the
 * vehicle cabin are culled.
 */

const MAX_RAIN = 32000;
const MAX_HAIL = 2500;

const VERT = /* glsl */ `
attribute vec4 aSeed;          // xyz in [0,1), w random
uniform vec3 uCam;
uniform vec3 uCamVel;
uniform vec3 uFall;            // fall velocity (wind + gravity)
uniform vec3 uBox;             // box size
uniform float uTime;
uniform float uStreak;         // seconds of motion per streak (shutter)
uniform float uWidth;          // world width
uniform mat4 uCarInv;          // world → vehicle local
uniform vec3 uCarHalf;
uniform float uCarCull;
uniform vec2 uViewport;
varying float vAlpha;
varying float vDist;
varying vec2 vQuad;
void main() {
  vec3 p = aSeed.xyz * uBox + uFall * (uTime * (0.85 + aSeed.w * 0.3));
  p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  vec3 rel = uFall * (0.85 + aSeed.w * 0.3) - uCamVel;
  vec3 a = p;
  vec3 b = p - rel * uStreak;
  // Cull inside the vehicle cabin.
  vec3 lp = (uCarInv * vec4(p, 1.0)).xyz;
  float inside = uCarCull * step(abs(lp.x), uCarHalf.x) * step(abs(lp.y - 0.4), uCarHalf.y) * step(abs(lp.z), uCarHalf.z);
  vec4 ca = projectionMatrix * viewMatrix * vec4(a, 1.0);
  vec4 cb = projectionMatrix * viewMatrix * vec4(b, 1.0);
  vec2 sa = ca.xy / ca.w;
  vec2 sb = cb.xy / cb.w;
  vec2 dir = sb - sa;
  vec2 px = dir * uViewport * 0.5;
  float lenPx = length(px);
  vec2 n = lenPx > 1e-4 ? normalize(vec2(-px.y, px.x)) : vec2(1.0, 0.0);
  // Width: world width projected, at least ~1 px (fading alpha instead of shrinking).
  float wPx = uWidth / max(ca.w, 0.01) * uViewport.y * projectionMatrix[1][1] * 0.5;
  float drawW = max(wPx, 0.9);
  vec4 c = position.y < 0.5 ? ca : cb;
  c.xy += n / uViewport * 2.0 * drawW * position.x * c.w;
  gl_Position = c;
  float d = length(p - uCam);
  vDist = d;
  vQuad = position.xy;
  vAlpha = (1.0 - inside) * clamp(wPx / drawW, 0.12, 1.0) * smoothstep(uBox.x * 0.5, uBox.x * 0.32, length(p.xz - uCam.xz)) * smoothstep(0.25, 1.2, d);
  vAlpha /= 1.0 + lenPx * 0.012;
  if (ca.w < 0.05 || cb.w < 0.05) vAlpha = 0.0;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
${SKYFOG_GLSL}
varying float vAlpha;
varying float vDist;
varying vec2 vQuad;
void main() {
  float edge = 1.0 - abs(vQuad.x) * 2.0;
  float a = vAlpha * uOpacity * edge;
  if (a < 0.003) discard;
  vec3 c = applySkyFog(uColor, vDist);
  gl_FragColor = vec4(c, a);
}
`;

function makeGeometry(count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  // Quad: x in [-0.5, 0.5] across, y in {0 (head), 1 (tail)}.
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = 0;
  return g;
}

export class Precipitation {
  readonly group = new THREE.Group();
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly hailMat: THREE.ShaderMaterial;
  private readonly rainGeo = makeGeometry(MAX_RAIN);
  private readonly hailGeo = makeGeometry(MAX_HAIL);
  density = 1;

  constructor() {
    const common = () => ({
      uCam: { value: new THREE.Vector3() },
      uCamVel: { value: new THREE.Vector3() },
      uFall: { value: new THREE.Vector3(0, -9, 0) },
      uBox: { value: new THREE.Vector3(36, 22, 36) },
      uTime: { value: 0 },
      uStreak: { value: 0.03 },
      uWidth: { value: 0.0025 },
      uCarInv: { value: new THREE.Matrix4() },
      uCarHalf: { value: new THREE.Vector3(1.0, 0.75, 2.6) },
      uCarCull: { value: 1 },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uColor: { value: new THREE.Color(0.6, 0.64, 0.66) },
      uOpacity: { value: 0.35 },
      ...skyFogUniforms(),
    });
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: common(),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.hailMat = new THREE.ShaderMaterial({
      uniforms: { ...common(), uBox: { value: new THREE.Vector3(30, 18, 30) }, uWidth: { value: 0.012 }, uOpacity: { value: 0.8 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    (this.hailMat.uniforms.uColor.value as THREE.Color).setRGB(0.75, 0.78, 0.8);
    const rain = new THREE.Mesh(this.rainGeo, this.rainMat);
    const hail = new THREE.Mesh(this.hailGeo, this.hailMat);
    for (const m of [rain, hail]) {
      m.frustumCulled = false;
      m.renderOrder = 50;
    }
    this.group.add(rain, hail);
  }

  update(
    time: number,
    cam: THREE.Vector3,
    camVel: THREE.Vector3,
    wind: THREE.Vector3,
    rain: number,
    hail: number,
    car: THREE.Object3D | null,
    viewport: THREE.Vector2,
    skyLight: THREE.Color,
  ): void {
    this.rainGeo.instanceCount = Math.floor(MAX_RAIN * Math.min(1, rain * 1.4) * this.density);
    this.hailGeo.instanceCount = Math.floor(MAX_HAIL * hail);
    for (const [m, fall] of [[this.rainMat, 9], [this.hailMat, 22]] as const) {
      const u = m.uniforms;
      (u.uCam.value as THREE.Vector3).copy(cam);
      (u.uCamVel.value as THREE.Vector3).copy(camVel);
      (u.uFall.value as THREE.Vector3).set(wind.x * 0.9, -fall, wind.z * 0.9);
      u.uTime.value = time;
      (u.uViewport.value as THREE.Vector2).copy(viewport);
      if (car) {
        car.updateMatrixWorld();
        (u.uCarInv.value as THREE.Matrix4).copy(car.matrixWorld).invert();
        u.uCarCull.value = 1;
      } else u.uCarCull.value = 0;
    }
    (this.rainMat.uniforms.uColor.value as THREE.Color).copy(skyLight).multiplyScalar(0.75);
    (this.hailMat.uniforms.uColor.value as THREE.Color).copy(skyLight).multiplyScalar(1.1);
    this.rainMat.uniforms.uOpacity.value = 0.34 + rain * 0.36;
  }
}
