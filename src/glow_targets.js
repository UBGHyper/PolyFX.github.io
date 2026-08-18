import * as THREE from './vendor/three.module.js';

// Track-part color differentiation happens entirely through a per-vertex `color` attribute
// feeding ONE shared MeshLambertMaterial used by every part type on the track (confirmed at
// runtime: 36+ distinct geometries, 8+ distinct baked colors, one material object). There is no
// per-part "SignYellow" material to grab and set emissive on — doing that would light up the
// entire track, not the selected part type. Instead this patches that one shared material's
// shader (once, via onBeforeCompile) to compare each vertex's baked color against a target and
// boost emissive output only where it matches, so selection happens per-vertex at render time
// regardless of how many distinct part types share the material.
//
// Colors below are the exact baseColorFactor values from the stock GLTF models
// (app_src/models/*.glb) — confirmed bit-identical to what ends up in the runtime vertex-color
// buffer, not just visually similar.
export const GLOW_TARGETS = [
  { id: 0, title: 'Off', color: null, glow: null },
  { id: 1, title: 'Warning Signs (Yellow)', color: [0.8, 0.4543, 0.0321], glow: [1.2, 0.95, 0.35] },
  { id: 2, title: 'Warning Signs (Red)', color: [0.5926, 0.0174, 0], glow: [1.4, 0.18, 0.1] },
  { id: 3, title: 'Checkpoints (Orange)', color: [0.8, 0.5971, 0], glow: [1.4, 0.75, 0.1] },
  { id: 4, title: 'Start Line (Orange)', color: [0.8, 0.3774, 0.0162], glow: [1.4, 0.55, 0.15] },
  // Finish (red stripe) and RoadEdgeRed share this exact baked color — indistinguishable at the
  // vertex-color level, so one target covers both honestly rather than pretending to pick one.
  { id: 5, title: 'Finish Line & Red Track Edges', color: [0.8, 0.0323, 0.0127], glow: [1.4, 0.2, 0.1] },
  // Same story: FinishWhite and RoadEdgeWhite are both pure (1,1,1).
  { id: 6, title: 'Track Edges & Finish (White)', color: [1, 1, 1], glow: [1.0, 1.0, 1.05] },
];

const COLOR_EPSILON = 0.015; // tight enough to keep visually-similar-but-distinct colors apart

export class GlowTargets {
  constructor() {
    this.material = null;
    this.targetId = 0;
    this.intensity = 2.2;
  }

  // Called from the shared periodic scene scan — cheap to no-op once patched (checked via
  // userData on the material itself, so a re-scan after a track reload that reuses the same
  // material object doesn't double-patch it).
  ingest(scene) {
    if (this.material) return;
    let found = null;
    scene.traverse((o) => {
      if (found || !o.isInstancedMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.isMeshLambertMaterial && o.geometry.attributes.color) found = m;
    });
    if (found) this._patch(found);
  }

  _patch(material) {
    this.material = material;
    if (material.userData.__polyfxGlowPatched) { this._apply(); return; }
    material.userData.__polyfxGlowPatched = true;
    const self = this;
    const prevOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer);
      shader.uniforms.polyfxGlowTarget = { value: new THREE.Vector3(-1, -1, -1) };
      shader.uniforms.polyfxGlowColor = { value: new THREE.Vector3(0, 0, 0) };
      shader.uniforms.polyfxGlowIntensity = { value: 0 };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_COLOR
        if (polyfxGlowIntensity > 0.0 && distance(vColor, polyfxGlowTarget) < ${COLOR_EPSILON.toFixed(4)}) {
          totalEmissiveRadiance += polyfxGlowColor * polyfxGlowIntensity;
        }
        #endif`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'uniform vec3 emissive;',
        'uniform vec3 emissive;\nuniform vec3 polyfxGlowTarget;\nuniform vec3 polyfxGlowColor;\nuniform float polyfxGlowIntensity;',
      );
      material.userData.__polyfxShader = shader;
    };
    material.needsUpdate = true;
    this._apply();
  }

  setTarget(id) {
    this.targetId = GLOW_TARGETS.some((t) => t.id === id) ? id : 0;
    this._apply();
  }

  setIntensity(v) {
    this.intensity = v;
    this._apply();
  }

  _apply() {
    if (!this.material) return;
    const shader = this.material.userData.__polyfxShader;
    if (!shader) return; // not compiled yet — needsUpdate triggers onBeforeCompile on next render
    const target = GLOW_TARGETS.find((t) => t.id === this.targetId) || GLOW_TARGETS[0];
    if (!target.color) {
      shader.uniforms.polyfxGlowIntensity.value = 0;
      return;
    }
    shader.uniforms.polyfxGlowTarget.value.set(target.color[0], target.color[1], target.color[2]);
    shader.uniforms.polyfxGlowColor.value.set(target.glow[0], target.glow[1], target.glow[2]);
    shader.uniforms.polyfxGlowIntensity.value = this.intensity;
  }

  disable() {
    this.setTarget(0);
  }
}
