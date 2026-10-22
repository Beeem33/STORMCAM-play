import * as THREE from 'three';
import { heightAt } from '../environment/WorldShape';
import { CG_HEIGHT } from './VehicleModel';

/**
 * Soft dark footprint on the ground under the car. There are no shadow maps,
 * and without it the truck looks like it hovers over the road. It follows the
 * car's yaw along the terrain and fades out as the car leaves the ground.
 */
export class ContactShadow {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(width: number, length: number) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.filter = 'blur(14px)';
    g.fillStyle = 'rgba(0,0,0,0.78)';
    g.fillRect(26, 34, 76, 188);
    // Black texels with a soft alpha edge.
    this.mat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), this.mat);
    this.mesh.name = 'car-contact-shadow';
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  /** @param car the vehicle object (origin at the centre of gravity) */
  update(car: THREE.Object3D): void {
    const p = car.position;
    const ground = heightAt(p.x, p.z);
    const fwd = _v.set(0, 0, -1).applyQuaternion(car.quaternion);
    const up = _u.set(0, 1, 0).applyQuaternion(car.quaternion);
    this.mesh.position.set(p.x, ground + 0.05, p.z);
    this.mesh.rotation.set(-Math.PI / 2, Math.atan2(-fwd.x, -fwd.z), 0, 'YXZ');
    // Lifted off the ground or on its side: the footprint fades and spreads.
    const lift = Math.max(0, p.y - CG_HEIGHT - ground);
    this.mat.opacity = THREE.MathUtils.clamp(1 - lift / 2.5, 0, 1) * THREE.MathUtils.lerp(0.45, 1, THREE.MathUtils.clamp(up.y, 0, 1));
    this.mesh.scale.setScalar(1 + lift * 0.15);
  }
}

const _v = new THREE.Vector3();
const _u = new THREE.Vector3();
