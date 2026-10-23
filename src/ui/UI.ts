import type { Settings, SettingsData } from '../core/Settings';
import type { Career } from '../gameplay/Career';
import { UPGRADES } from '../gameplay/Upgrades';
import { clipGrade, type Clip } from '../gameplay/FootageRecorder';

/** Builds DOM from a template string. */
function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

const money = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

export interface HudState {
  recording: boolean;
  clipTime: number;
  quality: number;
  hint: string;
  clipValue: number;
  sessionValue: number;
  speedLabel: string;
  gear: string;
  objective: string[];
  /** Arrow to the tornado/storm: angle relative to where the camera looks (rad, clockwise). */
  pointer: { angle: number; label: string } | null;
  /** The current objective, one short line. */
  goal: string;
  warning: string;
  camLabel: string;
  osd: string;
  prompt: string;
  center: string;
}

export interface UIActions {
  startChase(): void;
  resume(): void;
  endChase(): void;
  toMenu(): void;
  nextDay(): void;
  selectTarget(id: number): void;
  settingsChanged(): void;
  click(): void;
}

export interface ReportData {
  clips: Clip[];
  footage: number;
  /** Probe data sold, and what lost probes cost to replace. */
  probes: { lines: string[]; value: number; lost: number };
  repairs: number;
  fuel: number;
  net: number;
  balance: number;
  day: number;
  outcome: string;
}

/**
 * All HTML UI: menus, HUD, radar device, report and garage. The HUD is
 * deliberately sparse — a camera's REC readout, a small speed readout and a
 * line of chase info — so the screen stays mostly footage.
 */
export class UI {
  readonly root: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly menu: HTMLElement;
  private panelWrap: HTMLElement | null = null;
  readonly radarDevice: HTMLElement;
  readonly radarCanvas: HTMLCanvasElement;
  private readonly toasts: HTMLElement;
  private readonly refs: Record<string, HTMLElement> = {};
  onPanelClose: (() => void) | null = null;
  /** Tears the intro down without going on to the menu (a chase started some other way). */
  private cancelIntro: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly settings: Settings,
    private readonly career: Career,
    private readonly actions: UIActions,
  ) {
    this.root = root;
    this.hud = el(`
      <div class="hud hidden">
        <div class="rec"><div class="line"><span class="dot"></span><span data-r="recLabel">STBY</span><span data-r="recTime">00:00</span></div></div>
        <div class="pointer hidden" data-r="pointer"><div class="arrow" data-r="arrow"></div><div class="plabel" data-r="plabel"></div></div>
        <div class="goal" data-r="goal"></div>
        <div class="obj" data-r="obj"></div>
        <div class="toasts"></div>
        <div class="speed"><b data-r="speed">0</b><span data-r="unit">MPH</span><span data-r="gear">D</span></div>
        <div class="cam" data-r="cam"></div>
        <div class="osd" data-r="osd"></div>
        <div class="prompt hidden" data-r="prompt"></div>
        <div class="center hidden" data-r="center"></div>
      </div>`);
    this.toasts = this.hud.querySelector('.toasts')!;
    this.hud.querySelectorAll<HTMLElement>('[data-r]').forEach((n) => (this.refs[n.dataset.r!] = n));

    this.menu = el(`<div class="menu hidden"><div class="col">
      <h1><span>STORM<span class="cam">CAM</span></span><span class="rec"></span></h1>
      <p class="tag">Independent storm chaser. Central Kansas, late May. Find the storm, get the shot, get out alive.</p>
      <button class="btn primary" data-a="start">Start chase</button>
      <button class="btn" data-a="garage">Garage</button>
      <button class="btn" data-a="settings">Settings</button>
      <button class="btn" data-a="controls">Controls</button>
      <button class="btn" data-a="exit">Exit</button>
      <div class="career" data-r="career"></div>
    </div></div>`);
    this.menu.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (!a) return;
      this.actions.click();
      if (a === 'start') this.actions.startChase();
      else if (a === 'garage') this.showGarage();
      else if (a === 'settings') this.showSettings();
      else if (a === 'controls') this.showControls();
      else if (a === 'exit') this.showExit();
    });

    this.radarDevice = el(`<div class="device hidden"><div class="title"><span>RADAR · KICT</span><span>R to close</span></div><canvas width="520" height="520"></canvas><div class="cells"></div></div>`);
    this.radarCanvas = this.radarDevice.querySelector('canvas')!;

    root.append(this.hud, this.radarDevice, this.menu);
  }

  // ------------------------------------------------------------------ screens
  /**
   * Title gate and intro. A PLAY button (browsers only allow sound after a
   * click), then "Made by Beem Studio" fades in and out, two seconds of black,
   * and the STORMCAM title slowly fades up in the middle before the main menu.
   * Any key or click after PLAY skips to the menu.
   */
  showIntro(onPlay: () => void, onDone: () => void): void {
    this.hideAll();
    const intro = el(`<div class="intro">
      <button class="play">PLAY</button>
      <div class="studio"><small>MADE BY</small><span>BEEM STUDIO</span></div>
      <h1 class="title">STORM<span class="cam">CAM</span></h1>
    </div>`);
    this.root.append(intro);
    const play = intro.querySelector<HTMLElement>('.play')!;
    const studio = intro.querySelector<HTMLElement>('.studio')!;
    const title = intro.querySelector<HTMLElement>('.title')!;
    const timers: number[] = [];
    const at = (s: number, fn: () => void) => timers.push(window.setTimeout(fn, s * 1000));
    let finished = false;
    const stop = () => {
      finished = true;
      this.cancelIntro = null;
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener('keydown', skip);
      intro.removeEventListener('click', skip);
    };
    const finish = (fade: number) => {
      if (finished) return;
      stop();
      onDone();
      intro.style.transition = `opacity ${fade}s ease`;
      intro.classList.add('out');
      window.setTimeout(() => intro.remove(), fade * 1000 + 50);
    };
    const skip = () => finish(0.6);
    this.cancelIntro = () => {
      stop();
      intro.remove();
    };
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      play.classList.add('gone');
      onPlay();
      // Studio card: 1.5 s in, held, 1.5 s out.
      at(0.8, () => studio.classList.add('on'));
      at(4.3, () => studio.classList.remove('on'));
      // Two seconds of black after it has faded, then the title slowly comes up.
      at(7.8, () => title.classList.add('on'));
      at(14.3, () => finish(1.8));
      at(0.3, () => {
        window.addEventListener('keydown', skip);
        intro.addEventListener('click', skip);
      });
    }, { once: true });
    play.focus();
  }

  showMenu(): void {
    this.hideDeathCard();
    this.closePanel();
    this.hud.classList.add('hidden');
    this.menu.classList.remove('hidden');
    const d = this.career.data;
    this.refs.career = this.menu.querySelector('[data-r=career]')!;
    this.refs.career.textContent = `DAY ${d.day}  ·  ${money(d.money)}  ·  ${d.tornadoesFilmed} TORNADOES FILMED`;
  }

  showHud(): void {
    this.cancelIntro?.();
    this.menu.classList.add('hidden');
    this.hud.classList.remove('hidden');
  }

  hideAll(): void {
    this.menu.classList.add('hidden');
    this.hud.classList.add('hidden');
  }

  get panelOpen(): boolean {
    return this.panelWrap !== null;
  }

  private openPanel(inner: HTMLElement): HTMLElement {
    this.closePanel(false);
    const wrap = el(`<div class="panel-wrap"></div>`);
    wrap.appendChild(inner);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) this.closePanel();
    });
    this.root.appendChild(wrap);
    this.panelWrap = wrap;
    return inner;
  }

  closePanel(notify = true): void {
    if (!this.panelWrap) return;
    this.panelWrap.remove();
    this.panelWrap = null;
    if (notify) this.onPanelClose?.();
  }

  showPause(): void {
    const p = this.openPanel(el(`<div class="panel"><h2>Paused</h2><div class="col" style="display:flex;flex-direction:column;gap:10px">
      <button class="btn primary" data-a="resume">Resume</button>
      <button class="btn" data-a="settings">Settings</button>
      <button class="btn" data-a="controls">Controls</button>
      <button class="btn" data-a="end">End chase &amp; sell footage</button>
      <button class="btn" data-a="menu">Quit to main menu</button></div></div>`));
    p.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (!a) return;
      this.actions.click();
      if (a === 'resume') this.actions.resume();
      else if (a === 'settings') this.showSettings(() => this.showPause());
      else if (a === 'controls') this.showControls(() => this.showPause());
      else if (a === 'end') this.actions.endChase();
      else if (a === 'menu') this.actions.toMenu();
    });
  }

  showSettings(back?: () => void): void {
    const s = this.settings.data;
    const p = this.openPanel(el(`<div class="panel"><h2>Settings</h2><div data-r="rows"></div>
      <div class="actions"><button class="btn primary" data-a="done">Done</button><button class="btn" data-a="reset">Reset defaults</button></div></div>`));
    const rows = p.querySelector<HTMLElement>('[data-r=rows]')!;
    const slider = (key: keyof SettingsData, label: string, min: number, max: number, step: number, fmt: (v: number) => string) => {
      const r = el(`<div class="row"><label>${label}</label><span style="display:flex;gap:10px;align-items:center"><input type="range" min="${min}" max="${max}" step="${step}"><span class="val"></span></span></div>`);
      const input = r.querySelector('input')!;
      const val = r.querySelector<HTMLElement>('.val')!;
      input.value = String(s[key]);
      val.textContent = fmt(Number(input.value));
      input.addEventListener('input', () => {
        this.settings.set(key, Number(input.value) as never);
        val.textContent = fmt(Number(input.value));
        this.actions.settingsChanged();
      });
      rows.appendChild(r);
    };
    const toggle = (key: keyof SettingsData, label: string) => {
      const r = el(`<div class="row"><label>${label}</label><input type="checkbox"></div>`);
      const input = r.querySelector('input')!;
      input.checked = Boolean(s[key]);
      input.addEventListener('change', () => {
        this.settings.set(key, input.checked as never);
        this.actions.settingsChanged();
      });
      rows.appendChild(r);
    };
    const select = (key: keyof SettingsData, label: string, opts: string[]) => {
      const r = el(`<div class="row"><label>${label}</label><select>${opts.map((o) => `<option value="${o}">${o}</option>`).join('')}</select></div>`);
      const input = r.querySelector('select')!;
      input.value = String(s[key]);
      input.addEventListener('change', () => {
        this.settings.set(key, input.value as never);
        this.actions.settingsChanged();
      });
      rows.appendChild(r);
    };
    const pct = (v: number) => Math.round(v * 100) + '%';
    slider('renderScale', 'Render resolution', 0.5, 1, 0.05, pct);
    select('cloudQuality', 'Cloud & storm quality', ['low', 'medium', 'high']);
    slider('rainDensity', 'Rain density', 0.25, 1, 0.05, pct);
    toggle('motionBlur', 'Motion blur');
    slider('sensorNoise', 'Camera sensor noise', 0, 2, 0.1, pct);
    slider('cameraShake', 'Camera shake', 0, 1.5, 0.05, pct);
    toggle('lensDistortion', 'Dashcam lens distortion');
    toggle('timestamp', 'Dashcam timestamp overlay');
    slider('fov', 'Driver field of view', 55, 90, 1, (v) => v + '°');
    slider('bodycamFov', 'Bodycam field of view', 70, 110, 1, (v) => v + '°');
    slider('mouseSensitivity', 'Mouse sensitivity', 0.3, 2.5, 0.05, (v) => v.toFixed(2));
    toggle('invertY', 'Invert mouse Y');
    slider('masterVolume', 'Master volume', 0, 1, 0.05, pct);
    select('units', 'Units', ['imperial', 'metric']);
    p.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (a === 'done') {
        this.actions.click();
        if (back) back();
        else this.closePanel();
      } else if (a === 'reset') {
        this.settings.reset();
        this.actions.settingsChanged();
        this.showSettings(back);
      }
    });
  }

  showControls(back?: () => void): void {
    const keys: [string, string][] = [
      ['W / S', 'Accelerate / brake, reverse when stopped'], ['A / D', 'Steer'], ['Space', 'Handbrake'], ['Mouse', 'Look around'],
      ['1 / 2 / 3, wheel', 'Camera / radar tablet / flashlight (again to put away)'], ['Left click', 'Use the item: film, flashlight'], ['C', 'Driver view ↔ dashcam'], ['F', 'Get out / get in'], ['E', 'Liftgate, take / set down / program / pick up probes'], ['L', 'Headlights / head torch on foot'],
      ['R', 'Weather radar'], ['1 – 4', 'Pick target cell (radar open)'], ['X', 'Wipers: auto / off / low / high'],
      ['L', 'Headlights'], ['T', 'Dashcam timestamp'], ['Hold RMB', 'Zoom (bodycam)'], ['Esc', 'Pause'],
    ];
    const p = this.openPanel(el(`<div class="panel"><h2>Controls</h2><div class="keys">${keys
      .map(([k, d]) => `<span class="k">${k}</span><span>${d}</span>`)
      .join('')}</div><div class="actions"><button class="btn primary" data-a="done">Done</button></div></div>`));
    p.querySelector('[data-a=done]')!.addEventListener('click', () => {
      this.actions.click();
      if (back) back();
      else this.closePanel();
    });
  }

  showGarage(back?: () => void): void {
    const owned = this.career.owned;
    const d = this.career.data;
    const p = this.openPanel(el(`<div class="panel shop"><h2>Garage · ${money(d.money)}</h2>${UPGRADES.map(
      (u) => `<div class="item"><span class="n">${u.name} <span class="ev">· ${u.category}</span></span><span class="b">${u.blurb}</span>
        <span class="p">${money(u.price)}${owned.has(u.id) ? '<span class="ev">OWNED</span>' : `<button class="btn" data-buy="${u.id}" ${d.money < u.price ? 'disabled' : ''}>Buy</button>`}</span></div>`,
    ).join('')}<div class="actions"><button class="btn primary" data-a="done">Done</button></div></div>`));
    p.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const buy = t.closest<HTMLElement>('[data-buy]')?.dataset.buy;
      if (buy) {
        this.actions.click();
        if (this.career.buy(buy as never)) this.showGarage(back);
        return;
      }
      if (t.closest('[data-a=done]')) {
        this.actions.click();
        if (back) back();
        else {
          this.closePanel();
          this.showMenu();
        }
      }
    });
  }

  showReport(r: ReportData): void {
    this.hideDeathCard();
    this.hud.classList.add('hidden');
    const rows = r.clips.length
      ? r.clips
          .map(
            (c) => `<tr><td>#${c.id}</td><td>${fmtTime(c.duration)}</td><td>${clipGrade(c)}</td>
              <td>${c.events.map((e) => `<div class="ev">${e.label} (+${money(e.bonus)})</div>`).join('') || '<span class="ev">—</span>'}</td>
              <td class="num">${money(c.value)}</td></tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="ev">No usable footage recorded. Take out the camcorder (1) and click to film when you have the storm in view.</td></tr>`;
    const p = this.openPanel(el(`<div class="panel report" style="width:min(720px, calc(100vw - 32px))"><h2>Day ${r.day} · ${r.outcome}</h2>
      <table><tr><th>Clip</th><th>Length</th><th>Grade</th><th>Highlights</th><th class="num">Sale</th></tr>${rows}</table>
      <div class="total"><span>Footage sold</span><span class="pos">${money(r.footage)}</span></div>
      ${r.probes.lines.map((l) => `<div class="ev" style="padding:2px 0">${l}</div>`).join('')}
      <div class="total"><span>Probe data sold</span><span class="pos">${money(r.probes.value)}</span></div>
      ${r.probes.lost ? `<div class="total"><span>Replacement probes</span><span class="neg">${money(-r.probes.lost)}</span></div>` : ''}
      <div class="total"><span>Repairs</span><span class="neg">${money(-r.repairs)}</span></div>
      <div class="total"><span>Fuel &amp; motel</span><span class="neg">${money(-r.fuel)}</span></div>
      <div class="total"><span>Net</span><span class="${r.net >= 0 ? 'pos' : 'neg'}">${money(r.net)}</span></div>
      <div class="total" style="border-top:1px solid var(--line);margin-top:8px"><span>Balance</span><span>${money(r.balance)}</span></div>
      <div class="actions"><button class="btn primary" data-a="next">Next chase day</button><button class="btn" data-a="garage">Garage</button><button class="btn" data-a="menu">Main menu</button></div></div>`));
    p.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (!a) return;
      this.actions.click();
      if (a === 'next') this.actions.nextDay();
      else if (a === 'garage') this.showGarage(() => this.showReport(r));
      else if (a === 'menu') this.actions.toMenu();
    });
  }

  showExit(): void {
    const p = this.openPanel(el(`<div class="panel"><h2>Exit</h2><p style="color:var(--fg-dim);line-height:1.6;margin:0">Your progress is saved in this browser. Close this tab to quit.</p>
      <div class="actions"><button class="btn primary" data-a="back">Back</button></div></div>`));
    p.querySelector('[data-a=back]')!.addEventListener('click', () => this.closePanel());
  }

  // ------------------------------------------------------------------ devices
  setRadarCells(cells: { id: number; label: string }[], selected: number | null): void {
    const box = this.radarDevice.querySelector('.cells')!;
    const key = cells.map((c) => c.id).join(',') + '|' + selected;
    if ((box as HTMLElement).dataset.key === key) return;
    (box as HTMLElement).dataset.key = key;
    box.innerHTML = cells
      .map((c, k) => `<button data-cell="${c.id}" class="${c.id === selected ? 'sel' : ''}">${k + 1} · CELL ${c.label}</button>`)
      .join('');
    box.querySelectorAll<HTMLElement>('[data-cell]').forEach((b) =>
      b.addEventListener('click', () => {
        this.actions.click();
        this.actions.selectTarget(Number(b.dataset.cell));
      }),
    );
  }

  // ------------------------------------------------------------------ HUD
  updateHud(h: HudState): void {
    const r = this.refs;
    // Only a REC readout while rolling; nothing on screen otherwise.
    const rec = this.hud.querySelector('.rec')!;
    rec.classList.toggle('on', h.recording);
    rec.classList.toggle('hidden', !h.recording);
    r.recLabel.textContent = 'REC';
    r.recTime.textContent = fmtTime(h.clipTime);
    r.goal.textContent = h.goal;
    r.pointer.classList.toggle('hidden', !h.pointer);
    if (h.pointer) {
      r.arrow.style.transform = `rotate(${h.pointer.angle}rad)`;
      r.plabel.textContent = h.pointer.label;
    }
    r.speed.textContent = h.speedLabel.split(' ')[0];
    r.unit.textContent = h.speedLabel.split(' ')[1] ?? '';
    r.gear.textContent = h.gear;
    r.obj.innerHTML = (h.warning ? `<div class="warn">${h.warning}</div>` : '') + h.objective.map((l) => `<div>${l}</div>`).join('');
    r.cam.textContent = h.camLabel;
    r.osd.textContent = h.osd;
    r.prompt.classList.toggle('hidden', !h.prompt);
    r.prompt.textContent = h.prompt;
    r.center.classList.toggle('hidden', !h.center);
    r.center.textContent = h.center;
  }

  private deathCardEl: HTMLElement | null = null;

  /** Full-screen black card when the chaser dies: a title, a line about how, and a recorder stamp. */
  showDeathCard(title: string, sub: string, osd: string): void {
    this.hideDeathCard();
    const d = el(`<div class="death-card"><div class="dc-title"></div><div class="dc-sub"></div><div class="dc-osd"></div></div>`);
    (d.querySelector('.dc-title') as HTMLElement).textContent = title;
    (d.querySelector('.dc-sub') as HTMLElement).textContent = sub;
    (d.querySelector('.dc-osd') as HTMLElement).textContent = osd;
    this.root.appendChild(d);
    this.deathCardEl = d;
    requestAnimationFrame(() => d.classList.add('on'));
    setTimeout(() => d.classList.add('on'), 50);
  }

  hideDeathCard(): void {
    this.deathCardEl?.remove();
    this.deathCardEl = null;
  }

  toast(text: string, kind: 'info' | 'money' | 'alert' = 'info', ms = 4000): void {
    const t = el(`<div class="toast ${kind}"></div>`);
    t.textContent = text;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 5) this.toasts.firstElementChild!.remove();
    setTimeout(() => t.remove(), ms);
  }
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
