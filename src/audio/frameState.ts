import * as THREE from 'three';
import type { AudioFrameState } from './AudioTypes';

/** A neutral AudioFrameState (sitting in a parked SUV at idle, calm weather). */
export function createAudioFrameState(): AudioFrameState {
  return {
    dt: 1 / 60,
    listenerPos: new THREE.Vector3(0, 1.4, 0),
    listenerForward: new THREE.Vector3(0, 0, -1),
    listenerUp: new THREE.Vector3(0, 1, 0),
    inVehicle: true,
    windowDamage: 0,
    engineRunning: true,
    engineRpm: 750,
    engineLoad: 0,
    vehicleSpeed: 0,
    surface: 'asphalt',
    tireSlip: 0,
    bumpiness: 0,
    rain: 0,
    hail: 0,
    windSpeed: 0,
    tornado: {
      active: false,
      position: new THREE.Vector3(0, 0, -2000),
      distance: 2000,
      intensity: 0.6,
      radius: 80,
    },
  };
}
