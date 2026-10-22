import * as THREE from 'three';
import type { StormCell } from './StormModel';
import { heightAt } from '../environment/WorldShape';
import { SKYFOG_GLSL, skyFogUniforms } from '../rendering/Atmosphere';

/**
 * Lightning: in-cloud flashes that light the storm from inside and
 * cloud-to-ground strokes with branching channels. Each flash is a short
 * train of return strokes; the scene light and sky emission follow that
 * envelope, thunder is dispatched with the right delay by the audio system.
 */

interface Flash {
  pos: THREE.Vector3;
  ground: THREE.Vector3 | null;
  t: number;
  strokes: number[]; // start times of return strokes
  duration: number;
  strength: number;
  bolt: THREE.Mesh | null;
  storm: StormCell;
}

export interface StrikeEvent {
  position: THREE.Vector3;
  cloudToGround: boolean;
  distance: number;
}

const BOLT_VERT = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute float aW;
uniform vec2 uViewport;
uniform float uWidthScale;
varying float vEdge;
varying float vDist;
varying float vW;
void main() {
  vec4 ca = projectionMatrix * viewMatrix * vec4(aA, 1.0);
  vec4 cb = projectionMatrix * viewMatrix * vec4(aB, 1.0);
  vec2 sa = ca.xy / ca.w, sb = cb.xy / cb.w;
  vec2 d = (sb - sa) * uViewport;
  vec2 n = normalize(vec2(-d.y, d.x) + 1e-5);
  vec4 c = position.y < 0.5 ? ca : cb;
  float px = max(1.2, aW * uWidthScale / max(c.w, 1.0) * uViewport.y);
  c.xy += n / uViewport * 2.0 * px * position.x * c.w;
  gl_Position = c;
  vEdge = position.x * 2.0;
  vDist = length((position.y < 0.5 ? aA : aB) - cameraPosition);
  vW = aW;
}
`;
const BOLT_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uGlow;
${SKYFOG_GLSL}
varying float vEdge;
varying float vDist;
varying float vW;
void main() {
  float core = 1.0 - smoothstep(0.0, 1.0, abs(vEdge));
  float glow = uGlow > 0.5 ? pow(core, 3.0) * 0.12 : core;
  vec3 c = vec3(0.86, 0.88, 1.0) * uIntensity * glow * (0.4 + vW * 0.6);
  // Rain and haze swallow distant channels.
  float f = 1.0 - exp(-vDist * uFogDensity * 0.8);
  c *= 1.0 - f * 0.9;
  gl_FragColor = vec4(c, 1.0);
}
`;

function buildBoltGeometry(top: THREE.Vector3, ground: THREE.Vector3, rng: () => number): THREE.InstancedBufferGeometry {
  const A: number[] = [], B: number[] = [], W: number[] = [];
  const walk = (from: THREE.Vector3, to: THREE.Vector3, width: number, depth: number) => {
    const n = 26;
    let p = from.clone();
    const len = from.distanceTo(to);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const target = from.clone().lerp(to, t);
      const jag = len * 0.035 * (1 - t * 0.5);
      const q = target.add(new THREE.Vector3((rng() - 0.5) * jag * 2, (rng() - 0.5) * jag * 0.6, (rng() - 0.5) * jag * 2));
      if (i === n) q.copy(to);
      A.push(p.x, p.y, p.z);
      B.push(q.x, q.y, q.z);
      W.push(width);
      if (depth < 2 && rng() < 0.16 && t < 0.8) {
        const dir = new THREE.Vector3((rng() - 0.5) * 2, -0.6 - rng(), (rng() - 0.5) * 2).normalize();
        walk(q.clone(), q.clone().addScaledVector(dir, len * (0.12 + rng() * 0.2)), width * 0.45, depth + 1);
      }
      p = q;
    }
  };
  walk(top, ground, 1, 0);
  // A few horizontal "spider" channels under the base.
  for (let k = 0; k < 2; k++) {
    const dir = new THREE.Vector3((rng() - 0.5) * 2, (rng() - 0.6) * 0.15, (rng() - 0.5) * 2).normalize();
    walk(top.clone(), top.clone().addScaledVector(dir, 1500 + rng() * 2500), 0.22, 1);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(new Float32Array(A), 3));
  g.setAttribute('aB', new THREE.InstancedBufferAttribute(new Float32Array(B), 3));
  g.setAttribute('aW', new THREE.InstancedBufferAttribute(new Float32Array(W), 1));
  g.instanceCount = W.length;
  return g;
}

export class Lightning {
  readonly group = new THREE.Group();
  private readonly flashes: Flash[] = [];
  private readonly coreMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private rng = Math.random;
  private acc = new Map<number, number>();

  /** Current illumination at the camera (0..~4). */
  flash = 0;
  /** Sensor blowout from a very close strike. */
  blowout = 0;
  readonly flashDir = new THREE.Vector3(0, 1, 0);
  /** Strongest active flash for the sky shader: position + intensity. */
  readonly skyFlash = new THREE.Vector4();
  onThunder: ((distance: number, strength: number, dir: THREE.Vector3) => void) | null = null;
  onStrike: ((e: StrikeEvent) => void) | null = null;
  baseAlt = 1250;

  constructor() {
    const mk = (glow: boolean) =>
      new THREE.ShaderMaterial({
        uniforms: {
          uViewport: { value: new THREE.Vector2(1, 1) },
          uWidthScale: { value: glow ? 90 : 7 },
          uIntensity: { value: 0 },
          uGlow: { value: glow ? 1 : 0 },
          ...skyFogUniforms(),
        },
        vertexShader: BOLT_VERT,
        fragmentShader: BOLT_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // Screen-space quads come out with either winding.
        side: THREE.DoubleSide,
      });
    this.coreMat = mk(false);
    this.glowMat = mk(true);
  }

  /** Force a strike (dev / scripted moments). */
  strike(storm: StormCell, cloudToGround: boolean, at?: THREE.Vector3): void {
    const r = this.rng;
    const R = storm.radius;
    const sp = Math.hypot(storm.vx, storm.vz) || 1;
    const fx = storm.vx / sp, fz = storm.vz / sp;
    // Strikes cluster in the forward-flank core, ahead-left of the updraft.
    const a = R * (0.2 + r() * 1.1);
    const b = -R * (0.1 + r() * 0.7);
    const x = at ? at.x : storm.x + fx * a + -fz * b + (r() - 0.5) * R * 0.4;
    const z = at ? at.z : storm.z + fz * a + fx * b + (r() - 0.5) * R * 0.4;
    const pos = new THREE.Vector3(x, this.baseAlt + 1500 + r() * 3500, z);
    let ground: THREE.Vector3 | null = null;
    let bolt: THREE.Mesh | null = null;
    if (cloudToGround) {
      ground = new THREE.Vector3(x + (r() - 0.5) * 900, 0, z + (r() - 0.5) * 900);
      ground.y = heightAt(ground.x, ground.z);
      const top = new THREE.Vector3(x, this.baseAlt - 100, z);
      const geo = buildBoltGeometry(top, ground, r);
      bolt = new THREE.Mesh(geo, this.coreMat);
      const glow = new THREE.Mesh(geo, this.glowMat);
      bolt.add(glow);
      bolt.frustumCulled = false;
      glow.frustumCulled = false;
      bolt.renderOrder = 60;
      this.group.add(bolt);
    }
    const n = 1 + Math.floor(r() * (cloudToGround ? 4 : 3));
    const strokes = [0];
    for (let i = 1; i < n; i++) strokes.push(strokes[i - 1] + 0.04 + r() * 0.12);
    this.flashes.push({
      pos: ground ? ground.clone().setY(this.baseAlt) : pos,
      ground,
      t: 0,
      strokes,
      duration: strokes[strokes.length - 1] + 0.25,
      strength: (cloudToGround ? 1 : 0.55) * (0.6 + r() * 0.6) * storm.intensity,
      bolt,
      storm,
    });
  }

  update(dt: number, storms: readonly StormCell[], cam: THREE.Vector3, viewport: THREE.Vector2): void {
    for (const s of storms) {
      // A tornadic storm is electrically violent: near-constant flashes and bolts.
      const rate = 0.13 * s.intensity * s.intensity * (1 + s.meso * 0.5) * (s.stage === 'developing' ? 0.4 : s.stage === 'tornadic' ? 2.6 : 1);
      let a = (this.acc.get(s.id) ?? Math.random()) + dt * rate;
      while (a >= 1) {
        a -= 1 + Math.random() * 0.6;
        this.strike(s, Math.random() < 0.32);
      }
      this.acc.set(s.id, a);
    }
    (this.coreMat.uniforms.uViewport.value as THREE.Vector2).copy(viewport);
    (this.glowMat.uniforms.uViewport.value as THREE.Vector2).copy(viewport);

    let total = 0;
    let best = 0;
    let boltI = 0;
    this.blowout = Math.max(0, this.blowout - dt * 4);
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const prevT = f.t;
      f.t += dt;
      let env = 0;
      for (const s of f.strokes) {
        if (f.t >= s) env = Math.max(env, Math.exp(-(f.t - s) / 0.05));
        // Each new stroke: thunder and events.
        if (prevT < s && f.t >= s && s === 0) {
          const target = f.ground ?? f.pos;
          const d = Math.hypot(target.x - cam.x, target.z - cam.z);
          const dir = new THREE.Vector3().subVectors(target, cam).normalize();
          this.onThunder?.(d, f.strength * (f.ground ? 1 : 0.6), dir);
          this.onStrike?.({ position: target.clone(), cloudToGround: !!f.ground, distance: d });
          if (f.ground && d < 900) this.blowout = Math.min(1.5, (900 - d) / 500);
        }
      }
      const d = Math.hypot(f.pos.x - cam.x, f.pos.z - cam.z);
      const atCam = f.strength * env * (f.ground ? 1.2 : 0.7) / (1 + (d / 2500) ** 2);
      total += atCam;
      if (env * f.strength > best) {
        best = env * f.strength;
        this.skyFlash.set(f.pos.x, f.pos.y, f.pos.z, env * f.strength);
        this.flashDir.subVectors(f.pos, cam).normalize();
      }
      if (f.bolt) {
        boltI = Math.max(boltI, env * 60 + (f.t < f.duration ? 4 : 0));
        f.bolt.visible = f.t < f.duration;
      }
      if (f.t > f.duration + 0.1) {
        if (f.bolt) {
          this.group.remove(f.bolt);
          f.bolt.geometry.dispose();
        }
        this.flashes.splice(i, 1);
      }
    }
    if (best === 0) this.skyFlash.w = 0;
    this.coreMat.uniforms.uIntensity.value = boltI;
    this.glowMat.uniforms.uIntensity.value = boltI;
    this.flash = Math.min(4, total);
  }

  /** Active cloud-to-ground bolts (for footage scoring). */
  activeBolts(): THREE.Vector3[] {
    return this.flashes.filter((f) => f.ground && f.t < f.duration).map((f) => f.ground!);
  }
}
