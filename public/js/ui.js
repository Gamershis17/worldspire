// HUD logic: player/target frames, hotbar + cooldowns, castbar, chat, xp,
// coins, death overlay, settings, toasts. Reads state.js every frame via update(dt).
import { targetEnt } from './state.js';

const $ = (id) => document.getElementById(id);

export function initUI({ net, world, state }) {
  const cds = new Map();          // slot -> cooldown endsAt (performance.now ms)
  const toastQ = [];
  let toastUntil = 0;
  let chatRendered = 0;
  let hotbarSlots = [];

  function toast(msg) { if (msg) toastQ.push(String(msg)); }

  function startCooldown(slot) {
    const ab = (state.me && state.me.abilities || []).find((a) => a.slot === slot);
    const cd = ab && ab.cd ? ab.cd : 0;
    if (cd > 0) cds.set(slot, performance.now() + cd * 1000);
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
      el.title = `${ab.name}${ab.mana ? ` — ${ab.mana} mana` : ''}${ab.cd ? ` — ${ab.cd}s cd` : ''}`;
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
      div.className = 'chat-line' + (c.sys ? ' sys' : '');
      if (c.sys) {
        div.textContent = c.text;
      } else {
        const from = document.createElement('span');
        from.className = 'from';
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
  $('settings-btn').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));
  const qsel = $('set-quality');
  if (typeof world.getQuality === 'function') {
    try { qsel.value = world.getQuality(); } catch (e) { /* keep default */ }
  }
  qsel.addEventListener('change', () => world.setQuality(qsel.value));

  buildHotbar();

  // ---- per-frame update ----
  function update(dt) {
    const me = state.me;
    if (!me) return;
    const now = performance.now();

    // player frame
    $('pf-name').textContent = me.name || '—';
    $('pf-level').textContent = me.level || 1;
    const hpP = me.maxHp > 0 ? Math.max(0, me.hp / me.maxHp) : 0;
    const mpP = me.maxMp > 0 ? Math.max(0, me.mp / me.maxMp) : 0;
    $('hp-fill').style.width = (hpP * 100).toFixed(1) + '%';
    $('mp-fill').style.width = (mpP * 100).toFixed(1) + '%';
    $('hp-text').textContent = `${Math.ceil(me.hp || 0)} / ${me.maxHp || 0}`;
    $('mp-text').textContent = `${Math.ceil(me.mp || 0)} / ${me.maxMp || 0}`;

    // target frame
    const t = targetEnt();
    const tf = $('target-frame');
    const tOk = t && !t.dead && Math.hypot((t.x || 0) - me.x, (t.z || 0) - me.z) <= 60;
    if (tOk) {
      tf.classList.remove('hidden');
      $('tf-name').textContent = t.name || '—';
      $('tf-level').textContent = t.level != null ? t.level : '?';
      const tp = t.maxHp > 0 ? Math.max(0, t.hp / t.maxHp) : 0;
      $('tf-hp-fill').style.width = (tp * 100).toFixed(1) + '%';
      $('tf-hp-text').textContent = `${Math.ceil(t.hp || 0)} / ${t.maxHp || 0} (${Math.round(tp * 100)}%)`;
    } else {
      tf.classList.add('hidden');
    }

    // hotbar cooldowns + mana dim
    for (const el of hotbarSlots) {
      const s = +el.dataset.slot;
      const ab = (me.abilities || []).find((a) => a.slot === s);
      const cdEl = el.querySelector('.cd');
      const remain = (cds.get(s) || 0) - now;
      if (remain > 0) {
        cdEl.style.display = 'flex';
        cdEl.textContent = remain > 9950 ? Math.ceil(remain / 1000) : (remain / 1000).toFixed(1);
      } else {
        cdEl.style.display = 'none';
        if (cds.has(s)) cds.delete(s);
      }
      el.classList.toggle('nomana', !!ab && (me.mp || 0) < (ab.mana || 0));
    }

    // xp / coins
    const xpP = me.xpNext > 0 ? Math.max(0, Math.min(1, (me.xp || 0) / me.xpNext)) : 0;
    $('xp-fill').style.width = (xpP * 100).toFixed(1) + '%';
    $('xp-text').textContent = `Lv ${me.level || 1} · ${me.xp || 0} / ${me.xpNext || 0} XP`;
    $('coins').textContent = `🪙 ${me.coins || 0}`;

    renderCastbar(now);
    renderChat();
    renderToast(now);

    // death overlay
    $('death-overlay').classList.toggle('hidden', !me.dead);
  }

  return { update, startCooldown, toast };
}
