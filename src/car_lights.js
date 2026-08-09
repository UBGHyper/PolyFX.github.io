
import * as THREE from './vendor/three.module.js';
import { fitCarAnchor } from './car_anchor.js';

const _worldPos = new THREE.Vector3();

export class CarLights {
  constructor() {
    this.cars = new Map();
    this._failed = new WeakSet();
    this.cfg = {
      enabled: true,
      offsetX: 0, offsetY: 0, offsetZ: 0, manualFlip: false,
      aimDistance: 12, aimDrop: 0.6,
      color: 0xfff2d0, intensity: 220, angle: 0.5, penumbra: 0.6, distance: 22,
      tailGlow: 0.28, brakeBoost: 3.2, brakeLightIntensity: 65, tailLightIntensity: 8, brakeLightDistance: 2.0,
      otherHeadlightsEnabled: true, maxLitOtherCars: 6,
    };
  }

  update(scene, headlightsOn, camera) {
    for (const [root, car] of this.cars) {
      if (root.parent !== scene) { this.cars.delete(root); continue; }
    }

    let ownRoot = null;
    const entries = [];
    if (camera) {
      let bestDistSq = Infinity;
      for (const [root, car] of this.cars) {
        const distSq = camera.position.distanceToSquared(car.carrier.getWorldPosition(_worldPos));
        entries.push({ root, distSq });
        if (distSq < bestDistSq) { bestDistSq = distSq; ownRoot = root; }
      }
    }

    const others = entries.filter((e) => e.root !== ownRoot).sort((a, b) => a.distSq - b.distSq);
    const litOtherRoots = new Set(
      this.cfg.otherHeadlightsEnabled ? others.slice(0, this.cfg.maxLitOtherCars).map((e) => e.root) : [],
    );

    for (const [root, car] of this.cars) {
      const isOwn = root === ownRoot;
      this._applyHeadlights(car, headlightsOn && (isOwn || litOtherRoots.has(root)));
      this._applyBrake(car, headlightsOn);
    }
  }

  setEnabled(on) {
    this.cfg.enabled = on;
    if (!on) for (const [, car] of this.cars) this._setHeadIntensity(car, 0);
  }

  ingestRoots(roots) {
    for (const root of roots) {
      if (this.cars.has(root) || this._failed.has(root)) continue;
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
      spot.visible = false;
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
      const along = frontEdge + frontSign * (0.12 + c.offsetZ);
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

  _layoutBrake(car) {
    const c = this.cfg, a = car.anchor;
    const frontSign = a.frontSign * (c.manualFlip ? -1 : 1);
    const rearSign = -frontSign;
    const rearEdge = rearSign > 0 ? a.maxEdge : a.minEdge;
    const along = rearEdge + rearSign * 0.10;
    const y = a.bumperY + 0.04;

    const pos = { x: 0, y, z: 0 };
    pos[a.lengthAxis] = along; pos[a.lateralAxis] = a.centerLateral;
    car.brakeSpot.position.set(pos.x, pos.y, pos.z);

    const tgt = { x: 0, y: y - 0.25, z: 0 };
    tgt[a.lengthAxis] = along + rearSign * c.brakeLightDistance;
    tgt[a.lateralAxis] = a.centerLateral;
    car.brakeTarget.position.set(tgt.x, tgt.y, tgt.z);

    car.brakeSpot.distance = c.brakeLightDistance;
    car.brakeSpot.angle = 0.9;
    car.brakeSpot.penumbra = 1.0;
  }

  _setHeadIntensity(car, v) {
    car.headL.spot.intensity = v; car.headL.spot.visible = v > 0;
    car.headR.spot.intensity = v; car.headR.spot.visible = v > 0;
  }

  _applyHeadlights(car, on) {
    this._setHeadIntensity(car, this.cfg.enabled && on ? this.cfg.intensity : 0);
  }

  _applyBrake(car, tailOn) {
    if (!car.brakeMat) return;
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
    car.brakeSpot.visible = car.brakeSpot.intensity > 0;
  }

  applyConfig(partial) {
    Object.assign(this.cfg, partial);
    for (const [, car] of this.cars) { this._layoutHeads(car); this._layoutBrake(car); }
  }

  disableAll() {
    for (const [, car] of this.cars) {
      this._setHeadIntensity(car, 0);
      car.brakeSpot.intensity = 0;
      car.brakeSpot.visible = false;
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
