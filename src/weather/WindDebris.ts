import * as THREE from 'three';
import { heightAt } from '../environment/WorldShape';
import { patchMaterial } from '../rendering/Atmosphere';

/**
 * Leaves, shredded grass, straw and twigs blowing past the camera. Nothing
 * shows in a light breeze; as the wind rises (a gust front, the tornado's
 * inflow) more and more bits stream through the air, tumbling and skipping
 * along the ground. Simulated on the CPU in a box that follows the camera.
 */

const N = 900;
const RADIUS = 38;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export class WindDebris {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(N * 3);
  private readonly vel = new Float32Array(N * 3);
  private readonly rot = new Float32Array(N * 3);
  private readonly spin = new Float32Array(N * 3);
  private readonly size = new Float32Array(N);
  private readonly alive = new Uint8Array(N);
  private time = 0;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 0.55);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    patchMaterial(mat);
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const palette = [
      [0.2, 0.26, 0.09], // green leaf
      [0.32, 0.27, 0.12], // dry leaf
      [0.55, 0.47, 0.26], // straw
      [0.24, 0.17, 0.1], // bark / twig
      [0.38, 0.33, 0.24], // grass clippings
    ];
    const colors = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      colors.set(palette[i % palette.length], i * 3);
      this.size[i] = 0.035 + Math.random() ** 2 * 0.12;
    }
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  }

  clear(): void {
    this.alive.fill(0);
    this.mesh.count = 0;
  }

  /** @param wind wind at the camera (m/s, world) */
  update(dt: number, cam: THREE.Vector3, wind: THREE.Vector3): void {
    this.time += dt;
    const ws = Math.hypot(wind.x, wind.z);
    // How much is in the air: none below ~6 m/s, all of it by ~35 m/s.
    const want = Math.floor(N * THREE.MathUtils.clamp((ws - 6) / 29, 0, 1));
    const dx = ws > 0.1 ? wind.x / ws : 1;
    const dz = ws > 0.1 ? wind.z / ws : 0;
    // Instances 0..want-1 are the active ones, so instance index == particle index.
    let n = 0;
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      if (i >= want) {
        this.alive[i] = 0;
        continue;
      }
      let x = this.pos[o], y = this.pos[o + 1], z = this.pos[o + 2];
      const rx = x - cam.x, rz = z - cam.z;
      const g = this.alive[i] ? heightAt(x, z) : 0;
      if (!this.alive[i] || rx * rx + rz * rz > RADIUS * RADIUS || y < g - 0.5 || y > cam.y + 25) {
        // Enter from the upwind side of the box (or anywhere on first fill).
        const fresh = !this.alive[i];
        const lat = (Math.random() - 0.5) * 2 * RADIUS;
        const back = fresh ? (Math.random() - 0.5) * 2 * RADIUS : -RADIUS * (0.85 + Math.random() * 0.15);
        x = cam.x + dx * back - dz * lat;
        z = cam.z + dz * back + dx * lat;
        y = heightAt(x, z) + 0.1 + Math.random() ** 2 * 9;
        this.vel[o] = wind.x * 0.7;
        this.vel[o + 1] = 0;
        this.vel[o + 2] = wind.z * 0.7;
        for (let k = 0; k < 3; k++) {
          this.rot[o + k] = Math.random() * 6.28;
          this.spin[o + k] = (Math.random() - 0.5) * (6 + ws * 0.4);
        }
        this.alive[i] = 1;
      }
      // Follow the wind with a little lag, plus gusty eddies; light bits float, heavy ones sink.
      const t = this.time;
      const eddy = Math.sin(t * 3.1 + i * 1.7) * 0.25 + Math.sin(t * 7.3 + i * 0.6) * 0.12;
      const k = Math.min(1, dt * (2.5 + 6 / (1 + this.size[i] * 30)));
      this.vel[o] += (wind.x * (1 + eddy) - this.vel[o]) * k;
      this.vel[o + 2] += (wind.z * (1 + eddy) - this.vel[o + 2]) * k;
      this.vel[o + 1] += ((wind.y * 0.6 + Math.sin(t * 2.2 + i) * ws * 0.08 - 1.2) - this.vel[o + 1]) * k;
      x += this.vel[o] * dt;
      y += this.vel[o + 1] * dt;
      z += this.vel[o + 2] * dt;
      const gh = heightAt(x, z);
      if (y < gh + 0.03) {
        // Skitter along the ground and bounce back up.
        y = gh + 0.03;
        this.vel[o + 1] = Math.abs(this.vel[o + 1]) * 0.4 + Math.random() * ws * 0.08;
      }
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
      for (let k2 = 0; k2 < 3; k2++) this.rot[o + k2] += this.spin[o + k2] * dt;
      _q.setFromEuler(_e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]));
      _s.setScalar(this.size[i]);
      _m.compose(_p.set(x, y, z), _q, _s);
      this.mesh.setMatrixAt(n, _m);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
