// Boot: login flow, WebSocket wiring, game loop, client-side movement
// prediction + reconciliation, keyboard/chat input.
import { state } from './state.js';
import { net } from './net.js';
import { initUI } from './ui.js';

// world3d is written by a second agent; import defensively so a missing or
// broken world3d.js never breaks the login screen or the ws handshake.
let initWorld = null;
try {
  ({ initWorld } = await import('./world3d.js'));
} catch (e) {
  console.error('[boot] world3d failed to load:', e);
}

const $ = (id) => document.getElementById(id);
const canvas = $('game');

let world = null;
let ui = null;
let selectedCls = 'warrior';
let autoOn = false;
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
  });
});

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
  net.login(name, selectedCls);
}
$('login-btn').addEventListener('click', tryLogin);
$('login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

// ---------- net wiring ----------
// WS endpoint: ?ws= override, else same-host, else localhost dev fallback
// (file:// testing has no host).
const _wsParam = new URLSearchParams(location.search).get('ws');
const WS_URL = _wsParam || (location.host ? 'ws://' + location.host + '/ws' : 'ws://localhost:3001/ws');
net.connect(WS_URL).catch(() => {
  $('login-err').textContent = 'Could not reach the game server. Is it running?';
});

net.onHello = (me) => {
  $('login').classList.add('hidden');
  $('hud').classList.remove('hidden');
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
    case 'dmg': if (fx) fx.damage(ev.dst, ev.amount, ev.crit, ev.label, ev.src); break;
    case 'proj': if (fx) fx.projectile(ev.src, ev.dst, ev.kind); break;
    case 'die': if (fx) fx.die(ev.id); break;
    case 'lvlup':
      if (fx) fx.levelUp();
      if (ui) ui.toast(`Level ${ev.level}! Power grows.`);
      break;
    case 'kill':
      if (ui) ui.toast(`+${ev.xp || 0} XP · +${ev.coins || 0} 🪙`);
      break;
    case 'buff': if (ui) ui.toast(ev.label || 'Buff'); break;
    case 'respawn': if (ui) ui.toast('Respawned at the village.'); break;
    case 'leash': break; // cosmetic-only, no toast spam
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
  const slot = SLOT_KEYS[e.code];
  if (slot && !state.me.dead && ui) {
    net.cast(slot);
    const ab = (state.me.abilities || []).find((a) => a.slot === slot);
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

  // Send at 10 Hz while moving, or immediately on direction change (incl. stop).
  const now = performance.now();
  const changed = wx !== lastDir.x || wz !== lastDir.z;
  if (changed || (len > 0 && now - lastMoveSent >= 100)) {
    net.move(+wx.toFixed(3), +wz.toFixed(3), +yaw.toFixed(3));
    lastMoveSent = now;
    lastDir = { x: wx, z: wz };
  }

  // RECONCILIATION: the server is authoritative — snap back on big drift.
  const snap = state.ents.get(me.id);
  if (snap) {
    const drift = Math.hypot(snap.x - me.x, snap.z - me.z);
    if (drift > 1.5) { me.x = snap.x; me.z = snap.z; }
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
window.WS_DEBUG = { state, net, get world() { return world; }, get ui() { return ui; } };
