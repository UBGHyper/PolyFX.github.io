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

const OTHER_HEADLIGHTS_OPTIONS = [
  { title: 'Off', value: '0' },
  { title: 'On', value: '1' },
];

const AMBIENT_OCCLUSION_OPTIONS = [
  { title: 'Off', value: '0' },
  { title: 'On', value: '1' },
];

const AUTO_PERF_GUARD_OPTIONS = [
  { title: 'Off', value: '0' },
  { title: 'On', value: '1' },
];

function isTypingTarget() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

class PolyFXShadersMod extends PolyMod {
  init = (pml) => {
    this.pml = pml;

    pml.registerSettingCategory('Realistic Shading');
    pml.registerSetting('Graphics Preset', 'GraphicsPreset', SettingType.CUSTOM, '1', GRAPHICS_PRESET_OPTIONS);
    pml.registerSetting('Time of Day', 'TimeOfDay', SettingType.CUSTOM, '0', TIME_OF_DAY_OPTIONS);
    pml.registerSetting('Ambient Occlusion', 'AmbientOcclusion', SettingType.CUSTOM, '0', AMBIENT_OCCLUSION_OPTIONS);
    pml.registerSetting('Underglow', 'Underglow', SettingType.CUSTOM, '0', UNDERGLOW_OPTIONS);
    pml.registerSetting('Headlights', 'Headlights', SettingType.CUSTOM, '1', HEADLIGHTS_OPTIONS);
    pml.registerSetting("Other Cars' Headlights", 'OtherHeadlights', SettingType.CUSTOM, '1', OTHER_HEADLIGHTS_OPTIONS);
    pml.registerSetting('Auto Perf Guard', 'AutoPerfGuard', SettingType.CUSTOM, '1', AUTO_PERF_GUARD_OPTIONS);

    try {
      pml.registerBindCategory('PolyFX');
      pml.registerKeybind('Tuning Panel', 'polyfx.panel', 'keydown', 'KeyL', null, (e) => {
        if (e.repeat || isTypingTarget()) return;
        const fx = window.__PolyFX;
        if (!fx || !fx.panel) return;
        e.preventDefault();
        fx.panel.toggle();
      });
      pml.registerKeybind('Photo Mode', 'polyfx.photo', 'keydown', 'F2', null, (e) => {
        if (e.repeat || isTypingTarget()) return;
        const fx = window.__PolyFX;
        if (!fx || !fx.photo) return;
        e.preventDefault();
        fx.photo.setActive(!fx.photo.active, fx.lastCamera);
      });
      pml.registerKeybind('Save Screenshot', 'polyfx.capture', 'keydown', 'F9', null, (e) => {
        const fx = window.__PolyFX;
        if (!fx || !fx.photo || !fx.photo.active) return;
        e.preventDefault();
        fx.photo.captureQueued = true;
      });
    } catch (e) {
      console.error('[PolyFX] keybind registration failed — falling back to no in-game hotkeys:', e);
    }

    try {
      const V = pml.getFromPolyTrack(`i(${RENDERER_ACCESS.moduleId}).${RENDERER_ACCESS.exportName}`);
      const originalUpdate = V.prototype.update;

      let lastSunDir = null;

      let rendererPatched = false;

      function installRenderPatch(renderer) {
        const originalRender = renderer.render;
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
        const hadOwnGetSunPosition = Object.prototype.hasOwnProperty.call(e, 'getSunPosition');
        const originalGetSunPosition = e.getSunPosition;
        e.getSunPosition = function (...args) {
          const pos = originalGetSunPosition.apply(this, args);
          window.__PolyFX?.overrideSun?.(pos);
          lastSunDir = pos;
          return pos;
        };

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
      console.error('[PolyFX] renderer hook installation failed — game bundle format likely changed, see src/mixin_tokens.js:', e);
    }
  };
}

export let polyMod = new PolyFXShadersMod();
