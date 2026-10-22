/**
 * Interior rattles: random plastic clicks, trim creaks and loose-item knocks
 * scaled by bumpiness and speed, plus a suspension thud on sudden jolts.
 * Interior bus only.
 */
import type { AudioFrameState } from '../AudioTypes';
import type { Core } from '../Core';
import { MIX } from '../mix';
import { Poisson, clamp, fin, pick, rand } from '../util';

export class CabinLayer {
  private readonly clock = new Poisson();
  private bumpAvg = 0;
  private thudCooldown = 0;

  constructor(private readonly core: Core) {}

  update(s: AudioFrameState, dt: number): void {
    const bump = clamp(fin(s.bumpiness));
    const v = Math.max(0, fin(s.vehicleSpeed));
    const { bank, bus } = this.core;
    const now = this.core.now;

    // Sudden jolt → suspension / body thud.
    this.thudCooldown -= dt;
    const jolt = bump - this.bumpAvg;
    this.bumpAvg += (bump - this.bumpAvg) * (1 - Math.exp(-dt / 0.25));
    if (s.inVehicle && jolt > 0.12 && this.thudCooldown <= 0) {
      this.thudCooldown = 0.18;
      this.core.play(pick(bank.thud), bus.interior, MIX.thud * clamp(jolt * 2.2, 0.25, 1.2), {
        rate: rand(0.9, 1.1), pan: rand(-0.3, 0.3),
      });
    }

    if (!s.inVehicle) return;
    const rate = Math.pow(bump, 1.3) * 16 + (v / 35) * 2.5 * (0.2 + bump);
    this.clock.step(rate, dt, (f) => {
      const r = Math.random();
      const buf = r < 0.6 ? pick(bank.rattleClick) : r < 0.8 ? pick(bank.rattleCreak) : pick(bank.rattleKnock);
      this.core.play(buf, bus.interior, MIX.rattle * rand(0.3, 1) * (0.4 + 0.6 * bump), {
        when: now + 0.02 + f * dt, rate: rand(0.9, 1.15), pan: rand(-0.7, 0.7),
      });
    });
  }
}
