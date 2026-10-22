import * as THREE from 'three';
import { WORLD_GLSL } from './WorldShape';
import { atmo, patchMaterial } from '../rendering/Atmosphere';
import { getNoise2D } from '../rendering/NoiseTextures';

/**
 * Ground: one camera-centred grid whose vertex spacing grows exponentially
 * with distance (≈0.3 m under the car, ≈25 m at 1 km, reaching 20 km), displaced
 * on the GPU by the shared world height function. All surface detail — asphalt,
 * lane paint, gravel ruts, ditch grass, crop rows, puddles — is procedural in
 * the fragment shader, so there are no road meshes to keep in sync.
 */

const N = 440;
const K = 7.2;
const EXTENT = 20000;

function buildGrid(): THREE.BufferGeometry {
  const c = EXTENT / (Math.exp(K) - 1);
  const coords = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 2 - 1;
    coords[i] = Math.sign(u) * c * (Math.exp(K * Math.abs(u)) - 1);
  }
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  let o = 0;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      pos[o++] = coords[i];
      pos[o++] = 0;
      pos[o++] = coords[j];
    }
  const idx = new Uint32Array(N * N * 6);
  o = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const d = a + (N + 1);
      const e = d + 1;
      idx[o++] = a; idx[o++] = d; idx[o++] = b;
      idx[o++] = b; idx[o++] = d; idx[o++] = e;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EXTENT * 1.5);
  return g;
}

/** GLSL that classifies and shades the ground at a world position. */
export const GROUND_GLSL = /* glsl */ `
uniform sampler2D uGroundNoise;
uniform float uWetness;
uniform float uTimeG;
uniform float uPixAngle;

float boxBand(float x, float w, float a, float b) {
  // Fraction of the pixel footprint [x - w/2, x + w/2] inside the band [a, b].
  return clamp((min(x + 0.5 * w, b) - max(x - 0.5 * w, a)) / w, 0.0, 1.0);
}
float stripes(float x, float period, float duty, float w) {
  // Box-filtered periodic stripes; fades to the average when finer than a pixel.
  float f = fract(x / period);
  float pw = w / period;
  float s = boxBand(f, pw, 0.5 - duty * 0.5, 0.5 + duty * 0.5) + boxBand(f - 1.0, pw, 0.5 - duty * 0.5, 0.5 + duty * 0.5) + boxBand(f + 1.0, pw, 0.5 - duty * 0.5, 0.5 + duty * 0.5);
  return mix(s, duty, smoothstep(0.35, 0.9, pw));
}
vec4 gnoise(vec2 p) { return texture2D(uGroundNoise, p); }

// Outputs albedo (linear), roughness, world-space normal tilt (xz) and wetness pooling.
void groundShade(vec3 wp, float pix, out vec3 albedo, out float rough, out vec2 tilt, out float spec) {
  vec4 r = w_roads(wp.xz);
  float adx = abs(r.y), adz = abs(r.w);
  float hwNS = w_roadHalf(r.x), hwEW = w_roadHalf(r.z);
  bool pNS = w_isPaved(r.x), pEW = w_isPaved(r.z);
  float wet = uWetness;

  vec4 nBig = gnoise(wp.xz / 1900.0);
  vec4 nMid = gnoise(wp.xz / 230.0);
  vec4 nSm = gnoise(wp.xz / 23.0);
  vec4 nFine = gnoise(wp.xz / 2.7);
  float fineFade = 1.0 - smoothstep(0.02, 0.25, pix);
  tilt = (vec2(nFine.r, nFine.g) - 0.5) * 0.35 * fineFade + (vec2(nSm.r, nSm.g) - 0.5) * 0.12;

  // ---- Fields --------------------------------------------------------------
  int ft = w_fieldType(wp.xz);
  float qx = floor(wp.x / QUARTER), qz = floor(wp.z / QUARTER);
  bool rowsAlongX = w_ihash(int(qx) + 101, int(qz) - 37) > 0.5;
  float rowCoord = rowsAlongX ? wp.z : wp.x;
  float patchN = nMid.r * 0.6 + nBig.g * 0.4;
  vec3 field;
  float fieldRough = 0.95;
  if (ft == 0) {        // winter wheat, green going gold
    vec3 g = vec3(0.07, 0.095, 0.035);
    vec3 gold = vec3(0.2, 0.17, 0.09);
    field = mix(g, gold, smoothstep(0.35, 0.8, patchN) * 0.65 + nBig.b * 0.2);
    field *= 0.85 + 0.3 * nSm.g;
  } else if (ft == 1) { // pasture: dry tan grass with green coming through
    vec3 tan = vec3(0.2, 0.165, 0.105);
    vec3 grn = vec3(0.075, 0.09, 0.04);
    field = mix(tan, grn, smoothstep(0.3, 0.75, nSm.r * 0.6 + nMid.g * 0.4) * 0.6);
    field *= 0.8 + 0.4 * nFine.b * fineFade + 0.15 * (1.0 - fineFade);
  } else if (ft == 2) { // plowed / planted bare soil
    vec3 soil = vec3(0.16, 0.115, 0.075);
    float furrow = stripes(rowCoord, 0.76, 0.45, pix);
    field = soil * (0.9 + 0.14 * furrow) * (0.85 + 0.3 * nSm.r);
    fieldRough = 1.0;
    tilt += vec2(rowsAlongX ? 0.0 : (furrow - 0.5) * 0.12, rowsAlongX ? (furrow - 0.5) * 0.12 : 0.0) * fineFade;
  } else if (ft == 3) { // young row crop
    vec3 soil = vec3(0.15, 0.11, 0.07);
    vec3 crop = vec3(0.055, 0.085, 0.03);
    float row = stripes(rowCoord, 0.76, 0.22 + 0.12 * nMid.r, pix);
    field = mix(soil, crop, row) * (0.85 + 0.3 * nSm.g);
  } else {              // CRP prairie grass, golden
    field = mix(vec3(0.23, 0.19, 0.115), vec3(0.15, 0.13, 0.075), nSm.r * 0.7 + nMid.b * 0.3);
  }
  // Field-edge grass strip and terraces.
  float edgeD = min(adx, adz);
  float strip = 1.0 - smoothstep(FENCE_OFFSET + 1.0, FENCE_OFFSET + 5.0, edgeD);
  vec3 verge = mix(vec3(0.06, 0.09, 0.032), vec3(0.1, 0.11, 0.05), nSm.b);
  verge *= 0.85 + 0.3 * nFine.r * fineFade;
  albedo = mix(field, verge, strip);
  rough = fieldRough;
  spec = 0.14 + 0.06 * wet;
  // Soil darkens when wet.
  float soilWet = wet * (ft == 2 || ft == 3 ? 1.0 : 0.6);
  albedo *= 1.0 - 0.35 * soilWet;

  // ---- Ditch / shoulder grass (the mowed bright green verge) --------------
  float ditchZone = 1.0 - smoothstep(FENCE_OFFSET - 1.0, FENCE_OFFSET + 1.0, edgeD);
  vec3 ditchGrass = mix(vec3(0.055, 0.1, 0.03), vec3(0.085, 0.125, 0.04), nSm.r);
  ditchGrass = mix(ditchGrass, vec3(0.2, 0.18, 0.11), smoothstep(0.62, 0.8, nMid.g) * 0.5); // dead patches
  ditchGrass *= 0.82 + 0.36 * nFine.g * fineFade;
  albedo = mix(albedo, ditchGrass, ditchZone);
  rough = mix(rough, 0.9, ditchZone);

  // ---- Road surfaces --------------------------------------------------------
  // Choose the road this pixel belongs to (the nearer centreline).
  bool nsNearer = adx - hwNS < adz - hwEW;
  float d = nsNearer ? adx : adz;
  float sd = nsNearer ? r.y : r.w;      // signed lateral offset
  float along = nsNearer ? wp.z : wp.x;
  float hw = nsNearer ? hwNS : hwEW;
  bool paved = nsNearer ? pNS : pEW;
  float otherD = nsNearer ? adz : adx;
  float otherHw = nsNearer ? hwEW : hwNS;
  float inIntersection = 1.0 - smoothstep(otherHw - 0.5, otherHw + 1.5, otherD);
  float roadMask = 1.0 - smoothstep(hw - 0.15, hw + (paved ? 0.25 : 1.6) * (0.6 + 0.8 * nSm.b), d);

  if (roadMask > 0.0) {
    vec3 road;
    float rr;
    if (paved) {
      float agg = nFine.a;
      road = vec3(0.055, 0.055, 0.053) * (0.85 + 0.3 * mix(0.5, agg, fineFade)) * (0.9 + 0.2 * nSm.r);
      // Wheel-polished tracks in each lane, lighter and smoother.
      float laneOff = abs(abs(sd) - 1.75);
      float track = 1.0 - smoothstep(0.35, 0.75, abs(laneOff - 0.85));
      road *= 1.0 + 0.12 * track;
      // Tar snakes sealing old cracks.
      float crackN = gnoise(wp.xz / 11.0 + nSm.rg * 0.08).r;
      float crack = (1.0 - smoothstep(0.0, 0.012 + pix * 0.02, abs(crackN - 0.5))) * smoothstep(0.45, 0.7, nMid.g);
      road = mix(road, vec3(0.022), crack * 0.8 * (0.4 + 0.6 * nMid.r));
      // Patches.
      road *= 1.0 - 0.12 * smoothstep(0.66, 0.7, nMid.b);
      rr = 0.82 - 0.1 * track;
      // Markings (skipped through intersections).
      float mark = 0.0;
      vec3 markCol = vec3(0.0);
      float wear = 0.65 + 0.35 * smoothstep(0.25, 0.6, nSm.g);
      float yel = boxBand(abs(sd), pix, 0.08, 0.2);
      if (yel > 0.0) { mark = yel; markCol = vec3(0.42, 0.28, 0.05); }
      float edgeLine = boxBand(abs(sd), pix, hw - 0.92, hw - 0.77);
      if (edgeLine > 0.0) { mark = max(mark, edgeLine); markCol = mix(markCol, vec3(0.62, 0.62, 0.6), edgeLine); }
      mark *= wear * (1.0 - inIntersection);
      road = mix(road, markCol, mark);
      rr = mix(rr, 0.6, mark);
      // Shoulder beyond the edge line is rougher, older asphalt.
      road *= abs(sd) > hw - 0.77 ? 1.12 : 1.0;
    } else {
      // Gravel: light tan-grey, darker compacted wheel ruts, loose ridge in the middle.
      float rut = 1.0 - smoothstep(0.25, 0.55, abs(abs(sd) - 1.05));
      float ridge = 1.0 - smoothstep(0.2, 0.6, abs(sd));
      road = vec3(0.24, 0.215, 0.18) * (0.8 + 0.4 * mix(0.5, nFine.a, fineFade)) * (0.9 + 0.2 * nSm.g);
      road *= 1.0 - 0.18 * rut;
      road *= 1.0 + 0.08 * ridge;
      road = mix(road, vec3(0.19, 0.17, 0.13), smoothstep(0.55, 0.75, nMid.r) * 0.6);
      rr = 0.92 - 0.1 * rut;
      tilt += (vec2(nFine.b, nFine.a) - 0.5) * 0.3 * fineFade;
      // Wet gravel turns to mud-brown.
      road = mix(road, road * vec3(0.72, 0.66, 0.58), wet);
    }
    // Wet surface: darker, glossy; puddles collect in ruts and low spots.
    float puddleNoise = gnoise(wp.xz / 9.0).r * 0.7 + nSm.r * 0.3;
    float rutBias = paved ? (1.0 - smoothstep(0.2, 0.6, abs(abs(abs(sd) - 1.75) - 0.85))) * 0.15 + smoothstep(hw - 1.2, hw, d) * 0.2
                          : (1.0 - smoothstep(0.2, 0.5, abs(abs(sd) - 1.05))) * 0.3;
    float puddle = smoothstep(0.79, 0.84, puddleNoise + rutBias) * smoothstep(0.5, 0.95, wet);
    road *= 1.0 - 0.45 * wet;
    rr = mix(rr, paved ? 0.3 : 0.45, wet);
    rr = mix(rr, 0.04, puddle);
    road = mix(road, road * 0.55, puddle);
    tilt *= 1.0 - puddle;
    albedo = mix(albedo, road, roadMask);
    rough = mix(rough, rr, roadMask);
    spec = mix(spec, (paved ? 0.4 : 0.3) + 0.3 * wet + puddle * 0.35, roadMask);
  }
  // Gravel lot around the gas station.
  float padD = w_padDistance(wp.xz);
  if (padD < 1.5) {
    float lot = 1.0 - smoothstep(-1.0, 1.5 + nSm.r * 2.0, padD);
    vec3 grav = vec3(0.21, 0.195, 0.17) * (0.8 + 0.4 * mix(0.5, nFine.a, fineFade)) * (0.85 + 0.3 * nSm.g);
    grav *= 1.0 - 0.4 * wet;
    float pud = smoothstep(0.64, 0.7, gnoise(wp.xz / 8.0).r) * smoothstep(0.3, 0.8, wet);
    albedo = mix(albedo, mix(grav, grav * 0.5, pud), lot);
    rough = mix(rough, mix(0.9 - wet * 0.4, 0.05, pud), lot);
    spec = mix(spec, 0.3 + wet * 0.5 + pud * 0.5, lot);
  }
  // Wet grass gets a slight sheen.
  rough = min(rough, mix(1.0, 0.82, wet * (1.0 - roadMask)));
}
`;

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly gridCenter = { value: new THREE.Vector2() };
  private readonly pixAngle = { value: 0.0015 };

  constructor() {
    const geo = buildGrid();
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    const gridCenter = this.gridCenter;
    const pixAngle = this.pixAngle;
    const noise = getNoise2D();
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uGridCenter = gridCenter;
      shader.uniforms.uGroundNoise = { value: noise };
      shader.uniforms.uWetness = atmo.uWetness;
      shader.uniforms.uTimeG = atmo.uTime;
      shader.uniforms.uPixAngle = pixAngle;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec2 uGridCenter;
varying vec3 vWorldPosG;
varying vec3 vWorldNormalG;
${WORLD_GLSL}`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec2 wxz = uGridCenter + position.xz;
float hC = w_height(wxz);
float eps = max(0.3, length(position.xz) * 0.015);
// Forward differences: 3 height evaluations per vertex instead of 5.
float hX = w_height(wxz + vec2(eps, 0.0)) - hC;
float hZ = w_height(wxz + vec2(0.0, eps)) - hC;
vec3 objectNormal = normalize(vec3(-hX, eps, -hZ));
vWorldPosG = vec3(wxz.x, hC, wxz.y);
vWorldNormalG = objectNormal;
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = vWorldPosG;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldPosG;
varying vec3 vWorldNormalG;
${WORLD_GLSL}
${GROUND_GLSL}
vec3 gAlbedo; float gRough; vec2 gTilt; float gSpec;`,
        )
        .replace(
          '#include <map_fragment>',
          `// Pixel footprint from distance and grazing angle — smooth, unlike fwidth on this non-uniform grid.
vec3 toFrag = vWorldPosG - cameraPosition;
float fragDist = length(toFrag);
float pixW = fragDist * uPixAngle * mix(1.0, 1.0 / max(abs(toFrag.y) / fragDist, 0.06), 0.35);
groundShade(vWorldPosG, pixW, gAlbedo, gRough, gTilt, gSpec);
diffuseColor.rgb = gAlbedo;`,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
        .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n  radiance *= gSpec;')
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
{
  vec3 wn = normalize(vWorldNormalG + vec3(gTilt.x, 0.0, gTilt.y));
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`,
        );
    };
    this.material.customProgramCacheKey = () => 'stormcam-terrain';
    patchMaterial(this.material);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'terrain';
  }

  /** Re-centre the grid under the camera (snapped to whole metres) and set the pixel angle. */
  update(camera: THREE.PerspectiveCamera, renderHeight: number): void {
    this.gridCenter.value.set(Math.round(camera.position.x), Math.round(camera.position.z));
    this.pixAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, renderHeight);
  }
}
