import type * as THREE from 'three';

/** Ground surface under the tyres — drives tyre noise and grip. */
export type Surface = 'asphalt' | 'gravel' | 'grass' | 'mud';

/** Kinds of one-shot impact sounds. */
export type ImpactKind = 'debris' | 'collision' | 'hail' | 'glass' | 'body';

/**
 * Everything the audio system needs each frame. The Game fills one of these
 * and passes it to AudioSystem.update(). All distances in metres, speeds in m/s.
 */
export interface AudioFrameState {
  dt: number;
  /** Listener (camera) pose in world space. */
  listenerPos: THREE.Vector3;
  listenerForward: THREE.Vector3;
  listenerUp: THREE.Vector3;

  /** True while the player sits in the vehicle: exterior sounds are muffled. */
  inVehicle: boolean;
  /** 0 intact .. 1 every window smashed — lets more exterior sound in. */
  windowDamage: number;

  engineRunning: boolean;
  /** Engine speed, ~750 idle .. ~6000 redline. */
  engineRpm: number;
  /** Throttle 0..1. */
  engineLoad: number;
  /** Vehicle speed. */
  vehicleSpeed: number;
  surface: Surface;
  /** 0..1 how hard the tyres are sliding (skid squeal / gravel scrabble). */
  tireSlip: number;
  /** 0..1 vertical shaking from bumps — drives interior rattles. */
  bumpiness: number;

  /** 0..1 rain rate at the listener. */
  rain: number;
  /** 0..1 hail rate at the listener. */
  hail: number;
  /** Total wind speed at the listener (ambient storm wind + tornado). */
  windSpeed: number;

  /** Tornado state; active=false when none exists. */
  tornado: {
    active: boolean;
    position: THREE.Vector3;
    /** Horizontal distance from listener to the vortex centre. */
    distance: number;
    /** 0..1 strength (EF0 ≈ 0.15 .. EF5 = 1). */
    intensity: number;
    /** Core radius in metres. */
    radius: number;
  };
}
