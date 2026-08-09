import * as THREE from './vendor/three.module.js';

export const WEATHER_NAMES = [
  'Clear',
  'Partly Cloudy',
  'Overcast',
  'Mist',
  'Fog',
  'Drizzle',
  'Rain',
  'Heavy Rain',
  'Storm',
  'Wet Road',
];

const PROFILE_KEYS = ['rainRate', 'cloudCover', 'fogDensity', 'storm', 'wind', 'temperature', 'wetTarget', 'puddleTarget', 'droplets'];
export const WEATHER_PROFILES = [
  profile(0, 0.26, 0, 0, 0.08, 0.62, 0, 0, 0),
  profile(0, 0.48, 0.008, 0, 0.12, 0.58, 0.02, 0, 0),
  profile(0, 0.82, 0.026, 0, 0.18, 0.52, 0.10, 0.02, 0),
  profile(0, 0.62, 0.060, 0, 0.04, 0.50, 0.06, 0, 0),
  profile(0, 0.74, 0.115, 0, 0.03, 0.48, 0.08, 0, 0),
  profile(0.20, 0.78, 0.042, 0.05, 0.16, 0.50, 0.36, 0.10, 0.18),
  profile(0.52, 0.88, 0.054, 0.12, 0.26, 0.46, 0.68, 0.30, 0.46),
  profile(0.82, 0.96, 0.072, 0.34, 0.38, 0.42, 0.92, 0.58, 0.72),
  profile(1.00, 1.00, 0.085, 1.00, 0.58, 0.38, 1.00, 0.76, 0.92),
  profile(0.00, 0.56, 0.020, 0.00, 0.10, 0.54, 0.64, 0.42, 0.10),
];

function profile(rainRate, cloudCover, fogDensity, storm, wind, temperature, wetTarget, puddleTarget, droplets) {
  return { rainRate, cloudCover, fogDensity, storm, wind, temperature, wetTarget, puddleTarget, droplets };
}

function clamp01(v) { return THREE.MathUtils.clamp(v, 0, 1); }
function lerp(a, b, t) { return a + (b - a) * t; }
function approach(a, b, step) {
  if (a < b) return Math.min(b, a + step);
  return Math.max(b, a - step);
}

function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

class SurfaceRegistry {
  constructor() {
    this.entries = new Map();
    this.scanT = 0;
    this.debug = false;
    this.debugMats = new Set();
  }

  update(scene, force = false) {
    const now = performance.now();
    if (!force && now - this.scanT < 1400) return;
    this.scanT = now;
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = materialList(o.material);
      for (const m of mats) {
        if (!m || !m.isMeshStandardMaterial || this.entries.has(m)) continue;
        const kind = this._classify(o, m);
        this.entries.set(m, {
          object: o,
          kind,
          orig: {
            roughness: m.roughness,
            metalness: m.metalness,
            envMapIntensity: m.envMapIntensity,
            color: m.color ? m.color.clone() : null,
          },
        });
      }
    });
  }

  _classify(o, m) {
    const name = ((o.name || '') + ' ' + (m.name || '')).toLowerCase();
    if (m.name === 'BrakeLight') return 'emissive';
    if (m.name === 'Main') return 'carPaint';
    if (m.name === 'Metal' || m.name === 'Rim' || name.includes('rim') || name.includes('wheel')) return 'metal';
    if (name.includes('road') || name.includes('track') || name.includes('asphalt') || name.includes('floor')) return 'road';
    if (name.includes('kerb') || name.includes('curb') || name.includes('stripe')) return 'paintedRoad';
    if (name.includes('grass') || name.includes('hill') || name.includes('mountain') || name.includes('terrain')) return 'terrain';
    const c = m.color;
    const grey = c ? Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 0.10 : false;
    if (grey && c.r > 0.25 && c.r < 0.72) return 'roadCandidate';
    return 'general';
  }

  apply({ envIntensity, photoreal, wetness, puddles, overcast, time }) {
    for (const [m, entry] of this.entries) {
      if (!m || !m.isMeshStandardMaterial) continue;
      const orig = entry.orig;
      m.roughness = orig.roughness;
      m.metalness = orig.metalness;
      m.envMapIntensity = orig.envMapIntensity;
      if (orig.color && m.color) m.color.copy(orig.color);

      if (entry.kind === 'emissive') {
        m.roughness = 0.16;
        m.metalness = 0;
        continue;
      }

      m.envMapIntensity = Math.max(orig.envMapIntensity ?? 1, envIntensity);

      if (entry.kind === 'road' || entry.kind === 'paintedRoad' || entry.kind === 'roadCandidate') {
        if (entry.kind !== 'roadCandidate') this._ensureWetShader(m);
        if (m.userData.__polyfxWetUniforms) {
          m.userData.__polyfxWetUniforms.uWetness.value = wetness;
          m.userData.__polyfxWetUniforms.uPuddles.value = puddles;
          m.userData.__polyfxWetUniforms.uTime.value = time;
        }
        const isCandidate = entry.kind === 'roadCandidate';
        const wet = isCandidate ? wetness * 0.45 : wetness;
        const puddle = isCandidate ? puddles * 0.35 : puddles;
        const smooth = Math.max(wet, puddle);
        m.roughness = lerp(orig.roughness ?? 0.72, 0.11, smooth);
        m.metalness = Math.max(orig.metalness ?? 0, 0.015);
        m.envMapIntensity = Math.max(m.envMapIntensity, 0.35 + smooth * 1.10);
        if (orig.color && m.color) {
          const darken = 1 - wet * 0.18 - puddle * 0.08;
          m.color.copy(orig.color).multiplyScalar(darken);
        }
        continue;
      }

      if (entry.kind === 'terrain' && orig.color && m.color) {
        m.color.copy(orig.color).lerp(new THREE.Color(0.45, 0.58, 0.50), overcast * 0.12);
        m.roughness = Math.min(1, (orig.roughness ?? 0.9) + wetness * 0.08);
        continue;
      }

      if (entry.kind === 'carPaint') {
        m.roughness = photoreal ? Math.min(orig.roughness ?? 0.6, 0.44) : Math.min(orig.roughness ?? 0.7, 0.56);
        m.metalness = Math.max(orig.metalness ?? 0, photoreal ? 0.08 : 0.03);
      } else if (entry.kind === 'metal') {
        m.roughness = photoreal ? Math.min(orig.roughness ?? 0.5, 0.26) : Math.min(orig.roughness ?? 0.6, 0.36);
        m.metalness = Math.max(orig.metalness ?? 0.2, photoreal ? 0.72 : 0.52);
      }
    }
  }

  _ensureWetShader(m) {
    if (m.userData.__polyfxWetShader) return;
    const prevCompile = m.onBeforeCompile;
    const prevKey = m.customProgramCacheKey;
    m.userData.__polyfxWetUniforms = {
      uWetness: { value: 0 },
      uPuddles: { value: 0 },
      uTime: { value: 0 },
    };
    m.onBeforeCompile = (shader, renderer) => {
      if (prevCompile) prevCompile.call(m, shader, renderer);
      Object.assign(shader.uniforms, m.userData.__polyfxWetUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPolyfxWorldPosition;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPolyfxWorldPosition = worldPosition.xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uWetness;\nuniform float uPuddles;\nuniform float uTime;\nvarying vec3 vPolyfxWorldPosition;\nfloat polyfxHash(vec2 p){ return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453); }\nfloat polyfxNoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f); return mix(mix(polyfxHash(i), polyfxHash(i+vec2(1.0,0.0)), u.x), mix(polyfxHash(i+vec2(0.0,1.0)), polyfxHash(i+vec2(1.0,1.0)), u.x), u.y); }\nfloat polyfxPuddleMask(vec3 wp){ float n=polyfxNoise(wp.xz*0.085)+0.45*polyfxNoise(wp.xz*0.19+13.0); float basin=smoothstep(1.04-uPuddles*0.42, 1.34, n); float ripple=sin((wp.x+wp.z)*2.4+uTime*5.0)*0.5+0.5; return clamp(basin*(0.72+0.28*ripple),0.0,1.0); }')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nfloat polyfxPuddle = polyfxPuddleMask(vPolyfxWorldPosition);\nroughnessFactor = mix(roughnessFactor, 0.045, polyfxPuddle * uPuddles);\nroughnessFactor = mix(roughnessFactor, 0.18, uWetness * 0.45);')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 - uWetness * 0.08 - polyfxPuddle * uPuddles * 0.10;');
    };
    m.customProgramCacheKey = () => {
      const base = prevKey ? prevKey.call(m) : '';
      return base + '|polyfx-wet-road-v1';
    };
    m.needsUpdate = true;
    m.userData.__polyfxWetShader = true;
  }
}

class RainField {
  constructor(count = 1300) {
    this.count = count;
    this.positions = new Float32Array(count * 2 * 3);
    this.seeds = Array.from({ length: count }, () => this._seed());
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color: 0xaec7df,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 49;
  }

  _seed() {
    return {
      x: (Math.random() - 0.5) * 92,
      y: Math.random() * 38,
      z: (Math.random() - 0.5) * 92,
      len: 0.9 + Math.random() * 2.3,
      speed: 16 + Math.random() * 30,
      phase: Math.random() * Math.PI * 2,
    };
  }

  update(scene, camera, weather, dt) {
    const rain = clamp01(weather.rainRate);
    if (rain <= 0.01) {
      this.material.opacity = 0;
      return;
    }
    if (this.lines.parent !== scene) scene.add(this.lines);
    const storm = clamp01(weather.storm);
    const wind = weather.wind || 0;
    const base = camera.position;
    this.material.opacity = 0.05 + rain * 0.26 + storm * 0.08;
    this.material.color.setRGB(0.62, 0.72, 0.82);
    for (let i = 0; i < this.count; i++) {
      const s = this.seeds[i];
      s.y -= s.speed * dt * (0.55 + rain * 0.9);
      s.x += wind * dt * (5 + storm * 16);
      if (s.y < -5) {
        const next = this._seed();
        s.x = next.x; s.y += 38; s.z = next.z; s.len = next.len; s.speed = next.speed;
      }
      const ix = i * 6;
      const x = base.x + s.x, y = base.y + s.y, z = base.z + s.z;
      const slant = wind * (0.25 + storm * 0.45);
      this.positions[ix] = x; this.positions[ix + 1] = y; this.positions[ix + 2] = z;
      this.positions[ix + 3] = x - slant; this.positions[ix + 4] = y - s.len * (0.7 + rain); this.positions[ix + 5] = z;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}

export class WeatherEngine {
  constructor() {
    this.state = {
      preset: 0,
      rainRate: 0,
      cloudCover: 0.26,
      fogDensity: 0,
      storm: 0,
      wind: 0.08,
      temperature: 0.62,
      wetness: 0,
      puddles: 0,
      wetTarget: 0,
      puddleTarget: 0,
      droplets: 0,
      lightning: true,
      lightningFlash: 0,
      lightningT: 0,
      skyBrightness: 1,
      skyWash: 0,
      autoHeadlights: false,
      intensity: 1,
      transition: 1.6,
    };
    this.target = { ...WEATHER_PROFILES[0] };
    this.rain = new RainField();
    this.surfaces = new SurfaceRegistry();
    this.lastMaterialT = 0;
    this.lastT = 0;
    this.forceMaterialUpdate = true;
  }

  setPreset(index) {
    const i = THREE.MathUtils.clamp(Math.round(index), 0, WEATHER_PROFILES.length - 1);
    this.state.preset = i;
    this.target = { ...WEATHER_PROFILES[i] };
    this.forceMaterialUpdate = true;
  }

  setParam(path, value) {
    const s = this.state;
    switch (path) {
      case 'preset': this.setPreset(value); return;
      case 'rain': s.rainRate = clamp01(value); this.target.rainRate = s.rainRate; s.droplets = Math.max(s.droplets, s.rainRate * 0.65); break;
      case 'wetness': s.wetness = clamp01(value); this.target.wetTarget = s.wetness; break;
      case 'puddles': s.puddles = clamp01(value); this.target.puddleTarget = s.puddles; break;
      case 'clouds': s.cloudCover = clamp01(value); this.target.cloudCover = s.cloudCover; break;
      case 'fog': s.fogDensity = THREE.MathUtils.clamp(value, 0, 0.18); this.target.fogDensity = s.fogDensity; break;
      case 'droplets': s.droplets = clamp01(value); this.target.droplets = s.droplets; break;
      case 'wind': s.wind = THREE.MathUtils.clamp(value, -1, 1); this.target.wind = s.wind; break;
      case 'storm': s.storm = clamp01(value); this.target.storm = s.storm; break;
      case 'intensity': s.intensity = clamp01(value); break;
      case 'transition': s.transition = THREE.MathUtils.clamp(value, 0.1, 12); break;
      default: return;
    }
    this.forceMaterialUpdate = true;
  }

  update({ scene, camera, sky, lensPass, renderer, cfg, baseBloomStrength, bloom, ssr, renderPass, photoreal }) {
    const now = performance.now();
    const dt = this.lastT ? Math.min(0.06, (now - this.lastT) / 1000) : 0.016;
    this.lastT = now;
    this._advance(dt);
    this._applySky(scene, sky);
    this._applyFog(scene, sky);
    this.rain.update(scene, camera, this.state, dt);
    this._applyLens(lensPass, now);
    this._applyLightning(renderer, cfg, dt);
    this._applyPost({ cfg, bloom, baseBloomStrength, ssr, renderPass, photoreal });
    this._applyMaterials(scene, cfg, sky, photoreal);
    this.state.autoHeadlights = this.state.rainRate > 0.10 || this.state.fogDensity > 0.055 || this.state.cloudCover > 0.86;
  }

  _advance(dt) {
    const s = this.state;
    const speed = 1 / Math.max(0.1, s.transition);
    const k = 1 - Math.exp(-dt * speed * 3.0);
    const clear = WEATHER_PROFILES[0];
    for (const key of PROFILE_KEYS) {
      if (!(key in this.target)) continue;
      const target = key === 'temperature' ? this.target[key] : lerp(clear[key] || 0, this.target[key], s.intensity);
      s[key] = lerp(s[key], target, k);
    }
    const wetIn = 0.06 + s.rainRate * 0.34;
    const wetOut = 0.035 * (1 - s.cloudCover * 0.55);
    s.wetness = approach(s.wetness, s.wetTarget, (s.rainRate > 0.01 ? wetIn : wetOut) * dt);
    const puddleIn = 0.018 + s.rainRate * 0.13;
    const puddleOut = 0.010 * (1 - s.cloudCover * 0.45);
    s.puddles = approach(s.puddles, s.puddleTarget, (s.rainRate > 0.08 ? puddleIn : puddleOut) * dt);
    s.skyWash = clamp01(s.cloudCover * 0.55 + s.fogDensity * 3.0 + s.rainRate * 0.18);
    s.skyBrightness = THREE.MathUtils.clamp(1 - s.skyWash * 0.28 - s.storm * 0.18, 0.55, 1);
  }

  _applySky(scene, sky) {
    const s = this.state;
    if (!sky) return;
    if (sky.sky && sky.sky.material && sky.sky.material.uniforms) {
      const u = sky.sky.material.uniforms;
      if (u.rayleigh) u.rayleigh.value *= 1 - s.skyWash * 0.22;
      if (u.turbidity) u.turbidity.value = Math.min(u.turbidity.value + s.cloudCover * 1.6, 6.5);
      if (u.mieCoefficient) u.mieCoefficient.value = Math.min(u.mieCoefficient.value + s.fogDensity * 0.018, 0.012);
    }
    if (sky.cloudMat && sky.cloudMat.uniforms) {
      const u = sky.cloudMat.uniforms;
      if (u.uCoverage) u.uCoverage.value = lerp(0.64, 0.25, s.cloudCover);
      if (u.uOpacity) u.uOpacity.value = lerp(0.22, 0.64, s.cloudCover) * (1 - s.storm * 0.06);
      if (u.uColor && u.uColorDark) {
        u.uColor.value.setRGB(0.88 - s.storm * 0.12, 0.91 - s.storm * 0.13, 0.92 - s.storm * 0.10);
        u.uColorDark.value.setRGB(0.38 - s.storm * 0.08, 0.43 - s.storm * 0.09, 0.47 - s.storm * 0.08);
      }
    }
    const lightScale = THREE.MathUtils.clamp(1 - s.cloudCover * 0.30 - s.storm * 0.20, 0.52, 1);
    scene.traverse((o) => {
      if (o.userData && o.userData.__polyfxOwned) return;
      if ((o.isDirectionalLight || o.isHemisphereLight) && !o.userData.__polyfxWeatherBase) {
        o.userData.__polyfxWeatherBase = o.intensity || 1;
      }
      if (o.isDirectionalLight || o.isHemisphereLight) o.intensity *= lightScale;
    });
  }

  _applyFog(scene, sky) {
    if (!scene.fog) return;
    const s = this.state;
    const fog = THREE.MathUtils.clamp(s.fogDensity + s.rainRate * 0.020 + s.storm * 0.020, 0, 0.18);
    if (fog <= 0.004) return;
    const night = sky && sky.sunDir ? sky.sunDir.y < 0.1 : false;
    if (night) scene.fog.color.setRGB(0.035, 0.045, 0.070);
    else scene.fog.color.setRGB(0.42 - s.storm * 0.06, 0.50 - s.storm * 0.07, 0.54 - s.storm * 0.06);
    if ('near' in scene.fog && 'far' in scene.fog) {
      const far = scene.fog.far || 10000;
      scene.fog.near = Math.max(95, far * (0.40 - fog * 0.90));
    }
  }

  _applyLens(lensPass, now) {
    const s = this.state;
    if (!lensPass) return;
    lensPass.enabled = s.droplets > 0.02 || s.rainRate > 0.08;
    const u = lensPass.material.uniforms;
    u.intensity.value = Math.max(s.droplets, s.rainRate * 0.58);
    u.streaks.value = s.rainRate;
    u.time.value = now * 0.001;
  }

  _applyLightning(renderer, cfg, dt) {
    const s = this.state;
    if (s.lightning && s.storm > 0.55) {
      s.lightningT -= dt;
      if (s.lightningT <= 0) {
        s.lightningT = 4 + Math.random() * 8;
        s.lightningFlash = 1;
      }
      s.lightningFlash = Math.max(0, s.lightningFlash - dt * 3.8);
    } else {
      s.lightningFlash = 0;
    }
    if (renderer && cfg) {
      renderer.toneMappingExposure = (cfg.exposure || 1) * s.skyBrightness + s.lightningFlash * s.storm * 0.36;
    }
  }

  _applyPost({ cfg, bloom, baseBloomStrength, ssr, renderPass, photoreal }) {
    if (!cfg) return;
    const s = this.state;
    const wetSSR = !!cfg.env && (s.wetness > 0.34 || s.puddles > 0.16);
    const baseSSR = !!cfg.ssr;
    const useSSR = !!ssr && (baseSSR || wetSSR || photoreal);
    if (ssr) {
      ssr.enabled = useSSR;
      if (renderPass) renderPass.enabled = !useSSR;
      if (useSSR && !baseSSR) {
        ssr.opacity = 0.16 + s.puddles * 0.26;
        ssr.maxDistance = 9 + s.puddles * 15;
        ssr.thickness = 0.08;
        ssr.blur = true;
      }
    }
    if (bloom && bloom.enabled) {
      bloom.strength = (baseBloomStrength || 0) + s.wetness * 0.012 + s.lightningFlash * 0.07;
    }
  }

  _applyMaterials(scene, cfg, sky, photoreal) {
    if (!cfg) return;
    const now = performance.now();
    if (!this.forceMaterialUpdate && now - this.lastMaterialT < 900) return;
    this.forceMaterialUpdate = false;
    this.lastMaterialT = now;
    this.surfaces.update(scene);
    const skyEnv = sky && sky.envTexture;
    const envIntensity = cfg.env ? (skyEnv ? 0.40 : (cfg.envIntensity ?? 0.35)) : 0;
    this.surfaces.apply({
      envIntensity,
      photoreal,
      wetness: this.state.wetness,
      puddles: this.state.puddles,
      overcast: this.state.cloudCover,
      time: now * 0.001,
    });
  }
}
