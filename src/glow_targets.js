import * as THREE from './vendor/three.module.js';

// Track-part color differentiation happens entirely through a per-vertex `color` attribute
// feeding ONE shared MeshLambertMaterial used by every part type on the track (confirmed at
// runtime: 36+ distinct geometries, 8+ distinct baked colors, one material object). There is no
// per-part "SignYellow" material to grab and set emissive on — doing that would light up the
// entire track, not the selected part type. Instead this patches that one shared material's
// shader (once, via onBeforeCompile) to compare each vertex's baked color against a set of target
// colors and boost emissive output only where it matches, so selection happens per-vertex at
// render time regardless of how many distinct part types share the material.
//
// Colors are the exact baseColorFactor values from the stock GLTF models (app_src/models/*.glb),
// confirmed bit-identical to what ends up in the runtime vertex-color buffer. Several source
// materials bake to colors within ~0.01 Euclidean distance of each other (e.g. BlockSurface
// 0.2079 vs Pillar 0.2019 — 0.0104 apart) — too close to reliably separate with a fixed shader
// epsilon without either failing to match legitimate targets (epsilon too tight) or bleeding into
// neighboring categories (epsilon too loose). Those are merged into one honestly-labeled category
// (its color is the cluster's centroid) rather than pretending to offer granularity the baked data
// doesn't actually support. All entries below are cross-checked pairwise to stay outside the match
// epsilon of one another.
export const GLOW_CATEGORIES = [
  { id: 'signRed', label: 'Warning Signs (Red)', color: [0.5926, 0.0174, 0], defaultGlow: '#ff4433' },
  { id: 'signYellow', label: 'Warning Signs (Yellow)', color: [0.8, 0.4543, 0.0321], defaultGlow: '#ffc25a' },
  { id: 'darkTrim', label: 'Sign/Pillar/Finish Trim (Near-Black)', color: [0.00943, 0.00943, 0.00943], defaultGlow: '#ffffff' },
  { id: 'checkpoint', label: 'Checkpoints', color: [0.8, 0.5971, 0], defaultGlow: '#ffaa22' },
  { id: 'startLine', label: 'Start Line', color: [0.8, 0.3774, 0.0162], defaultGlow: '#ff9944' },
  { id: 'finishRedEdge', label: 'Finish Line & Red Track Edges', color: [0.8, 0.0323, 0.0127], defaultGlow: '#ff4433' },
  { id: 'finishWhiteEdge', label: 'Track Edges & Finish (White)', color: [1, 1, 1], defaultGlow: '#ffffff' },
  { id: 'wallBase', label: 'Wall Base & Road Barriers', color: [0.0741, 0.0741, 0.0741], defaultGlow: '#66aaff' },
  { id: 'trackWalls', label: 'Track Walls', color: [0.1005, 0.1005, 0.1005], defaultGlow: '#66aaff' },
  { id: 'blocksPillars', label: 'Blocks & Pillars', color: [0.2049, 0.2049, 0.2049], defaultGlow: '#88ccff' },
  { id: 'roadSurface', label: 'Road Surface', color: [0.2957, 0.2957, 0.2957], defaultGlow: '#66aaff' },
  { id: 'wallTrim', label: 'Wall Trim (Tan)', color: [0.2202, 0.1762, 0.0969], defaultGlow: '#ffcc88' },
  { id: 'wallDetail', label: 'Wall Detail (Blue)', color: [0.1318, 0.1388, 0.2738], defaultGlow: '#88aaff' },
];

const COLOR_EPSILON = 0.02;
const MAX_GLOW_SLOTS = 16; // headroom above GLOW_CATEGORIES.length for future entries

function hexToRgbArray(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class GlowTargets {
  constructor() {
    this.material = null;
    this.enabled = false;
    this.intensity = 2.2;
    this.categoryState = new Map(GLOW_CATEGORIES.map((c) => [c.id, { on: false, glow: hexToRgbArray(c.defaultGlow) }]));
  }

  setEnabled(on) {
    this.enabled = on;
    this._apply();
  }

  setCategoryEnabled(id, on) {
    const s = this.categoryState.get(id);
    if (!s) return;
    s.on = on;
    this._apply();
  }

  setCategoryColor(id, hex) {
    const s = this.categoryState.get(id);
    if (!s) return;
    s.glow = hexToRgbArray(hex);
    this._apply();
  }

  setIntensity(v) {
    this.intensity = v;
    this._apply();
  }

  // Called from the shared periodic scene scan with InstancedMesh candidates already gathered
  // during that same traversal (see runtime.js's _sharedScan — one shared scan, not a second
  // full-tree walk). Re-validates every call rather than "find once, trust forever": the
  // previous version patched the first isMeshLambertMaterial-with-vertex-colors InstancedMesh it
  // found and never looked again, which silently broke two ways in real play — patching whatever
  // happened to be the first match at scan time (plausibly something car-related, matching the
  // "glowing cars" report) and never noticing when the actual track material gets replaced on a
  // track change, leaving the glow patched onto an orphaned, no-longer-rendered material.
  ingestCandidates(candidates) {
    if (this.material) {
      const stillUsed = candidates.some((c) => c.material === this.material);
      if (stillUsed) return;
      this.material = null; // orphaned — fall through and find the current one
    }
    let best = null, bestScore = 0;
    for (const c of candidates) {
      const score = this._paletteMatchScore(c.material, c.sampleColors);
      if (score > bestScore) { bestScore = score; best = c.material; }
    }
    // Require at least 3 distinct baked colors matching the known palette before trusting a
    // candidate — the real track material should hit most of GLOW_CATEGORIES' colors; anything
    // else (car paint, some other shared material) should score 0 or 1 at most by chance.
    if (best && bestScore >= 3) this._patch(best);
  }

  _paletteMatchScore(material, sampleColorSets) {
    const seen = new Set();
    for (const colors of sampleColorSets) {
      for (const c of colors) {
        for (const cat of GLOW_CATEGORIES) {
          if (seen.has(cat.id)) continue;
          const d = Math.hypot(c[0] - cat.color[0], c[1] - cat.color[1], c[2] - cat.color[2]);
          if (d < COLOR_EPSILON) seen.add(cat.id);
        }
      }
    }
    return seen.size;
  }

  _patch(material) {
    this.material = material;
    if (material.userData.__polyfxGlowPatched) { this._apply(); return; }
    material.userData.__polyfxGlowPatched = true;
    const prevOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer);
      shader.uniforms.polyfxGlowTargets = { value: Array.from({ length: MAX_GLOW_SLOTS }, () => new THREE.Vector3(-1, -1, -1)) };
      shader.uniforms.polyfxGlowColors = { value: Array.from({ length: MAX_GLOW_SLOTS }, () => new THREE.Vector3(0, 0, 0)) };
      shader.uniforms.polyfxGlowCount = { value: 0 };
      shader.uniforms.polyfxGlowIntensity = { value: 0 };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_COLOR
        if (polyfxGlowIntensity > 0.0) {
          for (int polyfxI = 0; polyfxI < ${MAX_GLOW_SLOTS}; polyfxI++) {
            if (polyfxI >= polyfxGlowCount) break;
            if (distance(vColor, polyfxGlowTargets[polyfxI]) < ${COLOR_EPSILON.toFixed(4)}) {
              totalEmissiveRadiance += polyfxGlowColors[polyfxI] * polyfxGlowIntensity;
              break;
            }
          }
        }
        #endif`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'uniform vec3 emissive;',
        `uniform vec3 emissive;\nuniform vec3 polyfxGlowTargets[${MAX_GLOW_SLOTS}];\nuniform vec3 polyfxGlowColors[${MAX_GLOW_SLOTS}];\nuniform int polyfxGlowCount;\nuniform float polyfxGlowIntensity;`,
      );
      material.userData.__polyfxShader = shader;
    };
    material.needsUpdate = true;
    this._apply();
  }

  _apply() {
    if (!this.material) return;
    const shader = this.material.userData.__polyfxShader;
    if (!shader) return; // not compiled yet — needsUpdate triggers onBeforeCompile on next render
    if (!this.enabled) { shader.uniforms.polyfxGlowIntensity.value = 0; return; }
    let n = 0;
    for (const cat of GLOW_CATEGORIES) {
      const s = this.categoryState.get(cat.id);
      if (!s || !s.on || n >= MAX_GLOW_SLOTS) continue;
      shader.uniforms.polyfxGlowTargets.value[n].set(cat.color[0], cat.color[1], cat.color[2]);
      shader.uniforms.polyfxGlowColors.value[n].set(s.glow[0], s.glow[1], s.glow[2]);
      n++;
    }
    shader.uniforms.polyfxGlowCount.value = n;
    shader.uniforms.polyfxGlowIntensity.value = n > 0 ? this.intensity : 0;
  }
}
