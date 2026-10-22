/**
 * Equipment catalog. Each upgrade is a data entry plus a small set of
 * effect multipliers that systems read through `UpgradeEffects` — adding an
 * item never requires touching the systems it modifies.
 */
export type UpgradeId =
  | 'actionCam'
  | 'gimbal'
  | 'tripod'
  | 'anemometer'
  | 'radarPro'
  | 'polyWindows'
  | 'armor'
  | 'atTires'
  | 'lightBar';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  category: 'Camera' | 'Instruments' | 'Vehicle';
  price: number;
  blurb: string;
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'actionCam', name: '4K action camera', category: 'Camera', price: 1800, blurb: 'Cleaner low-light image. Footage sells for 20% more.' },
  { id: 'gimbal', name: 'Handheld gimbal', category: 'Camera', price: 1200, blurb: 'Steadier handheld footage, even in strong wind.' },
  { id: 'tripod', name: 'Heavy tripod', category: 'Camera', price: 600, blurb: 'Rock-steady shots when you stand still outside.' },
  { id: 'anemometer', name: 'Roof anemometer readout', category: 'Instruments', price: 900, blurb: 'Live wind speed on the dash.' },
  { id: 'radarPro', name: 'Pro radar subscription', category: 'Instruments', price: 1500, blurb: 'Radar refreshes twice as often.' },
  { id: 'polyWindows', name: 'Polycarbonate windows', category: 'Vehicle', price: 3200, blurb: 'Hail and debris crack the glass far less.' },
  { id: 'armor', name: 'Steel body armor', category: 'Vehicle', price: 6500, blurb: 'Halves impact damage. Heavier in the wind.' },
  { id: 'atTires', name: 'All-terrain tires', category: 'Vehicle', price: 1400, blurb: 'More grip on gravel, grass and mud.' },
  { id: 'lightBar', name: 'LED light bar', category: 'Vehicle', price: 700, blurb: 'Far brighter headlights in the core.' },
];

export interface UpgradeEffects {
  footageValue: number;
  sensorNoise: number;
  handheldShake: number;
  tripod: boolean;
  windReadout: boolean;
  radarInterval: number;
  glassDamage: number;
  impactDamage: number;
  offroadGrip: number;
  headlights: number;
  massBonus: number;
}

export function effectsFor(owned: ReadonlySet<UpgradeId>): UpgradeEffects {
  const has = (id: UpgradeId) => owned.has(id);
  return {
    footageValue: has('actionCam') ? 1.2 : 1,
    sensorNoise: has('actionCam') ? 0.6 : 1,
    handheldShake: has('gimbal') ? 0.35 : 1,
    tripod: has('tripod'),
    windReadout: has('anemometer'),
    radarInterval: has('radarPro') ? 30 : 60,
    glassDamage: has('polyWindows') ? 0.3 : 1,
    impactDamage: has('armor') ? 0.5 : 1,
    offroadGrip: has('atTires') ? 1.2 : 1,
    headlights: has('lightBar') ? 2.2 : 1,
    massBonus: has('armor') ? 450 : 0,
  };
}
