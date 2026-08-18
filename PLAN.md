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
  sky.js  car_lights.js  car_anchor.js  weather_engine.js  underglow.js
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
- **Weather is built but disabled** (`WEATHER_ENABLED = false` in `runtime.js`) — reviving it needs a
  real fix first, not just flipping the flag: `weather_engine.js`'s `_applySky` does
  `light.intensity *= lightScale` every frame without ever resetting from a stored base, so intensities
  decay geometrically toward zero. It only ever looked correct because `SkySystem`'s full-atmosphere
  relight rewrote them absolutely first each frame, and `envOnly` mode (the default now) doesn't do
  that. See ROADMAP Phase 3.
- Redistribution: this repo ships no game assets. `app_src/` and `extracted/` (built from your own
  legitimate install via `npm run setup:dev`) are gitignored on purpose.
