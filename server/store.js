// Persistence seam. Two backends, one API.
//
// - If DATABASE_URL is set: Postgres via a single shared pg.Pool. Tables
//   are created automatically on first use and the complete record shape is
//   stored in a JSONB `data` column, keyed by lowercased player name /
//   guild id. Writes use INSERT ... ON CONFLICT ... DO UPDATE.
// - Otherwise: the original JSON-file store (data/players.json,
//   data/guilds.json). This is EPHEMERAL on hosts with a non-persistent
//   filesystem (e.g. Render free tier) — the server logs a loud warning
//   at boot.
//
// game.js only calls loadPlayer(name), savePlayer(record), loadGuilds()
// and saveGuilds(arr) — the storage format is an internal detail.
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- backend selection ----------
const usePg = !!process.env.DATABASE_URL;

if (usePg) {
  console.log('[store] Postgres persistence enabled (DATABASE_URL set)');
} else {
  console.warn('[store] no DATABASE_URL — persistence is EPHEMERAL (wiped on deploy/restart)');
}

// ---------- Postgres backend ----------
let pool = null;      // pg.Pool, once initialized
let poolReady = null; // in-flight init promise (also creates tables)

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players(
  name TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guilds(
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);`;

async function getPool() {
  if (pool) return pool;
  if (!poolReady) {
    poolReady = (async () => {
      // Dynamic import: the JSON fallback must keep working even when the
      // `pg` dependency is not installed.
      const { Pool } = await import('pg');
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }, // Neon / managed Postgres
        max: 5,
      });
      pool.on('error', (e) => console.error('[store] pg pool error:', e.message));
      await pool.query(SCHEMA_SQL);
      console.log('[store] pg tables ready (players, guilds)');
      return pool;
    })().catch((e) => {
      poolReady = null; // don't cache the failure; allow a later retry
      console.error('[store] pg init failed:', e.message);
      throw e;
    });
  }
  return poolReady;
}

// Player keys are case-insensitive, matching the JSON backend.
const pkey = (name) => String(name).toLowerCase();

async function pgLoadPlayer(name) {
  const p = await getPool();
  const { rows } = await p.query('SELECT data FROM players WHERE name = $1', [pkey(name)]);
  return rows.length ? rows[0].data : null;
}

async function pgSavePlayer(rec) {
  const p = await getPool();
  await p.query(
    `INSERT INTO players (name, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (name) DO UPDATE
       SET data = EXCLUDED.data, updated_at = now()`,
    [pkey(rec.name), JSON.stringify({ ...rec })]
  );
}

async function pgLoadGuilds() {
  const p = await getPool();
  const { rows } = await p.query('SELECT data FROM guilds');
  return rows.map((r) => r.data);
}

async function pgSaveGuilds(arr) {
  // saveGuilds replaces the whole collection, so mirror that in one txn.
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM guilds');
    for (const g of arr) {
      await client.query(
        'INSERT INTO guilds (id, data, updated_at) VALUES ($1, $2::jsonb, now())',
        [String(g.id), JSON.stringify({ ...g })]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// ---------- JSON-file backend (EPHEMERAL without a persistent disk) ----------
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

// ---- guilds ----
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

async function jsonLoadGuilds() {
  const all = await readGuilds();
  return [...all.values()];
}

async function jsonSaveGuilds(arr) {
  const all = await readGuilds();
  guildCache = new Map();
  for (const g of arr) guildCache.set(g.id, { ...g });
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(GUILD_FILE, JSON.stringify([...guildCache.values()], null, 1));
  } catch (e) { console.error('[store] guild write error:', e.message); }
}

// ---------- public API (unchanged signatures) ----------

// Returns the stored record or null.
// Record: {name, cls, level, xp, coins, x, z, gm, gear:{weapon,armor}, speedMult, ...}
export async function loadPlayer(name) {
  if (usePg) return pgLoadPlayer(name);
  const all = await readAll();
  return all.get(String(name).toLowerCase()) || null;
}

export async function savePlayer(rec) {
  if (usePg) return pgSavePlayer(rec);
  const all = await readAll();
  all.set(String(rec.name).toLowerCase(), { ...rec });
  await flush();
}

// Guild: {id, name, leader, members:[names], createdAt}
export async function loadGuilds() {
  return usePg ? pgLoadGuilds() : jsonLoadGuilds();
}

export async function saveGuilds(arr) {
  return usePg ? pgSaveGuilds(arr) : jsonSaveGuilds(arr);
}
