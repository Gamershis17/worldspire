// Persistence seam. JSON file store for phase 1.
//
// To move to Postgres later: replace loadPlayer/savePlayer with queries
// against a `players` table (name PK, cls, level, xp, coins, x, z).
// game.js only calls loadPlayer(name) and savePlayer(record) — nothing else
// in the codebase touches the storage format.
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = fileURLToPath(new URL('../data', import.meta.url));
const FILE = path.join(dir, 'players.json');

let cache = null; // Map<lowerName, record>

async function readAll() {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const arr = JSON.parse(raw);
    for (const r of arr) cache.set(String(r.name).toLowerCase(), r);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] read error:', e.message);
  }
  return cache;
}

async function flush() {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify([...cache.values()], null, 1));
  } catch (e) { console.error('[store] write error:', e.message); }
}

// Returns the stored record or null.
// Record: {name, cls, level, xp, coins, x, z, gm, gear:{weapon,armor}, speedMult}
export async function loadPlayer(name) {
  const all = await readAll();
  return all.get(String(name).toLowerCase()) || null;
}

export async function savePlayer(rec) {
  const all = await readAll();
  all.set(String(rec.name).toLowerCase(), { ...rec });
  await flush();
}

// ---- guilds ----
// Guild: {id, name, leader, members:[names], createdAt}
const GUILD_FILE = path.join(dir, 'guilds.json');
let guildCache = null; // Map<id, guild>

async function readGuilds() {
  if (guildCache) return guildCache;
  guildCache = new Map();
  try {
    const raw = await fs.readFile(GUILD_FILE, 'utf8');
    for (const g of JSON.parse(raw)) guildCache.set(g.id, g);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] guild read error:', e.message);
  }
  return guildCache;
}

export async function loadGuilds() {
  const all = await readGuilds();
  return [...all.values()];
}

export async function saveGuilds(arr) {
  const all = await readGuilds();
  guildCache = new Map();
  for (const g of arr) guildCache.set(g.id, { ...g });
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(GUILD_FILE, JSON.stringify([...guildCache.values()], null, 1));
  } catch (e) { console.error('[store] guild write error:', e.message); }
}
