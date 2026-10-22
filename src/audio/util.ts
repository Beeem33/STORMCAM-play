/**
 * Small helpers shared by the procedural audio layers.
 * Nothing in here allocates audio nodes per frame.
 */

export const clamp = (x: number, lo = 0, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length) % arr.length] as T;
/** Unit-mean exponential random variable. */
export const expRand = (): number => -Math.log(1 - Math.random() * 0.999999);
/** Finite-or-fallback, so NaN from the game never reaches an AudioParam. */
export const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

/**
 * Wraps an AudioParam and only issues setTargetAtTime when the target moves
 * by more than a tolerance — keeps the automation timeline short while every
 * change stays smooth (no zipper noise).
 */
export class Smoothed {
  private last: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly param: AudioParam,
    initial: number,
    private readonly tau: number,
    private readonly rel = 0.006,
    private readonly abs = 1e-4,
  ) {
    param.value = initial;
    this.last = initial;
  }

  set(v: number, tau = this.tau): void {
    if (!Number.isFinite(v)) return;
    const d = Math.abs(v - this.last);
    if (d <= this.abs || d <= this.rel * Math.abs(this.last)) return;
    this.last = v;
    this.param.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  get value(): number {
    return this.last;
  }
}

/**
 * Poisson event generator with a time-varying rate (time-rescaling method):
 * correct even when the rate jumps from ~0 to high in a single frame.
 */
export class Poisson {
  private e = expRand();

  /** Calls fire(fraction-of-frame) for every event that falls into this step. */
  step(rate: number, dt: number, fire: (frac: number) => void): void {
    if (!(rate > 0) || !(dt > 0)) return;
    this.e -= rate * dt;
    let guard = 0;
    while (this.e <= 0 && guard++ < 24) {
      fire(Math.random());
      this.e += expRand();
    }
    if (this.e <= 0) this.e = expRand();
  }
}

export function makeGain(ctx: BaseAudioContext, v = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

export function makeFilter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  Q = 0.707,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  f.gain.value = gainDb;
  return f;
}

/** Looping buffer source started at a random offset (decorrelates layers sharing a buffer). */
export function loopSource(ctx: BaseAudioContext, buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(ctx.currentTime, Math.random() * buffer.duration * 0.98);
  return s;
}

/** Connects nodes in series and returns the last one. */
export function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
  return nodes[nodes.length - 1]!;
}

/** Piecewise-linear lookup in a sorted [x, y] table. */
export function interpTable(table: readonly (readonly [number, number])[], x: number): number {
  if (x <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!;
    if (x <= x1) {
      const [x0, y0] = table[i - 1]!;
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return table[table.length - 1]![1];
}
