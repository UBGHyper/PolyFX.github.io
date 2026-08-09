
import * as THREE from './vendor/three.module.js';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

export function isBrakeLightMesh(o) {
  if (!o.isMesh) return false;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  return mats.some((m) => m && m.name === 'BrakeLight');
}

export function rootOf(o, scene) {
  let p = o;
  while (p.parent && p.parent !== scene) p = p.parent;
  return p.parent === scene ? p : null;
}

export function findCarRoots(scene) {
  const roots = new Set();
  scene.traverse((o) => {
    if (!isBrakeLightMesh(o)) return;
    const root = rootOf(o, scene);
    if (root) roots.add(root);
  });
  return roots;
}

export function findBrakeMesh(root) {
  let brakeMesh = null;
  root.traverse((o) => {
    if (brakeMesh || !o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const m = mats.find((m) => m && m.name === 'BrakeLight');
    if (m) brakeMesh = o;
  });
  return brakeMesh;
}

export function localBox(mesh) {
  if (mesh.geometry && mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
  if (mesh.geometry && mesh.geometry.boundingBox) return mesh.geometry.boundingBox.clone();
  return new THREE.Box3().setFromObject(mesh);
}

export function materialBox(mesh, materialIndex) {
  const geo = mesh.geometry;
  const pos = geo && geo.attributes && geo.attributes.position;
  if (!geo || !pos || materialIndex < 0) return null;
  const groups = geo.groups.filter((g) => g.materialIndex === materialIndex);
  if (!groups.length) return null;
  const idx = geo.index;
  const box = _box.makeEmpty();
  for (const g of groups) {
    const end = g.start + g.count;
    for (let i = g.start; i < end; i++) {
      const vi = idx ? idx.getX(i) : i;
      _v.fromBufferAttribute(pos, vi);
      box.expandByPoint(_v);
    }
  }
  return box.isEmpty() ? null : box.clone();
}

export function deriveFrontAnchor(brakeMesh, brakeMaterialIndex) {
  const box = localBox(brakeMesh);
  const brakeBox = materialBox(brakeMesh, brakeMaterialIndex);
  const sizeX = box.max.x - box.min.x, sizeZ = box.max.z - box.min.z;
  const lengthAxis = sizeX >= sizeZ ? 'x' : 'z';
  const lateralAxis = lengthAxis === 'x' ? 'z' : 'x';

  const brakeLocal = (brakeBox || box).getCenter(new THREE.Vector3());

  const distToMin = Math.abs(brakeLocal[lengthAxis] - box.min[lengthAxis]);
  const distToMax = Math.abs(brakeLocal[lengthAxis] - box.max[lengthAxis]);
  const frontSign = distToMax >= distToMin ? 1 : -1;
  const halfWidth = (box.max[lateralAxis] - box.min[lateralAxis]) / 2;
  const centerLateral = (box.max[lateralAxis] + box.min[lateralAxis]) / 2;
  const bumperY = box.min.y + (box.max.y - box.min.y) * 0.22;

  return { lengthAxis, lateralAxis, frontSign, minEdge: box.min[lengthAxis], maxEdge: box.max[lengthAxis], halfWidth, centerLateral, bumperY, floorY: box.min.y };
}

const FALLBACK_ANCHOR = { lengthAxis: 'z', lateralAxis: 'x', frontSign: 1, minEdge: -1.0, maxEdge: 1.0, halfWidth: 0.5, centerLateral: 0, bumperY: 0.25, floorY: 0 };

export function fitCarAnchor(root) {
  const brakeMesh = findBrakeMesh(root);
  if (!brakeMesh) return null;
  const brakeMaterialIndex = Array.isArray(brakeMesh.material) ? brakeMesh.material.findIndex((m) => m && m.name === 'BrakeLight') : 0;

  let anchor;
  try {
    anchor = deriveFrontAnchor(brakeMesh, brakeMaterialIndex);
    const len = Math.abs(anchor.maxEdge - anchor.minEdge);
    if (!Number.isFinite(len) || len < 0.05 || len > 50 || !Number.isFinite(anchor.halfWidth)) {
      throw new Error('degenerate bounding box (len=' + len + ')');
    }
  } catch (e) {
    console.warn('[PolyFX] car anchor derivation failed, using fallback offsets:', e);
    anchor = { ...FALLBACK_ANCHOR };
  }
  return { brakeMesh, brakeMaterialIndex, anchor };
}
