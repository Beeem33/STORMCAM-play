import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { CG_HEIGHT, DASHCAM_POS, DRIVER_DOOR, DRIVER_EYE, type GlassFrame, type VehicleParts, type WiperRig } from './VehicleModel';

/**
 * Loads the Blender-built chase SUV (`public/models/chaser.glb`, made by
 * `models/chaser_build.py`) and adapts it to the VehicleParts the game drives:
 * wheels, steering, wipers, gauges, lights and camera mounts are found by name.
 */

const URL_GLB = `${import.meta.env.BASE_URL}models/chaser.glb`;

/** Instrument cluster painted on a canvas: dials once, needles each frame. */
export class GaugeCluster {
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshStandardMaterial;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly face: HTMLCanvasElement;
  private last = '';

  constructor() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 192;
    this.ctx = c.getContext('2d')!;
    this.face = document.createElement('canvas');
    this.face.width = 512;
    this.face.height = 192;
    const g = this.face.getContext('2d')!;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, 512, 192);
    const dial = (cx: number, cy: number, r: number, max: number, step: number, label: string) => {
      g.strokeStyle = '#d8d6cf';
      g.fillStyle = '#d8d6cf';
      g.lineWidth = 2;
      g.font = '15px Inter, Arial';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let v = 0; v <= max; v += step / 2) {
        const a = Math.PI * 0.75 + (v / max) * Math.PI * 1.5;
        const major = v % step === 0;
        const r0 = r - (major ? 14 : 8);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        g.stroke();
        if (major) g.fillText(String(label === 'x1000' ? v / 1000 : v), cx + Math.cos(a) * (r - 28), cy + Math.sin(a) * (r - 28));
      }
      g.font = '11px Inter, Arial';
      g.fillText(label, cx, cy + r * 0.45);
    };
    dial(150, 100, 84, 120, 20, 'MPH');
    dial(372, 100, 70, 6000, 1000, 'x1000');
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshStandardMaterial({
      color: '#1c1c1c',
      roughness: 0.35,
      map: this.texture,
      emissive: new THREE.Color('#ffffff'),
      emissiveMap: this.texture,
      emissiveIntensity: 0.06,
    });
    this.update(0, 750, false);
  }

  update(mph: number, rpm: number, lit: boolean): void {
    const key = `${Math.round(mph)}|${Math.round(rpm / 25)}|${lit}`;
    if (key === this.last) return;
    this.last = key;
    const g = this.ctx;
    g.drawImage(this.face, 0, 0);
    const needle = (cx: number, cy: number, r: number, frac: number) => {
      const a = Math.PI * 0.75 + Math.min(1, Math.max(0, frac)) * Math.PI * 1.5;
      g.strokeStyle = '#ff5a1f';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10);
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.stroke();
      g.fillStyle = '#222';
      g.beginPath();
      g.arc(cx, cy, 7, 0, Math.PI * 2);
      g.fill();
    };
    needle(150, 100, 72, mph / 120);
    needle(372, 100, 58, rpm / 6000);
    this.texture.needsUpdate = true;
    this.material.emissiveIntensity = lit ? 0.55 : 0.06;
  }
}

/** Side decal: lightning bolt and the crew name, drawn on a transparent canvas. */
function decalTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  // Lightning bolt sweeping along the side.
  g.fillStyle = 'rgba(232,236,240,0.92)';
  g.beginPath();
  const pts = [[30, 300], [330, 250], [300, 290], [640, 215], [600, 262], [1000, 170], [560, 300], [600, 262], [270, 330], [300, 290]];
  g.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  g.closePath();
  g.fill();
  // Lettering.
  g.font = '900 italic 150px "Arial Black", Impact, sans-serif';
  g.textBaseline = 'alphabetic';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(10,10,10,0.95)';
  g.strokeText('STORMCAM', 120, 470);
  g.fillStyle = '#f2f2f0';
  g.fillText('STORMCAM', 120, 470);
  g.font = '700 46px Arial, sans-serif';
  g.fillStyle = '#d23a2a';
  g.fillText('SEVERE WEATHER UNIT', 360, 140);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export async function loadChaserModel(): Promise<VehicleParts> {
  const gltf = await new GLTFLoader().loadAsync(URL_GLB);
  const scene = gltf.scene;
  const find = (name: string) => scene.getObjectByName(name) ?? null;
  const need = (name: string) => {
    const o = find(name);
    if (!o) throw new Error(`chaser.glb is missing "${name}"`);
    return o;
  };

  const root = new THREE.Group();
  root.name = 'vehicle-model';
  root.position.y = -CG_HEIGHT;
  root.add(scene);
  scene.updateMatrixWorld(true);

  // Materials by name.
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mats.set(mt.name, mt as THREE.MeshStandardMaterial);
  });
  const mat = (n: string) => mats.get(n) ?? new THREE.MeshStandardMaterial();
  const paint = mat('Paint');
  // Satin rather than dead flat, so the black hood catches a soft sky sheen from the seat.
  paint.roughness = Math.min(paint.roughness, 0.34);
  paint.envMapIntensity = 1.0;
  // The body shell is single-sided; from the cabin the A-pillars would show the sky through them.
  paint.side = THREE.DoubleSide;
  mat('Trim').side = THREE.DoubleSide;
  const glassMat = mat('Glass');
  glassMat.envMapIntensity = 1.2;
  for (const [n, m] of mats) {
    // The cabin sits under a roof: keep sky reflections faint inside. With no
    // bounce light, the true-to-life dark trim reads as black under storm light, so lift it a little.
    if (/Dash|Fabric|Headliner|Interior|Seat|Carpet|Plastic|Door|^Wheel$|Gear|Knob/i.test(n)) {
      m.envMapIntensity = 0.12;
      m.color.multiplyScalar(1.6);
    }
  }
  const headlightMat = mat('Headlight');
  if (headlightMat.emissive.getHex() === 0) headlightMat.emissive.set('#fff4e0');
  headlightMat.emissiveIntensity = 0;
  const taillightMat = mat('Taillight');
  if (taillightMat.emissive.getHex() === 0) taillightMat.emissive.set('#ff1a0a');
  const ledMat = mat('LEDBar');
  if (ledMat.emissive.getHex() === 0) ledMat.emissive.set('#f4f8ff');
  ledMat.emissiveIntensity = 0;

  // Windshield: our own thin, faintly reflective glass (water is drawn by the glass pass).
  const windshield = need('Windshield') as THREE.Mesh;
  windshield.material = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#0d1012'),
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMapIntensity: 0.6,
  });
  windshield.renderOrder = 10;

  // Points in the vehicle's ground frame (relative to the model root, before the CG offset).
  const groundPos = (o: THREE.Object3D) => {
    const v = new THREE.Vector3();
    // getWorldPosition also applies the root's CG offset; undo it so y=0 is the ground.
    return scene.worldToLocal(o.getWorldPosition(v));
  };
  const eye = find('EyeDriver');
  if (eye) DRIVER_EYE.copy(groundPos(eye));
  const dash = find('Dashcam');
  if (dash) DASHCAM_POS.copy(groundPos(dash));
  const door = find('DoorDriver');
  if (door) DRIVER_DOOR.copy(groundPos(door));

  // Wheels: wrap each mesh as pivot (steer) → spin group → mesh, like the procedural model.
  const wheels: THREE.Group[] = [];
  for (const n of ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']) {
    const mesh = need(n);
    const pivot = new THREE.Group();
    pivot.name = n + '-pivot';
    const spin = new THREE.Group();
    spin.name = 'spin';
    pivot.position.copy(groundPos(mesh));
    mesh.parent!.remove(mesh);
    mesh.position.set(0, 0, 0);
    spin.add(mesh);
    pivot.add(spin);
    scene.add(pivot);
    wheels.push(pivot);
  }

  // Steering wheel turns about its column (Blender local Z → glTF local Y).
  const steeringWheel = need('SteeringWheel');

  // Wipers and the glass frame, measured from the windshield mesh.
  windshield.updateMatrixWorld(true);
  const pos = windshield.geometry.getAttribute('position') as THREE.BufferAttribute;
  const uv = windshield.geometry.getAttribute('uv') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  // The droplet canvas wants v=0 along the bottom edge of the glass. glTF stores
  // v flipped relative to Blender, so check which edge is lower and flip if needed.
  {
    let lowV = 0, highV = 0, nl = 0, nh = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = scene.worldToLocal(p.fromBufferAttribute(pos, i).applyMatrix4(windshield.matrixWorld)).y;
      if (uv.getY(i) < 0.04) { lowV += y; nl++; }
      else if (uv.getY(i) > 0.96) { highV += y; nh++; }
    }
    if (nl && nh && lowV / nl > highV / nh) {
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      uv.needsUpdate = true;
    }
  }
  const base = { c: new THREE.Vector3(), n: 0, half: 0 };
  const top = { c: new THREE.Vector3(), n: 0, half: 0 };
  for (let i = 0; i < pos.count; i++) {
    scene.worldToLocal(p.fromBufferAttribute(pos, i).applyMatrix4(windshield.matrixWorld));
    const v = uv.getY(i);
    if (v < 0.04) {
      base.c.add(p);
      base.n++;
      base.half = Math.max(base.half, Math.abs(p.x));
    } else if (v > 0.96) {
      top.c.add(p);
      top.n++;
      top.half = Math.max(top.half, Math.abs(p.x));
    }
  }
  base.c.divideScalar(Math.max(1, base.n));
  top.c.divideScalar(Math.max(1, top.n));
  const upDir = new THREE.Vector3().subVectors(top.c, base.c);
  const length = upDir.length();
  upDir.normalize();
  const wipers: WiperRig[] = [];
  for (const n of ['Wiper_L', 'Wiper_R']) {
    const w = find(n);
    if (!w) continue;
    const wp = groundPos(w);
    // Reach: farthest vertex from the pivot.
    let len = 0.5;
    w.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const a = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        scene.worldToLocal(p.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld));
        len = Math.max(len, p.distanceTo(wp));
      }
    });
    const rig: WiperRig = {
      obj: w,
      axis: new THREE.Vector3(0, 0, 1),
      base: w.quaternion.clone(),
      px: wp.x,
      py: new THREE.Vector3().subVectors(wp, base.c).dot(upDir),
      len: len * 0.97,
      maxAngle: wp.x < 0 ? 1.9 : 1.75,
    };
    const blade = find(n + '_Blade');
    if (blade) {
      rig.blade = blade;
      rig.bladeBase = blade.quaternion.clone();
    }
    // Make sure a positive sweep moves the blade up the glass; flip the axis if not.
    const tip = new THREE.Vector3(len, 0, 0);
    const probe = tip.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(rig.axis, 0.5));
    if (probe.applyQuaternion(rig.base).y < tip.clone().applyQuaternion(rig.base).y) rig.axis.negate();
    wipers.push(rig);
  }
  const glass: GlassFrame = { baseHalf: base.half, topHalf: top.half, length, wipers };

  // Gauges.
  const gauges = new GaugeCluster();
  const face = find('GaugeFace') as THREE.Mesh | null;
  if (face) face.material = gauges.material;

  // Lights.
  const headlights: THREE.SpotLight[] = [];
  for (const n of ['HeadlightL', 'HeadlightR']) {
    const o = find(n);
    if (!o) continue;
    const s = new THREE.SpotLight('#fff2dc', 0, 140, 0.45, 0.55, 1.6);
    const hp = groundPos(o);
    s.position.copy(hp);
    s.target.position.set(hp.x * 0.6, 0, hp.z - 30);
    scene.add(s, s.target);
    headlights.push(s);
  }
  const dashLight = new THREE.PointLight('#9fc0ff', 0, 1.2, 2);
  dashLight.position.copy(DRIVER_EYE).add(new THREE.Vector3(0.05, -0.3, -0.45));
  scene.add(dashLight);

  // Lightning-bolt side decals projected onto the body.
  // Body is split by material slot; project onto the painted panels only.
  let body: THREE.Mesh | null = null;
  find('Body')?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !body && /paint/i.test((m.material as THREE.Material).name)) body = m;
  });
  if (body) {
    // Work in the model's own frame (ground at y=0); DecalGeometry works in world space.
    scene.updateMatrixWorld(true);
    const toModel = scene.matrixWorld.clone().invert();
    const box = new THREE.Box3().setFromObject(body).applyMatrix4(toModel);
    const decalMat = new THREE.MeshStandardMaterial({
      map: decalTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      roughness: 0.6,
    });
    for (const side of [-1, 1]) {
      // Door height, below the window line; same 2:1 aspect as the texture.
      const at = new THREE.Vector3(side * box.max.x, 1.05, -0.15).applyMatrix4(scene.matrixWorld);
      const rot = new THREE.Euler(0, side * Math.PI / 2, 0);
      try {
        const geo = new DecalGeometry(body, at, rot, new THREE.Vector3(2.1, 1.05, 0.8));
        geo.applyMatrix4(toModel);
        const decal = new THREE.Mesh(geo, decalMat);
        decal.renderOrder = 2;
        scene.add(decal);
      } catch (e) {
        console.warn('[vehicle] decal skipped', e);
      }
    }
  }

  // Cargo area: liftgate (opens on negative rotation.x about its top hinge) and the probe tote.
  const liftgate = find('Liftgate');
  const rearEntry = find('RearEntry');
  const probes = [1, 2, 3, 4].map((i) => find(`Probe_${i}`)).filter((o): o is THREE.Object3D => !!o);
  const cargo = liftgate && rearEntry ? { liftgate, liftgateBase: liftgate.quaternion.clone(), rearEntry, probes } : undefined;

  const interior: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o !== windshield) interior.push(o);
  });

  return {
    root,
    interior,
    windshield,
    wheels,
    steeringWheel,
    speedNeedle: new THREE.Object3D(),
    tachNeedle: new THREE.Object3D(),
    glass,
    headlightMat,
    taillightMat,
    gaugeMat: gauges.material,
    headlights,
    anemometer: find('Anemometer') ?? new THREE.Object3D(),
    // The shell is single-sided, so everything can stay visible from the driver's seat.
    exterior: new THREE.Group(),
    bodyMat: paint,
    dashLight,
    gauges,
    ledMat,
    steeringBase: steeringWheel.quaternion.clone(),
    steeringAxis: new THREE.Vector3(0, 0, 1),
    cargo,
  };
}
