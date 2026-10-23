# Status

What exists in the code today, and what doesn't. Updated with each milestone.

## Milestone 1: first playable (current)

### Done
- **Project:** Three.js + TypeScript + Vite, modular folders, dev tools, docs.
- **Map:** a 2 × 2-mile chase area of section roads around the gas station:
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
- **Main menu:** a drone shot. A mature EF3 is staged near the middle of the
  map and a chase truck circles it with its lights on, while a stabilised
  drone camera hangs ~85 m up beside the truck, slowly swinging around it,
  with the tornado looming behind (framed right of the menu).
- **Objectives:** one line under the tornado arrow always says what to do
  next: head for the storm, get ahead of the tornado, grab a probe, set it
  down, program it, then film and survive, then cash in.
- **Probe programming:** a placed probe starts unarmed (steady red LED) and
  logs nothing. E at the probe opens its field programmer: three quick
  calibration checks (add, subtract, multiply or divide) typed on the keypad.
  Wrong answers get a new code. The world keeps running while you type.
  Armed probes blink green and log data.
- **Head torch:** L on foot toggles a head-mounted spotlight.
- **Random days:** the player starts at a random spot on the section roads
  (sometimes the gas station), and the storms come from a random direction
  with the tornadic storm placed randomly upstream.
- **Grass:** ~70k wind-blown blades around the camera (half packed into a
  dense 16 m patch underfoot), by field type (tall
  wheat and prairie, short pasture, sparse young crops, bare plowed ground,
  shaggy verges along the roads), flattened under the truck.
- **Storm menace:** near a tornado the image darkens and shifts to a sickly
  green-grey with a tighter vignette; tornadic storms flash and strike about
  2.6x more often; outdoor warning sirens wail in the distance while a
  tornado is down.
- **Sensor probes:** four orange "turtle" probes ride in a tote in the cargo
  area. On foot, E at the back of the truck opens the liftgate and takes a
  probe; the chaser carries it in both hands (no sprinting) and E sets it
  down with a crouch animation. E next to a placed probe picks it back up.
  Each probe logs the tornado's closest approach and peak wind; when the
  core passes over one, it's torn off the ground and thrown with the debris
  (an intercept). The day report sells the data: up to about $4,000 for a
  near miss within 500 m of the vortex edge, more for an intercept and for
  stronger tornadoes. Each lost probe costs $250 to replace.
- **Caught on foot:** past ~50 m/s wind or ~22 m/s updraft the chaser is
  picked up and carried by the vortex's wind field, tumbling (the camera
  spins with him), for up to ~7 s before it kills him, or sooner if he's
  slammed into the ground.
- **Flying missiles:** within ~3 vortex-widths the air fills with junk flung
  across the truck's path from upwind (boards, roofing sheets, fence posts,
  oil drums, limbs, now and then a round bale), more the closer you are.
  Hits dent the truck where they land, shove it (heavy ones can roll it) and
  crack the windshield if they strike the front.
- **Windshield:** cracks only when something hits it (a localised star crack
  sized by the hit; a big one shatters it into a crazed web); occasional
  hail chips in heavy hail; clean glass every new day.
- **Parts tear off:** doors, hood (an engine bay shows underneath), brush
  guard, roof rack (with the anemometer), bumpers and fender flares each
  take a few hits before ripping away and flying on the wind; violent core
  winds strip them too. Bolted back on each day.
- **Tornado stays reachable:** near the edge of the chase area its storm
  turns back toward the middle, and it's never carried more than ~80 m past
  the edge roads.
- **Truck damage:** every hard landing or crash dents the panels where it
  hit and scrapes the paint through to primer and bare metal (up to 14
  dents; nearby hits deepen a dent).
- **Rain:** light rain anywhere under thick cloud, heavier in the core; up to
  32k streaks and more windshield drops.
- **Ending a day:** only the chaser's death ends it: caught on foot, or, in
  the truck, a violent impact while caught by the tornado (slammed down at
  over 22 m/s or into an object at over 18 m/s within 4 s of being in the
  core). Inside the core the tornado can carry the truck up to ~140 m
  (hundreds of feet); coming back down from above ~35 m is fatal, and a
  black "SIGNAL LOST" card says how high and how far it was thrown before
  the report. Landings and collisions count once per impact (not per contact
  point), so jumps and rollovers do modest damage. Being sucked up is survivable: inside the vortex the truck is
  carried no higher than about 20 m and drifts down at most 10 m/s. A rolled truck is rocked back
  onto its wheels after 3 s; at 0% health it's wrecked but keeps about 70%
  of its power. When the storms die out, a message says to end the
  chase from the pause menu to get paid.
- **Wind:** tree crowns lean downwind, pump with the gusts and flutter
  (stronger near the tornado); above ~13 mph leaves, straw, grass and twigs
  start streaming past the camera, up to 900 pieces at ~80 mph.
- **Interior:** the gauges are backlit while the engine runs, and an LED
  speed readout sits on the dash right of the wheel. Headlights light only
  the road (the old cabin flood light is gone).
- **HUD:** deliberately bare: REC and clip time, speed, one red arrow
  pointing at the tornado (or the storm before it forms) with its distance,
  and the probe count. The radar draws a bold arrow on each storm showing
  where it will be in 20 minutes (red once it's tornadic), and the live
  tornado as a red dot with spinning arms and a pulsing ring.
- **Tornado chaos:** a dark, dense condensation funnel (about 60% of the
  damaging-wind width, flaring into the wall cloud) that reaches the ground,
  sways along its length and wanders up to ~6 m/s on top of the storm's
  motion; it carries through haze at half the normal fog so it reads from a
  few kilometres. A churning brown debris cloud about two funnel-widths
  across sits at its base. Up to 4,000
  debris fragments are ripped up and lofted; tree crowns are torn off and
  thrown, the strongest winds uproot whole trees, and telephone poles snap
  and fly (up to 160 large thrown objects at once).
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
  - Landmarks (several draw calls each) are skipped past ~1.8 km and
    farmsteads past ~2.8 km; the terrain grid is 340² (was 440²); foliage
    only uses its ragged, alpha-tested edges within ~220 m. That took a busy
    frame from ~470 draw calls / 1.5M triangles to ~250 / 0.95M.
