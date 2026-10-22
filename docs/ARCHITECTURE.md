# Architecture

## Frame order

`core/Game.ts` owns every system and calls them in a fixed order each frame:

1. **Input**: key edges (record, camera, radar…).
2. **Weather** (`weather/WeatherSystem.ts`): moves the storm cells and steps
   their life cycles, then samples local rain, hail, wind, cover and
   visibility at the player. It can trigger tornadogenesis.
3. **Tornado** (`tornado/TornadoSystem.ts`): life cycle, track and wind field,
   plus debris integration.
4. **Vehicle** (`vehicle/Vehicle.ts`) or **walker** (`player/Walker.ts`):
   physics against the terrain, the colliders and the wind.
5. **Camera rig** (`camera/CameraRig.ts`): driver, dashcam or handheld pose,
   shake, and lens profile.
6. **World props** (`environment/WorldProps.ts`): streaming around the camera
   and tornado destruction.
7. **Lighting and atmosphere**: the sky shader and fog get their parameters
   from the weather.
8. **Precipitation, windshield, recording, radar.**
9. **Audio**: one `AudioFrameState` per frame.
10. **Render**, then the **HUD**.

## Rendering pipeline (`rendering/`)

```
CloudSky (low-res raymarch) ──► sky texture ─┬─► sky dome in scene
                                             └─► fog colour for every material
Scene (HDR + depth) ──► Glass pass (windshield water + "attached to car" mask)
                    ──► Sensor post: barrel lens → refraction through water →
                        motion blur from depth → auto exposure → filmic tone →
                        sharpening → sensor noise → vignette → screen
```

- **Aerial perspective** (`Atmosphere.ts`): patched materials fade toward the
  sky colour *behind them*, sampled from the sky texture at the same screen
  position. Distant farms dissolve into the exact rain curtain or horizon
  behind them. Custom shaders use `SKYFOG_GLSL` to get the same fog.
- **The sky** (`CloudSky.ts`) raymarches the storm volume in world space: a
  base that lowers into a rotating wall cloud with striations, rain/hail
  curtains under the core, an anvil layer, and lightning that lights the
  volume from inside. A second material reuses the shader to capture a
  reflection cube for wet roads.
- **Auto exposure** reads back a 32×18 log-luminance image asynchronously.
  The camera brightens slowly and darkens fast, so lightning blows out
  before it adapts.

## World (`environment/`)

`WorldShape.ts` defines the terrain height, the one-mile road grid, ditches,
field types and the gas-station lot. It is written **twice, in TypeScript and
GLSL, and the two must stay identical**. Integer hashing keeps the noise
bit-exact on both sides. The GPU displaces a camera-centred grid with
exponential vertex spacing (`Terrain.ts`), and the fragment shader paints
asphalt, lane paint, gravel ruts, ditch grass, crop rows and puddles
procedurally. There are no road meshes.

`WorldProps.ts` places farmsteads, hedgerows, bales, poles and fences
deterministically per section, and streams them within about 3 sections of
the camera. It records what the tornado destroyed, so a ruined farm stays
ruined.

## Weather and tornado

- `StormModel.ts` is the footprint of a classic supercell in storm-relative
  coordinates: base coverage, forward-flank core, hook echo, hail, inflow and
  outflow winds, and radar reflectivity. The sky shader has a GLSL twin.
- `Tornado.ts` exposes every parameter the brief asks for (`TornadoParams`):
  rating, core and top radius, height, rotation, maximum wind, debris,
  visibility and lifetime. It runs the phases forming → mature → rope →
  dissipating. `windAt()` is a Rankine-like vortex with inflow, updraft and
  translation, and the car, debris, walker, props and audio all use it.
- `TornadoRenderer.ts` raymarches the funnel and the debris skirt inside a
  box around the leaning axis. Step sizes follow the distance to the funnel,
  so a 20 m rope and a 600 m wedge both render cleanly.

## Gameplay

- `FootageRecorder.ts` grades every recorded frame. Is the tornado in frame,
  and how big? How clear is it through the rain and haze? Which window is the
  camera looking through? How steady is the shot? Events add bonuses:
  tornadogenesis, close intercept, rope-out, lightning in frame, structures
  destroyed in frame. Per-second value diminishes over a chase.
- `Radar.ts` is a stale, coarse reflectivity scan (60 s, or 30 s with the
  upgrade). It shows storm tracks and a warning polygon, never the tornado's
  exact position.
- `Career.ts` and `Upgrades.ts` hold money, days and equipment. Systems read
  multipliers from `UpgradeEffects`, so a new item is a data entry plus,
  optionally, one line where its effect applies.

## Extending

- **New storm type or behaviour:** extend `StormCell` and the stage machine in
  `WeatherSystem.update`.
- **New tornado type** (wedge, multi-vortex): add parameters to
  `TornadoParams` and branches in `TornadoRenderer`'s `field()`.
- **New prop:** write a builder in `environment/props/` that returns a
  `PropBuild`, then place it in `WorldProps.buildSection`.
- **New camera mode:** add a `LensProfile` to `LENSES` and a branch in
  `CameraRig.update`.
