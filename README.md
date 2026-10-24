# STORMCAM

**[▶ Play in your browser](https://beeem33.github.io/STORMCAM-play/)**: Chrome or Edge on a desktop or laptop, keyboard and mouse.

A first-person storm-chasing game that should look like real dashcam footage.
Drive the section roads of central Kansas, read the radar, get into position
in front of a supercell, film the tornado and get out alive. You get paid for
footage that's actually usable, not just for driving close.

> **Prototype.** The first playable milestone is in place: one rural map, one
> drivable SUV, driver and dashcam cameras, rain, lightning, one volumetric
> tornado, recording and scoring, radar, and menus. See
> [`docs/STATUS.md`](docs/STATUS.md) for what is done and what isn't.

## Run it

```bash
npm install
npm run dev        # http://localhost:8191 (also on your LAN)
npm run build      # type-check + production build into dist/
```

Pushing to `main` publishes the game: a GitHub Actions workflow
(`.github/workflows/deploy.yml`) builds it and deploys `dist/` to GitHub Pages
at the play link above.

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
| 1 / 2 / 3 or mouse wheel | Pick an item: camcorder, radar tablet, flashlight (press again to put it away) |
| Left click | Use the item: start/stop filming, flashlight on/off |
| C | Switch camera: driver ↔ dashcam |
| F | Get out of / back into the vehicle |
| E | At the liftgate: open it, take or return a probe. On foot: set a probe down, program it (type the answers on the keypad), or pick it up |
| R | Weather radar (1–4 picks a target cell) |
| X | Wipers (start off): cycle auto / off / low / high |
| L | Headlights (in the truck) / head torch (on foot) |
| T | Dashcam timestamp overlay |
| Right mouse (hold) | Zoom (bodycam) |
| Shift | Run (on foot) |
| Z | Tornado close, on grass: get flat and hold on. If a hand tears loose, aim at a glowing patch of grass and click before time runs out. Z again to get up once the wind drops |
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
  gameplay/     Footage recorder and scoring, radar, career, upgrades
  audio/        Procedural Web Audio (wind, rain, hail, thunder, tornado, engine, tyres), menu music
  ui/           Menus, HUD, report, garage
  dev/          Console dev tools, audio test page
docs/           Architecture and status notes
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains how the systems fit
together and how to extend them.

## Credits

Made by Beem Studio.

- Menu music: "I Needed A Human Body" by Fuzzeke (`public/audio/menu-theme.mp3`).
