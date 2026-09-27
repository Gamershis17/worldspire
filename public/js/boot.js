// Boot: login flow, WebSocket wiring, game loop, client-side movement
// prediction + reconciliation, keyboard/chat input.
import { state } from './state.js';
import { net } from './net.js';
import { initUI } from './ui.js';

// world3d is written by a second agent; import defensively so a missing or
// broken world3d.js never breaks the login screen or the ws handshake.
let initWorld = null, APPEARANCE_UI = null, createPreview = null;
try {
  ({ initWorld, APPEARANCE_UI, createPreview } = await import('./world3d.js'));
} catch (e) {
  console.error('[boot] world3d failed to load:', e);
}

const $ = (id) => document.getElementById(id);
const canvas = $('game');

let world = null;
let ui = null;
let selectedCls = 'warrior';
let autoOn = false;
// character-creation appearance (indices into APPEARANCE_UI palettes)
let appearance = { skin: 1, face: 0, hairStyle: 1, hairColor: 1 };
let preview = null;
const keys = {};
let lastMoveSent = 0;
let lastDir = { x: 0, z: 0 };
let pingTimer = null;

const loginVisible = () => !$('login').classList.contains('hidden');
const isTyping = () => {
  const a = document.activeElement;
  return a === $('chat-input') || a === $('login-name');
};

// ---------- login UI ----------
document.querySelectorAll('.class-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.class-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedCls = card.dataset.cls;
    refreshPreview();
  });
});

// ---------- appearance customization ----------
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
function refreshPreview() {
  if (preview) { try { preview.set(selectedCls, appearance); } catch (e) { /* never break login */ } }
}
function markSelected(el, idx) {
  el.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('selected', +b.dataset.i === idx));
}
function buildAppearanceUI() {
  if (!APPEARANCE_UI || !createPreview) return; // 3D unavailable: skip appearance UI
  const AP = APPEARANCE_UI;
  const skinsEl = $('ap-skins'), hairEl = $('ap-haircolors');
  AP.skins.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.i = i;
    b.title = AP.skinNames[i]; b.style.background = hex(c);
    b.setAttribute('aria-label', 'Skin: ' + AP.skinNames[i]);
    b.addEventListener('click', () => { appearance.skin = i; markSelected(skinsEl, i); refreshPreview(); });
    skinsEl.appendChild(b);
  });
  AP.hairColors.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.i = i;
    b.title = AP.hairColorNames[i]; b.style.background = hex(c);
    b.setAttribute('aria-label', 'Hair color: ' + AP.hairColorNames[i]);
    b.addEventListener('click', () => { appearance.hairColor = i; markSelected(hairEl, i); refreshPreview(); });
    hairEl.appendChild(b);
  });
  const facesEl = $('ap-faces'), hairsEl = $('ap-hairs');
  AP.faceNames.forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ap-btn'; b.dataset.i = i; b.textContent = n;
    b.addEventListener('click', () => { appearance.face = i; markSelected(facesEl, i); refreshPreview(); });
    facesEl.appendChild(b);
  });
  AP.hairStyleNames.forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ap-btn'; b.dataset.i = i; b.textContent = n;
    b.addEventListener('click', () => { appearance.hairStyle = i; markSelected(hairsEl, i); refreshPreview(); });
    hairsEl.appendChild(b);
  });
  const rnd = (n) => Math.floor(Math.random() * n);
  $('ap-random').addEventListener('click', () => {
    appearance = {
      skin: rnd(AP.skins.length), face: rnd(AP.faceNames.length),
      hairStyle: rnd(AP.hairStyleNames.length), hairColor: rnd(AP.hairColors.length),
    };
    markSelected(skinsEl, appearance.skin); markSelected(hairEl, appearance.hairColor);
    markSelected(facesEl, appearance.face); markSelected(hairsEl, appearance.hairStyle);
    refreshPreview();
  });
  markSelected(skinsEl, appearance.skin); markSelected(hairEl, appearance.hairColor);
  markSelected(facesEl, appearance.face); markSelected(hairsEl, appearance.hairStyle);
  try {
    preview = createPreview($('char-preview'));
    refreshPreview();
  } catch (e) {
    console.error('[boot] preview failed:', e);
    preview = null;
  }
}
buildAppearanceUI();

function tryLogin() {
  const name = $('login-name').value.trim();
  if (!/^[A-Za-z0-9]{2,16}$/.test(name)) {
    $('login-err').textContent = 'Name must be 2–16 letters or numbers.';
    return;
  }
  if (!state.connected) {
    $('login-err').textContent = 'Not connected to the server yet — one moment…';
    return;
  }
  $('login-err').textContent = '';
  net.login(name, selectedCls, appearance);
}
$('login-btn').addEventListener('click', tryLogin);
$('login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

// ---------- net wiring ----------
// WS endpoint: ?ws= override, else same-host, else localhost dev fallback
// (file:// testing has no host). Scheme follows the page protocol so the
// HTTPS live site uses wss:// (browsers block ws:// as mixed content).
const _wsParam = new URLSearchParams(location.search).get('ws');
const _wsScheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
const WS_URL = _wsParam || (location.host ? _wsScheme + location.host + '/ws' : 'ws://localhost:3001/ws');
net.connect(WS_URL).catch(() => {
  $('login-err').textContent = 'Could not reach the game server. Is it running?';
});

net.onHello = (me) => {
  $('login').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (preview) { try { preview.dispose(); } catch (e) {} preview = null; }
  if (initWorld) {
    try {
      world = initWorld(canvas, net);
    } catch (e) {
      console.error('[boot] initWorld threw:', e);
      world = null;
    }
  }
  ui = initUI({ net, world: world || fallbackWorld(), state });
  if (!initWorld) ui.toast('3D world unavailable — HUD only.');
  autoOn = true;
  net.auto(true);
  syncAutoBtn();
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => net.ping(), 20000);
  requestAnimationFrame(loop);
};

// Minimal stand-in so ui.js never touches an undefined world before the real
// renderer exists (e.g. world3d still being written by the second agent).
function fallbackWorld() {
  return {
    setQuality() {},
    getCameraYaw() { return 0; },
    cycleTarget() {},
    fx: { damage() {}, projectile() {}, die() {}, levelUp() {} },
  };
}

net.onEvent = (ev) => {
  if (!world && !ui) return;
  const fx = world ? world.fx : null;
  switch (ev.ev) {
    case 'dmg': if (fx) fx.damage(ev.dst, ev.amount, ev.crit, ev.label, ev.src, ev.roll); break;
    case 'proj': if (fx) fx.projectile(ev.src, ev.dst, ev.kind); break;
    case 'die': if (fx) fx.die(ev.id); break;
    case 'lvlup':
      if (fx) fx.levelUp();
      if (ui) { ui.toast(`Level ${ev.level}! Power grows.`); ui.xpFlash(); }
      break;
    case 'kill':
      if (ui) ui.toast(`+${ev.xp || 0} XP · +${ev.coins || 0} 🪙`);
      break;
    case 'buff': if (ui) ui.toast(ev.label || 'Buff'); break;
    case 'respawn': if (ui) ui.toast('Respawned at the village.'); break;
    case 'leash': break; // cosmetic-only, no toast spam
    case 'ach':
      if (ui) ui.toast(`🏆 Achievement Earned: ${ev.name} (+${ev.points} pts)`);
      break; // system chat line arrives separately from the server
    case 'cdclear':
      if (ui) ui.clearCooldowns();
      break;
    default: break; // chat is applied to state by net.js; ui polls it
  }
};

net.onErr = (msg) => {
  if (ui) ui.toast(msg);
  else $('login-err').textContent = msg;
};

// ---------- auto-attack toggle ----------
function syncAutoBtn() {
  const b = $('auto-btn');
  b.classList.toggle('off', !autoOn);
  b.title = 'Auto-attack ' + (autoOn ? 'ON' : 'OFF');
}
$('auto-btn').addEventListener('click', () => {
  autoOn = !autoOn;
  net.auto(autoOn);
  syncAutoBtn();
});

// ---------- keyboard input ----------
const SLOT_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 };

window.addEventListener('keydown', (e) => {
  // Tab targeting is bound inside world3d (it skips form fields); don't double-bind here.
  if (e.key === 'Tab') return;
  if (e.key === 'Enter') {
    if (loginVisible()) return; // login-name input owns its own Enter
    const ci = $('chat-input');
    if (document.activeElement === ci) {
      const t = ci.value.trim();
      if (t) net.chat(t.slice(0, 140));
      ci.value = '';
      ci.blur();
    } else if (state.me) {
      ci.focus();
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    $('settings-panel').classList.add('hidden');
    if (document.activeElement === $('chat-input')) $('chat-input').blur();
    return;
  }
  if (loginVisible() || isTyping() || !state.me) return;
  keys[e.code] = true;
  if (e.code === 'Space' && state.me.fly) e.preventDefault(); // fly: don't scroll the page
  if (e.code === 'KeyY' && ui) { ui.toggleAch(); return; } // achievements panel
  const slot = SLOT_KEYS[e.code];
  if (slot && !state.me.dead && ui) {
    const ab = (state.me.abilities || []).find((a) => a.slot === slot);
    // Level-locked abilities (e.g. Tame Beast) stay greyed until unlocked; server enforces too.
    if (ab && ab.levelReq && (state.me.level || 1) < ab.levelReq) {
      ui.toast(`${ab.name} unlocks at level ${ab.levelReq}.`);
      return;
    }
    net.cast(slot);
    // Optimistic cooldown; skip it when we know mana is short (server will err → toast).
    if (!ab || (state.me.mp || 0) >= (ab.mana || 0)) ui.startCooldown(slot);
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------- movement: prediction + reconciliation ----------
function stepMovement(dt) {
  const me = state.me;
  let ix = 0, iz = 0;
  const canMove = !me.dead && !loginVisible() && !isTyping();
  if (canMove) {
    if (keys.KeyW || keys.ArrowUp) iz -= 1;
    if (keys.KeyS || keys.ArrowDown) iz += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
  }

  // Wish dir in camera space: forward = -Z rotated by camera yaw.
  const yaw = world.getCameraYaw();
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // camera forward
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);  // camera right
  let wx = rx * ix + fx * -iz;
  let wz = rz * ix + fz * -iz;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx /= len; wz /= len; }

  // PREDICTION: integrate locally.
  const sp = me.speed || 6;
  let nx = me.x + wx * sp * dt;
  let nz = me.z + wz * sp * dt;

  // Resolve against static colliders (circles mirrored from hello.layout).
  const cols = me.colliders || [];
  for (const c of cols) {
    const dx = nx - c.x, dz = nz - c.z;
    const d = Math.hypot(dx, dz);
    const min = (c.r || 0.5) + 0.4; // collider radius + player radius
    if (d < min) {
      if (d > 1e-6) { nx = c.x + (dx / d) * min; nz = c.z + (dz / d) * min; }
      else { nx = c.x + min; }
    }
  }
  nx = Math.max(-58, Math.min(58, nx));
  nz = Math.max(-58, Math.min(58, nz));
  me.x = nx; me.z = nz;
  me.heading = yaw; // WoW-style: character faces the camera direction

  // Free-flight (GM): Space ascends, C descends. Server clamps/validates.
  let iy = 0;
  if (canMove && me.fly) {
    if (keys.Space) iy += 1;
    if (keys.KeyC) iy -= 1;
  }
  const ny = Math.max(0, Math.min(30, (me.y || 0) + iy * 8 * dt));
  const yChanged = Math.abs(ny - (me.y || 0)) > 1e-4;
  me.y = ny;

  // Send at 10 Hz while moving, or immediately on direction change (incl. stop).
  const now = performance.now();
  const changed = wx !== lastDir.x || wz !== lastDir.z || yChanged;
  if (changed || (len > 0 && now - lastMoveSent >= 100)) {
    net.move(+wx.toFixed(3), +wz.toFixed(3), +yaw.toFixed(3), +me.y.toFixed(2));
    lastMoveSent = now;
    lastDir = { x: wx, z: wz };
  }

  // RECONCILIATION: the server is authoritative, but snapshots arrive ~1 RTT
  // stale, so while actively steering we trust our prediction (client speed is
  // synced from the server) instead of hard-snapping to old data — otherwise
  // normal latency looks like constant rubber-banding. Genuine divergence
  // (teleport, respawn, summon) still hard-corrects; small drift eases out.
  const snap = state.ents.get(me.id);
  if (snap) {
    const dx = snap.x - me.x, dz = snap.z - me.z;
    const drift = Math.hypot(dx, dz);
    if (drift > 6) { me.x = snap.x; me.z = snap.z; } // teleport / respawn / summon
    else if (len === 0 && drift > 1.5) { me.x = snap.x; me.z = snap.z; } // drifted while idle
    else if (drift > 0.02) { const k = Math.min(1, dt * 6); me.x += dx * k; me.z += dz * k; } // ease latency offset
    if (Math.abs((snap.y || 0) - me.y) > 2) me.y = snap.y || 0;
  }
}

// ---------- main loop ----------
let lastT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(Math.max((t - lastT) / 1000 || 0, 0), 0.1);
  lastT = t;
  if (!world || !state.me || !ui) return;
  stepMovement(dt);
  try { world.render(dt); } catch (e) { console.error('[boot] render threw:', e); }
  ui.update(dt);
}

// Validation hook (harmless in production): lets headless tests drive the client.
window.WS_DEBUG = { state, net, get world() { return world; }, get ui() { return ui; }, wsUrl: WS_URL };
