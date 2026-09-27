// WORLDSPIRE server: Express static + WebSocket game endpoint.
import express from 'express';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import * as store from './store.js';

const PORT = process.env.PORT || 3001;
const TICK_MS = 50; // 20 Hz authoritative tick

// Client cache-busting: package.json version is the single source of truth.
// index.html carries ?v=__APP_VERSION__ on the entry tags and the importmap
// (which version-pins every first-party module), replaced here at serve time
// so the HTML and the version can never drift. Bump package.json per release.
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const INDEX_HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const SW_JS = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

const app = express();
// Must come before express.static: the HTML is the version check, always revalidated.
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML.replaceAll('__APP_VERSION__', APP_VERSION));
});
// Service worker: version-injected so every release gets a fresh cache name
// (stale game code can never be served); never HTTP-cached so the browser
// picks up updates promptly.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('js').send(SW_JS.replaceAll('__APP_VERSION__', APP_VERSION));
});
app.use(express.static('public'));
app.get('/api/health', (req, res) => res.json({ ok: true, players: game.players.size, version: APP_VERSION }));

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
