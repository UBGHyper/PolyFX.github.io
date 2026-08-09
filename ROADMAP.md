# PolyFX Roadmap — "CSP / Pure, but for PolyTrack"

**Vision:** a weather + lighting system with customizable conditions (time of day,
cloud cover, rain, fog), realistic wet surfaces, and working car lights — the
PolyTrack analog of Assetto Corsa's **Custom Shaders Patch + Pure/Sol**.

## Where we are (PolyFX v1.0.0)
- Post-processing pipeline on three.js r181: Neutral tone-map (ACES/AgX/None
  also available live), sky-refreshed IBL, N8AO, bloom, volumetric god-rays,
  SSR (Photoreal), cinematic grade, SMAA.
- 6 presets: Off / Very Low / Balanced / Enhanced / Semi-Real / Photoreal.
- Real headlights + brake/tail lights, and underglow (emissive strip + road
  glow), sharing one car-discovery pass via `car_anchor.js`.
- Software-rasterizer capability gate + an adaptive perf guard (AO -> SSR ->
  god rays -> bloom -> bypass, with recovery) — Phase 1's items below, done.
- A live in-mod tuning panel (backtick key) exposing every parameter, and
  `tools/shotbench` for before/after screenshot + frame-time comparison.
- Single `src/` tree, bundled by esbuild into one self-contained file per
  target (`dist/PolyFX` / `app_src/mod`); zero remaining relative imports.
  Two small bundle seams (`src/main.mod.js`); game runs 100% stock if the
  mod is absent or the preset is Off — `npm test` asserts this directly.
- See `PLAN.md` for the current architecture in detail.

## Guiding principles
1. Everything tiered + individually toggleable; never regress low-end.
2. A single **WeatherState** object is the source of truth — it drives sky, fog,
   grade, rain, and lights together so conditions stay coherent.
3. Keep bundle edits tiny and documented; all logic lives in mod modules.

---

## Phase 1 — Control & tuning foundation — **done**
- ~~Granular per-effect toggles~~ — done, via the tuning panel (every effect + parameter).
- ~~Live tuning overlay~~ — done (backtick key).
- ~~FPS-adaptive perf guard~~ — done (`PerfGuard` in `src/runtime.js`), but its
  34ms-degrade/16ms-recover thresholds have only been validated under software
  rendering — real-hardware retuning is still open, see "Open work" below.
- **Auto-exposure** — not done. Still relevant once Phase 2/3 land (varied
  time-of-day + weather brightness needs it more than the current fixed
  presets do).
- New seams: none.

## Phase 2 — Dynamic sky & clouds *(the "Pure" core)* — **mostly done**
- ~~Shader sky dome (Preetham-style scattering)~~ — done, `src/sky.js`'s `SkySystem`.
- ~~Time of day~~ — done: a `TimeOfDay` setting, 7 named times + Default.
  Rebuilds the IBL env map from the sky on change.
- ~~Moon + stars at night~~ — done.
- **Still open:** the sky dome and clouds only engage once a time of day is
  *explicitly* chosen (`envOnly` mode is the default — see PLAN.md §1) —
  activating them unconditionally regressed the look (hazier than stock).
  A real auto day-night *cycle* (time advancing on its own) was never built.
- **Better clouds** — still the flat procedural fbm layer, not upgraded to
  billboards/raymarch.
- New seams: none needed beyond what's already there.

## Phase 3 — Weather system & rain *(the headline feature)* — **built, but disabled**
`src/weather_engine.js` (436 lines) already implements everything below —
`WeatherState` profiles (Clear through Storm), lens droplets, instanced rain,
wet-road material shader injection, fog, lightning — but
`WEATHER_ENABLED = false` in `src/runtime.js` and it is **not safe to just flip
it on**. `_applySky` does `light.intensity *= lightScale` and
`u.rayleigh.value *= (1 - skyWash * 0.22)` every frame with no stored base to
reset from — intensities decay geometrically toward zero. It only ever
appeared stable because `SkySystem`'s full-atmosphere path rewrote light
colors/intensities absolutely every frame *before* weather's multiply ran, and
`envOnly` mode (the default now for Enhanced+ on "Default" time of day — see
PLAN.md) doesn't do that rewrite. Reviving this phase means, in order:
1. Fix `_applySky` to multiply from a stored base intensity, not the live
   (already-multiplied) one — same fix for the rayleigh/turbidity mutations
   just above it.
2. Fold `SurfaceRegistry.update`'s unthrottled per-frame `scene.traverse`
   (wet-road material discovery) into the shared scan in `runtime.js`
   (`_sharedScan`) rather than adding a fourth independent traversal.
3. Add a `Weather` PML setting and wire `_applyWeatherPreset`.
4. Only then set `WEATHER_ENABLED = true` and validate against real driving,
   not just a stationary start-line screenshot — rain/wetness accumulate over
   time, which the shotbench doesn't currently exercise (see Track B, "drive
   -N-frames" below).
- New seams: none needed — road material and fog are already reachable.

## Phase 4 — Lights & effects *(night driving + car FX)* — **partly done**
- ~~Brake / tail lights~~ — done (`src/car_lights.js`): emissive boost on the
  existing `BrakeLight` material, ramping on braking, plus a spot-light glow
  and ground spill. Auto-derives the car's front/rear from geometry rather
  than a hardcoded axis convention, shared with underglow via
  `car_anchor.js`.
- ~~Headlights~~ — done: two SpotLights, auto-positioned the same way, aimed
  via tunable distance/drop/angle. Shadow-casting not implemented.
- ~~Underglow~~ (not originally in this phase, added anyway) — emissive strip
  + road glow, fades correctly during jumps/flips (see PLAN.md).
- **Not done:** volumetric headlight shafts in fog/rain (weather is disabled,
  see Phase 3); shadow-casting headlights; exhaust backfire (needs
  throttle/brake state — no seam for that yet); a distinct low-ambient
  "night mode" beyond what `TimeOfDay=Night` already gives; other cars'
  lights in multiplayer/replays (car discovery already finds every car with a
  `BrakeLight` material, so this may already partially work — untested in
  multiplayer).
- New seams still needed: throttle/brake/speed state, for backfire and any
  future speed-reactive effects (e.g. speed-reactive underglow intensity).
  Same trick as brake-light detection should work — derive speed from the
  car root's own world-position delta per frame, no new bundle seam needed.

## Phase 5 — Cinematic & advanced realism
- ~~Photo mode~~ — done: free-fly camera (F2) + PNG export (F9), full effects,
  reuses whatever preset/time-of-day is active. `src/runtime.js`'s `PhotoMode`.
- **TAA** for temporal stability across all the moving effects — not done
  (SMAA only).
- **Auto-exposure / eye adaptation** (tunnels, night) — not done.
- **Depth of field + subtle motion blur** for replays / photo mode — not done.
- Contact-hardening or higher-res shadows; optional screen-space GI — not done.

---

## New engineering seams required
Turned out smaller than expected — the car object, road material, and sky/cloud
objects are all reachable via `scene.traverse` (car via the `BrakeLight`
material marker, road/wetness materials via name heuristics in
`weather_engine.js`'s `SurfaceRegistry`, native sky via its own uniform
signature) without a new bundle seam at all. The two seams in `src/main.mod.js`
(sun override, render hook) have covered everything shipped so far. The one
seam still genuinely missing:
- **Throttle/brake/speed state** — for exhaust backfire and any future
  speed-reactive effects. Likely doesn't need a *bundle* seam either — car
  speed should be derivable from the car root's own world-position delta per
  frame, the same trick `car_anchor.js`/`car_lights.js` already use for
  everything else.

## Phase 6 — Ray tracing (draft, researched July 2026)

**Short version: real-time ray-traced *gameplay* isn't viable on the web today, and
probably won't be for a while. There's a real, valuable use for it — just not
during driving.**

### What's actually available right now
- **`three-gpu-pathtracer`** (gkjohnson) — the mature option. WebGL2 + compute-shader-style
  BVH traversal (via `three-mesh-bvh`), actively maintained. Gives full global
  illumination, soft shadows, and correct reflections/refractions.
- **WebGPU hardware ray tracing** — does not exist yet. It's not in the WebGPU spec,
  it's blocked upstream on bindless-resource support, and the working group hasn't
  committed to a timeline — realistically 2026+ at the earliest, possibly never.
  Everything calling itself "WebGPU ray tracing" today is a **compute-shader
  software path tracer** (WGSL), not hardware-accelerated RT cores.

### The hard constraint that rules out gameplay use
Path tracers (three-gpu-pathtracer included) are **progressive accumulators**: each
frame renders one noisy sample and blends it with all previous samples, converging
to a clean image over dozens–hundreds of frames — *provided the camera, lights, and
geometry don't move in between*. The moment anything moves, accumulation resets and
you're back to a noisy single-sample frame.

PolyTrack's actual gameplay view has: a continuously moving car, a moving chase
camera, and (now) a moving sun/time-of-day. None of that ever holds still. A path
tracer applied to the live race view would be permanently noisy — never a clean
image, and nowhere close to 60fps regardless of GPU (path tracing a full scene at
even 1 sample/pixel/frame at speed is already a heavy lift; converging it isn't
possible while driving).

**This is why the plan through Phase 5 uses rasterization + screen-space
approximations (SSR, N8AO, IBL) — that's not a stopgap, it's the correct real-time
technique.** This mirrors what "ray-traced" native games actually do even on RTX
hardware: a handful of RT effects (shadows, one bounce of reflections) layered on
top of a rasterized base, not full path tracing of the live frame.

### Where ray tracing *is* a good fit here
Anywhere the camera and scene can legitimately hold still for a second or more:
- **Photo Mode** — freeze the car and camera, path-trace for 1–3 seconds
  (accumulating up to a target sample count), then present or export the result.
  This is the highest-value, most achievable target: genuinely photoreal
  reflections/GI/soft shadows for a screenshot feature, using `three-gpu-pathtracer`
  as-is, today.
- **Garage / car customization screen** — car sits still, camera is static or
  orbits slowly; a path-traced preview here is very achievable and would look
  dramatically better than the rasterized preview for judging paint/finish.
- **Track-select / main-menu backdrops** — a static or slow-panning showcase shot.

### Proposed approach (draft — not yet built)
1. **Phase A — Photo Mode.** Add `three-gpu-pathtracer` alongside the existing
   composer (only active when Photo Mode is entered — car/camera frozen, gameplay
   paused). Reuse the same scene, materials, and the atmosphere's sun/sky state
   for lighting consistency with whatever time of day is active. Accumulate to a
   fixed sample budget (tunable — trade quality for wait time), then either display
   live or export a PNG.
2. **Phase B — Garage preview.** Same integration, applied to the garage scene
   (small, static, controlled lighting — the easiest possible target).
3. **Phase C (speculative, gated on the web platform, not on us)** — if WebGPU
   hardware RT ever ships with real timelines, reassess for a *replay/cinematic*
   mode with slow, scripted camera moves and a generous per-frame budget. Still not
   for live driving.
4. **Explicitly out of scope:** ray-traced live gameplay. Revisit only if the
   fundamental constraint above changes (it won't from our side — it's a browser/
   GPU platform limitation).

### Sources
- [three-gpu-pathtracer (GitHub)](https://github.com/gkjohnson/three-gpu-pathtracer)
- [WebGPU Future Roadmap 2025-2027 — hardware RT status](https://kaelan.fyi/research/webgpu-future-roadmap/)
- [WebGPU browser support 2026](https://webo360solutions.com/blog/webgpu-browser-support/)

---

## Suggested build order (impact ÷ effort) — updated

Phases 1, 2, and most of 4 are done (see status markers above). What's left, in
priority order:

1. **Fix and enable weather** (Phase 3) — the biggest remaining headline
   feature, and the implementation already exists; it needs the light-intensity
   compounding bug fixed (§3 above), not new code from scratch.
2. **Real-hardware perf-guard retuning** — the current thresholds have only
   ever been validated under software rendering (see PLAN.md §4). Cheap to do,
   currently blocking confidence in the guard's actual behavior on real GPUs.
3. **Throttle/brake/speed seam** — unlocks exhaust backfire and any
   speed-reactive effects (Phase 4).
4. **TAA + auto-exposure** (Phase 5) — most valuable once weather/time-of-day
   introduce more brightness variation than the current fixed presets have.
5. **Photo Mode path tracing** (Phase 6, Phase A) — highest-value ray tracing
   target; genuinely achievable today with `three-gpu-pathtracer`, unlike
   live-gameplay RT.
