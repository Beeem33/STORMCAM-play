import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as P from '../environment/props';
import type { InstancedAsset } from '../environment/props';
import { mulberry32 } from '../environment/props/util';

declare global {
  interface Window {
    renderOnce: () => void;
    frameProp: (name: string) => void;
    propNames: () => string[];
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#8f989e');
scene.fog = new THREE.Fog('#8f989e', 250, 2200);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener('change', () => renderOnce());

scene.add(new THREE.HemisphereLight('#9aa5ad', '#4a4a3a', 1.5));
const sun = new THREE.DirectionalLight('#f4f1ea', 1.2);
sun.position.set(-40, 70, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -40;
sun.shadow.camera.right = sun.shadow.camera.top = 40;
sun.shadow.camera.far = 300;
sun.shadow.radius = 4;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

// ground
{
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#6b6f55';
  x.fillRect(0, 0, 256, 256);
  const r = mulberry32(5);
  for (let i = 0; i < 4000; i++) {
    x.fillStyle = `rgba(${r() < 0.5 ? '70,78,50' : '120,118,90'},${0.15 + r() * 0.25})`;
    x.fillRect(r() * 256, r() * 256, 1 + r() * 3, 1 + r() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(800, 800);
  t.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

interface Entry { name: string; obj: THREE.Object3D; tris: number; meshes: number }
const entries: Entry[] = [];
let cursor = 0;
function add(name: string, obj: THREE.Object3D, width: number, tris?: number): void {
  obj.position.x = cursor + width / 2;
  cursor += width + 8;
  obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  scene.add(obj);
  let meshes = 0;
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
  entries.push({ name, obj, tris: tris ?? P.triCount(obj), meshes });
}
function addBuild(name: string, b: P.PropBuild): void {
  const w = b.collider.type === 'box' ? b.collider.hx * 2 : b.collider.r * 2;
  add(name, b.group, Math.max(2, w));
}
function instanced(asset: InstancedAsset, mats: THREE.Matrix4[]): THREE.Group {
  const g = new THREE.Group();
  for (const p of asset.parts) {
    const im = new THREE.InstancedMesh(p.geometry, p.material, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = im.receiveShadow = true;
    g.add(im);
  }
  return g;
}
const assetTris = (a: InstancedAsset) => a.parts.reduce((s, p) => s + (p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count) / 3, 0);

const t0 = performance.now();
for (let i = 0; i < 4; i++) addBuild('farmhouse_' + i, P.buildFarmhouse(mulberry32(11 + i * 7)));
for (let i = 0; i < 3; i++) addBuild('barn_' + i, P.buildBarn(mulberry32(21 + i * 5)));
for (let i = 0; i < 2; i++) addBuild('machine_shed_' + i, P.buildMachineShed(mulberry32(31 + i)));
{
  const g = new THREE.Group();
  const r = mulberry32(3);
  let x = 0;
  for (const d of [9.1, 11, 7.3]) { const b = P.buildGrainBin(r, d); b.group.position.x = x + d / 2; x += d + 3; g.add(b.group); }
  add('grain_bins', g, x);
}
for (let i = 0; i < 2; i++) addBuild('silo_' + i, P.buildSilo(mulberry32(41 + i * 3)));
addBuild('gas_station', P.buildGasStation());
{
  const g = new THREE.Group();
  const kinds = ['stop', 'speed55', 'crossroad', 'countyRoad', 'noOutlet'] as const;
  kinds.forEach((k, i) => { const s = P.buildRoadSign(k, k === 'countyRoad' ? 'RD 220' : undefined); s.group.position.x = i * 1.6; g.add(s.group); });
  for (let i = 0; i < 3; i++) { const m = P.buildMailbox(mulberry32(60 + i)); m.group.position.set(kinds.length * 1.6 + i * 0.9, 0, 0); g.add(m.group); }
  add('signs_mailboxes', g, 11);
}
{
  const pole = P.telephonePoleAsset();
  const mats = [0, 1, 2, 3].map((i) => new THREE.Matrix4().makeTranslation(0, 0, -i * 45));
  const g = instanced(pole, mats);
  const wm = new THREE.LineBasicMaterial({ color: '#2a2a2a' });
  for (let i = 0; i < 3; i++)
    for (const a of pole.wireAttach) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 16; k++) { const t = k / 16; pts.push(new THREE.Vector3(a.x, a.y - Math.sin(t * Math.PI) * 0.6, a.z - i * 45 - t * 45)); }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wm));
    }
  add('telephone_poles', g, 4, assetTris(pole));
}
{
  const post = P.fencePostAsset();
  const r = mulberry32(8);
  const mats = Array.from({ length: 12 }, (_, i) => new THREE.Matrix4().compose(new THREE.Vector3(0, 0, -i * 4), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 6, 0)), new THREE.Vector3(1, 0.95 + r() * 0.1, 1)));
  add('fence_posts', instanced(post, mats), 2, assetTris(post));
}
for (const t of P.treeAssets()) {
  const mats = [new THREE.Matrix4(), new THREE.Matrix4().compose(new THREE.Vector3(0, 0, -t.asset.radius * 2.6), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 2.1, 0)), new THREE.Vector3(0.85, 0.85, 0.85))];
  add('tree_' + t.kind, instanced(t.asset, mats), t.asset.radius * 2, assetTris(t.asset));
}
{
  const bale = P.hayBaleAsset();
  const r = mulberry32(2);
  const mats = Array.from({ length: 6 }, (_, i) => new THREE.Matrix4().compose(new THREE.Vector3((i % 3) * 2.2, 0, -Math.floor(i / 3) * 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 0.6 - 0.3 + (i === 5 ? 1.5 : 0), 0)), new THREE.Vector3(1, 1, 1)));
  add('hay_bales', instanced(bale, mats), 7, assetTris(bale));
}
const buildMs = performance.now() - t0;

function renderOnce(): void {
  renderer.render(scene, camera);
}
function frameProp(name: string): void {
  const e = entries.find((q) => q.name === name) ?? entries.find((q) => q.name.startsWith(name));
  if (!e) return;
  const bb = new THREE.Box3().setFromObject(e.obj);
  const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y * 1.3, s.z) * 0.5 + 0.5;
  const dist = r / Math.tan((camera.fov * Math.PI) / 360) * 1.25;
  camera.position.set(c.x + dist * 0.62, Math.max(1.6, c.y + dist * 0.28), c.z + dist * 0.78);
  controls.target.copy(c);
  controls.update();
  sun.target.position.copy(c);
  sun.position.copy(c).add(new THREE.Vector3(-40, 70, 50));
  const sz = Math.max(20, r * 1.6);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -sz;
  sun.shadow.camera.right = sun.shadow.camera.top = sz;
  sun.shadow.camera.updateProjectionMatrix();
  renderOnce();
}
window.renderOnce = renderOnce;
window.frameProp = frameProp;
window.propNames = () => entries.map((e) => e.name);

const ui = document.getElementById('ui')!;
ui.innerHTML = `<div style="margin-bottom:4px;opacity:.7">built in ${buildMs.toFixed(0)} ms</div>`;
for (const e of entries) {
  const b = document.createElement('button');
  b.innerHTML = `${e.name}<span>${Math.round(e.tris)} tris · ${e.meshes} m</span>`;
  b.onclick = () => frameProp(e.name);
  ui.appendChild(b);
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderOnce();
});
frameProp('farmhouse_0');
const loop = () => { requestAnimationFrame(loop); controls.update(); renderOnce(); };
loop();
