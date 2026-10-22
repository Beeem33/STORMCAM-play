import { stormReflectivity, type StormCell } from '../weather/StormModel';
import { MAP_HALF, MILE, isPaved } from '../environment/WorldShape';
import type { Tornado } from '../tornado/Tornado';

/**
 * Simulated NEXRAD reflectivity. The radar only knows what it saw on its
 * last volume scan (once a minute, or every 30 s with the pro subscription),
 * at ~250 m resolution — so the picture is always a little stale and coarse,
 * like the real thing. No tornado positions: just the hook echo, and a
 * warning polygon once the weather service issues one.
 */

const N = 170;
const RANGE = 21000; // half-width in metres

export interface StormMark {
  id: number;
  label: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  stage: string;
}

export interface RadarScan {
  time: number;
  cx: number;
  cz: number;
  dbz: Float32Array;
  storms: StormMark[];
  warning: { x: number; z: number; vx: number; vz: number } | null;
}

const COLORS: [number, string][] = [
  [18, '#019ff4'], [22, '#0300f4'], [25, '#02fd02'], [30, '#01c501'], [35, '#008e00'],
  [40, '#fdf802'], [45, '#e5bc00'], [50, '#fd9500'], [55, '#fd0000'], [60, '#d40000'], [65, '#bc0000'], [70, '#f800fd'],
];
const RGB = COLORS.map(([d, hex]) => [d, parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const);

export class Radar {
  scan: RadarScan | null = null;
  private timer = 0;
  interval = 60;
  targetId: number | null = null;
  private readonly img: ImageData;
  private readonly off: HTMLCanvasElement;

  constructor() {
    this.off = document.createElement('canvas');
    this.off.width = N;
    this.off.height = N;
    this.img = this.off.getContext('2d')!.createImageData(N, N);
  }

  get scanAge(): number {
    return this.scan ? this.timer : Infinity;
  }

  reset(): void {
    this.scan = null;
    this.timer = 0;
    this.targetId = null;
  }

  update(dt: number, time: number, cx: number, cz: number, storms: readonly StormCell[], tornado: Tornado | null): void {
    this.timer += dt;
    if (this.scan && this.timer < this.interval) return;
    this.timer = 0;
    const dbz = new Float32Array(N * N);
    // Beam noise: speckle so it looks sampled.
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = cx + ((i + 0.5) / N - 0.5) * RANGE * 2;
        const z = cz + ((j + 0.5) / N - 0.5) * RANGE * 2;
        let v = 0;
        for (const s of storms) v = Math.max(v, stormReflectivity(s, x, z));
        if (v > 0) v += (Math.random() - 0.5) * 2.5;
        dbz[j * N + i] = v;
      }
    let warning: RadarScan['warning'] = null;
    if (tornado && tornado.presence > 0.3) {
      const s = tornado.storm;
      warning = { x: s.x, z: s.z, vx: s.vx, vz: s.vz };
    }
    this.scan = {
      time,
      cx,
      cz,
      dbz,
      storms: storms.map((s) => ({ id: s.id, label: s.label, x: s.x, z: s.z, vx: s.vx, vz: s.vz, stage: s.stage })),
      warning,
    };
    // Keep the target valid.
    if (this.targetId !== null && !storms.some((s) => s.id === this.targetId)) this.targetId = null;
  }

  forceScan(): void {
    this.timer = this.interval;
  }

  target(): StormMark | null {
    if (!this.scan || this.targetId === null) return null;
    return this.scan.storms.find((s) => s.id === this.targetId) ?? null;
  }

  /**
   * Draw the radar into a canvas. `view` = current player pose (live GPS),
   * the precipitation itself is from the last scan.
   */
  draw(ctx: CanvasRenderingContext2D, size: number, view: { x: number; z: number; heading: number }, clockLabel: (t: number) => string): void {
    const s = this.scan;
    ctx.fillStyle = '#0d1114';
    ctx.fillRect(0, 0, size, size);
    const scale = size / (RANGE * 2);
    const cx = view.x;
    const cz = view.z;
    const toPx = (x: number, z: number): [number, number] => [(x - cx) * scale + size / 2, (z - cz) * scale + size / 2];

    // County-road grid.
    const i0 = Math.floor((cx - RANGE) / MILE), i1 = Math.ceil((cx + RANGE) / MILE);
    const j0 = Math.floor((cz - RANGE) / MILE), j1 = Math.ceil((cz + RANGE) / MILE);
    for (let i = i0; i <= i1; i++) {
      const [px] = toPx(i * MILE, 0);
      ctx.strokeStyle = isPaved(i) ? 'rgba(220,220,210,0.28)' : 'rgba(200,200,190,0.05)';
      ctx.lineWidth = isPaved(i) ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, size);
      ctx.stroke();
    }
    for (let j = j0; j <= j1; j++) {
      const [, pz] = toPx(0, j * MILE);
      ctx.strokeStyle = isPaved(j) ? 'rgba(220,220,210,0.28)' : 'rgba(200,200,190,0.05)';
      ctx.lineWidth = isPaved(j) ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(0, pz);
      ctx.lineTo(size, pz);
      ctx.stroke();
    }

    if (s) {
      // Reflectivity image (from the scan's own centre).
      const d = this.img.data;
      for (let k = 0; k < N * N; k++) {
        const v = s.dbz[k];
        let c: (typeof RGB)[number] | null = null;
        for (const e of RGB) if (v >= e[0]) c = e;
        const o = k * 4;
        if (!c) {
          d[o + 3] = 0;
          continue;
        }
        d[o] = c[1];
        d[o + 1] = c[2];
        d[o + 2] = c[3];
        d[o + 3] = 205;
      }
      this.off.getContext('2d')!.putImageData(this.img, 0, 0);
      const [ox, oz] = toPx(s.cx - RANGE, s.cz - RANGE);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.off, ox, oz, RANGE * 2 * scale, RANGE * 2 * scale);
      ctx.imageSmoothingEnabled = true;

      // Warning polygon: a cone downstream of the storm, 45 minutes of travel.
      if (s.warning) {
        const w = s.warning;
        const sp = Math.hypot(w.vx, w.vz) || 1;
        const fx = w.vx / sp, fz = w.vz / sp;
        const len = sp * 1800;
        const pts: [number, number][] = [
          [w.x - fx * 3000 - fz * 3500, w.z - fz * 3000 + fx * 3500],
          [w.x - fx * 3000 + fz * 3500, w.z - fz * 3000 - fx * 3500],
          [w.x + fx * len + fz * 9000, w.z + fz * len - fx * 9000],
          [w.x + fx * len - fz * 9000, w.z + fz * len + fx * 9000],
        ];
        ctx.strokeStyle = '#ff2020';
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach(([x, z], k) => {
          const [px, pz] = toPx(x, z);
          if (k === 0) ctx.moveTo(px, pz);
          else ctx.lineTo(px, pz);
        });
        ctx.closePath();
        ctx.stroke();
      }

      // Storm IDs and bold arrows: where each storm will be in 20 minutes.
      ctx.font = '600 13px "IBM Plex Mono", monospace';
      for (const m of s.storms) {
        const [px, pz] = toPx(m.x, m.z);
        const [ex, ez] = toPx(m.x + m.vx * 1200, m.z + m.vz * 1200);
        const ang = Math.atan2(ez - pz, ex - px);
        const tor = m.stage === 'tornadic';
        for (const [col, w] of [['#000', 7], [tor ? '#ff4a3d' : '#ffffff', 3.5]] as const) {
          ctx.strokeStyle = col;
          ctx.fillStyle = col;
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(px, pz);
          ctx.lineTo(ex - Math.cos(ang) * 8, ez - Math.sin(ang) * 8);
          ctx.stroke();
          const hs = w > 5 ? 15 : 12;
          ctx.beginPath();
          ctx.moveTo(ex + Math.cos(ang) * (w > 5 ? 3 : 0), ez + Math.sin(ang) * (w > 5 ? 3 : 0));
          ctx.lineTo(ex - Math.cos(ang - 0.45) * hs, ez - Math.sin(ang - 0.45) * hs);
          ctx.lineTo(ex - Math.cos(ang + 0.45) * hs, ez - Math.sin(ang + 0.45) * hs);
          ctx.closePath();
          ctx.fill();
        }
        const sel = m.id === this.targetId;
        ctx.fillStyle = sel ? '#ffd23a' : '#ffffff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px, pz, sel ? 6 : 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
        const label = `${m.label}`;
        ctx.strokeText(label, px + 9, pz - 7);
        ctx.fillText(label, px + 9, pz - 7);
      }
    }

    // Chase-area boundary.
    {
      const [ax, az] = toPx(-MAP_HALF, -MAP_HALF);
      ctx.strokeStyle = 'rgba(255,210,58,0.55)';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ax, az, MAP_HALF * 2 * scale, MAP_HALF * 2 * scale);
      ctx.setLineDash([]);
    }
    // Range rings (10 mi).
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (const r of [5, 10]) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, r * MILE * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Player (live GPS).
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(view.heading);
    ctx.fillStyle = '#3af0ff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();

    // Legend and scan time.
    ctx.font = '500 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, size - 22, size, 22);
    ctx.fillStyle = '#cfd6da';
    const age = s ? Math.floor(this.timer) : 0;
    ctx.fillText(s ? `REFLECTIVITY  ·  SCAN ${clockLabel(s.time)}  ·  ${age}s OLD` : 'WAITING FOR FIRST SCAN…', 8, size - 7);
    COLORS.forEach(([, col], k) => {
      ctx.fillStyle = col;
      ctx.fillRect(size - 12 * (COLORS.length - k) - 6, size - 16, 11, 10);
    });
  }
}
