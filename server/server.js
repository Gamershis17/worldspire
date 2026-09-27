// WORLDSPIRE server: Express static + WebSocket game endpoint.
import express from 'express';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import * as store from './store.js';

const PORT = process.env.PORT || 3001;
const TICK_MS = 50; // 20 Hz authoritative tick

const app = express();
app.use(express.static('public'));
app.get('/api/health', (req, res) => res.json({ ok: true, players: game.players.size }));

const game = new Game(store);
await game.init(); // load persisted guilds before accepting connections
const server = app.listen(PORT, () => console.log(`[worldspire] listening on :${PORT}`));

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws._pid = null;
  let loggedIn = false;
  const loginTimer = setTimeout(() => { if (!loggedIn) ws.close(); }, 10000);

  ws.on('message', async (raw) => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (!loggedIn) {
      if (d.op === 'login') {
        loggedIn = true;
        clearTimeout(loginTimer);
        const p = await game.login(ws, d.name, d.cls, d.appearance);
        if (!p) { loggedIn = false; ws.close(); }
      }
      return;
    }
    game.handle(ws, d);
  });

  ws.on('close', () => {
    clearTimeout(loginTimer);
    if (ws._pid != null) game.logout(ws._pid);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  try { game.tick(TICK_MS / 1000); } catch (e) { console.error('[tick]', e); }
}, TICK_MS);

process.on('SIGINT', () => {
  console.log('[worldspire] saving + shutdown');
  for (const p of game.players.values()) game._persist(p);
  process.exit(0);
});
