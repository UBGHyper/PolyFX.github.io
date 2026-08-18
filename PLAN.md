# PolyFX — architecture reference

**Target:** PolyTrack v0.6.2 (Electron desktop). **Engine:** three.js r181 (vendored, tree-shaken).

This document describes what's actually built. It replaces an earlier version written before the
mod existed, back when the only option on the table was hand-patching the game's compiled bundle
directly — that recon (render call location, private-field variable names, settings enum layout)
is still accurate and is now encoded in `src/main.mod.js` and `src/car_anchor.js`, not narrated here.

---

## 1. Source layout and the two bundle seams

```
src/
  main.mod.js      PolyModLoader entry point — registers settings + the two mixins below
  runtime.js        the PolyFX class: composer, passes, tuning panel, perf guard
  sky.js  car_lights.js  car_anchor.js  weather_engine.js  underglow.js  glow_targets.js
  vendor/           three r181 + addons, N8AO, PolyTypes.js — all vendored, no npm runtime deps
  pml/              manifest.json, version.json, icon.png, description.html — copied verbatim
tools/
  build.mjs          esbuild -> dist/PolyFX (PML flavor) + app_src/mod (direct-patch dev flavor)
  release.mjs        build.mjs + copy into release/ (the committed, publishable tree)
  game-bundle.mjs    extracts your own app.asar, patches main.bundle.js for local dev
  shotbench/         Playwright screenshot + frame-time bench
test/                npm test — mixin-token guard, stock-safety invariant
```

Everything is authored once in `src/` and bundled by esbuild into **two single-file targets** with
zero remaining relative imports:

1. **`dist/PolyFX` / `release/`** — the PolyModLoader flavor (`main.mod.js`). PolyModLoader caches a
   mod's main file and re-imports it from a `blob:` URL on every launch after the first — a blob URL
   has no base path, so a multi-file mod (the mod's original form) breaks on every launch but the
   first. A single self-contained file has nothing to resolve, which is what actually fixes it —
   `tools/build.mjs` asserts zero relative imports survive in the output, so this can't silently
   regress.
2. **`app_src/mod/polyfx_runtime.js`** — the direct-bundle-patch flavor, for local dev against the
   unpacked game without PolyModLoader at all.

Both flavors route through the **same two seams** in the game's `V.prototype.update()`:

- **INSERT** right after the sun-position copy — lets `SkySystem` override the sun direction when
  its own day/night atmosphere is active.
- **REPLACEBETWEEN** around the stock `renderer.render(scene, camera)` call — routes it through
  `window.__PolyFX.render(...)` when present, falling straight back to the original call otherwise
  (or when the preset is Off — see §4).

**These tokens are matched against the game bundle's exact literal source text, not a prettified
copy.** `PolyModLoader.registerClassMixin` calls `.toString()` on the *live function object*, which
per spec returns the source exactly as shipped — no reformatting. A token with so much as an extra
space (the kind a prettifier adds) silently fails to match and PML throws "Token not found," meaning
the mod's settings menu still appears (that's a separate, always-working PML API) but the render hook
never installs and nothing is ever visible. This happened here once already — `test/mixin-tokens.test.mjs`
exists specifically to catch it again, verified against a bundle extracted straight from `app.asar`.

---

## 2. The post-processing pipeline

Pass order (`src/runtime.js`, `_ensure()`):

```
RenderPass -> (SSRPass, lazy) -> N8AOPass -> UnrealBloomPass -> god rays -> rain lens
  -> grade (contrast/saturation/split-tone/vignette) -> OutputPass (tone map + sRGB) -> SMAAPass
```

Grade runs **before** tone mapping (on linear HDR — its contrast is a power curve around a linear
pivot, not a display-referred `(x-0.5)*k+0.5` form, which only makes sense post-tonemap). SMAA runs
**after** — its edge-detection thresholds are tuned for gamma-space input.

`SSRPass` is built lazily, on first use, not in `_ensure()` — it's the single most expensive pass to
allocate (several full-res render targets) and only Photoreal needs it.

Reflections/IBL: `scene.environment` is refreshed from `SkySystem`'s PMREM, not from a static
`RoomEnvironment` (an indoor studio box was lighting the outdoor track like an interior — an early,
real bug). On "Default" time of day, only the reflection map refreshes (`envOnly` mode); the full
visible atmosphere (sky dome, procedural clouds, relighting) only engages once a time of day is
explicitly chosen — activating it unconditionally made Enhanced+ look hazier than stock, not punchier.

---

## 3. Presets & settings

`GraphicsPreset` (PML `SettingType.CUSTOM`, default `1` = Balanced):

| Preset | Tone map | Bloom | SMAA | God rays | env |
|---|---|---|---|---|---|
| Off (0) | — | — | — | — | composer bypassed entirely — provably identical to stock |
| Very Low (5) | Neutral | — | — | — | grade only |
| Balanced (1) | Neutral | subtle | on | — | — |
| Enhanced (2) | Neutral | on | on | — | IBL |
| Semi-Real (3) | Neutral | on | on | on | IBL |
| Photoreal (4) | Neutral | on | on | on | IBL |

`AmbientOcclusion` (PML `SettingType.CUSTOM`, default `0` = Off) is a separate, opt-in setting
independent of preset — every preset except Off/Very Low carries its own AO tuning parameters
(radius/intensity/samples, half-res on Balanced+Enhanced, full-res on Semi-Real+Photoreal), applied
only once this setting is on. It was folded into the preset table through 1.0.x, which meant AO's
cost (and a half-res compositing bug — see §5) landed on everyone at the default preset whether
they'd asked for shading or not. SSR is no longer offered by any preset (still reachable from the
tuning panel) for the same reason it and AO can't currently be enabled together — see below.

Tone mapping default is `NeutralToneMapping` (Khronos PBR Neutral), not ACES — ACES desaturates
content authored with no tone mapping in mind. Also exposed as a live-cyclable panel slider
(None/Neutral/ACES/AgX).

Also: `TimeOfDay` (Default + 7 named times), `Underglow` (Off/On), `AutoPerfGuard` (Off/On, default On).

`GlowingBlocks` (PML `SettingType.CUSTOM`, default `0` = Off) is a master switch only — *which*
`GLOW_CATEGORIES` are active and what color each one glows is a tuning-panel section
(`glow_targets.js` + `PolyFXPanel._buildGlowSection`), not the PML setting, because one PML
dropdown can't represent 13 independently-toggled, independently-colored entries (same reason AO's
radius/intensity are panel sliders, not settings). Any combination of categories can be active
simultaneously, each with its own user-picked `<input type="color">`.

This does **not** work by grabbing a material named `SignYellow` and setting `.emissive` on it,
because no such material exists at runtime: every track-part InstancedMesh (confirmed at runtime
— 36+ distinct geometries, 8+ distinct baked colors) shares exactly **one** `MeshLambertMaterial`,
with per-part color coming entirely from a baked per-vertex `color` attribute (values bit-identical
to the source GLTFs' `baseColorFactor`, confirmed by direct comparison). Setting `.emissive` on
that shared material would light up the *entire track*. Instead `GlowTargets._patch()` hooks the
shared material's `onBeforeCompile` once, adds fixed-size array uniforms
(`polyfxGlowTargets[16]`/`polyfxGlowColors[16]`/`polyfxGlowCount`/`polyfxGlowIntensity`) and
inserts a per-fragment loop right after `#include <emissivemap_fragment>` that checks the built-in
`vColor` varying against each active target color (epsilon `0.02`) and adds that category's glow
color if it matches.

Several source materials bake to colors too close together to reliably tell apart with a fixed
epsilon (e.g. `BlockSurface` 0.2079 vs `Pillar` 0.2019 — 0.0104 apart in Euclidean distance) — those
are merged into one honestly-labeled category (its target color is the cluster's centroid) rather
than pretending to offer granularity the baked data doesn't support; all 13 entries are cross-checked
pairwise to confirm they sit outside each other's match epsilon.

**Material detection is validated, not "first match wins forever."** The first version patched
whichever `MeshLambertMaterial`-with-vertex-colors `InstancedMesh` it found first during a
one-time scan — which broke in real play two ways: patching something car-related if it happened
to be traversed first (reported as "glowing cars"), and never re-checking after a track change
replaced the actual track material, silently leaving the patch on an orphaned, no-longer-rendered
object. Fixed by scoring each candidate material against how many `GLOW_CATEGORIES` colors its
sampled vertex colors actually match (the real track material should hit most of them; anything
else scores 0 or 1 by chance — accept only ≥3), and by cheaply re-verifying every scan
(`_sharedScan`, ~1/s) that the tracked material is still in use by a live mesh, falling back to a
fresh (expensive, sampling-based) re-scan only when it isn't — one shared traversal, not a second
full-tree walk, matching this codebase's existing "one shared per-second scan" discipline.
Verified against the real game: the detected material has exactly 36 usages (matching the known
track-part count) and is confirmed not one of the named car materials; two categories enabled
simultaneously with custom, non-default colors reach the shader uniforms exactly as set and render
correctly (screenshot: red/white track edges glowing magenta/cyan on request), with the car visibly
unaffected.

Tire smoke's material gets a color tint each frame (`_applySmokeTint`) rather than any real
lighting — it's a single `MeshBasicMaterial` shared across every smoke instance (same
one-material-many-parts shape as the track geometry above), so per-instance dynamic lighting isn't
free. Before 1.1.6 that tint only applied while an explicit `TimeOfDay` was chosen
(`SkySystem.ambientTint`, only maintained on that code path); Default time of day — the actual
default, and so the most common case — fell all the way back to smoke's original flat color with
no lighting response at all. `SkySystem.getStockAmbientTint()` fixes that by reading the stock
scene's own current directional/hemisphere lights directly (captured by `ingestLights`, valid
regardless of whether PolyFX's own procedural sky is engaged), so smoke now tints correctly in
every mode. Verified at the data level (`sky.getStockAmbientTint()` returns different, sensible
colors under Default/Night/Golden Hour) — not confirmed against actual on-screen smoke, since that
needs live drifting to spawn, which isn't scriptable without driving input.

---

## 4. Performance safeguards

- **Capability gate**: `WEBGL_debug_renderer_info` is probed once; a software rasterizer
  (SwiftShader/llvmpipe/"Basic Render Driver") forces the composer off unconditionally, regardless of
  preset.
- **Adaptive perf guard**: under sustained bad frame time, degrades one rung at a time — AO half-res
  -> SSR off -> god rays off -> bloom off — and recovers the same way once there's headroom, with
  hysteresis so it doesn't thrash. There is deliberately no "bypass" rung anymore: the guard may cut
  quality, it may not silently uninstall the mod. Thresholds are relative to a decayed running
  baseline of observed frame time (this machine's real vsync/steady-state floor), not fixed absolute
  numbers — degrade above `max(2× baseline, 28ms)`, recover below `1.25× baseline`. A fixed 16ms
  recovery floor (the pre-1.1 behavior) is mathematically unreachable on a 60Hz display, whose
  steady-state frame time is ~16.7ms — the guard could degrade but never recover. Both directions now
  also require ~2s of sustained bad/good frames before acting, and a preset switch, photo-mode
  toggle, or track load holds judgement for a few seconds so that transition's own hitch isn't read
  as steady-state cost. Exposed as the `AutoPerfGuard` PML setting (default on), not just the
  in-game panel.
- **AO and SSR each need to own the scene render.** `N8AOPass`, unlike `N8AOPostPass`, always
  renders its own beauty pass internally (`autoRenderBeauty`) and never reads the composer's own
  buffer chain — the same is true of `SSRPass`. `RenderPass` running first in the chain when either
  is enabled is a full extra scene render that's computed and then never read.
  `_updateRenderPassGate()` disables `RenderPass` whenever AO or SSR is the active scene source, and
  is called from every path that can flip either (preset/guard application, and the manual panel
  toggles) so it can't drift out of sync. AO and SSR are mutually exclusive by construction, which is
  the reason SSR was dropped from every preset in 1.1 (see §3) rather than composed with AO.
- **`N8AOPass.configuration.gammaCorrection` defaults to `true`** and, unlike `N8AOPostPass`, applies
  it unconditionally rather than only when it's the last pass before the screen. Left at its default
  it sRGB-encodes mid-chain, and `OutputPass` later in the chain encodes a second time — set to
  `false` in `_ensure()`.
- **Bloom has no protection against non-finite HDR input.** `LuminosityHighPassShader` (bloom's first
  step) read the scene's raw linear color unclamped; a single NaN/Infinity/absurd pixel survives
  `UnrealBloomPass`'s five downsample levels and, at the coarsest mip, one bad texel's blur kernel
  covers a large fraction of the frame — this is the actual mechanism behind the long-reported
  "warning signs cause a black box" bug (confirmed by disabling Bloom alone making it go away; an
  earlier, real N8AO half-res bug — see `THIRD_PARTY_LICENSES.md` — turned out not to be the one
  players were hitting). Patched in 1.1.1 with an explicit NaN guard plus a magnitude clamp, and a
  `debugHighlightNonFinite` uniform (panel: "Highlight Bloom Overflow") that renders caught pixels as
  a large finite magenta value instead of zero so the problem region is visible on screen rather than
  just suppressed.
- **God rays' threshold check was structurally broken, not just badly tuned.** `smoothstep(threshold,
  1.0, lum)` hardcoded `1.0` as the upper edge — sensible only if scene luminance is normalized into
  roughly [0,1], but this pipeline runs on raw linear HDR (pre-tonemap, same as bloom), where ordinary
  daytime sky luminance already exceeds 1.0. That made the "bright enough to feed the rays" test
  degenerate two ways: below 1.0 it was nearly a step function with almost no falloff band, so any
  threshold in the shipped 0-1.2 slider range was crossed by most of the sky, not just the sun disc
  (confirmed empirically at 43-93% of the frame across most daytime times of day — see
  `tools/shotbench/run.mjs`'s `godrays-sweep` section); above 1.0, smoothstep's `edge0 > edge1` case
  is undefined per the GLSL spec, so raising the panel's own threshold slider produced non-monotonic
  results. This is the actual cause of both symptoms reported: the whole screen washing toward one
  flat amber tone at any daytime hour, and the car's own bright surfaces (windshield, rims) getting
  ray-marched into duplicate/ghost copies of themselves once nearly everything on screen counted as
  "light source material." Fixed by scaling the falloff band with `threshold` itself
  (`smoothstep(threshold, threshold+max(threshold*0.5,0.05), lum)`, matching the non-degenerate
  pattern `LuminosityHighPassShader` already used for bloom's own threshold), and retuning
  `threshold`/`exposure` together per preset against the corrected formula (Semi-Real 2.4/0.016,
  Photoreal 2.0/0.022 — the old 0.84-0.88/0.11-0.15 pairs were tuned against the broken formula's
  behavior). Verified against the real extracted game across all 8 times of day: above-threshold
  coverage dropped to 0-8.8% of frame (was 0-93%), and the rendered result at Dawn/Morning — the
  worst offenders before — now shows a normal-looking scene with a contained glow near the sun
  instead of a scene-wide wash.
  The `godraysDebug` panel toggle (a `.polyfx-sun-marker` crosshair at the shader's actual
  `sunPosition`, plus a `debugShowThreshold` mode that tints above-threshold pixels cyan instead of
  accumulating rays) is what made this diagnosable in the first place, and stays in the panel for
  any future god-ray regressions.
- **Off provably costs nothing**: `_ensure()` (which builds the composer/sky/car-lights/underglow) is
  never called at all while the preset stays Off — not "disabled," never constructed.
  `test/stock-safety.test.mjs` asserts this directly.
- One shared per-second `scene.traverse` (car discovery, light discovery, the smoke-material scan)
  instead of three independent ones.

---

## 5. Known risks

- **Bundle-patch fragility is permanent, not something this round removed** — a future PolyTrack
  update can move the mixin tokens or the private-field variable names (`k`, `E`, `M`, `x`, `I`) the
  render-seam replacement hardcodes. `npm test`'s mixin-token guard turns that from a silent failure
  into a caught one, but only when someone actually runs it against a current game copy — a game
  update still needs a deliberate re-verify + version bump before shipping.
- **Weather is built but disabled** (`WEATHER_ENABLED = false` in `runtime.js`). The originally-diagnosed
  bug is fixed: `weather_engine.js`'s `_applySky` did `light.intensity *= lightScale` every frame with
  no reset from a stored base, so intensity decayed geometrically toward zero — it only ever looked
  correct because `SkySystem`'s full-atmosphere relight (an explicit `TimeOfDay`) resets `.intensity`
  absolutely every frame *before* weather runs (confirmed via the actual `render()` call order), which
  masked the bug everywhere except `envOnly` mode (Default time of day — the actual default, so the
  most commonly-hit case, and the one PLAN.md always meant by "doesn't do that"). Fixed by making
  weather's own reset conditional on `sky._fullEngaged` — multiply the fresh value sky.js just set
  when full relight is active (correct, non-compounding since it's fresh every frame), reset from
  weather's own captured original when it isn't (the case nothing else protects). Verified directly:
  under sustained heavy storm, light intensity now dims correctly during the transition, then holds
  exactly steady once cloudCover/storm stop changing, instead of continuing to decay (6 consecutive
  identical samples across 12+ seconds, vs. visible continued decay before the fix).
  **The flag stays off regardless** — testing with it flipped on (locally, reverted before shipping)
  turned up a second, separate, unfixed problem: `RainField`'s rain-line visual renders as wild
  connected-looking squiggles across the whole frame rather than discrete diagonal streaks, confirmed
  isolated to the rain-line geometry itself (not the lens shader, not SSR — ruled out individually) via
  `lines.visible = false`. Not yet diagnosed further: all testing this session runs through SwiftShader
  software rasterization even with the software-rasterizer *gate* spoofed off, and WebGL line rendering
  is known to differ meaningfully between software and real-GPU rasterizers, so this could be a
  testing-environment artifact rather than a bug real players would hit — needs verification on real
  hardware before spending more effort chasing it blind.
- Redistribution: this repo ships no game assets. `app_src/` and `extracted/` (built from your own
  legitimate install via `npm run setup:dev`) are gitignored on purpose.
