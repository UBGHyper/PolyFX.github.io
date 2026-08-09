// PolyFX Atmosphere — a real day/night system.
// ---------------------------------------------------------------------------
// Drives the sun direction from a time of day, renders an atmospheric sky dome
// (Rayleigh/Mie scattering) plus a procedural cloud layer, relights the scene
// (directional + hemisphere lights, fog), and rebuilds a sky-matched reflection
// environment map so reflections match the time of day.

import * as THREE from './vendor/three.module.js';
import { Sky } from './vendor/addons/objects/Sky.js';

const DEG = Math.PI / 180;

// Sun unit direction for a given hour (0..24). Sunrise ~6h, sunset ~18h.
export function sunDirForHour(h) {
  const t = (h - 6) / 12;                     // 0 at sunrise, 1 at sunset
  const ang = t * Math.PI;                    // 0..PI across the day
  const elev = Math.sin(ang) * 78 * DEG;      // negative below horizon at night
  const azi = (t - 0.5) * Math.PI * 0.9;      // sweep E→W, 0 at noon
  const ch = Math.cos(elev);
  return new THREE.Vector3(ch * Math.sin(azi), Math.sin(elev), -ch * Math.cos(azi)).normalize();
}

// Colour/intensity keyframes by sun elevation (y of the unit sun direction).
function stop(sunC, sunI, skyC, grndC, hemiI, fogC, cloudC, sky) {
  return {
    sun: new THREE.Color(...sunC), sunI,
    hemiSky: new THREE.Color(...skyC), hemiGround: new THREE.Color(...grndC), hemiI,
    fog: new THREE.Color(...fogC), cloud: new THREE.Color(...cloudC), sky,
  };
}
const NIGHT  = stop([0.35, 0.45, 0.72], 0.22, [0.06, 0.09, 0.18], [0.03, 0.04, 0.07], 0.35, [0.05, 0.07, 0.13], [0.15, 0.18, 0.28], { turbidity: 4, rayleigh: 0.7, mie: 0.004, mieG: 0.8 });
const SUNSET = stop([1.0, 0.5, 0.24],   2.6,  [0.55, 0.42, 0.45], [0.22, 0.15, 0.12], 0.8,  [0.72, 0.5, 0.42],  [0.95, 0.62, 0.45], { turbidity: 8, rayleigh: 2.4, mie: 0.010, mieG: 0.86 });
const DAY    = stop([1.0, 0.98, 0.92],  4.25, [0.46, 0.66, 0.86], [0.55, 0.68, 0.62], 0.92, [0.50, 0.66, 0.82], [0.86, 0.91, 0.94], { turbidity: 1.8, rayleigh: 0.86, mie: 0.004, mieG: 0.78 });

function lerpN(a, b, f) { return a + (b - a) * f; }
function lerpStop(a, b, f) {
  return {
    sun: a.sun.clone().lerp(b.sun, f), sunI: lerpN(a.sunI, b.sunI, f),
    hemiSky: a.hemiSky.clone().lerp(b.hemiSky, f), hemiGround: a.hemiGround.clone().lerp(b.hemiGround, f),
    hemiI: lerpN(a.hemiI, b.hemiI, f),
    fog: a.fog.clone().lerp(b.fog, f), cloud: a.cloud.clone().lerp(b.cloud, f),
    sky: {
      turbidity: lerpN(a.sky.turbidity, b.sky.turbidity, f), rayleigh: lerpN(a.sky.rayleigh, b.sky.rayleigh, f),
      mie: lerpN(a.sky.mie, b.sky.mie, f), mieG: lerpN(a.sky.mieG, b.sky.mieG, f),
    },
  };
}
function sampleSky(elevY) {
  if (elevY <= -0.10) return NIGHT;
  if (elevY < 0.06) return lerpStop(NIGHT, SUNSET, (elevY + 0.10) / 0.16);
  if (elevY < 0.45) return lerpStop(SUNSET, DAY, (elevY - 0.06) / 0.39);
  return DAY;
}

// Soft radial-gradient circle texture, generated on a canvas (no asset needed).
// Shared with underglow.js for its road-blob decal.
export function radialTexture(inner, outer, stops) {
  const size = 128, c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * inner, size / 2, size / 2, size * outer);
  for (const [t, col] of stops) g.addColorStop(t, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural cloud layer: fbm noise projected onto a sky-plane, scrolling.
const CloudShader = {
  uniforms: {
    uTime: { value: 0 }, uCoverage: { value: 0.44 }, uOpacity: { value: 0.85 },
    uColor: { value: new THREE.Color(1, 1, 1) }, uColorDark: { value: new THREE.Color(0.6, 0.63, 0.7) },
  },
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w; // pin to the far plane so the game's near far clip never culls the clouds
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vDir;
    uniform float uTime, uCoverage, uOpacity;
    uniform vec3 uColor, uColorDark;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
    }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.02; a *= 0.5; } return v; }
    void main(){
      float y = vDir.y;
      if (y <= 0.03) discard;
      vec2 p = vDir.xz / (y + 0.12);
      p = p * 1.1 + vec2(uTime * 0.004, uTime * 0.0015);
      float n = fbm(p * 1.6);
      float d = smoothstep(uCoverage, uCoverage + 0.30, n);
      if (d <= 0.001) discard;
      float horizon = smoothstep(0.03, 0.30, y);
      vec3 col = mix(uColorDark, uColor, smoothstep(0.0, 1.0, d));
      gl_FragColor = vec4(col, d * horizon * uOpacity);
    }
  `,
};

export class SkySystem {
  constructor(renderer) {
    this.renderer = renderer;
    this.active = false;
    this.hour = 12;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, 1, 0);
    this.envTexture = null;
    this.ambientTint = new THREE.Color(1, 1, 1); // current scene brightness/colour — for unlit effects (e.g. smoke) that ignore real lights
    this._attached = null;
    this._orig = null;
    this._origLights = null;
    this._lights = { dir: [], hemi: [] };
    this._envHour = -999;
    this._envT = 0;
    this._envRT = null;
    this._nativeSky = undefined; // undefined = not yet scanned, null = none found
    this._fullEngaged = false; // whether the visible dome/clouds/relight are currently applied (vs envOnly)

    this.sky = new Sky();
    this.sky.scale.setScalar(450000);
    this.sky.renderOrder = -3;
    this.sky.material.depthWrite = false;

    const cloudGeo = new THREE.SphereGeometry(400000, 32, 16);
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CloudShader.uniforms),
      vertexShader: CloudShader.vertexShader, fragmentShader: CloudShader.fragmentShader,
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    });
    this.clouds = new THREE.Mesh(cloudGeo, this.cloudMat);
    this.clouds.renderOrder = -2.5;

    // Moon billboard and star field sit at a real distance WITHIN the game's
    // camera far plane (maxViewDistance = 10000) — unlike the sky/cloud dome,
    // Sprite/Points materials don't support the "pin to far plane" trick, so
    // anything placed further out would be silently frustum-culled.
    const SKY_RADIUS = 9000;

    // Moon billboard.
    const moonTex = radialTexture(0, 0.5, [[0, 'rgba(255,255,250,1)'], [0.6, 'rgba(255,255,250,0.9)'], [1, 'rgba(255,255,250,0)']]);
    this.moonMat = new THREE.SpriteMaterial({ map: moonTex, color: 0xffffff, transparent: true, depthWrite: false, fog: false, opacity: 0 });
    this.moon = new THREE.Sprite(this.moonMat);
    this.moon.scale.setScalar(450);
    this.moon.renderOrder = -2.8;
    this._moonDist = SKY_RADIUS;

    // Moon light (dim, cool). Tagged so our own light-scan (which recolors the
    // game's sun light to match time of day) skips over it.
    this.moonLight = new THREE.DirectionalLight(0x8fa8ff, 0);
    this.moonLight.userData.__polyfxOwned = true;
    this._moonLightAdded = false;

    // Star field: sprinkled points on the upper hemisphere, faded in at night.
    const starCount = 700, starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u, phi = Math.acos(1 - v * 0.92); // upper hemisphere-ish
      starPos[i * 3] = SKY_RADIUS * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = SKY_RADIUS * Math.cos(phi);
      starPos[i * 3 + 2] = SKY_RADIUS * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starTex = radialTexture(0, 0.5, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    this.starMat = new THREE.PointsMaterial({ size: 60, map: starTex, transparent: true, depthWrite: false, fog: false, opacity: 0, sizeAttenuation: true });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -2.9;

    // Dedicated tiny scene for rebuilding the reflection env-map from the sky.
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._envScene = new THREE.Scene();
    this._envSky = new Sky();
    this._envSky.scale.setScalar(450000);
    this._envScene.add(this._envSky);
  }

  // The game renders its own sky/cloud dome (a huge sphere, hardcoded blue/white
  // gradient, always visible) independent of our atmosphere. We hide it while
  // active so night can actually go dark, and restore it when deactivated.
  _findNativeSky(scene) {
    if (this._nativeSky !== undefined) return this._nativeSky;
    let found = null;
    scene.traverse((o) => {
      if (found || !o.isMesh || !o.material || !o.material.uniforms) return;
      const u = o.material.uniforms;
      if (u.cloudDensity && u.sunPosition && u.cloudLight) found = o;
    });
    this._nativeSky = found || null;
    return this._nativeSky;
  }

  attach(scene) {
    if (this._attached === scene) return;
    this._attached = scene;
    this._orig = {
      fog: scene.fog ? scene.fog.color.clone() : null,
      fogNear: scene.fog ? scene.fog.near : 0,
    };
  }

  // Fed by runtime.js's shared scene scan (see PolyFX._sharedScan) instead of
  // doing its own scene.traverse — `capture` should be true exactly once, on
  // the very first scan of a session, so original light state is recorded
  // before we start recolouring anything.
  ingestLights(dir, hemi, capture) {
    if (capture || !this._origLights) this._origLights = new Map();
    for (const l of dir) if (!this._origLights.has(l)) this._origLights.set(l, { color: l.color.clone(), intensity: l.intensity });
    for (const l of hemi) if (!this._origLights.has(l)) this._origLights.set(l, { color: l.color.clone(), ground: l.groundColor.clone(), intensity: l.intensity });
    this._lights = { dir, hemi };
  }

  setState(active, hour) { this.active = active; if (hour != null) this.hour = hour; }

  // `envOnly`: refresh the reflection/IBL environment map (for material
  // ambient + reflections) WITHOUT touching the visible sky, clouds, scene
  // lights, or fog. Used for "Default" time of day on Enhanced+ presets — the
  // whole point of that tier is to light the track properly, not to force a
  // different-looking sky on top of a game whose stock sky already looks
  // good; the full atmosphere (day/night dome, procedural clouds, relighting)
  // only engages once the player explicitly picks a time of day.
  update(scene, camera, envOnly = false) {
    if (!this.active) { this._deactivate(scene); this._fullEngaged = false; return; }
    this.attach(scene);

    this.sunDir.copy(sunDirForHour(this.hour));
    const s = sampleSky(this.sunDir.y);
    this._updateEnv(s); // cheap (internally rate-limited) — keep the IBL fresh either way

    if (envOnly) {
      if (this._fullEngaged) { this._retractVisuals(scene); this._fullEngaged = false; }
      return;
    }
    this._fullEngaged = true;

    const nativeSky = this._findNativeSky(scene);
    if (nativeSky && nativeSky.visible) nativeSky.visible = false;

    const now = performance.now();
    const nightF = THREE.MathUtils.clamp(-this.sunDir.y * 3.0, 0, 1); // 0 day .. 1 well below horizon

    // Sky dome.
    if (this.sky.parent !== scene) scene.add(this.sky);
    this.sky.position.copy(camera.position);
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = s.sky.turbidity; u.rayleigh.value = s.sky.rayleigh;
    u.mieCoefficient.value = s.sky.mie; u.mieDirectionalG.value = s.sky.mieG;

    // Clouds.
    if (this.clouds.parent !== scene) scene.add(this.clouds);
    this.clouds.position.copy(camera.position);
    const cu = this.cloudMat.uniforms;
    cu.uTime.value = now * 0.001;
    cu.uColor.value.copy(s.cloud);
    cu.uColorDark.value.copy(s.cloud).multiplyScalar(0.62);
    cu.uOpacity.value = 0.16 + 0.30 * THREE.MathUtils.clamp(this.sunDir.y + 0.3, 0, 1);

    // Moon + stars, fading in as the sun sets.
    this.moonDir.set(-this.sunDir.x, 0.55, -this.sunDir.z).normalize();
    if (this.moon.parent !== scene) scene.add(this.moon);
    this.moon.position.copy(camera.position).addScaledVector(this.moonDir, this._moonDist);
    this.moonMat.opacity = nightF;
    if (this.stars.parent !== scene) scene.add(this.stars);
    this.stars.position.copy(camera.position);
    this.starMat.opacity = nightF * 0.9;
    if (!this._moonLightAdded) { scene.add(this.moonLight); scene.add(this.moonLight.target); this._moonLightAdded = true; }
    this.moonLight.position.copy(camera.position).addScaledVector(this.moonDir, 100);
    this.moonLight.target.position.copy(camera.position);
    this.moonLight.intensity = nightF * 0.35;

    // Approximate brightness/colour for materials that ignore real lights
    // entirely (e.g. the game's particle smoke, which is unlit MeshBasicMaterial).
    const brightness = THREE.MathUtils.clamp(s.sunI / 4.7, 0.16, 1.0);
    this.ambientTint.copy(s.sun).lerp(s.hemiSky, 0.5).multiplyScalar(brightness);

    // Relight.
    for (const l of this._lights.dir) {
      l.color.copy(s.sun);
      const base = this._origLights.get(l);
      l.intensity = (base ? base.intensity : 4.7) * (s.sunI / 4.7);
    }
    for (const l of this._lights.hemi) {
      l.color.copy(s.hemiSky); l.groundColor.copy(s.hemiGround);
      const base = this._origLights.get(l);
      l.intensity = (base ? base.intensity : 1.0) * s.hemiI;
    }

    // Fog: match horizon colour. Only ever push the near plane FARTHER out
    // (a floor, not a clamp) so an already-loose fog setting is never made
    // heavier — this used to unconditionally overwrite `near`, which hazed
    // the horizon once the sky system is active more of the time (see the
    // "Default" time-of-day handling in runtime.js).
    if (scene.fog) {
      scene.fog.color.copy(s.fog);
      if ('near' in scene.fog) {
        const minNear = (scene.fog.far || 10000) * 0.55;
        if (scene.fog.near < minNear) scene.fog.near = minNear;
      }
    }

  }

  // Rebuild the reflection env-map from the sky when the time changes enough.
  // Sources sun direction + sky params directly (not from the visible dome's
  // material uniforms) so this works whether or not the visible dome is
  // actually being updated this frame (see envOnly above).
  _updateEnv(s) {
    const now = performance.now();
    if (this._envRT && Math.abs(this.hour - this._envHour) < 0.25) return;
    if (now - this._envT < 400) return;
    this._envT = now; this._envHour = this.hour;
    const eu = this._envSky.material.uniforms;
    eu.sunPosition.value.copy(this.sunDir);
    eu.turbidity.value = s.sky.turbidity; eu.rayleigh.value = s.sky.rayleigh;
    eu.mieCoefficient.value = s.sky.mie; eu.mieDirectionalG.value = s.sky.mieG;
    const old = this._envRT;
    try {
      this._envRT = this._pmrem.fromScene(this._envScene);
      this.envTexture = this._envRT.texture;
      if (old) old.dispose();
    } catch (e) { console.warn('[PolyFX] env rebuild failed:', e); }
  }

  // Undoes everything the full-atmosphere path (dome, clouds, moon, stars,
  // relighting, fog) changed, WITHOUT touching envTexture — shared by
  // _deactivate (sky system off entirely) and the envOnly transition (sky
  // system still on, just dropping back to IBL-only).
  _retractVisuals(scene) {
    if (this.sky.parent) this.sky.parent.remove(this.sky);
    if (this.clouds.parent) this.clouds.parent.remove(this.clouds);
    if (this.moon.parent) this.moon.parent.remove(this.moon);
    if (this.stars.parent) this.stars.parent.remove(this.stars);
    if (this._moonLightAdded) {
      if (this.moonLight.parent) this.moonLight.parent.remove(this.moonLight);
      if (this.moonLight.target.parent) this.moonLight.target.parent.remove(this.moonLight.target);
      this._moonLightAdded = false;
    }
    if (this._nativeSky) this._nativeSky.visible = true;
    if (!this._origLights) return;
    for (const l of this._lights.dir) { const b = this._origLights.get(l); if (b) { l.color.copy(b.color); l.intensity = b.intensity; } }
    for (const l of this._lights.hemi) { const b = this._origLights.get(l); if (b) { l.color.copy(b.color); l.groundColor.copy(b.ground); l.intensity = b.intensity; } }
    if (scene && scene.fog && this._orig) {
      if (this._orig.fog) scene.fog.color.copy(this._orig.fog);
      if ('near' in scene.fog) scene.fog.near = this._orig.fogNear;
    }
  }

  _deactivate(scene) {
    this._retractVisuals(scene);
    this.envTexture = null;
    this.ambientTint.set(1, 1, 1);
  }

  getSunDir() { return this.sunDir; }
}
