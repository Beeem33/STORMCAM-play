# STORMCAM

A first-person storm-chasing game that should look like real dashcam footage.
Drive the section roads of central Kansas, read the radar, get into position
in front of a supercell, film the tornado and get out alive. You get paid for
footage that's actually usable, not just for driving close.

> **Prototype.** The first playable milestone is in place: one rural map, one
> drivable SUV, driver and dashcam cameras, rain, lightning, one volumetric
> tornado, recording and scoring, radar and GPS, and menus. See
> [`docs/STATUS.md`](docs/STATUS.md) for what is done and what isn't.

## Run it

```bash
npm install
npm run dev        # http://localhost:8191 (also on your LAN)
npm run build      # type-check + production build into dist/
```

Any static file server can host `dist/` (it uses relative paths). Chrome or
Edge on a desktop/laptop GPU is the target. The game uses pointer lock, so
click the view to capture the mouse.

Dev URL flags: `?mute` silences audio. In dev builds `window.dev` has
helpers (`dev.tornadoView(distance, rating)`, `dev.step(frames)`,
`dev.strike()`), and `window.game` exposes every system.

## Controls

| Input | Action |
|---|---|
| W / S | Accelerate / brake (reverse when stopped) |
| A / D | Steer |
| Space | Handbrake |
| Mouse | Look around (driver and on foot) |
| Q | Start / stop recording |
| C | Switch camera: driver ↔ dashcam |
| F | Get out of / back into the vehicle |
| E | Interact (currently: same as F at the door) |
| R | Weather radar (1–4 picks a target cell) |
| M | GPS map with route to the target |
| X | Wipers: auto / off / low / high |
| L | Headlights |
| T | Dashcam timestamp overlay |
| Mouse wheel / right mouse | Zoom (bodycam) |
| Shift | Run (on foot) |
| Esc | Pause |

## Why not Unreal Engine 5?

The brief prefers UE5 with Blueprints. It isn't installed on the development
Mac, and UE5 content (Blueprints, maps, materials) is stored as binary
`.uasset`/`.umap` files that can't be written or reviewed as text, or tested
from an automated session. STORMCAM is built with **Three.js + TypeScript +
Vite** instead:

- it runs in a browser, so anyone on the network can play a build;
- every system is plain, reviewable text, organised the same way a UE
  project would be (vehicle, weather, tornado, camera, audio, UI, gameplay);
- the core techniques carry over to an Unreal port: raymarched clouds and
  tornado, a sky-coloured aerial perspective, raycast-wheel vehicle physics,
  and a camera-sensor post chain.

## Project layout

```
src/
  core/         Game loop and state machine, input, settings
  rendering/    Renderer pipeline, raymarched sky, sensor post-processing, shared atmosphere
  environment/  World shape (terrain/roads, TS + GLSL), terrain shader, props streaming, colliders, lighting
    props/      Procedural farm buildings, gas station, poles, fences, trees, bales
  vehicle/      SUV model, vehicle physics, windshield water and wipers
  weather/      Storm model, weather simulation, rain/hail particles, lightning
  tornado/      Tornado life cycle and wind field, volume renderer, debris
  camera/       Driver / dashcam / handheld rigs and lens profiles
  player/       On-foot movement
  gameplay/     Footage recorder and scoring, radar, GPS, career, upgrades
  audio/        Procedural Web Audio (wind, rain, hail, thunder, tornado, engine, tyres)
  ui/           Menus, HUD, report, garage
  dev/          Console dev tools, audio test page
docs/           Architecture and status notes
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains how the systems fit
together and how to extend them.
