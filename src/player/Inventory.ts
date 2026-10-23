import * as THREE from 'three';
import { patchMaterial } from '../rendering/Atmosphere';

/**
 * Three hand-held items, body-cam style: nothing on the HUD — the selected
 * item rises into the bottom right of the shot in the chaser's hand, and is
 * gone when he puts it away. 1/2/3 pick a slot (again to put it away), the
 * mouse wheel cycles through empty hands → 1 → 2 → 3. Left click uses it.
 *
 *   1  Camcorder — click to start/stop filming (tally light on while rolling)
 *   2  Rugged tablet — live radar on the screen
 *   3  Flashlight — click for the beam
 */

export type ItemId = 'camera' | 'tablet' | 'flashlight';
export const SLOTS: ItemId[] = ['camera', 'tablet', 'flashlight'];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();

export class Inventory {
  /** -1 = hands empty. */
  selected = -1;
  flashlightOn = false;
  readonly group = new THREE.Group();
  private readonly models: Record<ItemId, THREE.Object3D>;
  private readonly tally: THREE.MeshStandardMaterial;
  private readonly lcd: THREE.MeshBasicMaterial;
  private readonly lcdCtx: CanvasRenderingContext2D;
  private readonly lcdTex: THREE.CanvasTexture;
  readonly tabletCanvas: HTMLCanvasElement;
  private readonly tabletTex: THREE.CanvasTexture;
  private raise = 0;
  private shown = -1;
  private sway = new THREE.Vector2();
  private lastYaw = 0;
  private lastPitch = 0;
  private time = 0;

  constructor() {
    this.group.name = 'inventory-viewmodel';
    const mat = (color: string, rough = 0.6, metal = 0) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
      patchMaterial(m);
      return m;
    };
    const black = mat('#17181a', 0.55), grey = mat('#3a3d41', 0.5, 0.3), rubber = mat('#0d0d0e', 0.9);

    // Camcorder.
    const cam = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.19), black);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.07, 20), grey);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.005, -0.12);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.027, 20), mat('#0a1018', 0.05, 0.2));
    glass.position.set(0, 0.005, -0.1551);
    glass.rotation.y = Math.PI;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.14), rubber);
    strap.position.set(0.044, -0.005, 0);
    this.tally = new THREE.MeshStandardMaterial({ color: '#300', emissive: new THREE.Color('#ff1a10'), emissiveIntensity: 0 });
    const tallyLed = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), this.tally);
    tallyLed.position.set(-0.02, 0.045, -0.08);
    // Flip-out screen facing the operator.
    const lc = document.createElement('canvas');
    lc.width = 128;
    lc.height = 96;
    this.lcdCtx = lc.getContext('2d')!;
    this.lcdTex = new THREE.CanvasTexture(lc);
    this.lcdTex.colorSpace = THREE.SRGBColorSpace;
    this.lcd = new THREE.MeshBasicMaterial({ map: this.lcdTex, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.052), this.lcd);
    screen.position.set(-0.065, 0.01, -0.02);
    screen.rotation.y = -0.35;
    const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.056, 0.074), black);
    hinge.position.set(-0.064, 0.01, -0.02);
    hinge.rotation.y = -0.35;
    hinge.position.x -= 0.004;
    cam.add(body, lens, glass, strap, tallyLed, hinge, screen);
    cam.rotation.y = 0.12;

    // Rugged tablet with the live radar.
    const tab = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.17, 0.018), mat('#2a2c2e', 0.75));
    const bumpers = new THREE.Mesh(new THREE.BoxGeometry(0.262, 0.182, 0.012), mat('#c4661d', 0.7));
    bumpers.position.z = 0.004;
    this.tabletCanvas = document.createElement('canvas');
    this.tabletCanvas.width = this.tabletCanvas.height = 384;
    this.tabletTex = new THREE.CanvasTexture(this.tabletCanvas);
    this.tabletTex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.148), new THREE.MeshBasicMaterial({ map: this.tabletTex, toneMapped: false }));
    disp.position.z = 0.0101;
    tab.add(bumpers, shell, disp);
    tab.rotation.set(-0.55, -0.25, 0.05);

    // Flashlight.
    const fl = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.16, 16), mat('#24272b', 0.4, 0.6));
    tube.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.018, 0.05, 18), mat('#2c2f33', 0.35, 0.7));
    head.rotation.x = Math.PI / 2;
    head.position.z = -0.1;
    const lensF = new THREE.Mesh(new THREE.CircleGeometry(0.023, 18), new THREE.MeshBasicMaterial({ color: '#e8eef0' }));
    lensF.position.z = -0.1251;
    lensF.rotation.y = Math.PI;
    fl.add(tube, head, lensF);
    fl.userData.lens = lensF;

    this.models = { camera: cam, tablet: tab, flashlight: fl };
    for (const m of Object.values(this.models)) {
      m.visible = false;
      m.traverse((o) => (o.frustumCulled = false));
      this.group.add(m);
    }
    this.drawLcd(false, 0);
  }

  get item(): ItemId | null {
    return this.selected >= 0 ? SLOTS[this.selected] : null;
  }

  select(slot: number): void {
    this.selected = this.selected === slot ? -1 : slot;
  }

  /** Mouse wheel: step through empty hands → 1 → 2 → 3. */
  scroll(steps: number): void {
    const n = SLOTS.length + 1;
    this.selected = ((((this.selected + 1 + steps) % n) + n) % n) - 1;
  }

  reset(): void {
    this.selected = -1;
    this.flashlightOn = false;
    this.raise = 0;
    this.shown = -1;
  }

  /**
   * Place the held item in front of the camera (bottom right, lagging a
   * touch behind fast looks), raising and lowering it as the slot changes.
   */
  update(dt: number, cam: THREE.Camera, recording: boolean, clipTime: number, hidden: boolean): void {
    this.time += dt;
    const want = hidden ? -1 : this.selected;
    // Lower the old item fully before raising the new one.
    if (this.shown !== want) {
      this.raise = Math.max(0, this.raise - dt * 6);
      if (this.raise === 0) this.shown = want;
    } else this.raise = Math.min(1, this.raise + dt * 5);
    for (const [k, m] of Object.entries(this.models)) m.visible = this.shown >= 0 && SLOTS[this.shown] === k && this.raise > 0.01;
    this.tally.emissiveIntensity = recording && Math.sin(this.time * 6) > -0.3 ? 4 : 0;
    if (this.shown === 0) this.drawLcd(recording, clipTime);
    if (this.shown < 0) return;

    // Sway: the hand lags behind quick turns.
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    const dy = THREE.MathUtils.euclideanModulo(_e.y - this.lastYaw + Math.PI, Math.PI * 2) - Math.PI;
    const dp = _e.x - this.lastPitch;
    this.lastYaw = _e.y;
    this.lastPitch = _e.x;
    this.sway.x += (-dy * 0.6 - this.sway.x) * Math.min(1, dt * 8);
    this.sway.y += (-dp * 0.6 - this.sway.y) * Math.min(1, dt * 8);
    const ease = 1 - (1 - this.raise) ** 3;
    const item = SLOTS[this.shown];
    const base = item === 'tablet' ? [0.06, -0.2, -0.36] : item === 'camera' ? [0.17, -0.17, -0.38] : [0.19, -0.19, -0.36];
    const breathe = Math.sin(this.time * 1.7) * 0.004;
    _p.set(base[0] + this.sway.x * 0.25, base[1] - (1 - ease) * 0.28 + breathe + this.sway.y * 0.25, base[2]);
    _m.compose(_p, _q.identity(), new THREE.Vector3(1, 1, 1));
    this.group.matrixAutoUpdate = false;
    this.group.matrix.multiplyMatrices(cam.matrixWorld, _m);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** World position and forward direction of the flashlight's lens (for the beam). */
  lensPose(pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (this.shown !== 2 || this.raise < 0.5) return false;
    const lens = this.models.flashlight.userData.lens as THREE.Object3D;
    this.group.updateMatrixWorld(true);
    lens.getWorldPosition(pos);
    dir.set(0, 0, -1).transformDirection(this.models.flashlight.matrixWorld);
    return true;
  }

  /** The tablet's screen needs redrawing (it's showing). */
  get tabletShown(): boolean {
    return this.shown === 1;
  }

  markTabletDirty(): void {
    this.tabletTex.needsUpdate = true;
  }

  private lastLcd = '';
  private drawLcd(recording: boolean, clipTime: number): void {
    const key = `${recording}|${Math.floor(clipTime)}|${Math.floor(this.time * 2) % 2}`;
    if (key === this.lastLcd) return;
    this.lastLcd = key;
    const g = this.lcdCtx;
    g.fillStyle = '#0c1418';
    g.fillRect(0, 0, 128, 96);
    g.fillStyle = 'rgba(120,150,160,0.25)';
    g.fillRect(8, 30, 112, 50);
    g.font = 'bold 16px "IBM Plex Mono", monospace';
    if (recording) {
      if (Math.floor(this.time * 2) % 2 === 0) {
        g.fillStyle = '#ff2a20';
        g.beginPath();
        g.arc(16, 16, 6, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#ffffff';
      const s = Math.floor(clipTime);
      g.fillText(`REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, 28, 22);
    } else {
      g.fillStyle = '#cfd6d8';
      g.fillText('STBY', 10, 22);
    }
    this.lcdTex.needsUpdate = true;
  }
}
