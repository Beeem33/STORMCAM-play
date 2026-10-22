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
- **Sensor probes:** four orange "turtle" probes ride in a tote in the cargo
  area. On foot, E at the back of the truck opens the liftgate and takes a
  probe; the chaser carries it in both hands (no sprinting) and E sets it
  down with a crouch animation. E next to a placed probe picks it back up.
  Each probe logs the tornado's closest approach and peak wind; when the
  core passes over one, it's torn off the ground and thrown with the debris
  (an intercept). The day report sells the data: up to about $4,000 for a
  near miss within 500 m of the vortex edge, more for an intercept and for
  stronger tornadoes. Each lost probe costs $250 to replace.
- **Ending a day:** only the chaser's death ends it: caught on foot, or
  carried up by the vortex inside the truck. A rolled truck is rocked back
  onto its wheels after 3 s; at 0% health it's wrecked but limps on at about
  a third of its power. When the storms die out, a message says to end the
  chase from the pause menu to get paid.
- **Day pacing:** the day's main storm starts mature about 3 km upstream on a
  track that crosses the start area, and drops its tornado about 10 s in.
  Tornadoes form over 30 s and stay mature for 7–12 minutes.
- **Vehicle:** raycast suspension on the terrain function, slip-based tyre
  grip that varies by surface and wetness, a 4-speed automatic with reverse
  (tuned 6.2 L: 0–60 mph in about 7.5 s on asphalt, about 70 mph on grass),
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
  mirror, seats, door cards, the hood seen through the glass. Wipers have a
  stamped arm and a beam blade that trails the arm and flips at each
  reversal; low is about 45 wipes a minute, high about 65.
- **Liftgate:** opens on its top hinge to reach the probe tote.
- **Cameras:**
  - Driver: head inertia, road vibration, free look.
  - Dashcam: wide lens with barrel distortion, heavier noise, GPS/time OSD.
  - Bodycam on foot: 90° fisheye lens. The torso follows the mouse through
    a spring, so looks overshoot and sway. Wind buffeting, timestamp OSD.
    The lens rides the chest of a rigged, animated body
    (`public/models/chaser_person.glb`, built in Blender by
    `models/chaser_person_build.py` outside this repo): the camera takes the
    chest mount's real lean and roll from each stride, so walking and
    running move the shot in step with the feet. Arm swing is kept low so
    the hands stay out of frame unless you look down or carry a probe.
    Looking down shows the jacket, legs, boots and hands; the head is
    hidden.
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
- **SUV model:** about 79k triangles. Cabin trim is brightened 2.5× in the
  loader because there's no bounce light inside the car, and the body shell
  is drawn double-sided so the A-pillars are solid from inside. Brake
  calipers don't steer with the front wheels; tail lamps are painted zones,
  not separate lenses; the interior has no seatbelts.
- **Player body:** about 44k triangles. Looking down from the true chest-lens
  position shows only boot toes, so the lens leans forward over the feet as
  you look down. Clothing is skinned, not simulated; the head is simplified
  because it's hidden in first person.
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
- **Performance:** tuned for an Apple M4 laptop. With a tornado on screen,
  a GPU-synced frame takes about 17–21 ms at 1620×1013 internal resolution
  (first prototype: about 50 ms at 1836×1148).
  - Adaptive resolution steps the render scale down when frames run long and
    back up when there's headroom.
  - The storm fields are baked to a texture once per frame for the sky
    raymarch.
  - Static buildings are merged per material; trees are batched with
    per-instance culling and LODs.
  - The canvas renders at the internal resolution, not full Retina.
