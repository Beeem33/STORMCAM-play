import * as THREE from 'three';
import { Renderer } from '../rendering/Renderer';
import { atmo, patchObject } from '../rendering/Atmosphere';
import { Terrain } from '../environment/Terrain';
import { Lighting } from '../environment/Lighting';
import { WorldProps } from '../environment/WorldProps';
import { ContactShadow } from '../vehicle/ContactShadow';
import { CG_HEIGHT, DRIVER_DOOR, type VehicleParts } from '../vehicle/VehicleModel';
import { Vehicle, type DriveInput } from '../vehicle/Vehicle';
import { Windshield } from '../vehicle/Windshield';
import { CameraRig, LENSES } from '../camera/CameraRig';
import { Walker } from '../player/Walker';
import { PlayerBody } from '../player/PlayerBody';
import { Input } from './Input';
import { Settings } from './Settings';
import { WeatherSystem } from '../weather/WeatherSystem';
import { Precipitation } from '../weather/Precipitation';
import { Lightning } from '../weather/Lightning';
import { TornadoSystem } from '../tornado/TornadoSystem';
import { FootageRecorder } from '../gameplay/FootageRecorder';
import { Career } from '../gameplay/Career';
import { Radar } from '../gameplay/Radar';
import { compass, drawMap, gridRoute, routeLength } from '../gameplay/Navigation';
import { AudioSystem } from '../audio/AudioSystem';
import type { AudioFrameState } from '../audio/AudioTypes';
import { UI, type HudState } from '../ui/UI';
import { clamp, damp, MPS_TO_MPH } from '../utils/MathUtils';
import { MAP_HALF } from '../environment/WorldShape';

export type GameState = 'menu' | 'playing' | 'paused' | 'report';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
/** Chase days start at 4:12 PM local time. */
const DAY_START_SECONDS = 16 * 3600 + 12 * 60;
/** Lat/lon of the world origin (central Kansas) for the dashcam GPS readout. */
const ORIGIN_LAT = 38.0512;
const ORIGIN_LON = -97.9324;

/**
 * Owns every system and runs the frame in a fixed order:
 *   input → weather → tornado → world → vehicle / walker → camera →
 *   recording → atmosphere → audio → render → HUD.
 */
export class Game {
  readonly renderer: Renderer;
  readonly scene = new THREE.Scene();
  readonly input: Input;
  readonly settings = new Settings();
  readonly career = new Career();
  readonly lighting: Lighting;
  readonly terrain = new Terrain();
  readonly world: WorldProps;
  readonly parts: VehicleParts;
  readonly vehicle = new Vehicle();
  readonly vehicleObj = new THREE.Group();
  private readonly carShadow = new ContactShadow(2.3, 5.3);
  readonly windshield: Windshield;
  readonly rig = new CameraRig();
  readonly walker = new Walker();
  readonly body = new PlayerBody();
  readonly weather = new WeatherSystem();
  readonly precip = new Precipitation();
  readonly lightning = new Lightning();
  readonly tornadoes = new TornadoSystem();
  readonly recorder = new FootageRecorder();
  readonly radar = new Radar();
  readonly audio = new AudioSystem();
  readonly ui: UI;
  state: GameState = 'menu';
  time = 0;
  /** Seconds since this chase day began. */
  dayTime = 0;
  onFoot = false;
  headlightsOn = false;
  private radarOpen = false;
  private mapOpen = false;
  private last = performance.now();
  running = true;
  /** Wind at the camera (m/s) — total of storm + tornado. */
  readonly windAtCam = new THREE.Vector3();
  private readonly camVel = new THREE.Vector3();
  private readonly prevCam = new THREE.Vector3();
  private shakeImpulse = 0;
  private endTimer = -1;
  private endReason = '';
  private distanceDriven = 0;
  private menuYaw = 0;
  private readonly audioState: AudioFrameState;
  private warnedTornado = 0;
  private warningToasted = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, parts: VehicleParts) {
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    this.scene.fog = new THREE.FogExp2(0x888888, 0.0001);
    this.lighting = new Lighting(this.scene);
    this.scene.add(this.renderer.sky.dome, this.terrain.mesh);
    this.world = new WorldProps(this.tornadoes.debris);
    this.scene.add(this.world.group, this.precip.group, this.lightning.group, this.tornadoes.group);

    this.parts = parts;
    this.vehicleObj.add(this.parts.root);
    this.scene.add(this.vehicleObj, this.body.root, this.carShadow.mesh);
    patchObject(this.vehicleObj);
    this.body.load().catch((e) => console.warn('[body] chaser body unavailable', e));
    this.windshield = new Windshield(this.parts);
    this.vehicle.colliders = this.world.query;
    this.walker.colliders = this.world.query;

    this.audioState = {
      dt: 0, listenerPos: new THREE.Vector3(), listenerForward: new THREE.Vector3(0, 0, -1), listenerUp: new THREE.Vector3(0, 1, 0),
      inVehicle: true, windowDamage: 0, engineRunning: true, engineRpm: 750, engineLoad: 0, vehicleSpeed: 0, surface: 'asphalt',
      tireSlip: 0, bumpiness: 0, rain: 0, hail: 0, windSpeed: 0,
      tornado: { active: false, position: new THREE.Vector3(), distance: 1e5, intensity: 0, radius: 100 },
    };
    if (new URLSearchParams(location.search).has('mute')) this.audio.setMuted(true);
    this.audio.setMasterVolume(this.settings.data.masterVolume);

    this.ui = new UI(uiRoot, this.settings, this.career, {
      startChase: () => this.beginChase(),
      resume: () => this.resume(),
      endChase: () => this.endChase('Chase ended'),
      toMenu: () => this.toMenu(),
      nextDay: () => this.beginChase(),
      selectTarget: (id) => this.selectTarget(id),
      settingsChanged: () => this.applySettings(),
      click: () => {
        this.audio.unlock();
        this.audio.uiClick();
      },
    });
    this.ui.onPanelClose = () => {
      if (this.state === 'paused') this.resume();
    };

    this.wireEvents();
    canvas.addEventListener('mousedown', () => {
      this.audio.unlock();
      if (this.state === 'playing') this.input.requestLock();
    });
    window.addEventListener('keydown', () => this.audio.unlock());
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'playing' && !this.radarOpen && !this.mapOpen) this.pause();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.state === 'playing') this.pause();
        else if (this.state === 'paused' && !this.ui.panelOpen) this.resume();
      }
    });

    this.setupDay();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.updateEnvironment(this.scene, this.rig.camera.position, true);
    this.ui.showMenu();
  }

  private wireEvents(): void {
    this.weather.onTornadogenesis = (s) => {
      if (this.tornadoes.tornado) return false;
      this.tornadoes.spawn(s);
      return true;
    };
    this.tornadoes.onSpawn = () => {
      this.warnedTornado = this.dayTime;
    };
    this.tornadoes.onEnded = (s) => {
      this.weather.tornadoEnded(s);
      if (this.state === 'playing') this.ui.toast('Spotters report the tornado has lifted.', 'info', 6000);
    };
    this.tornadoes.debris.hitTarget = this.vehicle.pos;
    this.tornadoes.debris.onHit = (strength, pos) => {
      const eff = this.career.effects;
      if (!this.onFoot) {
        this.vehicle.damage(strength * 9);
        this.vehicle.windshieldCracks = Math.min(1, this.vehicle.windshieldCracks + strength * 0.08 * eff.glassDamage);
        this.shakeImpulse = Math.max(this.shakeImpulse, strength);
      }
      this.audio.impact(strength > 0.5 ? 'body' : 'debris', strength, pos);
    };
    this.vehicle.onImpact = (strength, kind) => {
      this.audio.impact(kind === 'collision' ? 'collision' : 'body', Math.min(1, strength / 15));
      this.shakeImpulse = Math.max(this.shakeImpulse, Math.min(1, strength / 12));
    };
    this.lightning.onThunder = (distance, strength, dir) => {
      this.audio.thunder(distance, strength, dir);
      if (distance < 1200) this.shakeImpulse = Math.max(this.shakeImpulse, 0.4);
    };
    this.lightning.onStrike = (e) => this.recorder.noteStrike(e.position, e.cloudToGround, this.rig.camera, this.time);
    this.world.onDestroyed = (pos, label) => {
      this.recorder.noteDestruction(pos, label, this.rig.camera, this.time);
      if (pos.distanceTo(this.rig.camera.position) < 1500) this.audio.impact('debris', 0.8, pos);
    };
    this.recorder.onEvent = (e) => this.ui.toast(`+$${Math.round(e.bonus).toLocaleString('en-US')}  ${e.label}`, 'money');
    this.windshield.onStroke = () => this.audio.wiperStroke();
  }

  // ------------------------------------------------------------------ flow
  private setupDay(): void {
    const d = this.career.data.day;
    const start = this.world.startPose;
    this.vehicle.placeAt(start.x, start.z, start.heading);
    this.vehicle.health = 100;
    this.vehicle.windshieldCracks = 0;
    this.vehicle.destroyed = false;
    this.weather.startDay({ day: d, seed: 1000 + d * 7919 }, { x: 0, z: 0 });
    this.tornadoes.clear();
    this.windshield.clear();
    this.recorder.reset();
    this.radar.reset();
    this.dayTime = 0;
    this.distanceDriven = 0;
    this.endTimer = -1;
    this.onFoot = false;
    this.rig.setMode('driver');
    this.rig.yaw = 0;
    this.rig.pitch = -0.04;
    this.renderer.fade = 0;
    this.renderer.resetMotion();
    this.applySettings();
  }

  beginChase(): void {
    this.audio.unlock();
    this.ui.closePanel(false);
    this.setupDay();
    this.state = 'playing';
    this.ui.showHud();
    this.input.requestLock();
    this.ui.toast(`Day ${this.career.data.day}. Storms are firing west of town. Check radar (R).`, 'info', 7000);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.releaseLock();
    this.ui.showPause();
  }

  resume(): void {
    this.ui.closePanel(false);
    this.state = 'playing';
    this.ui.showHud();
    this.input.requestLock();
  }

  toMenu(): void {
    this.ui.closePanel(false);
    this.state = 'menu';
    this.input.releaseLock();
    this.setupDay();
    this.ui.showMenu();
  }

  endChase(outcome: string): void {
    if (this.state === 'report') return;
    this.recorder.stop();
    this.state = 'report';
    this.input.releaseLock();
    const c = this.career.data;
    const footage = Math.round(this.recorder.clips.reduce((a, cl) => a + cl.value, 0));
    const repairs = Math.round((100 - this.vehicle.health) * 55 + (this.vehicle.destroyed ? 4500 : 0) + this.vehicle.windshieldCracks * 900);
    const fuel = Math.round(95 + (this.distanceDriven / 1609) * 0.32);
    const net = footage - repairs - fuel;
    c.money += net;
    c.totalEarned += footage;
    c.bestClip = Math.max(c.bestClip, ...this.recorder.clips.map((cl) => cl.value), 0);
    if (this.recorder.clips.some((cl) => cl.tornadoSeconds > 3)) c.tornadoesFilmed++;
    const day = c.day;
    c.day++;
    this.career.save();
    this.ui.closePanel(false);
    this.ui.showReport({ clips: [...this.recorder.clips], footage, repairs, fuel, net, balance: c.money, day, outcome });
  }

  private selectTarget(id: number): void {
    this.radar.targetId = id;
    this.ui.toast(`Target set: cell ${this.radar.scan?.storms.find((s) => s.id === id)?.label ?? '?'}`);
  }

  applySettings(): void {
    const s = this.settings.data;
    this.audio.setMasterVolume(s.masterVolume);
    const r = this.renderer.settings;
    const changedRes = r.renderScale !== s.renderScale || r.cloudSteps !== this.settings.cloudSteps() || r.skyDivisor !== this.settings.skyDivisor();
    r.renderScale = s.renderScale;
    r.cloudSteps = this.settings.cloudSteps();
    r.skyDivisor = this.settings.skyDivisor();
    r.motionBlur = s.motionBlur;
    if (changedRes) this.resize();
    const eff = this.career.effects;
    this.radar.interval = eff.radarInterval;
    this.vehicle.offroadGrip = eff.offroadGrip;
    this.vehicle.damageScale = eff.impactDamage;
    this.tornadoes.renderer.steps = s.cloudQuality === 'low' ? 44 : s.cloudQuality === 'medium' ? 64 : 96;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  start(): void {
    let acc = 0;
    let frames = 0;
    let goodWindows = 0;
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      const raw = now - this.last;
      const dt = Math.min(0.05, raw / 1000);
      this.last = now;
      if (!this.running) return;
      this.frame(dt);
      // Adaptive resolution from real frame times (ignore hitches over 100 ms, e.g. tab switches).
      if (raw < 100 && (this.state === 'playing' || this.state === 'menu')) {
        acc += raw;
        frames++;
        if (acc > 1000) {
          const avg = acc / frames;
          // Only step up after a few calm seconds in a row.
          goodWindows = avg < 12.5 ? goodWindows + 1 : 0;
          if (avg > 19 || goodWindows >= 3) {
            this.renderer.adaptResolution(avg);
            if (goodWindows >= 3) goodWindows = 0;
          }
          acc = 0;
          frames = 0;
        }
      }
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ frame
  frame(dt: number): void {
    const playing = this.state === 'playing';
    const simulate = playing || this.state === 'menu';
    const sdt = simulate ? dt : 0;
    this.time += sdt;
    if (playing) this.dayTime += sdt;
    atmo.uTime.value = this.time;
    const inp = this.input;
    const eff = this.career.effects;

    if (playing) this.handleKeys();

    // --- Weather & tornado.
    const focus = this.onFoot ? this.walker.pos : this.vehicle.pos;
    this.weather.update(playing ? sdt : 0, focus);
    const baseAlt = this.lighting.sky.baseAlt;
    this.tornadoes.update(playing ? sdt : 0, baseAlt);
    const L = this.weather.local;
    const t = this.tornadoes.tornado;

    // --- Vehicle.
    const drive: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: !this.onFoot ? false : true };
    if (playing && !this.onFoot && !this.vehicle.destroyed) {
      drive.throttle = inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0;
      drive.brake = inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0;
      drive.steer = (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0);
      drive.handbrake = inp.isDown('Space');
    }
    this.tornadoes.windAt(_v.copy(this.vehicle.pos), _w);
    this.vehicle.wind.set(L.wind.x + _w.x, _w.y, L.wind.z + _w.z);
    this.vehicle.wetness = this.weather.wetness;
    if (sdt > 0 && this.state !== 'menu') {
      this.coreHazard(sdt, t);
      const bx = this.vehicle.pos.x, bz = this.vehicle.pos.z;
      this.vehicle.update(sdt, drive);
      this.keepInChaseArea(this.vehicle.pos, this.vehicle.vel);
      this.distanceDriven += Math.hypot(this.vehicle.pos.x - bx, this.vehicle.pos.z - bz);
    }
    this.vehicle.writeTransform(this.vehicleObj);
    this.updateVehicleVisuals(sdt);

    // --- On foot.
    if (this.onFoot && playing) {
      const fwd = (inp.isDown('KeyW') ? 1 : 0) - (inp.isDown('KeyS') ? 1 : 0);
      const right = (inp.isDown('KeyD') ? 1 : 0) - (inp.isDown('KeyA') ? 1 : 0);
      this.tornadoes.windAt(_v.copy(this.walker.pos).setY(this.walker.pos.y + 1), _w).add(L.wind);
      const yawCar = this.vehicle.heading;
      this.walker.car = { x: this.vehicle.pos.x, z: this.vehicle.pos.z, rot: -yawCar, hx: 1.0, hz: 2.55 };
      this.walker.update(sdt, { fwd, right, run: inp.isDown('ShiftLeft') || inp.isDown('ShiftRight') }, this.rig.yaw, _w);
      this.keepInChaseArea(this.walker.pos, this.walker.vel);
    }
    // The chaser's body: animated from his speed and the wind; the bodycam rides its chest mount.
    const speedOnFoot = Math.hypot(this.walker.vel.x, this.walker.vel.z);
    this.body.update(sdt, this.onFoot && !this.walker.dead, this.walker.pos, this.rig.torsoYaw, speedOnFoot, this.walker.strain);
    if (this.onFoot && this.body.chestCamPosition(_v)) {
      // Sit the lens just proud of the jacket; looking down, the wearer leans
      // forward over his feet so the jacket, legs and boots come into frame.
      const lean = THREE.MathUtils.clamp((-this.rig.torsoPitch - 0.5) / 0.8, 0, 1);
      this.walker.eye.copy(_v).add(new THREE.Vector3(-Math.sin(this.rig.torsoYaw), 0, -Math.cos(this.rig.torsoYaw)).multiplyScalar(0.06 + lean * 0.07));
      this.walker.eye.y -= lean * 0.05;
    }

    // --- Camera.
    this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 2.5);
    if (this.state === 'menu') {
      // Slow look around from the driver's seat toward the storms.
      this.menuYaw += dt * 0.025;
      this.rig.yaw = -0.3 + Math.sin(this.menuYaw) * 0.15;
      this.rig.pitch = 0.06;
    }
    const shake = this.settings.data.cameraShake * (this.onFoot ? eff.handheldShake : 1);
    this.rig.update({
      dt, time: this.time, vehicleObj: this.vehicleObj, vehicle: this.vehicle,
      walker: this.onFoot ? { eye: this.walker.eye, bob: this.walker.bob, moving: this.walker.moving, animated: this.body.loaded } : null,
      mouseDX: playing ? inp.mouseDX : 0, mouseDY: playing ? inp.mouseDY : 0, wheel: playing ? inp.wheel : 0,
      zoomHeld: inp.mouseRight, sensitivity: this.settings.data.mouseSensitivity, invertY: this.settings.data.invertY,
      shake: this.onFoot && eff.tripod && this.walker.stillTime > 1.5 ? shake * 0.1 : shake,
      fov: this.settings.data.fov, wind: this.windAtCam.length(), impulse: this.shakeImpulse,
      bodycamFov: this.settings.data.bodycamFov,
    });
    const cam = this.rig.camera;
    this.camVel.subVectors(cam.position, this.prevCam).divideScalar(Math.max(dt, 1e-3));
    if (this.camVel.length() > 200) this.camVel.set(0, 0, 0);
    this.prevCam.copy(cam.position);
    this.tornadoes.windAt(cam.position, this.windAtCam).add(L.wind);

    // --- World streaming and destruction.
    this.world.update(sdt, cam.position, playing ? t : null);
    this.world.animate(sdt, cam.position, atmo.uWind.value);

    // --- Lighting, sky, atmosphere.
    this.lightning.baseAlt = baseAlt;
    this.lightning.update(playing ? sdt : sdt * 0.5, this.weather.storms, cam.position, atmo.uViewport.value);
    const tornadoDist = t ? t.distanceTo(cam.position) : 1e9;
    const dust = t ? t.debris * t.params.debrisDensity * clamp(1 - (tornadoDist - t.radius) / (t.radius * 6 + 300), 0, 1) : 0;
    atmo.uDust.value = damp(atmo.uDust.value, dust, 2, dt);
    this.lighting.update(cam.position, L.cover, L.sunBlocked, L.rain, this.lightning.flash);
    const sky = this.renderer.sky;
    sky.setParams(this.lighting.sky);
    sky.setStorms(this.weather.storms, t ? { x: t.position.x, z: t.position.z, radius: t.radius, presence: Math.min(1, t.presence * 1.2) } : null);
    sky.setFlash(this.lightning.skyFlash.x, this.lightning.skyFlash.y, this.lightning.skyFlash.z, this.lightning.skyFlash.w);
    atmo.uFogDensity.value = 3 / L.visibility;
    atmo.uWetness.value = this.weather.wetness;
    atmo.uWind.value.set(this.windAtCam.x, this.windAtCam.z);
    this.terrain.update(cam, this.renderer.renderHeight);
    this.tornadoes.renderer.update(t, this.time, cam.position, this.lighting.sky, 1 - L.sunBlocked, this.lightning.flash);

    // --- Precipitation, glass, damage from hail.
    const inCar = !this.onFoot;
    // Rain streaks catch the sky light: brighter than the dark ground behind them.
    const skyLight = new THREE.Color().copy(this.lighting.sky.horizon).multiplyScalar(0.95);
    this.precip.density = this.settings.data.rainDensity;
    this.precip.update(this.time, cam.position, this.camVel, this.windAtCam, L.rain, L.hail, inCar ? this.vehicleObj : null, atmo.uViewport.value, skyLight);
    this.windshield.update(sdt, L.rain, L.hail, this.vehicle.forwardSpeed, this.vehicle.windshieldCracks);
    if (L.hail > 0.2 && playing) {
      this.vehicle.windshieldCracks = Math.min(1, this.vehicle.windshieldCracks + sdt * L.hail * 0.006 * eff.glassDamage);
      this.vehicle.damage(sdt * L.hail * 0.3);
    }
    this.vehicleObj.updateMatrixWorld(true);
    this.windshield.syncProxies();
    this.parts.exterior.visible = !inCar;

    // --- Recording.
    if (playing) {
      this.recorder.update({
        dt: sdt, time: this.time, camera: cam, mode: this.rig.mode, angularSpeed: this.rig.angularSpeed,
        tornado: t, storms: this.weather.storms, visibility: L.visibility, rain: L.rain, hail: L.hail,
        inVehicle: inCar, vehicleQuat: this.vehicle.quat,
        glassWater: this.windshield.activeMode === 'off' ? L.rain : L.rain * 0.3,
        stationary: this.onFoot && this.walker.stillTime > 1.5, effects: eff,
      });
      this.radar.update(sdt, this.dayTime, focus.x, focus.z, this.weather.storms, t);
    }
    this.checkEndConditions(sdt);

    // --- Audio.
    this.updateAudio(dt);

    // --- Render.
    const r = this.renderer;
    const lens = this.rig.lens;
    const base = LENSES[this.rig.mode];
    lens.barrel = this.settings.data.lensDistortion ? base.barrel : 0;
    lens.noise = base.noise * eff.sensorNoise;
    r.flashWhite = this.lightning.blowout * 0.6;
    r.glassVeil = 0.3 + 0.5 * (1 - L.cover);
    r.settings.noiseAmount = this.settings.data.sensorNoise;
    r.damage = this.onFoot ? this.walker.strain * 0.6 : 0;
    if (this.endTimer >= 0) r.fade = clamp(1 - this.endTimer / 2, 0, 1) * 0.85;
    r.updateEnvironment(this.scene, cam.position, false, dt);
    r.render(this.scene, cam, inCar ? this.windshield.glassScene : null, lens, this.time, dt);

    if (this.state === 'playing' || this.state === 'paused') this.updateHud(t);
    inp.endFrame();
  }

  /**
   * Inside a tornado's core the flow is violently unsteady. On top of the
   * aerodynamic forces, apply scripted gust impulses that roll and loft the
   * vehicle — strong tornadoes destroy anything that drives into them.
   */
  private coreHazard(dt: number, t: TornadoSystem['tornado']): void {
    if (!t || t.presence < 0.3) return;
    const v = this.vehicle;
    const d = t.distanceTo(v.pos);
    const R = Math.max(25, t.radius);
    const severity = clamp((t.params.rating + 0.5) / 4, 0.2, 1.4) * t.presence * (1 - t.rope * 0.5);
    if (d < R * 1.7) {
      const inner = clamp(1 - (d - R * 0.6) / (R * 1.1), 0, 1);
      v.damage(dt * 9 * severity * inner);
      v.windshieldCracks = Math.min(1, v.windshieldCracks + dt * 0.3 * inner * this.career.effects.glassDamage);
      this.shakeImpulse = Math.max(this.shakeImpulse, 0.4 + inner * 0.6);
      if (Math.random() < dt * 1.4 * severity * inner) {
        t.windAt(v.pos, _w);
        const kick = new THREE.Vector3(_w.x * 0.22, 4 + Math.random() * 7 * severity, _w.z * 0.22);
        const spin = new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3).multiplyScalar(severity);
        v.applyImpulse(kick, spin);
        this.audio.impact('body', 0.9, v.pos);
      }
    }
  }

  /** The chase area ends a little past the perimeter roads (the barricades); push back softly. */
  private keepInChaseArea(p: THREE.Vector3, v: THREE.Vector3): void {
    const lim = MAP_HALF + 45;
    let hit = false;
    for (const axis of ['x', 'z'] as const) {
      const over = Math.abs(p[axis]) - lim;
      if (over > 0) {
        p[axis] -= Math.sign(p[axis]) * over;
        if (Math.sign(v[axis]) === Math.sign(p[axis])) v[axis] *= -0.2;
        hit = true;
      }
    }
    if (hit && this.time - this.boundaryToast > 6) {
      this.boundaryToast = this.time;
      this.ui.toast('Roads are closed beyond here — edge of the chase area.');
    }
  }
  private boundaryToast = -100;

  private handleKeys(): void {
    const inp = this.input;
    if (inp.wasPressed('KeyQ')) {
      const on = this.recorder.toggle(this.time);
      this.audio.recordBeep(on);
    }
    if (inp.wasPressed('KeyC') && !this.onFoot) this.rig.setMode(this.rig.mode === 'driver' ? 'dashcam' : 'driver');
    if (inp.wasPressed('KeyX')) {
      const order = ['auto', 'off', 'low', 'high'] as const;
      this.windshield.mode = order[(order.indexOf(this.windshield.mode) + 1) % order.length];
      this.ui.toast(`Wipers: ${this.windshield.mode.toUpperCase()}`);
    }
    if (inp.wasPressed('KeyL')) this.headlightsOn = !this.headlightsOn;
    if (inp.wasPressed('KeyT')) this.settings.set('timestamp', !this.settings.data.timestamp);
    if (inp.wasPressed('KeyR')) {
      this.radarOpen = !this.radarOpen;
      this.mapOpen = false;
      if (this.radarOpen && !this.radar.scan) this.radar.forceScan();
    }
    if (inp.wasPressed('KeyM')) {
      this.mapOpen = !this.mapOpen;
      this.radarOpen = false;
    }
    if (this.radarOpen && this.radar.scan) {
      ['Digit1', 'Digit2', 'Digit3', 'Digit4'].forEach((code, k) => {
        const s = this.radar.scan!.storms[k];
        if (inp.wasPressed(code) && s) this.selectTarget(s.id);
      });
    }
    if (inp.wasPressed('KeyF') || inp.wasPressed('KeyE')) this.toggleOnFoot(inp.wasPressed('KeyF'));
  }

  private doorWorld(out: THREE.Vector3): THREE.Vector3 {
    out.set(DRIVER_DOOR.x, DRIVER_DOOR.y - CG_HEIGHT, DRIVER_DOOR.z);
    return this.vehicleObj.localToWorld(out);
  }

  private toggleOnFoot(isF: boolean): void {
    if (!this.onFoot) {
      if (!isF) return;
      if (this.vehicle.speed > 2.5) {
        this.ui.toast('Stop the vehicle first.');
        return;
      }
      const d = this.doorWorld(new THREE.Vector3());
      this.walker.placeAt(d.x, d.z);
      this.onFoot = true;
      this.rig.setMode('bodycam');
      this.rig.yaw = this.vehicle.heading * -1;
      this.rig.pitch = 0;
      this.audio.door(true);
      this.renderer.resetMotion();
    } else {
      const d = this.doorWorld(new THREE.Vector3());
      if (Math.hypot(d.x - this.walker.pos.x, d.z - this.walker.pos.z) > 3.5) {
        if (isF) this.ui.toast('Walk back to the driver door to get in.');
        return;
      }
      this.onFoot = false;
      this.rig.setMode('driver');
      this.rig.yaw = 0;
      this.audio.door(false);
      this.renderer.resetMotion();
    }
  }

  private checkEndConditions(dt: number): void {
    if (this.state !== 'playing') return;
    if (this.endTimer < 0) {
      if (this.vehicle.destroyed) {
        this.endTimer = 4;
        this.endReason = 'Vehicle destroyed';
        this.audio.vehicleDestroyed();
      } else if (this.onFoot && this.walker.dead) {
        this.endTimer = 4;
        this.endReason = 'Caught in the tornado';
      } else if (this.weather.storms.length === 0 && this.dayTime > 60) {
        this.endTimer = 6;
        this.endReason = 'Storms dissipated';
      }
    } else {
      this.endTimer -= dt;
      if (this.endTimer <= 0) this.endChase(this.endReason);
    }
  }

  private updateAudio(dt: number): void {
    const a = this.audioState;
    const cam = this.rig.camera;
    const L = this.weather.local;
    a.dt = dt;
    a.listenerPos.copy(cam.position);
    this.rig.forward(a.listenerForward);
    a.listenerUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    a.inVehicle = !this.onFoot;
    a.windowDamage = clamp(this.vehicle.windshieldCracks * 0.5 + (100 - this.vehicle.health) / 200, 0, 1);
    a.engineRunning = this.vehicle.engineOn && !this.vehicle.destroyed;
    a.engineRpm = this.vehicle.rpm;
    a.engineLoad = this.vehicle.throttle;
    a.vehicleSpeed = this.vehicle.speed;
    a.surface = this.vehicle.surface;
    a.tireSlip = this.vehicle.tireSlip;
    a.bumpiness = Math.max(this.vehicle.bumpiness, this.vehicle.jolt);
    a.rain = this.state === 'menu' ? L.rain * 0.5 : L.rain;
    a.hail = L.hail;
    a.windSpeed = this.windAtCam.length();
    const tor = this.tornadoes.tornado;
    a.tornado.active = !!tor;
    if (tor) {
      a.tornado.position.copy(tor.position);
      a.tornado.distance = tor.distanceTo(cam.position);
      a.tornado.intensity = tor.intensity01;
      a.tornado.radius = tor.radius;
    }
    this.audio.update(a);
  }

  // ------------------------------------------------------------------ HUD
  private clock(secondsIntoDay: number): string {
    const s = DAY_START_SECONDS + secondsIntoDay;
    const h = Math.floor(s / 3600) % 24;
    const m = Math.floor((s % 3600) / 60);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  private updateHud(t: TornadoSystem['tornado']): void {
    const imperial = this.settings.data.units === 'imperial';
    const v = this.vehicle;
    const speed = Math.abs(v.forwardSpeed);
    const focus = this.onFoot ? this.walker.pos : v.pos;
    const objective: string[] = [`DAY ${this.career.data.day}  ·  ${this.clock(this.dayTime)}`];
    const target = this.radar.target();
    const dist = (m: number) => (imperial ? `${(m / 1609.34).toFixed(1)} MI` : `${(m / 1000).toFixed(1)} KM`);
    if (target) {
      const route = routeLength(gridRoute(focus.x, focus.z, target.x, target.z));
      const sp = Math.hypot(target.vx, target.vz);
      objective.push(`CELL ${target.label}  ${dist(Math.hypot(target.x - focus.x, target.z - focus.z))} ${compass(target.x - focus.x, target.z - focus.z)}  ·  ROUTE ${dist(route)}`);
      objective.push(`MOVING ${compass(target.vx, target.vz)} ${imperial ? Math.round(sp * MPS_TO_MPH) + ' MPH' : Math.round(sp * 3.6) + ' KM/H'}`);
    } else objective.push('NO TARGET  ·  R FOR RADAR');
    if (this.career.effects.windReadout) objective.push(`WIND ${imperial ? Math.round(this.windAtCam.length() * MPS_TO_MPH) + ' MPH' : Math.round(this.windAtCam.length()) + ' M/S'}`);
    if (v.health < 95) objective.push(`VEHICLE ${Math.round(v.health)}%`);
    const warning = t && this.dayTime - this.warnedTornado < 900 && t.distanceTo(focus) < 40000 ? 'TORNADO WARNING IN EFFECT' : '';

    let prompt = '';
    if (!this.onFoot && v.speed < 1 && !v.destroyed) prompt = 'F  GET OUT';
    if (this.onFoot) {
      const d = this.doorWorld(new THREE.Vector3());
      if (Math.hypot(d.x - this.walker.pos.x, d.z - this.walker.pos.z) < 3.5) prompt = 'F  GET IN';
    }
    let center = '';
    if (v.destroyed && !this.onFoot) center = 'Vehicle disabled';
    if (this.onFoot && this.walker.dead) center = 'Caught in the tornado';

    const camLabel = this.rig.mode === 'driver' ? 'DRIVER CAM' : this.rig.mode === 'dashcam' ? 'DASHCAM' : this.rig.zoom > 1.05 ? `BODYCAM  ${this.rig.zoom.toFixed(1)}×` : 'BODYCAM';
    let osd = '';
    if (this.rig.mode === 'bodycam' && this.settings.data.timestamp) {
      const s = DAY_START_SECONDS + this.dayTime;
      const hh = String(Math.floor(s / 3600) % 24).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(Math.floor(s % 60)).padStart(2, '0');
      osd = `BODYCAM X3  2026-05-22 T${hh}:${mm}:${ss} -05:00`;
    }
    if (this.rig.mode === 'dashcam' && this.settings.data.timestamp) {
      const s = DAY_START_SECONDS + this.dayTime;
      const hh = String(Math.floor(s / 3600) % 24).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(Math.floor(s % 60)).padStart(2, '0');
      const lat = ORIGIN_LAT - v.pos.z / 111000;
      const lon = ORIGIN_LON + v.pos.x / 87700;
      osd = `2026/05/22 ${hh}:${mm}:${ss}  N${lat.toFixed(4)} W${Math.abs(lon).toFixed(4)}  ${Math.round(speed * MPS_TO_MPH)}MPH`;
    }
    const h: HudState = {
      recording: this.recorder.recording,
      clipTime: this.recorder.current?.duration ?? 0,
      quality: this.recorder.quality,
      hint: this.recorder.recording ? this.recorder.hint : '',
      clipValue: this.recorder.current?.value ?? 0,
      sessionValue: this.recorder.totalValue,
      speedLabel: this.onFoot ? '' : imperial ? `${Math.round(speed * MPS_TO_MPH)} MPH` : `${Math.round(speed * 3.6)} KM/H`,
      gear: this.onFoot ? '' : v.gearLabel,
      objective,
      warning,
      camLabel,
      osd,
      prompt,
      center,
    };
    this.ui.updateHud(h);

    if (warning && !this.warningToasted) {
      this.warningToasted = true;
      this.ui.toast('NWS: Tornado Warning issued. Radar indicated rotation.', 'alert', 8000);
    }
    if (!t) this.warningToasted = false;

    // Devices.
    this.ui.radarDevice.classList.toggle('hidden', !this.radarOpen);
    this.ui.mapDevice.classList.toggle('hidden', !this.mapOpen);
    const view = { x: focus.x, z: focus.z, heading: this.onFoot ? -this.rig.yaw : v.heading };
    if (this.radarOpen) {
      const ctx = this.ui.radarCanvas.getContext('2d')!;
      this.radar.draw(ctx, this.ui.radarCanvas.width, view, (s) => this.clock(s));
      this.ui.setRadarCells(this.radar.scan?.storms.map((s) => ({ id: s.id, label: s.label })) ?? [], this.radar.targetId);
    }
    if (this.mapOpen) {
      const ctx = this.ui.mapCanvas.getContext('2d')!;
      const tg = this.radar.target();
      drawMap(ctx, this.ui.mapCanvas.width, view, tg ? { x: tg.x, z: tg.z, label: tg.label } : null);
    }
  }

  private updateVehicleVisuals(dt: number): void {
    const p = this.parts;
    const v = this.vehicle;
    this.carShadow.update(this.vehicleObj);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const g = p.wheels[i];
      g.position.y = w.center.y + CG_HEIGHT;
      g.rotation.y = i < 2 ? -v.steerAngle : 0;
      (g.children[0] as THREE.Object3D).rotation.x = -w.spinAngle;
    }
    if (p.steeringBase && p.steeringAxis) {
      p.steeringWheel.quaternion.copy(p.steeringBase).multiply(new THREE.Quaternion().setFromAxisAngle(p.steeringAxis, -v.steerInput * 2.4));
    } else p.steeringWheel.rotation.z = -v.steerInput * 2.4;
    const mph = Math.abs(v.forwardSpeed) * MPS_TO_MPH;
    const hl = this.headlightsOn ? 1 : 0;
    if (p.gauges) p.gauges.update(mph, v.rpm, hl > 0);
    else {
      p.speedNeedle.rotation.z = -(Math.PI * 0.75 + (Math.min(mph, 120) / 120) * Math.PI * 1.5) + Math.PI / 2;
      p.tachNeedle.rotation.z = -(Math.PI * 0.75 + (Math.min(v.rpm, 6000) / 6000) * Math.PI * 1.5) + Math.PI / 2;
    }
    if (p.ledMat) p.ledMat.emissiveIntensity = hl * 8;
    const boost = this.career.effects.headlights;
    p.headlightMat.emissiveIntensity = hl * 6;
    for (const s of p.headlights) {
      s.intensity = 900 * boost;
      // Invisible lights are left out of every shader; toggling recompiles once.
      s.visible = hl > 0;
    }
    p.dashLight.visible = hl > 0;
    p.dashLight.intensity = 0.6;
    p.gaugeMat.emissiveIntensity = 0.06 + hl * 0.5;
    p.taillightMat.emissiveIntensity = 0.4 + (this.input.isDown('KeyS') && !this.onFoot ? 3 : 0) + hl;
    p.anemometer.rotation.y += dt * Math.min(40, this.windAtCam.length() * 1.6 + v.speed * 1.2);
  }
}
