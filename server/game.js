// WORLDSPIRE authoritative simulation. 20 Hz tick, snapshots at 10 Hz.
import { CLASSES, MOBS, LAYOUT, MOB_SPAWNS, buildColliders, resolveColliders, xpNext, MAX_LEVEL, BOUNDS } from './data.js';

let nextId = 1;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rand = (a, b) => a + Math.random() * (b - a);
const clampMove = (m) => { const l = Math.hypot(m.mx, m.mz); if (l > 1) { m.mx /= l; m.mz /= l; } };

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
    for (const s of MOB_SPAWNS) this.mobs.push(this._makeMob(s.mob, s.x, s.z));
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

  async login(ws, name, cls) {
    if (!/^[A-Za-z0-9]{2,16}$/.test(name)) { ws.send(JSON.stringify({ op: 'err', msg: 'Name must be 2–16 letters/numbers.' })); return null; }
    if (!CLASSES[cls]) { ws.send(JSON.stringify({ op: 'err', msg: 'Unknown class.' })); return null; }
    const ln = name.toLowerCase();
    if (this.byName.has(ln)) { ws.send(JSON.stringify({ op: 'err', msg: 'That name is already in the world.' })); return null; }
    const c = CLASSES[cls];
    const saved = await this.store.loadPlayer(name);
    const p = {
      id: nextId++, kind: 'player', name, cls, ws,
      level: 1, xp: 0, coins: 0,
      x: LAYOUT.spawn.x, z: LAYOUT.spawn.z, heading: Math.PI,
      hp: c.hp, maxHp: c.hp, mp: c.mp, maxMp: c.mp, speed: c.speed,
      move: { mx: 0, mz: 0 }, targetId: null, autoOn: true,
      dead: false, deadT: 0, cds: {}, casting: null, buffs: {},
      swingT: 0, lastCombat: -99, moving: false, dirty: false,
    };
    if (saved) {
      p.level = Math.min(saved.level || 1, MAX_LEVEL);
      p.xp = saved.xp || 0; p.coins = saved.coins || 0;
      p.x = saved.x ?? p.x; p.z = saved.z ?? p.z;
      this._applyLevelStats(p, false);
    }
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
    this.players.delete(id);
    this.byName.delete(p.name.toLowerCase());
    this._persist(p);
    this._sys(`${p.name} has left the world.`);
  }

  _applyLevelStats(p, fullRestore = true) {
    const c = CLASSES[p.cls];
    p.maxHp = c.hp + c.hpPer * (p.level - 1);
    p.maxMp = c.mp + c.mpPer * (p.level - 1);
    if (fullRestore) { p.hp = p.maxHp; p.mp = p.maxMp; }
    else { p.hp = Math.min(p.hp, p.maxHp); p.mp = Math.min(p.mp, p.maxMp); }
  }

  _persist(p) {
    p.dirty = false;
    this.store.savePlayer({ name: p.name, cls: p.cls, level: p.level, xp: p.xp, coins: p.coins, x: +p.x.toFixed(1), z: +p.z.toFixed(1) }).catch(() => {});
  }

  // ---------- messaging ----------
  _send(ws, o) { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
  _bcast(o) { for (const p of this.players.values()) this._send(p.ws, o); }
  _sys(text) { this._bcast({ op: 'ev', ev: 'chat', from: '', text, sys: true }); }

  _sendHello(p) {
    const c = CLASSES[p.cls];
    this._send(p.ws, {
      op: 'hello', id: p.id, name: p.name, cls: p.cls, level: p.level,
      xp: p.xp, xpNext: xpNext(p.level), coins: p.coins,
      x: p.x, z: p.z, hp: Math.round(p.hp), maxHp: p.maxHp, mp: Math.round(p.mp), maxMp: p.maxMp,
      speed: p.speed,
      abilities: c.abilities.map(a => ({ slot: a.slot, id: a.id, name: a.name, icon: a.icon, mana: a.mana, cd: a.cd, cast: a.cast, range: a.range, desc: a.desc })),
      colliders: this.colliders,
      layout: LAYOUT,
    });
  }

  _sendStats(p) {
    this._send(p.ws, {
      op: 'stats', hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
      mp: Math.max(0, Math.round(p.mp)), maxMp: p.maxMp,
      xp: p.xp, xpNext: xpNext(p.level), level: p.level, coins: p.coins, dead: p.dead,
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
        // moving cancels casts with a cast time
        if (p.casting && (p.move.mx || p.move.mz)) p.casting = null;
        break;
      }
      case 'target': {
        const id = d.id;
        p.targetId = (id != null && (this.players.has(id) || this.mobs.some(m => m.id === id))) ? id : null;
        break;
      }
      case 'auto': p.autoOn = !!d.on; break;
      case 'cast': this._cast(p, +d.slot); break;
      case 'chat': {
        const text = String(d.text || '').slice(0, 140).trim();
        if (text) this._bcast({ op: 'ev', ev: 'chat', from: p.name, text });
        break;
      }
      case 'respawn': if (p.dead) this._respawn(p); break;
      case 'ping': this._send(ws, { op: 'pong', t: d.t }); break;
    }
  }

  // ---------- combat ----------
  _mobById(id) { return this.mobs.find(m => m.id === id); }
  _entById(id) { return this.players.get(id) || this._mobById(id); }

  _inRange(a, b, r) { return dist(a, b) <= r + 0.001; }

  _damage(srcId, dst, amount, label) {
    if (dst.dead) return;
    // retaliation: a damaged mob turns on its attacker
    if (dst.kind === 'mob' && srcId) {
      const src = this.players.get(srcId);
      if (src && !src.dead && dst.targetId == null) dst.targetId = srcId;
    }
    amount = Math.max(1, Math.round(amount * rand(0.9, 1.1)));
    if (dst.kind === 'player' && this.time < (dst.buffs.shieldBlock || 0)) amount = Math.round(amount * 0.5);
    dst.hp -= amount;
    dst.lastCombat = this.time;
    const crit = amount >= (dst.maxHp * 0.15);
    this._bcast({ op: 'ev', ev: 'dmg', src: srcId, dst: dst.id, amount, crit, label });
    if (dst.kind === 'player') this._sendStats(dst);
    if (dst.hp <= 0) {
      dst.hp = 0;
      if (dst.kind === 'mob') this._killMob(dst, this.players.get(srcId));
      else this._killPlayer(dst, srcId);
    }
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
      this._sendStats(killer);
      killer.dirty = true;
    }
  }

  _awardXp(p, amount) {
    if (p.level >= MAX_LEVEL) return;
    p.xp += amount;
    while (p.level < MAX_LEVEL && p.xp >= xpNext(p.level)) {
      p.xp -= xpNext(p.level);
      p.level++;
      this._applyLevelStats(p, true);
      this._send(p.ws, { op: 'ev', ev: 'lvlup', level: p.level });
      this._sys(`${p.name} has reached level ${p.level}!`);
    }
  }

  _killPlayer(p, byId) {
    p.dead = true; p.deadT = 8; p.casting = null; p.targetId = null;
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
  }

  _cast(p, slot) {
    if (p.dead || p.casting) return;
    const c = CLASSES[p.cls];
    const a = c.abilities.find(x => x.slot === slot);
    if (!a) return;
    if ((p.cds[slot] || 0) > this.time) return;
    if (p.mp < a.mana) { this._send(p.ws, { op: 'err', msg: 'Not enough mana.' }); return; }
    let target = null;
    if (a.range > 0) {
      target = this._mobById(p.targetId);
      if (!target || target.dead) { this._send(p.ws, { op: 'err', msg: 'No target.' }); return; }
      if (!this._inRange(p, target, a.range)) { this._send(p.ws, { op: 'err', msg: 'Target out of range.' }); return; }
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
    const lvl = p.level;
    const dmg = (amt) => amt;
    switch (a.id) {
      case 'strike': this._damage(p.id, target, dmg(8 + 2 * lvl), a.name); break;
      case 'charge': {
        const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
        if (d > 0.01) {
          const stop = Math.max(0, d - 2.5);
          p.x += (dx / d) * stop; p.z += (dz / d) * stop;
          resolveColliders(p, this.colliders);
        }
        this._damage(p.id, target, dmg(4 + 1 * lvl), a.name);
        break;
      }
      case 'shieldblock': p.buffs.shieldBlock = this.time + 6; this._bcast({ op: 'ev', ev: 'buff', id: p.id, label: 'Shield Block', dur: 6 }); break;
      case 'whirlwind':
        for (const m of this.mobs) if (!m.dead && this._inRange(p, m, 6)) this._damage(p.id, m, dmg(7 + 1.5 * lvl), a.name);
        break;
      case 'fireball': this._damage(p.id, target, dmg(14 + 3 * lvl), a.name); break;
      case 'frostbolt':
        this._damage(p.id, target, dmg(9 + 2 * lvl), a.name);
        if (!target.dead) target.slowUntil = this.time + 4;
        break;
      case 'blink': {
        p.x += Math.sin(p.heading) * 12; p.z += Math.cos(p.heading) * 12;
        resolveColliders(p, this.colliders);
        break;
      }
      case 'arcaneexplosion':
        for (const m of this.mobs) if (!m.dead && this._inRange(p, m, 8)) this._damage(p.id, m, dmg(10 + 2 * lvl), a.name);
        break;
      case 'steadyshot': this._damage(p.id, target, dmg(12 + 2.5 * lvl), a.name); break;
      case 'multishot': {
        const near = this.mobs.filter(m => !m.dead && this._inRange(p, m, 28)).sort((x, y) => dist(p, x) - dist(p, y)).slice(0, 3);
        for (const m of near) { this._damage(p.id, m, dmg(8 + 2 * lvl), a.name); this._bcast({ op: 'ev', ev: 'proj', src: p.id, dst: m.id, kind: 'arrow' }); }
        break;
      }
      case 'disengage':
        p.x -= Math.sin(p.heading) * 10; p.z -= Math.cos(p.heading) * 10;
        resolveColliders(p, this.colliders);
        break;
      case 'volley':
        for (const m of this.mobs) if (!m.dead && this._inRange(target, m, 6)) this._damage(p.id, m, dmg(10 + 2 * lvl), a.name);
        break;
    }
  }

  // ---------- tick ----------
  tick(dt) {
    this.time += dt;
    for (const p of this.players.values()) this._tickPlayer(p, dt);
    for (const m of this.mobs) this._tickMob(m, dt);
    this._snapT += dt;
    if (this._snapT >= 0.1) { this._snapT = 0; this._broadcastSnap(); }
    this._saveT += dt;
    if (this._saveT >= 5) { this._saveT = 0; for (const p of this.players.values()) if (p.dirty) this._persist(p); }
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
      resolveColliders(p, this.colliders, 0.5);
    }
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
        this._damage(p.id, target, c.auto(p.level), null);
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

    // validate current target
    let tgt = m.targetId != null ? this.players.get(m.targetId) : null;
    if (tgt && (tgt.dead || dist(m, tgt) > 34)) { tgt = null; m.targetId = null; }

    if (!tgt) {
      // acquire: hostile mobs aggro nearby players; others only retaliate (handled in _damage via _aggro)
      if (d.hostile && m.state !== 'return') {
        let best = null, bd = d.aggro;
        for (const p of this.players.values()) {
          if (p.dead) continue;
          const dd = dist(m, p);
          if (dd < bd) { bd = dd; best = p; }
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
          this._damage(m.id, tgt, rand(d.dmg[0], d.dmg[1]) * (m.enraged ? 1.5 : 1), m.name);
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
    const ents = [];
    for (const p of this.players.values()) {
      ents.push({
        id: p.id, kind: 'player', name: p.name, cls: p.cls, level: p.level,
        x: +p.x.toFixed(2), z: +p.z.toFixed(2), heading: +p.heading.toFixed(2),
        hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
        moving: p.moving, dead: p.dead,
        casting: p.casting ? { label: p.casting.label, endsAt: +p.casting.endsAt.toFixed(2), dur: p.casting.dur } : undefined,
      });
    }
    for (const m of this.mobs) {
      ents.push({
        id: m.id, kind: 'mob', mob: m.mob, name: m.name, elite: m.elite || undefined, level: 1,
        x: +m.x.toFixed(2), z: +m.z.toFixed(2), heading: +m.heading.toFixed(2),
        hp: Math.max(0, Math.round(m.hp)), maxHp: m.maxHp,
        moving: m.moving, dead: m.dead,
      });
    }
    this._bcast({ op: 'snap', t: +this.time.toFixed(2), ents });
  }
}
