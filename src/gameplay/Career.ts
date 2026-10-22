import { effectsFor, UPGRADES, type UpgradeEffects, type UpgradeId } from './Upgrades';

/** Persistent progress: money, chase days, owned equipment, best clips. */
interface CareerData {
  money: number;
  day: number;
  owned: UpgradeId[];
  bestClip: number;
  totalEarned: number;
  tornadoesFilmed: number;
}

const KEY = 'stormcam.career.v1';
const FRESH: CareerData = { money: 1500, day: 1, owned: [], bestClip: 0, totalEarned: 0, tornadoesFilmed: 0 };

export class Career {
  data: CareerData;

  constructor() {
    let saved: Partial<CareerData> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CareerData>;
    } catch {
      saved = {};
    }
    this.data = { ...FRESH, ...saved };
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable */
    }
  }

  get owned(): Set<UpgradeId> {
    return new Set(this.data.owned);
  }

  get effects(): UpgradeEffects {
    return effectsFor(this.owned);
  }

  buy(id: UpgradeId): boolean {
    const def = UPGRADES.find((u) => u.id === id);
    if (!def || this.data.owned.includes(id) || this.data.money < def.price) return false;
    this.data.money -= def.price;
    this.data.owned.push(id);
    this.save();
    return true;
  }

  reset(): void {
    this.data = { ...FRESH, owned: [] };
    this.save();
  }
}
