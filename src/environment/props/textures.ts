import * as THREE from 'three';
import { clamp, hash4, mulberry32, tfbm2 } from './util';
import type { Rect } from './util';

// ---------------------------------------------------------------- cache + canvas helpers

const cache = new Map<string, unknown>();
/** Module-level cache shared by every texture / material / asset in the props library. */
export function memo<T>(key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const v = make();
  cache.set(key, v);
  return v;
}

export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const x = c.getContext('2d');
  if (!x) throw new Error('props: no 2d context');
  return x;
}
/** Canvas -> texture. tileW/tileH: metres covered by one repeat (geometry UVs are metric). */
export function mkTex(c: HTMLCanvasElement, srgb: boolean, tileW = 1, tileH = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.repeat.set(1 / tileW, 1 / tileH);
  t.needsUpdate = true;
  return t;
}
/** Atlas rect from canvas pixel coords (canvas y down; CanvasTexture flips Y). */
export function rectPx(x: number, y: number, w: number, h: number, W: number, H: number): Rect {
  return [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
}

export interface TexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
}

const to8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/** Float image: colour (sRGB 0..1), height (metres) and roughness. */
export class Img {
  readonly w: number;
  readonly h: number;
  readonly col: Float32Array;
  readonly hgt: Float32Array;
  readonly rough: Float32Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.col = new Float32Array(w * h * 3);
    this.hgt = new Float32Array(w * h);
    this.rough = new Float32Array(w * h).fill(0.8);
  }
  px(x: number, y: number, r: number, g: number, b: number, h: number, ro: number): void {
    const i = y * this.w + x;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.hgt[i] = h;
    this.rough[i] = ro;
  }
  colorCanvas(): HTMLCanvasElement {
    const c = canvas(this.w, this.h), x = ctx2d(c), id = x.createImageData(this.w, this.h);
    for (let j = 0; j < this.w * this.h; j++) {
      id.data[j * 4] = to8(this.col[j * 3]!);
      id.data[j * 4 + 1] = to8(this.col[j * 3 + 1]!);
      id.data[j * 4 + 2] = to8(this.col[j * 3 + 2]!);
      id.data[j * 4 + 3] = 255;
    }
    x.putImageData(id, 0, 0);
    return c;
  }
  normalCanvas(mppX: number, mppY: number, k: number): HTMLCanvasElement {
    const { w, h, hgt } = this;
    const c = canvas(w, h), x = ctx2d(c), id = x.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const yu = (y - 1 + h) % h, yd = (y + 1) % h;
      for (let xx = 0; xx < w; xx++) {
        const xl = (xx - 1 + w) % w, xr = (xx + 1) % w;
        const dx = ((hgt[y * w + xr]! - hgt[y * w + xl]!) / (2 * mppX)) * k;
        const dy = ((hgt[yu * w + xx]! - hgt[yd * w + xx]!) / (2 * mppY)) * k;
        const nx = -dx, ny = -dy, nz = 1;
        const l = 1 / Math.hypot(nx, ny, nz);
        const j = (y * w + xx) * 4;
        id.data[j] = to8(nx * l * 0.5 + 0.5);
        id.data[j + 1] = to8(ny * l * 0.5 + 0.5);
        id.data[j + 2] = to8(nz * l * 0.5 + 0.5);
        id.data[j + 3] = 255;
      }
    }
    x.putImageData(id, 0, 0);
    return c;
  }
  roughCanvas(): HTMLCanvasElement {
    const c = canvas(this.w, this.h), x = ctx2d(c), id = x.createImageData(this.w, this.h);
    for (let j = 0; j < this.w * this.h; j++) {
      const v = to8(this.rough[j]!);
      id.data[j * 4] = v;
      id.data[j * 4 + 1] = v;
      id.data[j * 4 + 2] = v;
      id.data[j * 4 + 3] = 255;
    }
    x.putImageData(id, 0, 0);
    return c;
  }
  set(tileW: number, tileH: number, k = 1): TexSet {
    return {
      map: mkTex(this.colorCanvas(), true, tileW, tileH),
      normalMap: mkTex(this.normalCanvas(tileW / this.w, tileH / this.h, k), false, tileW, tileH),
      roughnessMap: mkTex(this.roughCanvas(), false, tileW, tileH),
      emissiveMap: null,
    };
  }
}

/** Precomputed tileable fBm tile, sampled bilinearly with wrap (fast). */
export class NoiseTile {
  readonly d = new Float32Array(256 * 256);
  constructor(seed: number) {
    let mn = Infinity, mx = -Infinity;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const v = tfbm2(x / 256, y / 256, 4, 4, 5, seed);
        this.d[y * 256 + x] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    const s = 1 / (mx - mn || 1);
    for (let i = 0; i < this.d.length; i++) this.d[i] = (this.d[i]! - mn) * s;
  }
  at(u: number, v: number): number {
    const x = u * 256 - 0.5, y = v * 256 - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const xa = x0 & 255, xb = (x0 + 1) & 255, ya = (y0 & 255) * 256, yb = ((y0 + 1) & 255) * 256;
    const d = this.d;
    const a = d[ya + xa]!, b = d[ya + xb]!, c = d[yb + xa]!, e = d[yb + xb]!;
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
  }
}
export const nt = (i: number): NoiseTile => memo('nt' + i, () => new NoiseTile(9001 + i * 131));

// ---------------------------------------------------------------- text helpers (signs, gas station)

export const SIGN_FONT = '"Highway Gothic", "Roadgeek 2005 Series D", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
export function text(
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color: string,
  o: { weight?: string; align?: CanvasTextAlign; squeeze?: number; family?: string; maxW?: number } = {},
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.font = `${o.weight ?? 'bold'} ${px}px ${o.family ?? SIGN_FONT}`;
  let sq = o.squeeze ?? 1;
  if (o.maxW !== undefined) {
    const w = ctx.measureText(s).width * sq;
    if (w > o.maxW) sq *= o.maxW / w;
  }
  ctx.scale(sq, 1);
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, 0, 0);
  ctx.restore();
}
/** Weathering overlay: specks, faint streaks, edge grime. */
export function grime(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, amt = 1): void {
  const r = mulberry32(seed);
  ctx.save();
  for (let i = 0; i < 260 * amt; i++) {
    ctx.fillStyle = `rgba(40,36,30,${0.04 + r() * 0.1})`;
    const s = 1 + r() * 3;
    ctx.fillRect(r() * w, r() * h, s, s);
  }
  for (let i = 0; i < 18 * amt; i++) {
    ctx.fillStyle = `rgba(60,55,45,${0.025 + r() * 0.04})`;
    const x = r() * w;
    ctx.fillRect(x, r() * h * 0.3, 2 + r() * 6, h * (0.3 + r() * 0.7));
  }
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,250,0.04)');
  g.addColorStop(1, 'rgba(50,45,35,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------- surface textures

/** Painted lap siding, 0.1 m exposure. Neutral (tint with material colour). Tile 2.4 x 1.2 m. */
export function sidingTex(): TexSet {
  return memo('t:siding', () => {
    const W = 512, H = 256, im = new Img(W, H);
    const boards = 12, bh = H / boards, n1 = nt(0), n2 = nt(1);
    const rnd = mulberry32(7);
    const joints = Array.from({ length: boards }, () => rnd() * W);
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / bh), t = (y - row * bh) / bh, j = joints[row]!;
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        let h = 0.002 + 0.011 * t;
        let ao = t < 0.2 ? 0.58 + 0.42 * (t / 0.2) : 1;
        if (t > 0.93) ao *= 0.9;
        let dj = Math.abs(x - j);
        dj = Math.min(dj, W - dj);
        if (dj < 1.5) { ao *= 0.72; h -= 0.0015; }
        const grain = n1.at(u * 2, v * 24), wth = n2.at(u, v);
        const c = (0.9 - 0.16 * wth + 0.06 * (grain - 0.5) - 0.03 * hash4(x, y, 1, 3)) * ao;
        im.px(x, y, c, c * 0.99, c * 0.965, h + 0.0006 * grain, 0.68 + 0.22 * wth);
      }
    }
    return im.set(2.4, 1.2);
  });
}

/** 3-tab asphalt shingles. Neutral grey (tint). Tile 2.0 x 1.96 m. */
export function shingleTex(): TexSet {
  return memo('t:shingle', () => {
    const W = 512, H = 512, im = new Img(W, H);
    const courses = 14, ch = H / courses, tw = W / 6, n1 = nt(2), n2 = nt(3);
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / ch), t = (y - row * ch) / ch, off = (row % 2) * tw * 0.5;
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const xx = (x + off) % W, tab = Math.floor(xx / tw), tx = xx - tab * tw;
        const tone = hash4(row, tab, 0, 9), gr = hash4(x, y, 2, 4);
        const ao = t < 0.12 ? 0.5 + 0.5 * (t / 0.12) : 1;
        let c = (0.64 + 0.24 * tone + 0.26 * (gr - 0.5)) * ao;
        const streak = n1.at(u * 8, v);
        if (streak > 0.6) c *= 1 - (streak - 0.6) * 1.1;
        c *= 0.9 + 0.16 * n2.at(u * 2, v * 2);
        let h = 0.001 + 0.004 * t + gr * 0.0005;
        if ((tx < 2 || tx > tw - 2) && t > 0.45) { c = 0.26 * ao; h = 0.0004; }
        im.px(x, y, c, c * 0.985, c * 0.96, h, 0.86 + 0.1 * gr);
      }
    }
    return im.set(2.0, 1.96);
  });
}

/** Common red brick, running bond. Tile 0.84 x 0.54 m. */
export function brickTex(): TexSet {
  return memo('t:brick', () => {
    const W = 256, H = 256, im = new Img(W, H), n = nt(4);
    for (let y = 0; y < H; y++) {
      const my = ((y + 0.5) / H) * 0.54, row = Math.floor(my / 0.0675), ly = my - row * 0.0675;
      for (let x = 0; x < W; x++) {
        const mx = ((x + 0.5) / W) * 0.84, bx = (mx + (row % 2) * 0.105) % 0.84, bi = Math.floor(bx / 0.21), lx = bx - bi * 0.21;
        const nn = n.at(x / W * 3, y / H * 3), gr = hash4(x, y, 3, 5);
        if (lx < 0.011 || ly < 0.011) {
          const c = 0.56 + 0.08 * nn + 0.06 * (gr - 0.5);
          im.px(x, y, c, c * 0.96, c * 0.9, 0, 0.95);
        } else {
          const tone = hash4(row, bi, 0, 21);
          const dark = tone > 0.86 ? 0.75 : 1;
          const k = (0.88 + 0.2 * tone + 0.12 * (gr - 0.5) + 0.1 * (nn - 0.5)) * dark;
          im.px(x, y, 0.5 * k, 0.26 * k, 0.2 * k, 0.007 + 0.001 * gr, 0.85);
        }
      }
    }
    return im.set(0.84, 0.54);
  });
}

/** Weathered concrete, neutral. Tile 3 x 3 m. */
export function concreteTex(): TexSet {
  return memo('t:concrete', () => {
    const W = 512, H = 512, im = new Img(W, H), n1 = nt(4), n2 = nt(5);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const a = n1.at(u * 2, v * 2), b = n2.at(u * 6, v * 6), g = hash4(x, y, 5, 6);
        let c = 0.7 + 0.14 * (a - 0.5) + 0.08 * (b - 0.5) + 0.06 * (g - 0.5);
        let h = 0.0012 * b + 0.0004 * g;
        if (hash4(x, y, 7, 8) > 0.996) { c *= 0.7; h -= 0.002; }
        if (a > 0.72) c *= 1 - (a - 0.72) * 0.8;
        im.px(x, y, c, c * 0.985, c * 0.955, h, 0.84 + 0.12 * b);
      }
    return im.set(3, 3);
  });
}

/** Subtle painted-surface noise, neutral. Tile 1.5 m. */
export function paintTex(): TexSet {
  return memo('t:paint', () => {
    const W = 256, H = 256, im = new Img(W, H), n1 = nt(6), n2 = nt(7);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, a = n1.at(u, v), b = n2.at(u * 4, v * 4), g = hash4(x, y, 9, 2);
        const c = 0.9 - 0.12 * a + 0.04 * (b - 0.5) - 0.025 * g;
        im.px(x, y, c, c, c * 0.985, 0.0004 * b, 0.55 + 0.2 * a);
      }
    return im.set(1.5, 1.5);
  });
}

/** Vertical barn boards with narrow battens: faded red paint peeling, or bare weathered grey. Tile 2.4 m. */
export function boardsTex(kind: 'red' | 'grey'): TexSet {
  return memo('t:boards:' + kind, () => {
    const W = 512, H = 512, im = new Img(W, H), nb = 10, bw = W / nb;
    const n1 = nt(8), n2 = nt(9), n3 = nt(10);
    const rnd = mulberry32(kind === 'red' ? 31 : 37);
    const tone = Array.from({ length: nb }, () => rnd());
    const butt = Array.from({ length: nb }, () => (rnd() < 0.5 ? Math.floor(rnd() * H) : -100));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, k = Math.floor(x / bw), lx = x - k * bw;
        const dj = Math.min(lx, bw - lx);
        const batten = dj < 5;
        let h = batten ? 0.02 - (dj > 3.5 ? (dj - 3.5) * 0.008 : 0) : 0;
        let ao = batten ? 1 : dj < 8 ? 0.62 + 0.38 * ((dj - 5) / 3) : 1;
        const bt = batten ? hash4(k, 0, 0, 5) : tone[k]!;
        const grain = n1.at(u * 32, v * 2), fine = hash4(x, y >> 2, 1, 11);
        if (!batten && Math.abs(y - butt[k]!) < 1.2) ao *= 0.55;
        let wg = (0.46 + 0.1 * bt + 0.14 * (grain - 0.5) + 0.04 * (fine - 0.5)) * ao;
        const streak = n2.at(u * 12, v);
        if (streak > 0.55) wg *= 1 - (streak - 0.55) * 0.7;
        let r = wg * 1.02, g = wg * 0.97, b = wg * 0.88, ro = 0.92;
        h += 0.001 * grain;
        if (kind === 'red') {
          const paint = n2.at(u * 3, v * 3) + 0.3 * n3.at(u * 12, v * 12) - 0.12 * bt;
          if (paint > 0.43) {
            const chalk = n3.at(u * 2, v * 2);
            const f = 0.85 + 0.15 * grain;
            r = (0.5 + 0.1 * chalk) * f * ao;
            g = (0.17 + 0.1 * chalk) * f * ao;
            b = (0.13 + 0.08 * chalk) * f * ao;
            ro = 0.78;
            h += 0.0006;
            if (paint < 0.47) { r *= 1.1; g *= 1.15; b *= 1.15; }
          }
        }
        if (batten && dj < 1.5 && y % 128 < 2) { r *= 0.4; g *= 0.4; b *= 0.4; }
        im.px(x, y, r, g, b, h, ro);
      }
    return im.set(2.4, 2.4);
  });
}

/** PBR-style ribbed steel panel (ribs run along v). 'plain' = neutral for paint tint, 'rust' = old galvanized. Tile 1.83 x 2 m. */
export function ribTex(kind: 'plain' | 'rust'): TexSet {
  return memo('t:rib:' + kind, () => {
    const W = 512, H = 512, im = new Img(W, H), TW = 1.8288, n1 = nt(11), n2 = nt(12), n3 = nt(13);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const m = ((x + 0.5) / W) * TW, local = m % 0.3048, d = Math.abs(local - 0.1524);
        let h = d < 0.0127 ? 0.019 : d < 0.0445 ? 0.019 * (1 - (d - 0.0127) / 0.0318) : 0;
        const dm = Math.min(Math.abs(local - 0.0508), Math.abs(local - 0.254));
        if (dm < 0.006) h += 0.003 * (1 - dm / 0.006);
        const screw = y % 128 < 3 && Math.abs(d - 0.06) < 0.004;
        const streak = n1.at(u * 6, v), mot = n2.at(u * 3, v * 3), g = hash4(x, y, 4, 4);
        let r: number, gg: number, b: number, ro: number;
        if (kind === 'plain') {
          const c = 0.86 - 0.1 * mot - (streak > 0.6 ? (streak - 0.6) * 0.4 : 0) + 0.03 * (g - 0.5);
          r = c; gg = c; b = c * 0.99; ro = 0.48 + 0.2 * mot;
        } else {
          const rust = mot * 0.9 + 0.3 * n3.at(u * 10, v * 10) + (streak > 0.62 ? 0.12 : 0);
          const c = 0.6 + 0.08 * (n3.at(u * 20, v * 20) - 0.5) + 0.04 * (g - 0.5);
          r = c; gg = c * 1.01; b = c * 1.02; ro = 0.55;
          if (rust > 0.86) {
            const t = clamp((rust - 0.86) * 4, 0, 1);
            const rr = 0.47 - 0.1 * g, rg = 0.27 - 0.06 * g, rb = 0.15 - 0.04 * g;
            r = r + (rr - r) * t; gg = gg + (rg - gg) * t; b = b + (rb - b) * t; ro = 0.55 + 0.35 * t;
          }
        }
        const ao = h < 0.002 && d < 0.05 ? 0.9 : 1;
        if (screw) { r *= 0.65; gg *= 0.65; b *= 0.65; }
        im.px(x, y, r * ao, gg * ao, b * ao, h, ro);
      }
    return im.set(TW, 2.0, 0.7);
  });
}

/** Corrugated galvanized grain-bin wall: horizontal waves, ring laps, bolts, a stiffener. Tile 2.74 x 0.8128 m. */
export function binTex(): TexSet {
  return memo('t:bin', () => {
    const W = 512, H = 256, im = new Img(W, H), n1 = nt(14), n2 = nt(15), n3 = nt(16);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        let h = 0.0065 * Math.sin(Math.PI * 2 * 12 * v);
        let ao = 1;
        if (y < 7) h += 0.0015;
        if (y >= 7 && y < 9) ao *= 0.72;
        if (x < 8) h += 0.0015;
        if (x >= 8 && x < 10) ao *= 0.8;
        const ds = Math.abs(x - 256);
        if (ds < 8) { h += ds < 5 ? 0.016 : 0.016 * (1 - (ds - 5) / 3); if (ds > 5 && ds < 8) ao *= 0.85; }
        const bolt = (y > 1 && y < 6 && x % 19 < 3) || (x > 2 && x < 6 && y % 21 < 3) || (ds < 2 && y % 21 < 3);
        const spang = n3.at(u * 24, v * 8), ox = n1.at(u * 2, v), dirt = n2.at(u * 4, v * 2);
        let c = 0.76 + 0.07 * (spang - 0.5) + 0.03 * (hash4(x, y, 6, 1) - 0.5);
        let ro = 0.42 + 0.12 * spang;
        if (ox > 0.62) { c += (ox - 0.62) * 0.25; ro += (ox - 0.62) * 0.8; }
        if (dirt > 0.66) c *= 1 - (dirt - 0.66) * 0.6;
        if (y >= 9 && y < 30) c *= 0.97;
        let r = c * 0.97, g = c * 0.985, b = c;
        if (bolt) { r *= 0.5; g *= 0.5; b *= 0.5; }
        im.px(x, y, r * ao, g * ao, b * ao, h, ro);
      }
    return im.set(2.74, 0.8128, 0.45);
  });
}

/** Grain bin roof: one radial panel across u (rib at the seam), tile 1 panel x 2 m. */
export function binRoofTex(): TexSet {
  return memo('t:binroof', () => {
    const W = 128, H = 256, im = new Img(W, H), n1 = nt(17), n2 = nt(18);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, d = Math.min(x, W - x);
        const h = d < 3 ? 0.02 : d < 6 ? 0.02 * (1 - (d - 3) / 3) : 0;
        const ao = d >= 6 && d < 8 ? 0.85 : 1;
        const sp = n1.at(u * 4, v * 8), ox = n2.at(u, v * 2);
        let c = 0.74 + 0.07 * (sp - 0.5);
        if (ox > 0.6) c *= 1 - (ox - 0.6) * 0.5;
        im.px(x, y, c * 0.97 * ao, c * 0.985 * ao, c * ao, h, 0.45 + 0.2 * ox);
      }
    return im.set(1, 2.0);
  });
}

/** Concrete silo staves 30"x10", staggered, rain/rust streaks. Tile 1.524 x 6.096 m. */
export function staveTex(): TexSet {
  return memo('t:stave', () => {
    const W = 256, H = 1024, im = new Img(W, H), course = H / 24, n1 = nt(19), n2 = nt(20), n3 = nt(21);
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / course), ly = y - row * course, off = (row % 2) * 64;
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, lx = (x + off) % 128;
        const st = hash4(row, Math.floor(((x + off) % W) / 128), 0, 41), g = hash4(x, y, 2, 9);
        const joint = ly < 1.6 || lx < 1.6;
        let c = (0.72 + 0.06 * (st - 0.5)) * (0.94 + 0.12 * n1.at(u * 2, v * 8)) + 0.04 * (g - 0.5);
        let h = joint ? 0 : 0.004 + 0.0008 * g;
        if (!joint && hash4(x, y, 3, 3) > 0.993) { c *= 0.7; h -= 0.002; }
        if (joint) c *= 0.8;
        const s = n2.at(u * 12, v);
        if (s > 0.52) c *= 1 - (s - 0.52) * 0.9;
        let r = c, gg = c * 0.98, b = c * 0.93;
        const rust = n3.at(u * 8, v * 2);
        if (rust > 0.68) {
          const t = Math.min(1, (rust - 0.68) * 3);
          r = r * (1 - t * 0.2) + 0.12 * t; gg *= 1 - t * 0.25; b *= 1 - t * 0.4;
        }
        im.px(x, y, r, gg, b, h, 0.92);
      }
    }
    return im.set(1.524, 6.096);
  });
}

/** Weathered wood, vertical grain with checks; neutral grey-brown (tint). Tile 0.3 x 1.2 m. */
export function woodTex(): TexSet {
  return memo('t:wood', () => {
    const W = 128, H = 512, im = new Img(W, H), n1 = nt(22), n2 = nt(23), n3 = nt(24);
    const checks = [17, 49, 88, 111];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const g = n1.at(u * 4, v) + 0.5 * n2.at(u * 16, v * 2);
        const fine = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 24 + g * 7);
        let c = 0.64 + 0.16 * (g - 0.75) - 0.07 * fine + 0.03 * (hash4(x, y, 1, 7) - 0.5);
        let h = 0.0008 * fine;
        for (const cx of checks) if (Math.abs(x - cx - 3 * (n3.at(u, v * 3) - 0.5)) < 0.9 && n3.at(u * 2, v * 4) > 0.5) { c *= 0.45; h -= 0.003; }
        im.px(x, y, c, c * 0.97, c * 0.9, h, 0.9);
      }
    return im.set(0.3, 1.2);
  });
}

/** Porch skirt lattice: white laths over a dark void. Tile 0.6 m. */
export function latticeTex(): TexSet {
  return memo('t:lattice', () => {
    const W = 128, H = 128, im = new Img(W, H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const a = (x + y) % 64, b = (x - y + 128) % 64;
        const la = a < 9, lb = b < 9;
        const g = hash4(x, y, 2, 2);
        if (la || lb) {
          const c = 0.78 + 0.06 * (g - 0.5);
          im.px(x, y, c, c, c * 0.97, la && lb ? 0.02 : 0.01, 0.7);
        } else im.px(x, y, 0.05, 0.05, 0.045, 0, 1);
      }
    return im.set(0.6, 0.6);
  });
}

/** Tan split-face concrete block. Tile 1.626 x 1.219 m. */
export function cmuTex(): TexSet {
  return memo('t:cmu', () => {
    const W = 512, H = 384, im = new Img(W, H), n1 = nt(25), n2 = nt(26);
    for (let y = 0; y < H; y++) {
      const my = ((y + 0.5) / H) * 1.2192, row = Math.floor(my / 0.2032), ly = my - row * 0.2032;
      for (let x = 0; x < W; x++) {
        const mx = ((x + 0.5) / W) * 1.6256, bx = (mx + (row % 2) * 0.2032) % 1.6256, bi = Math.floor(bx / 0.4064), lx = bx - bi * 0.4064;
        const u = x / W, v = y / H, g = hash4(x, y, 4, 1);
        if (lx < 0.01 || ly < 0.01) {
          const c = 0.66 + 0.05 * (g - 0.5);
          im.px(x, y, c, c * 0.95, c * 0.86, 0, 0.95);
        } else {
          const tone = hash4(row, bi, 1, 77), rough = n1.at(u * 16, v * 12);
          const k = (0.92 + 0.1 * tone) * (0.93 + 0.12 * rough) + 0.05 * (g - 0.5);
          const dirt = n2.at(u * 2, v * 2);
          const dk = dirt > 0.65 ? 1 - (dirt - 0.65) * 0.5 : 1;
          im.px(x, y, 0.74 * k * dk, 0.65 * k * dk, 0.51 * k * dk, 0.006 + 0.004 * rough + 0.001 * g, 0.93);
        }
      }
    }
    return im.set(1.6256, 1.2192);
  });
}

/** Furrowed bark, neutral (tinted by vertex colour). Tile 0.8 x 1.6 m. */
export function barkTex(): TexSet {
  return memo('t:bark', () => {
    const W = 128, H = 256, im = new Img(W, H), n1 = nt(27), n2 = nt(28);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const warp = n2.at(u * 2, v * 2);
        const ridge = Math.abs(Math.sin((u * 10 + warp * 1.6) * Math.PI));
        const n = n1.at(u * 6, v * 3);
        const f = Math.pow(ridge, 0.6) * (0.7 + 0.6 * n);
        const c = 0.38 + 0.5 * f + 0.06 * (hash4(x, y, 5, 5) - 0.5);
        im.px(x, y, c, c * 0.97, c * 0.92, 0.012 * f, 0.95);
      }
    return im.set(0.8, 1.6, 0.8);
  });
}

/** Leaf-clump breakup texture for crowns (neutral, tinted by vertex colour). Tile 1.4 m. */
export function foliageTex(): TexSet {
  return memo('t:foliage', () => {
    const W = 256, H = 256, im = new Img(W, H);
    for (let i = 0; i < W * H; i++) { im.col[i * 3] = 0.6; im.col[i * 3 + 1] = 0.6; im.col[i * 3 + 2] = 0.6; im.hgt[i] = 0; im.rough[i] = 0.9; }
    const r = mulberry32(55);
    for (let k = 0; k < 2600; k++) {
      const cx = r() * W, cy = r() * H, rad = 2.5 + r() * 5, bright = 0.72 + r() * 0.28, ang = r() * Math.PI;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++)
        for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
          const lx = (dx * ca + dy * sa) / rad, ly = ((-dx * sa + dy * ca) / rad) * 1.7;
          const d2 = lx * lx + ly * ly;
          if (d2 > 1) continue;
          const x = ((Math.floor(cx) + dx) % W + W) % W, y = ((Math.floor(cy) + dy) % H + H) % H, i = y * W + x;
          const hh = (1 - d2) * 0.012 + k * 0.0000005;
          if (hh > im.hgt[i]!) {
            im.hgt[i] = hh;
            const c = bright * (0.8 + 0.2 * (1 - d2));
            im.col[i * 3] = c; im.col[i * 3 + 1] = c; im.col[i * 3 + 2] = c * 0.95;
            im.rough[i] = 0.72;
          }
        }
    }
    return im.set(1.4, 1.4, 0.6);
  });
}

/** Round bale atlas: left half = wrapped side (u around), right half = spiral end. */
export function baleTex(): TexSet {
  return memo('t:bale', () => {
    const W = 1024, H = 512, im = new Img(W, H), n1 = nt(29), n2 = nt(30);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const g = hash4(x, y, 8, 8);
        if (x < 512) {
          const u = x / 512, v = y / H;
          const strand = n1.at(u * 16, v * 32), wth = n2.at(u * 2, v * 2);
          let c = 0.58 + 0.16 * (strand - 0.5) + 0.08 * (g - 0.5) - 0.1 * wth;
          const twine = (y % 48) < 2;
          if (twine) c += 0.06;
          im.px(x, y, c * 1.0, c * 0.92, c * 0.68, 0.004 * strand + (twine ? 0.002 : 0), 0.95);
        } else {
          const dx = (x - 768) / 256, dy = (y - 256) / 256, rr = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
          const ph = rr * 14 - th / (Math.PI * 2);
          const band = 0.5 + 0.5 * Math.cos(ph * Math.PI * 2);
          const straw = n1.at(th / (Math.PI * 2) * 8 + 0.5, rr * 4);
          let c = 0.62 + 0.12 * (straw - 0.5) - 0.12 * Math.pow(band, 6) + 0.08 * (g - 0.5);
          if (rr > 0.9) c *= 0.85;
          if (rr < 0.1) c *= 0.8;
          im.px(x, y, c * 1.02, c * 0.92, c * 0.66, 0.006 * (1 - Math.pow(band, 6)) + 0.002 * straw, 0.95);
        }
      }
    const s = im.set(1, 1, 0.7);
    s.map.repeat.set(1, 1); s.normalMap!.repeat.set(1, 1); s.roughnessMap!.repeat.set(1, 1);
    return s;
  });
}

// ---------------------------------------------------------------- atlases (windows / doors)

type Fill = (col: string, rough: number) => void;
function atlasPair(W: number, H: number, paint: (ctx: CanvasRenderingContext2D, F: Fill, R: boolean) => void): TexSet {
  const c1 = canvas(W, H), x1 = ctx2d(c1);
  paint(x1, (col) => { x1.fillStyle = col; }, false);
  const c2 = canvas(W, H), x2 = ctx2d(c2);
  paint(x2, (_c, r) => { const v = to8(r); x2.fillStyle = `rgb(${v},${v},${v})`; }, true);
  const map = mkTex(c1, true);
  const rough = mkTex(c2, false);
  map.wrapS = map.wrapT = rough.wrapS = rough.wrapT = THREE.ClampToEdgeWrapping;
  return { map, normalMap: null, roughnessMap: rough, emissiveMap: null };
}

function glass(ctx: CanvasRenderingContext2D, F: Fill, R: boolean, x: number, y: number, w: number, h: number, style: number, dusty = false): void {
  if (R) { F('', 0.08); ctx.fillRect(x, y, w, h); return; }
  const g = ctx.createLinearGradient(x, y, x, y + h);
  if (dusty) { g.addColorStop(0, 'rgb(92,96,92)'); g.addColorStop(1, 'rgb(48,50,48)'); }
  else { g.addColorStop(0, 'rgb(88,95,102)'); g.addColorStop(0.5, 'rgb(48,52,56)'); g.addColorStop(1, 'rgb(28,30,32)'); }
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  if (style === 1 || style === 4) {
    const frac = style === 4 ? 1 : 0.55;
    for (let yy = y; yy < y + h * frac; yy += 4) { ctx.fillStyle = 'rgba(150,142,124,0.55)'; ctx.fillRect(x, yy, w, 3); }
  } else if (style === 3) {
    ctx.fillStyle = 'rgba(150,140,124,0.55)';
    ctx.fillRect(x, y, w * 0.3, h);
    ctx.fillRect(x + w * 0.7, y, w * 0.3, h);
    ctx.fillStyle = 'rgba(80,70,60,0.35)';
    for (let k = 0; k < 4; k++) { ctx.fillRect(x + k * w * 0.075, y, 2, h); ctx.fillRect(x + w * 0.7 + k * w * 0.075, y, 2, h); }
  } else if (style === 5) {
    ctx.fillStyle = 'rgba(120,105,80,0.35)';
    ctx.fillRect(x + w * 0.55, y + h * 0.45, w * 0.2, h * 0.3);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.15, y); ctx.lineTo(x + w * 0.5, y); ctx.lineTo(x + w * 0.1, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h * 0.6);
  ctx.closePath();
  ctx.fill();
}

const WA_W = 1024, WA_H = 512;
/** Window atlas cells. */
export const WIN = {
  /** double-hung house windows, 6 interior variants */
  dh: (i: number): Rect => rectPx((i % 6) * 128, 0, 128, 240, WA_W, WA_H),
  /** barn sash: 0,1 white trim (1 broken); 2,3 grey trim (3 broken) */
  barn: (i: number): Rect => rectPx((i % 4) * 128, 256, 128, 128, WA_W, WA_H),
  attic: rectPx(512, 256, 128, 128, WA_W, WA_H),
  shed: rectPx(640, 256, 128, 128, WA_W, WA_H),
  casingWhite: rectPx(920, 280, 80, 80, WA_W, WA_H),
  casingGrey: rectPx(920, 410, 80, 80, WA_W, WA_H),
};
export function windowAtlas(): TexSet {
  return memo('t:winAtlas', () =>
    atlasPair(WA_W, WA_H, (ctx, F, R) => {
      F('#3a3a38', 0.8); ctx.fillRect(0, 0, WA_W, WA_H);
      const white = '#dad7ce', shadow = '#9c998f';
      for (let i = 0; i < 6; i++) {
        const x0 = i * 128, y0 = 0, w = 128, h = 240;
        F(white, 0.55); ctx.fillRect(x0, y0, w, h);
        F(shadow, 0.6); ctx.fillRect(x0 + 10, y0 + 10, w - 20, 2);
        const ix = x0 + 13, iy = y0 + 13, iw = w - 26, ih = h - 34;
        F('#a3a5a2', 0.4); ctx.fillRect(ix, iy, iw, ih);
        const gx = ix + 4, gy = iy + 4, gw = iw - 8, gh = ih - 8, mid = gy + gh / 2;
        F(white, 0.55); ctx.fillRect(gx, gy, gw, gh);
        glass(ctx, F, R, gx + 6, gy + 6, gw - 12, gh / 2 - 9, i);
        glass(ctx, F, R, gx + 6, mid + 4, gw - 12, gh / 2 - 10, i === 1 ? 0 : i);
        if (i === 2) { F(white, 0.55); ctx.fillRect(gx + gw / 2 - 2, gy, 4, gh); }
        F(shadow, 0.6); ctx.fillRect(gx, mid - 1, gw, 2);
        F('#c9c6bc', 0.6); ctx.fillRect(x0, y0 + h - 21, w, 21);
        F('#77746c', 0.6); ctx.fillRect(x0 + 6, y0 + h - 21, w - 12, 3);
      }
      for (let i = 0; i < 4; i++) {
        const x0 = i * 128, y0 = 256, s = 128;
        const trim = i < 2 ? '#d2cfc6' : '#77736a';
        F(trim, i < 2 ? 0.6 : 0.9); ctx.fillRect(x0, y0, s, s);
        const cols = i % 2 === 0 ? 2 : 3, rows = 2;
        const ix = x0 + 14, iy = y0 + 14, iw = s - 28, ih = s - 28;
        F(i < 2 ? '#c4c1b8' : '#5f5c55', 0.7); ctx.fillRect(ix, iy, iw, ih);
        const pw = (iw - 6) / cols, ph = (ih - 6) / rows;
        for (let c = 0; c < cols; c++)
          for (let r = 0; r < rows; r++) {
            const px = ix + 3 + c * pw + 2, py = iy + 3 + r * ph + 2;
            const broken = i % 2 === 1 && ((c === 1 && r === 0) || (c === 2 && r === 1));
            if (broken) { F('#0d0d0c', 0.95); ctx.fillRect(px, py, pw - 4, ph - 4); if (!R) { ctx.fillStyle = 'rgba(80,84,80,0.8)'; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + pw * 0.5, py); ctx.lineTo(px, py + ph * 0.6); ctx.fill(); } }
            else glass(ctx, F, R, px, py, pw - 4, ph - 4, 0, true);
          }
      }
      {
        const x0 = 512, y0 = 256, s = 128;
        F(white, 0.55); ctx.fillRect(x0, y0, s, s);
        F(white, 0.55); ctx.fillRect(x0 + 14, y0 + 14, s - 28, s - 28);
        const pw = (s - 34) / 2;
        for (let c = 0; c < 2; c++) for (let r = 0; r < 2; r++) glass(ctx, F, R, x0 + 17 + c * pw + 2, y0 + 17 + r * pw + 2, pw - 4, pw - 4, 0);
      }
      {
        const x0 = 640, y0 = 256, s = 128;
        F('#b9bbb8', 0.4); ctx.fillRect(x0, y0, s, s);
        glass(ctx, F, R, x0 + 10, y0 + 12, s / 2 - 14, s - 24, 5);
        glass(ctx, F, R, x0 + s / 2 + 4, y0 + 12, s / 2 - 14, s - 24, 0);
      }
      F(white, 0.55); ctx.fillRect(896, 256, 128, 128);
      F('#77736a', 0.9); ctx.fillRect(896, 384, 128, 128);
    }),
  );
}

const DA_W = 512, DA_H = 512;
/** Door atlas cells (128x256 each). 0 white panel + storm door, 1 green 4-light, 2 red half-glass, 3 painted steel,
 *  4 red board barn door, 5 grey board door, 6 aluminium glass shop door, 7 grey steel back door. */
export const DOOR = {
  cell: (i: number): Rect => rectPx((i % 4) * 128, Math.floor(i / 4) * 256, 128, 256, DA_W, DA_H),
  side: (i: number): Rect => rectPx((i % 4) * 128 + 2, Math.floor(i / 4) * 256 + 100, 6, 60, DA_W, DA_H),
};
export function doorAtlas(): TexSet {
  return memo('t:doorAtlas', () =>
    atlasPair(DA_W, DA_H, (ctx, F, R) => {
      const panels = (x: number, y: number, w: number, h: number, base: string, dark: string, rows: number, cols: number) => {
        const pw = (w - (cols + 1) * 8) / cols, ph = (h - (rows + 1) * 8) / rows;
        for (let c = 0; c < cols; c++)
          for (let r = 0; r < rows; r++) {
            const px = x + 8 + c * (pw + 8), py = y + 8 + r * (ph + 8);
            F(dark, 0.6); ctx.fillRect(px, py, pw, ph);
            F(base, 0.6); ctx.fillRect(px + 3, py + 3, pw - 6, ph - 6);
          }
      };
      const cellBase = (i: number, casing: string, rough: number) => {
        const x0 = (i % 4) * 128, y0 = Math.floor(i / 4) * 256;
        F(casing, rough); ctx.fillRect(x0, y0, 128, 256);
        return [x0, y0] as const;
      };
      {
        const [x0, y0] = cellBase(0, '#dad7ce', 0.55);
        F('#cfccc2', 0.6); ctx.fillRect(x0 + 12, y0 + 12, 104, 244);
        panels(x0 + 12, y0 + 12, 104, 244, '#d4d1c8', '#a9a69c', 3, 2);
        F('#a5a7a4', 0.4); ctx.fillRect(x0 + 10, y0 + 10, 108, 246);
        glass(ctx, F, R, x0 + 18, y0 + 18, 92, 130, 0);
        if (!R) { ctx.fillStyle = 'rgba(210,207,198,0.25)'; ctx.fillRect(x0 + 18, y0 + 18, 92, 130); }
        F('#a5a7a4', 0.4); ctx.fillRect(x0 + 18, y0 + 150, 92, 10);
        F('#8f918e', 0.5); ctx.fillRect(x0 + 18, y0 + 162, 92, 86);
        F('#3c3c3a', 0.3); ctx.fillRect(x0 + 98, y0 + 150, 8, 18);
      }
      {
        const [x0, y0] = cellBase(1, '#dad7ce', 0.55);
        F('#3f4e3c', 0.55); ctx.fillRect(x0 + 12, y0 + 12, 104, 244);
        for (let c = 0; c < 2; c++) for (let r = 0; r < 2; r++) glass(ctx, F, R, x0 + 24 + c * 42, y0 + 24 + r * 42, 38, 38, 0);
        panels(x0 + 12, y0 + 120, 104, 136, '#435340', '#2d382b', 2, 2);
        F('#9c8a5a', 0.3); ctx.fillRect(x0 + 100, y0 + 130, 6, 10);
      }
      {
        const [x0, y0] = cellBase(2, '#dad7ce', 0.55);
        F('#6a2a24', 0.55); ctx.fillRect(x0 + 12, y0 + 12, 104, 244);
        for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) glass(ctx, F, R, x0 + 22 + c * 29, y0 + 22 + r * 33, 26, 30, 3);
        panels(x0 + 12, y0 + 128, 104, 128, '#6e2c26', '#4a1d19', 1, 2);
        F('#9c8a5a', 0.3); ctx.fillRect(x0 + 100, y0 + 132, 6, 10);
      }
      {
        const [x0, y0] = cellBase(3, '#c9c7c0', 0.5);
        F('#d0cec7', 0.5); ctx.fillRect(x0 + 10, y0 + 10, 108, 246);
        F('#b4b2ab', 0.5); ctx.fillRect(x0 + 10, y0 + 226, 108, 30);
        F('#55554f', 0.3); ctx.fillRect(x0 + 98, y0 + 130, 8, 12);
      }
      for (const i of [4, 5]) {
        const red = i === 4;
        const [x0, y0] = cellBase(i, red ? '#cfccc2' : '#6f6b62', red ? 0.6 : 0.9);
        for (let b = 0; b < 6; b++) {
          const k = 0.9 + 0.1 * hash4(b, i, 0, 3);
          F(red ? `rgb(${Math.round(118 * k)},${Math.round(44 * k)},${Math.round(36 * k)})` : `rgb(${Math.round(112 * k)},${Math.round(106 * k)},${Math.round(96 * k)})`, 0.85);
          ctx.fillRect(x0 + 12 + b * 17.3, y0 + 12, 16, 244);
        }
        F(red ? '#cfccc2' : '#5d5a52', 0.7);
        ctx.fillRect(x0 + 12, y0 + 20, 104, 14);
        ctx.fillRect(x0 + 12, y0 + 222, 104, 14);
        ctx.save(); ctx.translate(x0 + 64, y0 + 128); ctx.rotate(Math.atan2(188, 90)); ctx.fillRect(-105, -7, 210, 14); ctx.restore();
      }
      {
        const [x0, y0] = cellBase(6, '#4a4239', 0.4);
        F('#4a4239', 0.4); ctx.fillRect(x0 + 8, y0 + 8, 112, 248);
        glass(ctx, F, R, x0 + 18, y0 + 18, 92, 214, 0);
        if (!R) { ctx.fillStyle = 'rgba(230,220,180,0.18)'; ctx.fillRect(x0 + 18, y0 + 18, 92, 214); }
        F('#8e8a82', 0.3); ctx.fillRect(x0 + 18, y0 + 130, 92, 7);
        if (!R) { text(ctx, 'OPEN 6AM-10PM', x0 + 64, y0 + 60, 9, 'rgba(235,235,225,0.8)', { weight: '600' }); text(ctx, 'PUSH', x0 + 64, y0 + 150, 10, 'rgba(235,235,225,0.85)'); }
      }
      {
        const [x0, y0] = cellBase(7, '#8c8a83', 0.5);
        F('#9d9a90', 0.5); ctx.fillRect(x0 + 10, y0 + 10, 108, 246);
        F('#54534e', 0.3); ctx.fillRect(x0 + 98, y0 + 130, 8, 12);
        if (!R) { ctx.save(); ctx.translate(x0, y0); grime(ctx, 128, 256, 7, 0.4); ctx.restore(); }
      }
    }),
  );
}

// ---------------------------------------------------------------- additions (decor set)

function hexRGB(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Faded, chalky paint with surface-rust patches (rust keeps its own colour). Tile 2 m. */
export function rustyPaintTex(hex: string, rustAmt = 0.5): TexSet {
  return memo('t:rustypaint:' + hex + ':' + rustAmt, () => {
    const W = 512, H = 512, im = new Img(W, H), n1 = nt(31), n2 = nt(32), n3 = nt(33);
    const [pr, pg, pb] = hexRGB(hex);
    const thr = 0.9 - rustAmt * 0.32;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, g = hash4(x, y, 3, 17);
        const chalk = n1.at(u * 2, v * 2), fine = n3.at(u * 16, v * 16);
        const k = 0.88 + 0.12 * (fine - 0.5) + 0.03 * (g - 0.5);
        let r = (pr + (0.78 - pr) * chalk * 0.35) * k, gg = (pg + (0.76 - pg) * chalk * 0.35) * k, b = (pb + (0.72 - pb) * chalk * 0.35) * k;
        let ro = 0.62 + 0.2 * chalk, h = 0.0004 * fine;
        const rust = n2.at(u * 3, v * 3) + 0.35 * (fine - 0.5) + 0.12 * (n1.at(u * 8, v) - 0.5);
        if (rust > thr) {
          const t = clamp((rust - thr) * 6, 0, 1), dark = 0.75 + 0.35 * g;
          r += (0.42 * dark - r) * t; gg += (0.24 * dark - gg) * t; b += (0.14 * dark - b) * t;
          ro += (0.92 - ro) * t; h += 0.0015 * t * g;
        }
        im.px(x, y, r, gg, b, h, ro);
      }
    return im.set(2, 2, 0.6);
  });
}

/** Slipform concrete (grain elevators): smooth, faint lift lines, vertical weather streaks. Tile 4 x 8 m. */
export function slipformTex(): TexSet {
  return memo('t:slipform', () => {
    const W = 256, H = 512, im = new Img(W, H), n1 = nt(34), n2 = nt(35), n3 = nt(36);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, g = hash4(x, y, 7, 7);
        let c = 0.74 + 0.06 * (n1.at(u * 2, v * 4) - 0.5) + 0.03 * (g - 0.5);
        const lift = y % 64;
        if (lift < 2) c *= 0.97;
        const s = n2.at(u * 3, v) * 0.7 + n1.at(u * 7, v * 2) * 0.3;
        if (s > 0.55) c *= 1 - (s - 0.55) * 0.55;
        const st = n3.at(u * 4, v);
        let r = c, gg = c * 0.985, b = c * 0.95;
        if (st > 0.7) { const t = (st - 0.7) * 2; r *= 1 - t * 0.1; gg *= 1 - t * 0.16; b *= 1 - t * 0.26; }
        im.px(x, y, r, gg, b, (lift < 2 ? -0.002 : 0) + 0.0005 * g, 0.9);
      }
    return im.set(4, 8, 0.6);
  });
}
