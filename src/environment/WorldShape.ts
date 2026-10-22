/**
 * The shape of the world: rolling terrain, the one-mile section-road grid,
 * ditches and field layout. Every function here exists twice — in TypeScript
 * (physics, placement, gameplay) and in GLSL (terrain, grass, tornado shaders)
 * — and the two must stay identical. The noise uses integer hashing so both
 * sides produce the same lattice values bit-for-bit.
 *
 * Axes: +X east, -Z north, +Y up, metres. Roads run along x = i·MILE (north–south)
 * and z = j·MILE (east–west). Every third line is a paved two-lane highway;
 * the rest are gravel section roads.
 */

export const MILE = 1609.34;
export const PAVED_EVERY = 3;
export const PAVED_HALF = 4.3; // two 3.5 m lanes + 0.8 m shoulders
export const GRAVEL_HALF = 3.4;
/** Distance from road centre to the field fence line. */
export const FENCE_OFFSET = 14.5;
export const QUARTER = MILE / 2;

/** Flattened lot for the gas station at the start (NE corner of the 0/0 junction). */
export const PAD = { x0: 4.6, x1: 72, z0: -62, z1: -4.6, cx: 38, cz: -32 };

export type FieldType = 0 | 1 | 2 | 3 | 4; // wheat, pasture, plowed, rowcrop, prairie
export const FIELD_NAMES = ['wheat', 'pasture', 'plowed', 'rowcrop', 'prairie'] as const;

// ---------------------------------------------------------------------------
// TypeScript side
// ---------------------------------------------------------------------------

function ihash(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy);
  const b = ihash(ix + 1, iy);
  const c = ihash(ix, iy + 1);
  const d = ihash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Natural rolling ground, roughly ±9 m. */
export function hills(x: number, z: number): number {
  return (
    (vnoise(x * 0.00052 + 13.1, z * 0.00052 - 7.7) - 0.5) * 15 +
    (vnoise(x * 0.0013 - 3.3, z * 0.0013 + 5.1) - 0.5) * 5 +
    (vnoise(x * 0.0041 + 1.7, z * 0.0041 + 9.2) - 0.5) * 1.1
  );
}

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const isPaved = (index: number): boolean => ((index % PAVED_EVERY) + PAVED_EVERY) % PAVED_EVERY === 0;
export const roadHalf = (index: number): number => (isPaved(index) ? PAVED_HALF : GRAVEL_HALF);

/** Ditch profile: 0 on the road, dips ~0.9 m between the shoulder and the fence. */
function ditch(d: number, hw: number): number {
  const a = hw + 1.4;
  const b = hw + 8.5;
  if (d <= a || d >= b) return 0;
  return -0.9 * Math.sin((Math.PI * (d - a)) / (b - a));
}

export interface RoadQuery {
  /** Index of nearest N–S road (x = i·MILE) and signed offset from it. */
  i: number;
  dx: number;
  /** Index of nearest E–W road (z = j·MILE) and signed offset from it. */
  j: number;
  dz: number;
}

export function nearestRoads(x: number, z: number, out: RoadQuery = { i: 0, dx: 0, j: 0, dz: 0 }): RoadQuery {
  out.i = Math.round(x / MILE);
  out.dx = x - out.i * MILE;
  out.j = Math.round(z / MILE);
  out.dz = z - out.j * MILE;
  return out;
}

const _rq: RoadQuery = { i: 0, dx: 0, j: 0, dz: 0 };

export function heightAt(x: number, z: number): number {
  const q = nearestRoads(x, z, _rq);
  const adx = Math.abs(q.dx);
  const adz = Math.abs(q.dz);
  const hwNS = roadHalf(q.i);
  const hwEW = roadHalf(q.j);
  let h = hills(x, z);
  const wNS = 1 - sstep(hwNS + 6, hwNS + 30, adx);
  const wEW = 1 - sstep(hwEW + 6, hwEW + 30, adz);
  if (wNS > 0) h += (hills(q.i * MILE, z) - h) * wNS;
  if (wEW > 0) h += (hills(x, q.j * MILE) - h) * wEW;
  const onNS = 1 - sstep(hwNS + 0.5, hwNS + 1.5, adx);
  const onEW = 1 - sstep(hwEW + 0.5, hwEW + 1.5, adz);
  h += Math.min(ditch(adx, hwNS) * (1 - onEW), ditch(adz, hwEW) * (1 - onNS));
  // Crown: roads shed water to the edges.
  if (adx < hwNS) h -= 0.07 * (adx / hwNS) * (adx / hwNS) * (1 - onEW);
  if (adz < hwEW) h -= 0.07 * (adz / hwEW) * (adz / hwEW) * (1 - onNS);
  const pd = padDistance(x, z);
  if (pd < 8) h += (hills(PAD.cx, PAD.cz) + 0.1 - h) * (1 - sstep(0, 8, pd));
  return h;
}

/** Signed distance outside the pad rectangle (negative inside). */
export function padDistance(x: number, z: number): number {
  const dx = Math.max(PAD.x0 - x, x - PAD.x1);
  const dz = Math.max(PAD.z0 - z, z - PAD.z1);
  return Math.max(dx, dz);
}

/** Surface normal by central differences. */
export function normalAt(x: number, z: number, out: { x: number; y: number; z: number }, e = 0.35): typeof out {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx;
  const ny = 2 * e;
  const nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
}

export type SurfaceKind = 'asphalt' | 'gravel' | 'grass' | 'mud';

export function fieldTypeAt(x: number, z: number): FieldType {
  const qx = Math.floor(x / QUARTER);
  const qz = Math.floor(z / QUARTER);
  const r = ihash(qx * 7 + 3, qz * 13 + 5);
  return (r < 0.26 ? 0 : r < 0.48 ? 1 : r < 0.66 ? 2 : r < 0.84 ? 3 : 4) as FieldType;
}

/** What the tyres are on. */
export function surfaceAt(x: number, z: number, wetness: number): SurfaceKind {
  const q = nearestRoads(x, z, _rq);
  const adx = Math.abs(q.dx);
  const adz = Math.abs(q.dz);
  const onNS = adx < roadHalf(q.i) + 0.6;
  const onEW = adz < roadHalf(q.j) + 0.6;
  if (onNS || onEW) {
    const paved = (onEW && isPaved(q.j) && adz < roadHalf(q.j)) || (onNS && isPaved(q.i) && adx < roadHalf(q.i));
    return paved ? 'asphalt' : 'gravel';
  }
  const ft = fieldTypeAt(x, z);
  if (wetness > 0.45 && (ft === 2 || ft === 3) && adx > FENCE_OFFSET && adz > FENCE_OFFSET) return 'mud';
  return 'grass';
}

/** Distance to the nearest road centreline. */
export function roadDistance(x: number, z: number): number {
  const q = nearestRoads(x, z, _rq);
  return Math.min(Math.abs(q.dx), Math.abs(q.dz));
}

// ---------------------------------------------------------------------------
// GLSL side — keep in lock-step with the functions above.
// ---------------------------------------------------------------------------

export const WORLD_GLSL = /* glsl */ `
#define MILE ${MILE.toFixed(2)}
#define QUARTER ${QUARTER.toFixed(2)}
#define PAVED_HALF ${PAVED_HALF.toFixed(2)}
#define GRAVEL_HALF ${GRAVEL_HALF.toFixed(2)}
#define FENCE_OFFSET ${FENCE_OFFSET.toFixed(2)}
#define PAD_X0 ${PAD.x0.toFixed(2)}
#define PAD_X1 ${PAD.x1.toFixed(2)}
#define PAD_Z0 ${PAD.z0.toFixed(2)}
#define PAD_Z1 ${PAD.z1.toFixed(2)}
#define PAD_CX ${PAD.cx.toFixed(2)}
#define PAD_CZ ${PAD.cz.toFixed(2)}

float w_ihash(int x, int y) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967296.0);
}

float w_vnoise(vec2 p) {
  vec2 ip = floor(p);
  vec2 f = p - ip;
  vec2 u = f * f * (3.0 - 2.0 * f);
  int ix = int(ip.x);
  int iy = int(ip.y);
  float a = w_ihash(ix, iy);
  float b = w_ihash(ix + 1, iy);
  float c = w_ihash(ix, iy + 1);
  float d = w_ihash(ix + 1, iy + 1);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}

float w_hills(vec2 p) {
  return (w_vnoise(p * 0.00052 + vec2(13.1, -7.7)) - 0.5) * 15.0
       + (w_vnoise(p * 0.0013 + vec2(-3.3, 5.1)) - 0.5) * 5.0
       + (w_vnoise(p * 0.0041 + vec2(1.7, 9.2)) - 0.5) * 1.1;
}

bool w_isPaved(float idx) {
  return mod(idx, 3.0) < 0.5;
}
float w_roadHalf(float idx) { return w_isPaved(idx) ? PAVED_HALF : GRAVEL_HALF; }

float w_padDistance(vec2 p) {
  return max(max(PAD_X0 - p.x, p.x - PAD_X1), max(PAD_Z0 - p.y, p.y - PAD_Z1));
}

float w_ditch(float d, float hw) {
  float a = hw + 1.4;
  float b = hw + 8.5;
  if (d <= a || d >= b) return 0.0;
  return -0.9 * sin(3.14159265 * (d - a) / (b - a));
}

// Returns (iNS, dxSigned, jEW, dzSigned).
vec4 w_roads(vec2 p) {
  float i = floor(p.x / MILE + 0.5);
  float j = floor(p.y / MILE + 0.5);
  return vec4(i, p.x - i * MILE, j, p.y - j * MILE);
}

float w_height(vec2 p) {
  vec4 r = w_roads(p);
  float adx = abs(r.y);
  float adz = abs(r.w);
  float hwNS = w_roadHalf(r.x);
  float hwEW = w_roadHalf(r.z);
  float h = w_hills(p);
  float wNS = 1.0 - smoothstep(hwNS + 6.0, hwNS + 30.0, adx);
  float wEW = 1.0 - smoothstep(hwEW + 6.0, hwEW + 30.0, adz);
  if (wNS > 0.0) h += (w_hills(vec2(r.x * MILE, p.y)) - h) * wNS;
  if (wEW > 0.0) h += (w_hills(vec2(p.x, r.z * MILE)) - h) * wEW;
  float onNS = 1.0 - smoothstep(hwNS + 0.5, hwNS + 1.5, adx);
  float onEW = 1.0 - smoothstep(hwEW + 0.5, hwEW + 1.5, adz);
  h += min(w_ditch(adx, hwNS) * (1.0 - onEW), w_ditch(adz, hwEW) * (1.0 - onNS));
  if (adx < hwNS) h -= 0.07 * (adx / hwNS) * (adx / hwNS) * (1.0 - onEW);
  if (adz < hwEW) h -= 0.07 * (adz / hwEW) * (adz / hwEW) * (1.0 - onNS);
  float pd = w_padDistance(p);
  if (pd < 8.0) h += (w_hills(vec2(PAD_CX, PAD_CZ)) + 0.1 - h) * (1.0 - smoothstep(0.0, 8.0, pd));
  return h;
}

int w_fieldType(vec2 p) {
  int qx = int(floor(p.x / QUARTER));
  int qz = int(floor(p.y / QUARTER));
  float r = w_ihash(qx * 7 + 3, qz * 13 + 5);
  return r < 0.26 ? 0 : r < 0.48 ? 1 : r < 0.66 ? 2 : r < 0.84 ? 3 : 4;
}
`;
