import * as THREE from 'three';
import { atmo } from '../rendering/Atmosphere';
import type { SkyParams } from '../rendering/CloudSky';

/**
 * Scene lighting for a late-May afternoon under storm skies. The sun sits low
 * in the west-southwest; how much of it reaches the ground, and how bright
 * the diffuse sky light is, comes from the storm coverage overhead.
 */
export class Lighting {
  readonly hemi = new THREE.HemisphereLight(0xa9b4bc, 0x4a4636, 1.0);
  readonly sun = new THREE.DirectionalLight(0xfff0dc, 1.0);
  readonly flash = new THREE.DirectionalLight(0xdfe4ff, 0);
  readonly sunDir = new THREE.Vector3();
  readonly sky: SkyParams;

  constructor(scene: THREE.Scene) {
    // Azimuth ~250° (WSW), elevation ~22°.
    const az = THREE.MathUtils.degToRad(250);
    const el = THREE.MathUtils.degToRad(22);
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    scene.add(this.hemi, this.sun, this.sun.target, this.flash, this.flash.target);
    this.sky = {
      sunDir: this.sunDir.clone(),
      sunColor: new THREE.Color(1.0, 0.86, 0.68),
      zenith: new THREE.Color(0.32, 0.4, 0.48),
      horizon: new THREE.Color(0.78, 0.82, 0.84),
      baseAlt: 1250,
      haze: 0.45,
    };
  }

  /**
   * @param cover 0..1 storm cloud overhead
   * @param sunBlocked 0..1 cloud between the camera and the sun
   * @param precip 0..1 rain at the camera (darkens further)
   * @param flash lightning brightness 0..~4
   */
  update(camPos: THREE.Vector3, cover: number, sunBlocked: number, precip: number, flash: number, flashDir: THREE.Vector3): void {
    const dark = Math.min(1, cover * 0.75 + precip * 0.35);
    const ambient = 1.25 * (1 - dark * 0.82);
    this.hemi.intensity = ambient + flash * 0.5;
    this.hemi.color.setRGB(0.66 - dark * 0.12, 0.72 - dark * 0.08, 0.76 - dark * 0.04);
    this.hemi.groundColor.setRGB(0.28, 0.26, 0.2).multiplyScalar(1 - dark * 0.5);
    this.sun.intensity = 2.6 * (1 - sunBlocked) * (1 - precip * 0.8);
    this.sun.position.copy(camPos).addScaledVector(this.sunDir, 1000);
    this.sun.target.position.copy(camPos);
    this.flash.intensity = flash * 1.2;
    this.flash.position.copy(camPos).addScaledVector(flashDir, 1000);
    this.flash.target.position.copy(camPos);
    atmo.uFlash.value = flash;

    // Sky colours: a hazy, humid afternoon; darker and greener under the storm.
    const s = this.sky;
    s.horizon.setRGB(0.86 - dark * 0.42, 0.9 - dark * 0.4, 0.92 - dark * 0.38);
    s.zenith.setRGB(0.36 - dark * 0.2, 0.45 - dark * 0.22, 0.54 - dark * 0.24);
    s.sunColor.setRGB(1.0, 0.88, 0.72).multiplyScalar(1.2 * (1 - sunBlocked * 0.7));
  }
}
