import * as THREE from 'three';

/**
 * Procedural mid-2000s full-size SUV, built in a ground-level frame:
 * origin on the ground under the centre of the wheelbase, forward = -Z,
 * right = +X, up = +Y. The physics body sits at the centre of gravity, so the
 * whole model is offset by -cgHeight inside the vehicle group.
 *
 * The exterior shell is single-sided, so from the driver's seat it is invisible
 * and only the interior meshes (dash, pillars, headliner, door cards…) and the
 * hood remain — exactly the dashcam view.
 */

// Lifted full-size SUV on 35" tyres (matches models/chaser_build.py).
export const CG_HEIGHT = 0.98;
export const WHEEL_RADIUS = 0.445;
export const WHEEL_POS = [
  new THREE.Vector3(-0.87, WHEEL_RADIUS, -1.475), // FL
  new THREE.Vector3(0.87, WHEEL_RADIUS, -1.475), // FR
  new THREE.Vector3(-0.87, WHEEL_RADIUS, 1.475), // RL
  new THREE.Vector3(0.87, WHEEL_RADIUS, 1.475), // RR
];
/** Driver eye point (ground frame). Overwritten from the model's `EyeDriver` empty. */
export const DRIVER_EYE = new THREE.Vector3(-0.4, 1.78, 0.1);
/** Dashcam lens position (ground frame). Overwritten from the model's `Dashcam` empty. */
export const DASHCAM_POS = new THREE.Vector3(0.08, 2.0, -0.45);
/** Door point where the player gets out (ground frame). Overwritten from `DoorDriver`. */
export const DRIVER_DOOR = new THREE.Vector3(-1.65, 0, -0.1);

// Windshield corners (ground frame).
const WS_BASE_Y = 1.14;
const WS_BASE_Z = -1.02;
const WS_TOP_Y = 1.77;
const WS_TOP_Z = -0.3;
const WS_BASE_HALF = 0.79;
const WS_TOP_HALF = 0.71;

/** Rotation whose local XY plane lies on the windshield (Y up the glass, Z out toward the driver). */
const GLASS_UP = new THREE.Vector3(0, WS_TOP_Y - WS_BASE_Y, WS_TOP_Z - WS_BASE_Z).normalize();
const GLASS_BASIS = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0),
  GLASS_UP,
  new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), GLASS_UP).normalize(),
);

function mat(color: string, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness, ...extra });
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function grainTexture(base: string, amount: number, size = 256): THREE.CanvasTexture {
  return canvasTexture(size, size, (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, size, size);
    const img = g.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * amount;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  });
}

/** A wiper: its pivot object, the axis it sweeps about, and its reach on the glass. */
export interface WiperRig {
  obj: THREE.Object3D;
  /** Rotation axis in the object's local space (the glass normal). */
  axis: THREE.Vector3;
  /** Rest orientation (blade parked). */
  base: THREE.Quaternion;
  /** Pivot position in glass space: across (m from centre) and up the glass (m from the bottom edge). */
  px: number;
  py: number;
  /** Blade reach from the pivot (m) and full sweep angle (rad). */
  len: number;
  maxAngle: number;
}

/** The windshield as a trapezoid in its own plane, for droplets and wipers. */
export interface GlassFrame {
  baseHalf: number;
  topHalf: number;
  /** Length up the glass from the bottom edge to the top edge, m. */
  length: number;
  wipers: WiperRig[];
}

export interface VehicleParts {
  root: THREE.Group;
  /** Meshes visible in the glass pass as occluders (interior). */
  interior: THREE.Object3D[];
  windshield: THREE.Mesh;
  wheels: THREE.Group[];
  steeringWheel: THREE.Object3D;
  speedNeedle: THREE.Object3D;
  tachNeedle: THREE.Object3D;
  glass: GlassFrame;
  headlightMat: THREE.MeshStandardMaterial;
  taillightMat: THREE.MeshStandardMaterial;
  gaugeMat: THREE.MeshStandardMaterial;
  headlights: THREE.SpotLight[];
  anemometer: THREE.Object3D;
  /** The exterior shell (hidden in driver/dashcam views to save fill). */
  exterior: THREE.Group;
  /** Meshes that should show crack/damage. */
  bodyMat: THREE.MeshStandardMaterial;
  dashLight: THREE.PointLight;
  /** Canvas-painted instruments (Blender model); the procedural model uses 3D needles. */
  gauges?: { update(mph: number, rpm: number, lit: boolean): void };
  /** Emissive LED bars on the brush guard and rack. */
  ledMat?: THREE.MeshStandardMaterial;
  /** Steering wheel rest orientation and column axis (local). */
  steeringBase?: THREE.Quaternion;
  steeringAxis?: THREE.Vector3;
}

export function buildVehicleModel(): VehicleParts {
  // This placeholder is smaller than the Blender truck: use its own camera mounts.
  DRIVER_EYE.set(-0.38, 1.3 + (CG_HEIGHT - 0.78), -0.02);
  DASHCAM_POS.set(0.06, 1.66 + (CG_HEIGHT - 0.78), -0.5);
  DRIVER_DOOR.set(-1.6, 0, -0.2);
  const root = new THREE.Group();
  root.name = 'vehicle-model';
  // Built for a 0.78 m CG; lift it so it sits on the bigger truck's suspension.
  root.position.y = -0.78;
  const exterior = new THREE.Group();
  exterior.name = 'exterior';
  const interiorGroup = new THREE.Group();
  interiorGroup.name = 'interior';
  root.add(exterior, interiorGroup);
  const interior: THREE.Object3D[] = [];

  // ---------------------------------------------------------------- materials
  const paint = mat('#2c3033', 0.38, 0.45);
  paint.envMapIntensity = 0.9;
  const trim = mat('#141516', 0.65);
  const chrome = mat('#9a9c9e', 0.25, 1);
  const tire = mat('#121212', 0.9);
  const rim = mat('#8e9092', 0.35, 0.85);
  const darkGlass = mat('#05070a', 0.06, 0, { transparent: true, opacity: 0.86 });
  const dashPlastic = mat('#d0d0d0', 0.72, 0, { map: grainTexture('#3a3b3d', 18) });
  const dashTop = mat('#c4c4c4', 0.85, 0, { map: grainTexture('#2c2d2f', 22) });
  const fabric = mat('#ffffff', 0.95, 0, { map: grainTexture('#4a4844', 30) });
  const headliner = mat('#ffffff', 0.95, 0, { map: grainTexture('#8a877e', 14) });
  const carpet = mat('#1d1d1c', 1);
  // The roof hides most of the sky from the cabin: darken interior albedo to stand in for that occlusion.
  for (const m of [dashPlastic, dashTop, fabric, headliner, carpet]) {
    m.envMapIntensity = 0.1;
    m.color.multiplyScalar(0.42);
  }
  trim.envMapIntensity = 0.25;
  const headlightMat = mat('#c9cdd2', 0.15, 0.2, { emissive: new THREE.Color('#fff4e0'), emissiveIntensity: 0 });
  const taillightMat = mat('#5a0c0a', 0.3, 0, { emissive: new THREE.Color('#ff1a0a'), emissiveIntensity: 0.4 });
  const amber = mat('#7a4a08', 0.3, 0, { emissive: new THREE.Color('#ffa020'), emissiveIntensity: 0 });

  // ---------------------------------------------------------------- exterior body
  // Lower body: side profile extruded across the width, wheel arches notched in.
  const prof = new THREE.Shape();
  const arch = (cz: number, fromZ: number, toZ: number) => {
    // semicircular arch over a wheel at cz (profile coords: x = z, y = y)
    const r = 0.5;
    prof.lineTo(fromZ, 0.46);
    prof.absarc(cz, WHEEL_RADIUS, r, Math.atan2(0.46 - WHEEL_RADIUS, fromZ - cz), Math.atan2(0.46 - WHEEL_RADIUS, toZ - cz), true);
    prof.lineTo(toZ, 0.46);
  };
  prof.moveTo(2.52, 0.46);
  prof.lineTo(2.55, 0.74);
  prof.lineTo(2.5, 1.12);
  prof.lineTo(-1.02, 1.14);
  prof.lineTo(-2.4, 1.04);
  prof.lineTo(-2.52, 0.92);
  prof.lineTo(-2.56, 0.5);
  prof.lineTo(-2.5, 0.42);
  // bottom edge, front to back with arches
  arch(-1.47, -1.97, -0.97);
  arch(1.48, 0.98, 1.98);
  prof.lineTo(2.52, 0.46);
  const lowerGeo = new THREE.ExtrudeGeometry(prof, { depth: 1.98, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 10 });
  lowerGeo.rotateY(Math.PI / 2);
  lowerGeo.translate(-0.99, 0, 0);
  const lower = new THREE.Mesh(lowerGeo, paint);
  lower.name = 'body-lower';
  exterior.add(lower);

  // Cabin shell (greenhouse).
  const cab = new THREE.Shape();
  cab.moveTo(WS_BASE_Z, WS_BASE_Y - 0.02);
  cab.lineTo(WS_TOP_Z, WS_TOP_Y + 0.06);
  cab.lineTo(2.32, 1.9);
  cab.lineTo(2.47, 1.84);
  cab.lineTo(2.49, 1.12);
  cab.lineTo(WS_BASE_Z, WS_BASE_Y - 0.02);
  const cabGeo = new THREE.ExtrudeGeometry(cab, { depth: 1.84, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3 });
  cabGeo.rotateY(Math.PI / 2);
  cabGeo.translate(-0.92, 0, 0);
  const cabin = new THREE.Mesh(cabGeo, paint);
  cabin.name = 'body-cabin';
  exterior.add(cabin);

  // Exterior window glass (dark, slightly proud of the shell).
  const sideWin = (side: number, z0: number, z1: number, y0: number, y1: number, topZ0: number) => {
    const s = new THREE.Shape();
    s.moveTo(z0, y0);
    s.lineTo(z1, y0);
    s.lineTo(z1, y1);
    s.lineTo(topZ0, y1);
    s.lineTo(z0, y0);
    const g = new THREE.ShapeGeometry(s);
    g.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
    const m = new THREE.Mesh(g, darkGlass);
    m.position.x = side * 0.985;
    if (side < 0) m.scale.z = -1;
    m.name = 'glass-side';
    exterior.add(m);
  };
  for (const side of [-1, 1]) {
    sideWin(side, -0.95, 0.62, 1.2, 1.76, -0.38);
    sideWin(side, 0.7, 1.55, 1.2, 1.8, 0.7);
    sideWin(side, 1.62, 2.38, 1.2, 1.8, 1.62);
  }
  const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.58), darkGlass);
  rearWin.position.set(0, 1.5, 2.53);
  rearWin.name = 'glass-rear';
  exterior.add(rearWin);

  // Grille, bumpers, lights.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.34, 0.06), trim);
  grille.position.set(0, 0.86, -2.55);
  exterior.add(grille);
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.025, 0.02), chrome);
    bar.position.set(0, 0.74 + i * 0.08, -2.585);
    exterior.add(bar);
  }
  const fBumper = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.26, 0.2), trim);
  fBumper.position.set(0, 0.5, -2.56);
  exterior.add(fBumper);
  const rBumper = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.2), trim);
  rBumper.position.set(0, 0.52, 2.58);
  exterior.add(rBumper);
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.06), headlightMat);
    hl.position.set(side * 0.78, 0.9, -2.53);
    exterior.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.08), taillightMat);
    tl.position.set(side * 0.94, 1.12, 2.52);
    exterior.add(tl);
    // Side mirror (also visible from inside).
    const mirror = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.19, 0.24), trim);
    const glassM = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.15), mat('#3a4248', 0.08, 0.9));
    glassM.rotation.y = side * Math.PI / 2;
    glassM.position.x = side * -0.037;
    housing.add(glassM);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.06), trim);
    arm.position.set(side * -0.08, -0.05, 0.05);
    housing.add(arm);
    mirror.add(housing);
    mirror.position.set(side * 1.1, 1.22, -0.86);
    housing.rotation.y = side * 0.12;
    root.add(mirror); // part of both views
    interior.push(mirror);
  }

  // Wheels.
  const tireProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    tireProfile.push(new THREE.Vector2(WHEEL_RADIUS - 0.12 + Math.sin(a) * 0.12, -0.13 + (1 - Math.cos(a)) * 0.13));
  }
  const tireGeo = new THREE.LatheGeometry(tireProfile, 28);
  tireGeo.rotateZ(Math.PI / 2);
  tireGeo.translate(0, 0, 0);
  const rimGeo = new THREE.CylinderGeometry(WHEEL_RADIUS - 0.13, WHEEL_RADIUS - 0.13, 0.2, 20);
  rimGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.24, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const wheels: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Group();
    const spin = new THREE.Group();
    spin.name = 'spin';
    spin.add(new THREE.Mesh(tireGeo, tire));
    spin.add(new THREE.Mesh(rimGeo, rim));
    spin.add(new THREE.Mesh(hubGeo, chrome));
    for (let k = 0; k < 6; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.04), rim);
      spoke.position.x = (i % 2 === 0 ? -1 : 1) * 0.1;
      spoke.rotation.x = (k / 6) * Math.PI * 2;
      spoke.position.y = Math.cos(spoke.rotation.x) * 0.12;
      spoke.position.z = -Math.sin(spoke.rotation.x) * 0.12;
      spin.add(spoke);
    }
    w.add(spin);
    w.position.copy(WHEEL_POS[i]);
    wheels.push(w);
    exterior.add(w);
  }

  // Roof gear: rack, amber light bar, weather station.
  const rackMat = mat('#1b1c1d', 0.5, 0.6);
  for (const x of [-0.75, 0.75]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 2.0), rackMat);
    rail.position.set(x, 1.97, 1.05);
    exterior.add(rail);
  }
  const lightBar = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.09, 0.22), amber);
  lightBar.position.set(0, 2.0, 0.08);
  exterior.add(lightBar);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.75, 6), rackMat);
  mast.position.set(0.55, 2.35, 1.9);
  exterior.add(mast);
  const anemometer = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.008, 0.008), rackMat);
    arm.position.x = 0.08;
    const cup = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6, 0, Math.PI), mat('#d8d8d4', 0.6));
    cup.position.set(0.16, 0, 0);
    cup.rotation.y = Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(arm, cup);
    holder.rotation.y = (k / 3) * Math.PI * 2;
    anemometer.add(holder);
  }
  anemometer.position.set(0.55, 2.73, 1.9);
  exterior.add(anemometer);
  for (const [x, z, h] of [[-0.6, 1.9, 0.9], [0.2, 2.1, 0.6]] as const) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, h, 4), rackMat);
    ant.position.set(x, 1.9 + h / 2, z);
    exterior.add(ant);
  }

  // ---------------------------------------------------------------- hood (visible from inside)
  const hoodGeo = new THREE.PlaneGeometry(1.9, 1.36, 14, 8);
  // Plane x/y → hood x and distance forward from the cowl, with a slight crown.
  const hp = hoodGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < hp.count; i++) {
    const t = hp.getY(i) + 0.68;
    const x = hp.getX(i) * (1 - t * 0.02);
    const z = WS_BASE_Z - 0.05 - t;
    const y = 1.135 - t * 0.075 + 0.035 * (1 - (x / 0.95) ** 2);
    hp.setXYZ(i, x, y, z);
  }
  hoodGeo.computeVertexNormals();
  const hood = new THREE.Mesh(hoodGeo, paint);
  hood.name = 'hood';
  root.add(hood);
  interior.push(hood);
  // Cowl panel between hood and glass (black plastic, where the wipers park).
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.03, 0.14), trim);
  cowl.position.set(0, WS_BASE_Y - 0.01, WS_BASE_Z - 0.06);
  cowl.rotation.x = -0.12;
  root.add(cowl);
  interior.push(cowl);

  // ---------------------------------------------------------------- windshield
  const wsGeo = new THREE.BufferGeometry();
  const segU = 12, segV = 6;
  const wsPos: number[] = [], wsUv: number[] = [], wsIdx: number[] = [];
  for (let j = 0; j <= segV; j++) {
    const v = j / segV;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const half = THREE.MathUtils.lerp(WS_BASE_HALF, WS_TOP_HALF, v);
      const x = (u * 2 - 1) * half;
      const y = THREE.MathUtils.lerp(WS_BASE_Y, WS_TOP_Y, v);
      // slight horizontal curvature
      const z = THREE.MathUtils.lerp(WS_BASE_Z, WS_TOP_Z, v) + 0.06 * (x / half) ** 2;
      wsPos.push(x, y, z);
      wsUv.push(u, v);
    }
  }
  for (let j = 0; j < segV; j++)
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      wsIdx.push(a, a + 1, a + segU + 1, a + 1, a + segU + 2, a + segU + 1);
    }
  wsGeo.setAttribute('position', new THREE.Float32BufferAttribute(wsPos, 3));
  wsGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wsUv, 2));
  wsGeo.setIndex(wsIdx);
  wsGeo.computeVertexNormals();
  const wsMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#0d1012'),
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMapIntensity: 0.6,
  });
  const windshield = new THREE.Mesh(wsGeo, wsMat);
  windshield.name = 'windshield';
  windshield.renderOrder = 10;
  root.add(windshield);
  // Shade band along the top of the glass.
  const tint = new THREE.Mesh(
    new THREE.PlaneGeometry(1.44, 0.16),
    new THREE.MeshBasicMaterial({ color: '#0b1a22', transparent: true, opacity: 0.45, depthWrite: false, fog: false }),
  );
  tint.position.set(0, WS_TOP_Y - 0.075, THREE.MathUtils.lerp(WS_BASE_Z, WS_TOP_Z, 0.88) + 0.005);
  tint.quaternion.setFromRotationMatrix(GLASS_BASIS);
  tint.renderOrder = 11;
  root.add(tint);

  // ---------------------------------------------------------------- interior
  const addI = (m: THREE.Mesh) => {
    interiorGroup.add(m);
    interior.push(m);
    return m;
  };
  // A-pillars.
  for (const side of [-1, 1]) {
    const a = new THREE.Vector3(side * (WS_BASE_HALF + 0.06), WS_BASE_Y, WS_BASE_Z + 0.02);
    const b = new THREE.Vector3(side * (WS_TOP_HALF + 0.08), WS_TOP_Y + 0.02, WS_TOP_Z + 0.04);
    const len = a.distanceTo(b);
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.11, len, 0.07), dashPlastic);
    p.position.copy(a).add(b).multiplyScalar(0.5);
    p.lookAt(b);
    p.rotateX(Math.PI / 2);
    p.name = 'a-pillar';
    addI(p);
  }
  // Headliner and roof edge.
  const hl = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.04, 2.7), headliner);
  hl.position.set(0, 1.82, 1.05);
  addI(hl);
  const header = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.16), headliner);
  header.position.set(0, WS_TOP_Y + 0.03, WS_TOP_Z + 0.08);
  addI(header);
  // Sun visors.
  for (const side of [-1, 1]) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 0.2), headliner);
    v.position.set(side * 0.4, WS_TOP_Y - 0.01, WS_TOP_Z + 0.16);
    v.rotation.x = -0.25;
    addI(v);
  }
  // Rear-view mirror.
  const rvm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.035), trim);
  rvm.position.set(0, 1.63, WS_TOP_Z - 0.04);
  rvm.rotation.x = 0.1;
  addI(rvm);
  const rvmStem = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.02), trim);
  rvmStem.position.set(0, 1.7, WS_TOP_Z - 0.05);
  addI(rvmStem);
  // The dashcam itself, stuck to the glass.
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.045, 0.03), mat('#0c0c0d', 0.4));
  cam.position.set(0.09, 1.68, WS_TOP_Z - 0.17);
  addI(cam);

  // Dashboard: top shelf sloping down to the glass, face, centre stack.
  const dashTopGeo = new THREE.BoxGeometry(1.9, 0.05, 0.62);
  const dtop = new THREE.Mesh(dashTopGeo, dashTop);
  dtop.position.set(0, 1.03, -0.78);
  dtop.rotation.x = 0.1;
  addI(dtop);
  const dface = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.38, 0.08), dashPlastic);
  dface.position.set(0, 0.84, -0.5);
  dface.rotation.x = -0.18;
  addI(dface);
  const dlower = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.3, 0.3), dashPlastic);
  dlower.position.set(0, 0.6, -0.62);
  addI(dlower);
  // Instrument binnacle.
  const binn = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.2), dashTop);
  binn.position.set(-0.38, 1.08, -0.56);
  binn.rotation.x = 0.06;
  addI(binn);
  // Gauge face (canvas) with speedometer and tach.
  const gaugeTex = canvasTexture(512, 192, (g) => {
    g.fillStyle = '#060606';
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
  });
  const gaugeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#202020'),
    roughness: 0.4,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: gaugeTex,
    emissiveIntensity: 0.05,
    map: gaugeTex,
  });
  const gauge = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.158), gaugeMat);
  gauge.position.set(-0.38, 0.97, -0.6);
  gauge.rotation.x = -0.32;
  addI(gauge);
  const needleMat = new THREE.MeshStandardMaterial({ color: '#c43a12', emissive: new THREE.Color('#ff4a12'), emissiveIntensity: 0.6 });
  const mkNeedle = (cx: number, len: number) => {
    const pivot = new THREE.Group();
    const n = new THREE.Mesh(new THREE.BoxGeometry(0.004, len, 0.002), needleMat);
    n.position.y = len / 2;
    pivot.add(n);
    pivot.position.set(cx, 0, 0.004);
    gauge.add(pivot);
    return pivot;
  };
  // Dial centres in gauge-local units (plane is 0.42 × 0.158 for 512 × 192 px).
  const speedNeedle = mkNeedle(-0.21 + (150 / 512) * 0.42, 0.06);
  speedNeedle.position.y = 0.079 - (100 / 192) * 0.158;
  const tachNeedle = mkNeedle(-0.21 + (372 / 512) * 0.42, 0.05);
  tachNeedle.position.y = 0.079 - (100 / 192) * 0.158;

  // Centre stack with a radio and HVAC knobs.
  const stack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.08), dashPlastic);
  stack.position.set(0.02, 0.82, -0.52);
  stack.rotation.x = -0.2;
  addI(stack);
  const radio = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.07),
    new THREE.MeshStandardMaterial({ color: '#0a0f0a', emissive: new THREE.Color('#33ff99'), emissiveIntensity: 0.05, roughness: 0.3 }),
  );
  radio.position.set(0.02, 0.91, -0.47);
  radio.rotation.x = -0.2;
  addI(radio);
  // Passenger-side glovebox face and a phone mount with a radar app glow.
  const phone = new THREE.Mesh(
    new THREE.BoxGeometry(0.075, 0.15, 0.012),
    new THREE.MeshStandardMaterial({ color: '#050505', emissive: new THREE.Color('#5d7f99'), emissiveIntensity: 0.04, roughness: 0.15 }),
  );
  phone.position.set(0.2, 1.08, -0.62);
  phone.rotation.x = -0.4;
  addI(phone);

  // Steering column and wheel.
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.36, 10), dashPlastic);
  column.position.set(-0.38, 0.86, -0.52);
  column.rotation.x = Math.PI / 2 - 0.42;
  addI(column);
  const steering = new THREE.Group();
  steering.position.set(-0.38, 0.94, -0.36);
  steering.rotation.x = -0.42;
  const rimS = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 10, 40), mat('#151515', 0.75));
  const hubS = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.06, 16), dashPlastic);
  hubS.rotation.x = Math.PI / 2;
  steering.add(rimS, hubS);
  for (const a of [-0.25, Math.PI + 0.25, Math.PI * 1.5]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.015), dashPlastic);
    sp.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0);
    sp.rotation.z = a;
    steering.add(sp);
  }
  const steeringWheel = new THREE.Group();
  steeringWheel.add(steering);
  interiorGroup.add(steeringWheel);
  steeringWheel.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) interior.push(o);
  });

  // Door cards with window sills.
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 2.9), fabric);
    door.position.set(side * 0.96, 0.84, 0.75);
    addI(door);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 2.9), dashPlastic);
    sill.position.set(side * 0.93, 1.16, 0.75);
    addI(sill);
    // B-pillar and C-pillar.
    const bp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.66, 0.12), headliner);
    bp.position.set(side * 0.94, 1.49, 0.66);
    addI(bp);
    const cp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.66, 0.1), headliner);
    cp.position.set(side * 0.94, 1.49, 1.58);
    addI(cp);
    // Interior side-window glass, faintly visible.
    const sg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.9, 0.6),
      new THREE.MeshStandardMaterial({ color: '#0a0d10', transparent: true, opacity: side > 0 ? 0.12 : 0.1, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide }),
    );
    sg.rotation.y = Math.PI / 2;
    sg.position.set(side * 0.97, 1.48, 0.95);
    sg.renderOrder = 9;
    interiorGroup.add(sg);
  }
  // Rear privacy glass seen from inside.
  const rg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.6),
    new THREE.MeshStandardMaterial({ color: '#020304', transparent: true, opacity: 0.6, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide }),
  );
  rg.position.set(0, 1.5, 2.45);
  rg.renderOrder = 9;
  interiorGroup.add(rg);
  // Floor, seats.
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.04, 3.6), carpet);
  floor.position.set(0, 0.42, 0.7);
  addI(floor);
  const seat = (x: number, z: number, w: number) => {
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, 0.52), fabric);
    base.position.set(x, 0.66, z);
    addI(base);
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.62, 0.12), fabric);
    back.position.set(x, 1.0, z + 0.3);
    back.rotation.x = 0.18;
    addI(back);
    const head = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w, 0.26), 0.18, 0.1), fabric);
    head.position.set(x, 1.42, z + 0.38);
    addI(head);
    if (w > 0.6) {
      const head2 = head.clone();
      head2.position.x = x - w * 0.33;
      head.position.x = x + w * 0.33;
      addI(head2);
    }
  };
  seat(0.4, 0.15, 0.52);
  seat(-0.4, 0.15, 0.52);
  seat(0, 1.35, 1.6);
  const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.8), dashPlastic);
  console_.position.set(0, 0.66, -0.05);
  addI(console_);

  // Interior glow from the instruments at night.
  const dashLight = new THREE.PointLight('#9fc0ff', 0, 1.2, 2);
  dashLight.position.set(-0.3, 1.0, -0.45);
  interiorGroup.add(dashLight);

  // ---------------------------------------------------------------- wipers
  const wiperRigs: WiperRig[] = [];
  const wiperMat = mat('#0c0c0c', 0.55, 0.3);
  // The glass plane's tangent frame at the base, used to lay the wipers flat on it.
  for (const [px, len] of [[-0.5, 0.6], [0.16, 0.56]] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(px, WS_BASE_Y + 0.005, WS_BASE_Z - 0.02);
    // orient pivot so its local XY plane lies on the glass
    pivot.quaternion.setFromRotationMatrix(GLASS_BASIS);
    const sweep = new THREE.Group();
    sweep.name = 'sweep';
    const arm = new THREE.Mesh(new THREE.BoxGeometry(len, 0.014, 0.018), wiperMat);
    arm.position.set(len / 2, 0, 0.025);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(len * 1.05, 0.022, 0.02), wiperMat);
    blade.position.set(len * 0.56, 0, 0.012);
    sweep.add(arm, blade);
    pivot.add(sweep);
    root.add(pivot);
    wiperRigs.push({ obj: sweep, axis: new THREE.Vector3(0, 0, 1), base: sweep.quaternion.clone(), px, py: -0.02, len, maxAngle: px < 0 ? 1.9 : 1.75 });
    interior.push(arm, blade);
  }

  // ---------------------------------------------------------------- headlights
  const headlights: THREE.SpotLight[] = [];
  for (const side of [-1, 1]) {
    const s = new THREE.SpotLight('#fff2dc', 0, 120, 0.42, 0.55, 1.6);
    s.position.set(side * 0.78, 0.9, -2.6);
    s.target.position.set(side * 0.5, 0.0, -30);
    root.add(s, s.target);
    headlights.push(s);
  }

  return {
    root,
    interior,
    windshield,
    wheels,
    steeringWheel: steering,
    speedNeedle,
    tachNeedle,
    glass: {
      baseHalf: WS_BASE_HALF,
      topHalf: WS_TOP_HALF,
      length: Math.hypot(WS_TOP_Y - WS_BASE_Y, WS_TOP_Z - WS_BASE_Z),
      wipers: wiperRigs,
    },
    headlightMat,
    taillightMat,
    gaugeMat,
    headlights,
    anemometer,
    exterior,
    bodyMat: paint,
    dashLight,
  };
}
