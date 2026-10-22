# Status

What exists in the code today, and what doesn't. Updated with each milestone.

## Milestone 1: first playable (current)

### Done
- **Project:** Three.js + TypeScript + Vite, modular folders, dev tools, docs.
- **Map:** a 4 × 4-mile chase area of section roads around the gas station:
  two paved highways crossing at the station, gravel roads on the other
  section lines. It has ditches, rolling terrain and five field types
  (wheat, pasture, plowed, row crop, prairie). ROAD CLOSED barricades sit
  at the edge, and scenery continues one mile beyond it. Asphalt, paint,
  gravel ruts, crop rows and wet puddles are all procedural.
- **Props:** deterministic per section.
  - Farmsteads: house, barn, grain bins, silo, machine shed, mailbox,
    windbreaks.
  - About 10,000 trees: hedgerows, three wooded creeks, lone cottonwoods,
    shrubs. Trees use LODs, are culled one by one, and have leaf-clump
    foliage shading.
  - The crossroads town of Cedar Flats: grain elevator, water tower, church,
    houses.
  - Windmills that turn with the wind, nodding oil pumpjacks, rotating
    center-pivot sprinklers.
  - Billboards, hay stacks, abandoned trucks, stock tanks, round bales.
  - Telephone poles with sagging wires, barbed-wire fences, road signs.
- **Vehicle:** raycast suspension on the terrain function, slip-based tyre
  grip that varies by surface and wetness, a 4-speed automatic with reverse,
  handbrake slides, aerodynamic drag, crosswind and tornado wind forces,
  rollovers, collisions with buildings, trees and poles, and damage.
- **Chase SUV model:** a lifted, matte-black full-size SUV with brush guard,
  LED light bars, roof basket and instruments, mud-terrain tyres and fender
  flares (`public/models/chaser.glb`, built in Blender by
  `models/chaser_build.py` outside this repo; `ChaserModel.ts` loads it and
  falls back to the old procedural SUV if it's missing). Lightning-bolt
  "STORMCAM" side graphics are projected onto the paint, and a soft contact
  shadow keeps it on the ground.
- **Interior:** modelled dash, gauges, steering wheel that turns, A-pillars,
  mirror, seats, door cards, the hood seen through the glass, wipers.
- **Cameras:**
  - Driver: head inertia, road vibration, free look.
  - Dashcam: wide lens with barrel distortion, heavier noise, GPS/time OSD.
  - Bodycam on foot: 90° fisheye lens. The torso follows the mouse through
    a spring, so looks overshoot and sway. Footfall jolts, wind buffeting,
    timestamp OSD. The lens rides the chest of a rigged, animated body
    (`public/models/chaser_person.glb`, built in Blender by
    `models/chaser_person_build.py` outside this repo), so the walk and run
    cycles move the shot. Looking down shows the jacket, legs, boots and
    hands; the head is hidden. The model is still a draft export.
  - All shake is scaled by a setting.
- **Camera sensor post-processing:** auto exposure that lags (lightning blows
  out), filmic tone curve, sharpening, sensor noise that grows in the
  shadows, vignette, chromatic fringe, motion blur reconstructed from depth
  (the car interior is excluded), and refraction through windshield water.
- **Weather:** 2–3 supercells per day that drift north-east and evolve from
  developing to mature to tornadic to dissipating. Coverage, rain, hail,
  wind, visibility and wetness are sampled locally. Rain and hail streak
  relative to the camera's motion.
- **Windshield:** droplets bead, stream upward at speed, and are cleared by
  the wiper blades. Wipers run auto, low, high or off. The glass is dirty
  and scatters light, and hail cracks it.
- **Lightning:** in-cloud flashes light the cloud volume, and
  cloud-to-ground strokes have branching channels and several return
  strokes. Thunder is delayed by distance.
- **Sky:** a raymarched storm with a lowered rotating wall cloud, stacked
  striations, rain curtains, an anvil, and aerial perspective shared with
  every material.
- **Tornado:** one volumetric tornado with forming, mature, rope-out and
  dissipating phases. It leans and snakes as it ropes out, has a debris skirt
  and orbiting debris, and its wind field pushes the car, the debris and the
  player.
- **Destruction:** buildings come apart piece by piece and leave their
  foundation. Trees are stripped, poles snap and drop their wires, fences go
  down, and bales get thrown.
- **Gameplay:** recording (Q) with live quality grading and an explanation
  of what's wrong with the shot, event bonuses, and diminishing returns.
  The end-of-day report sells the footage and subtracts repairs and fuel.
  Money, days and owned equipment persist.
- **Radar:** stale reflectivity scans with hook echoes, storm tracks, a
  warning polygon, and target selection.
- **GPS:** a road map with a grid route to the target, plus distance and
  bearing in the HUD.
- **On foot:** get out (F), walk or run, wind pushes you, and you can be
  killed in the core.
- **Audio:** fully procedural, with inside/outside muffling and spatial
  panning.
- **UI:** main menu, settings (graphics, camera, controls, audio, units),
  controls, pause, report, garage.

### Unfinished or simplified
- **SUV model:** the current export is a draft (about 200k triangles, over
  budget, paint still blue-grey). The modeller is cutting it to 80k and
  switching to matte black. Cabin trim is brightened 2.5× in the loader
  because there's no bounce light inside the car.
- **Windshield droplets:** shading is basic. They refract and darken, with
  a faint rim highlight.
- **Trees:** solid noisy crowns. They read well from 20 m out but look smooth
  up close.
- **Upgrades:** all are purchasable and most have an effect. The armor's
  added weight isn't simulated.
- **Damage visuals:** the windshield cracks, but the body doesn't dent and
  windows don't shatter.
- **No traffic, other chasers, or driver hands/arms** in the driver view.
- **Video:** recording produces metadata and a score, not real video files.
- **One tornado at a time:** no multi-vortex or wedge-specific visuals yet.
- **Rain-wrapped tornadoes** are only partly modelled (through the
  visibility parameter).
- **Fences** don't block the car.
- **Farm driveways:** farms have none (they're set back from the road on
  natural terrain).
- **Gas station:** the start point only; no fuel or shop interaction yet.
  The garage is in the menu and report screens.
- **Mobile:** no touch controls. The game targets desktop browsers.
- **Audio:** levels were measured offline, not tuned by ear.
- **Performance:** tuned for an Apple M4 laptop.
  - Adaptive resolution steps the render scale down when frames run long and
    back up when there's headroom.
  - The storm fields are baked to a texture once per frame for the sky
    raymarch.
  - Static buildings are merged per material; trees are batched with
    per-instance culling and LODs.
  - The canvas renders at the internal resolution, not full Retina.
