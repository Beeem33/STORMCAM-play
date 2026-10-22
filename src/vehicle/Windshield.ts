import * as THREE from 'three';
import type { GlassFrame, VehicleParts } from './VehicleModel';

/**
 * Water on the windshield and the wipers that clear it.
 *
 * Droplets live on a 512×256 canvas in windshield UV space (u across, v up the
 * glass). Each pixel stores a refraction normal (RG) and water thickness (B);
 * the sensor post pass bends the image through it. Wiper blades sweep across
 * the same space and delete the drops they pass over.
 *
 * The glass scene renders proxies of the vehicle interior (alpha = "attached
 * to the car, don't motion-blur") and then the windshield with the droplet
 * texture, preserving that alpha.
 */

const W = 512;
const H = 256;

interface Drop {
  x: number;
  y: number;
  r: number;
  vy: number;
  stretch: number;
}

export type WiperMode = 'auto' | 'off' | 'low' | 'high';

export class Windshield {
  readonly glassScene = new THREE.Scene();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly sprite: HTMLCanvasElement;
  private readonly dirt: HTMLCanvasElement;
  private readonly cracks: HTMLCanvasElement;
  private readonly drops: Drop[] = [];
  private readonly proxies: { src: THREE.Object3D; proxy: THREE.Mesh }[] = [];
  private spawnAcc = 0;

  mode: WiperMode = 'auto';
  private wiperAngle = 0;
  private wiperDir = 0; // 1 up, -1 down, 0 parked
  private wiperPause = 0;
  private prevAngle = 0;
  onStroke: (() => void) | null = null;
  /** Current effective wiper speed label for the HUD. */
  activeMode: 'off' | 'int' | 'low' | 'high' = 'off';

  private readonly frame: GlassFrame;
  private readonly _q = new THREE.Quaternion();

  constructor(private readonly parts: VehicleParts) {
    this.frame = parts.glass;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.sprite = makeDropSprite(64);
    this.dirt = makeDirt(this.frame);
    this.cracks = document.createElement('canvas');
    this.cracks.width = W;
    this.cracks.height = H;

    // Interior proxies: write "attached to car" into alpha.
    // One occluder material per face side, so single-sided body panels stay
    // invisible from inside the cabin, exactly as in the main render.
    const occMats = new Map<THREE.Side, THREE.ShaderMaterial>();
    const occFor = (side: THREE.Side) => {
      let m = occMats.get(side);
      if (!m) {
        m = new THREE.ShaderMaterial({
          vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'void main(){ gl_FragColor = vec4(0.5, 0.5, 0.0, 1.0); }',
          side,
        });
        occMats.set(side, m);
      }
      return m;
    };
    for (const src of parts.interior) {
      src.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const srcMat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
        if (srcMat.transparent && srcMat.opacity < 0.5) return; // glass: seen through, not an occluder
        const p = new THREE.Mesh(m.geometry, occFor(srcMat.side));
        p.matrixAutoUpdate = false;
        // We copy the source's world matrix each frame; stop the scene graph from overwriting it.
        p.matrixWorldAutoUpdate = false;
        p.frustumCulled = false;
        this.glassScene.add(p);
        this.proxies.push({ src: m, proxy: p });
      });
    }
    const glassMat = new THREE.ShaderMaterial({
      uniforms: { tDrops: { value: this.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDrops; varying vec2 vUv;
        void main(){ vec4 d = texture2D(tDrops, vUv); gl_FragColor = vec4(d.rg, d.b, 0.0); }`,
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
    });
    const ws = new THREE.Mesh(parts.windshield.geometry, glassMat);
    ws.matrixAutoUpdate = false;
    ws.matrixWorldAutoUpdate = false;
    ws.frustumCulled = false;
    ws.renderOrder = 100;
    this.glassScene.add(ws);
    this.proxies.push({ src: parts.windshield, proxy: ws });
  }

  /** Glass-space (metres from the bottom-centre, along the glass) → canvas px. */
  private toCanvas(gx: number, gy: number): [number, number] {
    const f = this.frame;
    const v = gy / f.length;
    const half = f.baseHalf + (f.topHalf - f.baseHalf) * v;
    return [((gx / half + 1) / 2) * W, (1 - v) * H];
  }
  private toGlass(x: number, y: number): [number, number] {
    const f = this.frame;
    const v = 1 - y / H;
    const half = f.baseHalf + (f.topHalf - f.baseHalf) * v;
    return [((x / W) * 2 - 1) * half, v * f.length];
  }

  /**
   * @param rain 0..1 rain rate
   * @param hail 0..1 hail rate
   * @param fwdSpeed forward speed (m/s); fast driving pushes water up the glass
   * @param cracks 0..1 accumulated windshield damage
   */
  update(dt: number, rain: number, hail: number, fwdSpeed: number, cracks: number): void {
    // --- Wipers.
    let speed = 0;
    let pause = 0;
    const wet = rain + hail * 0.5;
    let mode = this.mode;
    if (mode === 'auto') mode = wet < 0.02 ? 'off' : wet < 0.6 ? 'low' : 'high';
    if (mode === 'low') {
      speed = 3.1;
      pause = wet < 0.22 && this.mode === 'auto' ? 2.5 : 0;
    } else if (mode === 'high') speed = 4.6;
    this.activeMode = mode === 'off' ? 'off' : pause > 0 ? 'int' : mode;
    this.prevAngle = this.wiperAngle;
    if (this.wiperDir === 0) {
      if (speed > 0) {
        this.wiperPause -= dt;
        if (this.wiperPause <= 0) this.wiperDir = 1;
      }
    } else {
      this.wiperAngle += this.wiperDir * speed * dt * (speed > 0 ? 1 : 1);
      if (this.wiperDir > 0 && this.wiperAngle >= 1) {
        this.wiperAngle = 1;
        this.wiperDir = -1;
        this.onStroke?.();
      } else if (this.wiperDir < 0 && this.wiperAngle <= 0) {
        this.wiperAngle = 0;
        this.wiperDir = speed > 0 && pause === 0 ? 1 : 0;
        this.wiperPause = pause;
        this.onStroke?.();
      }
    }
    // Ease the blade motion at the ends of travel.
    const ease = (a: number) => 0.5 - 0.5 * Math.cos(a * Math.PI);
    for (const w of this.frame.wipers) {
      w.obj.quaternion.copy(w.base).multiply(this._q.setFromAxisAngle(w.axis, ease(this.wiperAngle) * w.maxAngle));
    }

    // --- Spawn drops (more when driving into the rain).
    const flowBoost = 1 + Math.max(0, fwdSpeed) / 9;
    this.spawnAcc += dt * (rain * 260 * flowBoost + hail * 40);
    while (this.spawnAcc >= 1 && this.drops.length < 900) {
      this.spawnAcc -= 1;
      const big = Math.random() < 0.08;
      this.drops.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: big ? 3.5 + Math.random() * 3 : 1.2 + Math.random() * 2.4,
        vy: 0,
        stretch: 1,
      });
    }
    if (this.spawnAcc > 5) this.spawnAcc = 5;

    // --- Drop motion: airflow pushes drops up the glass above ~35 km/h; gravity pulls large ones down when slow.
    const air = Math.max(0, fwdSpeed - 9) * 1.8;
    for (const d of this.drops) {
      const mass = d.r * d.r;
      let target = 0;
      if (air > 0 && mass > 3) target = -air * Math.min(1, mass / 14) * (0.7 + Math.random() * 0.3);
      else if (mass > 20) target = 14;
      d.vy += (target - d.vy) * Math.min(1, dt * 4);
      d.y += d.vy * dt;
      d.stretch = 1 + Math.min(3, Math.abs(d.vy) / 25);
      if (Math.abs(d.vy) > 1) d.x += (Math.random() - 0.5) * 0.6;
    }
    // Evaporate / run off.
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (d.y < -8 || d.y > H + 8 || (rain < 0.01 && Math.random() < dt * 0.15)) this.drops.splice(i, 1);
    }

    // --- Wiper clearing: delete drops the blades swept over this frame.
    const a0 = Math.min(ease(this.prevAngle), ease(this.wiperAngle));
    const a1 = Math.max(ease(this.prevAngle), ease(this.wiperAngle));
    if (a1 - a0 > 1e-4) {
      for (let i = this.drops.length - 1; i >= 0; i--) {
        const d = this.drops[i];
        const [gx, gy] = this.toGlass(d.x, d.y);
        for (const wdef of this.frame.wipers) {
          const dx = gx - wdef.px;
          const dy = gy - wdef.py;
          const rho = Math.hypot(dx, dy);
          if (rho < 0.08 || rho > wdef.len + 0.04) continue;
          const phi = Math.atan2(dy, dx);
          if (phi >= a0 * wdef.maxAngle - 0.04 && phi <= a1 * wdef.maxAngle + 0.04) {
            this.drops.splice(i, 1);
            break;
          }
        }
      }
    }

    // --- Hail cracks.
    if (cracks > this.crackLevel + 0.06) this.addCrack();

    this.draw();
  }

  private crackLevel = 0;
  private addCrack(): void {
    this.crackLevel += 0.06;
    const g = this.cracks.getContext('2d')!;
    const cx = 60 + Math.random() * (W - 120);
    const cy = 30 + Math.random() * (H - 60);
    g.lineCap = 'round';
    const branches = 5 + Math.floor(Math.random() * 6);
    for (let b = 0; b < branches; b++) {
      let x = cx, y = cy;
      let a = Math.random() * Math.PI * 2;
      const n = 6 + Math.floor(Math.random() * 10);
      for (let s = 0; s < n; s++) {
        const nx = x + Math.cos(a) * (4 + Math.random() * 9);
        const ny = y + Math.sin(a) * (4 + Math.random() * 9);
        // Encode a sharp refraction kink: normal perpendicular to the crack.
        const px = -Math.sin(a), py = Math.cos(a);
        g.strokeStyle = `rgb(${Math.round(128 + px * 120)}, ${Math.round(128 - py * 120)}, 235)`;
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(nx, ny);
        g.stroke();
        x = nx;
        y = ny;
        a += (Math.random() - 0.5) * 0.9;
      }
    }
    // Star impact.
    g.fillStyle = 'rgb(128,128,255)';
    g.beginPath();
    g.arc(cx, cy, 2.5, 0, Math.PI * 2);
    g.fill();
  }

  private draw(): void {
    const g = this.ctx;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.drawImage(this.dirt, 0, 0);
    g.drawImage(this.cracks, 0, 0);
    for (const d of this.drops) {
      const s = d.r * 2;
      g.globalAlpha = 0.95;
      g.drawImage(this.sprite, d.x - d.r, d.y - d.r * d.stretch, s, s * d.stretch);
    }
    g.globalAlpha = 1;
    this.texture.needsUpdate = true;
  }

  /** Sync proxy transforms to the real interior meshes. Call after the vehicle moved. */
  syncProxies(): void {
    for (const { src, proxy } of this.proxies) {
      src.updateWorldMatrix(true, false);
      proxy.matrixWorld.copy(src.matrixWorld);
    }
  }

  clear(): void {
    this.drops.length = 0;
  }
}

function makeDropSprite(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - r) / r;
      const dy = (y + 0.5 - r) / r;
      // Drops sag: flatter on top, rounder at the bottom.
      const d2 = dx * dx + dy * dy * (dy < 0 ? 1.25 : 0.9);
      const i = (y * size + x) * 4;
      if (d2 >= 1) {
        img.data[i + 3] = 0;
        continue;
      }
      const h = Math.sqrt(1 - d2);
      img.data[i] = 128 + dx * 125;
      img.data[i + 1] = 128 - dy * 125;
      img.data[i + 2] = 120 + h * 135;
      img.data[i + 3] = Math.min(255, (1 - d2) * 900);
    }
  g.putImageData(img, 0, 0);
  return c;
}

function makeDirt(frame: GlassFrame): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(128,128,0)';
  g.fillRect(0, 0, W, H);
  // Faint road film concentrated low on the glass, wiper arcs, a few bug spots.
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * W;
    const y = H * (0.35 + Math.random() * 0.65);
    const r = 6 + Math.random() * 30;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(128,128,26,0.5)');
    grad.addColorStop(1, 'rgba(128,128,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.strokeStyle = 'rgba(128,128,30,0.35)';
  // Faint arcs where the blades have smeared road film.
  for (const w of frame.wipers) {
    const [px, py] = [((w.px / frame.baseHalf + 1) / 2) * W, H + 4];
    for (const rr of [w.len * 0.95, w.len, w.len * 0.55]) {
      g.lineWidth = 2 + Math.random() * 3;
      g.beginPath();
      g.arc(px, py, (rr / frame.length) * H * 1.02, Math.PI, Math.PI * 1.98);
      g.stroke();
    }
  }
  for (let i = 0; i < 14; i++) {
    g.fillStyle = 'rgba(128,128,90,0.8)';
    g.beginPath();
    g.arc(Math.random() * W, Math.random() * H * 0.8, 0.8 + Math.random() * 1.4, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}
