// PolyFX Shaders — PolyModLoader entry point.
//
// This registers two things with PML:
//   1. Three settings ("Realistic Shading" / "Time of Day" / "Underglow") via
//      PML's own registerSetting API — PML allocates the enum id, default
//      value, and settings-menu dropdown for these itself, so we never touch
//      the raw bundle for that part.
//   2. Two hooks into the renderer's per-frame update, installed by directly
//      patching prototypes (see "Why not registerClassMixin" below) instead
//      of PML's own mixin API:
//        a) wrapping the day/night object's getSunPosition() for the
//           duration of one update() call, so PolyFX can override the sun
//           direction when its own day/night sky is active.
//        b) wrapping WebGLRenderer.prototype.render itself, routing it
//           through window.__PolyFX.render(...) when the mod is present
//           (falls straight back to the original call when it isn't, or
//           when the "Off" graphics preset is selected).
//
// Everything else (the actual post-processing pipeline, weather, sky, car
// lights, underglow, tuning panel) lives in runtime.js, imported below.
//
// PolyTypes.js is vendored locally (src/vendor/PolyTypes.js, pinned to PML
// 0.6.2) rather than imported from the CDN — PML never does `instanceof
// PolyMod` (it duck-types via `modImport.polyMod`), so a local copy is safe,
// and it keeps the mod working under PML's offline/cached mode.
//
// --- Why not registerClassMixin ---
//
// PML's registerClassMixin(scope, path, mixin) works by taking the target
// method's OWN toString() text, splicing the mixin's code in at a token, and
// reinstalling the result via (paraphrased) `eval('eval(scope)[path] = ' +
// '(function(...) {...newBody...})')`. That reinstall is itself a direct
// eval() call written inside PolyModLoader's own source — and per JS spec, a
// function expression evaluated via eval() closes over the LEXICAL SCOPE
// AT THE EVAL SITE, not whatever scope the original source text came from.
//
// The renderer class (`V` in the 0.6.2 bundle) is compiled with several
// private fields (the renderer, scene, camera, sun-direction vector, etc.)
// implemented as module-scope WeakMaps (`k`, `E`, `M`, `I`, ...) that
// V.prototype.update reads via a shared per-field-access helper bound to a
// local `i` — all free variables from V's OWN webpack module closure. Once
// PML reconstructs update() via the mechanism above, that new function's
// closure is PML's own module (getFromPolyTrack's home), not V's — so every
// one of those free variables is simply unreachable there. The mixin
// *registers* fine (getFromPolyTrack('i(1507).A.prototype')['update'] reads
// the ORIGINAL, still-closure-intact function just fine), but the
// RECONSTRUCTED replacement throws the moment it actually runs and tries to
// use them: "(0, i.gn) is not a function".
//
// This is unrelated to (and layered on top of) a separate, now-solved
// problem: V isn't reachable as a bare "V" identifier from PML's own
// getFromPolyTrack eval() scope at all, because it's declared in its own
// isolated webpack module. See RENDERER_ACCESS in mixin_tokens.js for how
// it's actually reached — via the shared webpack require function ("i" in
// that scope) plus its module id, e.g. `i(1507).A`.
//
// The fix here sidesteps registerClassMixin's reconstruction entirely by
// reassigning V.prototype.update directly from this module's own, perfectly
// normal closure (getFromPolyTrack is only used to fetch V itself — a plain
// property read, not an eval'd function, so nothing loses its closure).
//
// That still leaves the actual renderer object needed to call
// window.__PolyFX.render(...) — real three.js's WebGLRenderer assigns
// render() as an INSTANCE property inside its own constructor (closing over
// many constructor-local variables — a normal three.js pattern, not
// specific to this bundle), so it can't be reached via .prototype.render at
// all, patched or not. It's found by briefly observing the global,
// module-independent WeakMap.prototype.get during one real update() call —
// V's private-field helper (module 1635) reads private fields via literal
// WeakMap.get(this) calls, so whichever call returns an object with
// isWebGLRenderer===true is V's own renderer instance. Verified against a
// synthetic reproduction of this exact shape before shipping (multiple
// frames, confirms one-time discovery, confirms the global patch is fully
// removed afterward, confirms unrelated WeakMaps are unaffected).
//
// installRenderPatch's own wrapper needs a reentrancy guard for a separate
// reason: window.__PolyFX.render's post-processing pipeline calls
// renderer.render(...) again internally as part of running its own passes
// (the composer's render pass draws through the very renderer whose
// .render we just replaced) — without the guard that inner call re-enters
// the wrapper and recurses into window.__PolyFX.render forever.
//
// The dev flavor (tools/game-bundle.mjs's patchBundle, used by
// app_src/main.bundle.js for `npm run dev` / `npm run shots`) doesn't have
// any of this trouble — it edits the bundle's source TEXT once, before the
// file is ever loaded, so the patched code becomes a normal part of V's own
// module and keeps its closure naturally. It still uses the token-splice
// approach in src/mixin_tokens.js's MIXIN_TOKENS.
import { PolyMod, SettingType } from './vendor/PolyTypes.js';
import { RENDERER_ACCESS } from './mixin_tokens.js';

import './runtime.js';

const GRAPHICS_PRESET_OPTIONS = [
  { title: 'Off', value: '0' },
  { title: 'Very Low', value: '5' },
  { title: 'Balanced', value: '1' },
  { title: 'Enhanced', value: '2' },
  { title: 'Semi-Real', value: '3' },
  { title: 'Photoreal (Ultra)', value: '4' },
];

const TIME_OF_DAY_OPTIONS = [
  { title: 'Default', value: '0' },
  { title: 'Dawn', value: '1' },
  { title: 'Morning', value: '2' },
  { title: 'Noon', value: '3' },
  { title: 'Afternoon', value: '4' },
  { title: 'Golden Hour', value: '5' },
  { title: 'Sunset', value: '6' },
  { title: 'Night', value: '7' },
];

const UNDERGLOW_OPTIONS = [
  { title: 'Off', value: '0' },
  { title: 'On', value: '1' },
];

const HEADLIGHTS_OPTIONS = [
  { title: 'Off', value: '0' },
  { title: 'On', value: '1' },
];

class PolyFXShadersMod extends PolyMod {
  init = (pml) => {
    this.pml = pml;

    pml.registerSettingCategory('Realistic Shading');
    // Default "1" = Balanced — see PLAN.md: Balanced is the safe, cheap-by-
    // default tier; Enhanced+ is an explicit opt-in for players with headroom.
    pml.registerSetting('Graphics Preset', 'GraphicsPreset', SettingType.CUSTOM, '1', GRAPHICS_PRESET_OPTIONS);
    pml.registerSetting('Time of Day', 'TimeOfDay', SettingType.CUSTOM, '0', TIME_OF_DAY_OPTIONS);
    pml.registerSetting('Underglow', 'Underglow', SettingType.CUSTOM, '0', UNDERGLOW_OPTIONS);
    pml.registerSetting('Headlights', 'Headlights', SettingType.CUSTOM, '1', HEADLIGHTS_OPTIONS);

    try {
      const V = pml.getFromPolyTrack(`i(${RENDERER_ACCESS.moduleId}).${RENDERER_ACCESS.exportName}`);
      const originalUpdate = V.prototype.update;

      // Set by the getSunPosition wrapper below (always called near the
      // start of the original update(), before render() at its end) so the
      // render patch has a sun direction to hand PolyFX for god rays,
      // without needing V's own private sun-vector field.
      let lastSunDir = null;

      // Discovered once, on whichever update() call happens to read the
      // renderer field first — see the file header for why this is
      // necessary at all (render() is an instance property, not reachable
      // via .prototype). Patched in place, so every later read of it
      // (stock code included) naturally goes through the wrapper too.
      let rendererPatched = false;

      function installRenderPatch(renderer) {
        const originalRender = renderer.render;
        // Reentrancy guard: window.__PolyFX.render's own post-processing
        // pipeline (this.composer.render()) calls renderer.render(...)
        // again internally as part of running its passes — the exact same
        // renderer instance whose .render we've just replaced, so that
        // inner call would otherwise re-enter this wrapper and recurse into
        // window.__PolyFX.render forever. inRender being true means we're
        // already inside our own dispatch, so fall straight through to the
        // real render instead of routing through PolyFX again.
        let inRender = false;
        renderer.render = function (scene, camera) {
          if (inRender || !window.__PolyFX) {
            return originalRender.call(this, scene, camera);
          }
          inRender = true;
          try {
            window.__PolyFX.render(this, scene, camera, undefined, lastSunDir);
          } finally {
            inRender = false;
          }
        };
      }

      V.prototype.update = function (e) {
        // (a) sun-direction override hook. Temporarily wraps the day/night
        // object's own getSunPosition for the duration of the original
        // update() call, so PolyFX can mutate the vector it returns exactly
        // like the old INSERT mixin did — but via a real, closure-intact
        // method instead of a reconstructed one.
        const hadOwnGetSunPosition = Object.prototype.hasOwnProperty.call(e, 'getSunPosition');
        const originalGetSunPosition = e.getSunPosition;
        e.getSunPosition = function (...args) {
          const pos = originalGetSunPosition.apply(this, args);
          window.__PolyFX?.overrideSun?.(pos);
          lastSunDir = pos;
          return pos;
        };

        // (b) renderer discovery, only until it succeeds once. this === the
        // V instance the private-field WeakMaps are keyed by.
        const self = this;
        let originalWeakMapGet = null;
        if (!rendererPatched) {
          originalWeakMapGet = WeakMap.prototype.get;
          WeakMap.prototype.get = function (key) {
            const result = originalWeakMapGet.call(this, key);
            if (!rendererPatched && key === self && result && result.isWebGLRenderer === true) {
              installRenderPatch(result);
              rendererPatched = true;
            }
            return result;
          };
        }

        try {
          return originalUpdate.call(this, e);
        } finally {
          if (hadOwnGetSunPosition) e.getSunPosition = originalGetSunPosition;
          else delete e.getSunPosition;
          if (originalWeakMapGet) WeakMap.prototype.get = originalWeakMapGet;
        }
      };
    } catch (e) {
      // Caught here (not left to PML's own try/catch around init()) so a
      // hook-installation failure — e.g. from a future game update moving
      // the renderer's module id or export name — logs instead of silently
      // losing the settings registered above too.
      console.error('[PolyFX] renderer hook installation failed — game bundle format likely changed, see src/mixin_tokens.js:', e);
    }
  };
}

export let polyMod = new PolyFXShadersMod();
