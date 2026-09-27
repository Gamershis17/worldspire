// Minimal geometry merge for static scenery. Items: {geom, x,y,z, ry, s (uniform or [x,y,z]), color}
// Returns one BufferGeometry with baked vertex colors — render with
// new THREE.MeshLambertMaterial({vertexColors: true}) in a SINGLE draw call.
import * as THREE from './vendor/three.module.js';

export function mergeGeoms(items) {
  const geos = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const col = new THREE.Color();
  for (const it of items) {
    const g = it.geom.index ? it.geom.toNonIndexed() : it.geom;
    const sc = it.s === undefined ? [1, 1, 1] : (Array.isArray(it.s) ? it.s : [it.s, it.s, it.s]);
    eul.set(0, it.ry || 0, 0);
    q.setFromEuler(eul);
    m.compose(new THREE.Vector3(it.x || 0, it.y || 0, it.z || 0), q, new THREE.Vector3(sc[0], sc[1], sc[2]));
    g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const carr = new Float32Array(n * 3);
    col.set(it.color === undefined ? 0xffffff : it.color);
    for (let i = 0; i < n; i++) { carr[i * 3] = col.r; carr[i * 3 + 1] = col.g; carr[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(carr, 3));
    geos.push(g);
  }
  // manual concat (avoids BufferGeometryUtils dependency)
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), cuv = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    cuv.set(g.attributes.color.array, o * 3);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(cuv, 3));
  return out;
}

// Shared primitive cache so we don't rebuild BoxGeometry etc. per item.
const _cache = new Map();
export function prim(kind, ...args) {
  const k = kind + ':' + args.join(',');
  let g = _cache.get(k);
  if (!g) {
    if (kind === 'box') g = new THREE.BoxGeometry(args[0], args[1], args[2]);
    else if (kind === 'cone') g = new THREE.ConeGeometry(args[0], args[1], args[2] || 6);
    else if (kind === 'cyl') g = new THREE.CylinderGeometry(args[0], args[1], args[2], args[3] || 7);
    else if (kind === 'sph') g = new THREE.SphereGeometry(args[0], args[1] || 7, args[2] || 6);
    else if (kind === 'plane') g = new THREE.PlaneGeometry(args[0], args[1]);
    _cache.set(k, g);
  }
  return g;
}
