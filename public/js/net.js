// WebSocket layer. Owns the socket, applies server messages to state.js,
// exposes send helpers. Event hook: net.onEvent(ev) set by UI/world.
import { state, upsertEnt, markSweep, pushChat } from './state.js';

export const net = {
  ws: null,
  onEvent: null,   // (ev) => void — dmg/die/kill/lvlup/cast/proj/buff/respawn/leash
  onHello: null,   // (me) => void
  onStats: null,   // () => void (state.me already updated)
  onErr: null,

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { state.connected = true; resolve(); };
      ws.onerror = () => reject(new Error('ws error'));
      ws.onclose = () => { state.connected = false; };
      ws.onmessage = (m) => {
        let d; try { d = JSON.parse(m.data); } catch (e) { return; }
        this._handle(d);
      };
    });
  },

  _handle(d) {
    const now = performance.now();
    switch (d.op) {
      case 'hello': {
        state.me = { ...d };
        delete state.me.op;
        if (this.onHello) this.onHello(state.me);
        break;
      }
      case 'stats': {
        if (state.me) Object.assign(state.me, d);
        if (this.onStats) this.onStats();
        break;
      }
      case 'snap': {
        const ids = new Set();
        for (const e of d.ents) { ids.add(e.id); upsertEnt(e, now); }
        markSweep(ids, now);
        break;
      }
      case 'ev': {
        if (d.ev === 'chat') pushChat(d.from, d.text, d.sys, d.gm, d.guild, d.emote);
        if (this.onEvent) this.onEvent(d);
        break;
      }
      case 'pong': break;
      case 'err': if (this.onErr) this.onErr(d.msg); break;
    }
  },

  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
  login(name, cls, appearance) { this.send({ op: 'login', name, cls, appearance }); },
  move(mx, mz, heading, y) { this.send({ op: 'move', mx, mz, heading, y }); },
  target(id) { this.send({ op: 'target', id }); },
  auto(on) { this.send({ op: 'auto', on }); },
  cast(slot) { this.send({ op: 'cast', slot }); },
  chat(text) { this.send({ op: 'chat', text }); },
  respawn() { this.send({ op: 'respawn' }); },
  ping() { this.send({ op: 'ping', t: Date.now() }); },
};
