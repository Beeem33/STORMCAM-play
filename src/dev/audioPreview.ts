/**
 * Dev page for the audio system (open /audio.html on the Vite dev server).
 * Sliders for every AudioFrameState field, buttons for every one-shot,
 * update() on a 60 Hz timer, an output meter, presets, and an offline
 * level probe that renders each test scenario silently and prints loudness.
 */
import * as THREE from 'three';
import { AudioSystem } from '../audio/AudioSystem';
import { SCENARIOS, runScenario } from '../audio/AudioLevelProbe';
import type { ImpactKind, Surface } from '../audio/AudioTypes';
import { createAudioFrameState } from '../audio/frameState';

const audio = new AudioSystem();
const state = createAudioFrameState();
const app = document.getElementById('app')!;

const ui = {
  tornadoAngle: 30,
  thunderDist: 600,
  thunderStrength: 1,
  thunderAngle: -40,
  impactStrength: 0.7,
  impactDist: 6,
  autoWiper: false,
  volume: 0.8,
};

function section(title: string, grid = true): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  app.appendChild(h);
  const g = document.createElement('div');
  if (grid) g.className = 'grid';
  app.appendChild(g);
  return g;
}

interface SliderHandle { set(v: number): void }

function slider(
  parent: HTMLElement, label: string, min: number, max: number, step: number, value: number,
  onInput: (v: number) => void, fmt: (v: number) => string = (v) => v.toFixed(step < 1 ? 2 : 0),
  log = false,
): SliderHandle {
  const row = document.createElement('label');
  row.className = 'row';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  const out = document.createElement('output');
  const toVal = (x: number): number => (log ? Math.exp(Math.log(min) + (Math.log(max) - Math.log(min)) * x) : x);
  const toPos = (v: number): number => (log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : v);
  if (log) {
    input.min = '0';
    input.max = '1';
    input.step = '0.001';
  } else {
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
  }
  const apply = (v: number): void => {
    out.textContent = fmt(v);
    onInput(v);
  };
  input.value = String(toPos(value));
  input.addEventListener('input', () => apply(toVal(parseFloat(input.value))));
  row.append(name, input, out);
  parent.appendChild(row);
  apply(value);
  return {
    set(v: number) {
      input.value = String(toPos(v));
      apply(v);
    },
  };
}

function checkbox(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): { set(v: boolean): void } {
  const row = document.createElement('label');
  row.className = 'row';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(name, input, document.createElement('span'));
  parent.appendChild(row);
  onChange(value);
  return {
    set(v: boolean) {
      input.checked = v;
      onChange(v);
    },
  };
}

function button(parent: HTMLElement, label: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', fn);
  parent.appendChild(b);
  return b;
}

// --- top bar ---------------------------------------------------------------
const top = document.createElement('div');
app.appendChild(top);
button(top, '▶ Start audio', () => {
  audio.unlock();
  startMeter();
}, 'primary');
button(top, 'Mute / unmute', () => {
  muted = !muted;
  audio.setMuted(muted);
});
let muted = false;
const meter = document.createElement('div');
meter.id = 'meter';
const meterBar = document.createElement('div');
meter.appendChild(meterBar);
const meterText = document.createElement('div');
meterText.id = 'meterText';
meterText.textContent = 'Output: — (press Start audio)';
app.append(meter, meterText);

// --- presets ---------------------------------------------------------------
const presetsEl = section('Presets', false);
const handles: Record<string, SliderHandle> = {};
const checks: Record<string, { set(v: boolean): void }> = {};
let surfaceSelect: HTMLSelectElement;

interface Preset {
  name: string;
  v: Partial<Record<string, number>>;
  c?: Partial<Record<string, boolean>>;
  surface?: Surface;
}
const BASE: Record<string, number> = {
  rpm: 750, load: 0, speed: 0, slip: 0, bump: 0, rain: 0, hail: 0, wind: 0,
  tDist: 2000, tInt: 0.6, tRad: 80, windowDamage: 0,
};
const PRESETS: Preset[] = [
  { name: 'Idle in car', v: {}, c: { engine: true, inVehicle: true, tornado: false } },
  { name: 'Highway cruise', v: { rpm: 2200, load: 0.35, speed: 27, bump: 0.08, wind: 6 }, c: { engine: true, inVehicle: true, tornado: false } },
  { name: 'Hard acceleration', v: { rpm: 4800, load: 1, speed: 18, bump: 0.1 }, c: { engine: true, inVehicle: true, tornado: false } },
  { name: 'Gravel road', v: { rpm: 2000, load: 0.4, speed: 16, bump: 0.35, wind: 8 }, c: { engine: true, inVehicle: true, tornado: false }, surface: 'gravel' },
  { name: 'Muddy field', v: { rpm: 2600, load: 0.7, speed: 7, bump: 0.5, slip: 0.4, rain: 0.5 }, c: { engine: true, inVehicle: true, tornado: false }, surface: 'mud' },
  { name: 'Heavy rain, inside', v: { rpm: 1600, load: 0.25, speed: 14, rain: 1, wind: 14, bump: 0.05 }, c: { engine: true, inVehicle: true, tornado: false } },
  { name: 'Hail core', v: { rpm: 900, load: 0.1, speed: 3, rain: 0.8, hail: 0.9, wind: 20 }, c: { engine: true, inVehicle: true, tornado: false } },
  { name: 'Tornado 2 km', v: { rpm: 750, rain: 0.2, wind: 15, tDist: 2000, tInt: 0.8, tRad: 120 }, c: { engine: true, inVehicle: true, tornado: true } },
  { name: 'Tornado 500 m, outside', v: { wind: 30, tDist: 500, tInt: 0.8, tRad: 120, rain: 0.1 }, c: { engine: false, inVehicle: false, tornado: true } },
  { name: 'Tornado on top of us', v: { rpm: 900, wind: 80, tDist: 60, tInt: 1, tRad: 120, rain: 0.6, hail: 0.3, windowDamage: 0.7, bump: 0.6 }, c: { engine: true, inVehicle: true, tornado: true } },
];

// --- state controls --------------------------------------------------------
const veh = section('Vehicle');
checks['engine'] = checkbox(veh, 'engineRunning', true, (v) => (state.engineRunning = v));
handles['rpm'] = slider(veh, 'engineRpm', 0, 6500, 10, 750, (v) => (state.engineRpm = v));
handles['load'] = slider(veh, 'engineLoad', 0, 1, 0.01, 0, (v) => (state.engineLoad = v));
handles['speed'] = slider(veh, 'vehicleSpeed (m/s)', 0, 45, 0.1, 0, (v) => (state.vehicleSpeed = v), (v) => `${v.toFixed(1)}`);
{
  const row = document.createElement('label');
  row.className = 'row';
  const name = document.createElement('span');
  name.textContent = 'surface';
  surfaceSelect = document.createElement('select');
  for (const s of ['asphalt', 'gravel', 'grass', 'mud'] as const) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    surfaceSelect.appendChild(o);
  }
  surfaceSelect.addEventListener('change', () => (state.surface = surfaceSelect.value as Surface));
  row.append(name, surfaceSelect, document.createElement('span'));
  veh.appendChild(row);
}
handles['slip'] = slider(veh, 'tireSlip', 0, 1, 0.01, 0, (v) => (state.tireSlip = v));
handles['bump'] = slider(veh, 'bumpiness', 0, 1, 0.01, 0, (v) => (state.bumpiness = v));
checks['inVehicle'] = checkbox(veh, 'inVehicle', true, (v) => (state.inVehicle = v));
handles['windowDamage'] = slider(veh, 'windowDamage', 0, 1, 0.01, 0, (v) => (state.windowDamage = v));

const wx = section('Weather');
handles['rain'] = slider(wx, 'rain', 0, 1, 0.01, 0, (v) => (state.rain = v));
handles['hail'] = slider(wx, 'hail', 0, 1, 0.01, 0, (v) => (state.hail = v));
handles['wind'] = slider(wx, 'windSpeed (m/s)', 0, 100, 0.5, 0, (v) => (state.windSpeed = v), (v) => v.toFixed(1));

const tor = section('Tornado');
const placeTornado = (): void => {
  const a = (ui.tornadoAngle * Math.PI) / 180;
  const d = state.tornado.distance;
  state.tornado.position.set(Math.sin(a) * d, 0, -Math.cos(a) * d).add(state.listenerPos).setY(0);
};
checks['tornado'] = checkbox(tor, 'active', false, (v) => (state.tornado.active = v));
handles['tDist'] = slider(tor, 'distance (m)', 20, 5000, 1, 2000, (v) => { state.tornado.distance = v; placeTornado(); }, (v) => v.toFixed(0), true);
handles['tInt'] = slider(tor, 'intensity', 0, 1, 0.01, 0.6, (v) => (state.tornado.intensity = v));
handles['tRad'] = slider(tor, 'radius (m)', 10, 400, 1, 80, (v) => (state.tornado.radius = v));
slider(tor, 'angle (° right of fwd)', -180, 180, 1, 30, (v) => { ui.tornadoAngle = v; placeTornado(); });

// --- one-shots -------------------------------------------------------------
const shots = section('One-shots');
const dirFromAngle = (deg: number): THREE.Vector3 => {
  const a = (deg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
};
slider(shots, 'thunder distance (m)', 50, 15000, 1, 600, (v) => (ui.thunderDist = v), (v) => v.toFixed(0), true);
slider(shots, 'thunder strength', 0, 1.5, 0.01, 1, (v) => (ui.thunderStrength = v));
slider(shots, 'thunder angle (°)', -180, 180, 1, -40, (v) => (ui.thunderAngle = v));
slider(shots, 'impact strength', 0, 1.5, 0.01, 0.7, (v) => (ui.impactStrength = v));
slider(shots, 'impact distance (m)', 0, 80, 0.5, 6, (v) => (ui.impactDist = v), (v) => v.toFixed(1));
slider(shots, 'master volume', 0, 1, 0.01, 0.8, (v) => { ui.volume = v; audio.setMasterVolume(v); });

const btns = document.createElement('div');
app.appendChild(btns);
button(btns, `Thunder (slider)`, () => audio.thunder(ui.thunderDist, ui.thunderStrength, dirFromAngle(ui.thunderAngle)));
button(btns, 'Thunder 150 m', () => audio.thunder(150, 1, dirFromAngle(ui.thunderAngle)));
button(btns, 'Thunder 2 km', () => audio.thunder(2000, 1, dirFromAngle(ui.thunderAngle)));
button(btns, 'Thunder 8 km', () => audio.thunder(8000, 1));
btns.appendChild(document.createElement('br'));
for (const k of ['debris', 'collision', 'hail', 'glass', 'body'] as ImpactKind[]) {
  button(btns, `impact: ${k}`, () => {
    const a = Math.random() * Math.PI * 2;
    const pos = ui.impactDist > 0
      ? new THREE.Vector3(Math.cos(a) * ui.impactDist, 1, Math.sin(a) * ui.impactDist).add(state.listenerPos)
      : undefined;
    audio.impact(k, ui.impactStrength, pos);
  });
}
btns.appendChild(document.createElement('br'));
button(btns, 'Wiper stroke', () => audio.wiperStroke());
const autoW = button(btns, 'Auto wipers: off', () => {
  ui.autoWiper = !ui.autoWiper;
  autoW.textContent = `Auto wipers: ${ui.autoWiper ? 'on' : 'off'}`;
});
button(btns, 'Door open', () => audio.door(true));
button(btns, 'Door close', () => audio.door(false));
button(btns, 'Record start', () => audio.recordBeep(true));
button(btns, 'Record stop', () => audio.recordBeep(false));
button(btns, 'UI click', () => audio.uiClick());
button(btns, 'Vehicle destroyed', () => audio.vehicleDestroyed());

for (const p of PRESETS) {
  button(presetsEl, p.name, () => {
    const v = { ...BASE, ...p.v };
    for (const [k, val] of Object.entries(v)) if (val !== undefined) handles[k]?.set(val);
    for (const [k, val] of Object.entries(p.c ?? {})) if (val !== undefined) checks[k]?.set(val);
    surfaceSelect.value = p.surface ?? 'asphalt';
    state.surface = surfaceSelect.value as Surface;
    audio.uiClick();
  });
}

// --- probe -----------------------------------------------------------------
const probe = section('Offline level probe (silent render, ≈LUFS ungated, targets = raw mix)', false);
const probeOut = document.createElement('div');
app.appendChild(probeOut);
button(probe, 'Measure levels', () => void runProbe());

async function runProbe(): Promise<void> {
  const rows: string[] = [];
  const table = document.createElement('table');
  probeOut.replaceChildren(table);
  const render = (): void => {
    table.innerHTML =
      '<tr><th>scenario</th><th>raw LUFS</th><th>target</th><th>final LUFS</th><th>final RMS</th><th>final peak dBFS</th></tr>' +
      rows.join('');
  };
  const results: unknown[] = [];
  for (const sc of SCENARIOS) {
    const raw = await runScenario(sc, true);
    const fin = await runScenario(sc, false);
    results.push({ raw, fin });
    const delta = raw.target !== undefined ? raw.lufs - raw.target : 0;
    const cls = raw.target === undefined ? '' : Math.abs(delta) <= 3 ? 'ok' : 'bad';
    rows.push(
      `<tr><td>${sc.name}</td><td class="${cls}">${raw.lufs.toFixed(1)}</td><td>${raw.target ?? ''}</td>` +
        `<td>${fin.lufs.toFixed(1)}</td><td>${fin.rms.toFixed(1)}</td><td>${fin.peak.toFixed(1)}</td></tr>`,
    );
    render();
  }
  (window as unknown as { __probe?: unknown }).__probe = results;
}

// --- loop / meter ----------------------------------------------------------
let wiperT = 0;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  state.dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (ui.autoWiper) {
    wiperT += state.dt;
    if (wiperT > 1.1) {
      wiperT = 0;
      audio.wiperStroke();
    }
  }
  audio.update(state);
}, 1000 / 60);

let meterStarted = false;
function startMeter(): void {
  if (meterStarted) return;
  const ctx = audio.context;
  const out = audio.outputNode;
  if (!ctx || !out) return;
  meterStarted = true;
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  out.connect(an);
  const buf = new Float32Array(an.fftSize);
  let peakHold = -120;
  const tick = (): void => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      s += buf[i]! * buf[i]!;
      p = Math.max(p, Math.abs(buf[i]!));
    }
    const rms = 10 * Math.log10(s / buf.length + 1e-12);
    const pk = 20 * Math.log10(p + 1e-9);
    peakHold = Math.max(pk, peakHold - 0.3);
    meterBar.style.width = `${Math.max(0, Math.min(100, ((rms + 60) / 60) * 100))}%`;
    meterText.textContent = `Output RMS ${rms.toFixed(1)} dBFS · peak ${peakHold.toFixed(1)} dBFS · ctx ${(ctx as AudioContext).state ?? ''}`;
    requestAnimationFrame(tick);
  };
  tick();
}

(window as unknown as { stormAudio?: AudioSystem }).stormAudio = audio;
