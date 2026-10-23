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
import { ProbeSystem } from '../gameplay/Probes';
import { WindDebris } from '../weather/WindDebris';
import { ProbeTerminal } from '../ui/ProbeTerminal';
import { Grass } from '../environment/Grass';
import { TruckDamage } from '../vehicle/TruckDamage';
import { Missiles } from '../tornado/Missiles';
import { BreakableParts } from '../vehicle/BreakableParts';
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
import { MAP_HALF, MILE, heightAt } from '../environment/WorldShape';

export type GameState = 'menu' | 'playing' | 'paused' | 'report';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _qSway = new THREE.Quaternion();
const _eSway = new THREE.Euler();
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
  readonly probes: ProbeSystem;
  readonly windDebris = new WindDebris();
  readonly terminal: ProbeTerminal;
  readonly grass = new Grass();
  readonly truckDamage: TruckDamage;
  readonly missiles: Missiles;
  readonly breakables: BreakableParts;
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
  /** Head torch, worn on foot (L toggles it out of the truck). */
  headlampOn = false;
  private readonly headlamp = new THREE.SpotLight('#fff1dc', 0, 70, 0.38, 0.55, 1.4);
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
  /** The truck was carried up by the vortex with the chaser inside. */
  private driverKilled = false;
  /** Highest the truck has been off the ground in this flight, and where it left the ground. */
  private truckPeak = 0;
  private readonly liftoff = new THREE.Vector3();
  private walkerPeak = 0;
  private readonly walkerFrom = new THREE.Vector3();
  private deathText: { title: string; sub: string } | null = null;
  private tornadoSeen = false;
  /** Seconds since the truck was last inside the tornado's core region. */
  private inVortexTime = 0;
  private wreckToasted = false;
  private calmToasted = false;
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
    this.probes = new ProbeSystem(this.parts, this.tornadoes);
    this.scene.add(this.probes.group, this.windDebris.mesh, this.headlamp, this.headlamp.target, this.grass.mesh);
    this.probes.onEvent = (text, kind) => this.ui.toast(text, kind);
    this.terminal = new ProbeTerminal(uiRoot);
    this.truckDamage = new TruckDamage(this.parts.root);
    this.missiles = new Missiles(this.tornadoes.debris);
    this.breakables = new BreakableParts(this.parts.root, this.vehicleObj, this.tornadoes.debris);
    const partLabel: Record<string, string> = { Hood: 'hood', BrushGuard: 'brush guard', RoofRack: 'roof rack', Mirrors: 'mirrors', Mirror_L: 'left mirror', Mirror_R: 'right mirror', Bumper_F: 'front bumper', Bumper_R: 'rear bumper', Anemometer: 'anemometer', Door_FL: "driver's door", Door_FR: 'passenger door', Door_RL: 'rear left door', Door_RR: 'rear right door' };
    this.breakables.onBreak = (name) => {
      if (this.state === 'playing') this.ui.toast(`The ${partLabel[name] ?? name.replace(/_/g, ' ').toLowerCase()} tore off!`, 'alert', 3000);
    };
    this.probes.onProgram = (d) => this.terminal.show(d.id, () => this.probes.arm(d));
    this.vehicle.onRighted = () => {
      if (this.state === 'playing') this.ui.toast('You rock the truck back onto its wheels.', 'info', 4000);
    };
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
    this.setupMenuScene();
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
    this.tornadoes.debris.onHit = (strength, pos, vel, mass) => {
      const eff = this.career.effects;
      if (!this.onFoot) {
        const v = this.vehicle;
        const heavy = mass ?? 0.2;
        v.damage(strength * (3 + heavy * 1.5));
        // Where on the truck it struck: snap to the body's surface on the side it came from.
        const local = this.vehicleObj.worldToLocal(pos.clone());
        const ex = Math.abs(local.x) / 1.0, ey = Math.abs(local.y - 0.35) / 0.75, ez = Math.abs(local.z) / 2.5;
        if (ex >= ey && ex >= ez) local.x = Math.sign(local.x) * 1.0;
        else if (ez >= ey) local.z = Math.sign(local.z) * 2.5;
        else local.y = local.y > 0.35 ? 1.1 : -0.4;
        local.x = clamp(local.x, -1, 1);
        local.y = clamp(local.y, -0.4, 1.1);
        local.z = clamp(local.z, -2.5, 2.5);
        this.truckDamage.add(local, strength * (0.4 + Math.min(1, heavy / 4)));
        this.breakables.hit(local, strength * (0.4 + heavy * 0.25), vel ?? v.vel);
        // Front and above the hood: it's the windshield.
        if (local.z < -0.3 && local.z > -2.0 && local.y > 0.15) {
          const sev = strength * (0.45 + Math.min(0.6, heavy * 0.12)) * eff.glassDamage;
          this.windshield.impact(sev, clamp((local.x + 0.85) / 1.7, 0, 1), clamp((local.y - 0.15) / 0.8, 0.05, 0.95));
          v.windshieldCracks = Math.min(1, v.windshieldCracks + sev * 0.3);
        }
        // Heavy junk shoves the truck and can roll it.
        if (vel && mass) {
          const k = (mass * 12) / v.mass;
          v.applyImpulse(vel.clone().multiplyScalar(k).setY(Math.abs(vel.y) * k + mass * 0.08), new THREE.Vector3((Math.random() - 0.5) * mass * 0.12, (Math.random() - 0.5) * mass * 0.06, (Math.random() - 0.5) * mass * 0.12));
        }
        this.shakeImpulse = Math.max(this.shakeImpulse, Math.min(1, strength * (0.6 + heavy * 0.2)));
      }
      this.audio.impact(strength > 0.4 || (mass ?? 0) > 1 ? 'body' : 'debris', strength, pos);
    };
    this.vehicle.onImpact = (strength, kind, local) => {
      // Dents: landings show from ~7 m/s, crashes from ~5 m/s.
      this.truckDamage.add(local, (strength - (kind === 'ground' ? 7 : 5)) / 18);
      this.breakables.hit(local, (strength - (kind === 'ground' ? 9 : 7)) / 14, this.vehicle.vel);
      // Being carried by the vortex is survivable; being slammed down or into something isn't.
      if (!this.onFoot && !this.driverKilled && this.inVortexTime > 0 && (kind === 'ground' ? strength > 22 : strength > 18)) {
        this.driverKilled = true;
        const mph = Math.round(strength * 2.237);
        const ft = Math.round(this.truckPeak * 3.281);
        const away = Math.hypot(this.vehicle.pos.x - this.liftoff.x, this.vehicle.pos.z - this.liftoff.z);
        this.deathText = {
          title: 'SIGNAL LOST',
          sub: ft > 30
            ? `The tornado threw your truck ${ft} feet into the air. It came down ${farText(away)} away.`
            : kind === 'collision'
              ? `The tornado hurled your truck into an obstacle at ${mph} mph.`
              : `The tornado slammed your truck into the ground at ${mph} mph.`,
        };
      }
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
    const start = randomStart(this.world.startPose);
    this.vehicle.placeAt(start.x, start.z, start.heading);
    this.vehicle.health = 100;
    this.vehicle.windshieldCracks = 0;
    this.vehicle.destroyed = false;
    this.weather.startDay({ day: d, seed: (Math.random() * 1e9) | 0 }, { x: start.x, z: start.z });
    this.tornadoes.clear();
    this.windshield.clear();
    this.recorder.reset();
    this.probes.reset();
    this.truckDamage.clear();
    this.breakables.reset();
    this.terminal.close();
    this.windDebris.clear();
    this.radar.reset();
    this.dayTime = 0;
    this.distanceDriven = 0;
    this.endTimer = -1;
    this.driverKilled = false;
    this.truckPeak = 0;
    this.walkerPeak = 0;
    this.deathText = null;
    this.tornadoSeen = false;
    this.wreckToasted = false;
    this.calmToasted = false;
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
    this.headlightsOn = false;
    this.setupDay();
    this.state = 'playing';
    this.ui.showHud();
    this.input.requestLock();
    const lead = this.weather.storms.find((s) => s.tornadic);
    const where = lead ? ` to the ${compassWord(lead.x - this.vehicle.pos.x, lead.z - this.vehicle.pos.z)}` : '';
    this.ui.toast(`Day ${this.career.data.day}. A supercell${where} is about to drop a tornado. Follow the red arrow.`, 'info', 8000);
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
    this.setupMenuScene();
    this.ui.showMenu();
  }

  /**
   * The tornado has to stay reachable: as it nears the edge of the chase area
   * its parent storm turns back inward (and comes straight in if it formed
   * outside), so it wanders the map instead of leaving it.
   */
  private keepTornadoInside(dt: number): void {
    const t = this.tornadoes.tornado;
    if (!t) return;
    const s = t.storm;
    const speed = Math.max(6, Math.hypot(s.vx, s.vz));
    const lim = MAP_HALF - 400;
    const out = Math.max(Math.abs(t.position.x), Math.abs(t.position.z)) - lim;
    if (out > 0) {
      // Near or past the edge: head back toward the middle, turning harder the farther out it is.
      const d = Math.hypot(t.position.x, t.position.z) || 1;
      const tx = (-t.position.x / d) * speed, tz = (-t.position.z / d) * speed;
      const k = 1 - Math.exp(-dt * (0.4 + out / 250));
      s.vx += (tx - s.vx) * k;
      s.vz += (tz - s.vz) * k;
    }
    // Keep its overall speed the same so it still feels like it's travelling.
    const now = Math.hypot(s.vx, s.vz) || 1;
    s.vx *= speed / now;
    s.vz *= speed / now;
    // Hard limit: never more than a stone's throw past the edge roads, where the truck can still reach it.
    const hard = MAP_HALF + 80;
    for (const axis of ['x', 'z'] as const) {
      const over = Math.abs(t.position[axis]) - hard;
      if (over > 0) s[axis] -= Math.sign(t.position[axis]) * Math.min(over, 30 * dt);
    }
  }

  /** How high the tornado has thrown the truck; coming down from that height is fatal. */
  private trackTruckFlight(): void {
    const v = this.vehicle;
    const lift = v.pos.y - CG_HEIGHT - heightAt(v.pos.x, v.pos.z);
    if (v.airborne > 0.25 && lift > 2.5) {
      if (this.truckPeak === 0) this.liftoff.copy(v.pos);
      this.truckPeak = Math.max(this.truckPeak, lift);
    } else if (lift < 2.5 && this.truckPeak > 0) {
      // Back on the ground, whichever way up.
      if (this.truckPeak > 35 && !this.driverKilled) {
        this.driverKilled = true;
        const ft = Math.round(this.truckPeak * 3.281);
        const away = Math.hypot(v.pos.x - this.liftoff.x, v.pos.z - this.liftoff.z);
        this.deathText = { title: 'SIGNAL LOST', sub: `The tornado threw your truck ${ft} feet into the air. It came down ${farText(away)} away.` };
      }
      this.truckPeak = 0;
    }
  }

  private showDeath(sub: string): void {
    const s = DAY_START_SECONDS + this.dayTime;
    const hh = String(Math.floor(s / 3600) % 24).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    const cam = this.onFoot ? 'BODYCAM X3' : 'DASHCAM 01';
    this.ui.showDeathCard('SIGNAL LOST', sub, `${cam}  ·  LAST FRAME ${hh}:${mm}:${ss}  ·  FOOTAGE RECOVERED`);
  }

  // ------------------------------------------------------------------ menu
  /**
   * Title screen: a drone shot of a chase truck circling a mature tornado.
   * The storm is held in place and the tornado kept mature; the truck drives
   * a loop around it (placed directly, no physics) with its lights on.
   */
  private setupMenuScene(): void {
    const s = this.weather.storms.find((c) => c.tornadic) ?? this.weather.storms[0];
    if (!s) return;
    const target = new THREE.Vector3(250, 0, -350);
    s.vx = 0;
    s.vz = 0;
    s.intensity = 1;
    s.meso = 1;
    s.stage = 'tornadic';
    s.hasTornado = true;
    this.tornadoes.clear();
    const tor = this.tornadoes.spawn(s, { rating: 3, visibility: 0.95 });
    // Shift the storm so its tornado lands on open ground near the middle of the map.
    s.x += target.x - tor.position.x;
    s.z += target.z - tor.position.z;
    tor.phase = 'mature';
    tor.phaseTime = 0;
    tor.presence = 1;
    tor.debris = 1;
    tor.condensation = 1;
    tor.radius = tor.params.coreRadius;
    for (const o of this.weather.storms) if (o !== s) o.x += 40000;
    this.menuOrbit = Math.random() * Math.PI * 2;
    this.menuDroneAngle = this.menuOrbit + 2.2;
    this.headlightsOn = true;
    this.rig.setMode('drone');
  }

  private menuOrbit = 0;
  private menuDroneAngle = 0;
  private readonly menuCenter = new THREE.Vector3();

  /** The truck's loop around the tornado. */
  private menuDrive(dt: number): void {
    const t = this.tornadoes.tornado;
    if (!t) return;
    t.phaseTime = 0; // stays mature for as long as the menu is up
    const R = t.radius * 2.6 + 260;
    const speed = 16;
    this.menuOrbit += (dt * speed) / R;
    const a = this.menuOrbit;
    const x = t.position.x + Math.cos(a) * R;
    const z = t.position.z + Math.sin(a) * R;
    // Heading along the loop (counter-clockwise seen from above).
    const hx = -Math.sin(a), hz = Math.cos(a);
    this.vehicle.placeAt(x, z, Math.atan2(hx, -hz));
    this.vehicle.vel.set(hx * speed, 0, hz * speed);
    for (const w of this.vehicle.wheels) w.spinAngle += (speed / 0.445) * dt;
  }

  /**
   * The chase drone: hanging high outside the truck's loop and slowly swinging
   * around it, looking past the truck at the tornado — truck in the
   * foreground, the funnel looming behind it.
   */
  private menuDrone(dt: number): void {
    const t = this.tornadoes.tornado;
    const cam = this.rig.camera;
    const truck = this.vehicle.pos;
    const tp = t ? t.position : _w.copy(truck).add(_v.set(600, 0, 0));
    // Outward from the tornado through the truck, swung slowly side to side.
    this.menuDroneAngle += dt * 0.12;
    const out = Math.atan2(truck.z - tp.z, truck.x - tp.x) + Math.sin(this.menuDroneAngle * 0.35) * 0.45;
    const dist = 200, alt = 85 + Math.sin(this.time * 0.11) * 10;
    const target = _v.set(truck.x + Math.cos(out) * dist, 0, truck.z + Math.sin(out) * dist);
    target.y = Math.max(heightAt(target.x, target.z) + 40, truck.y + alt);
    if (this.menuCenter.lengthSq() === 0) this.menuCenter.copy(target);
    this.menuCenter.lerp(target, 1 - Math.exp(-dt * 1.5));
    cam.position.copy(this.menuCenter);
    cam.up.set(0, 1, 0);
    const look = _w.copy(truck).lerp(tp, 0.08);
    cam.lookAt(look.x, look.y + 45, look.z);
    // Frame the action right of centre, clear of the menu, with a touch of gimbal drift.
    cam.rotateY(0.3);
    cam.rotateZ(Math.sin(this.time * 0.07) * 0.015);
    cam.fov = 55;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
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
    const probes = this.probes.report();
    const net = footage + probes.value - probes.lost - repairs - fuel;
    c.money += net;
    c.totalEarned += footage + probes.value;
    c.bestClip = Math.max(c.bestClip, ...this.recorder.clips.map((cl) => cl.value), 0);
    if (this.recorder.clips.some((cl) => cl.tornadoSeconds > 3)) c.tornadoesFilmed++;
    const day = c.day;
    c.day++;
    this.career.save();
    this.ui.closePanel(false);
    this.ui.showReport({ clips: [...this.recorder.clips], footage, probes, repairs, fuel, net, balance: c.money, day, outcome });
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
    this.probes.update(playing ? sdt : 0);
    if (playing) this.keepTornadoInside(sdt);
    this.missiles.update(playing ? sdt : 0, this.tornadoes.tornado, this.vehicle.pos, playing && !this.onFoot);
    if (this.terminal.open && (!this.onFoot || this.walker.dead || this.state !== 'playing')) this.terminal.close();
    const L = this.weather.local;
    const t = this.tornadoes.tornado;

    // --- Vehicle.
    const drive: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: !this.onFoot ? false : true };
    if (playing && !this.onFoot) {
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
    if (this.state === 'menu') this.menuDrive(sdt);
    else if (!this.onFoot) this.trackTruckFlight();
    this.vehicle.writeTransform(this.vehicleObj);
    this.updateVehicleVisuals(sdt);

    // --- On foot.
    if (this.onFoot && playing) {
      // Setting a probe down roots the feet until it's on the ground.
      const rooted = this.body.busy || this.terminal.open;
      const fwd = rooted ? 0 : (inp.isDown('KeyW') ? 1 : 0) - (inp.isDown('KeyS') ? 1 : 0);
      const right = rooted ? 0 : (inp.isDown('KeyD') ? 1 : 0) - (inp.isDown('KeyA') ? 1 : 0);
      this.tornadoes.windAt(_v.copy(this.walker.pos).setY(this.walker.pos.y + 1), _w).add(L.wind);
      const yawCar = this.vehicle.heading;
      this.walker.car = { x: this.vehicle.pos.x, z: this.vehicle.pos.z, rot: -yawCar, hx: 1.0, hz: 2.55 };
      this.walker.update(sdt, { fwd, right, run: !this.probes.carrying && (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight')) }, this.rig.yaw, _w);
      this.keepInChaseArea(this.walker.pos, this.walker.vel);
      if (this.walker.caught) {
        if (this.walkerPeak === 0 && this.walker.caughtTime < 0.1) this.walkerFrom.copy(this.walker.pos);
        this.walkerPeak = Math.max(this.walkerPeak, this.walker.pos.y - heightAt(this.walker.pos.x, this.walker.pos.z), 0.001);
      }
    }
    // The chaser's body: animated from his speed and the wind; the bodycam rides its chest mount.
    const speedOnFoot = Math.hypot(this.walker.vel.x, this.walker.vel.z);
    this.body.update(sdt, this.onFoot && !this.walker.dead && !this.walker.caught, this.walker.pos, this.rig.torsoYaw, speedOnFoot, this.walker.strain, this.probes.carrying);
    if (this.onFoot && !this.walker.caught && this.body.chestCamPosition(_v)) {
      // Sit the lens just proud of the jacket; looking down, the wearer leans
      // forward over his feet so the jacket, legs and boots come into frame.
      const lean = this.probes.carrying ? 0 : THREE.MathUtils.clamp((-this.rig.torsoPitch - 0.5) / 0.8, 0, 1);
      this.walker.eye.copy(_v).add(new THREE.Vector3(-Math.sin(this.rig.torsoYaw), 0, -Math.cos(this.rig.torsoYaw)).multiplyScalar(0.06 + lean * 0.07));
      this.walker.eye.y -= lean * 0.05;
    }

    // --- Camera.
    this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 2.5);

    const shake = this.settings.data.cameraShake * (this.onFoot ? eff.handheldShake : 1);
    this.rig.update({
      dt, time: this.time, vehicleObj: this.vehicleObj, vehicle: this.vehicle,
      walker: this.onFoot
        ? {
            eye: this.walker.eye, bob: this.walker.bob, moving: this.walker.moving, animated: this.body.loaded,
            sway: this.body.chestSway(_qSway) ? _eSway.setFromQuaternion(_qSway, 'YXZ') : null,
            tumble: this.walker.caught ? this.walker.tumble : null,
          }
        : null,
      mouseDX: playing && !this.terminal.open ? inp.mouseDX : 0, mouseDY: playing && !this.terminal.open ? inp.mouseDY : 0, wheel: playing ? inp.wheel : 0,
      zoomHeld: inp.mouseRight, sensitivity: this.settings.data.mouseSensitivity, invertY: this.settings.data.invertY,
      shake: this.onFoot && eff.tripod && this.walker.stillTime > 1.5 ? shake * 0.1 : shake,
      fov: this.settings.data.fov, wind: this.windAtCam.length(), impulse: this.shakeImpulse,
      bodycamFov: this.settings.data.bodycamFov,
    });
    const cam = this.rig.camera;
    if (this.state === 'menu') this.menuDrone(dt);
    // Head torch rides just above the lens and points where the chaser looks.
    const lamp = this.onFoot && this.headlampOn && !this.walker.dead;
    this.headlamp.visible = lamp;
    if (lamp) {
      this.headlamp.intensity = 260;
      this.headlamp.position.copy(cam.position).y += 0.35;
      this.rig.forward(this.headlamp.target.position).multiplyScalar(12).add(cam.position);
      this.headlamp.target.updateMatrixWorld();
    }
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
    // Dread grade: builds from ~6 km out as the tornado nears, and under the storm's darkest cloud.
    const dread = t ? t.presence * (1 - clamp((tornadoDist - 400) / 5600, 0, 1)) : L.cover * 0.35;
    this.renderer.dread = damp(this.renderer.dread, clamp(dread, 0, 1), 0.6, dt);
    this.lighting.update(cam.position, L.cover, L.sunBlocked, L.rain, this.lightning.flash);
    const sky = this.renderer.sky;
    sky.setParams(this.lighting.sky);
    sky.setStorms(this.weather.storms, t ? { x: t.position.x, z: t.position.z, radius: t.radius, presence: Math.min(1, t.presence * 1.2) } : null);
    sky.setFlash(this.lightning.skyFlash.x, this.lightning.skyFlash.y, this.lightning.skyFlash.z, this.lightning.skyFlash.w);
    atmo.uFogDensity.value = 3 / L.visibility;
    atmo.uWetness.value = this.weather.wetness;
    atmo.uWind.value.set(this.windAtCam.x, this.windAtCam.z);
    this.windDebris.update(playing ? sdt : 0, cam.position, this.windAtCam);
    this.grass.update(cam.position, this.vehicleObj);
    this.truckDamage.update(this.vehicleObj);
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
      this.vehicle.damage(sdt * L.hail * 0.15);
      // Now and then a big stone chips the glass.
      if (!this.onFoot && L.hail > 0.5 && Math.random() < sdt * 0.04 * L.hail) this.windshield.impact(0.12 + Math.random() * 0.15);
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
    this.inVortexTime = Math.max(0, this.inVortexTime - dt);
    if (!t || t.presence < 0.3) return;
    const v = this.vehicle;
    const d = t.distanceTo(v.pos);
    const R = Math.max(25, t.radius);
    const severity = clamp((t.params.rating + 0.5) / 4, 0.2, 1.4) * t.presence * (1 - t.rope * 0.5);
    if (d < R * 1.7) {
      const inner = clamp(1 - (d - R * 0.6) / (R * 1.1), 0, 1);
      const lift = v.pos.y - CG_HEIGHT - heightAt(v.pos.x, v.pos.z);
      this.inVortexTime = 4;
      const windRel = Math.hypot(v.wind.x - v.vel.x, v.wind.z - v.vel.z);
      this.breakables.wind(dt, windRel, v.vel, v.wind);
      // Inside the vortex the flow carries the truck: it spins and drifts down
      // rather than dropping like a stone. Flung out, it falls freely.
      if (d < R * 1.6 && lift > 1.5 && v.vel.y < -10) v.vel.y = -10;
      // Hundreds of feet is plenty: near the top of the ride it stops climbing.
      if (lift > 140 && v.vel.y > 0) v.vel.y *= Math.max(0, 1 - dt * 3);
      v.damage(dt * 4 * severity * inner);
      this.shakeImpulse = Math.max(this.shakeImpulse, 0.4 + inner * 0.6);
      if (Math.random() < dt * 1.4 * severity * inner) {
        t.windAt(v.pos, _w);
        // Deep in the core the updraft can carry the truck hundreds of feet up.
        const up = lift > 150 ? 0 : inner > 0.5 ? (8 + Math.random() * 18) * severity : 4 + Math.random() * 7 * severity;
        const kick = new THREE.Vector3(_w.x * 0.22, up, _w.z * 0.22);
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
    // The probe programmer owns the keyboard while it's open.
    if (this.terminal.open) return;
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
    if (inp.wasPressed('KeyL')) {
      if (this.onFoot) {
        this.headlampOn = !this.headlampOn;
        this.ui.toast(this.headlampOn ? 'Head torch on' : 'Head torch off', 'info', 1500);
      } else this.headlightsOn = !this.headlightsOn;
    }
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
    // E works the liftgate and probes on foot; otherwise E/F are the door.
    const usedE = inp.wasPressed('KeyE') && this.onFoot && !this.walker.dead && !this.walker.caught && !this.body.busy &&
      this.probes.interact(this.walker.pos, this.rig.torsoYaw, this.body.carryPoint, (touchdown) => this.body.playPlace(touchdown));
    if (!usedE && (inp.wasPressed('KeyF') || inp.wasPressed('KeyE'))) this.toggleOnFoot(inp.wasPressed('KeyF'));
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
      this.probes.stowOnEntry();
      this.probes.closeGate();
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
      // Only the chaser's death ends the day; a wrecked truck limps on.
      if (this.onFoot && this.walker.dead) {
        this.endTimer = 6;
        this.endReason = 'Caught in the tornado';
        const ft = Math.round(this.walkerPeak * 3.281);
        const away = Math.hypot(this.walker.pos.x - this.walkerFrom.x, this.walker.pos.z - this.walkerFrom.z);
        this.showDeath(ft > 15
          ? `The vortex carried you ${ft} feet into the air. Your bodycam was found ${farText(away)} from where you stood.`
          : 'You were caught in the tornado. Your bodycam kept recording.');
      } else if (!this.onFoot && this.driverKilled) {
        this.endTimer = 6;
        this.endReason = 'Truck thrown by the tornado';
        this.audio.vehicleDestroyed();
        this.showDeath(this.deathText?.sub ?? 'The tornado threw your truck. The dashcam kept rolling.');
      }
      if (this.vehicle.destroyed && !this.wreckToasted) {
        this.wreckToasted = true;
        this.ui.toast('The truck is wrecked. It still runs, on reduced power.', 'alert', 7000);
      }
      if (this.weather.storms.length === 0 && this.dayTime > 60 && !this.calmToasted) {
        this.calmToasted = true;
        this.ui.toast('The storms have dissipated. Press Esc and end the chase to sell your footage and probe data.', 'info', 10000);
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
    a.engineRunning = this.vehicle.engineOn;
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
    a.siren = 0;
    if (tor) {
      a.tornado.position.copy(tor.position);
      a.tornado.distance = tor.distanceTo(cam.position);
      a.tornado.intensity = tor.intensity01;
      a.siren = Math.min(1, tor.presence * 1.5);
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
    // Kept deliberately bare: one arrow to the tornado (or the storm before it
    // forms), and the probe count. Everything else is in the radar and map.
    const dist = (m: number) => (imperial ? `${(m / 1609.34).toFixed(1)} MI` : `${(m / 1000).toFixed(1)} KM`);
    const objective: string[] = [];
    let pointer: HudState['pointer'] = null;
    const aim = t ?? this.radar.target() ?? this.weather.storms.find((s) => s.tornadic) ?? null;
    if (aim) {
      const ax = 'position' in aim ? aim.position.x : aim.x;
      const az = 'position' in aim ? aim.position.z : aim.z;
      this.rig.forward(_v);
      const rel = Math.atan2(ax - focus.x, -(az - focus.z)) - Math.atan2(_v.x, -_v.z);
      pointer = { angle: rel, label: `${t ? 'TORNADO' : 'STORM'}  ${dist(Math.hypot(ax - focus.x, az - focus.z))}` };
    }
    // The one thing to do next.
    const P = this.probes;
    const armed = P.deployed.filter((d) => d.armed).length;
    const unarmed = P.deployed.filter((d) => !d.armed && !d.lofted).length;
    if (t) this.tornadoSeen = true;
    let goal = '';
    if (!t && !this.tornadoSeen) goal = 'Head toward the storm. The tornado is about to form.';
    else if (!t) goal = 'The tornado has lifted. Esc → End chase to sell your data.';
    else if (P.carrying) goal = "Set the probe down in the tornado's path (E)";
    else if (unarmed > 0) goal = 'Program the probe you set down (E at the probe)';
    else if (P.available && P.inTruck > 0 && P.deployed.length < 4) {
      const ahead = t.distanceTo(focus) < 1600;
      if (!ahead) goal = 'Get ahead of the tornado';
      else if (!this.onFoot) goal = 'Stop in its path and get out (F)';
      else goal = 'Grab a probe from the back of the truck (E at the liftgate)';
    } else goal = 'Film the tornado (Q) and stay alive';
    if (this.onFoot && this.walker.caught) goal = '';
    if (P.available) objective.push(`PROBES  ${armed}/4 ARMED${unarmed ? `  ·  ${unarmed} NOT PROGRAMMED` : ''}`);
    if (v.destroyed) objective.push('TRUCK WRECKED');
    const warning = '';

    let prompt = '';
    if (!this.onFoot && v.speed < 1) prompt = 'F  GET OUT';
    if (this.onFoot) {
      const d = this.doorWorld(new THREE.Vector3());
      if (Math.hypot(d.x - this.walker.pos.x, d.z - this.walker.pos.z) < 3.5) prompt = 'F  GET IN';
      if (!this.body.busy) prompt = this.probes.prompt(this.walker.pos) || prompt;
      if (this.terminal.open) prompt = '';
    }
    let center = '';
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
      pointer,
      goal,
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
      const tor = this.tornadoes.tornado;
      this.radar.draw(ctx, this.ui.radarCanvas.width, view, (s) => this.clock(s), tor && tor.presence > 0.2 ? { x: tor.position.x, z: tor.position.z } : null);
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
    // Instruments are backlit whenever the engine runs.
    p.dashDisplay?.update(mph, v.gearLabel);
    if (p.gauges) p.gauges.update(mph, v.rpm, v.engineOn);
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
    // No cabin flood light: it lit the whole dash blue whenever the headlights were on.
    p.dashLight.visible = false;
    p.gaugeMat.emissiveIntensity = 0.06 + hl * 0.5;
    p.taillightMat.emissiveIntensity = 0.4 + (this.input.isDown('KeyS') && !this.onFoot ? 3 : 0) + hl;
    p.anemometer.rotation.y += dt * Math.min(40, this.windAtCam.length() * 1.6 + v.speed * 1.2);
  }
}

/**
 * Where a chase day starts: sometimes the gas station, usually a random spot
 * on one of the section roads inside the chase area, in the right-hand lane.
 */
function randomStart(station: { x: number; z: number; heading: number }): { x: number; z: number; heading: number } {
  if (Math.random() < 0.2) return station;
  const lim = MAP_HALF - 250;
  const roads = [-1, 0, 1].filter((k) => Math.abs(k * MILE) <= MAP_HALF);
  const k = roads[Math.floor(Math.random() * roads.length)] * MILE;
  // Keep clear of the crossroads themselves.
  let along = (Math.random() * 2 - 1) * lim;
  if (Math.abs(along - Math.round(along / MILE) * MILE) < 60) along += 120;
  const dir = Math.random() < 0.5 ? 1 : -1;
  if (Math.random() < 0.5) {
    // North–south road: heading 0 = north (-z); the right lane is east of the centreline going north.
    return { x: k + 2.2 * dir, z: along, heading: dir > 0 ? 0 : Math.PI };
  }
  // East–west road: heading π/2 = east; the right lane is south (+z) going east.
  return { x: along, z: k + 2.2 * dir, heading: dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
}

function compassWord(dx: number, dz: number): string {
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return names[Math.round(deg / 45) % 8];
}

/** A distance in feet under a quarter mile, otherwise in miles. */
function farText(m: number): string {
  const ft = m * 3.281;
  return ft < 1300 ? `${Math.round(ft / 10) * 10} feet` : `${(m / 1609.34).toFixed(1)} miles`;
}
