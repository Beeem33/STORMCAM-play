/**
 * Mix calibration — every layer's gain lives here so the balance can be tuned
 * in one place. Values were calibrated with the offline level probe
 * (audio.html → "Measure levels"); targets are in AudioLevelProbe.ts.
 * All beds are generated at 0.25 RMS, so these are "linear gain on a -12 dBFS bed".
 */
export const MIX = {
  // wind
  windBody: 0.29,
  windBuffet: 2,
  windWhistle: 1.5,
  // rain
  rainOut: 0.17,
  roofDense: 0.34,
  roofSparse: 0.4,
  // hail
  hailIn: 0.45,
  hailOut: 0.17,
  hailBedIn: 0.3,
  hailBedOut: 0.16,
  // tornado
  tornRoar: 1.0,
  tornRumble: 0.56,
  tornGrowl: 1.1,
  tornJet: 2.0,
  // engine
  engine: 0.17,
  engNoise: 6,
  // tyres
  road: 0.33,
  roadRumble: 0.2,
  wet: 1.2,
  gravel: 0.31,
  grass: 0.4,
  mud: 0.57,
  squeal: 5.1,
  pebble: 0.2,
  splat: 0.25,
  // cabin
  rattle: 0.3,
  thud: 0.35,
  // one-shots
  thunderRumble: 2.4,
  thunderMid: 4,
  thunderCrack: 0.45,
  debris: 0.5,
  collision: 0.9,
  glass: 0.6,
  body: 0.7,
  door: 0.8,
  wiper: 0.25,
  beep: 0.12,
  ui: 0.25,
};
