// HUD logic: player/target frames, hotbar + cooldowns, castbar, chat, xp,
// coins, death overlay, settings, achievements, toasts. Reads state.js every frame via update(dt).
import { targetEnt } from './state.js';
import { ACHIEVEMENTS, ACH_CATEGORIES } from './ach.js';

const $ = (id) => document.getElementById(id);

// Procedural class medallion icons (original SVG, class-colored).
const CLASS_MEDAL = {
  warrior: { color: '#d1603d', svg: `<svg viewBox="0 0 32 32"><g stroke="#d1603d" stroke-width="2.6" stroke-linecap="round"><line x1="10" y1="22" x2="22" y2="10"/><line x1="22" y1="22" x2="10" y2="10"/></g><g stroke="#d1603d" stroke-width="3.2" stroke-linecap="round"><line x1="8" y1="19" x2="12" y2="23"/><line x1="24" y1="19" x2="20" y2="23"/></g><circle cx="9" cy="24" r="1.9" fill="#d1603d"/><circle cx="23" cy="24" r="1.9" fill="#d1603d"/></svg>` },
  mage:    { color: '#6fb7ff', svg: `<svg viewBox="0 0 32 32"><line x1="16" y1="11" x2="16" y2="26" stroke="#6fb7ff" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="7" r="3.4" fill="none" stroke="#6fb7ff" stroke-width="2.4"/><g stroke="#6fb7ff" stroke-width="1.6" stroke-linecap="round"><line x1="16" y1="1" x2="16" y2="2.6"/><line x1="9.6" y1="7" x2="11.4" y2="7"/><line x1="20.6" y1="7" x2="22.4" y2="7"/></g></svg>` },
  ranger:  { color: '#7dffa8', svg: `<svg viewBox="0 0 32 32"><path d="M10 5 Q24 16 10 27" fill="none" stroke="#7dffa8" stroke-width="2.6" stroke-linecap="round"/><line x1="10" y1="5" x2="10" y2="27" stroke="#d8cba4" stroke-width="1.2"/><line x1="6" y1="16" x2="21" y2="16" stroke="#7dffa8" stroke-width="2" stroke-linecap="round"/><path d="M21 16 l-4 -2.4 M21 16 l-4 2.4" stroke="#7dffa8" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>` },
};
const MOB_MEDAL = { boar: '🐗', wolf: '🐺', alpha: '👑' };

export function initUI({ net, world, state }) {
  const cds = new Map();          // slot -> cooldown endsAt (performance.now ms)
  const toastQ = [];
  let toastUntil = 0;
  let chatRendered = 0;
  let hotbarSlots = [];
  let gearSig = '';
  let charSig = '';
  let achSig = '';
  let achCat = ACH_CATEGORIES[0];
  let medalSig = '';   // class medallion rebuild key
  let tfMedalSig = ''; // target medallion rebuild key
  let buffSig = '';    // player buff row
  let debuffSig = '';  // target debuff row

  function toast(msg) { if (msg) toastQ.push(String(msg)); }

  function startCooldown(slot) {
    const ab = (state.me && state.me.abilities || []).find((a) => a.slot === slot);
    const cd = ab && ab.cd ? ab.cd : 0;
    if (cd > 0) cds.set(slot, performance.now() + cd * 1000);
  }

  // GM .cooldown: wipe every slot's cooldown sweep immediately.
  function clearCooldowns() {
    cds.clear();
    const bar = document.getElementById('hotbar');
    if (!bar) return;
    for (const el of bar.querySelectorAll('.slot')) {
      const cdEl = el.querySelector('.cd');
      if (cdEl) cdEl.style.background = 'conic-gradient(rgba(0,0,0,0) 0deg, rgba(0,0,0,0) 360deg)';
      el.classList.remove('cooling');
    }
  }

  // ---- hotbar ----
  function buildHotbar() {
    const bar = $('hotbar');
    bar.innerHTML = '';
    hotbarSlots = [];
    const abs = (state.me && state.me.abilities) || [];
    for (const ab of abs) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.dataset.slot = ab.slot;
      const locked = ab.levelReq && (state.me.level || 1) < ab.levelReq;
      if (locked) el.classList.add('locked');
      el.title = locked ? `${ab.name} — Unlocks at level ${ab.levelReq}`
        : `${ab.name}${ab.mana ? ` — ${ab.mana} mana` : ''}${ab.cd ? ` — ${ab.cd}s cd` : ''}`;
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = ab.slot;
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = ab.icon || '❔';
      const cd = document.createElement('span');
      cd.className = 'cd';
      el.append(key, icon, cd);
      if (ab.mana) {
        const mana = document.createElement('span');
        mana.className = 'mana';
        mana.textContent = ab.mana;
        el.appendChild(mana);
      }
      bar.appendChild(el);
      hotbarSlots.push(el);
    }
  }

  // ---- chat ----
  function renderChat() {
    const log = $('chat-log');
    const chats = state.chat;
    if (chats.length < chatRendered) { // history was trimmed from the front
      log.innerHTML = '';
      chatRendered = 0;
    }
    while (chatRendered < chats.length) {
      const c = chats[chatRendered++];
      const div = document.createElement('div');
      div.className = 'chat-line' + (c.sys ? ' sys' : '') + (c.guild ? ' guild' : '') + (c.emote ? ' emote' : '');
      if (c.sys) {
        // sys lines may carry newlines (e.g. /played): render them as breaks
        for (const part of String(c.text).split('\n')) {
          if (div.firstChild) div.appendChild(document.createElement('br'));
          div.appendChild(document.createTextNode(part));
        }
      } else if (c.emote && !c.from) {
        // emote action lines ("Name dances.") carry no speaker prefix
        div.textContent = c.text;
      } else {
        const from = document.createElement('span');
        from.className = 'from' + (c.gm ? ' gm' : '');
        from.textContent = (c.from || '?') + ': ';
        const txt = document.createElement('span');
        txt.textContent = c.text;
        div.appendChild(from);
        div.appendChild(txt);
      }
      log.appendChild(div);
    }
    while (log.children.length > 120) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // ---- castbar ----
  // Protocol doesn't pin down the clock/units of casting.endsAt/dur, so:
  // prefer endsAt when it plausibly shares the performance.now() clock,
  // otherwise anchor locally and guess dur units (<=60 => seconds).
  let castKey = null, castT0 = 0;
  function renderCastbar(now) {
    const bar = $('castbar');
    const me = state.me;
    const self = me && state.ents.get(me.id);
    const casting = self && self.casting;
    const key = casting ? `${casting.label}|${casting.endsAt}` : null;
    if (!casting) { castKey = null; bar.classList.add('hidden'); return; }
    if (key !== castKey) { castKey = key; castT0 = now; }
    const elapsed = now - castT0;
    let p = -1;
    if (typeof casting.endsAt === 'number' && casting.endsAt > now && casting.endsAt - now < 60000) {
      const total = (casting.endsAt - now) + elapsed;
      p = total > 0 ? elapsed / total : 1;
    } else if (casting.dur > 0) {
      p = elapsed / (casting.dur * (casting.dur > 60 ? 1 : 1000));
    }
    if (p < 0 || p >= 1) { castKey = null; bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('cast-label').textContent = casting.label || 'Casting';
    $('cast-fill').style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%';
  }

  // ---- toast queue ----
  function renderToast(now) {
    const el = $('err-toast');
    if (now < toastUntil) return;
    if (toastQ.length) {
      el.textContent = toastQ.shift();
      el.classList.remove('hidden');
      toastUntil = now + 2800;
    } else {
      el.classList.add('hidden');
    }
  }

  // ---- wiring (once) ----
  $('respawn-btn').addEventListener('click', () => net.respawn());
  // Clicking your own portrait frame targets yourself (F1 does the same).
  const pf = $('player-frame');
  pf.title = 'Target self (F1)';
  pf.addEventListener('click', () => {
    if (state.me) { state.targetId = state.me.id; net.target(state.me.id); }
  });
  $('settings-btn').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));
  $('char-btn').addEventListener('click', () => $('char-panel').classList.toggle('hidden'));
  $('ach-btn').addEventListener('click', () => { renderAch(true); $('ach-panel').classList.toggle('hidden'); });
  const qsel = $('set-quality');
  if (typeof world.getQuality === 'function') {
    try { qsel.value = world.getQuality(); } catch (e) { /* keep default */ }
  }
  qsel.addEventListener('change', () => world.setQuality(qsel.value));

  buildHotbar();

  // ---- achievements panel ----
  function achValue(ach, counter) {
    if (!ach) return 0;
    if (counter === 'level') return (state.me && state.me.level) || 1;
    const parts = counter.split('.');
    let v = ach.counters;
    for (const k of parts) v = v?.[k];
    return v || 0;
  }
  function renderAch(force) {
    const me = state.me;
    if (!me) return;
    const ach = me.ach || { unlocked: [], points: 0, counters: {} };
    const sig = achCat + '|' + JSON.stringify([ach.unlocked, ach.points, ach.counters, me.level]);
    if (!force && sig === achSig) return;
    achSig = sig;
    $('ach-points').textContent = `${ach.points} pts`;
    const tabs = $('ach-tabs');
    tabs.innerHTML = '';
    for (const cat of ACH_CATEGORIES) {
      const b = document.createElement('button');
      b.className = 'ach-tab' + (cat === achCat ? ' sel' : '');
      b.textContent = cat;
      b.addEventListener('click', () => { achCat = cat; renderAch(true); });
      tabs.appendChild(b);
    }
    const list = $('ach-list');
    list.innerHTML = '';
    for (const a of ACHIEVEMENTS.filter(x => x.category === achCat)) {
      const done = ach.unlocked.includes(a.id);
      const v = Math.min(achValue(ach, a.track.counter), a.track.goal);
      const row = document.createElement('div');
      row.className = 'ach-row' + (done ? ' done' : '');
      const pct = Math.round((v / a.track.goal) * 100);
      row.innerHTML =
        `<div class="ach-icon">${a.icon}</div>` +
        `<div class="ach-body"><div class="ach-name">${a.name}</div>` +
        `<div class="ach-desc">${a.desc}</div>` +
        (done ? `<div class="ach-prog">Unlocked</div>`
              : `<div class="ach-prog">${Math.floor(v)} / ${a.track.goal}</div>` +
                `<div class="ach-bar"><div style="width:${pct}%"></div></div>`) +
        `</div><div class="ach-pts">${done ? '✓ ' : ''}${a.points} pts</div>`;
      list.appendChild(row);
    }
  }
  function toggleAch() { renderAch(true); $('ach-panel').classList.toggle('hidden'); }

  // level-up flash on the XP bar
  function xpFlash() {
    const x = $('xpbar');
    x.classList.remove('flash');
    void x.offsetWidth; // restart the animation
    x.classList.add('flash');
  }

  // ---- per-frame update ----
  function update(dt) {
    const me = state.me;
    if (!me) return;
    const now = performance.now();

    // player frame
    $('pf-name').textContent = (me.gm ? '<GM> ' : '') + (me.name || '—');
    $('pf-name').style.color = me.gm ? '#ffd75e' : '';
    $('pf-level').textContent = me.level || 1;
    const cm = CLASS_MEDAL[me.cls] || CLASS_MEDAL.warrior;
    if (medalSig !== me.cls) {
      medalSig = me.cls;
      $('pf-medal').innerHTML = cm.svg + '<span class="uf-lvl" id="pf-level">' + (me.level || 1) + '</span>';
    }
    // stat mini-line tooltip on the medallion
    const cs0 = me.stats;
    if (cs0) $('pf-medal').title = `Str ${cs0.str} · Agi ${cs0.agi} · Sta ${cs0.sta} · Int ${cs0.int}`;
    const hpP = me.maxHp > 0 ? Math.max(0, me.hp / me.maxHp) : 0;
    const mpP = me.maxMp > 0 ? Math.max(0, me.mp / me.maxMp) : 0;
    $('hp-fill').style.width = (hpP * 100).toFixed(1) + '%';
    $('mp-fill').style.width = (mpP * 100).toFixed(1) + '%';
    $('hp-text').textContent = `${Math.ceil(me.hp || 0)} / ${me.maxHp || 0}`;
    $('mp-text').textContent = `${Math.ceil(me.mp || 0)} / ${me.maxMp || 0}`;

    // player buff row (durations tick down client-side between server syncs)
    const buffs = (me.buffs || []).map(b => ({ ...b, remain: Math.max(0, b.remain - dt) }));
    me.buffs = buffs;
    const bsig = buffs.map(b => b.id + ':' + Math.ceil(b.remain)).join(',');
    if (bsig !== buffSig) {
      buffSig = bsig;
      $('pf-buffs').innerHTML = buffs.filter(b => b.remain > 0)
        .map(b => `<div class="uf-buff" title="${b.name}"><span>${b.icon}</span><span class="dur">${Math.ceil(b.remain)}</span></div>`).join('');
    }

    // target frame
    const t = targetEnt();
    const tf = $('target-frame');
    const tOk = t && !t.dead && Math.hypot((t.x || 0) - me.x, (t.z || 0) - me.z) <= 60;
    if (tOk) {
      tf.classList.remove('hidden');
      $('tf-name').textContent = t.name || '—';
      $('tf-level').textContent = t.level != null ? t.level : '?';
      // target medallion: class icon for players, beast emoji for mobs
      const tKey = t.kind === 'player' ? 'p:' + (t.cls || 'warrior') : 'm:' + (t.mob || 'boar');
      if (tKey !== tfMedalSig) {
        tfMedalSig = tKey;
        const inner = t.kind === 'player'
          ? (CLASS_MEDAL[t.cls] || CLASS_MEDAL.warrior).svg
          : `<span>${MOB_MEDAL[t.mob] || '🐾'}</span>`;
        $('tf-medal').innerHTML = inner + '<span class="uf-lvl" id="tf-level">' + (t.level != null ? t.level : '?') + '</span>';
      }
      const tp = t.maxHp > 0 ? Math.max(0, t.hp / t.maxHp) : 0;
      $('tf-hp-fill').style.width = (tp * 100).toFixed(1) + '%';
      $('tf-hp-text').textContent = `${Math.ceil(t.hp || 0)} / ${t.maxHp || 0} (${Math.round(tp * 100)}%)`;
      // target debuffs (frostbolt slow; snap refreshes at 10 Hz so no local decay needed)
      const slow = t.kind !== 'player' && t.slow > 0 ? Math.ceil(t.slow) : 0;
      const dsig = slow > 0 ? 'slow:' + slow : '';
      if (dsig !== debuffSig) {
        debuffSig = dsig;
        $('tf-debuffs').innerHTML = slow > 0
          ? `<div class="uf-buff debuff" title="Slowed"><span>❄️</span><span class="dur">${slow}</span></div>` : '';
      }
    } else {
      tf.classList.add('hidden');
      tfMedalSig = '';
    }

    // hotbar cooldowns (radial sweep) + mana/range dim
    const tgt = targetEnt();
    for (const el of hotbarSlots) {
      const s = +el.dataset.slot;
      const ab = (me.abilities || []).find((a) => a.slot === s);
      const cdEl = el.querySelector('.cd');
      const remain = (cds.get(s) || 0) - now;
      if (remain > 0) {
        cdEl.style.display = 'flex';
        cdEl.textContent = remain > 9950 ? Math.ceil(remain / 1000) : (remain / 1000).toFixed(1);
        const total = (ab && ab.cd ? ab.cd * 1000 : 1);
        cdEl.style.setProperty('--cdp', Math.max(0, Math.min(100, (remain / total) * 100)).toFixed(1));
      } else {
        cdEl.style.display = 'none';
        if (cds.has(s)) cds.delete(s);
      }
      el.classList.toggle('nomana', !!ab && (me.mp || 0) < (ab.mana || 0));
      // out-of-range dimming: targeted ability whose range can't reach the target
      const oor = !!ab && !!ab.range && !!tgt && !tgt.dead &&
        Math.hypot((tgt.x || 0) - me.x, (tgt.z || 0) - me.z) > ab.range;
      el.classList.toggle('oor', oor);
      const locked = !!ab && !!ab.levelReq && (me.level || 1) < ab.levelReq;
      el.classList.toggle('locked', locked);
      if (ab) el.title = locked ? `${ab.name} — Unlocks at level ${ab.levelReq}`
        : `${ab.name}${ab.mana ? ` — ${ab.mana} mana` : ''}${ab.cd ? ` — ${ab.cd}s cd` : ''}`;
    }

    // pet frame (own tamed pet from snap)
    let petEnt = null;
    for (const e of state.ents.values()) {
      if (e.kind === 'pet' && e.ownerId === me.id) { petEnt = e; break; }
    }
    const pf = $('pet-frame');
    if (petEnt) {
      pf.classList.remove('hidden');
      $('pet-name').textContent = `${petEnt.ownerName ? petEnt.ownerName + "'s " : ''}${petEnt.name || 'Pet'}`;
      const pp = petEnt.maxHp > 0 ? Math.max(0, petEnt.hp / petEnt.maxHp) : 0;
      $('pet-hp-fill').style.width = (pp * 100).toFixed(1) + '%';
      $('pet-hp-text').textContent = petEnt.dead ? 'DEAD' : `${Math.ceil(petEnt.hp || 0)} / ${petEnt.maxHp || 0}`;
    } else {
      pf.classList.add('hidden');
    }

    // xp / coins
    const xpP = me.xpNext > 0 ? Math.max(0, Math.min(1, (me.xp || 0) / me.xpNext)) : 0;
    $('xp-fill').style.width = (xpP * 100).toFixed(1) + '%';
    $('xp-text').textContent = `Lv ${me.level || 1} · ${me.xp || 0} / ${me.xpNext || 0} XP`;
    $('coins').textContent = `🪙 ${me.coins || 0}`;

    // equipment line (settings panel)
    const g = me.gear || {};
    const gsig = ((g.weapon && g.weapon.id) || '') + '|' + ((g.armor && g.armor.id) || '');
    if (gsig !== gearSig) {
      gearSig = gsig;
      const wname = (g.weapon && g.weapon.name) || '—';
      const aname = (g.armor && g.armor.name) || '—';
      $('gear-line').textContent = `Weapon: ${wname} · Armor: ${aname}`;
    }

    // character stat sheet
    const cs = me.stats;
    const cssig = cs ? [cs.str, cs.agi, cs.sta, cs.int, cs.ap, cs.armor, cs.dodge, cs.parry, cs.crit].join('|') : '';
    if (cs && cssig !== charSig) {
      charSig = cssig;
      const pct = (f) => (f * 100).toFixed(1) + '%';
      const apName = me.cls === 'mage' ? 'Spell Power' : 'Attack Power';
      const rows = [
        ['Strength', cs.str], ['Agility', cs.agi], ['Stamina', cs.sta], ['Intellect', cs.int],
        [apName, cs.ap], ['Armor', cs.armor],
        ['Dodge', pct(cs.dodge)], ['Parry', pct(cs.parry)], ['Crit', pct(cs.crit)],
      ];
      $('char-stats').innerHTML = rows.map(([k, v]) =>
        `<div class="cs-row"><span>${k}</span><span class="cs-val">${v}</span></div>`).join('');
    }

    renderCastbar(now);
    renderChat();
    renderToast(now);
    if (!$('ach-panel').classList.contains('hidden')) renderAch(false);

    // death overlay
    $('death-overlay').classList.toggle('hidden', !me.dead);
  }

  return { update, startCooldown, clearCooldowns, toast, toggleAch, xpFlash };
}
