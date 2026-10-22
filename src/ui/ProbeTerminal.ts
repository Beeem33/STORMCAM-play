/**
 * The probe's field programmer: a rugged handheld screen that pops up when the
 * chaser kneels at a placed probe. Arming it takes three quick calibration
 * checks (basic arithmetic typed on the keypad). The storm doesn't wait while
 * you type — the world keeps running behind the screen.
 */

const STEPS = 3;

function problem(): { text: string; answer: number } {
  const r = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
  switch (Math.floor(Math.random() * 4)) {
    case 0: {
      const a = r(12, 79), b = r(11, 49);
      return { text: `${a} + ${b}`, answer: a + b };
    }
    case 1: {
      const a = r(41, 98), b = r(12, a - 5);
      return { text: `${a} − ${b}`, answer: a - b };
    }
    case 2: {
      const a = r(3, 9), b = r(4, 12);
      return { text: `${a} × ${b}`, answer: a * b };
    }
    default: {
      const b = r(3, 9), q = r(3, 12);
      return { text: `${b * q} ÷ ${b}`, answer: q };
    }
  }
}

export class ProbeTerminal {
  private readonly el: HTMLElement;
  private readonly q: HTMLElement;
  private readonly input: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly status: HTMLElement;
  private probeId = 0;
  private done = 0;
  private current = problem();
  private typed = '';
  private onArmed: (() => void) | null = null;
  open = false;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'probe-term hidden';
    this.el.innerHTML = `
      <div class="pt-head"><span class="pt-title"></span><span class="pt-batt">BATT 82%  ·  LINK OK</span></div>
      <div class="pt-label">CALIBRATION CHECK</div>
      <div class="pt-q"></div>
      <div class="pt-in"></div>
      <div class="pt-steps"></div>
      <div class="pt-status"></div>
      <div class="pt-help">Type the answer · Enter to send · E to put it away</div>`;
    root.appendChild(this.el);
    this.q = this.el.querySelector('.pt-q')!;
    this.input = this.el.querySelector('.pt-in')!;
    this.steps = this.el.querySelector('.pt-steps')!;
    this.status = this.el.querySelector('.pt-status')!;
    window.addEventListener('keydown', (e) => this.key(e), true);
  }

  show(probeId: number, onArmed: () => void): void {
    this.probeId = probeId;
    this.onArmed = onArmed;
    this.done = 0;
    this.typed = '';
    this.current = problem();
    this.open = true;
    (this.el.querySelector('.pt-title') as HTMLElement).textContent = `PROBE ${probeId}  ·  FIELD PROGRAMMER`;
    this.status.textContent = '';
    this.status.className = 'pt-status';
    this.el.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.open = false;
    this.el.classList.add('hidden');
  }

  private render(): void {
    this.q.textContent = `${this.current.text} = ?`;
    this.input.textContent = this.typed || '_';
    this.steps.innerHTML = Array.from({ length: STEPS }, (_, i) => `<i class="${i < this.done ? 'ok' : ''}"></i>`).join('');
  }

  private key(e: KeyboardEvent): void {
    if (!this.open) return;
    // The programmer owns the keyboard while it's up.
    e.stopPropagation();
    e.preventDefault();
    const digit = /^(Digit|Numpad)(\d)$/.exec(e.code);
    if (digit && this.typed.length < 4) this.typed += digit[2];
    else if (e.code === 'Backspace') this.typed = this.typed.slice(0, -1);
    else if (e.code === 'Escape' || e.code === 'KeyE') {
      this.close();
      return;
    } else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && this.typed) {
      if (Number(this.typed) === this.current.answer) {
        this.done++;
        this.status.textContent = 'ACCEPTED';
        this.status.className = 'pt-status ok';
        if (this.done >= STEPS) {
          this.status.textContent = `PROBE ${this.probeId} ARMED · LOGGING`;
          this.render();
          const cb = this.onArmed;
          setTimeout(() => this.close(), 700);
          cb?.();
          this.open = false;
          return;
        }
      } else {
        this.status.textContent = 'CHECKSUM ERROR · NEW CODE';
        this.status.className = 'pt-status bad';
      }
      this.current = problem();
      this.typed = '';
    }
    this.render();
  }
}
