// WORLDSPIRE authoritative simulation. 20 Hz tick, snapshots at 10 Hz.
import { CLASSES, MOBS, LAYOUT, MOB_SPAWNS, buildColliders, resolveColliders, xpNext, MAX_LEVEL, BOUNDS, ITEMS, GM_GEAR_SET, APPEARANCE, DEFAULT_APPEARANCE, sanitizeAppearance, ACHIEVEMENTS } from './data.js';

// Server-side GM identity. NEVER trust the client for this — the check runs
// only here, on login, against the character name.
const GM_NAME = 'gamershis17';

let nextId = 1;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rand = (a, b) => a + Math.random() * (b - a);
const clampMove = (m) => { const l = Math.hypot(m.mx, m.mz); if (l > 1) { m.mx /= l; m.mz /= l; } };

// Original clean fantasy jokes for /joke (one random line per use).
const JOKES = [
  "I told my sword a joke once. It didn't get the point.",
  'My shield and I never argue. It always comes to my defense.',
  'I asked the innkeeper for a room with a view. Now I sleep in the stables.',
  "Dragons don't hoard gold. They just have very shiny retirement plans.",
  'I tried to sneak past the wolves in a boar costume. They saw right through it.',
  'The mage said my armor was outdated. I told him rust is just battle seasoning.',
];

export class Game {
  constructor(store) {
    this.store = store;
    this.players = new Map(); // id -> player
    this.byName = new Map();  // lowerName -> player (connected)
    this.mobs = [];
    this.time = 0;
    this.colliders = buildColliders();
    this._snapT = 0;
    this._saveT = 0;
    this.guilds = new Map();    // id -> guild {id,name,leader,members[],createdAt}
    this.guildByName = new Map(); // lowerName -> id
    this.invites = new Map();   // lowerName -> {guildId, from, expires}
    this.pets = new Map();      // id -> pet (tamed beasts)
    for (const s of MOB_SPAWNS) this.mobs.push(this._makeMob(s.mob, s.x, s.z));
  }

  // Load persisted guilds. Called once at server boot (server.js awaits it).
  async init() {
    const arr = await this.store.loadGuilds();
    for (const g of arr) {
      if (!g || !g.id || !g.name) continue;
      g.members = Array.isArray(g.members) ? g.members : [];
      this.guilds.set(g.id, g);
      this.guildByName.set(String(g.name).toLowerCase(), g.id);
    }
    console.log(`[worldspire] loaded ${this.guilds.size} guild(s)`);
  }

  _saveGuilds() {
    this.store.saveGuilds([...this.guilds.values()]).catch(() => {});
  }

  // ---------- entities ----------
  _makeMob(type, x, z) {
    const d = MOBS[type];
    return {
      id: nextId++, kind: 'mob', mob: type, name: d.name, elite: !!d.elite, level: 1,
      x, z, hx: x, hz: z, heading: rand(0, Math.PI * 2),
      hp: d.hp, maxHp: d.hp, dead: false, respawnT: 0,
      state: 'idle', targetId: null, swingT: 0, wanderT: rand(1, 4), wx: x, wz: z,
      slowUntil: 0, enraged: false, moving: false,
    };
  }

  async login(ws, name, cls, appearance) {
    if (!/^[A-Za-z0-9]{2,16}$/.test(name)) { ws.send(JSON.stringify({ op: 'err', msg: 'Name must be 2–16 letters/numbers.' })); return null; }
    if (!CLASSES[cls]) { ws.send(JSON.stringify({ op: 'err', msg: 'Unknown class.' })); return null; }
    const ln = name.toLowerCase();
    if (this.byName.has(ln)) { ws.send(JSON.stringify({ op: 'err', msg: 'That name is already in the world.' })); return null; }
    const c = CLASSES[cls];
    const saved = await this.store.loadPlayer(name);
    const isOwner = ln === GM_NAME;
    const p = {
      id: nextId++, kind: 'player', name, cls, ws,
      level: 1, xp: 0, coins: 0,
      x: LAYOUT.spawn.x, z: LAYOUT.spawn.z, heading: Math.PI,
      hp: c.hp, maxHp: c.hp, mp: c.mp, maxMp: c.mp, speed: c.speed,
      move: { mx: 0, mz: 0 }, targetId: null, autoOn: true,
      dead: false, deadT: 0, cds: {}, casting: null, buffs: {},
      swingT: 0, lastCombat: -99, moving: false, dirty: false,
      // GM + equipment (phase 1)
      gm: isOwner ? true : !!saved?.gm, // owner name always wins; never from client
      god: false,                        // session-only, never persisted
      gmMode: true,      // GM-only, session-only: ON = aggro immunity + <GM> tag; OFF = play as normal (keeps commands)
      gmInvisible: false, // GM-only, session-only: hidden from non-GM snap entity lists
      fly: false,        // GM-only, session-only free-flight
      y: 0,              // height while flying (0 = grounded)
      gear: { weapon: saved?.gear?.weapon || null, armor: saved?.gear?.armor || null },
      atkBonus: 0,
      speedMult: saved?.speedMult || 1,
      guildId: saved?.guildId || null,
      // appearance: saved record wins (set at creation); new heroes use the
      // creation-screen choice, sanitized. Session-only pet below.
      appearance: saved?.appearance ? sanitizeAppearance(saved.appearance) : sanitizeAppearance(appearance),
      // emote: session-only ('dance'|'sit'|'sleep' toggles, 'lol'|'joke' one-shots)
      emote: null, emoteUntil: 0,
      // afk: session-only; custom message optional
      afk: false, afkMsg: '',
      // /played: playTime persisted (seconds), sessionStart marks this session
      playTime: saved?.playTime || 0, sessionStart: Date.now(),
      // achievements: unlocked ids + points + progress counters (persisted)
      ach: this._freshAch(saved?.ach),
      pet: null, // session-only tamed beast (see _tameBeast)
    };
    p.speed = c.speed * p.speedMult;
    if (p.guildId && !this.guilds.has(p.guildId)) p.guildId = null; // guild disbanded while away
    if (saved) {
      p.level = Math.min(saved.level || 1, MAX_LEVEL);
      p.xp = saved.xp || 0; p.coins = saved.coins || 0;
      p.x = saved.x ?? p.x; p.z = saved.z ?? p.z;
    }
    // primary stats: base + per-level growth (deterministic from level)
    p.stats = { str: 0, agi: 0, sta: 0, int: 0 };
    for (const k of ['str', 'agi', 'sta', 'int']) p.stats[k] = c.baseStats[k] + c.growth[k] * (p.level - 1);
    this._recalcStats(p, 'delta');
    this.players.set(p.id, p);
    this.byName.set(ln, p);
    ws._pid = p.id;
    this._sendHello(p);
    this._sendStats(p);
    this._sys(`${name} the ${c.name} has entered the world.`);
    return p;
  }

  logout(id) {
    const p = this.players.get(id);
    if (!p) return;
    // release the pet (session-only)
    if (p.pet) {
      this._bcast({ op: 'ev', ev: 'die', id: p.pet.id, by: 0 });
      this.pets.delete(p.pet.id);
      p.pet = null;
    }
    this.players.delete(id);
    this.byName.delete(p.name.toLowerCase());
    // bank the current session into playTime before persisting
    p.playTime += (Date.now() - p.sessionStart) / 1000;
    p.sessionStart = Date.now();
    this._persist(p);
    this._sys(`${p.name} has left the world.`);
  }

  // Gear stat bonuses from equipped items.
  _gearBonus(p) {
    let attack = 0, maxHp = 0, armor = 0;
    for (const slot of ['weapon', 'armor']) {
      const it = p.gear && p.gear[slot] && ITEMS[p.gear[slot]];
      if (it) { attack += it.attack || 0; maxHp += it.maxHp || 0; armor += it.armor || 0; }
    }
    return { attack, maxHp, armor };
  }

  // Small client-facing view of equipped gear (ids + names only).
  _gearView(p) {
    const v = {};
    for (const slot of ['weapon', 'armor']) {
      const it = p.gear && p.gear[slot] && ITEMS[p.gear[slot]];
      v[slot] = it ? { id: it.id, name: it.name } : null;
    }
    return v;
  }

  // Equip an item by id into its slot. Returns the item or null.
  _equip(p, itemId) {
    const it = ITEMS[itemId];
    if (!it) return null;
    p.gear[it.slot] = it.id;
    this._recalcStats(p, 'delta');
    p.dirty = true;
    this._sendStats(p);
    return it;
  }

  // Recompute derived stats from primary stats + level + gear.
  // mode: 'full' (restore to max), 'ratio' (keep current HP/MP ratios),
  //       'delta' (heal only the gained max-HP difference, e.g. equipping armor).
  _recalcStats(p, mode = 'delta') {
    const c = CLASSES[p.cls];
    const gb = this._gearBonus(p);
    const s = p.stats;
    p.atkBonus = gb.attack;
    // attack power from the class primary stat (warriors str, rangers agi, mages int = spell power)
    const primary = p.cls === 'warrior' ? s.str : p.cls === 'ranger' ? s.agi : s.int;
    p.attackPower = Math.round(primary * 1.5);
    // armor: class base + gear
    p.armor = (c.baseArmor || 0) + gb.armor;
    const newMaxHp = Math.round(20 + s.sta * 6) + gb.maxHp;
    const newMaxMp = Math.round(10 + s.int * 5);
    // avoidance: dodge 5% base + diminishing agility scaling (cap 30%)
    p.dodge = Math.min(0.30, 0.05 + 0.25 * (1 - Math.exp(-s.agi / 60)));
    // parry (melee only): warriors 10% + diminishing str scaling, others 3%
    p.parry = p.cls === 'warrior'
      ? Math.min(0.35, 0.10 + 0.20 * (1 - Math.exp(-s.str / 60)))
      : 0.03;
    // crit: 5% + agility/intellect scaling (cap 40%)
    p.crit = Math.min(0.40, 0.05 + (s.agi + s.int) * 0.0015);
    const hpRatio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
    const mpRatio = p.maxMp > 0 ? p.mp / p.maxMp : 1;
    if (mode === 'full') {
      p.maxHp = newMaxHp; p.hp = p.maxHp;
      p.maxMp = newMaxMp; p.mp = p.maxMp;
    } else if (mode === 'ratio') {
      p.maxHp = newMaxHp; p.hp = p.maxHp * hpRatio;
      p.maxMp = newMaxMp; p.mp = p.maxMp * mpRatio;
    } else {
      const delta = newMaxHp - (p.maxHp || 0);
      p.maxHp = newMaxHp;
      p.hp = delta > 0 ? Math.min(p.maxHp, (p.hp || 0) + delta) : Math.min(p.hp || 0, p.maxHp);
      p.maxMp = newMaxMp;
      p.mp = Math.min(p.mp || 0, p.maxMp);
    }
  }

  // Client-facing stat sheet (hello + stats ops).
  _statsView(p) {
    const s = p.stats || { str: 0, agi: 0, sta: 0, int: 0 };
    return {
      str: s.str, agi: s.agi, sta: s.sta, int: s.int,
      ap: p.attackPower || 0, armor: p.armor || 0,
      dodge: +(p.dodge || 0).toFixed(4), parry: +(p.parry || 0).toFixed(4), crit: +(p.crit || 0).toFixed(4),
    };
  }

  // Active buffs for the player frame (remaining seconds, snapshot at send).
  _buffView(p) {
    const out = [];
    const sb = (p.buffs.shieldBlock || 0) - this.time;
    if (sb > 0) out.push({ id: 'shieldblock', name: 'Shield Block', icon: '🛡️', remain: +sb.toFixed(1) });
    return out;
  }

  _persist(p) {
    p.dirty = false;
    this.store.savePlayer({ name: p.name, cls: p.cls, level: p.level, xp: p.xp, coins: p.coins, x: +p.x.toFixed(1), z: +p.z.toFixed(1), gm: !!p.gm, gear: { ...p.gear }, speedMult: p.speedMult || 1, guildId: p.guildId || null, appearance: { ...p.appearance }, playTime: Math.floor(p.playTime), ach: { unlocked: p.ach.unlocked, points: p.ach.points, counters: p.ach.counters } }).catch(() => {});
  }

  // ---------- messaging ----------
  _send(ws, o) { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
  _bcast(o) { for (const p of this.players.values()) this._send(p.ws, o); }
  _sys(text) { this._bcast({ op: 'ev', ev: 'chat', from: '', text, sys: true }); }
  // Emote line to nearby players (WoW-style: "Name dances.").
  _emoteSay(p, text, range = 40) {
    for (const q of this.players.values()) {
      if (Math.hypot(q.x - p.x, q.z - p.z) <= range)
        this._send(q.ws, { op: 'ev', ev: 'chat', from: '', text, emote: true });
    }
  }

  _sendHello(p) {
    const c = CLASSES[p.cls];
    this._send(p.ws, {
      op: 'hello', id: p.id, name: p.name, cls: p.cls, level: p.level,
      xp: p.xp, xpNext: xpNext(p.level), coins: p.coins,
      x: p.x, z: p.z, hp: Math.round(p.hp), maxHp: p.maxHp, mp: Math.round(p.mp), maxMp: p.maxMp,
      speed: p.speed,
      gm: !!p.gm, god: !!p.god, fly: !!p.fly, gear: this._gearView(p),
      guild: this._guildName(p), pet: this._petView(p),
      stats: this._statsView(p), appearance: { ...p.appearance },
      playTime: Math.floor(p.playTime), // seconds, accumulated across sessions
      ach: this._achView(p),
      abilities: c.abilities.map(a => ({ slot: a.slot, id: a.id, name: a.name, icon: a.icon, mana: a.mana, cd: a.cd, cast: a.cast, range: a.range, levelReq: a.levelReq || 0, desc: a.desc })),
      colliders: this.colliders,
      layout: LAYOUT,
    });
  }

  _sendStats(p) {
    this._send(p.ws, {
      op: 'stats', hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
      mp: Math.max(0, Math.round(p.mp)), maxMp: p.maxMp,
      xp: p.xp, xpNext: xpNext(p.level), level: p.level, coins: p.coins, dead: p.dead,
      speed: p.speed, god: !!p.god, fly: !!p.fly, gear: this._gearView(p), guild: this._guildName(p),
      stats: this._statsView(p), emote: p.emote || null,
      ach: this._achView(p), buffs: this._buffView(p),
    });
  }

  handle(ws, d) {
    const p = this.players.get(ws._pid);
    if (!p) return;
    switch (d.op) {
      case 'move': {
        if (p.dead) break;
        const mx = +d.mx || 0, mz = +d.mz || 0;
        p.move.mx = Math.max(-1, Math.min(1, mx));
        p.move.mz = Math.max(-1, Math.min(1, mz));
        clampMove(p.move);
        if (typeof d.heading === 'number') p.heading = d.heading;
        // vertical: client-sent y is only honored while free-flying (GM-only)
        const yy = +d.y;
        if (p.gm && p.fly && Number.isFinite(yy)) p.y = Math.max(0, Math.min(30, yy));
        else if (p.y !== 0) p.y = 0;
        // moving cancels casts with a cast time
        if (p.casting && (p.move.mx || p.move.mz)) p.casting = null;
        break;
      }
      case 'target': {
        const id = d.id;
        let tid = (id != null && (this.players.has(id) || this.mobs.some(m => m.id === id))) ? id : null;
        // invisible GMs cannot be targeted by non-GMs
        if (tid != null && !p.gm) {
          const tp = this.players.get(tid);
          if (tp && tp.gmInvisible) tid = null;
        }
        p.targetId = tid;
        break;
      }
      case 'auto': p.autoOn = !!d.on; break;
      case 'cast': this._cast(p, +d.slot); break;
      case 'chat': {
        const text = String(d.text || '').slice(0, 140).trim();
        if (!text) break;
        if (text.startsWith('/') || text.startsWith('.')) this._command(p, text.slice(1).trim());
        else {
          if (p.afk) this._clearAfk(p); // chatting clears AFK
          this._bumpAch(p, 'chatMsgs'); // Chatter
          this._bcast({ op: 'ev', ev: 'chat', from: p.name, text, gm: p.gm || undefined });
        }
        break;
      }
      case 'respawn': if (p.dead) this._respawn(p); break;
      case 'ping': this._send(ws, { op: 'pong', t: d.t }); break;
    }
  }

  // ---------- guilds ----------
  _guildOf(p) { return (p.guildId && this.guilds.get(p.guildId)) || null; }

  // ---- emotes (all players) ----
  // Toggles: dance, sit, sleep. One-shots: lol, joke (expire after ~3 s).
  _emote(p, kind) {
    if (p.dead) return;
    const TOGGLES = { dance: 'dances.', sit: 'sits.', sleep: 'falls asleep.' };
    if (TOGGLES[kind]) {
      if (p.emote === kind) { p.emote = null; p.emoteUntil = 0; } // toggle off, quietly
      else {
        p.emote = kind; p.emoteUntil = 0;
        if (kind === 'dance') this._bumpAch(p, 'danced'); // Dancer
        this._emoteSay(p, `${p.name} ${TOGGLES[kind]}`);
      }
      this._sendStats(p); // self learns its emote state immediately
      return;
    }
    // one-shots
    p.emote = kind; p.emoteUntil = this.time + 3;
    if (kind === 'lol') this._emoteSay(p, `${p.name} laughs.`);
    else if (kind === 'joke') {
      const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
      this._bumpAch(p, 'joked'); // Jokester
      for (const q of this.players.values()) {
        if (Math.hypot(q.x - p.x, q.z - p.z) <= 40)
          this._send(q.ws, { op: 'ev', ev: 'chat', from: p.name, text: `"${joke}"`, emote: true });
      }
    }
    this._sendStats(p); // self learns its emote state immediately
  }

  // Clear a one-shot emote once it expires; movement also breaks emotes and AFK.
  _tickEmote(p) {
    let changed = false;
    if (p.emote && p.emoteUntil && this.time >= p.emoteUntil) { p.emote = null; p.emoteUntil = 0; changed = true; }
    if (p.emote && p.moving) { p.emote = null; p.emoteUntil = 0; changed = true; }
    if (p.afk && p.moving) this._clearAfk(p);
    if (changed) this._sendStats(p); // self sees its emote end without waiting for the 1 Hz trickle
  }

  // ---- /afk (all players, session-only) ----
  _afk(p, rest) {
    if (p.dead) return;
    if (p.afk) { this._clearAfk(p); return; }
    p.afk = true;
    p.afkMsg = rest.trim().slice(0, 60) || 'Away from keyboard';
    const suffix = rest.trim() ? `: ${p.afkMsg}` : '';
    this._emoteSay(p, `${p.name} is now AFK${suffix}.`);
  }

  _clearAfk(p) {
    if (!p.afk) return;
    p.afk = false; p.afkMsg = '';
    this._emoteSay(p, `${p.name} is no longer AFK.`);
  }

  // ---- /played (all players) ----
  _played(p) {
    const total = Math.floor(p.playTime + (Date.now() - p.sessionStart) / 1000);
    const sess = Math.floor((Date.now() - p.sessionStart) / 1000);
    const fmt = (s) => {
      const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
      const parts = [];
      if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
      if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
      if (m || !parts.length) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
      return parts.join(', ');
    };
    this._send(p.ws, { op: 'ev', ev: 'chat', from: '', sys: true,
      text: `Total time played: ${fmt(total)}\nTime played this session: ${fmt(sess)}` });
  }

  // ---- achievements (all players, persisted) ----
  _freshAch(savedAch) {
    const counters = {
      kills: { total: 0, boar: 0, wolf: 0, alpha: 0 },
      chatMsgs: 0, distanceM: 0, petsTamed: 0, deaths: 0,
      coinsMax: 0, guilded: 0, danced: 0, joked: 0,
    };
    if (savedAch?.counters) {
      for (const k of Object.keys(counters)) {
        if (k === 'kills' && savedAch.counters.kills) {
          for (const kk of Object.keys(counters.kills)) counters.kills[kk] = savedAch.counters.kills[kk] || 0;
        } else if (typeof savedAch.counters[k] === 'number') counters[k] = savedAch.counters[k];
      }
    }
    const valid = new Set(ACHIEVEMENTS.map(a => a.id));
    const unlocked = (savedAch?.unlocked || []).filter(id => valid.has(id));
    const points = unlocked.reduce((s, id) => s + ACHIEVEMENTS.find(a => a.id === id).points, 0);
    return { unlocked, points, counters };
  }

  _achValue(p, counter) {
    if (counter === 'level') return p.level;
    if (counter === 'coinsMax') return Math.max(p.ach.counters.coinsMax, p.coins);
    const parts = counter.split('.');
    let v = p.ach.counters;
    for (const k of parts) v = v?.[k];
    return v || 0;
  }

  // Bump a progress counter, then check for unlocks. Counter paths match
  // ACHIEVEMENTS track.counter (e.g. 'kills.boar').
  _bumpAch(p, counter, n = 1) {
    const parts = counter.split('.');
    let o = p.ach.counters;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = (o[parts[parts.length - 1]] || 0) + n;
    this._checkAch(p);
  }

  _checkAch(p) {
    p.ach.counters.coinsMax = Math.max(p.ach.counters.coinsMax, p.coins);
    for (const a of ACHIEVEMENTS) {
      if (p.ach.unlocked.includes(a.id)) continue;
      if (this._achValue(p, a.track.counter) >= a.track.goal) {
        p.ach.unlocked.push(a.id);
        p.ach.points += a.points;
        p.dirty = true;
        this._send(p.ws, { op: 'ev', ev: 'ach', id: a.id, name: a.name, points: a.points });
        this._send(p.ws, { op: 'ev', ev: 'chat', from: '', sys: true,
          text: `🏆 Achievement earned: ${a.name} (+${a.points} pts)` });
        this._sendStats(p); // achievement panel progress stays live
      }
    }
  }

  _achView(p) {
    return { unlocked: [...p.ach.unlocked], points: p.ach.points, counters: JSON.parse(JSON.stringify(p.ach.counters)) };
  }
  _guildName(p) { const g = this._guildOf(p); return g ? g.name : null; }

  // Send a message to every online member of a guild.
  _guildMsg(guild, o) {
    for (const name of guild.members) {
      const m = this.byName.get(String(name).toLowerCase());
      if (m) this._send(m.ws, o);
    }
  }

  _cleanInvites() {
    const now = Date.now();
    for (const [k, v] of this.invites) if (v.expires <= now) this.invites.delete(k);
  }

  _guildChat(p, text) {
    const g = this._guildOf(p);
    if (!g) { this._gmSay(p, 'You are not in a guild. Create one with /gcreate <name>.'); return; }
    this._guildMsg(g, { op: 'ev', ev: 'chat', from: p.name, text, guild: true, gm: p.gm || undefined });
  }

  _guildCommand(p, args) {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);
    switch (sub) {
      case 'create': {
        if (p.guildId) { this._gmSay(p, 'You are already in a guild. Leave it first (/gleave).'); return; }
        let name = rest.join(' ').replace(/\s+/g, ' ').trim();
        if (!/^(?=.*[A-Za-z0-9])[A-Za-z0-9 ]{2,24}$/.test(name)) {
          this._gmSay(p, 'Usage: /gcreate <name> — 2–24 chars, letters/numbers/spaces.'); return;
        }
        if (this.guildByName.has(name.toLowerCase())) { this._gmSay(p, `A guild named "${name}" already exists.`); return; }
        const g = {
          id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
          name, leader: p.name, members: [p.name], createdAt: Date.now(),
        };
        this.guilds.set(g.id, g);
        this.guildByName.set(name.toLowerCase(), g.id);
        this._saveGuilds();
        p.guildId = g.id; p.dirty = true;
        this._bumpAch(p, 'guilded'); // Guilded
        this._sendStats(p);
        this._gmSay(p, `Guild "${name}" created. You are the leader.`);
        break;
      }
      case 'invite': {
        const g = this._guildOf(p);
        if (!g) { this._gmSay(p, 'You are not in a guild.'); return; }
        const tname = (rest[0] || '').trim();
        const t = tname && this.byName.get(tname.toLowerCase());
        if (!t) { this._gmSay(p, `"${tname || ''}" is not online.`); return; }
        if (t.id === p.id) { this._gmSay(p, 'You cannot invite yourself.'); return; }
        if (this._guildOf(t)) { this._gmSay(p, `${t.name} is already in a guild.`); return; }
        this._cleanInvites();
        const ex = this.invites.get(t.name.toLowerCase());
        if (ex && ex.guildId === g.id) { this._gmSay(p, `${t.name} already has a pending invite.`); return; }
        this.invites.set(t.name.toLowerCase(), { guildId: g.id, from: p.name, expires: Date.now() + 60000 });
        this._gmSay(t, `${p.name} invites you to join "${g.name}". Type /gaccept or /gdecline. (expires in 60s)`);
        this._gmSay(p, `Invited ${t.name} to "${g.name}".`);
        break;
      }
      case 'accept': {
        this._cleanInvites();
        const inv = this.invites.get(p.name.toLowerCase());
        if (!inv) { this._gmSay(p, 'You have no pending guild invite.'); return; }
        this.invites.delete(p.name.toLowerCase());
        const g = this.guilds.get(inv.guildId);
        if (!g) { this._gmSay(p, 'That guild no longer exists.'); return; }
        if (p.guildId) { this._gmSay(p, 'You are already in a guild.'); return; }
        if (!g.members.some((m) => m.toLowerCase() === p.name.toLowerCase())) g.members.push(p.name);
        this._saveGuilds();
        p.guildId = g.id; p.dirty = true;
        this._bumpAch(p, 'guilded'); // Guilded
        this._sendStats(p);
        this._guildMsg(g, { op: 'ev', ev: 'chat', from: '', text: `${p.name} has joined the guild.`, sys: true });
        break;
      }
      case 'decline': {
        const inv = this.invites.get(p.name.toLowerCase());
        if (!inv) { this._gmSay(p, 'You have no pending guild invite.'); return; }
        this.invites.delete(p.name.toLowerCase());
        const from = this.byName.get(String(inv.from).toLowerCase());
        if (from) this._gmSay(from, `${p.name} declined your guild invite.`);
        this._gmSay(p, 'Invite declined.');
        break;
      }
      case 'leave': {
        const g = this._guildOf(p);
        if (!g) { this._gmSay(p, 'You are not in a guild.'); return; }
        g.members = g.members.filter((m) => m.toLowerCase() !== p.name.toLowerCase());
        p.guildId = null; p.dirty = true;
        this._sendStats(p);
        if (g.members.length === 0) {
          this.guilds.delete(g.id);
          this.guildByName.delete(g.name.toLowerCase());
          this._saveGuilds();
          this._gmSay(p, `You left "${g.name}". The guild has been disbanded.`);
        } else {
          if (g.leader.toLowerCase() === p.name.toLowerCase()) {
            g.leader = g.members[0];
            this._guildMsg(g, { op: 'ev', ev: 'chat', from: '', text: `${p.name} has left the guild. ${g.leader} is now the leader.`, sys: true });
          } else {
            this._guildMsg(g, { op: 'ev', ev: 'chat', from: '', text: `${p.name} has left the guild.`, sys: true });
          }
          this._saveGuilds();
          this._gmSay(p, `You left "${g.name}".`);
        }
        break;
      }
      case 'kick': {
        const g = this._guildOf(p);
        if (!g) { this._gmSay(p, 'You are not in a guild.'); return; }
        if (g.leader.toLowerCase() !== p.name.toLowerCase()) { this._gmSay(p, 'Only the guild leader can kick members.'); return; }
        const tname = (rest[0] || '').trim().toLowerCase();
        if (!tname) { this._gmSay(p, 'Usage: /gkick <player>.'); return; }
        if (tname === p.name.toLowerCase()) { this._gmSay(p, 'You cannot kick yourself — use /gleave.'); return; }
        const member = g.members.find((m) => m.toLowerCase() === tname);
        if (!member) { this._gmSay(p, `"${rest[0]}" is not in your guild.`); return; }
        g.members = g.members.filter((m) => m.toLowerCase() !== tname);
        const t = this.byName.get(tname);
        if (t) { t.guildId = null; t.dirty = true; this._sendStats(t); this._gmSay(t, `You were kicked from "${g.name}".`); }
        this._saveGuilds();
        this._guildMsg(g, { op: 'ev', ev: 'chat', from: '', text: `${member} was kicked from the guild.`, sys: true });
        break;
      }
      default:
        this._gmSay(p, 'Guild commands: /gcreate <name> · /ginvite <player> · /gaccept · /gdecline · /gleave · /gkick <player> · /g <message>');
    }
  }

  // ---------- GM commands ----------
  // System message visible only to one player (keeps GM activity discreet).
  _gmSay(p, text) { this._send(p.ws, { op: 'ev', ev: 'chat', from: '', text, sys: true }); }

  // Named GM teleport destinations (second-push zones included).
  static TELEPORTS = {
    spawn:   () => ({ x: LAYOUT.spawn.x, z: LAYOUT.spawn.z }),
    dungeon: () => ({ x: -42, z: 28 }),  // Gloomhollow cave-mouth entrance
    raid:    () => ({ x: 35, z: -30 }),   // Dire Alpha clearing
  };

  // Drop combat for one player: every mob targeting them leashes home.
  _combatStop(p) {
    for (const m of this.mobs) {
      if (m.targetId === p.id) { m.targetId = null; m.state = 'return'; }
    }
  }

  // Shared mob-spawn routine for /spawn and .npc summon (cap 10 per call).
  _spawnMobNear(p, type, n) {
    n = Math.max(1, Math.min(10, Math.floor(n || 1)));
    for (let i = 0; i < n; i++) {
      const m = this._makeMob(type, p.x + (Math.random() * 10 - 5), p.z + (Math.random() * 10 - 5));
      m.x = Math.max(-BOUNDS, Math.min(BOUNDS, m.x));
      m.z = Math.max(-BOUNDS, Math.min(BOUNDS, m.z));
      resolveColliders(m, this.colliders, 0.4);
      m.hx = m.x; m.hz = m.z;
      this.mobs.push(m);
    }
    return n;
  }

  // Online player by (case-insensitive) name, or null.
  _playerByName(name) {
    const t = (name || '').trim().toLowerCase();
    return t ? (this.byName.get(t) || null) : null;
  }

  // Shared by /level and .levelup: set level (clamped 1–MAX_LEVEL), recalc, full restore.
  _setLevel(p, n) {
    n = Math.max(1, Math.min(MAX_LEVEL, Math.floor(n)));
    if (!Number.isFinite(n) || n < 1) return 0;
    p.level = n; p.xp = 0;
    // recompute primary stats deterministically from level, then full restore
    const c = CLASSES[p.cls];
    for (const k of ['str', 'agi', 'sta', 'int']) p.stats[k] = c.baseStats[k] + c.growth[k] * (n - 1);
    this._recalcStats(p, 'full');
    p.dirty = true;
    this._sendStats(p);
    this._checkAch(p); // level achievements (Rising Hero / Veteran)
    return n;
  }

  // Shared by /give gold and .modify money: add (or remove, if negative) coins, floor at 0.
  _addCoins(p, n) {
    n = Math.floor(n);
    if (!Number.isFinite(n) || n === 0) return false;
    p.coins = Math.max(0, p.coins + n);
    p.dirty = true;
    this._sendStats(p);
    this._checkAch(p); // hoarder (coinsMax) re-evaluated
    return true;
  }

  _command(p, line) {
    const [cmd, ...rest] = line.split(/\s+/);
    const c = (cmd || '').toLowerCase();
    // Guild commands are available to every player.
    if (c === 'g' || c === 'gcreate' || c === 'ginvite' || c === 'gaccept' || c === 'gdecline' || c === 'gleave' || c === 'gkick') {
      if (c === 'g') {
        const text = rest.join(' ').trim().slice(0, 140);
        if (!text) { this._gmSay(p, 'Usage: /g <message> — guild chat.'); return; }
        this._guildChat(p, text);
        return;
      }
      this._guildCommand(p, [c.slice(1), ...rest]); // gcreate -> ['create', ...]
      return;
    }
    // Pet control is available to every ranger.
    if (c === 'petfollow') {
      if (p.cls !== 'ranger' || !p.pet) { this._gmSay(p, 'You do not have a pet. Rangers can tame one at level 10.'); return; }
      p.pet.follow = !p.pet.follow;
      this._gmSay(p, `Your pet will now ${p.pet.follow ? 'follow you' : 'stay where it is'}.`);
      return;
    }
    // Emotes are available to every player.
    if (c === 'dance' || c === 'sit' || c === 'sleep' || c === 'lol' || c === 'joke') {
      this._emote(p, c);
      return;
    }
    if (c === 'afk') { this._afk(p, rest); return; }
    if (c === 'played') { this._played(p); return; }
    // Non-GMs never learn GM commands exist.
    if (!p.gm) {
      this._gmSay(p, c === 'help' ? 'No commands available.' : 'Unknown command.');
      return;
    }
    const num = (s, dflt) => { const n = parseFloat(s); return Number.isFinite(n) ? n : dflt; };
    switch (c) {
      case 'help':
        this._gmSay(p, '— General: .give gold <n> · .give gear · .level <n> · .levelup [#] · .modify hp <n> · .modify money <n> · .heal · .god · .speed <mult> · .killmobs');
        this._gmSay(p, '— Teleport: .tele [spawn|dungeon|raid] | .tele <x> <z> · .goname/.appear <player> · .summon/.namego <player>');
        this._gmSay(p, '— Items & Combat: .additem <item-id> · .cooldown · .combatstop · .die · .revive · .spawn <mob> [n] · .npc summon <npc-id> [n]');
        this._gmSay(p, '— GM Mode: .gm [on|off] · .gm visible [on|off] · .gm fly [on|off]  (fly: Space up / C down)');
        this._gmSay(p, 'Both . and / prefixes work for every command.');
        break;
      case 'give': {
        const what = (rest[0] || '').toLowerCase();
        if (what === 'gold') {
          const n = Math.max(1, Math.min(1000000, Math.floor(num(rest[1], 0))));
          if (!n) { this._gmSay(p, 'Usage: /give gold <amount> (1–1000000).'); break; }
          this._addCoins(p, n);
          this._gmSay(p, `Gave ${n} gold. Balance: ${p.coins}.`);
        } else if (what === 'gear') {
          for (const id of GM_GEAR_SET) this._equip(p, id);
          this._gmSay(p, 'Equipped GM set: GM Greatblade (+500 attack), GM Aegis Plate (+2000 HP).');
        } else {
          this._gmSay(p, 'Usage: /give gold <n> | /give gear');
        }
        break;
      }
      case 'level': {
        const n = this._setLevel(p, num(rest[0], 0));
        if (!n) { this._gmSay(p, `Usage: /level <1–${MAX_LEVEL}>.`); break; }
        this._gmSay(p, `Level set to ${n}.`);
        break;
      }
      case 'levelup': {
        // no arg: +1 level; with a number: set level (same clamp/recalc as /level)
        const arg = (rest[0] || '').trim();
        const n = this._setLevel(p, arg === '' ? p.level + 1 : num(arg, 0));
        if (!n) { this._gmSay(p, `Usage: .levelup [#] (1–${MAX_LEVEL}).`); break; }
        this._gmSay(p, `Level set to ${n}.`);
        break;
      }
      case 'modify': {
        const what = (rest[0] || '').toLowerCase();
        if (what === 'hp') {
          const n = Math.floor(num(rest[1], NaN));
          if (!Number.isFinite(n) || n < 0) { this._gmSay(p, 'Usage: .modify hp <#newhp> (0 kills).'); break; }
          let dst = p;
          const t = p.targetId != null ? this._entById(p.targetId) : null;
          if (t && (t.kind === 'player' || t.kind === 'mob')) dst = t;
          if (dst.kind === 'mob') {
            dst.hp = Math.max(0, Math.min(dst.maxHp, n));
            if (dst.hp <= 0 && !dst.dead) {
              dst.dead = true; dst.state = 'dead'; dst.targetId = null;
              dst.respawnT = MOBS[dst.mob].respawn;
              this._bcast({ op: 'ev', ev: 'die', id: dst.id, by: 0 });
              this._gmSay(p, `Set ${dst.name}'s HP to 0 — it died.`);
            } else {
              this._gmSay(p, `Set ${dst.name}'s HP to ${Math.round(dst.hp)}/${dst.maxHp}.`);
            }
          } else {
            dst.hp = Math.max(0, Math.min(dst.maxHp, n));
            if (dst.hp <= 0 && !dst.dead) {
              this._killPlayer(dst, 0);
              this._gmSay(p, dst === p ? 'You died.' : `Set ${dst.name}'s HP to 0 — they died.`);
            } else {
              if (dst.dead && dst.hp > 0) { dst.dead = false; dst.deadT = 0; this._bcast({ op: 'ev', ev: 'respawn', id: dst.id, x: dst.x, z: dst.z }); }
              this._sendStats(dst);
              this._gmSay(p, `Set ${dst === p ? 'your' : dst.name + "'s"} HP to ${Math.round(dst.hp)}/${dst.maxHp}.`);
            }
          }
        } else if (what === 'money') {
          const n = Math.max(-1000000, Math.min(1000000, Math.floor(num(rest[1], NaN))));
          if (!Number.isFinite(n) || n === 0) { this._gmSay(p, 'Usage: .modify money <#amount> (negative removes; total never drops below 0).'); break; }
          this._addCoins(p, n);
          this._gmSay(p, `${n > 0 ? 'Added' : 'Removed'} ${Math.abs(n)} gold. Balance: ${p.coins}.`);
        } else {
          this._gmSay(p, 'Usage: .modify hp <#newhp> | .modify money <#amount>');
        }
        break;
      }
      case 'heal':
        p.hp = p.maxHp; p.mp = p.maxMp;
        this._sendStats(p);
        this._gmSay(p, 'Fully healed.');
        break;
      case 'god':
        p.god = !p.god;
        this._gmSay(p, `Godmode ${p.god ? 'ON — you take no damage.' : 'OFF.'}`);
        break;
      case 'spawn': {
        const type = (rest[0] || '').toLowerCase();
        if (!MOBS[type]) { this._gmSay(p, `Usage: .spawn <${Object.keys(MOBS).join('|')}> [n] (max 10).`); break; }
        const n = this._spawnMobNear(p, type, num(rest[1], 1));
        this._gmSay(p, `Spawned ${n} ${MOBS[type].name}${n > 1 ? 's' : ''} near you.`);
        break;
      }
      case 'npc': {
        const sub = (rest[0] || '').toLowerCase();
        if (sub !== 'summon') { this._gmSay(p, `Usage: .npc summon <npc-id> [n] (max 10 per command).`); break; }
        const type = (rest[1] || '').toLowerCase();
        if (!MOBS[type]) { this._gmSay(p, `Unknown creature. Available: ${Object.keys(MOBS).join(', ')}`); break; }
        const n = this._spawnMobNear(p, type, num(rest[2], 1));
        this._gmSay(p, `Summoned ${n} ${MOBS[type].name}${n > 1 ? 's' : ''} near you.`);
        break;
      }
      case 'tele':
      case 'tp': {
        const where = (rest[0] || '').toLowerCase();
        if (!where) {
          this._gmSay(p, `Teleport locations: ${Object.keys(Game.TELEPORTS).join(' · ')} — or .tele <x> <z>.`);
          break;
        }
        let dest = null;
        if (Game.TELEPORTS[where]) dest = Game.TELEPORTS[where]();
        else {
          const x = num(rest[0], NaN), z = num(rest[1], NaN);
          if (Number.isFinite(x) && Number.isFinite(z)) dest = { x, z };
        }
        if (!dest) { this._gmSay(p, 'Usage: .tele [spawn|dungeon|raid] | .tele <x> <z>'); break; }
        p.x = Math.max(-BOUNDS, Math.min(BOUNDS, dest.x));
        p.z = Math.max(-BOUNDS, Math.min(BOUNDS, dest.z));
        resolveColliders(p, this.colliders, 0.5);
        p.dirty = true;
        this._gmSay(p, `Teleported to (${p.x.toFixed(1)}, ${p.z.toFixed(1)}).`);
        break;
      }
      case 'goname':
      case 'appear': {
        const t = this._playerByName(rest.join(' '));
        if (!t) { this._gmSay(p, 'Usage: .goname <player> — target must be online.'); break; }
        p.x = t.x; p.z = t.z;
        resolveColliders(p, this.colliders, 0.5);
        p.dirty = true;
        this._gmSay(p, `Teleported to ${t.name} (${p.x.toFixed(1)}, ${p.z.toFixed(1)}).`);
        break;
      }
      case 'namego':
      case 'summon': {
        const t = this._playerByName(rest.join(' '));
        if (!t) { this._gmSay(p, 'Usage: .summon <player> — target must be online.'); break; }
        if (t === p) { this._gmSay(p, 'You are already here.'); break; }
        t.x = p.x; t.z = p.z;
        resolveColliders(t, this.colliders, 0.5);
        t.dirty = true;
        this._gmSay(p, `Summoned ${t.name} to your position.`);
        this._gmSay(t, `${p.name} has summoned you.`);
        break;
      }
      case 'speed': {
        const m = Math.max(0.5, Math.min(3, num(rest[0], 0)));
        if (!m) { this._gmSay(p, 'Usage: /speed <0.5–3>.'); break; }
        p.speedMult = m;
        p.speed = CLASSES[p.cls].speed * m;
        p.dirty = true;
        this._sendStats(p);
        this._gmSay(p, `Speed multiplier set to ${m}x.`);
        break;
      }
      case 'killmobs': {
        let n = 0;
        for (const m of this.mobs) {
          if (m.dead) continue;
          m.dead = true; m.hp = 0; m.state = 'dead'; m.targetId = null;
          m.respawnT = MOBS[m.mob].respawn;
          this._bcast({ op: 'ev', ev: 'die', id: m.id, by: 0 });
          n++;
        }
        this._gmSay(p, `Killed ${n} mob${n === 1 ? '' : 's'}.`);
        break;
      }
      case 'gm': {
        const sub = (rest[0] || '').toLowerCase();
        const arg = (rest[1] || '').toLowerCase();
        const want = (cur) => arg === 'on' ? true : arg === 'off' ? false : !cur;
        if (sub === 'visible') {
          p.gmInvisible = arg === 'on' ? false : arg === 'off' ? true : !p.gmInvisible;
          this._gmSay(p, p.gmInvisible
            ? 'GM visibility OFF — you are invisible to normal players (other GMs still see you).'
            : 'GM visibility ON — normal players can see you again.');
        } else if (sub === 'fly') {
          p.fly = want(p.fly);
          if (!p.fly) p.y = 0; // landing resets height
          p.dirty = true;
          this._sendStats(p);
          this._gmSay(p, p.fly
            ? 'Fly mode ON — Space ascends, C descends (0–30m).'
            : 'Fly mode OFF — you land.');
        } else if (sub === '' || sub === 'on' || sub === 'off') {
          p.gmMode = sub === '' ? !p.gmMode : sub === 'on';
          if (p.gmMode) this._combatStop(p); // entering GM mode drops existing aggro
          p.dirty = true;
          this._sendStats(p);
          this._gmSay(p, p.gmMode
            ? 'GM mode ON — mobs never aggro you; the <GM> tag shows.'
            : 'GM mode OFF — you play as a normal player (command access kept, tag hidden).');
        } else {
          this._gmSay(p, 'Usage: .gm [on|off] · .gm visible [on|off] · .gm fly [on|off]');
        }
        break;
      }
      case 'die': {
        const t = p.targetId != null ? this._entById(p.targetId) : null;
        if (t && t.kind === 'mob' && !t.dead) {
          t.dead = true; t.hp = 0; t.state = 'dead'; t.targetId = null;
          t.respawnT = MOBS[t.mob].respawn;
          this._bcast({ op: 'ev', ev: 'die', id: t.id, by: 0 });
          this._gmSay(p, `Killed ${t.name}.`);
        } else if (t && t.kind === 'player') {
          if (t.dead) this._gmSay(p, `${t.name} is already dead.`);
          else { this._killPlayer(t, 0); this._gmSay(p, t === p ? 'You died.' : `Killed ${t.name}.`); }
        } else if (!t) {
          this._killPlayer(p, 0); // no target = self
          this._gmSay(p, 'You died.');
        } else {
          this._gmSay(p, 'Nothing to kill.');
        }
        break;
      }
      case 'revive': {
        const t = p.targetId != null ? this._entById(p.targetId) : null;
        const dst = (t && t.kind === 'player' && t.dead) ? t : (p.dead ? p : null);
        if (!dst) { this._gmSay(p, 'Nothing to revive — target a dead player, or be dead yourself.'); break; }
        dst.dead = false; dst.hp = dst.maxHp; dst.mp = dst.maxMp; dst.deadT = 0; dst.casting = null;
        this._bcast({ op: 'ev', ev: 'respawn', id: dst.id, x: dst.x, z: dst.z });
        this._sendStats(dst);
        this._gmSay(p, dst === p ? 'You live again.' : `Revived ${dst.name}.`);
        break;
      }
      case 'additem': {
        const id = (rest[0] || '').toLowerCase();
        const it = ITEMS[id];
        if (!it) { this._gmSay(p, `Unknown item. Available: ${Object.keys(ITEMS).join(', ')}`); break; }
        let dst = p;
        const t = p.targetId != null ? this._entById(p.targetId) : null;
        if (t && t.kind === 'player' && t !== p) dst = t;
        this._equip(dst, id);
        this._gmSay(p, `Granted ${it.name} to ${dst === p ? 'you' : dst.name} (equipped — quantity is reserved for future stackables).`);
        if (dst !== p) this._gmSay(dst, `${p.name} granted you ${it.name}.`);
        break;
      }
      case 'cooldown': {
        let dst = p;
        const t = p.targetId != null ? this._entById(p.targetId) : null;
        if (t && t.kind === 'player' && t !== p) dst = t;
        dst.cds = {};
        this._send(dst.ws, { op: 'ev', ev: 'cdclear' }); // client wipes its cooldown overlays
        this._gmSay(p, `Cooldowns cleared for ${dst === p ? 'you' : dst.name}.`);
        break;
      }
      case 'combatstop': {
        let dst = p;
        const t = p.targetId != null ? this._entById(p.targetId) : null;
        if (t && t.kind === 'player' && t !== p) dst = t;
        this._combatStop(dst);
        this._gmSay(p, `Combat dropped for ${dst === p ? 'you' : dst.name} — attackers leash home.`);
        break;
      }
      default:
        this._gmSay(p, `Unknown GM command. Try /help.`);
    }
  }

  // ---------- pets ----------
  _petById(id) { return this.pets.get(id); }

  _petView(p) {
    const pet = p.pet;
    if (!pet) return null;
    return { id: pet.id, mob: pet.mob, name: pet.name, hp: Math.max(0, Math.round(pet.hp)), maxHp: pet.maxHp, dead: pet.dead, follow: pet.follow };
  }

  // Pet damage scales with owner level: base mob damage +10%/level.
  _petDmg(pet) {
    const d = MOBS[pet.mob];
    const owner = this.players.get(pet.ownerId);
    const lvl = owner ? owner.level : 1;
    return rand(d.dmg[0], d.dmg[1]) * (1 + 0.1 * (lvl - 1));
  }

  _killPet(pet) {
    if (pet.dead) return;
    pet.dead = true; pet.hp = 0; pet.targetId = null;
    this._bcast({ op: 'ev', ev: 'die', id: pet.id, by: 0 });
    const owner = this.players.get(pet.ownerId);
    if (owner) this._gmSay(owner, 'Your pet has died. Use Revive Pet (out of combat) or respawn to bring it back.');
  }

  _revivePet(p, silent) {
    const pet = p.pet;
    if (!pet || !pet.dead) return false;
    pet.dead = false; pet.hp = pet.maxHp;
    pet.x = p.x - Math.sin(p.heading) * 2.5; pet.z = p.z - Math.cos(p.heading) * 2.5;
    this._bcast({ op: 'ev', ev: 'respawn', id: pet.id, x: pet.x, z: pet.z });
    if (!silent) this._gmSay(p, 'Your pet has been revived.');
    return true;
  }

  _tameBeast(p, target) {
    const d = MOBS[target.mob];
    // release the old pet, if any
    if (p.pet) {
      this._bcast({ op: 'ev', ev: 'die', id: p.pet.id, by: 0 });
      this.pets.delete(p.pet.id);
      p.pet = null;
    }
    // remove the wild mob
    this.mobs = this.mobs.filter((m) => m.id !== target.id);
    const lvl = p.level;
    const maxHp = Math.round(d.hp * (1 + 0.1 * (lvl - 1)));
    const pet = {
      id: nextId++, kind: 'pet', mob: target.mob, name: d.name,
      ownerId: p.id, ownerName: p.name,
      x: target.x, z: target.z, heading: target.heading,
      hp: maxHp, maxHp, dead: false,
      targetId: null, swingT: 0, moving: false, follow: true,
      lastCombat: -99,
    };
    p.pet = pet;
    this.pets.set(pet.id, pet);
    this._bcast({ op: 'ev', ev: 'die', id: target.id, by: p.id });
    this._bumpAch(p, 'petsTamed'); // Beast Master
    this._gmSay(p, `You have tamed a ${d.name}! It will fight beside you. (/petfollow to toggle stay)`);
  }

  _tickPet(pet, dt) {
    const owner = this.players.get(pet.ownerId);
    if (!owner) { this.pets.delete(pet.id); return; } // owner logged out
    if (pet.dead) return;
    pet.moving = false;
    // assist: attack the owner's current target
    let tgt = null;
    if (pet.follow && owner.targetId != null) {
      const t = this._mobById(owner.targetId);
      if (t && !t.dead) tgt = t;
    }
    if (tgt) {
      const dd = dist(pet, tgt);
      if (dd <= 2.4) {
        pet.heading = Math.atan2(tgt.x - pet.x, tgt.z - pet.z);
        pet.swingT -= dt;
        if (pet.swingT <= 0) {
          pet.swingT = 2.0;
          pet.lastCombat = this.time;
          this._damage(pet.id, tgt, this._petDmg(pet), 'Pet', 'melee');
        }
      } else {
        this._moveToward(pet, tgt, 7, dt);
      }
    } else if (pet.follow) {
      // follow ~2.5 m behind the owner
      const tx = owner.x - Math.sin(owner.heading) * 2.5;
      const tz = owner.z - Math.cos(owner.heading) * 2.5;
      if (Math.hypot(tx - pet.x, tz - pet.z) > 1.2) this._moveToward(pet, { x: tx, z: tz }, 7, dt);
      else pet.heading = owner.heading;
    }
  }

  // ---------- combat ----------
  _mobById(id) { return this.mobs.find(m => m.id === id); }
  _entById(id) { return this.players.get(id) || this.pets.get(id) || this._mobById(id); }

  _inRange(a, b, r) { return dist(a, b) <= r + 0.001; }

  // Attacker level for armor mitigation (mobs use their data level, pets their owner's).
  _attackerLevel(src) {
    if (!src) return 1;
    if (src.kind === 'player') return src.level;
    if (src.kind === 'pet') { const o = this.players.get(src.ownerId); return o ? o.level : 1; }
    if (src.kind === 'mob') return MOBS[src.mob].level || 1;
    return 1;
  }

  // Avoidance stats of a defender as fractions {dodge, parry}.
  _defenderAvoid(dst) {
    if (dst.kind === 'player') return { dodge: dst.dodge || 0, parry: dst.parry || 0 };
    return { dodge: 0.05, parry: 0 }; // mobs and pets: small base dodge, no parry
  }

  // kind: 'melee' | 'ranged' | 'spell'. Rolls dodge -> parry (melee only) ->
  // crit, applies armor mitigation to physical damage, and reports the outcome
  // in the dmg ev as roll: 'dodge' | 'parry' | 'crit' | 'hit'.
  _damage(srcId, dst, amount, label, kind = 'melee') {
    if (dst.dead) return;
    if (dst.kind === 'player' && dst.god) return; // GM godmode: no damage taken
    // retaliation: a damaged mob turns on its attacker (player or pet)
    if (dst.kind === 'mob' && srcId) {
      const src = this._entById(srcId);
      if (src && src.kind !== 'mob' && !src.dead && dst.targetId == null) dst.targetId = srcId;
    }
    const src = srcId != null ? this._entById(srcId) : null;
    const physical = kind !== 'spell';
    let roll = 'hit';
    const avoid = this._defenderAvoid(dst);
    if (physical && Math.random() < avoid.dodge) roll = 'dodge';
    else if (kind === 'melee' && Math.random() < avoid.parry) roll = 'parry';
    let crit = false;
    if (roll === 'hit' && src) {
      const c = src.kind === 'player' ? (src.crit || 0) : 0.05;
      if (Math.random() < c) { crit = true; roll = 'crit'; }
    }
    if (roll === 'dodge') {
      amount = 0;
    } else {
      amount = Math.max(1, Math.round(amount * rand(0.9, 1.1)));
      // armor mitigation (physical only): armor / (armor + 40 * attackerLevel), cap 75%
      if (physical) {
        const armor = dst.kind === 'player' ? (dst.armor || 0)
          : dst.kind === 'pet' ? 0
          : (MOBS[dst.mob].armor || 0);
        const mit = Math.min(0.75, armor / (armor + 40 * this._attackerLevel(src)));
        amount = Math.max(1, Math.round(amount * (1 - mit)));
      }
      if (dst.kind === 'player' && this.time < (dst.buffs.shieldBlock || 0)) amount = Math.round(amount * 0.5);
      if (roll === 'parry') amount = Math.max(1, Math.round(amount * 0.5));
      if (roll === 'crit') amount *= 2;
    }
    dst.hp -= amount;
    dst.lastCombat = this.time;
    // taking damage breaks emotes and wakes sleepers; damage also clears AFK
    if (dst.kind === 'player') {
      if (dst.emote) { dst.emote = null; dst.emoteUntil = 0; }
      if (dst.afk) { dst.afk = false; dst.afkMsg = ''; this._emoteSay(dst, `${dst.name} is no longer AFK.`); }
    }
    this._bcast({ op: 'ev', ev: 'dmg', src: srcId, dst: dst.id, amount, crit, roll, label });
    if (dst.kind === 'player') this._sendStats(dst);
    if (dst.hp <= 0) {
      dst.hp = 0;
      if (dst.kind === 'mob') this._killMob(dst, this._killerOf(srcId));
      else if (dst.kind === 'pet') this._killPet(dst);
      else this._killPlayer(dst, srcId);
    }
  }

  // Resolve a damage source id to the player who earns kill credit
  // (pet kills credit their owner).
  _killerOf(srcId) {
    const src = srcId != null ? this._entById(srcId) : null;
    if (!src) return null;
    if (src.kind === 'player') return src;
    if (src.kind === 'pet') { const o = this.players.get(src.ownerId); return o && !o.dead ? o : null; }
    return null;
  }

  _killMob(m, killer) {
    m.dead = true; m.hp = 0; m.state = 'dead'; m.targetId = null;
    m.respawnT = MOBS[m.mob].respawn;
    this._bcast({ op: 'ev', ev: 'die', id: m.id, by: killer ? killer.id : 0 });
    if (killer && !killer.dead) {
      const d = MOBS[m.mob];
      const coins = Math.round(rand(d.coins[0], d.coins[1]));
      killer.coins += coins;
      this._send(killer.ws, { op: 'ev', ev: 'kill', mob: m.mob, xp: d.xp, coins });
      this._awardXp(killer, d.xp);
      if (killer.kind === 'player') {
        this._bumpAch(killer, 'kills.total');
        if (m.mob === 'boar' || m.mob === 'wolf' || m.mob === 'alpha') this._bumpAch(killer, 'kills.' + m.mob);
      }
      this._sendStats(killer);
      killer.dirty = true;
    }
  }

  _awardXp(p, amount) {
    if (p.level >= MAX_LEVEL) return;
    p.xp += amount;
    const c = CLASSES[p.cls];
    while (p.level < MAX_LEVEL && p.xp >= xpNext(p.level)) {
      p.xp -= xpNext(p.level);
      p.level++;
      // per-class stat growth, then recalc keeping current HP/MP ratios
      for (const k of ['str', 'agi', 'sta', 'int']) p.stats[k] += c.growth[k];
      this._recalcStats(p, 'ratio');
      this._send(p.ws, { op: 'ev', ev: 'lvlup', level: p.level });
      this._sys(`${p.name} has reached level ${p.level}!`);
    }
  }

  _killPlayer(p, byId) {
    p.dead = true; p.deadT = 8; p.casting = null; p.targetId = null;
    p.ach.counters.deaths++; p.dirty = true; // Survivor unlocks on the respawn
    this._bcast({ op: 'ev', ev: 'die', id: p.id, by: byId || 0 });
    this._sendStats(p);
    // killer mob loses interest
    for (const m of this.mobs) if (m.targetId === p.id) { m.targetId = null; m.state = 'return'; }
  }

  _respawn(p) {
    p.dead = false; p.hp = p.maxHp; p.mp = p.maxMp;
    p.x = LAYOUT.spawn.x; p.z = LAYOUT.spawn.z;
    this._bcast({ op: 'ev', ev: 'respawn', id: p.id, x: p.x, z: p.z });
    this._sendStats(p);
    this._checkAch(p); // Survivor (deaths >= 1) unlocks here
    // ranger's pet auto-revives with its master
    if (p.pet && p.pet.dead) this._revivePet(p, true);
  }

  _cast(p, slot) {
    if (p.dead || p.casting) return;
    if (p.emote) { p.emote = null; p.emoteUntil = 0; } // casting breaks emotes
    if (p.afk) this._clearAfk(p); // casting clears AFK
    const c = CLASSES[p.cls];
    const a = c.abilities.find(x => x.slot === slot);
    if (!a) return;
    if ((p.cds[slot] || 0) > this.time) return;
    if (p.mp < a.mana) { this._send(p.ws, { op: 'err', msg: 'Not enough mana.' }); return; }
    let target = null;
    // gates that need no target come before target/range validation
    if (a.id === 'tamebeast' && p.level < 10) {
      this._send(p.ws, { op: 'err', msg: 'Tame Beast unlocks at level 10.' }); return;
    }
    if (a.range > 0) {
      target = this._mobById(p.targetId);
      if (!target || target.dead) { this._send(p.ws, { op: 'err', msg: 'No target.' }); return; }
      if (!this._inRange(p, target, a.range)) { this._send(p.ws, { op: 'err', msg: 'Target out of range.' }); return; }
    }
    // pet abilities: extra validation before mana is spent / the channel starts
    if (a.id === 'tamebeast') {
      if (!target || target.dead || target.elite || (target.mob !== 'boar' && target.mob !== 'wolf')) {
        this._send(p.ws, { op: 'err', msg: 'You can only tame a boar or wolf.' }); return;
      }
    }
    if (a.id === 'revivepet') {
      const pet = p.pet;
      if (!pet) { this._send(p.ws, { op: 'err', msg: 'You have no pet to revive.' }); return; }
      if (!pet.dead) { this._send(p.ws, { op: 'err', msg: 'Your pet is not dead.' }); return; }
      if (this.time - p.lastCombat <= 5) { this._send(p.ws, { op: 'err', msg: 'You must be out of combat to revive your pet.' }); return; }
    }
    p.mp -= a.mana;
    p.cds[slot] = this.time + a.cd;
    p.lastCombat = this.time;
    const dur = a.cast;
    const endsAt = this.time + dur;
    this._bcast({ op: 'ev', ev: 'cast', src: p.id, slot: a.slot, label: a.name, dur, endsAt });
    if (a.proj && target) this._bcast({ op: 'ev', ev: 'proj', src: p.id, dst: target.id, kind: a.proj });
    if (dur > 0) { p.casting = { slot, endsAt, dur, label: a.name, targetId: target ? target.id : null }; }
    else this._resolveCast(p, a, target);
    this._sendStats(p);
  }

  _resolveCast(p, a, target) {
    // ability damage = flat base + equipped weapon attack + attack power (from primary stat) scaling
    const ap = p.attackPower || 0;
    const dmg = (amt, k = 0.5) => amt + (p.atkBonus || 0) + ap * k;
    switch (a.id) {
      case 'strike': this._damage(p.id, target, dmg(4, 0.6), a.name, 'melee'); break;
      case 'charge': {
        const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
        if (d > 0.01) {
          const stop = Math.max(0, d - 2.5);
          p.x += (dx / d) * stop; p.z += (dz / d) * stop;
          resolveColliders(p, this.colliders);
        }
        this._damage(p.id, target, dmg(2, 0.4), a.name, 'melee');
        break;
      }
      case 'shieldblock': p.buffs.shieldBlock = this.time + 6; this._bcast({ op: 'ev', ev: 'buff', id: p.id, label: 'Shield Block', dur: 6 }); break;
      case 'whirlwind':
        for (const m of this.mobs) if (!m.dead && this._inRange(p, m, 6)) this._damage(p.id, m, dmg(3, 0.45), a.name, 'melee');
        break;
      case 'fireball': this._damage(p.id, target, dmg(6, 0.8), a.name, 'spell'); break;
      case 'frostbolt':
        this._damage(p.id, target, dmg(4, 0.5), a.name, 'spell');
        if (!target.dead) target.slowUntil = this.time + 4;
        break;
      case 'blink': {
        p.x += Math.sin(p.heading) * 12; p.z += Math.cos(p.heading) * 12;
        resolveColliders(p, this.colliders);
        break;
      }
      case 'arcaneexplosion':
        for (const m of this.mobs) if (!m.dead && this._inRange(p, m, 8)) this._damage(p.id, m, dmg(5, 0.6), a.name, 'spell');
        break;
      case 'steadyshot': this._damage(p.id, target, dmg(5, 0.7), a.name, 'ranged'); break;
      case 'multishot': {
        const near = this.mobs.filter(m => !m.dead && this._inRange(p, m, 28)).sort((x, y) => dist(p, x) - dist(p, y)).slice(0, 3);
        for (const m of near) { this._damage(p.id, m, dmg(4, 0.5), a.name, 'ranged'); this._bcast({ op: 'ev', ev: 'proj', src: p.id, dst: m.id, kind: 'arrow' }); }
        break;
      }
      case 'disengage':
        p.x -= Math.sin(p.heading) * 10; p.z -= Math.cos(p.heading) * 10;
        resolveColliders(p, this.colliders);
        break;
      case 'volley':
        for (const m of this.mobs) if (!m.dead && this._inRange(target, m, 6)) this._damage(p.id, m, dmg(5, 0.6), a.name, 'ranged');
        break;
      case 'tamebeast': {
        // re-validate at channel completion
        const t = this._mobById(p.targetId);
        if (p.level < 10 || !t || t.dead || t.elite || (t.mob !== 'boar' && t.mob !== 'wolf') || !this._inRange(p, t, 25)) {
          this._gmSay(p, 'Tame failed — the beast must be a living boar or wolf nearby.');
          break;
        }
        this._tameBeast(p, t);
        break;
      }
      case 'revivepet': {
        this._revivePet(p, false);
        break;
      }
    }
  }

  // ---------- tick ----------
  tick(dt) {
    this.time += dt;
    for (const p of this.players.values()) this._tickPlayer(p, dt);
    for (const m of this.mobs) this._tickMob(m, dt);
    for (const pet of this.pets.values()) this._tickPet(pet, dt);
    this._snapT += dt;
    if (this._snapT >= 0.1) { this._snapT = 0; this._broadcastSnap(); }
    this._saveT += dt;
    if (this._saveT >= 5) { this._saveT = 0; for (const p of this.players.values()) if (p.dirty) this._persist(p); }
    // /played: accumulate session time into playTime every 60 s so totals
    // survive crashes, not just clean disconnects.
    this._playT = (this._playT || 0) + dt;
    if (this._playT >= 60) {
      this._playT = 0;
      const now = Date.now();
      for (const p of this.players.values()) {
        p.playTime += (now - p.sessionStart) / 1000;
        p.sessionStart = now;
        p.dirty = true;
      }
    }
  }

  _tickPlayer(p, dt) {
    if (p.dead) {
      p.deadT -= dt;
      if (p.deadT <= 0) this._respawn(p);
      return;
    }
    // movement (authoritative integrate, speed-hack clamped by construction)
    const c = CLASSES[p.cls];
    p.moving = (p.move.mx !== 0 || p.move.mz !== 0);
    if (p.moving) {
      p.x += p.move.mx * p.speed * dt;
      p.z += p.move.mz * p.speed * dt;
      p.ach.counters.distanceM += Math.hypot(p.move.mx, p.move.mz) * p.speed * dt; // Wanderer
      resolveColliders(p, this.colliders, 0.5);
    }
    this._tickEmote(p); // movement breaks emotes; one-shots expire
    // achievement check at 1 Hz (level, coinsMax, distance)
    p._achT = (p._achT || 0) + dt;
    if (p._achT >= 1) { p._achT = 0; this._checkAch(p); }
    // regen
    const ooc = this.time - p.lastCombat > 5;
    p.mp = Math.min(p.maxMp, p.mp + (ooc ? 8 : 4) * dt);
    if (ooc) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.02 * dt);
    // trickle stats (regen) to the client at 1 Hz
    p._statT = (p._statT || 0) + dt;
    if (p._statT >= 1) { p._statT = 0; this._sendStats(p); }
    // cast completion
    if (p.casting && this.time >= p.casting.endsAt) {
      const a = c.abilities.find(x => x.slot === p.casting.slot);
      const target = this._mobById(p.casting.targetId);
      p.casting = null;
      if (a && (!a.range || (target && !target.dead))) this._resolveCast(p, a, target);
    }
    // auto attack
    p.swingT -= dt;
    if (p.autoOn && !p.casting && p.swingT <= 0) {
      const target = this._mobById(p.targetId);
      if (target && !target.dead && this._inRange(p, target, c.range)) {
        p.swingT = c.swing;
        p.lastCombat = this.time;
        const kind = p.cls === 'warrior' ? 'melee' : p.cls === 'ranger' ? 'ranged' : 'spell';
        this._damage(p.id, target, (p.atkBonus || 0) + (p.attackPower || 0) * 0.45, null, kind);
        if (p.cls !== 'warrior') this._bcast({ op: 'ev', ev: 'proj', src: p.id, dst: target.id, kind: p.cls === 'mage' ? 'frost' : 'arrow' });
      }
    }
  }

  _tickMob(m, dt) {
    const d = MOBS[m.mob];
    if (m.dead) {
      m.respawnT -= dt;
      if (m.respawnT <= 0) {
        m.dead = false; m.hp = m.maxHp; m.x = m.hx; m.z = m.hz;
        m.state = 'idle'; m.enraged = false; m.slowUntil = 0;
        this._bcast({ op: 'ev', ev: 'respawn', id: m.id, x: m.x, z: m.z });
      }
      return;
    }
    // enrage
    if (d.elite && !m.enraged && m.hp < m.maxHp * d.enrageAt) {
      m.enraged = true;
      this._bcast({ op: 'ev', ev: 'chat', from: '', text: 'The Alpha Wolf enrages!', sys: true });
    }
    const speed = d.speed * (m.enraged ? 1.3 : 1) * (this.time < m.slowUntil ? 0.6 : 1);
    m.moving = false;

    // validate current target (players and pets)
    let tgt = m.targetId != null ? this._entById(m.targetId) : null;
    if (tgt && (tgt.dead || tgt.kind === 'mob' || dist(m, tgt) > 34)) { tgt = null; m.targetId = null; }

    if (!tgt) {
      // acquire: hostile mobs aggro nearby players and their pets; others only retaliate
      if (d.hostile && m.state !== 'return') {
        let best = null, bd = d.aggro;
        for (const p of this.players.values()) {
          // GM mode ON or invisible GMs never draw aggro
          if (!p.dead && !((p.gm && p.gmMode) || p.gmInvisible)) {
            const dd = dist(m, p);
            if (dd < bd) { bd = dd; best = p; }
          }
          const pt = p.pet;
          if (pt && !pt.dead) {
            const pd = dist(m, pt);
            if (pd < bd) { bd = pd; best = pt; }
          }
        }
        if (best) { m.targetId = best.id; tgt = best; }
      }
      // leash return
      if (m.state === 'return' || dist(m, { x: m.hx, z: m.hz }) > 30) {
        m.state = 'return'; m.targetId = null; tgt = null;
        const home = { x: m.hx, z: m.hz };
        if (dist(m, home) < 1.5) { m.state = 'idle'; m.hp = m.maxHp; m.enraged = false; }
        else { this._moveToward(m, home, speed, dt); }
      } else if (!tgt) {
        // wander
        m.wanderT -= dt;
        if (m.state !== 'wander' && m.wanderT <= 0) {
          m.state = 'wander'; m.wanderT = rand(4, 9);
          const a = rand(0, Math.PI * 2), r = rand(3, 9);
          m.wx = m.hx + Math.cos(a) * r; m.wz = m.hz + Math.sin(a) * r;
        }
        if (m.state === 'wander') {
          if (dist(m, { x: m.wx, z: m.wz }) < 1) { m.state = 'idle'; }
          else this._moveToward(m, { x: m.wx, z: m.wz }, d.speed * 0.5, dt);
        }
      }
    }

    if (tgt) {
      const dd = dist(m, tgt);
      if (dd <= d.range) {
        m.state = 'attack'; m.heading = Math.atan2(tgt.x - m.x, tgt.z - m.z);
        m.swingT -= dt;
        if (m.swingT <= 0) {
          m.swingT = d.swing / (m.enraged ? 1.4 : 1);
          m.lastCombat = this.time;
          this._damage(m.id, tgt, (rand(d.dmg[0], d.dmg[1]) + d.str * 0.2) * (m.enraged ? 1.5 : 1), m.name, 'melee');
        }
      } else {
        m.state = 'chase';
        this._moveToward(m, tgt, speed, dt);
      }
    }
  }

  _moveToward(m, t, speed, dt) {
    const dx = t.x - m.x, dz = t.z - m.z, d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    m.x += (dx / d) * speed * dt;
    m.z += (dz / d) * speed * dt;
    m.heading = Math.atan2(dx, dz);
    m.moving = true;
    resolveColliders(m, this.colliders, 0.4);
  }

  // retaliation: damaging a mob makes it aggressive toward the attacker.
  // (Implemented inside _damage above — single damage path.)

  _broadcastSnap() {
    const t = +this.time.toFixed(2);
    const ents = [];
    for (const p of this.players.values()) {
      ents.push({
        id: p.id, kind: 'player', name: p.name, cls: p.cls, level: p.level,
        x: +p.x.toFixed(2), y: +(p.y || 0).toFixed(2), z: +p.z.toFixed(2), heading: +p.heading.toFixed(2),
        hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
        moving: p.moving, dead: p.dead, gm: (p.gm && p.gmMode) || undefined,
        guild: this._guildName(p) || undefined,
        appearance: p.appearance,
        casting: p.casting ? { label: p.casting.label, endsAt: +p.casting.endsAt.toFixed(2), dur: p.casting.dur } : undefined,
        emote: p.emote || undefined,
        afk: p.afk || undefined, afkMsg: p.afk ? p.afkMsg : undefined,
      });
    }
    for (const m of this.mobs) {
      ents.push({
        id: m.id, kind: 'mob', mob: m.mob, name: m.name, elite: m.elite || undefined, level: 1,
        x: +m.x.toFixed(2), z: +m.z.toFixed(2), heading: +m.heading.toFixed(2),
        hp: Math.max(0, Math.round(m.hp)), maxHp: m.maxHp,
        moving: m.moving, dead: m.dead,
        slow: this.time < m.slowUntil ? +(m.slowUntil - this.time).toFixed(1) : undefined, // frostbolt debuff
      });
    }
    for (const pet of this.pets.values()) {
      ents.push({
        id: pet.id, kind: 'pet', mob: pet.mob, name: pet.name,
        ownerId: pet.ownerId, ownerName: pet.ownerName, level: 1,
        x: +pet.x.toFixed(2), z: +pet.z.toFixed(2), heading: +pet.heading.toFixed(2),
        hp: Math.max(0, Math.round(pet.hp)), maxHp: pet.maxHp,
        moving: pet.moving, dead: pet.dead,
      });
    }
    for (const q of this.players.values()) this._sendSnap(q, ents, t);
  }

  // Invisible GMs are excluded from non-GM players' snap entity lists
  // (their clients sweep the missing ent away, so plates/targeting drop too).
  _sendSnap(q, ents, t) {
    if (q.gm) { this._send(q.ws, { op: 'snap', t, ents }); return; }
    const vis = [];
    for (const e of ents) {
      if (e.kind === 'player') {
        const pl = this.players.get(e.id);
        if (pl && pl.gmInvisible) continue;
      }
      vis.push(e);
    }
    this._send(q.ws, { op: 'snap', t, ents: vis });
  }
}
