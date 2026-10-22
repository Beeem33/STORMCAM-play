/** Player-adjustable settings, persisted to localStorage. */
export interface SettingsData {
  renderScale: number;
  cloudQuality: 'low' | 'medium' | 'high';
  motionBlur: boolean;
  sensorNoise: number;
  cameraShake: number;
  lensDistortion: boolean;
  timestamp: boolean;
  fov: number;
  bodycamFov: number;
  mouseSensitivity: number;
  invertY: boolean;
  masterVolume: number;
  rainDensity: number;
  units: 'imperial' | 'metric';
}

const DEFAULTS: SettingsData = {
  renderScale: 0.75,
  cloudQuality: 'medium',
  motionBlur: true,
  sensorNoise: 1,
  cameraShake: 1,
  lensDistortion: true,
  timestamp: true,
  fov: 72,
  bodycamFov: 90,
  mouseSensitivity: 1,
  invertY: false,
  masterVolume: 0.8,
  rainDensity: 1,
  units: 'imperial',
};

const KEY = 'stormcam.settings.v1';

export class Settings {
  data: SettingsData;
  private listeners: ((s: SettingsData) => void)[] = [];

  constructor() {
    let saved: Partial<SettingsData> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SettingsData>;
    } catch {
      saved = {};
    }
    this.data = { ...DEFAULTS, ...saved };
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable */
    }
    for (const l of this.listeners) l(this.data);
  }

  onChange(fn: (s: SettingsData) => void): void {
    this.listeners.push(fn);
  }

  reset(): void {
    this.data = { ...DEFAULTS };
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(this.data);
  }

  cloudSteps(): number {
    return this.data.cloudQuality === 'low' ? 20 : this.data.cloudQuality === 'medium' ? 30 : 46;
  }
  skyDivisor(): number {
    return this.data.cloudQuality === 'high' ? 3 : this.data.cloudQuality === 'medium' ? 3.5 : 4;
  }
}
