// world3d.js — WORLDSPIRE phase-1 3D client (Three.js r160, vendored).
//
// Exports: initWorld(canvas, net) -> api
//   api = {
//     render(dt),            // call every frame; dt in seconds. Never throws.
//     setQuality(q),         // 'low' | 'medium' | 'high'; persists to localStorage 'ws_quality'.
//     getCameraYaw(),        // current camera yaw (radians) for camera-relative movement.
//     cycleTarget(),         // Tab: target nearest alive mob within 30 m.
//     fx: {
//       damage(id, amount, crit, label, srcId?), // floating damage number over entity id.
//       projectile(fromId, toId, kind),          // 'fire'|'frost'|'arrow'|'nature' cosmetic bolt.
//       die(id),                                // corpse tipping is driven by ent.dead; no-op hook.
//       levelUp(),                              // golden burst around the local player.
//     },
//   }
//
// DOM ids created (if missing): #nameplates (pooled nameplate divs), #dmgnums (pooled
// floating damage numbers). Both are position:fixed overlays with pointer-events:none.
//
// PERFORMANCE NOTES (weak integrated graphics):
// - WebGLRenderer with antialias ONLY when quality !== 'low'. NOTE: the antialias flag is
//   fixed at renderer construction; calling setQuality() applies pixelRatio live, but a
//   change to antialias itself takes effect after a page reload.
// - shadowMap is NEVER enabled. Lights: 1 HemisphereLight + 1 DirectionalLight, no shadows.
// - Materials: ONLY THREE.MeshLambertMaterial for world geometry/characters.
//   THREE.MeshBasicMaterial is used ONLY for transient FX (projectiles, level-up burst,
//   target ring) where lighting is irrelevant — never Standard/Phong anywhere.
// - Static scenery (huts/trees/well/fences/rocks/clouds/dirt) is merged into ONE mesh
//   with baked vertex colors (1 draw call) + 1 ground plane mesh.
// - scene.fog = Fog(sky, 30, 90) limits draw distance.
// - Steady-state draw calls: ~2 (world) + ~7-8 per player + 1-3 per mob + 1 target ring
//   ≈ under 60 in normal play. Transient FX (projectiles, level-up) add a few briefly.

import * as THREE from './vendor/three.module.js';
import { state } from './state.js';
import { mergeGeoms, prim } from './merge.js';

const QUALITY_KEY = 'ws_quality';
const SKY = 0x87b5e0;
const MAX_PLATES = 40;
const MAX_DMG = 30;
const MAX_PROJ = 12;
const MAX_TETRA = 12;

// ---------------------------------------------------------------- utils
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
const lamVC = () => new THREE.MeshLambertMaterial({ vertexColors: true });

function ensureCss() {
  if (document.getElementById('ws3d-css')) return;
  const s = document.createElement('style');
  s.id = 'ws3d-css';
  s.textContent = `
#nameplates,#dmgnums{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:5}
.ws-plate{position:absolute;left:0;top:0;text-align:center;font:11px system-ui,sans-serif;
 color:#fff;text-shadow:0 1px 2px #000,0 0 3px #000;white-space:nowrap}
.wp-name{font-weight:600}
.wp-guild{color:#8fd694;font-size:10px;line-height:1.2;min-height:0}
.wp-bar{width:58px;height:6px;background:rgba(0,0,0,.55);border:1px solid rgba(0,0,0,.8);
 margin:1px auto 0;border-radius:2px}
.wp-fill{height:100%;border-radius:1px}
.wp-cast{color:#9fd8ff;font-size:10px;min-height:12px}
.ws-dmg{position:absolute;left:0;top:0;font:bold 15px system-ui,sans-serif;color:#fff;
 text-shadow:0 2px 3px #000,0 0 4px #000;pointer-events:none;white-space:nowrap}`;
  document.head.appendChild(s);
}

function ensureDiv(id) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
  return el;
}

// ---------------------------------------------------------------- zone scenery (merged, one draw call)
function addHut(items, hx, hz, ry) {
  const c = Math.cos(ry), s = Math.sin(ry);
  const put = (geom, lx, ly, lz, color, lry) => {
    items.push({ geom, x: hx + lx * c + lz * s, y: ly, z: hz - lx * s + lz * c,
                 ry: ry + (lry || 0), color });
  };
  put(prim('box', 4, 2.2, 3.5), 0, 1.1, 0, 0xb08d5f);            // walls
  put(prim('cone', 3.3, 2.0, 4), 0, 3.2, 0, 0x9a4a35, Math.PI / 4); // pyramid roof
  put(prim('box', 0.95, 1.6, 0.14), 0, 0.8, 1.78, 0x3a2a1c);      // door
  put(prim('box', 0.7, 0.6, 0.12), -1.15, 1.45, 1.78, 0x2c2118); // windows
  put(prim('box', 0.7, 0.6, 0.12), 1.15, 1.45, 1.78, 0x2c2118);
  put(prim('box', 4.3, 0.18, 3.8), 0, 0.09, 0, 0x8d8d94);        // stone foundation
}

function addTree(items, x, z, s) {
  s = s || 1;
  items.push({ geom: prim('cyl', 0.22, 0.3, 1.8, 7), x, y: 0.9 * s, z, color: 0x6b4a2e, s });
  items.push({ geom: prim('cone', 1.7, 2.6, 7), x, y: 2.9 * s, z, color: 0x3f8f3f, s });
  items.push({ geom: prim('cone', 1.15, 1.9, 7), x, y: 4.2 * s, z, color: 0x357a35, s });
}

function addWell(items, x, z) {
  items.push({ geom: prim('cyl', 1.15, 1.25, 0.9, 9), x, y: 0.45, z, color: 0x8d8d94 });
  items.push({ geom: prim('cyl', 0.95, 0.95, 0.12, 9), x, y: 0.72, z, color: 0x3f9fdf }); // water
  items.push({ geom: prim('box', 0.16, 1.9, 0.16), x: x - 1.0, y: 1.35, z, color: 0x5d3f24 });
  items.push({ geom: prim('box', 0.16, 1.9, 0.16), x: x + 1.0, y: 1.35, z, color: 0x5d3f24 });
  items.push({ geom: prim('cone', 1.6, 0.9, 4), x, y: 2.75, z, color: 0x9a4a35, ry: Math.PI / 4 });
}

function addFence(items, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const ry = Math.atan2(dx, dz);
  const n = Math.max(1, Math.round(len / 2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    items.push({ geom: prim('box', 0.18, 1.15, 0.18), x: x1 + dx * t, y: 0.57, z: z1 + dz * t,
                 color: 0x6b4a2e, ry });
  }
  const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
  for (const y of [0.45, 0.85])
    items.push({ geom: prim('box', 0.1, 0.1, len), x: mx, y, z: mz, color: 0x7a5230, ry });
}

function addRock(items, x, z, s) {
  s = s || 1;
  items.push({ geom: prim('sph', 1, 7, 5), x, y: 0.3 * s, z, color: 0x8d8d94, s: [s, s * 0.55, s * 0.9] });
}

function addClouds(items) {
  const spots = [[-20, 26, -15], [15, 28, -25], [30, 25, 10], [-30, 27, 15], [2, 29, 30]];
  for (const [x, y, z] of spots) {
    items.push({ geom: prim('sph', 2.2, 7, 5), x, y, z, color: 0xffffff, s: [1.4, 0.55, 1] });
    items.push({ geom: prim('sph', 1.6, 7, 5), x: x + 2.3, y: y - 0.4, z, color: 0xf2f6ff, s: [1.2, 0.5, 1] });
    items.push({ geom: prim('sph', 1.6, 7, 5), x: x - 2.3, y: y - 0.5, z: z + 0.6, color: 0xf2f6ff, s: [1.2, 0.5, 1] });
  }
}

// ---------------------------------------------------------------- character templates
// Appearance palettes (indices mirror server/data.js APPEARANCE). Also drives the
// creation-screen swatches via the exported APPEARANCE_UI.
export const APPEARANCE_UI = {
  skins: [0xf2c89b, 0xe0aa7e, 0xc98a5e, 0xa06a42, 0x7a4e2e, 0x5c3a24],
  skinNames: ['Fair', 'Tan', 'Bronze', 'Brown', 'Dark', 'Deep'],
  hairColors: [0x2b2b2b, 0x5d3f24, 0xb0653a, 0xd9a441, 0x8c8c8c, 0xa02828],
  hairColorNames: ['Black', 'Brown', 'Auburn', 'Blond', 'Grey', 'Red'],
  faceNames: ['Stern', 'Heavy Brow', 'Scarred', 'War Paint'],
  hairStyleNames: ['Bald', 'Short', 'Long', 'Mohawk'],
};
export const DEFAULT_APPEARANCE_UI = { skin: 1, face: 0, hairStyle: 1, hairColor: 1 };
function sanitizeApp(a) {
  const d = DEFAULT_APPEARANCE_UI;
  if (!a || typeof a !== 'object') return { ...d };
  const iv = (v, max, fb) => (Number.isInteger(v) && v >= 0 && v < max ? v : fb);
  return {
    skin: iv(a.skin, APPEARANCE_UI.skins.length, d.skin),
    face: iv(a.face, APPEARANCE_UI.faceNames.length, d.face),
    hairStyle: iv(a.hairStyle, APPEARANCE_UI.hairStyleNames.length, d.hairStyle),
    hairColor: iv(a.hairColor, APPEARANCE_UI.hairColors.length, d.hairColor),
  };
}
const appSig = (a) => `${a.skin}|${a.face}|${a.hairStyle}|${a.hairColor}`;

// Apply a sanitized appearance to an instantiated player: skin tone, hair
// style + color, face variant. Updates material c0 so death grey-out restores
// the appearance colors.
export function applyAppearance(inst, app) {
  const a = sanitizeApp(app);
  const skinHex = APPEARANCE_UI.skins[a.skin];
  const hairHex = APPEARANCE_UI.hairColors[a.hairColor];
  inst.group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData.skin) {
      o.material.color.setHex(skinHex);
      o.material.userData.c0 = skinHex;
    } else if (o.userData.hair !== undefined) {
      const show = o.userData.hair === a.hairStyle;
      o.visible = show;
      if (show) { o.material.color.setHex(hairHex); o.material.userData.c0 = hairHex; }
    } else if (o.userData.face !== undefined) {
      o.visible = o.userData.face === a.face;
    }
  });
  inst.group.userData.appSig = appSig(a);
}

// Hair styles (head-local coords; head box is 0.34 x 0.36 x 0.32).
function buildHairMeshes() {
  const defs = [
    null, // 0 = bald
    [{ geom: prim('box', 0.38, 0.13, 0.36), y: 0.225 }],                                    // 1 short
    [{ geom: prim('box', 0.38, 0.13, 0.36), y: 0.225 },                                     // 2 long
     { geom: prim('box', 0.38, 0.55, 0.12), y: -0.08, z: -0.2 }],
    [{ geom: prim('box', 0.1, 0.3, 0.38), y: 0.32 }],                                       // 3 mohawk
  ];
  return defs.map((parts, i) => {
    if (!parts) return null;
    const m = new THREE.Mesh(mergeGeoms(parts.map((p) => ({ ...p, color: 0xffffff }))),
      new THREE.MeshLambertMaterial({ color: 0x5d3f24 }));
    m.userData.hair = i;
    m.visible = false;
    return m;
  });
}

// Face variants (face front z = 0.16; eyes dark, extras colored).
function buildFaceMeshes() {
  const EYE = 0x141414;
  const defs = [
    [ // 0 stern: standard eyes
      { geom: prim('box', 0.06, 0.05, 0.03), x: -0.08, y: 0.03, z: 0.165, color: EYE },
      { geom: prim('box', 0.06, 0.05, 0.03), x: 0.08, y: 0.03, z: 0.165, color: EYE },
    ],
    [ // 1 heavy brow: narrower eyes + brow ridge
      { geom: prim('box', 0.07, 0.04, 0.03), x: -0.09, y: 0.0, z: 0.165, color: EYE },
      { geom: prim('box', 0.07, 0.04, 0.03), x: 0.09, y: 0.0, z: 0.165, color: EYE },
      { geom: prim('box', 0.11, 0.03, 0.02), x: -0.085, y: 0.1, z: 0.165, color: 0x3a2a1a },
      { geom: prim('box', 0.11, 0.03, 0.02), x: 0.085, y: 0.1, z: 0.165, color: 0x3a2a1a },
    ],
    [ // 2 scarred: standard eyes + scar slash
      { geom: prim('box', 0.06, 0.05, 0.03), x: -0.08, y: 0.03, z: 0.165, color: EYE },
      { geom: prim('box', 0.06, 0.05, 0.03), x: 0.08, y: 0.03, z: 0.165, color: EYE },
      { geom: prim('box', 0.035, 0.24, 0.015), x: 0.07, y: 0.0, z: 0.168, color: 0x8a3030 },
    ],
    [ // 3 war paint: paint band + eyes
      { geom: prim('box', 0.32, 0.09, 0.015), x: 0, y: 0.02, z: 0.166, color: 0x28304a },
      { geom: prim('box', 0.06, 0.05, 0.03), x: -0.08, y: 0.03, z: 0.172, color: EYE },
      { geom: prim('box', 0.06, 0.05, 0.03), x: 0.08, y: 0.03, z: 0.172, color: EYE },
    ],
  ];
  return defs.map((parts, i) => {
    const m = new THREE.Mesh(mergeGeoms(parts), lamVC());
    m.userData.face = i;
    m.visible = false;
    return m;
  });
}

const CLASS_COLORS = {
  warrior: { torso: 0x8a8f98, trim: 0xa02828, legs: 0x565b64, skin: 0xe0aa7e },
  mage:    { torso: 0x2b3fa0, trim: 0x8fb8ff, legs: 0x2b3fa0, skin: 0xe0aa7e, robe: true },
  ranger:  { torso: 0x3f7a3f, trim: 0x8a5a2b, legs: 0x5d4630, skin: 0xe0aa7e },
};

function buildPlayerTemplate(cls) {
  const C = CLASS_COLORS[cls] || CLASS_COLORS.warrior;
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body'; root.add(body);

  const torsoGeo = mergeGeoms([
    { geom: prim('box', 0.56, 0.72, 0.34), y: 1.3, color: C.torso },
    { geom: prim('box', 0.72, 0.16, 0.4), y: 1.6, color: C.trim },   // shoulder trim
    { geom: prim('box', 0.6, 0.1, 0.36), y: 0.98, color: C.trim },   // belt
    ...(C.robe ? [{ geom: prim('cone', 0.52, 1.6, 7), y: 0.8, color: C.torso }] : []),
  ]);
  body.add(new THREE.Mesh(torsoGeo, lamVC()));

  const headG = new THREE.Group(); headG.name = 'head'; headG.position.y = 1.86; body.add(headG);
  const headMesh = new THREE.Mesh(prim('box', 0.34, 0.36, 0.32),
    new THREE.MeshLambertMaterial({ color: C.skin }));
  headMesh.userData.skin = true;
  headG.add(headMesh);
  for (const hm of buildHairMeshes()) if (hm) headG.add(hm);
  for (const fm of buildFaceMeshes()) headG.add(fm);

  const armSleeveGeo = mergeGeoms([
    { geom: prim('box', 0.17, 0.62, 0.2), y: -0.31, color: C.torso },
  ]);
  const handGeo = prim('box', 0.15, 0.16, 0.17);
  const mkHand = () => {
    const h = new THREE.Mesh(handGeo, new THREE.MeshLambertMaterial({ color: C.skin }));
    h.position.y = -0.68; h.userData.skin = true;
    return h;
  };
  const armL = new THREE.Group(); armL.name = 'armL'; armL.position.set(-0.38, 1.56, 0);
  armL.add(new THREE.Mesh(armSleeveGeo, lamVC())); armL.add(mkHand()); body.add(armL);
  const armR = new THREE.Group(); armR.name = 'armR'; armR.position.set(0.38, 1.56, 0);
  armR.add(new THREE.Mesh(armSleeveGeo, lamVC())); armR.add(mkHand()); body.add(armR);

  const legGeo = mergeGeoms([{ geom: prim('box', 0.22, 0.95, 0.24), y: -0.475, color: C.legs }]);
  const legL = new THREE.Group(); legL.name = 'legL'; legL.position.set(-0.15, 0.95, 0);
  legL.add(new THREE.Mesh(legGeo, lamVC())); body.add(legL);
  const legR = new THREE.Group(); legR.name = 'legR'; legR.position.set(0.15, 0.95, 0);
  legR.add(new THREE.Mesh(legGeo, lamVC())); body.add(legR);

  if (cls === 'warrior') {
    const sword = new THREE.Mesh(mergeGeoms([
      { geom: prim('box', 0.09, 0.85, 0.05), y: -0.5, color: 0xc9d2dd },  // blade
      { geom: prim('box', 0.24, 0.07, 0.09), y: -0.06, color: C.trim },  // guard
    ]), lamVC());
    sword.position.set(0, -0.72, 0.06); armR.add(sword);
  } else if (cls === 'mage') {
    const shaft = new THREE.Mesh(mergeGeoms([
      { geom: prim('cyl', 0.045, 0.045, 1.5, 6), y: -0.4, color: 0x6b4a2e },
    ]), lamVC());
    shaft.position.set(0, -0.72, 0.06); armR.add(shaft);
    const orb = new THREE.Mesh(prim('sph', 0.14, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0x3fa9ff, emissive: 0x2266cc }));
    orb.position.set(0, 0.45, 0); shaft.add(orb);
  } else { // ranger
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 6, 12, Math.PI),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2e }));
    bow.rotation.z = Math.PI / 2; bow.position.set(0, -0.72, 0.1); armL.add(bow);
  }

  root.scale.setScalar(0.92); // ~1.85 m tall
  return root;
}

function buildMobTemplate(type) {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body'; root.add(body);
  if (type === 'boar') {
    const g = mergeGeoms([
      { geom: prim('box', 1.05, 0.62, 0.62), y: 0.62, color: 0x7a5230 },
      { geom: prim('box', 0.44, 0.44, 0.4), y: 0.72, z: 0.62, color: 0x7a5230 },
      { geom: prim('box', 0.24, 0.2, 0.2), y: 0.64, z: 0.9, color: 0xc98a7a }, // snout
      { geom: prim('box', 0.07, 0.18, 0.07), x: -0.15, y: 0.56, z: 0.88, color: 0xf2ede2, ry: 0.3 },
      { geom: prim('box', 0.07, 0.18, 0.07), x: 0.15, y: 0.56, z: 0.88, color: 0xf2ede2, ry: -0.3 },
      { geom: prim('box', 0.16, 0.42, 0.16), x: -0.32, y: 0.21, z: 0.22, color: 0x5d3f24 },
      { geom: prim('box', 0.16, 0.42, 0.16), x: 0.32, y: 0.21, z: 0.22, color: 0x5d3f24 },
      { geom: prim('box', 0.16, 0.42, 0.16), x: -0.32, y: 0.21, z: -0.22, color: 0x5d3f24 },
      { geom: prim('box', 0.16, 0.42, 0.16), x: 0.32, y: 0.21, z: -0.22, color: 0x5d3f24 },
    ]);
    body.add(new THREE.Mesh(g, lamVC()));
  } else { // wolf | alpha
    const fur = type === 'alpha' ? 0x6a2b2b : 0x7d7d88;
    const dark = type === 'alpha' ? 0x4a1f1f : 0x5f5f6a;
    const parts = [
      { geom: prim('box', 1.15, 0.55, 0.52), y: 0.62, color: fur },
      { geom: prim('box', 0.4, 0.38, 0.38), y: 0.95, z: 0.62, color: fur },
      { geom: prim('box', 0.2, 0.18, 0.26), y: 0.88, z: 0.88, color: dark }, // snout
      { geom: prim('cone', 0.09, 0.22, 4), x: -0.13, y: 1.2, z: 0.6, color: dark }, // ears
      { geom: prim('cone', 0.09, 0.22, 4), x: 0.13, y: 1.2, z: 0.6, color: dark },
      { geom: prim('box', 0.12, 0.12, 0.5), y: 0.78, z: -0.72, color: dark }, // tail
      { geom: prim('box', 0.14, 0.45, 0.14), x: -0.3, y: 0.22, z: 0.25, color: dark },
      { geom: prim('box', 0.14, 0.45, 0.14), x: 0.3, y: 0.22, z: 0.25, color: dark },
      { geom: prim('box', 0.14, 0.45, 0.14), x: -0.3, y: 0.22, z: -0.25, color: dark },
      { geom: prim('box', 0.14, 0.45, 0.14), x: 0.3, y: 0.22, z: -0.25, color: dark },
    ];
    body.add(new THREE.Mesh(mergeGeoms(parts), lamVC()));
    const eyes = new THREE.Mesh(mergeGeoms([
      { geom: prim('box', 0.08, 0.08, 0.06), x: -0.12, y: 1.0, z: 0.8, color: 0xff3333 },
      { geom: prim('box', 0.08, 0.08, 0.06), x: 0.12, y: 1.0, z: 0.8, color: 0xff3333 },
    ]), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xaa0000 }));
    body.add(eyes);
    if (type === 'alpha') {
      const mane = new THREE.Mesh(prim('box', 0.55, 0.28, 0.95),
        new THREE.MeshLambertMaterial({ color: 0x7a1f1f, emissive: 0x550000 }));
      mane.position.set(0, 1.02, 0.15); body.add(mane);
      root.scale.setScalar(1.7);
    }
  }
  return root;
}

const _templates = {};
function getTemplate(kind, sub) {
  const key = kind + ':' + sub;
  if (!_templates[key]) _templates[key] = kind === 'player' ? buildPlayerTemplate(sub) : buildMobTemplate(sub);
  return _templates[key];
}

// Clone a template for one entity: fresh materials (so death grey-out is per-entity),
// rig pivots re-collected by name. A `tint` hex color bakes a slight tint into the
// base colors (used for tamed pets).
function instantiate(kind, sub, tint) {
  const g = getTemplate(kind, sub).clone(true);
  const mats = [];
  const tc = tint ? new THREE.Color(tint) : null;
  g.traverse(o => {
    if (o.isMesh) {
      o.material = o.material.clone();
      if (tc) o.material.color.lerp(tc, 0.35); // slight golden tint for pets
      o.material.userData.c0 = o.material.color.getHex();
      o.material.userData.e0 = o.material.emissive ? o.material.emissive.getHex() : 0;
      mats.push(o.material);
    }
  });
  return {
    group: g, mats,
    rig: {
      body: g.getObjectByName('body'), head: g.getObjectByName('head'),
      armL: g.getObjectByName('armL'), armR: g.getObjectByName('armR'),
      legL: g.getObjectByName('legL'), legR: g.getObjectByName('legR'),
    },
    walkPhase: Math.random() * 6.28, flinch: 0, tipped: false, rx: 0, rz: 0,
  };
}

function setDead(inst, dead) {
  if (inst.tipped === dead) return;
  inst.tipped = dead;
  inst.group.rotation.z = dead ? Math.PI / 2 * 0.94 : 0;
  for (const m of inst.mats) {
    if (dead) {
      m.color.setHex(m.userData.c0).multiplyScalar(0.45);
      if (m.emissive) m.emissive.setHex(m.userData.e0).multiplyScalar(0.35);
    } else {
      m.color.setHex(m.userData.c0);
      if (m.emissive) m.emissive.setHex(m.userData.e0);
    }
  }
}

// ---------------------------------------------------------------- initWorld
export function initWorld(canvas, net) {
  ensureCss();
  const platesEl = ensureDiv('nameplates');
  const dmgEl = ensureDiv('dmgnums');

  let quality = 'low';
  try { quality = localStorage.getItem(QUALITY_KEY) || 'low'; } catch (e) { /* private mode */ }

  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low' });
  } catch (e) { renderer = null; }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 30, 90);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 220);

  if (renderer) {
    scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x6a8f5f, 0.95));
    const sun = new THREE.DirectionalLight(0xfff2dd, 0.85);
    sun.position.set(30, 50, 20);
    scene.add(sun);
    // Ground: one 140x140 plane (its own draw call; dirt patches join the merged mesh).
    const gg = new THREE.PlaneGeometry(140, 140); gg.rotateX(-Math.PI / 2);
    scene.add(new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ color: 0x5da24a })));
  }

  // ---- state
  let built = false;
  let yaw = 0.6, pitch = 0.34, locked = false;
  let cycleIdx = -1;
  let errLogged = false;
  const models = new Map(); // entId -> { inst, sub }
  const local = { inst: null, lx: 0, lz: 0, init: false };
  let lastW = 0, lastH = 0;

  // ---- target ring (single draw call, repositioned)
  let ring = null;
  if (renderer) {
    const rg = new THREE.RingGeometry(0.9, 1.12, 24); rg.rotateX(-Math.PI / 2);
    ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
      color: 0xffd34d, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
    }));
    ring.visible = false;
    scene.add(ring);
  }

  // ---- nameplate pool
  const plates = [];
  for (let i = 0; i < MAX_PLATES; i++) {
    const d = document.createElement('div');
    d.className = 'ws-plate';
    d.style.display = 'none';
    d.innerHTML = '<div class="wp-name"></div><div class="wp-guild"></div><div class="wp-bar"><div class="wp-fill"></div></div><div class="wp-cast"></div>';
    platesEl.appendChild(d);
    plates.push({ el: d, name: d.children[0], guild: d.children[1],
                  fill: d.children[2].firstChild, cast: d.children[3], sig: '', used: false });
  }

  // ---- damage-number pool
  const dmgPool = [];
  for (let i = 0; i < MAX_DMG; i++) {
    const d = document.createElement('div');
    d.className = 'ws-dmg';
    d.style.display = 'none';
    dmgEl.appendChild(d);
    dmgPool.push({ el: d, t: 0, x: 0, y: 0, active: false });
  }

  // ---- projectile pool (MeshBasicMaterial — unlit FX, allowed)
  const projPool = [];
  const projSphere = new THREE.SphereGeometry(0.14, 8, 6);
  const projArrow = new THREE.BoxGeometry(0.08, 0.08, 0.7);
  if (renderer) for (let i = 0; i < MAX_PROJ; i++) {
    const m = new THREE.Mesh(projSphere, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.visible = false; scene.add(m);
    projPool.push({ mesh: m, t: 0, active: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, arrow: false });
  }
  const PROJ_STYLE = {
    fire:   { color: 0xff7b24, arrow: false },
    frost:  { color: 0x9fd8ff, arrow: false },
    arrow:  { color: 0x8a5a2b, arrow: true },
    nature: { color: 0x7dff8a, arrow: false },
  };

  // ---- level-up tetra burst pool
  const tetraPool = [];
  const tetraGeo = new THREE.TetrahedronGeometry(0.22);
  if (renderer) for (let i = 0; i < MAX_TETRA; i++) {
    const m = new THREE.Mesh(tetraGeo, new THREE.MeshBasicMaterial({
      color: 0xffd34d, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    m.visible = false; scene.add(m);
    tetraPool.push({ mesh: m, t: 0, active: false, ang: 0, rad: 0 });
  }

  // ---- zone build (lazy: waits for hello -> state.me.layout)
  function buildZone(layout) {
    const items = [];
    for (const [x, z, r] of [[6, 12, 4.5], [-8, 5, 3.5], [3, -4, 5.5], [-4, 16, 3]]) {
      const g = new THREE.CircleGeometry(r, 10); g.rotateX(-Math.PI / 2);
      items.push({ geom: g, x, y: 0.02, z, color: 0x8a6b46 });
    }
    for (const h of (layout.huts || [])) addHut(items, h.x, h.z, h.ry || 0);
    for (const t of (layout.trees || [])) addTree(items, t.x, t.z, t.s || 1);
    if (layout.well) addWell(items, layout.well.x, layout.well.z);
    for (const f of (layout.fences || [])) addFence(items, f.x1, f.z1, f.x2, f.z2);
    for (const r of (layout.rocks || [])) addRock(items, r.x, r.z, r.s || 1);
    addClouds(items);
    scene.add(new THREE.Mesh(mergeGeoms(items), lamVC()));
  }

  // ---- sizing
  function onResize() {
    const w = canvas.clientWidth || 0, h = canvas.clientHeight || 0;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function applyQuality() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const pr = quality === 'low' ? 0.66 : quality === 'medium' ? 1 : Math.min(dpr, 2);
    renderer.setPixelRatio(pr);
    onResize();
  }
  if (renderer) { applyQuality(); window.addEventListener('resize', onResize); }

  // ---- input: pointer-lock mouse look + click targeting
  const raycaster = new THREE.Raycaster();
  let downPos = null, downLocked = false;
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', e => {
    if (!locked) return;
    yaw -= (e.movementX || 0) * 0.003;
    pitch = Math.max(-0.1, Math.min(1.0, pitch + (e.movementY || 0) * 0.003));
  });
  canvas.addEventListener('mousedown', e => {
    downPos = [e.clientX, e.clientY];
    downLocked = document.pointerLockElement === canvas;
  });
  canvas.addEventListener('mouseup', e => {
    const wasLocked = downLocked;
    const dx = downPos ? e.clientX - downPos[0] : 99;
    const dy = downPos ? e.clientY - downPos[1] : 99;
    downPos = null;
    if (!renderer || !state.me) return;
    if (!wasLocked) {
      // First click just captures the mouse (WoW-style mouse look); no targeting.
      try { canvas.requestPointerLock(); } catch (err) { /* ignore */ }
      return;
    }
    if (Math.hypot(dx, dy) > 6) return; // it was a drag, not a click
    // Pointer is locked: pick whatever is under the crosshair (screen center).
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const roots = [];
    if (local.inst) roots.push(local.inst.group);
    for (const rec of models.values()) roots.push(rec.inst.group);
    const hits = raycaster.intersectObjects(roots, true);
    let id = null;
    if (hits.length) {
      let o = hits[0].object;
      while (o && o.userData.entId === undefined) o = o.parent;
      if (o) id = o.userData.entId;
    }
    state.targetId = id; // miss (ground/sky) clears the target
    net.target(id);
  });
  window.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    // don't steal Tab from chat inputs / form fields
    const t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    api.cycleTarget();
  });

  // ---- helpers
  const _v = new THREE.Vector3();
  function screenOf(x, y, z) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    _v.set(x, y, z).project(camera);
    if (_v.z > 1) return null;
    return [(_v.x * 0.5 + 0.5) * w, (-_v.y * 0.5 + 0.5) * h];
  }
  function headPosOf(id) {
    if (state.me && id === state.me.id && local.inst) {
      const p = local.inst.group.position;
      return { x: p.x, y: 2.1, z: p.z };
    }
    const rec = models.get(id);
    if (rec) return { x: rec.inst.rx, y: rec.kind === 'player' ? 2.1 : 1.3, z: rec.inst.rz };
    const ent = state.ents.get(id);
    if (ent) return { x: ent.x, y: 2.0, z: ent.z };
    return null;
  }
  function chestPosOf(id) {
    const h = headPosOf(id);
    return h ? { x: h.x, y: h.y - 0.9, z: h.z } : null;
  }
  function recOf(id) {
    if (state.me && id === state.me.id) return local.inst ? { inst: local.inst } : null;
    const rec = models.get(id);
    return rec || null;
  }

  // ---- animation
  // emote: null | 'dance' | 'sit' | 'sleep' | 'lol' | 'joke' (server-authoritative via snap/stats)
  function animateRig(rec, moving, dead, dt, emote) {
    const inst = rec.inst || rec; // local uses bare inst
    const r = inst.rig;
    // track emote changes: reset one-shot offsets when an emote ends
    if (inst._emPrev !== (emote || null)) {
      inst._emPrev = emote || null;
      inst.emoteT = 0;
      if (!emote) {
        if (r.body) { r.body.rotation.x = 0; }
        if (r.head) { r.head.rotation.x = 0; }
        if (r.armL) r.armL.rotation.z = 0;
        if (r.armR) r.armR.rotation.z = 0;
      }
    }
    if (emote) inst.emoteT = (inst.emoteT || 0) + dt;
    const et = inst.emoteT || 0;
    // dance spins the whole figure
    if (emote === 'dance' && !dead) inst.emoteSpin = (inst.emoteSpin || 0) + dt * 2.4;
    else if (inst.emoteSpin) inst.emoteSpin = Math.max(0, inst.emoteSpin - dt * 6);

    if (moving && !dead) inst.walkPhase += dt * 9;
    const sw = (moving && !dead) ? Math.sin(inst.walkPhase) * 0.55 : 0;
    const k = Math.min(1, dt * 12);
    // default targets (walk/idle), overridden by emotes below
    let tArmL = sw, tArmR = -sw, tLegL = -sw, tLegR = sw, tBodyY = 0, tBodyRX = 0;
    if (emote && !dead) {
      if (emote === 'dance') {
        const b = Math.sin(et * 8);
        tBodyY = Math.abs(b) * 0.12;      // rhythmic bounce
        tArmL = b * 0.95; tArmR = -b * 0.95; // alternating arm swings
        tLegL = -b * 0.3; tLegR = b * 0.3;
      } else if (emote === 'sit') {
        tBodyY = -0.45;                   // lowered seated pose
        tLegL = -1.45; tLegR = -1.45;     // folded legs
        tArmL = -0.3; tArmR = -0.3;
      } else if (emote === 'sleep') {
        tBodyRX = -1.35;                  // lying flat on the back
        tBodyY = -0.55;
        tArmL = -0.15; tArmR = -0.15; tLegL = 0; tLegR = 0;
      } else if (emote === 'lol') {
        const j = Math.sin(et * 14);
        tBodyY = Math.abs(j) * 0.045;     // body shake
        tArmL = -0.9 + j * 0.12; tArmR = -0.9 - j * 0.12; // hands toward belly
        if (r.head) r.head.rotation.x = j * 0.28; // head bob
      } else if (emote === 'joke') {
        const bow = Math.sin(Math.min(1, et / 3) * Math.PI); // flourish bow over ~3 s
        tBodyRX = bow * 0.65;
        tArmL = -bow * 0.4; tArmR = -bow * 0.4;
        if (r.armL) r.armL.rotation.z += ((bow * 1.1) - r.armL.rotation.z) * k; // arms sweep out
        if (r.armR) r.armR.rotation.z += ((-bow * 1.1) - r.armR.rotation.z) * k;
      }
    }
    if (r.armL) r.armL.rotation.x += (tArmL - r.armL.rotation.x) * k;
    if (r.armR) r.armR.rotation.x += (tArmR - r.armR.rotation.x) * k;
    if (r.legL) r.legL.rotation.x += (tLegL - r.legL.rotation.x) * k;
    if (r.legR) r.legR.rotation.x += (tLegR - r.legR.rotation.x) * k;
    if (r.body) {
      const bob = (moving && !dead) ? Math.abs(Math.sin(inst.walkPhase)) * 0.07 : 0;
      r.body.position.y += ((emote && !dead ? tBodyY : bob) - r.body.position.y) * k;
      r.body.rotation.x += (tBodyRX - r.body.rotation.x) * k;
      // mobs have no pivoted legs: rock the body a touch instead
      if (!r.armL) r.body.rotation.x = (moving && !dead) ? Math.sin(inst.walkPhase) * 0.05 : 0;
    }
    if (inst.flinch > 0) {
      inst.flinch = Math.max(0, inst.flinch - dt * 6);
      if (r.body) r.body.position.z = inst.flinch * 0.18;
    } else if (r.body && r.body.position.z !== 0) {
      r.body.position.z = 0;
    }
  }

  // ---- per-frame entity sync
  function syncEntities(dt, now) {
    const seen = new Set();
    const me = state.me;
    if (!me) return;
    for (const ent of state.ents.values()) {
      if (ent.id === me.id) continue; // local player rendered separately (client-predicted)
      seen.add(ent.id);
      const sub = ent.kind === 'player' ? (ent.cls || 'warrior') : (ent.mob || 'boar');
      let rec = models.get(ent.id);
      const tint = ent.kind === 'pet' ? 0xd4a017 : 0; // golden tint marks tamed beasts
      if (!rec) {
        rec = { inst: instantiate(ent.kind, sub, tint), sub, kind: ent.kind };
        rec.inst.group.userData.entId = ent.id;
        if (ent.kind === 'player') applyAppearance(rec.inst, ent.appearance);
        scene.add(rec.inst.group);
        models.set(ent.id, rec);
      } else if (rec.sub !== sub || rec.kind !== ent.kind) {
        scene.remove(rec.inst.group);
        rec.inst = instantiate(ent.kind, sub, tint);
        rec.inst.group.userData.entId = ent.id;
        if (ent.kind === 'player') applyAppearance(rec.inst, ent.appearance);
        scene.add(rec.inst.group);
        rec.sub = sub; rec.kind = ent.kind;
      } else if (ent.kind === 'player' && ent.appearance &&
                 rec.inst.group.userData.appSig !== appSig(sanitizeApp(ent.appearance))) {
        applyAppearance(rec.inst, ent.appearance); // appearance changed: re-apply
      }
      const inst = rec.inst;
      const px = ent._px ?? ent.x, pz = ent._pz ?? ent.z;
      const alpha = Math.min(1, Math.max(0, (now - (ent._pt || now)) / 100));
      inst.rx = px + (ent.x - px) * alpha;
      inst.rz = pz + (ent.z - pz) * alpha;
      inst.group.position.set(inst.rx, (inst.tipped ? -0.35 : 0) + (ent.y || 0), inst.rz);
      inst.group.rotation.y = lerpAngle(inst.group.rotation.y, ent.heading || 0, Math.min(1, dt * 10)) + (inst.emoteSpin || 0);
      setDead(inst, !!ent.dead);
      animateRig(rec, !!ent.moving, !!ent.dead, dt, ent.emote || null);
      zzzTick(inst, ent.id, ent.emote || null, dt);
    }
    for (const [id, rec] of models) {
      if (!seen.has(id)) { scene.remove(rec.inst.group); models.delete(id); }
    }
  }

  function syncLocal(dt) {
    const me = state.me;
    if (!me) return;
    if (!local.inst) {
      local.inst = instantiate('player', me.cls || 'warrior');
      applyAppearance(local.inst, me.appearance);
      local.inst.group.userData.entId = me.id;
      scene.add(local.inst.group);
      local.lx = me.x; local.lz = me.z; local.init = true;
    }
    const g = local.inst.group;
    const moved = Math.hypot(me.x - local.lx, me.z - local.lz);
    local.lx = me.x; local.lz = me.z;
    g.position.set(me.x, (local.inst.tipped ? -0.35 : 0) + (me.y || 0), me.z);
    g.rotation.y = (me.heading || 0) + (local.inst.emoteSpin || 0); // client-predicted; no smoothing needed
    setDead(local.inst, !!me.dead);
    animateRig(local, moved > 0.02, !!me.dead, dt, me.emote || null);
    zzzTick(local.inst, me.id, me.emote || null, dt);
  }

  // ---- nameplates
  function updatePlates(now) {
    const me = state.me;
    let pi = 0;
    if (me) {
      for (const ent of state.ents.values()) {
        if (pi >= MAX_PLATES || ent.id === me.id) continue;
        const rec = models.get(ent.id);
        if (!rec) continue;
        const dx = rec.inst.rx - me.x, dz = rec.inst.rz - me.z;
        if (dx * dx + dz * dz > 45 * 45) continue;
        const headY = (ent.kind === 'player' ? 2.15 : 1.35) + (ent.y || 0);
        const s = screenOf(rec.inst.rx, headY, rec.inst.rz);
        if (!s) continue;
        const [sx, sy] = s;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20) continue;
        const p = plates[pi++];
        p.used = true;
        const elite = ent.kind === 'mob' && (ent.elite || ent.mob === 'alpha');
        const isGM = ent.kind === 'player' && !!ent.gm;
        const isPet = ent.kind === 'pet';
        const gname = ent.kind === 'player' ? (ent.guild || '') : '';
        const isAfk = ent.kind === 'player' && !!ent.afk;
        const sig = ent.name + '|' + ent.level + '|' + elite + '|' + ent.kind + '|' + isGM + '|' + gname + '|' +
                    (ent.ownerName || '') + '|' + (ent.casting ? ent.casting.label : '') + '|' + isAfk + '|' + (ent.afkMsg || '');
        if (p.sig !== sig) {
          p.sig = sig;
          // WoW-style: <GM>Name in gold, guild name in smaller text underneath;
          // tamed pets show "<Owner>'s Pet". AFK players get a grey <AFK> tag.
          p.name.textContent = isPet ? `${ent.ownerName}'s Pet`
            : (elite ? '★ ' : '') + (isGM ? '<GM>' : '') + ent.name + '  ' + (ent.level || 1) + (isAfk ? ' <AFK>' : '');
          p.name.style.color = isGM ? '#ffd75e' : isAfk ? '#9a9a9a' : '';
          p.name.title = isAfk ? (ent.afkMsg || 'Away from keyboard') : '';
          p.guild.textContent = gname;
          p.fill.style.background = isPet ? '#8fd694' : isGM ? '#ffd75e' : ent.kind === 'player' ? '#5f5' : elite ? '#fa0' : '#f55';
        }
        const frac = (ent.hp != null && ent.maxHp) ? Math.max(0, Math.min(1, ent.hp / ent.maxHp)) : 1;
        p.fill.style.width = (frac * 100).toFixed(1) + '%';
        p.cast.textContent = ent.casting ? '✦ ' + ent.casting.label + '…' : '';
        p.el.style.display = 'block';
        p.el.style.transform = `translate(${sx.toFixed(0)}px,${sy.toFixed(0)}px) translate(-50%,-100%)`;
      }
    }
    for (let i = pi; i < MAX_PLATES; i++) {
      if (plates[i].used) { plates[i].used = false; plates[i].el.style.display = 'none'; plates[i].sig = ''; }
    }
  }

  // ---- FX updates
  // "Zzz" float above a sleeping character's head (pooled, like damage numbers)
  function zzzTick(inst, id, emote, dt) {
    if (emote === 'sleep') {
      inst._zzzT = (inst._zzzT || 0) + dt;
      if (inst._zzzT > 1.5) {
        inst._zzzT = 0;
        const hp = headPosOf(id);
        const s = hp ? screenOf(hp.x, hp.y, hp.z) : null;
        if (s) floatDmg(s[0] + 8, s[1] - 10, 'Z', '#9fd8ff', 18);
      }
    } else inst._zzzT = 0;
  }
  // shared float-text spawner (damage numbers + emote Zzz)
  function floatDmg(x, y, text, color, size) {
    let d = dmgPool.find(p => !p.active);
    if (!d) { d = dmgPool[0]; } // steal oldest slot when saturated
    d.active = true; d.t = 0;
    d.x = x + (Math.random() * 16 - 8);
    d.y = y;
    d.el.textContent = text;
    d.el.style.display = 'block';
    d.el.style.color = color;
    d.el.style.fontSize = size + 'px';
  }
  function updateDmg(dt) {
    for (const d of dmgPool) {
      if (!d.active) continue;
      d.t += dt;
      if (d.t >= 0.8) { d.active = false; d.el.style.display = 'none'; continue; }
      d.el.style.transform = `translate(${d.x.toFixed(0)}px,${(d.y - d.t * 75).toFixed(0)}px) translate(-50%,-50%)`;
      d.el.style.opacity = (1 - d.t / 0.8).toFixed(2);
    }
  }
  function updateProj(dt) {
    for (const p of projPool) {
      if (!p.active) continue;
      p.t += dt / 0.35;
      if (p.t >= 1) { p.active = false; p.mesh.visible = false; continue; }
      const x = p.ax + (p.bx - p.ax) * p.t;
      const z = p.az + (p.bz - p.az) * p.t;
      const y = p.ay + (p.by - p.ay) * p.t + Math.sin(p.t * Math.PI) * 1.1;
      p.mesh.position.set(x, y, z);
      if (p.arrow) {
        _v.set(p.bx - p.ax, 0, p.bz - p.az);
        if (_v.lengthSq() > 0.0001) p.mesh.rotation.y = Math.atan2(_v.x, _v.z);
      } else {
        p.mesh.rotation.y += dt * 9;
      }
    }
  }
  function updateTetra(dt) {
    if (!local.inst || !state.me) return;
    const lp = local.inst.group.position;
    for (const t of tetraPool) {
      if (!t.active) continue;
      t.t += dt;
      if (t.t >= 1) { t.active = false; t.mesh.visible = false; continue; }
      t.mesh.visible = t.t >= 0;
      if (t.t < 0) continue;
      const r = t.rad * (1 - t.t * 0.4);
      t.mesh.position.set(lp.x + Math.cos(t.ang) * r, 0.4 + t.t * 3.2, lp.z + Math.sin(t.ang) * r);
      t.mesh.rotation.y += dt * 7;
      t.mesh.material.opacity = 0.95 * (1 - t.t);
    }
  }

  // ---- camera
  function updateCamera() {
    const me = state.me;
    if (me && local.inst) {
      const p = local.inst.group.position;
      const D = 9, cp = Math.cos(pitch), sp = Math.sin(pitch);
      camera.position.set(
        p.x + Math.sin(yaw) * cp * D,
        3.6 + sp * D,
        p.z + Math.cos(yaw) * cp * D
      );
      camera.lookAt(p.x, 1.7, p.z);
    } else {
      camera.position.set(0, 16, 30);
      camera.lookAt(0, 2, 6);
    }
  }

  // ---- target ring
  function updateRing(now) {
    if (!ring) return;
    const t = state.targetId != null ? recOf(state.targetId) : null;
    if (!t) { ring.visible = false; return; }
    const p = t.inst.group.position;
    ring.visible = true;
    const s = 1 + Math.sin(now * 0.008) * 0.07;
    ring.position.set(p.x, 0.07, p.z);
    ring.scale.set(s, 1, s);
  }

  // ---- main render
  function _render(dt) {
    if (!renderer) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    onResize();
    const now = performance.now();
    if (!built && state.me && state.me.layout) {
      buildZone(state.me.layout);
      built = true;
    }
    syncLocal(dt);
    syncEntities(dt, now);
    updateCamera();
    updatePlates(now);
    updateDmg(dt);
    updateProj(dt);
    updateTetra(dt);
    updateRing(now);
    renderer.render(scene, camera);
  }

  // ---- public api
  const api = {
    render(dt) {
      try { _render(dt); }
      catch (err) {
        if (!errLogged) { errLogged = true; console.error('[world3d] render error:', err); }
      }
    },
    setQuality(q) {
      if (q !== 'low' && q !== 'medium' && q !== 'high') return;
      quality = q;
      try { localStorage.setItem(QUALITY_KEY, q); } catch (e) { /* ignore */ }
      // NOTE: pixelRatio applies live. The antialias flag is fixed when the WebGLRenderer
      // was constructed, so toggling AA on/off needs a page reload to take effect.
      if (renderer) applyQuality();
    },
    getCameraYaw() { return yaw; },
    cycleTarget() {
      const me = state.me;
      if (!me) return;
      const cands = [];
      for (const ent of state.ents.values()) {
        if (ent.kind !== 'mob' || ent.dead) continue;
        const d = Math.hypot(ent.x - me.x, ent.z - me.z);
        if (d <= 30) cands.push([d, ent.id]);
      }
      if (!cands.length) return;
      cands.sort((a, b) => a[0] - b[0]);
      cycleIdx = (cycleIdx + 1) % cands.length;
      const id = cands[cycleIdx][1];
      state.targetId = id;
      net.target(id);
    },
    fx: {
      // floating text over an entity (damage numbers use this too via fx.damage)
      floatText(id, text, color = '#fff', size = 15) {
        if (!renderer) return;
        const hp = headPosOf(id);
        const s = hp ? screenOf(hp.x, hp.y, hp.z) : null;
        if (s) floatDmg(s[0], s[1] - 6, text, color, size);
      },
      damage(id, amount, crit, label, srcId, roll) {
        if (!renderer) return;
        const hp = headPosOf(id);
        const s = hp ? screenOf(hp.x, hp.y, hp.z) : null;
        if (s) {
          let d = dmgPool.find(p => !p.active);
          if (!d) { d = dmgPool[0]; } // steal oldest slot when saturated
          d.active = true; d.t = 0;
          d.x = s[0] + (Math.random() * 24 - 12);
          d.y = s[1] - 6;
          const el = d.el;
          let color = '#fff', size = 15, text = String(Math.round(amount));
          if (roll === 'dodge') { text = 'DODGED'; color = '#c9c9c9'; size = 14; }
          else if (roll === 'parry') { text = 'PARRIED'; color = '#9fd8ff'; size = 14; }
          else if (crit || roll === 'crit') { text = Math.round(amount) + '!'; color = '#ffd34d'; size = 21; }
          else if (label === 'heal') { color = '#5f5'; size = 14; }
          else if (state.me && id === state.me.id) { color = '#ff5b5b'; size = 14; }
          el.textContent = text;
          el.style.display = 'block';
          el.style.color = color;
          el.style.fontSize = size + 'px';
          el.style.opacity = '1';
        }
        // hit flinch on the victim (not on a clean dodge)
        const victim = recOf(id);
        if (victim && roll !== 'dodge') victim.inst.flinch = 1;
        // attacker faces its target (cheap attack read)
        if (srcId != null && srcId !== id) {
          const a = recOf(srcId), b = recOf(id);
          if (a && b) {
            const ap = a.inst.group.position, bp = b.inst.group.position;
            a.inst.group.rotation.y = Math.atan2(bp.x - ap.x, bp.z - ap.z);
          }
        }
      },
      projectile(fromId, toId, kind) {
        if (!renderer) return;
        const a = headPosOf(fromId), b = chestPosOf(toId);
        if (!a || !b) return;
        const p = projPool.find(q => !q.active);
        if (!p) return;
        const st = PROJ_STYLE[kind] || PROJ_STYLE.fire;
        p.active = true; p.t = 0;
        p.ax = a.x; p.ay = a.y - 0.3; p.az = a.z;
        p.bx = b.x; p.by = b.y; p.bz = b.z;
        p.mesh.geometry = st.arrow ? projArrow : projSphere;
        p.mesh.material.color.setHex(st.color);
        p.mesh.visible = true;
        p.mesh.position.set(p.ax, p.ay, p.az);
        p.arrow = st.arrow;
        if (st.arrow) p.mesh.rotation.set(0, Math.atan2(p.bx - p.ax, p.bz - p.az), 0);
      },
      die(id) {
        // Corpse tipping/greying is driven by ent.dead in the render loop; nothing extra.
      },
      levelUp() {
        if (!renderer || !local.inst) return;
        let n = 0;
        for (const t of tetraPool) {
          if (t.active) continue;
          t.active = true; t.t = -n * 0.03; // slight stagger
          t.ang = (n / MAX_TETRA) * Math.PI * 2;
          t.rad = 1.1 + Math.random() * 0.5;
          t.mesh.visible = true;
          t.mesh.material.opacity = 0.95;
          if (++n >= 10) break;
        }
      },
    },
  };

  return api;
}

// ---------------------------------------------------------------- creation-screen preview
// Cheap live 3D preview for the login screen: own tiny scene, one character,
// slow turntable. Call dispose() once the player enters the world.
export function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a2f22, 1.0));
  const dir = new THREE.DirectionalLight(0xffe0b3, 1.2);
  dir.position.set(2, 4, 3);
  scene.add(dir);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0.4, 1.55, 4.4);
  camera.lookAt(0, 1.05, 0);
  let inst = null, raf = 0, alive = true;
  function resize() {
    const w = canvas.clientWidth || 240, h = canvas.clientHeight || 320;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function set(cls, app) {
    if (inst) scene.remove(inst.group);
    inst = instantiate('player', cls);
    applyAppearance(inst, app);
    scene.add(inst.group);
    resize();
  }
  function frame() {
    if (!alive) return;
    try {
      if (inst) inst.group.rotation.y += 0.01;
      renderer.render(scene, camera);
    } catch (e) { /* preview must never break the login screen */ }
    raf = requestAnimationFrame(frame);
  }
  resize();
  frame();
  return {
    set, resize,
    dispose() { alive = false; cancelAnimationFrame(raf); renderer.dispose(); },
  };
}
