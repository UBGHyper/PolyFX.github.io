
import * as THREE from './vendor/three.module.js';
import { radialTexture } from './sky.js';

const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _carUp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class Underglow {
  constructor(carLights) {
    this.carLights = carLights;
    this.enabled = false;
    this.cfg = {
      color: 0x36e0ff,
      stripIntensity: 1.4,
      blobOpacity: 0.55,
      blobRadius: 1.7,
      pulse: false,
    };
    this._rigs = new Map();
    this._blobTex = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) for (const [, rig] of this._rigs) { rig.strip.visible = false; rig.blob.visible = false; }
  }

  applyConfig(partial) {
    Object.assign(this.cfg, partial);
    for (const [, rig] of this._rigs) this._retint(rig);
  }

  _ensureBlobTexture() {
    if (this._blobTex) return this._blobTex;
    this._blobTex = radialTexture(0, 0.5, [
      [0, 'rgba(255,255,255,1)'],
      [0.55, 'rgba(255,255,255,0.45)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    return this._blobTex;
  }

  _build(scene, car) {
    const stripMat = new THREE.MeshBasicMaterial({
      color: this.cfg.color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
    });
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), stripMat);
    strip.rotation.x = -Math.PI / 2;
    strip.renderOrder = 5;
    car.carrier.add(strip);

    const blobMat = new THREE.MeshBasicMaterial({
      map: this._ensureBlobTexture(), color: this.cfg.color, transparent: true,
      opacity: this.cfg.blobOpacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = 4;
    scene.add(blob);

    return { strip, stripMat, blob, blobMat, groundY: null, lastY: null, lastT: 0 };
  }

  _retint(rig) {
    rig.stripMat.color.set(this.cfg.color);
    rig.blobMat.color.set(this.cfg.color);
  }

  update(scene) {
    if (!this.enabled) return;
    const t = performance.now() * 0.001;

    for (const [root, car] of this.carLights.cars) {
      let rig = this._rigs.get(root);
      if (!rig) { rig = this._build(scene, car); this._rigs.set(root, rig); this._retint(rig); }
      rig.strip.visible = true; rig.blob.visible = true;

      const a = car.anchor;
      const width = a.halfWidth * 2;
      const length = Math.abs(a.maxEdge - a.minEdge);
      const lengthExtent = length * 0.82, lateralExtent = width * 0.94;
      if (a.lengthAxis === 'x') rig.strip.scale.set(lengthExtent, lateralExtent, 1);
      else rig.strip.scale.set(lateralExtent, lengthExtent, 1);

      const pos = { x: 0, y: a.floorY - 0.03, z: 0 };
      pos[a.lengthAxis] = (a.minEdge + a.maxEdge) / 2;
      pos[a.lateralAxis] = a.centerLateral;
      rig.strip.position.set(pos.x, pos.y, pos.z);

      const now = performance.now();
      car.carrier.getWorldPosition(_worldPos);
      if (rig.lastY == null) { rig.lastY = _worldPos.y; rig.groundY = _worldPos.y; rig.lastT = now; }
      const dt = Math.max(0.001, (now - rig.lastT) / 1000);
      const verticalSpeed = (_worldPos.y - rig.lastY) / dt;
      rig.lastY = _worldPos.y; rig.lastT = now;
      const grounded = Math.abs(verticalSpeed) < 2.5;
      if (grounded) rig.groundY += (_worldPos.y - rig.groundY) * Math.min(1, dt * 6);
      const heightAboveGround = Math.max(0, _worldPos.y - rig.groundY);
      const airFade = THREE.MathUtils.clamp(1 - heightAboveGround / 1.2, 0, 1);

      rig.blob.position.set(_worldPos.x, rig.groundY + a.floorY - 0.02, _worldPos.z);
      const r = this.cfg.blobRadius;
      rig.blob.scale.set(r * 2, r * 2, 1);

      car.carrier.getWorldQuaternion(_worldQuat);
      _carUp.set(0, 1, 0).applyQuaternion(_worldQuat);
      const uprightness = THREE.MathUtils.clamp(_carUp.dot(WORLD_UP), 0, 1);

      const pulse = this.cfg.pulse ? 0.75 + 0.25 * Math.sin(t * 3.4) : 1;
      rig.stripMat.opacity = 0.85 * this.cfg.stripIntensity * pulse * uprightness;
      rig.blobMat.opacity = this.cfg.blobOpacity * pulse * airFade;
    }

    for (const [root, rig] of this._rigs) {
      if (!this.carLights.cars.has(root)) { this._disposeRig(rig); this._rigs.delete(root); }
    }
  }

  _disposeRig(rig) {
    if (rig.strip.parent) rig.strip.parent.remove(rig.strip);
    if (rig.blob.parent) rig.blob.parent.remove(rig.blob);
    rig.strip.geometry.dispose(); rig.stripMat.dispose();
    rig.blob.geometry.dispose(); rig.blobMat.dispose();
  }

  dispose() {
    for (const [, rig] of this._rigs) this._disposeRig(rig);
    this._rigs.clear();
  }
}
