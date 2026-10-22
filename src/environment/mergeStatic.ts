import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Bake a prop group (built as many small meshes so it can be torn apart) into
 * one mesh per material for drawing while it stands. Cuts a farmstead from
 * ~80 draw calls to ~10. The original group is left untouched for destruction.
 */
export function mergeByMaterial(group: THREE.Object3D): THREE.Group {
  const out = new THREE.Group();
  out.name = group.name + '-merged';
  const savedPos = group.position.clone();
  const savedQuat = group.quaternion.clone();
  const savedScale = group.scale.clone();
  group.position.set(0, 0, 0);
  group.quaternion.identity();
  group.scale.set(1, 1, 1);
  group.updateMatrixWorld(true);

  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    let list = buckets.get(m.material);
    if (!list) buckets.set(m.material, (list = []));
    list.push(g);
  });

  for (const [mat, geos] of buckets) {
    // Merge needs identical attribute sets and consistent indexing.
    const names = ['position', 'normal', 'uv', 'color'].filter((n) => geos.every((g) => g.getAttribute(n)));
    const anyIndexed = geos.some((g) => g.index);
    const allIndexed = geos.every((g) => g.index);
    const prepared = geos.map((g) => {
      const h = anyIndexed && !allIndexed ? g.toNonIndexed() : g;
      for (const key of Object.keys(h.attributes)) if (!names.includes(key)) h.deleteAttribute(key);
      for (const key of names) {
        const a = h.getAttribute(key) as THREE.BufferAttribute;
        if (a.normalized || !(a.array instanceof Float32Array)) {
          const f = new Float32Array(a.count * a.itemSize);
          for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
          h.setAttribute(key, new THREE.BufferAttribute(f, a.itemSize));
        }
      }
      h.morphAttributes = {};
      h.clearGroups();
      return h;
    });
    const merged = mergeGeometries(prepared, false);
    if (!merged) {
      // Fall back to separate meshes for this material.
      for (const g of prepared) out.add(new THREE.Mesh(g, mat));
      continue;
    }
    merged.computeBoundingSphere();
    out.add(new THREE.Mesh(merged, mat));
  }

  group.position.copy(savedPos);
  group.quaternion.copy(savedQuat);
  group.scale.copy(savedScale);
  group.updateMatrixWorld(true);
  out.position.copy(savedPos);
  out.quaternion.copy(savedQuat);
  out.scale.copy(savedScale);
  return out;
}
