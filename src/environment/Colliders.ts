/**
 * 2D (XZ-plane) collision shapes for the static world — buildings, poles,
 * trees — stored in a uniform spatial hash. Vehicle and walker query it.
 */

interface ColliderBase {
  x: number;
  z: number;
  /** Ignore when the querying body is above this height (m, absolute). */
  yMax?: number;
  /** Called with impact speed when something hits it. */
  onHit?: (impact: number) => void;
  /** Owner tag, e.g. a farmstead id, so destroyed objects can remove their colliders. */
  owner?: string;
}
export interface CircleCollider extends ColliderBase {
  type: 'circle';
  r: number;
}
export interface BoxCollider extends ColliderBase {
  type: 'box';
  hx: number;
  hz: number;
  /** Rotation about Y (radians). */
  rot: number;
}
export type Collider2D = CircleCollider | BoxCollider;

const CELL = 32;

export class ColliderGrid {
  private readonly cells = new Map<number, Collider2D[]>();

  private key(cx: number, cz: number): number {
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  private extent(c: Collider2D): number {
    return c.type === 'circle' ? c.r : Math.hypot(c.hx, c.hz);
  }

  add(c: Collider2D): void {
    const e = this.extent(c);
    for (let cx = Math.floor((c.x - e) / CELL); cx <= Math.floor((c.x + e) / CELL); cx++)
      for (let cz = Math.floor((c.z - e) / CELL); cz <= Math.floor((c.z + e) / CELL); cz++) {
        const k = this.key(cx, cz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(c);
      }
  }

  remove(c: Collider2D): void {
    const e = this.extent(c);
    for (let cx = Math.floor((c.x - e) / CELL); cx <= Math.floor((c.x + e) / CELL); cx++)
      for (let cz = Math.floor((c.z - e) / CELL); cz <= Math.floor((c.z + e) / CELL); cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
      }
  }

  removeOwner(owner: string): void {
    for (const list of this.cells.values()) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1);
    }
  }

  *query(x: number, z: number, r: number): Iterable<Collider2D> {
    const seen = new Set<Collider2D>();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (const c of list) {
          if (seen.has(c)) continue;
          seen.add(c);
          yield c;
        }
      }
  }
}
