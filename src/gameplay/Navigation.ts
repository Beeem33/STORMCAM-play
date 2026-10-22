import { MAP_HALF, MILE, isPaved } from '../environment/WorldShape';

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass label for a world-space offset (north = -z). */
export function compass(dx: number, dz: number): string {
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return DIRS[Math.round(deg / 22.5) % 16];
}

/** Road and section names: county roads are lettered/numbered on the mile grid. */
export function roadName(axis: 'ns' | 'ew', index: number): string {
  if (isPaved(index)) return axis === 'ns' ? `Hwy ${81 + index}` : `Hwy ${56 - index}`;
  return axis === 'ns' ? `${index >= 0 ? index + 10 : -index}th Rd` : `Rd ${String.fromCharCode(77 + ((index % 13) + 13) % 13)}`;
}

/**
 * A road route on the section grid: along the current road to the grid line
 * nearest the target, then across. Good enough for a GPS on a grid of roads.
 */
export function gridRoute(x: number, z: number, tx: number, tz: number): [number, number][] {
  const i = Math.round(x / MILE);
  const j = Math.round(z / MILE);
  const onNS = Math.abs(x - i * MILE) < Math.abs(z - j * MILE);
  const ti = Math.round(tx / MILE);
  const tj = Math.round(tz / MILE);
  if (onNS) {
    const rx = i * MILE;
    return [[x, z], [rx, z], [rx, tj * MILE], [tx, tj * MILE]];
  }
  const rz = j * MILE;
  return [[x, z], [x, rz], [ti * MILE, rz], [ti * MILE, tz]];
}

export function routeLength(pts: [number, number][]): number {
  let d = 0;
  for (let k = 1; k < pts.length; k++) d += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return d;
}

/** Draw the GPS map (north-up) with the route to a target. */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  size: number,
  view: { x: number; z: number; heading: number },
  target: { x: number; z: number; label: string } | null,
  range = 7000,
): void {
  ctx.fillStyle = '#e9e6dc';
  ctx.fillRect(0, 0, size, size);
  const scale = size / (range * 2);
  const toPx = (x: number, z: number): [number, number] => [(x - view.x) * scale + size / 2, (z - view.z) * scale + size / 2];
  // Section tint (fields).
  const i0 = Math.floor((view.x - range) / MILE), i1 = Math.ceil((view.x + range) / MILE);
  const j0 = Math.floor((view.z - range) / MILE), j1 = Math.ceil((view.z + range) / MILE);
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const [a, b] = toPx(i * MILE, j * MILE);
      ctx.fillStyle = (i + j) % 2 === 0 ? '#e3dfd2' : '#dedacb';
      ctx.fillRect(a, b, MILE * scale, MILE * scale);
    }
  const line = (paved: boolean, x0: number, z0: number, x1: number, z1: number) => {
    const [a, b] = toPx(x0, z0);
    const [c, d] = toPx(x1, z1);
    ctx.strokeStyle = paved ? '#f0b44a' : '#ffffff';
    ctx.lineWidth = paved ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(a, b);
    ctx.lineTo(c, d);
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  for (let i = i0; i <= i1; i++) if (!isPaved(i)) line(false, i * MILE, view.z - range, i * MILE, view.z + range);
  for (let j = j0; j <= j1; j++) if (!isPaved(j)) line(false, view.x - range, j * MILE, view.x + range, j * MILE);
  for (let i = i0; i <= i1; i++) if (isPaved(i)) line(true, i * MILE, view.z - range, i * MILE, view.z + range);
  for (let j = j0; j <= j1; j++) if (isPaved(j)) line(true, view.x - range, j * MILE, view.x + range, j * MILE);
  // Road labels.
  ctx.font = '600 11px Inter, sans-serif';
  ctx.fillStyle = '#5b5446';
  for (let i = i0; i <= i1; i++) {
    const [px] = toPx(i * MILE, 0);
    ctx.save();
    ctx.translate(px + 4, 18);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(roadName('ns', i), 0, 0);
    ctx.restore();
  }
  for (let j = j0; j <= j1; j++) {
    const [, pz] = toPx(0, j * MILE);
    ctx.fillText(roadName('ew', j), 8, pz - 5);
  }

  // Outside the chase area: greyed out.
  ctx.fillStyle = 'rgba(60,60,60,0.28)';
  {
    const [ax, az] = toPx(-MAP_HALF, -MAP_HALF);
    const w = MAP_HALF * 2 * scale;
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.rect(ax + w, az, -w, w);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#b8862a';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(ax, az, w, w);
    ctx.setLineDash([]);
  }

  if (target) {
    const pts = gridRoute(view.x, view.z, target.x, target.z);
    ctx.strokeStyle = '#2a7cf0';
    ctx.lineWidth = 4;
    ctx.beginPath();
    pts.forEach(([x, z], k) => {
      const [a, b] = toPx(x, z);
      if (k === 0) ctx.moveTo(a, b);
      else ctx.lineTo(a, b);
    });
    ctx.stroke();
    const [tx, tz] = toPx(target.x, target.z);
    ctx.fillStyle = 'rgba(200,30,30,0.18)';
    ctx.beginPath();
    ctx.arc(tx, tz, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c81e1e';
    ctx.font = '700 13px Inter, sans-serif';
    ctx.fillText(`CELL ${target.label}`, tx + 10, tz - 8);
  }

  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(view.heading);
  ctx.fillStyle = '#1a6ee0';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(8, 9);
  ctx.lineTo(0, 4);
  ctx.lineTo(-8, 9);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();
  // North arrow.
  ctx.fillStyle = '#333';
  ctx.font = '700 12px Inter, sans-serif';
  ctx.fillText('N ↑', size - 34, 20);
}
