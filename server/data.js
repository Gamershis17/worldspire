// WORLDSPIRE phase-1 data: classes, abilities, mobs, zone layout, colliders.
// The layout here is the SOURCE OF TRUTH — it is sent to clients in `hello`
// and drives both the 3D scenery and the shared circle colliders.

export const BOUNDS = 58; // playable half-extent (m)

// deterministic RNG so layout is stable across restarts
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(1337);
const rr = (a, b) => a + rng() * (b - a);

export const CLASSES = {
  warrior: {
    name: 'Warrior', desc: 'Plate-clad juggernaut. Charges into the fray and shrugs off blows.',
    hp: 120, hpPer: 14, mp: 50, mpPer: 4, speed: 6.0, range: 4, swing: 2.0,
    // base primary stats + per-level growth (applied on level-up)
    baseStats: { str: 18, agi: 10, sta: 16, int: 6 },
    growth:    { str: 3,  agi: 1,  sta: 4,  int: 1 },
    baseArmor: 20,
    auto: (lvl) => 5 + 0.8 * lvl,
    abilities: [
      { slot: 1, id: 'strike', name: 'Strike', icon: '⚔️', mana: 8, cd: 0, cast: 0, range: 4, desc: 'A brutal melee blow.' },
      { slot: 2, id: 'charge', name: 'Charge', icon: '💨', mana: 0, cd: 15, cast: 0, range: 25, desc: 'Dash to your target.' },
      { slot: 3, id: 'shieldblock', name: 'Shield Block', icon: '🛡️', mana: 0, cd: 20, cast: 0, range: 0, desc: '−50% damage taken, 6 s.' },
      { slot: 4, id: 'whirlwind', name: 'Whirlwind', icon: '🌪️', mana: 15, cd: 8, cast: 0, range: 6, desc: 'Spin, hitting all nearby foes.' },
    ],
  },
  mage: {
    name: 'Mage', desc: 'Master of arcane fire and frost. Fragile, devastating at range.',
    hp: 80, hpPer: 9, mp: 100, mpPer: 12, speed: 5.6, range: 26, swing: 1.6,
    baseStats: { str: 6,  agi: 10, sta: 10, int: 18 },
    growth:    { str: 1,  agi: 1,  sta: 2,  int: 4 },
    baseArmor: 2,
    auto: (lvl) => 3 + 0.5 * lvl,
    abilities: [
      { slot: 1, id: 'fireball', name: 'Fireball', icon: '🔥', mana: 15, cd: 0, cast: 1.5, range: 28, proj: 'fire', desc: 'Hurls a blazing fireball.' },
      { slot: 2, id: 'frostbolt', name: 'Frostbolt', icon: '❄️', mana: 10, cd: 0, cast: 1.2, range: 28, proj: 'frost', desc: 'Chilling bolt that slows.' },
      { slot: 3, id: 'blink', name: 'Blink', icon: '✨', mana: 0, cd: 15, cast: 0, range: 0, desc: 'Teleport 12 m forward.' },
      { slot: 4, id: 'arcaneexplosion', name: 'Arcane Explosion', icon: '💥', mana: 25, cd: 10, cast: 0, range: 8, desc: 'Blast all foes around you.' },
    ],
  },
  ranger: {
    name: 'Ranger', desc: 'Silent hunter of the wilds. Deadly arrows, unmatched mobility.',
    hp: 100, hpPer: 11, mp: 80, mpPer: 8, speed: 6.2, range: 26, swing: 1.8,
    baseStats: { str: 10, agi: 18, sta: 12, int: 8 },
    growth:    { str: 1,  agi: 3,  sta: 2,  int: 1 },
    baseArmor: 8,
    auto: (lvl) => 4 + 0.7 * lvl,
    abilities: [
      { slot: 1, id: 'steadyshot', name: 'Steady Shot', icon: '🏹', mana: 12, cd: 0, cast: 1.0, range: 28, proj: 'arrow', desc: 'A carefully aimed shot.' },
      { slot: 2, id: 'multishot', name: 'Multi-Shot', icon: '🎯', mana: 18, cd: 6, cast: 0, range: 28, proj: 'arrow', desc: 'Arrows strike up to 3 foes.' },
      { slot: 3, id: 'disengage', name: 'Disengage', icon: '🌀', mana: 0, cd: 18, cast: 0, range: 0, desc: 'Leap 10 m backward.' },
      { slot: 4, id: 'volley', name: 'Volley', icon: '🌠', mana: 22, cd: 12, cast: 0, range: 28, desc: 'Arrow storm at your target.' },
      { slot: 5, id: 'tamebeast', name: 'Tame Beast', icon: '🐾', mana: 20, cd: 0, cast: 3, range: 20, levelReq: 10, desc: 'Tame a boar or wolf as your pet. Unlocks at level 10.' },
      { slot: 6, id: 'revivepet', name: 'Revive Pet', icon: '💚', mana: 30, cd: 0, cast: 5, range: 0, desc: 'Revive your dead pet. Must be out of combat.' },
    ],
  },
};

export const MOBS = {
  boar:  { name: 'Boar', hp: 40, dmg: [3, 5], xp: 25, coins: [2, 5], speed: 3.0, aggro: 0, swing: 2.0, range: 2.2, respawn: 20, hostile: false, level: 1, str: 8, sta: 6, armor: 5 },
  wolf:  { name: 'Wolf', hp: 70, dmg: [5, 8], xp: 40, coins: [4, 8], speed: 5.5, aggro: 12, swing: 2.0, range: 2.2, respawn: 20, hostile: true, level: 3, str: 12, sta: 8, armor: 10 },
  alpha: { name: 'Alpha Wolf', hp: 400, dmg: [10, 15], xp: 200, coins: [30, 50], speed: 6.0, aggro: 14, swing: 1.8, range: 2.6, respawn: 120, hostile: true, elite: true, enrageAt: 0.3, level: 8, str: 25, sta: 20, armor: 30 },
};

// ---- zone layout ----
const huts = [
  { x: -10, z: 14, ry: 0.3 }, { x: 10, z: 14, ry: -0.3 },
  { x: -10, z: -2, ry: 3.44 }, { x: 10, z: -2, ry: 2.84 },
];
const well = { x: 0, z: 8 };
const spawn = { x: 0, z: 18 };
const fences = [
  { x1: -18, z1: 24, x2: -4, z2: 24 },
  { x1: 4, z1: 24, x2: 18, z2: 24 },
];
const trees = [];
for (let i = 0; i < 46; i++) {
  const a = rng() * Math.PI * 2, r = rr(26, 56);
  const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.9 + 4;
  if (Math.hypot(x, z - 10) < 17) continue;            // keep village clearing open
  if (Math.hypot(x, z + 48) < 8) continue;             // alpha den clearing
  trees.push({ x: +x.toFixed(1), z: +z.toFixed(1), s: +rr(0.8, 1.5).toFixed(2) });
}
const rocks = [];
for (let i = 0; i < 8; i++) {
  const a = rng() * Math.PI * 2, r = rr(22, 54);
  rocks.push({ x: +(Math.cos(a) * r).toFixed(1), z: +(Math.sin(a) * r).toFixed(1), s: +rr(0.5, 1.4).toFixed(2) });
}

export const LAYOUT = { spawn, huts, well, fences, trees, rocks };

// ---- character appearance (indices; palettes mirrored client-side in world3d.js) ----
export const APPEARANCE = {
  skins: [0xf2c89b, 0xe0aa7e, 0xc98a5e, 0xa06a42, 0x7a4e2e, 0x5c3a24],
  hairColors: [0x2b2b2b, 0x5d3f24, 0xb0653a, 0xd9a441, 0x8c8c8c, 0xa02828],
  faces: 4,       // 0 stern, 1 heavy brow, 2 scarred, 3 war paint
  hairStyles: 4,  // 0 bald, 1 short, 2 long, 3 mohawk
};
export const DEFAULT_APPEARANCE = { skin: 1, face: 0, hairStyle: 1, hairColor: 1 };
export function sanitizeAppearance(a) {
  const d = DEFAULT_APPEARANCE;
  if (!a || typeof a !== 'object') return { ...d };
  const iv = (v, max, fb) => (Number.isInteger(v) && v >= 0 && v < max ? v : fb);
  return {
    skin: iv(a.skin, APPEARANCE.skins.length, d.skin),
    face: iv(a.face, APPEARANCE.faces, d.face),
    hairStyle: iv(a.hairStyle, APPEARANCE.hairStyles, d.hairStyle),
    hairColor: iv(a.hairColor, APPEARANCE.hairColors.length, d.hairColor),
  };
}

export const MOB_SPAWNS = [
  { mob: 'boar', x: 25, z: -10 }, { mob: 'boar', x: 32, z: 5 }, { mob: 'boar', x: 20, z: 15 },
  { mob: 'boar', x: -28, z: -5 }, { mob: 'boar', x: -24, z: 12 }, { mob: 'boar', x: 30, z: -25 },
  { mob: 'wolf', x: -15, z: -30 }, { mob: 'wolf', x: 15, z: -32 }, { mob: 'wolf', x: 0, z: -38 },
  { mob: 'wolf', x: -35, z: -25 }, { mob: 'wolf', x: 35, z: -20 },
  { mob: 'alpha', x: 0, z: -48 },
];

// ---- colliders (circles) derived from layout ----
export function buildColliders() {
  const c = [];
  for (const h of huts) c.push({ x: h.x, z: h.z, r: 3.4 });
  c.push({ x: well.x, z: well.z, r: 1.3 });
  for (const t of trees) c.push({ x: t.x, z: t.z, r: 0.7 * t.s });
  for (const rk of rocks) c.push({ x: rk.x, z: rk.z, r: 0.9 * rk.s });
  for (const f of fences) {
    const len = Math.hypot(f.x2 - f.x1, f.z2 - f.z1);
    const n = Math.max(2, Math.round(len / 2));
    for (let i = 0; i <= n; i++) {
      c.push({ x: f.x1 + (f.x2 - f.x1) * (i / n), z: f.z1 + (f.z2 - f.z1) * (i / n), r: 0.35 });
    }
  }
  return c;
}

// push a point out of circle colliders; returns nothing (mutates p={x,z})
export function resolveColliders(p, colliders, radius = 0.5) {
  for (const c of colliders) {
    const dx = p.x - c.x, dz = p.z - c.z;
    const d = Math.hypot(dx, dz), min = c.r + radius;
    if (d < min && d > 0.0001) {
      p.x = c.x + (dx / d) * min;
      p.z = c.z + (dz / d) * min;
    }
  }
  p.x = Math.max(-BOUNDS, Math.min(BOUNDS, p.x));
  p.z = Math.max(-BOUNDS, Math.min(BOUNDS, p.z));
}

export const xpNext = (level) => 100 * level; // xp to go level -> level+1
export const MAX_LEVEL = 10;

// ---- items (phase 1: minimal equipment; slots weapon/armor) ----
// attack adds flat damage to auto-attacks and abilities; maxHp raises max HP.
// golden items render with a gold nameplate on the wearer.
export const ITEMS = {
  gm_greatblade: { id: 'gm_greatblade', name: 'GM Greatblade', slot: 'weapon', attack: 500, golden: true },
  gm_aegis:      { id: 'gm_aegis', name: 'GM Aegis Plate', slot: 'armor', maxHp: 2000, armor: 150, golden: true },
  worn_sword:    { id: 'worn_sword', name: 'Worn Sword', slot: 'weapon', attack: 3 },
  cloth_vest:    { id: 'cloth_vest', name: 'Cloth Vest', slot: 'armor', maxHp: 25, armor: 10 },
};
export const GM_GEAR_SET = ['gm_greatblade', 'gm_aegis'];

// ---- achievements ----
// WoW-style function, original WORLDSPIRE presentation (no copied names/text).
// track: { counter, goal } — 'level' reads the live player level, everything
// else reads p.ach.counters.<path>. Server bumps counters on events and
// unlocks; the client renders from the hello/stats ach view.
export const ACH_CATEGORIES = ['Character', 'Combat', 'Exploration', 'Wealth', 'Social'];
export const ACHIEVEMENTS = [
  { id: 'first_blood',  name: 'First Blood',     desc: 'Slay your first foe.',            category: 'Combat',      points: 5,  icon: '🩸', track: { counter: 'kills.total', goal: 1 } },
  { id: 'boar_hunter',  name: 'Boar Hunter',     desc: 'Slay 25 boars.',                   category: 'Combat',      points: 10, icon: '🐗', track: { counter: 'kills.boar',  goal: 25 } },
  { id: 'wolf_slayer',  name: 'Wolf Slayer',     desc: 'Slay 25 wolves.',                  category: 'Combat',      points: 10, icon: '🐺', track: { counter: 'kills.wolf',  goal: 25 } },
  { id: 'alpha_down',   name: 'Alpha Down',      desc: 'Bring down the Alpha Wolf.',       category: 'Combat',      points: 15, icon: '👑', track: { counter: 'kills.alpha', goal: 1 } },
  { id: 'rising_hero',  name: 'Rising Hero',     desc: 'Reach level 5.',                   category: 'Character',   points: 10, icon: '⚔️',  track: { counter: 'level',       goal: 5 } },
  { id: 'veteran',      name: 'Veteran',         desc: 'Reach level 10.',                  category: 'Character',   points: 15, icon: '🛡️',  track: { counter: 'level',       goal: 10 } },
  { id: 'beast_master', name: 'Beast Master',    desc: 'Tame a wild beast.',               category: 'Character',   points: 10, icon: '🐾', track: { counter: 'petsTamed',   goal: 1 } },
  { id: 'survivor',     name: 'Survivor',        desc: 'Return from death.',               category: 'Character',   points: 5,  icon: '💪', track: { counter: 'deaths',      goal: 1 } },
  { id: 'wanderer',     name: 'Wanderer',        desc: 'Walk 2,000 meters.',               category: 'Exploration', points: 10, icon: '🥾', track: { counter: 'distanceM',   goal: 2000 } },
  { id: 'hoarder',      name: 'Treasure Hoarder', desc: 'Hold 1,000 coins at once.',       category: 'Wealth',      points: 10, icon: '💰', track: { counter: 'coinsMax',    goal: 1000 } },
  { id: 'chatter',      name: 'Chatter',         desc: 'Send 25 chat messages.',           category: 'Social',      points: 5,  icon: '💬', track: { counter: 'chatMsgs',    goal: 25 } },
  { id: 'guilded',      name: 'Guilded',         desc: 'Join a guild.',                    category: 'Social',      points: 10, icon: '🏰', track: { counter: 'guilded',     goal: 1 } },
  { id: 'dancer',       name: 'Dancer',          desc: 'Dance like nobody is watching.',   category: 'Social',      points: 5,  icon: '💃', track: { counter: 'danced',      goal: 1 } },
  { id: 'jokester',     name: 'Jokester',        desc: 'Tell a joke in the wilds.',        category: 'Social',      points: 5,  icon: '🃏', track: { counter: 'joked',       goal: 1 } },
];
