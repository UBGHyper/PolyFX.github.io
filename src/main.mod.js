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

    // (a) sun-direction override hook.
    pml.registerClassMixin('V.prototype', 'update', {
      type: MixinType.INSERT,
      token: MIXIN_TOKENS.sunInsert,
      func: `window.__PolyFX?.overrideSun?.((0, i.gn)(this, I, "f"));`,
    });

    // (b) route the render call through PolyFX when present. tokenEnd is the
    // exact tail of update()'s own render(...) call plus its closing brace —
    // i.e. the very end of the method — not a reference to any other method.
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
  };
}

export let polyMod = new PolyFXShadersMod();
