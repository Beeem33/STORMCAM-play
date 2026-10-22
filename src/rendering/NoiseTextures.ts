import * as THREE from 'three';
import { hash3i } from '../utils/Random';

/**
 * Tileable noise textures generated once at startup and shared by the
 * cloud, terrain, tornado and windshield shaders. Sampling a texture is far
 * cheaper than evaluating fbm in a shader at every raymarch step.
 */

function tileValue3(x: number, y: number, z: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const m = (v: number) => ((v % period) + period) % period;
  const h = (a: number, b: number, c: number) => hash3i(m(a), m(b), m(c) + seed * 4099) / 4294967296;
  const x0 = ix, x1 = ix + 1, y0 = iy, y1 = iy + 1, z0 = iz, z1 = iz + 1;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(x0, y0, z0), h(x1, y0, z0), ux), l(h(x0, y1, z0), h(x1, y1, z0), ux), uy),
    l(l(h(x0, y0, z1), h(x1, y0, z1), ux), l(h(x0, y1, z1), h(x1, y1, z1), ux), uy),
    uz,
  );
}

/** Tileable 3D Worley (cellular) noise, 0 at cell points → ~1 far away. */
function tileWorley3(x: number, y: number, z: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const mx = ((cx % period) + period) % period;
        const my = ((cy % period) + period) % period;
        const mz = ((cz % period) + period) % period;
        const hh = hash3i(mx, my, mz + seed * 131);
        const px = cx + (hh & 1023) / 1023;
        const py = cy + ((hh >>> 10) & 1023) / 1023;
        const pz = cz + ((hh >>> 20) & 1023) / 1023;
        const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
        if (d < best) best = d;
      }
  return Math.min(1, Math.sqrt(best));
}

let noise3D: THREE.Data3DTexture | null = null;
let noise2D: THREE.DataTexture | null = null;

/**
 * 64³ RGBA: R = 4-octave value fbm, G = 3-octave Worley fbm (inverted, "billowy"),
 * B = low-frequency value noise, A = high-frequency value noise. All tile at 64.
 */
export function getNoise3D(): THREE.Data3DTexture {
  if (noise3D) return noise3D;
  const N = 64;
  const data = new Uint8Array(N * N * N * 4);
  let o = 0;
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let f = 0, amp = 0.5, freq = 4, norm = 0;
        for (let k = 0; k < 4; k++) {
          f += tileValue3((x / N) * freq, (y / N) * freq, (z / N) * freq, freq, k + 1) * amp;
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        f /= norm;
        let w = 0;
        w += (1 - tileWorley3((x / N) * 4, (y / N) * 4, (z / N) * 4, 4, 7)) * 0.625;
        w += (1 - tileWorley3((x / N) * 8, (y / N) * 8, (z / N) * 8, 8, 8)) * 0.25;
        w += (1 - tileWorley3((x / N) * 16, (y / N) * 16, (z / N) * 16, 16, 9)) * 0.125;
        const lo = tileValue3((x / N) * 2, (y / N) * 2, (z / N) * 2, 2, 11);
        const hi = tileValue3((x / N) * 16, (y / N) * 16, (z / N) * 16, 16, 12);
        data[o++] = Math.round(f * 255);
        data[o++] = Math.round(Math.min(1, w) * 255);
        data[o++] = Math.round(lo * 255);
        data[o++] = Math.round(hi * 255);
      }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  noise3D = tex;
  return tex;
}

/**
 * 256² RGBA: R = 6-octave value fbm, G = second fbm (other seed),
 * B = Worley, A = white noise. Tiles at 256, mipmapped.
 */
export function getNoise2D(): THREE.DataTexture {
  if (noise2D) return noise2D;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const fbm = (x: number, y: number, seed: number) => {
    let f = 0, amp = 0.5, freq = 8, norm = 0;
    for (let k = 0; k < 6; k++) {
      f += tileValue3((x / N) * freq, (y / N) * freq, 0, freq, seed + k) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return f / norm;
  };
  let o = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      data[o++] = Math.round(fbm(x, y, 21) * 255);
      data[o++] = Math.round(fbm(x, y, 41) * 255);
      data[o++] = Math.round(tileWorley3((x / N) * 16, (y / N) * 16, 0.5, 16, 3) * 255);
      data[o++] = hash3i(x, y, 99) & 255;
    }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  noise2D = tex;
  return tex;
}
