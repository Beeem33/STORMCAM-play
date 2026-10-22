/**
 * Kinematic model of a classic-supercell's footprint, shared by gameplay
 * (rain at the car, wind, radar) and — in GLSL — by the sky shader.
 *
 * Storm-relative frame: origin at the mesocyclone/updraft, `a` = distance
 * ahead along the storm motion, `b` = distance to the right of motion. For a
 * storm moving north-east the forward-flank rain core sits ahead-left of the
 * updraft and the hook echo wraps cyclonically around its rear.
 */

export type StormStage = 'developing' | 'mature' | 'tornadic' | 'dissipating';

export interface StormCell {
  id: number;
  label: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Characteristic size of the base/core, metres (~4–7 km). */
  radius: number;
  /** 0..1 overall strength (precip, darkness, lightning). */
  intensity: number;
  /** 0..1 mesocyclone strength — wall cloud, striations, hook echo. */
  meso: number;
  stage: StormStage;
  age: number;
  /** Seconds until the next stage change (simulation detail). */
  stageTimer: number;
  /** Will this storm produce a tornado if it matures? */
  tornadic: boolean;
  hasTornado: boolean;
  /** Seed for per-storm variation. */
  seed: number;
}

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface StormLocal {
  /** distance ahead (+) / behind (-) of the updraft along motion */
  a: number;
  /** distance right (+) / left (-) of motion */
  b: number;
}

export function toStormFrame(s: StormCell, x: number, z: number, out: StormLocal): StormLocal {
  const sp = Math.hypot(s.vx, s.vz) || 1;
  const fx = s.vx / sp;
  const fz = s.vz / sp;
  const dx = x - s.x;
  const dz = z - s.z;
  out.a = dx * fx + dz * fz;
  // right of motion: rotate forward 90° clockwise seen from above (north = -z)
  out.b = dx * -fz + dz * fx;
  return out;
}

const _l: StormLocal = { a: 0, b: 0 };

/** 0..1 cloud-base coverage overhead. */
export function stormCover(s: StormCell, x: number, z: number): number {
  const l = toStormFrame(s, x, z, _l);
  const R = s.radius;
  const ea = (l.a - 0.45 * R) / (1.45 * R);
  const eb = (l.b + 0.1 * R) / (0.95 * R);
  const e = Math.sqrt(ea * ea + eb * eb);
  return s.intensity * (1 - sstep(0.5, 1.0, e));
}

/** 0..1 anvil coverage (high cirrus shield streaming downstream). */
export function stormAnvil(s: StormCell, x: number, z: number): number {
  const l = toStormFrame(s, x, z, _l);
  const R = s.radius;
  if (l.a < -1.2 * R) return 0;
  const along = Math.max(0, l.a + 1.2 * R);
  const width = 1.2 * R + along * 0.45;
  const lat = Math.abs(l.b + 0.2 * R) / width;
  return s.intensity * (1 - sstep(0.6, 1.0, lat)) * (1 - sstep(7 * R, 10 * R, along));
}

/** 0..1 rain rate. */
export function stormPrecip(s: StormCell, x: number, z: number): number {
  const l = toStormFrame(s, x, z, _l);
  const R = s.radius;
  // Forward-flank core.
  const ca = (l.a - 0.75 * R) / (0.95 * R);
  const cb = (l.b + 0.4 * R) / (0.55 * R);
  const ffd = 1 - sstep(0.15, 1.0, Math.sqrt(ca * ca + cb * cb));
  // Hook echo: a ring around the updraft, missing in the front-right inflow notch.
  const d = Math.hypot(l.a, l.b);
  const ring = 1 - sstep(0.06 * R, 0.13 * R, Math.abs(d - 0.24 * R));
  const theta = Math.atan2(l.b, l.a); // 0 ahead, +PI/2 right
  const arc = sstep(-0.2, 0.6, -Math.sin(theta) * 0.8 - Math.cos(theta) * 0.6 + 0.35);
  const hook = ring * arc * s.meso;
  return s.intensity * Math.max(ffd * ffd * 1.15, hook * 0.8);
}

/** 0..1 hail rate — near the updraft on the edge of the core. */
export function stormHail(s: StormCell, x: number, z: number): number {
  const l = toStormFrame(s, x, z, _l);
  const R = s.radius;
  const ha = (l.a - 0.38 * R) / (0.28 * R);
  const hb = (l.b + 0.32 * R) / (0.2 * R);
  const h = 1 - sstep(0.3, 1.0, Math.sqrt(ha * ha + hb * hb));
  return h * s.intensity * s.intensity * (s.stage === 'developing' ? 0.3 : 1);
}

/**
 * Storm-scale surface wind (not the tornado): warm moist inflow feeding the
 * updraft from ahead-right, outflow gusts pushing out of the rain core.
 * Returns m/s in world xz.
 */
export function stormWind(s: StormCell, x: number, z: number, out: { x: number; z: number }): typeof out {
  const dx = x - s.x;
  const dz = z - s.z;
  const d = Math.hypot(dx, dz) + 1;
  const R = s.radius;
  // Inflow: converging toward the updraft, strongest within ~1.5R.
  const inflow = s.intensity * 9 * Math.exp(-d / (1.6 * R));
  out.x = (-dx / d) * inflow;
  out.z = (-dz / d) * inflow;
  // Cyclonic swirl around the meso (counter-clockwise seen from above with north = -z).
  const swirl = s.meso * 7 * Math.exp(-d / (0.6 * R));
  out.x += (-dz / d) * -swirl;
  out.z += (dx / d) * -swirl;
  // Outflow out of the precip core.
  const p = stormPrecip(s, x, z);
  const sp = Math.hypot(s.vx, s.vz) || 1;
  out.x += (s.vx / sp) * p * 10;
  out.z += (s.vz / sp) * p * 10;
  return out;
}

/** Simulated radar reflectivity in dBZ (≤ 5 means nothing shown). */
export function stormReflectivity(s: StormCell, x: number, z: number): number {
  const p = stormPrecip(s, x, z);
  const c = stormCover(s, x, z);
  const hail = stormHail(s, x, z);
  const light = Math.max(p, c * 0.32);
  if (light < 0.02) return 0;
  return 8 + light * 52 + hail * 12;
}
