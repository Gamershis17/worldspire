# WORLDSPIRE (phase 1) — browser MMO RPG

A World of Warcraft-style multiplayer RPG that runs in the browser.
Phase 1: a playable online world — third-person 3D, real-time combat,
three classes, mobs, XP/levels, loot, chat, and persistent characters.

## Run it

```bash
cd ~/workspace/worldspire
npm install   # once
npm start     # serves on http://localhost:3001
```

Open `http://localhost:3001`, pick a name + class, click **Enter World**.
`npm start` = `node server/server.js`. Port via `PORT` env var.

## What's in phase 1

- **Server** (`server/`): Node + Express + `ws`. Authoritative 20 Hz tick,
  10 Hz snapshots. Movement validation (speed-hack clamp), circle colliders,
  tab/click targeting, auto-attack, 4 hotbar abilities per class with
  cooldowns/mana/cast times, mob AI (wander/aggro/leash/retaliate), an elite
  **Alpha Wolf** with enrage, XP/levels 1–10, death/respawn, global chat,
  auto-loot coins. Persistence is a JSON file (`data/players.json`) behind
  a clean seam — see `server/store.js` to swap in Postgres later.
- **Client** (`public/`): Three.js third-person 3D. WASD + mouse-orbit camera
  (click canvas for pointer lock), procedural low-poly zone (forest clearing +
  village: huts, fences, trees, well), class-tinted characters, nameplates,
  target frame, HP/mana/XP bars, hotbar, cast bar, chat box, death overlay,
  settings panel with **Low/Medium/High graphics quality** (defaults to Low).
- **Performance** (built for weak integrated GPUs): merged static geometry
  (one draw call for all scenery), `MeshLambertMaterial` only, no shadow maps,
  fog-limited draw distance, capped pixel ratio, pooled damage numbers /
  projectiles / nameplates.

## Protocol

See [PROTOCOL.md](PROTOCOL.md) for the full client↔server message spec.

## Project layout

```
server/   server.js (http+ws) · game.js (simulation) · data.js (classes/mobs/zone) · store.js (persistence seam)
public/   index.html · css/style.css
          js/state.js · js/net.js · js/merge.js      (shared client modules)
          js/world3d.js  (3D scene, characters, FX)   js/ui.js · js/boot.js (HUD, input, loop)
          js/vendor/three.module.js (r160, vendored)
data/     players.json (created at runtime)
```

## Deliberately left for phase 2

Quests, dungeons/instances, guilds/parties, PvP, trading, minimap, more zones,
talents/professions, real accounts/passwords (name = identity for now),
mobile controls, Postgres migration.
