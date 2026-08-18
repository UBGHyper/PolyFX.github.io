import * as THREE from './vendor/three.module.js';
import { EffectComposer } from './vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/addons/postprocessing/RenderPass.js';
import { OutputPass } from './vendor/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from './vendor/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from './vendor/addons/postprocessing/SMAAPass.js';
import { SSRPass } from './vendor/addons/postprocessing/SSRPass.js';
import { Pass, FullScreenQuad } from './vendor/addons/postprocessing/Pass.js';
import { N8AOPass } from './vendor/addons/N8AO.js';
import { SkySystem } from './sky.js';
import { CarLights } from './car_lights.js';
import { Underglow } from './underglow.js';
import { isBrakeLightMesh, rootOf } from './car_anchor.js';
import { WeatherEngine, WEATHER_NAMES } from './weather_engine.js';

const GRAPHICS_PRESET_ID = 'GraphicsPreset';
const TIME_OF_DAY_ID = 'TimeOfDay';
const UNDERGLOW_ID = 'Underglow';
const HEADLIGHTS_ID = 'Headlights';
const OTHER_HEADLIGHTS_ID = 'OtherHeadlights';
const AMBIENT_OCCLUSION_ID = 'AmbientOcclusion';
const AUTO_PERF_GUARD_ID = 'AutoPerfGuard';
const PRESET = { OFF: 0, BALANCED: 1, ENHANCED: 2, SEMI_REAL: 3, PHOTO_REAL: 4, VERY_LOW: 5 };
const TOD_HOURS = [null, 6.5, 9, 12, 15, 16.8, 18, 22];

const WEATHER_ENABLED = false;

const TONE_MODES = [
  { name: 'None', value: THREE.NoToneMapping },
  { name: 'Neutral', value: THREE.NeutralToneMapping },
  { name: 'ACES', value: THREE.ACESFilmicToneMapping },
  { name: 'AgX', value: THREE.AgXToneMapping },
];
const DEFAULT_TONE_INDEX = 1;

function detectCapabilities(renderer) {
  let rendererString = '';
  let maxTextureSize = 0;
  try {
    const gl = renderer.getContext();
    let dbg = null;
    try { dbg = gl.getExtension('WEBGL_debug_renderer_info'); } catch (_) {}
    rendererString = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  } catch (e) {
    console.warn('[PolyFX] capability probe failed:', e);
  }
  const lower = String(rendererString || '').toLowerCase();
  const isSoftware = /swiftshader|llvmpipe|software|basic render driver|microsoft basic/.test(lower);
  return {
    rendererString: rendererString || 'unknown',
    isSoftware,
    maxTextureSize,
    deviceMemory: (typeof navigator !== 'undefined' && navigator.deviceMemory) || null,
    hardwareConcurrency: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null,
  };
}

class PerfGuard {
  // No "bypass" rung — the guard may cut quality, it may never uninstall the mod outright.
  static STEPS = ['full', 'aoHalf', 'ssrOff', 'godraysOff', 'bloomOff'];
  static MAX_LEVEL = PerfGuard.STEPS.length - 1;
  static SUSTAIN_MS = 2000;
  static HOLD_MS = 3000;

  constructor() {
    this.enabled = true;
    this.level = 0;
    // A running floor of observed frame time, standing in for "this machine's vsync/steady-state
    // cost" — thresholds are relative to it rather than fixed absolute numbers. A fixed 16ms
    // recovery floor is *never* reachable on a 60Hz display (its steady frame time is ~16.7ms),
    // which is why this guard used to degrade freely but could never recover.
    this.baselineMs = 16.7;
    this.holdUntil = 0;
    this._badSinceT = 0;
    this._goodSinceT = 0;
  }

  // Suspend judgement for a bit after a change we know isn't the mod's steady-state cost: a
  // preset switch, a track load, entering/exiting photo mode.
  hold(ms = PerfGuard.HOLD_MS) {
    this.holdUntil = performance.now() + ms;
    this._badSinceT = 0;
    this._goodSinceT = 0;
  }

  update(frameMs, now) {
    if (!this.enabled) return false;
    if (now < this.holdUntil) { this._badSinceT = 0; this._goodSinceT = 0; return false; }

    this.baselineMs = frameMs < this.baselineMs ? frameMs : this.baselineMs + (frameMs - this.baselineMs) * 0.01;
    const degradeAt = Math.max(this.baselineMs * 2, 28);
    const recoverAt = this.baselineMs * 1.25;

    if (frameMs > degradeAt) { if (!this._badSinceT) this._badSinceT = now; this._goodSinceT = 0; }
    else if (frameMs < recoverAt) { if (!this._goodSinceT) this._goodSinceT = now; this._badSinceT = 0; }
    else { this._badSinceT = 0; this._goodSinceT = 0; }

    // Sustained, not instantaneous — a one-off hitch (GC pause, shader compile) shouldn't cost a rung.
    if (this._badSinceT && now - this._badSinceT > PerfGuard.SUSTAIN_MS && this.level < PerfGuard.MAX_LEVEL) {
      this.level++; this._badSinceT = 0;
      console.warn(`[PolyFX] perf guard: degrading to "${this.stepName}" (frame ${frameMs.toFixed(1)}ms vs ${this.baselineMs.toFixed(1)}ms baseline)`);
      return true;
    }
    if (this._goodSinceT && now - this._goodSinceT > PerfGuard.SUSTAIN_MS && this.level > 0) {
      this.level--; this._goodSinceT = 0;
      console.info(`[PolyFX] perf guard: recovering to "${this.stepName}"`);
      return true;
    }
    return false;
  }

  get stepName() { return PerfGuard.STEPS[this.level]; }
}

function cfgFor(preset) {
  switch (preset) {
    case PRESET.VERY_LOW:
      return { composer: true, tone: TONE_MODES[DEFAULT_TONE_INDEX].value, exposure: 1, env: false,
        ao: null, bloom: null, smaa: false, ssr: null, godrays: null,
        grade: { contrast: 1.02, saturation: 1.02, vignette: 0.03, split: 0 } };
    case PRESET.BALANCED:
      // AO used to be this preset's whole personality; now it's an opt-in setting (default off —
      // see AmbientOcclusion), so Balanced needs bloom+SMAA of its own to still visibly do
      // something for players who never touch that toggle.
      return { composer: true, tone: TONE_MODES[DEFAULT_TONE_INDEX].value, exposure: 1, env: false,
        ao: { aoRadius: 2.2, distanceFalloff: 0.9, intensity: 1.6, halfRes: true, screenSpaceRadius: true, aoSamples: 8, denoiseSamples: 4, denoiseRadius: 8 },
        bloom: { strength: 0.07, radius: 0.45, threshold: 1.2 }, smaa: true, ssr: null, godrays: null,
        grade: { contrast: 1.04, saturation: 1.06, vignette: 0.05, split: 0.12 } };
    case PRESET.ENHANCED:
      return { composer: true, tone: TONE_MODES[DEFAULT_TONE_INDEX].value, exposure: 1, env: true, envIntensity: 0.4,
        ao: { aoRadius: 3.2, distanceFalloff: 1.0, intensity: 2.0, halfRes: true, screenSpaceRadius: true, aoSamples: 16, denoiseSamples: 8, denoiseRadius: 10 },
        bloom: { strength: 0.09, radius: 0.5, threshold: 1.15 }, smaa: true, ssr: null,
        godrays: null, grade: { contrast: 1.06, saturation: 1.10, vignette: 0.08, split: 0.22 } };
    case PRESET.SEMI_REAL:
      return { composer: true, tone: TONE_MODES[DEFAULT_TONE_INDEX].value, exposure: 1, env: true, envIntensity: 0.55,
        ao: { aoRadius: 4.2, distanceFalloff: 1.05, intensity: 2.6, halfRes: false, screenSpaceRadius: true, aoSamples: 20, denoiseSamples: 10, denoiseRadius: 12 },
        bloom: { strength: 0.13, radius: 0.58, threshold: 1.05 }, smaa: true, ssr: null,
        godrays: { intensity: 0.4, density: 0.9, weight: 0.42, decay: 0.95, exposure: 0.11, threshold: 0.88, samples: 32 },
        grade: { contrast: 1.08, saturation: 1.14, vignette: 0.14, split: 0.30 } };
    case PRESET.PHOTO_REAL:
      return { composer: true, tone: TONE_MODES[DEFAULT_TONE_INDEX].value, exposure: 1, env: true, envIntensity: 0.7,
        ao: { aoRadius: 5.0, distanceFalloff: 1.1, intensity: 3.2, halfRes: false, screenSpaceRadius: true, aoSamples: 24, denoiseSamples: 16, denoiseRadius: 14 },
        bloom: { strength: 0.17, radius: 0.65, threshold: 0.95 }, smaa: true,
        // SSRPass renders its own scene pass and needs to own RenderPass the same way AO now
        // does; the two have never been made to compose, and previously AO silently discarded
        // whatever SSR drew. Dropped from presets rather than shipping "on" and invisible — still
        // reachable from the tuning panel.
        ssr: null,
        godrays: { intensity: 0.65, density: 0.94, weight: 0.46, decay: 0.96, exposure: 0.15, threshold: 0.84, samples: 56 },
        grade: { contrast: 1.10, saturation: 1.18, vignette: 0.18, split: 0.36 } };
    default:
      return { composer: false };
  }
}

function hourLabel(hour) {
  if (hour == null) return 'Default';
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

class FullscreenShaderPass extends Pass {
  constructor(shader) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(shader.uniforms),
      vertexShader: shader.vertexShader,
      fragmentShader: shader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }
  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1 },
    saturation: { value: 1 },
    vignette: { value: 0 },
    splitStrength: { value: 0 },
    shadowTint: { value: new THREE.Color(0.94, 0.98, 1.05) },
    highlightTint: { value: new THREE.Color(1.05, 1.01, 0.94) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse;
    uniform float contrast, saturation, vignette, splitStrength;
    uniform vec3 shadowTint, highlightTint;
    const float PIVOT = 0.18; // linear-light "middle grey"
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = max(c.rgb, 0.0);
      col = PIVOT * pow(col / PIVOT, vec3(contrast));
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, saturation);
      vec3 split = mix(shadowTint, highlightTint, smoothstep(0.05, 1.4, lum));
      col = mix(col, col * split, splitStrength);
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * vignette * 2.0;
      gl_FragColor = vec4(max(col, 0.0) * clamp(v, 0.0, 1.0), c.a);
    }`,
};

const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    sunPosition: { value: new THREE.Vector2(0.5, 0.5) },
    intensity: { value: 0 },
    density: { value: 0.92 },
    weight: { value: 0.45 },
    decay: { value: 0.95 },
    exposure: { value: 0.12 },
    threshold: { value: 0.9 },
    tint: { value: new THREE.Color(1, 0.92, 0.74) },
    sampleCount: { value: 56 },
    debugShowThreshold: { value: false },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse; uniform vec2 sunPosition;
    uniform float intensity,density,weight,decay,exposure,threshold; uniform vec3 tint;
    uniform int sampleCount; uniform bool debugShowThreshold;
    const int MAX_SAMPLES=56;
    void main(){
      vec4 base=texture2D(tDiffuse,vUv);
      // Shows exactly which pixels count as "bright enough to feed the rays" (linear HDR,
      // pre-tonemap — see PLAN.md) without the accumulation/smear on top, so a shadow or other
      // dark-on-screen region that's secretly crossing threshold in linear space is visible
      // directly instead of only inferred from the smeared result.
      if(debugShowThreshold){
        float lum=dot(base.rgb,vec3(0.299,0.587,0.114));
        float over=smoothstep(threshold,1.0,lum);
        gl_FragColor=vec4(mix(base.rgb,vec3(0.0,3.0,3.0),over),base.a);
        return;
      }
      if(intensity<=0.0){ gl_FragColor=base; return; }
      vec2 tc=vUv;
      vec2 delta=(vUv-sunPosition)*(density/float(sampleCount));
      float illum=1.0;
      vec3 acc=vec3(0.0);
      for(int i=0;i<MAX_SAMPLES;i++){
        if(i>=sampleCount) break;
        tc-=delta;
        vec3 s=texture2D(tDiffuse,clamp(tc,0.0,1.0)).rgb;
        float lum=dot(s,vec3(0.299,0.587,0.114));
        acc+=s*smoothstep(threshold,1.0,lum)*(illum*weight);
        illum*=decay;
      }
      gl_FragColor=vec4(base.rgb+acc*exposure*intensity*tint,base.a);
    }`,
};

const RainLensShader = {
  uniforms: {
    tDiffuse: { value: null },
    intensity: { value: 0 },
    time: { value: 0 },
    streaks: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse; uniform float intensity,time,streaks;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x),u.y);
    }
    void main(){
      if(intensity<=0.001){ gl_FragColor=texture2D(tDiffuse,vUv); return; }
      vec2 uv=vUv;
      float edge=smoothstep(0.05,0.65,length(uv-0.5));
      vec2 flow=vec2(0.0,time*0.55);
      float n=noise(uv*vec2(38.0,18.0)+flow);
      float drops=smoothstep(0.965-0.08*intensity,1.0,n)*edge;
      float lines=smoothstep(0.86,1.0,noise(vec2(uv.x*85.0,uv.y*5.0+time*2.2)))*streaks*edge;
      float mask=clamp(drops+lines,0.0,1.0);
      vec2 wobble=(vec2(noise(uv*70.0+time),noise(uv.yx*70.0-time))-0.5)*0.018*intensity + vec2(0.0,-lines*0.018*intensity);
      vec3 col=texture2D(tDiffuse,uv+wobble).rgb;
      col=mix(col,col*0.82+vec3(0.04,0.055,0.07),mask*0.35*intensity);
      gl_FragColor=vec4(col,1.0);
    }`,
};

class PhotoMode {
  constructor(fx) {
    this.fx = fx;
    this.active = false;
    this.camera = null;
    this.keys = new Set();
    this.dragging = false;
    this.captureQueued = false;
    this.yaw = 0;
    this.pitch = 0;
    this.lastT = 0;
    this.speed = 11;
    this.dir = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._installHud();
    window.addEventListener('keydown', (e) => this._key(e, true), true);
    window.addEventListener('keyup', (e) => this._key(e, false), true);
    window.addEventListener('mousedown', (e) => {
      if (!this.active || e.button !== 2) return;
      this.dragging = true;
      e.preventDefault(); e.stopPropagation();
    }, true);
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.dragging = false;
      if (this.active) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    window.addEventListener('mousemove', (e) => this._look(e), true);
    window.addEventListener('wheel', (e) => this._wheel(e), { capture: true, passive: false });
    window.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); }, true);
  }

  _installHud() {
    const style = document.createElement('style');
    style.textContent = `.polyfx-photo-active #ui{opacity:0;pointer-events:none}.polyfx-photo-hud{display:none;position:fixed;right:16px;bottom:16px;z-index:99998;font-family:ForcedSquare,Arial,sans-serif;color:#fff;background:rgba(10,16,34,.68);border:2px solid rgba(130,160,230,.55);border-radius:8px;padding:10px 12px;backdrop-filter:blur(4px);pointer-events:none}.polyfx-photo-active .polyfx-photo-hud{display:block}`;
    document.head.appendChild(style);
    this.hud = document.createElement('div');
    this.hud.className = 'polyfx-photo-hud';
    this.hud.textContent = 'PHOTO MODE  F2 exit  WASD/QE move  RMB look  wheel FOV  F9 save';
    document.body.appendChild(this.hud);
  }

  // Activation (F2) and capture (F9) are real, rebindable PML keybinds registered in
  // main.mod.js — they call setActive()/set captureQueued directly. This listener only
  // handles continuous WASD/QE/Shift/Ctrl movement while active, which is held-key polling,
  // not a discrete action PML's keybind API is meant for.
  _key(e, down) {
    if (!this.active) return;
    const handled = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'];
    if (handled.includes(e.code)) {
      down ? this.keys.add(e.code) : this.keys.delete(e.code);
      e.preventDefault(); e.stopPropagation();
    }
  }

  _look(e) {
    if (!this.active || !this.dragging) return;
    this.yaw -= e.movementX * 0.003;
    this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.003, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    e.preventDefault(); e.stopPropagation();
  }

  _wheel(e) {
    if (!this.active || !this.camera) return;
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + Math.sign(e.deltaY) * 3, 18, 90);
    this.camera.updateProjectionMatrix();
    e.preventDefault(); e.stopPropagation();
  }

  setActive(active, sourceCamera) {
    if (active === this.active) return;
    this.active = active;
    document.body.classList.toggle('polyfx-photo-active', active);
    this.keys.clear(); this.dragging = false; this.lastT = 0;
    if (active && sourceCamera) this._copyCamera(sourceCamera);
  }

  _copyCamera(sourceCamera) {
    this.camera = sourceCamera.clone();
    this.camera.matrixAutoUpdate = true;
    this.camera.rotation.order = 'YXZ';
    this.yaw = this.camera.rotation.y;
    this.pitch = this.camera.rotation.x;
  }

  update(sourceCamera) {
    if (!this.active) return sourceCamera;
    if (!this.camera) this._copyCamera(sourceCamera);
    this.camera.aspect = sourceCamera.aspect;
    this.camera.near = sourceCamera.near;
    this.camera.far = sourceCamera.far;
    const now = performance.now();
    const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0;
    this.lastT = now;
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.getWorldDirection(this.dir);
    this.right.crossVectors(this.dir, this.up).normalize();
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const slow = this.keys.has('ControlLeft') || this.keys.has('ControlRight');
    const amount = this.speed * (fast ? 3 : 1) * (slow ? 0.25 : 1) * dt;
    if (this.keys.has('KeyW')) this.camera.position.addScaledVector(this.dir, amount);
    if (this.keys.has('KeyS')) this.camera.position.addScaledVector(this.dir, -amount);
    if (this.keys.has('KeyD')) this.camera.position.addScaledVector(this.right, amount);
    if (this.keys.has('KeyA')) this.camera.position.addScaledVector(this.right, -amount);
    if (this.keys.has('KeyE')) this.camera.position.y += amount;
    if (this.keys.has('KeyQ')) this.camera.position.y -= amount;
    this.camera.updateProjectionMatrix();
    return this.camera;
  }

  capture(renderer) {
    if (!this.captureQueued) return;
    this.captureQueued = false;
    renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'polyfx-photo-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }
}

class PolyFX {
  constructor() {
    this.renderer = null;
    this.composer = null;
    this.builtFor = null;
    this.preset = -1;
    this.orig = null;
    this.cfg = null;
    this.size = new THREE.Vector2(-1, -1);
    this.tmpSize = new THREE.Vector2();
    this.lastCamera = null;
    this.lastScene = null;
    this.warned = false;
    this.sky = null;
    this.skyActive = false;
    this.envOnly = false;
    this.skyHour = 12;
    this.lastTod = null;
    this.hourOverride = null;
    this.carLights = null;
    this.underglow = null;
    this.headlightsForce = false;
    this.weatherHeadlights = false;
    this.carLightsEnabled = true;
    this.bloomDebugHighlight = false;
    this.godraysDebug = false;
    this.photo = null;
    this.photoWasActive = false;
    this.sunOverrideScratch = new THREE.Vector3();
    this.smokeMat = undefined;
    this.frameMs = 16.7;
    this.frameT = 0;
    this.panel = null;
    this.godraysStrength = 0;
    this.lastPerfT = 0;
    this.weatherEngine = new WeatherEngine();
    this.weather = this.weatherEngine.state;

    this.caps = null;
    this.perfGuard = new PerfGuard();
    this._lastAppliedGuardLevel = -1;
    this._ssrFailed = false;

    this.presetOverride = null;
    this.todOverride = null;
    this.underglowOverride = null;
    this.lastUnderglowSetting = null;
    this.carLightsOverride = null;
    this.lastCarLightsSetting = null;
    this.otherHeadlightsOverride = null;
    this.lastOtherHeadlightsSetting = null;
    this.aoOverride = null;
    this.lastAoSetting = null;
    this.aoRequested = false;
    this.aoAvailable = false;
    this.perfGuardOverride = null;
    this.lastPerfGuardSetting = null;

    this._scanT = 0;
    this._scanIsFirst = true;

    // Panel/photo/capture keys are registered as real, rebindable PML keybinds — see
    // main.mod.js. window.__PolyFX.panel.toggle() etc. are the hooks their callbacks call.
  }

  render(renderer, scene, camera, settings, sunDir) {
    this._trackFrameTime();

    if (this.caps === null) {
      try { this.caps = detectCapabilities(renderer); } catch (e) { this.caps = { isSoftware: false }; }
    }
    if (this.caps && this.caps.isSoftware) {
      if (this.orig) this._restore(scene);
      if (this.sky && this.skyActive) { this.skyActive = false; try { this.sky.setState(false); this.sky._deactivate(scene); } catch (_) {} }
      if (this.carLights) this.carLights.disableAll();
      if (this.underglow) this.underglow.setEnabled(false);
      renderer.render(scene, camera);
      return;
    }

    let preset = this.presetOverride != null ? this.presetOverride : PRESET.OFF;
    if (this.presetOverride == null) {
      try { preset = parseInt(window.polyModLoader?.getSetting(GRAPHICS_PRESET_ID), 10); } catch (_) {}
      if (!Number.isFinite(preset)) preset = PRESET.OFF;
    }
    let cfg = cfgFor(preset);
    if (this.photo && this.photo.active) cfg = cfgFor(PRESET.PHOTO_REAL);
    const guardLevel = this.perfGuard.enabled ? this.perfGuard.level : 0;

    if (!cfg.composer || !camera) {
      if (this.orig) this._restore(scene);
      if (this.sky && this.skyActive) { this.skyActive = false; try { this.sky.setState(false); this.sky._deactivate(scene); } catch (_) {} }
      if (this.carLights) this.carLights.disableAll();
      if (this.underglow) this.underglow.setEnabled(false);
      renderer.render(scene, camera);
      return;
    }

    try {
      this._ensure(renderer, scene, camera);
      const photoActive = !!(this.photo && this.photo.active);
      const presetChanged = preset !== this.preset;
      const photoChanged = photoActive !== this.photoWasActive;
      if (presetChanged || photoChanged || guardLevel !== this._lastAppliedGuardLevel) {
        this._apply(cfg, renderer, scene, camera, guardLevel);
        // A preset switch or a photo-mode toggle causes its own hitch; don't let that hitch be
        // mistaken for steady-state cost and used to justify degrading further.
        if (presetChanged || photoChanged) this.perfGuard.hold();
        this.preset = preset;
        this.photoWasActive = photoActive;
        this._lastAppliedGuardLevel = guardLevel;
      }
      renderer.getDrawingBufferSize(this.tmpSize);
      if (this.tmpSize.x !== this.size.x || this.tmpSize.y !== this.size.y) { this.size.copy(this.tmpSize); this._resize(); }

      this.lastCamera = camera;
      const activeCamera = this.photo ? this.photo.update(camera) : camera;
      this.renderPass.scene = scene; this.renderPass.camera = activeCamera;
      this.n8ao.scene = scene; this.n8ao.camera = activeCamera;
      if (this.ssr) { this.ssr.scene = scene; this.ssr.camera = activeCamera; }
      this.lastScene = scene;

      this._sharedScan(scene, this._scanIsFirst);

      let tod = this.todOverride != null ? this.todOverride : 0;
      if (this.todOverride == null) {
        try { tod = parseInt(window.polyModLoader?.getSetting(TIME_OF_DAY_ID), 10); } catch (_) {}
        if (!Number.isFinite(tod)) tod = 0;
      }
      if (tod !== this.lastTod) { this.lastTod = tod; this.hourOverride = null; }
      const hour = this.hourOverride != null ? this.hourOverride : TOD_HOURS[tod];
      this.skyActive = !!(this.cfg && this.cfg.env) || hour != null || this.weather.cloudCover > 0.5 || this.weather.fogDensity > 0.01 || this.weather.rainRate > 0.01;
      this.skyHour = hour != null ? hour : 12;
      this.envOnly = hour == null;
      if (this.sky) { this.sky.setState(this.skyActive, this.skyHour); this.sky.update(scene, activeCamera, this.envOnly); }
      if (WEATHER_ENABLED && this.weatherEngine) {
        this.weatherEngine.update({
          scene,
          camera: activeCamera,
          sky: this.sky,
          lensPass: this.rainLens,
          renderer,
          cfg: this.cfg,
          baseBloomStrength: this.baseBloomStrength,
          bloom: this.bloom,
          ssr: this.ssr,
          renderPass: this.renderPass,
          photoreal: !!(this.cfg && this.cfg.ssr) || photoActive,
        });
        this.weather = this.weatherEngine.state;
        this.weatherHeadlights = this.weather.autoHeadlights;
      }
      this._applyEnv(scene);
      this._applySmokeTint(scene);

      let carLightsSetting = this.carLightsOverride != null ? this.carLightsOverride : 1;
      if (this.carLightsOverride == null) {
        try { carLightsSetting = parseInt(window.polyModLoader?.getSetting(HEADLIGHTS_ID), 10); } catch (_) {}
        if (!Number.isFinite(carLightsSetting)) carLightsSetting = 1;
      }
      if (carLightsSetting !== this.lastCarLightsSetting) {
        this.lastCarLightsSetting = carLightsSetting;
        this.carLightsEnabled = carLightsSetting >= 1;
        if (!this.carLightsEnabled && this.carLights) this.carLights.disableAll();
      }

      let otherHeadlightsSetting = this.otherHeadlightsOverride != null ? this.otherHeadlightsOverride : 1;
      if (this.otherHeadlightsOverride == null) {
        try { otherHeadlightsSetting = parseInt(window.polyModLoader?.getSetting(OTHER_HEADLIGHTS_ID), 10); } catch (_) {}
        if (!Number.isFinite(otherHeadlightsSetting)) otherHeadlightsSetting = 1;
      }
      if (otherHeadlightsSetting !== this.lastOtherHeadlightsSetting) {
        this.lastOtherHeadlightsSetting = otherHeadlightsSetting;
        if (this.carLights) this.carLights.cfg.otherHeadlightsEnabled = otherHeadlightsSetting >= 1;
      }

      let aoSetting = this.aoOverride != null ? this.aoOverride : 0;
      if (this.aoOverride == null) {
        try { aoSetting = parseInt(window.polyModLoader?.getSetting(AMBIENT_OCCLUSION_ID), 10); } catch (_) {}
        if (!Number.isFinite(aoSetting)) aoSetting = 0;
      }
      if (aoSetting !== this.lastAoSetting) {
        this.lastAoSetting = aoSetting;
        this.aoRequested = aoSetting >= 1;
        this._updateAO();
      }

      let perfGuardSetting = this.perfGuardOverride != null ? this.perfGuardOverride : 1;
      if (this.perfGuardOverride == null) {
        try { perfGuardSetting = parseInt(window.polyModLoader?.getSetting(AUTO_PERF_GUARD_ID), 10); } catch (_) {}
        if (!Number.isFinite(perfGuardSetting)) perfGuardSetting = 1;
      }
      if (perfGuardSetting !== this.lastPerfGuardSetting) {
        this.lastPerfGuardSetting = perfGuardSetting;
        this.perfGuard.enabled = perfGuardSetting >= 1;
      }

      if (this.carLights) {
        const dusk = this.skyActive && !this.envOnly && this.sky && this.sky.sunDir.y < 0.1;
        if (this.carLightsEnabled) this.carLights.update(scene, this.headlightsForce || this.weatherHeadlights || dusk, activeCamera);
        else this.carLights.disableAll();
      }

      let underglowSetting = this.underglowOverride != null ? this.underglowOverride : 0;
      if (this.underglowOverride == null) {
        try { underglowSetting = parseInt(window.polyModLoader?.getSetting(UNDERGLOW_ID), 10); } catch (_) {}
        if (!Number.isFinite(underglowSetting)) underglowSetting = 0;
      }
      if (underglowSetting !== this.lastUnderglowSetting) {
        this.lastUnderglowSetting = underglowSetting;
        if (this.underglow) this.underglow.setEnabled(underglowSetting >= 1);
      }
      if (this.underglow) this.underglow.update(scene);

      if (this.godrays && this.godrays.enabled) this._updateSun(activeCamera, sunDir);
      else this._updateSunMarker(null, null);
      if (this.panel) this.panel.tick();
      this.composer.render();
      if (this.photo) this.photo.capture(renderer);
    } catch (err) {
      if (!this.warned) { console.error('[PolyFX] failed, using direct render:', err); this.warned = true; }
      renderer.render(scene, camera);
    }
  }

  _ensure(renderer, scene, camera) {
    if (this.composer && this.builtFor === renderer) return;
    this.orig = { toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure, environment: scene.environment, environmentIntensity: scene.environmentIntensity ?? 1 };
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, size.x), h = Math.max(1, size.y);
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.n8ao = new N8AOPass(scene, camera, w, h);
    this.n8ao.autoDetectTransparency = false;
    this.n8ao.configuration.transparencyAware = false;
    // N8AOPass sRGB-encodes its own output unconditionally (unlike N8AOPostPass, it has no
    // autosetGamma guard). OutputPass encodes a second time later in the chain, which is the
    // "AO overexposes everything" bug — see PLAN.md §5.
    this.n8ao.configuration.gammaCorrection = false;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.1, 0.5, 1.25);
    this.ssr = null;
    this.godrays = new FullscreenShaderPass(GodRaysShader);
    this.godrays.enabled = false;
    this.rainLens = new FullscreenShaderPass(RainLensShader);
    this.rainLens.enabled = false;
    this.grade = new FullscreenShaderPass(GradeShader);
    this.grade.enabled = false;
    this.output = new OutputPass();
    this.smaa = new SMAAPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.n8ao);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.godrays);
    this.composer.addPass(this.rainLens);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
    this.composer.addPass(this.smaa);
    this.renderer = renderer;
    this.builtFor = renderer;
    this.size.set(-1, -1);
    if (!this.sky) { try { this.sky = new SkySystem(renderer); this.sky.attach(scene); } catch (e) { console.warn('[PolyFX] sky unavailable:', e); } }
    if (!this.carLights) { try { this.carLights = new CarLights(); } catch (e) { console.warn('[PolyFX] car lights unavailable:', e); } }
    if (!this.underglow && this.carLights) { try { this.underglow = new Underglow(this.carLights); } catch (e) { console.warn('[PolyFX] underglow unavailable:', e); } }
    if (!this.photo && typeof document !== 'undefined') { try { this.photo = new PhotoMode(this); } catch (e) { console.warn('[PolyFX] photo mode unavailable:', e); } }
    if (!this.panel && typeof document !== 'undefined') { try { this.panel = new PolyFXPanel(this); } catch (e) { console.warn('[PolyFX] panel unavailable:', e); } }
    if (!this._sunMarker && typeof document !== 'undefined') { try { this._installSunMarker(); } catch (e) { console.warn('[PolyFX] sun marker unavailable:', e); } }
  }

  // Debug-only: shows exactly where GodRaysShader thinks the sun is on screen (the same
  // sunPosition uniform it samples toward), so a theory about "the rays are radiating from
  // somewhere they shouldn't" can be confirmed by looking, not inferred from the smeared result.
  _installSunMarker() {
    const style = document.createElement('style');
    style.textContent = `.polyfx-sun-marker{display:none;position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border:2px solid #37e6e6;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.6);pointer-events:none;z-index:99997}.polyfx-sun-marker::before,.polyfx-sun-marker::after{content:'';position:absolute;background:#37e6e6}.polyfx-sun-marker::before{left:50%;top:-6px;width:2px;height:6px;transform:translateX(-1px)}.polyfx-sun-marker::after{top:50%;left:-6px;width:6px;height:2px;transform:translateY(-1px)}.polyfx-sun-marker.on{display:block}`;
    document.head.appendChild(style);
    this._sunMarker = document.createElement('div');
    this._sunMarker.className = 'polyfx-sun-marker';
    document.body.appendChild(this._sunMarker);
  }

  _ensureSSR(renderer, scene, camera) {
    if (this.ssr || this._ssrFailed) return;
    try {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      this.ssr = new SSRPass({ renderer, scene, camera, width: Math.max(1, size.x), height: Math.max(1, size.y), groundReflector: null, selects: null });
      this.ssr.enabled = false;
      const idx = this.composer.passes.indexOf(this.renderPass);
      this.composer.insertPass(this.ssr, idx + 1);
      if (this.size.x > 0 && this.ssr.setSize) this.ssr.setSize(this.size.x, this.size.y);
    } catch (e) {
      console.warn('[PolyFX] SSR unavailable:', e);
      this._ssrFailed = true;
    }
  }

  _apply(cfg, renderer, scene, camera, guardLevel = 0) {
    this.cfg = cfg;
    renderer.toneMapping = cfg.tone;
    renderer.toneMappingExposure = cfg.exposure;

    // AO's enabled state is driven by the (opt-in, off-by-default) AmbientOcclusion setting, not
    // by preset — see _updateAO(). cfg.ao only carries this preset's tuning parameters for when
    // it's on.
    this.aoAvailable = !!cfg.ao;
    if (cfg.ao) {
      Object.assign(this.n8ao.configuration, cfg.ao);
      if (guardLevel >= 1) this.n8ao.configuration.halfRes = true;
      if (this.n8ao.configuration.color && this.n8ao.configuration.color.set) this.n8ao.configuration.color.set(0x000000);
    }
    this._updateAO();

    this.baseBloomStrength = cfg.bloom ? cfg.bloom.strength : 0;
    this.bloom.enabled = !!cfg.bloom && guardLevel < 4;
    if (cfg.bloom) Object.assign(this.bloom, cfg.bloom);

    const wantSSR = !!cfg.ssr && guardLevel < 2;
    if (wantSSR) this._ensureSSR(renderer, scene, camera);
    const useSSR = wantSSR && !!this.ssr;
    if (this.ssr) {
      this.ssr.enabled = useSSR;
      if (useSSR && cfg.ssr) {
        this.ssr.opacity = cfg.ssr.opacity;
        this.ssr.maxDistance = cfg.ssr.maxDistance;
        this.ssr.thickness = cfg.ssr.thickness;
        this.ssr.blur = cfg.ssr.blur;
      }
    }
    this._updateRenderPassGate();

    this.godrays.enabled = !!cfg.godrays && guardLevel < 3;
    if (cfg.godrays) {
      const u = this.godrays.material.uniforms;
      u.density.value = cfg.godrays.density;
      u.weight.value = cfg.godrays.weight;
      u.decay.value = cfg.godrays.decay;
      u.exposure.value = cfg.godrays.exposure;
      u.threshold.value = cfg.godrays.threshold;
      u.sampleCount.value = cfg.godrays.samples || 56;
      this.godraysStrength = cfg.godrays.intensity;
    } else {
      this.godraysStrength = 0;
    }

    this.grade.enabled = !!cfg.grade;
    if (cfg.grade) {
      const u = this.grade.material.uniforms;
      u.contrast.value = cfg.grade.contrast;
      u.saturation.value = cfg.grade.saturation;
      u.vignette.value = cfg.grade.vignette;
      u.splitStrength.value = cfg.grade.split ?? 0;
    }

    this.smaa.enabled = !!cfg.smaa;
    this.output.enabled = true;

    if (cfg.env) {
      if ('environmentIntensity' in scene) scene.environmentIntensity = cfg.envIntensity ?? 0.35;
    } else {
      scene.environment = this.orig.environment;
      if ('environmentIntensity' in scene) scene.environmentIntensity = this.orig.environmentIntensity;
    }
  }

  _updateAO() {
    if (!this.n8ao) return;
    this.n8ao.enabled = !!(this.aoAvailable && this.aoRequested);
    this._updateRenderPassGate();
  }

  // N8AOPass always renders its own beauty pass internally (autoRenderBeauty) and never reads the
  // composer's buffer chain at all — so whenever it's the active scene source (same as SSR),
  // RenderPass rendering the same frame first is pure waste: a full extra scene render, thrown
  // away unread, every frame.
  _updateRenderPassGate() {
    if (!this.renderPass) return;
    const aoOwnsRender = !!(this.n8ao && this.n8ao.enabled);
    const ssrOwnsRender = !!(this.ssr && this.ssr.enabled);
    this.renderPass.enabled = !(aoOwnsRender || ssrOwnsRender);
  }

  _sharedScan(scene, force) {
    const now = performance.now();
    if (!force && now - this._scanT < 1000) return;
    this._scanT = now;

    const carRoots = new Set();
    const dirLights = [], hemiLights = [];
    const smokeUnknown = this.smokeMat === undefined;
    let smoke = smokeUnknown ? null : this.smokeMat;

    scene.traverse((o) => {
      if (o.userData && o.userData.__polyfxOwned) return;
      if (o.isDirectionalLight) { dirLights.push(o); return; }
      if (o.isHemisphereLight) { hemiLights.push(o); return; }
      if (!o.isMesh) return;
      if (isBrakeLightMesh(o)) { const root = rootOf(o, scene); if (root) carRoots.add(root); }
      if (smokeUnknown && !smoke && o.isInstancedMesh && o.material) {
        const m = o.material;
        if (m.isMeshBasicMaterial && m.transparent && m.depthWrite === false && m.map && Math.abs(m.opacity - 0.3) < 0.01) smoke = m;
      }
    });

    if (this.carLights) this.carLights.ingestRoots(carRoots);
    if (this.sky) this.sky.ingestLights(dirLights, hemiLights, this._scanIsFirst);
    if (smokeUnknown) {
      this.smokeMat = smoke || null;
      if (this.smokeMat && !this.smokeMat.userData.__polyfxOrigColor) this.smokeMat.userData.__polyfxOrigColor = this.smokeMat.color.clone();
    }
    this._scanIsFirst = false;
  }

  _applyEnv(scene) {
    if (!this.cfg || !this.cfg.env) return;
    if (this.sky && this.sky.envTexture) {
      scene.environment = this.sky.envTexture;
      const base = this.cfg.envIntensity ?? 0.35;
      const wash = this.weather ? (this.weather.skyWash || 0) : 0;
      const wet = this.weather ? Math.max(this.weather.wetness || 0, this.weather.puddles || 0) : 0;
      if ('environmentIntensity' in scene) scene.environmentIntensity = THREE.MathUtils.clamp(base + wet * 0.18 - wash * 0.10, base * 0.5, base * 1.6);
    }
  }

  _applySmokeTint(scene) {
    if (!this.smokeMat) return;
    if (this.skyActive && !this.envOnly && this.sky) this.smokeMat.color.copy(this.sky.ambientTint);
    else this.smokeMat.color.copy(this.smokeMat.userData.__polyfxOrigColor);
  }

  _restore(scene) {
    if (!this.orig) return;
    if (this.renderer) { this.renderer.toneMapping = this.orig.toneMapping; this.renderer.toneMappingExposure = this.orig.exposure; }
    scene.environment = this.orig.environment;
    if ('environmentIntensity' in scene) scene.environmentIntensity = this.orig.environmentIntensity;
  }

  _resize() {
    const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
    this.composer.setSize(w, h);
    this.n8ao.setSize(w, h);
    this.bloom.setSize(w, h);
    if (this.ssr && this.ssr.setSize) this.ssr.setSize(w, h);
    if (this.smaa.setSize) this.smaa.setSize(w, h);
  }

  _updateSun(camera, sunDir) {
    const u = this.godrays.material.uniforms;
    const dir = this.skyActive && !this.envOnly && this.sky ? this.sky.getSunDir() : sunDir;
    if (!dir) { u.intensity.value = 0; this._updateSunMarker(null, null); return; }
    this.sunOverrideScratch.copy(dir).normalize().multiplyScalar(5000).add(camera.position).project(camera);
    const sx = this.sunOverrideScratch.x * 0.5 + 0.5;
    const sy = this.sunOverrideScratch.y * 0.5 + 0.5;
    u.sunPosition.value.set(sx, sy);
    let fade = 0;
    if (this.sunOverrideScratch.z < 1) {
      const mx = Math.max(0, Math.max(-sx, sx - 1));
      const my = Math.max(0, Math.max(-sy, sy - 1));
      fade = Math.max(0, 1 - (mx + my) / 0.4);
    }
    u.intensity.value = this.godraysStrength * fade;
    this._updateSunMarker(sx, sy);
  }

  _updateSunMarker(sx, sy) {
    if (!this._sunMarker) return;
    if (!this.godraysDebug || sx == null) { this._sunMarker.classList.remove('on'); return; }
    this._sunMarker.classList.add('on');
    // sunPosition is GL-convention UV (y=1 at the top); the marker is positioned in DOM/viewport
    // space (y=0 at the top), and the canvas fills the viewport, so this flip is the only
    // conversion needed — no separate NDC step, sx/sy are already normalized [0,1].
    this._sunMarker.style.left = (sx * 100) + '%';
    this._sunMarker.style.top = ((1 - sy) * 100) + '%';
  }

  _trackFrameTime() {
    const now = performance.now();
    if (this.frameT) {
      const dt = now - this.frameT;
      if (dt > 0 && dt < 1000) this.frameMs += (dt - this.frameMs) * 0.1;
    }
    this.frameT = now;
    this.lastPerfT = now;
    if (this.perfGuard.enabled) this.perfGuard.update(this.frameMs, now);
  }

  fps() {
    return this.frameMs > 0 ? Math.round(1000 / this.frameMs) : 0;
  }

  setPresetOverride(n) { this.presetOverride = n == null ? null : Number(n); }
  setTimeOfDayOverride(n) { this.todOverride = n == null ? null : Number(n); }
  setUnderglowOverride(n) { this.underglowOverride = n == null ? null : Number(n); }
  setAoOverride(n) { this.aoOverride = n == null ? null : Number(n); }
  setPerfGuardOverride(n) { this.perfGuardOverride = n == null ? null : Number(n); }

  toggleEffect(name, on) {
    switch (name) {
      case 'ao':
        this.aoRequested = on;
        this._updateAO();
        break;
      case 'bloom': if (this.bloom) this.bloom.enabled = on; break;
      case 'ssr':
        if (on) this._ensureSSR(this.renderer, this.lastScene, this.lastCamera);
        if (this.ssr) this.ssr.enabled = on;
        this._updateRenderPassGate();
        break;
      case 'godrays': if (this.godrays) this.godrays.enabled = on; break;
      case 'grade': if (this.grade) this.grade.enabled = on; break;
      case 'smaa': if (this.smaa) this.smaa.enabled = on; break;
      case 'underglow': if (this.underglow) this.underglow.setEnabled(on); break;
      case 'underglowPulse': if (this.underglow) this.underglow.applyConfig({ pulse: on }); break;
      case 'perfguard': this.perfGuard.enabled = on; break;
      case 'carlights':
        this.carLightsEnabled = on;
        if (!on && this.carLights) this.carLights.disableAll();
        break;
      case 'otherHeadlights': if (this.carLights) this.carLights.cfg.otherHeadlightsEnabled = on; break;
      case 'headlightsForce': this.headlightsForce = on; break;
      case 'photo': if (this.photo) this.photo.setActive(on, this.lastCamera); break;
      case 'lightning': this.weather.lightning = on; break;
      case 'bloomDebug':
        this.bloomDebugHighlight = on;
        if (this.bloom) this.bloom.highPassUniforms['debugHighlightNonFinite'].value = on;
        break;
      case 'godraysDebug':
        this.godraysDebug = on;
        if (this.godrays) this.godrays.material.uniforms.debugShowThreshold.value = on;
        if (!on) this._updateSunMarker(null, null);
        break;
    }
  }

  setParam(path, value) {
    switch (path) {
      case 'weather.preset':
        this._applyWeatherPreset(Math.round(value));
        break;
      case 'weather.rain':
        if (this.weatherEngine) this.weatherEngine.setParam('rain', value);
        break;
      case 'weather.wetness': if (this.weatherEngine) this.weatherEngine.setParam('wetness', value); break;
      case 'weather.puddles': if (this.weatherEngine) this.weatherEngine.setParam('puddles', value); break;
      case 'weather.clouds': if (this.weatherEngine) this.weatherEngine.setParam('clouds', value); break;
      case 'weather.fog': if (this.weatherEngine) this.weatherEngine.setParam('fog', value); break;
      case 'weather.droplets': if (this.weatherEngine) this.weatherEngine.setParam('droplets', value); break;
      case 'weather.wind': if (this.weatherEngine) this.weatherEngine.setParam('wind', value); break;
      case 'weather.storm': if (this.weatherEngine) this.weatherEngine.setParam('storm', value); break;
      case 'weather.intensity': if (this.weatherEngine) this.weatherEngine.setParam('intensity', value); break;
      case 'weather.transition': if (this.weatherEngine) this.weatherEngine.setParam('transition', value); break;
      case 'toneMode': if (this.renderer) this.renderer.toneMapping = (TONE_MODES[Math.round(value)] || TONE_MODES[DEFAULT_TONE_INDEX]).value; break;
      case 'exposure': if (this.renderer) this.renderer.toneMappingExposure = value; break;
      case 'envIntensity': if (this.lastScene && 'environmentIntensity' in this.lastScene) this.lastScene.environmentIntensity = value; break;
      case 'hour': this.hourOverride = value; break;
      case 'ao.intensity': if (this.n8ao) this.n8ao.configuration.intensity = value; break;
      case 'ao.radius': if (this.n8ao) this.n8ao.configuration.aoRadius = value; break;
      case 'ao.falloff': if (this.n8ao) this.n8ao.configuration.distanceFalloff = value; break;
      case 'ao.halfRes': if (this.n8ao) this.n8ao.configuration.halfRes = value >= 0.5; break;
      case 'ao.renderMode': if (this.n8ao) this.n8ao.configuration.renderMode = Math.round(value); break;
      case 'bloom.strength': if (this.bloom) { this.baseBloomStrength = value; this.bloom.strength = value; } break;
      case 'bloom.radius': if (this.bloom) this.bloom.radius = value; break;
      case 'bloom.threshold': if (this.bloom) this.bloom.threshold = value; break;
      case 'ssr.opacity': if (this.ssr) this.ssr.opacity = value; break;
      case 'ssr.maxDistance': if (this.ssr) this.ssr.maxDistance = value; break;
      case 'ssr.thickness': if (this.ssr) this.ssr.thickness = value; break;
      case 'godrays.intensity': this.godraysStrength = value; break;
      case 'godrays.exposure': if (this.godrays) this.godrays.material.uniforms.exposure.value = value; break;
      case 'godrays.threshold': if (this.godrays) this.godrays.material.uniforms.threshold.value = value; break;
      case 'grade.contrast': if (this.grade) this.grade.material.uniforms.contrast.value = value; break;
      case 'grade.saturation': if (this.grade) this.grade.material.uniforms.saturation.value = value; break;
      case 'grade.vignette': if (this.grade) this.grade.material.uniforms.vignette.value = value; break;
      case 'grade.split': if (this.grade) this.grade.material.uniforms.splitStrength.value = value; break;
      case 'underglow.intensity': if (this.underglow) this.underglow.applyConfig({ stripIntensity: value }); break;
      case 'underglow.blobOpacity': if (this.underglow) this.underglow.applyConfig({ blobOpacity: value }); break;
      case 'underglow.blobRadius': if (this.underglow) this.underglow.applyConfig({ blobRadius: value }); break;
      case 'head.intensity': if (this.carLights) this.carLights.applyConfig({ intensity: value }); break;
      case 'head.distance': if (this.carLights) this.carLights.applyConfig({ distance: value }); break;
      case 'head.angle': if (this.carLights) this.carLights.applyConfig({ angle: value }); break;
      case 'head.aimDistance': if (this.carLights) this.carLights.applyConfig({ aimDistance: value }); break;
      case 'head.aimDrop': if (this.carLights) this.carLights.applyConfig({ aimDrop: value }); break;
      case 'head.offsetX': if (this.carLights) this.carLights.applyConfig({ offsetX: value }); break;
      case 'head.offsetY': if (this.carLights) this.carLights.applyConfig({ offsetY: value }); break;
      case 'head.offsetZ': if (this.carLights) this.carLights.applyConfig({ offsetZ: value }); break;
      case 'head.manualFlip': if (this.carLights) this.carLights.applyConfig({ manualFlip: value >= 0.5 }); break;
      case 'brake.tailGlow': if (this.carLights) this.carLights.applyConfig({ tailGlow: value }); break;
      case 'brake.boost': if (this.carLights) this.carLights.applyConfig({ brakeBoost: value }); break;
      case 'brake.intensity': if (this.carLights) this.carLights.applyConfig({ brakeLightIntensity: value }); break;
      case 'brake.tailIntensity': if (this.carLights) this.carLights.applyConfig({ tailLightIntensity: value }); break;
      case 'brake.distance': if (this.carLights) this.carLights.applyConfig({ brakeLightDistance: value }); break;
      case 'photo.speed': if (this.photo) this.photo.speed = value; break;
    }
  }

  _applyWeatherPreset(index) {
    if (this.weatherEngine) {
      this.weatherEngine.setPreset(index);
      this.weather = this.weatherEngine.state;
    }
  }

  getState() {
    const car = this.carLights ? this.carLights.cfg : null;
    const gr = this.grade ? this.grade.material.uniforms : null;
    const god = this.godrays ? this.godrays.material.uniforms : null;
    const ug = this.underglow ? this.underglow.cfg : null;
    const toneIndex = this.renderer ? TONE_MODES.findIndex((t) => t.value === this.renderer.toneMapping) : DEFAULT_TONE_INDEX;
    return {
      preset: this.preset,
      fps: this.fps(),
      hourLabel: hourLabel(this.skyActive ? this.skyHour : null),
      guardStep: this.perfGuard.stepName,
      toggles: {
        ao: !!(this.n8ao && this.n8ao.enabled),
        bloom: !!(this.bloom && this.bloom.enabled),
        ssr: !!(this.ssr && this.ssr.enabled),
        godrays: !!(this.godrays && this.godrays.enabled),
        grade: !!(this.grade && this.grade.enabled),
        smaa: !!(this.smaa && this.smaa.enabled),
        underglow: !!(this.underglow && this.underglow.enabled),
        underglowPulse: !!(this.underglow && this.underglow.cfg.pulse),
        perfguard: this.perfGuard.enabled,
        carlights: this.carLightsEnabled,
        otherHeadlights: !!(this.carLights && this.carLights.cfg.otherHeadlightsEnabled),
        headlightsForce: this.headlightsForce,
        photo: !!(this.photo && this.photo.active),
        lightning: !!this.weather.lightning,
        bloomDebug: this.bloomDebugHighlight,
        godraysDebug: this.godraysDebug,
      },
      params: {
        'weather.preset': this.weather.preset,
        'weather.rain': this.weather.rainRate,
        'weather.wetness': this.weather.wetness,
        'weather.puddles': this.weather.puddles,
        'weather.clouds': this.weather.cloudCover,
        'weather.fog': this.weather.fogDensity,
        'weather.droplets': this.weather.droplets,
        'weather.wind': this.weather.wind,
        'weather.storm': this.weather.storm,
        'weather.intensity': this.weather.intensity,
        'weather.transition': this.weather.transition,
        toneMode: toneIndex >= 0 ? toneIndex : DEFAULT_TONE_INDEX,
        exposure: this.renderer ? this.renderer.toneMappingExposure : 1,
        envIntensity: this.lastScene ? (this.lastScene.environmentIntensity ?? 1) : 1,
        hour: this.skyActive ? this.skyHour : 12,
        'ao.intensity': this.n8ao ? this.n8ao.configuration.intensity : 0,
        'ao.radius': this.n8ao ? this.n8ao.configuration.aoRadius : 0,
        'ao.falloff': this.n8ao ? this.n8ao.configuration.distanceFalloff : 0,
        'ao.halfRes': this.n8ao && this.n8ao.configuration.halfRes ? 1 : 0,
        'ao.renderMode': this.n8ao ? this.n8ao.configuration.renderMode : 0,
        'bloom.strength': this.bloom ? this.bloom.strength : 0,
        'bloom.radius': this.bloom ? this.bloom.radius : 0,
        'bloom.threshold': this.bloom ? this.bloom.threshold : 0,
        'ssr.opacity': this.ssr ? this.ssr.opacity : 0,
        'ssr.maxDistance': this.ssr ? this.ssr.maxDistance : 0,
        'ssr.thickness': this.ssr ? this.ssr.thickness : 0,
        'godrays.intensity': this.godraysStrength || 0,
        'godrays.exposure': god ? god.exposure.value : 0,
        'godrays.threshold': god ? god.threshold.value : 0,
        'grade.contrast': gr ? gr.contrast.value : 1,
        'grade.saturation': gr ? gr.saturation.value : 1,
        'grade.vignette': gr ? gr.vignette.value : 0,
        'grade.split': gr ? gr.splitStrength.value : 0,
        'underglow.intensity': ug ? ug.stripIntensity : 0,
        'underglow.blobOpacity': ug ? ug.blobOpacity : 0,
        'underglow.blobRadius': ug ? ug.blobRadius : 0,
        'head.intensity': car ? car.intensity : 0,
        'head.distance': car ? car.distance : 0,
        'head.angle': car ? car.angle : 0,
        'head.aimDistance': car ? car.aimDistance : 0,
        'head.aimDrop': car ? car.aimDrop : 0,
        'head.offsetX': car ? car.offsetX : 0,
        'head.offsetY': car ? car.offsetY : 0,
        'head.offsetZ': car ? car.offsetZ : 0,
        'head.manualFlip': car && car.manualFlip ? 1 : 0,
        'brake.tailGlow': car ? car.tailGlow : 0,
        'brake.boost': car ? car.brakeBoost : 0,
        'brake.intensity': car ? car.brakeLightIntensity : 0,
        'brake.tailIntensity': car ? car.tailLightIntensity : 0,
        'brake.distance': car ? car.brakeLightDistance : 0,
        'photo.speed': this.photo ? this.photo.speed : 0,
      },
    };
  }

  overrideSun(vec) {
    if (!this.sky || !this.skyActive || this.envOnly) return;
    const len = vec.length() || 20;
    vec.copy(this.sky.getSunDir()).multiplyScalar(len);
  }
}

const PRESET_NAMES = ['Off', 'Balanced', 'Enhanced', 'Semi-Real', 'Photoreal', 'Very Low'];
const PANEL_TOGGLES = [
  ['Performance'],
  ['perfguard', 'Auto Perf Guard'],
  ['Effects'],
  ['ao', 'Ambient Occlusion'],
  ['bloom', 'Bloom'],
  ['ssr', 'SSR reflections'],
  ['godrays', 'God Rays'],
  ['grade', 'Color Grade'],
  ['smaa', 'Anti-alias (SMAA)'],
  ['underglow', 'Underglow'],
  ['underglowPulse', 'Underglow Pulse'],
  ['carlights', 'Car Lights'],
  ['otherHeadlights', "Other Cars' Headlights"],
  ['headlightsForce', 'Force Headlights'],
  ['photo', 'Photo Mode'],
  ...(WEATHER_ENABLED ? [['lightning', 'Lightning']] : []),
  ['Debug'],
  ['bloomDebug', 'Highlight Bloom Overflow (magenta)'],
  ['godraysDebug', 'God Ray Sun Position + Threshold (cyan)'],
];
const PANEL_SLIDERS = [
  ...(WEATHER_ENABLED ? [
    ['Weather'],
    ['Preset', 'weather.preset', 0, WEATHER_NAMES.length - 1, 1],
    ['Transition', 'weather.transition', 0.1, 12, 0.1],
    ['Intensity', 'weather.intensity', 0, 1, 0.01],
    ['Rain rate', 'weather.rain', 0, 1, 0.01],
    ['Wetness', 'weather.wetness', 0, 1, 0.01],
    ['Puddles', 'weather.puddles', 0, 1, 0.01],
    ['Cloud cover', 'weather.clouds', 0, 1, 0.01],
    ['Fog density', 'weather.fog', 0, 0.18, 0.005],
    ['Lens droplets', 'weather.droplets', 0, 1, 0.01],
    ['Wind', 'weather.wind', -1, 1, 0.01],
    ['Storm', 'weather.storm', 0, 1, 0.01],
  ] : []),
  ['Time of Day'],
  ['Hour', 'hour', 0, 24, 0.1],
  ['Global'],
  ['Tone mapping', 'toneMode', 0, TONE_MODES.length - 1, 1],
  ['Exposure', 'exposure', 0.2, 2, 0.01],
  ['IBL intensity', 'envIntensity', 0, 1.5, 0.01],
  ['Ambient Occlusion'],
  ['AO intensity', 'ao.intensity', 0, 6, 0.05],
  ['AO radius', 'ao.radius', 0.1, 6, 0.05],
  ['AO falloff', 'ao.falloff', 0.1, 4, 0.05],
  ['AO half-res', 'ao.halfRes', 0, 1, 1],
  ['AO render mode (0 combined, 1 AO only, 2 no AO, 3 split, 4 split AO)', 'ao.renderMode', 0, 4, 1],
  ['Bloom'],
  ['Bloom strength', 'bloom.strength', 0, 1.5, 0.01],
  ['Bloom radius', 'bloom.radius', 0, 1, 0.01],
  ['Bloom threshold', 'bloom.threshold', 0, 2, 0.01],
  ['Reflections'],
  ['SSR opacity', 'ssr.opacity', 0, 1, 0.01],
  ['SSR distance', 'ssr.maxDistance', 0, 40, 0.5],
  ['SSR thickness', 'ssr.thickness', 0, 0.5, 0.005],
  ['God Rays'],
  ['Ray intensity', 'godrays.intensity', 0, 2, 0.01],
  ['Ray exposure', 'godrays.exposure', 0, 0.5, 0.005],
  ['Ray threshold', 'godrays.threshold', 0, 1.2, 0.01],
  ['Color Grade'],
  ['Contrast', 'grade.contrast', 0.5, 1.6, 0.01],
  ['Saturation', 'grade.saturation', 0, 2, 0.01],
  ['Vignette', 'grade.vignette', 0, 0.8, 0.01],
  ['Split-tone', 'grade.split', 0, 1, 0.01],
  ['Underglow'],
  ['Strip intensity', 'underglow.intensity', 0, 3, 0.05],
  ['Blob opacity', 'underglow.blobOpacity', 0, 1, 0.02],
  ['Blob radius', 'underglow.blobRadius', 0.3, 4, 0.05],
  ['Headlights'],
  ['Intensity', 'head.intensity', 0, 2500, 20],
  ['Range', 'head.distance', 4, 60, 1],
  ['Cone angle', 'head.angle', 0.1, 1.2, 0.02],
  ['Aim distance', 'head.aimDistance', 2, 40, 0.5],
  ['Aim drop', 'head.aimDrop', -2, 3, 0.05],
  ['Offset X', 'head.offsetX', -1.5, 1.5, 0.02],
  ['Offset Y', 'head.offsetY', -1.5, 1.5, 0.02],
  ['Offset Z', 'head.offsetZ', -1.5, 1.5, 0.02],
  ['Flip direction', 'head.manualFlip', 0, 1, 1],
  ['Brake / Tail Lights'],
  ['Tail glow', 'brake.tailGlow', 0, 2, 0.02],
  ['Brake boost', 'brake.boost', 1, 8, 0.1],
  ['Brake spill', 'brake.intensity', 0, 250, 5],
  ['Tail spill', 'brake.tailIntensity', 0, 80, 2],
  ['Rear range', 'brake.distance', 1, 10, 0.2],
  ['Photo Mode'],
  ['Fly speed', 'photo.speed', 1, 60, 1],
];

const PANEL_CSS = `
.polyfx-panel{position:fixed;top:16px;left:16px;z-index:99999;width:324px;max-height:90vh;overflow-y:auto;display:none;font-family:ForcedSquare,Arial,sans-serif;color:var(--text-color,#fff);background:var(--surface-transparent-color,rgba(33,43,82,.68));border:2px solid var(--surface-color,#28346a);border-radius:8px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.55);backdrop-filter:blur(4px);user-select:none}
.polyfx-panel .pf-header{display:flex;justify-content:space-between;align-items:baseline;font-size:24px;margin-bottom:10px}.polyfx-panel .pf-sub{font-size:14px;color:#9fb0e0}.polyfx-panel .pf-sep{margin:12px 0 4px;font-size:15px;color:#8ea2d6;text-transform:uppercase}.polyfx-panel .pf-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:5px 0;font-size:17px}.polyfx-panel .pf-btn{font-family:inherit;font-size:15px;color:var(--text-color,#fff);background:var(--button-color,#112052);border:none;border-radius:6px;padding:5px 14px;cursor:pointer;min-width:56px}.polyfx-panel .pf-btn.on{background:#2f63c6}.polyfx-panel .pf-slider{margin:6px 0;font-size:15px}.polyfx-panel .pf-slider .pf-top{display:flex;justify-content:space-between;gap:8px}.polyfx-panel .pf-val{color:#9fd0ff}.polyfx-panel input[type=range]{width:100%;accent-color:#2f63c6;height:4px;margin-top:3px}.polyfx-panel .pf-hint{margin-top:10px;font-size:13px;color:#7f90bd}
`;

class PolyFXPanel {
  constructor(fx) {
    this.fx = fx;
    this.visible = false;
    this.buttons = {};
    this.sliders = {};
    if (!document.getElementById('polyfx-panel-style')) {
      const style = document.createElement('style');
      style.id = 'polyfx-panel-style';
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
    }

    const el = document.createElement('div');
    el.className = 'polyfx-panel';
    this.header = document.createElement('div');
    this.header.className = 'pf-header';
    el.appendChild(this.header);

    for (const item of PANEL_TOGGLES) {
      if (item.length === 1) { el.appendChild(this._sep(item[0])); continue; }
      const [key, label] = item;
      this.buttons[key] = this._buttonRow(el, label, () => {
        const on = !this.buttons[key].classList.contains('on');
        fx.toggleEffect(key, on);
        this._setButton(this.buttons[key], on);
      });
    }

    for (const item of PANEL_SLIDERS) {
      if (item.length === 1) {
        el.appendChild(this._sep(item[0]));
        continue;
      }
      const [label, path, min, max, step] = item;
      const row = document.createElement('div');
      row.className = 'pf-slider';
      const top = document.createElement('div');
      top.className = 'pf-top';
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'pf-val';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.oninput = () => {
        const v = parseFloat(input.value);
        val.textContent = this._format(v, step, path);
        fx.setParam(path, v);
        if (path === 'weather.preset') this.refresh();
      };
      top.appendChild(name);
      top.appendChild(val);
      row.appendChild(top);
      row.appendChild(input);
      el.appendChild(row);
      this.sliders[path] = { input, val, step };
    }

    const hint = document.createElement('div');
    hint.className = 'pf-hint';
    hint.textContent = 'Press L to close (rebindable in PolyModLoader keybinds). F2 toggles photo mode; F9 saves a PNG.';
    el.appendChild(hint);
    document.body.appendChild(el);
    this.el = el;
  }

  _sep(text) {
    const div = document.createElement('div');
    div.className = 'pf-sep';
    div.textContent = text;
    return div;
  }

  _buttonRow(parent, label, onClick) {
    const row = document.createElement('div');
    row.className = 'pf-row';
    const span = document.createElement('span');
    span.textContent = label;
    const button = document.createElement('button');
    button.className = 'pf-btn';
    button.textContent = 'OFF';
    button.onclick = onClick;
    row.appendChild(span);
    row.appendChild(button);
    parent.appendChild(row);
    return button;
  }

  _setButton(button, on) {
    button.classList.toggle('on', !!on);
    button.textContent = on ? 'ON' : 'OFF';
  }

  _format(value, step, path = '') {
    if (path === 'weather.preset') return WEATHER_NAMES[Math.round(value)] || 'Custom';
    if (path === 'toneMode') return (TONE_MODES[Math.round(value)] || TONE_MODES[DEFAULT_TONE_INDEX]).name;
    return step >= 1 ? String(Math.round(value)) : Number(value).toFixed(step < 0.01 ? 3 : 2);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this.refresh();
  }

  refresh() {
    if (!this.visible) return;
    const state = this.fx.getState();
    for (const item of PANEL_TOGGLES) {
      if (item.length === 1) continue;
      const [key] = item;
      if (this.buttons[key]) this._setButton(this.buttons[key], state.toggles[key]);
    }
    for (const path in this.sliders) {
      const slider = this.sliders[path];
      const value = state.params[path];
      if (value == null) continue;
      slider.input.value = value;
      slider.val.textContent = this._format(Number(value), Number(slider.step), path);
    }
    this.tick();
  }

  tick() {
    if (!this.visible) return;
    const state = this.fx.getState();
    const fpsColor = state.fps >= 55 ? '#9fe0a0' : state.fps >= 30 ? '#e8d07f' : '#e88f8f';
    const guardNote = state.guardStep !== 'full' ? ' <span class="pf-sub">(guard: ' + state.guardStep + ')</span>' : '';
    this.header.innerHTML = '<span>PolyFX <span class="pf-sub">' + (PRESET_NAMES[state.preset] || '?') + ' - ' + state.hourLabel + '</span></span><span style="color:' + fpsColor + '">' + state.fps + ' fps' + guardNote + '</span>';
  }
}

window.__PolyFX = new PolyFX();
// Keybinds are registered through PML (see main.mod.js) and don't exist at all in this
// direct-patch/dev flavor, which never loads main.mod.js — say so instead of naming a key that
// does nothing here.
console.log(
  window.polyModLoader
    ? '[PolyFX] loaded - L for tuning, F2 photo mode, F9 screenshot (rebindable in PolyModLoader keybinds)'
    : '[PolyFX] loaded (dev/direct-patch mode, no PolyModLoader keybinds) - try window.__PolyFX.panel.toggle(), .setPresetOverride(n), .setAoOverride(n) from the console',
);
