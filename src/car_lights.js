// PolyFX Car Lights — real headlights + brake-light glow.
// ---------------------------------------------------------------------------
// No new bundle seam needed: cars are ordinary Object3D groups added directly
// to the scene, and the game already tags each car's brake-light mesh with a
// material named "BrakeLight" (and the body with "Main") — car discovery and
// the front/rear/lateral anchor are shared with underglow.js via car_anchor.js.
// Braking state is read straight off the brake material's own emissive
// colour, which the stock game already toggles.
//
// Car *discovery* (the scene.traverse to find BrakeLight-tagged meshes) is
// NOT done here — runtime.js folds it into one shared per-second scan (also
// used for lights and the smoke material) and feeds roots in via ingestRoots.
// This class only fits/lays out/applies state for roots it's handed.

import * as THREE from './vendor/three.module.js';
import { fitCarAnchor } from './car_anchor.js';

export class CarLights {
  constructor() {
    this.cars = new Map(); // carRoot -> { carrier, brakeMesh, brakeMat, brakeSpot, brakeTarget, headL, headR, anchor, origEmissive }
    this._failed = new WeakSet(); // roots we already tried and gave up on this session
    // NB: three.js (r155+) lights are photometric — SpotLight intensity is in
    // candela, so useful values are in the hundreds, unlike the game's own
    // DirectionalLight/HemisphereLight (irradiance-like, ~1-10).
    // offsetZ/offsetX/offsetY are FINE-TUNE nudges (additive, local units) on
    // top of a position auto-derived from the car's own geometry — see _fit().
    this.cfg = {
      enabled: true,
      offsetX: 0, offsetY: 0, offsetZ: 0, manualFlip: false, // safety override if auto-detected front is ever wrong
      aimDistance: 12, aimDrop: 0.6,
      color: 0xfff2d0, intensity: 220, angle: 0.5, penumbra: 0.6, distance: 22,
      // brakeLightDistance is the spotlight's range/target reach behind the
      // car, not just its source offset — 4.0 (the original default) reads as
      // the glow trailing a car-length or more behind, disproportionate to
      // typical car length. 2.0 keeps the pool close to the bumper; tune live
      // via the panel's "Rear range" slider if it still needs adjusting.
      tailGlow: 0.28, brakeBoost: 3.2, brakeLightIntensity: 65, tailLightIntensity: 8, brakeLightDistance: 2.0,
    };
  }

  update(scene, headlightsOn) {
    for (const [root, car] of this.cars) {
      if (root.parent !== scene) { this.cars.delete(root); continue; }
      this._applyHeadlights(car, headlightsOn);
      this._applyBrake(car, headlightsOn);
    }
  }

  setEnabled(on) {
    this.cfg.enabled = on;
    if (!on) for (const [, car] of this.cars) this._setHeadIntensity(car, 0);
  }

  // Fed by runtime.js's shared scene scan (see PolyFX._sharedScan).
  ingestRoots(roots) {
    for (const root of roots) {
      if (this.cars.has(root) || this._failed.has(root)) continue;
      // A single car's setup must never be able to take down the whole render
      // pipeline (this runs inside PolyFX's per-frame try/catch) — any failure
      // here is caught, logged once, and that car is skipped, not retried.
      try { this._fit(root); }
      catch (e) { console.warn('[PolyFX] car light setup failed, skipping this car:', e); this._failed.add(root); }
    }
  }

  _fit(root) {
    const found = fitCarAnchor(root);
    if (!found) return;
    const { brakeMesh, brakeMaterialIndex, anchor } = found;
    const brakeMat = Array.isArray(brakeMesh.material) ? brakeMesh.material.find((m) => m.name === 'BrakeLight') : brakeMesh.material;

    const carrier = brakeMesh;

    const mkSpot = (color) => {
      const spot = new THREE.SpotLight(color, 0, 1, 0.5, 0.6, 1.2);
      spot.userData.__polyfxOwned = true;
      const target = new THREE.Object3D();
      spot.target = target;
      carrier.add(spot); carrier.add(target);
      return { spot, target };
    };
    const headL = { ...mkSpot(this.cfg.color), sideSign: -1 };
    const headR = { ...mkSpot(this.cfg.color), sideSign: 1 };
    const brake = mkSpot(0xff4433);

    const car = {
      root, carrier, brakeMesh, brakeMat, origEmissive: brakeMat ? (brakeMat.emissiveIntensity ?? 1) : 1,
      brakeSpot: brake.spot, brakeTarget: brake.target, headL, headR, anchor,
    };
    this.cars.set(root, car);
    this._layoutHeads(car);
    this._layoutBrake(car);
  }

  _layoutHeads(car) {
    const c = this.cfg, a = car.anchor;
    const frontSign = a.frontSign * (c.manualFlip ? -1 : 1);
    const frontEdge = frontSign > 0 ? a.maxEdge : a.minEdge;
    for (const h of [car.headL, car.headR]) {
      const lateral = a.centerLateral + h.sideSign * a.halfWidth * 0.62 + h.sideSign * c.offsetX;
      const along = frontEdge + frontSign * (0.12 + c.offsetZ); // just outside the body, not embedded in it
      const y = a.bumperY + c.offsetY;
      const pos = { x: 0, y, z: 0 };
      pos[a.lengthAxis] = along; pos[a.lateralAxis] = lateral;
      h.spot.position.set(pos.x, pos.y, pos.z);

      const tgt = { x: 0, y: y - c.aimDrop, z: 0 };
      tgt[a.lengthAxis] = along + frontSign * c.aimDistance;
      tgt[a.lateralAxis] = a.centerLateral + h.sideSign * a.halfWidth * 0.3;
      h.target.position.set(tgt.x, tgt.y, tgt.z);

      h.spot.angle = c.angle; h.spot.penumbra = c.penumbra; h.spot.distance = c.distance;
      h.spot.color.set(c.color);
    }
  }

  // Brake glow: a SpotLight aimed BACKWARD and slightly down, at the rear edge
  // — not an omnidirectional PointLight, which was spilling light in every
  // direction including forward, under the chassis ("washing" under the car).
  _layoutBrake(car) {
    const c = this.cfg, a = car.anchor;
    const frontSign = a.frontSign * (c.manualFlip ? -1 : 1);
    const rearSign = -frontSign;
    const rearEdge = rearSign > 0 ? a.maxEdge : a.minEdge;
    const along = rearEdge + rearSign * 0.10; // just outside the body
    const y = a.bumperY + 0.04;

    const pos = { x: 0, y, z: 0 };
    pos[a.lengthAxis] = along; pos[a.lateralAxis] = a.centerLateral;
    car.brakeSpot.position.set(pos.x, pos.y, pos.z);

    const tgt = { x: 0, y: y - 0.25, z: 0 };
    tgt[a.lengthAxis] = along + rearSign * c.brakeLightDistance;
    tgt[a.lateralAxis] = a.centerLateral;
    car.brakeTarget.position.set(tgt.x, tgt.y, tgt.z);

    car.brakeSpot.distance = c.brakeLightDistance;
    car.brakeSpot.angle = 0.9;      // wide, soft glow rather than a tight beam
    car.brakeSpot.penumbra = 1.0;
  }

  _setHeadIntensity(car, v) { car.headL.spot.intensity = v; car.headR.spot.intensity = v; }

  _applyHeadlights(car, on) {
    this._setHeadIntensity(car, this.cfg.enabled && on ? this.cfg.intensity : 0);
  }

  _applyBrake(car, tailOn) {
    if (!car.brakeMat) return;
    // The stock game marks active braking by setting emissive red before render.
    const braking = car.brakeMat.emissive.r > 0.5;
    if (braking) {
      car.brakeMat.emissive.setRGB(1, 0.34, 0.22);
      car.brakeMat.emissiveIntensity = car.origEmissive * this.cfg.brakeBoost;
      car.brakeSpot.intensity = this.cfg.brakeLightIntensity;
    } else if (tailOn) {
      car.brakeMat.emissive.setRGB(1, 0.08, 0.04);
      car.brakeMat.emissiveIntensity = car.origEmissive * this.cfg.tailGlow;
      car.brakeSpot.intensity = this.cfg.tailLightIntensity;
    } else {
      car.brakeMat.emissive.setRGB(0, 0, 0);
      car.brakeMat.emissiveIntensity = car.origEmissive;
      car.brakeSpot.intensity = 0;
    }
  }

  applyConfig(partial) {
    Object.assign(this.cfg, partial);
    for (const [, car] of this.cars) { this._layoutHeads(car); this._layoutBrake(car); }
  }

  // Zero every light without removing them (cheap, reversible) — used when the
  // composer/atmosphere is off so no car keeps glowing from a stale state.
  disableAll() {
    for (const [, car] of this.cars) {
      this._setHeadIntensity(car, 0);
      car.brakeSpot.intensity = 0;
      if (car.brakeMat) car.brakeMat.emissiveIntensity = car.origEmissive;
    }
  }

  dispose() {
    for (const [root, car] of this.cars) {
      car.carrier.remove(car.headL.spot, car.headL.target, car.headR.spot, car.headR.target, car.brakeSpot, car.brakeTarget);
    }
    this.cars.clear();
  }
}
