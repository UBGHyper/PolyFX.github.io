// PolyFX Shaders — PolyModLoader entry point.
//
// This registers two things with PML:
//   1. Three settings ("Realistic Shading" / "Time of Day" / "Underglow") via
//      PML's own registerSetting API — PML allocates the enum id, default
//      value, and settings-menu dropdown for these itself, so we never touch
//      the raw bundle for that part.
//   2. Two small mixins on the renderer class (`V` in the 0.6.2 bundle), both
//      inside its `update()` method:
//        a) INSERT right after the sun-position copy, so PolyFX can override
//           the sun direction when its own day/night sky is active.
//        b) REPLACEBETWEEN around the stock `renderer.render(scene, camera)`
//           call, routing it through `window.__PolyFX.render(...)` when the
//           mod is present (falls straight back to the original call when it
//           isn't, or when the "Off" graphics preset is selected).
//
// Everything else (the actual post-processing pipeline, weather, sky, car
// lights, underglow, tuning panel) lives in runtime.js, imported below.
//
// PolyTypes.js is vendored locally (src/vendor/PolyTypes.js, pinned to PML
// 0.6.2) rather than imported from the CDN — PML never does `instanceof
// PolyMod` (it duck-types via `modImport.polyMod`), so a local copy is safe,
// and it keeps the mod working under PML's offline/cached mode.
//
// Tokens below are matched EXACTLY against the live minified game bundle —
// registerClassMixin calls `.toString()` on the actual running function
// object, which per spec returns the function's literal source text as it
// was shipped (no reformatting), so a token with prettifier-added whitespace
// (e.g. spaces after commas) silently fails to match and throws "Token not
// found" — the mod would never load under real PolyModLoader even with a
// correct bundle build.
//
// registerClassMixin also operates on `V.prototype.update`'s OWN toString()
// output — i.e. the SOURCE OF JUST THAT ONE METHOD, not the whole bundle
// file. `addMaterial` used to be tokenEnd here on the assumption it was the
// tail of update()'s body, but it's actually a separate SIBLING method
// starting immediately after update()'s own closing brace — a whole-file
// `indexOf` finds it fine (it's real text, just not inside update()), so
// that mistake survived undetected until tested against PML's real
// method-scoped mechanism. tokenEnd now ends exactly at update()'s own
// closing brace, and `func` supplies that brace itself instead of assuming
// anything follows.
//
// Verified against a pristine 0.6.2 bundle extracted straight from app.asar
// (see tools/game-bundle.mjs / `npm test`) — test/mixin-tokens.test.mjs
// simulates PML's actual method-scoped extraction, splice, and
// reconstruction, not just whole-file substring presence.

import { PolyMod, MixinType, SettingType } from './vendor/PolyTypes.js';
import { MIXIN_TOKENS } from './mixin_tokens.js';

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

class PolyFXShadersMod extends PolyMod {
  init = (pml) => {
    this.pml = pml;

    pml.registerSettingCategory('Realistic Shading');
    // Default "1" = Balanced — see PLAN.md: Balanced is the safe, cheap-by-
    // default tier; Enhanced+ is an explicit opt-in for players with headroom.
    pml.registerSetting('Graphics Preset', 'GraphicsPreset', SettingType.CUSTOM, '1', GRAPHICS_PRESET_OPTIONS);
    pml.registerSetting('Time of Day', 'TimeOfDay', SettingType.CUSTOM, '0', TIME_OF_DAY_OPTIONS);
    pml.registerSetting('Underglow', 'Underglow', SettingType.CUSTOM, '0', UNDERGLOW_OPTIONS);

    // TEMPORARY DIAGNOSTIC — remove once the correct scope path is confirmed.
    // 'V.prototype' throws inside registerClassMixin ("Cannot read properties
    // of undefined (reading 'toString')"): pml.getFromPolyTrack('V') resolves
    // to something real but unrelated (an unrelated WASM-loading stub
    // function that happens to share the name "V" in a different,
    // coincidentally eval-reachable scope). Brute-forces every single/double
    // uppercase-letter name through PML's own real getFromPolyTrack to find
    // whichever one actually holds the render call. Wrapped so it can never
    // throw, and logs to console regardless of outcome.
    // Round 2: brute-forcing every single/double uppercase-letter bare name
    // came back empty — the render class isn't reachable as a simple
    // identifier from wherever getFromPolyTrack's eval() runs at all, not
    // just under a colliding name. This scope DOES have a webpack-style
    // require function reachable as "i" (confirmed separately: i.n() calls
    // nearby are the classic webpack ESM-interop helper) — introspect it
    // directly to find its actual module cache property name (varies by
    // config/version), then search every cached module's exports for the
    // render call, plus a bounded fallback search from `window`. Passed as
    // one big expression string since getFromPolyTrack is exactly `eval`.
    try {
      const marker = MIXIN_TOKENS.renderTokenStart;
      const probe = `(function(){
        const marker = ${JSON.stringify(marker)};
        const out = { iProps: null, cacheProp: null, cacheSize: null, matches: [], windowMatches: [] };
        function isMatch(obj) {
          const upd = obj && obj.prototype && obj.prototype.update;
          return typeof upd === 'function' && upd.toString().includes(marker);
        }
        try {
          if (typeof i === 'function') {
            out.iProps = Object.getOwnPropertyNames(i);
            for (const propName of out.iProps) {
              let val;
              try { val = i[propName]; } catch (e) { continue; }
              if (!val || typeof val !== 'object') continue;
              const keys = Object.keys(val);
              if (keys.length < 5 || keys.length > 5000) continue; // heuristic: a module cache, not something tiny/huge
              out.cacheProp = propName;
              out.cacheSize = keys.length;
              for (const k of keys) {
                try {
                  const entry = val[k];
                  const candidates = [entry, entry && entry.exports, entry && entry.exports && entry.exports.default];
                  for (const c of candidates) {
                    if (isMatch(c)) { out.matches.push({ cacheProp: propName, moduleKey: k }); }
                    if (c && typeof c === 'object') {
                      for (const ek of Object.keys(c)) {
                        try { if (isMatch(c[ek])) out.matches.push({ cacheProp: propName, moduleKey: k, exportKey: ek }); } catch (e) {}
                      }
                    }
                  }
                } catch (e) {}
              }
              if (out.matches.length) break;
            }
          }
        } catch (e) { out.iError = String(e); }
        try {
          if (!out.matches.length) {
            const seen = new Set(); let visited = 0;
            (function search(obj, path, depth) {
              if (!obj || depth > 3 || visited > 20000 || seen.has(obj)) return;
              seen.add(obj); visited++;
              if (isMatch(obj)) { out.windowMatches.push(path); return; }
              let keys; try { keys = Object.keys(obj); } catch (e) { return; }
              for (const k of keys) {
                if (visited > 20000) return;
                let v; try { v = obj[k]; } catch (e) { continue; }
                if (v && (typeof v === 'object' || typeof v === 'function')) search(v, path + '.' + k, depth + 1);
              }
            })(window, 'window', 0);
          }
        } catch (e) { out.windowError = String(e); }
        return JSON.stringify(out);
      })()`;
      const result = pml.getFromPolyTrack(probe);
      console.log('[PolyFX diag v2]', result);
    } catch (e) {
      console.error('[PolyFX diag v2] scan itself failed:', e);
    }
    // --- END TEMPORARY DIAGNOSTIC ---

    try {
      // (a) sun-direction override hook.
      pml.registerClassMixin('V.prototype', 'update', {
        type: MixinType.INSERT,
        token: MIXIN_TOKENS.sunInsert,
        func: `window.__PolyFX?.overrideSun?.((0, i.gn)(this, I, "f"));`,
      });

      // (b) route the render call through PolyFX when present. tokenEnd is
      // the exact tail of update()'s own render(...) call plus its closing
      // brace — i.e. the very end of the method — not a reference to any
      // other method.
      pml.registerClassMixin('V.prototype', 'update', {
        type: MixinType.REPLACEBETWEEN,
        tokenStart: MIXIN_TOKENS.renderTokenStart,
        tokenEnd: MIXIN_TOKENS.renderTokenEnd,
        func: `window.__PolyFX
                  ? window.__PolyFX.render(
                      (0, i.gn)(this, k, "f"),
                      (0, i.gn)(this, E, "f"),
                      (0, i.gn)(this, M, "f"),
                      (0, i.gn)(this, x, "f"),
                      (0, i.gn)(this, I, "f"),
                    )
                  : (0, i.gn)(this, k, "f").render(
                      (0, i.gn)(this, E, "f"),
                      (0, i.gn)(this, M, "f"),
                    );
                }`,
      });
    } catch (e) {
      // Caught here (not left to PML's own try/catch around init()) so the
      // diagnostic above still runs and the mod doesn't get unloaded while
      // we're actively narrowing this down.
      console.error('[PolyFX] mixin registration failed (see diagnostic above for the likely fix):', e);
    }
  };
}

export let polyMod = new PolyFXShadersMod();
