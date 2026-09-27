# WORLDSPIRE — Network Protocol (Phase 1)

Authoritative server, 20 Hz tick (`TICK=50ms`). Snapshots broadcast at 10 Hz.
All JSON over a single WebSocket at `ws://host:PORT/ws` (default port 3001).

## Client → Server

| op | fields | notes |
|---|---|---|
| `login` | `name` (2–16 alnum), `cls` (`warrior`\|`mage`\|`ranger`) | First message. Server loads or creates the character. |
| `move` | `mx`, `mz` (-1..1), `heading` (radians) | Send at 10 Hz and on change. Server clamps `\|m\|≤1`, integrates at class speed. |
| `target` | `id` (entity id or `null`) | Select target. |
| `auto` | `on` (bool) | Toggle auto-attack. |
| `cast` | `slot` (1–4) | Cast hotbar ability. Server validates range/mana/cooldown/target. |
| `chat` | `text` (≤140 chars) | Global say. If `text` starts with `/` it is a command — see GM commands below. |
| `respawn` | — | Respawn at village after death (also auto after 8 s). |
| `ping` | `t` | Server replies `pong`. |

## Server → Client

- `hello` — `{op:'hello', id, name, cls, level, xp, xpNext, coins, x, z, hp, maxHp, mp, maxMp, speed, gm, god, gear:{weapon:{id,name}|null, armor:{id,name}|null}, guild, pet, stats:{str,agi,sta,int,ap,armor,dodge,parry,crit}, abilities:[{slot,name,icon,mana,cd,castTime,range}], colliders:[{x,z,r}], layout:{spawn:{x,z}, huts:[{x,z,ry}], trees:[{x,z,s}], well:{x,z}, fences:[{x1,z1,x2,z2}], rocks:[{x,z,s}]}}` — full character state on login. `layout` drives BOTH the 3D scenery and is the source of the `colliders` (client mirrors them for movement prediction). `gm` is true only for the owner (server-side check, never from the client). `gear` names drive the client equipment display; golden items give the wearer a gold nameplate. `guild` is the player's guild name (or null). `stats` is the character stat sheet (fractions for dodge/parry/crit).
- `stats` — `{op:'stats', hp, maxHp, mp, maxMp, xp, xpNext, level, coins, dead, speed, god, gear, guild, stats}` — whenever these change.
- `snap` — `{op:'snap', t, ents:[ent...]}` at 10 Hz. Entity:
  `{id, kind:'player'|'mob', name, cls?, mob?, elite?, level, x, z, heading, hp, maxHp, moving, dead, gm?, guild?, casting?:{label, endsAt, dur}, targetId?}`
  `mob` is `boar`|`wolf`|`alpha`. `gm` (players only) marks Game Masters — clients render `<GM>Name` in gold. `guild` (players only) is the guild name — clients render it under the nameplate. The client never extrapolates the local player from `snap` (it predicts); `snap` still contains self for reconciliation.
- `ev` — `{op:'ev', ev:'dmg', src, dst, amount, crit, roll, label?}` damage numbers.
  `roll` is `'dodge'|'parry'|'crit'|'hit'` — clients render DODGED / PARRIED / CRIT distinctly.
  `{op:'ev', ev:'die', id, by?}` · `{op:'ev', ev:'kill', mob, xp, coins}` (to killer)
  `{op:'ev', ev:'lvlup', level}` · `{op:'ev', ev:'chat', from, text, sys?, gm?, guild?}`
  (`gm` marks a Game Master sender — clients color the name gold; `guild`
  marks guild chat — clients render it green and only members receive it)
  `{op:'ev', ev:'cast', src, slot, label, dur, endsAt}` · `{op:'ev', ev:'proj', src, dst, kind}` (cosmetic projectile)
  `{op:'ev', ev:'buff', id, label, dur}` · `{op:'ev', ev:'respawn', id, x, z}`
  `{op:'ev', ev:'leash', id}` (mob returned home)
- `err` — `{op:'err', msg}`

## Combat rules (server-enforced)

- Auto-attack: requires target, range (melee 4 m, ranged 26 m), class swing timer.
  Damage = weapon attack + attackPower × 0.45. Kind: warrior melee, ranger ranged, mage spell.
- Abilities per class (slot: name — mana, cooldown, range, effect; damage = base + weapon + AP×k):
  - Warrior: 1 Strike — 8, 0 s, 4 m, melee, 4+AP×0.6 · 2 Charge — 0, 15 s, 25 m, dash + 2+AP×0.4 melee · 3 Shield Block — 0, 20 s, self, −50 % dmg taken 6 s · 4 Whirlwind — 15, 8 s, 6 m AoE melee, 3+AP×0.45
  - Mage: 1 Fireball — 15, 0 s, 28 m, 1.5 s cast, spell, 6+SP×0.8 · 2 Frostbolt — 10, 0 s, 28 m, 1.2 s cast, spell, 4+SP×0.5 + slow 4 s · 3 Blink — 0, 15 s, self, teleport 12 m forward · 4 Arcane Explosion — 25, 10 s, 8 m AoE spell, 5+SP×0.6
  - Ranger: 1 Steady Shot — 12, 0 s, 28 m, 1.0 s cast, ranged, 5+AP×0.7 · 2 Multi-Shot — 18, 6 s, 28 m, ranged, 4+AP×0.5 to ≤3 targets · 3 Disengage — 0, 18 s, self, leap 10 m backward · 4 Volley — 22, 12 s, 28 m, ranged, 5+AP×0.6 AoE 6 m at target · 5 Tame Beast / 6 Revive Pet (see Hunter pets)
- Combat rolls (every hit, in order): dodge → no damage ("DODGED"); parry (melee only) → damage halved ("PARRIED"); crit → ×2 damage. Outcome sent as `roll` in the dmg ev.
- Armor mitigation (physical only): `armor / (armor + 40 × attackerLevel)`, cap 75 %. Armor = class base + gear armor. Mobs have armor too (boar 5, wolf 10, alpha 30).
- Mana regen 4/s (8/s out of combat). HP regen 2 %/s out of combat (5 s).
- XP: boar 25, wolf 40, alpha 200. `xpNext(level) = 100 * level`. Cap level 10.
- Death: 8 s corpse, respawn at village (0, 8) full HP/MP. No XP loss in phase 1.
- Mobs: boar passive (retaliates), wolf aggressive (aggro 12 m, leash 30 m), alpha elite (aggro 14 m, enrage <30 % HP: +50 % dmg & speed), respawn 20 s (alpha 120 s). Mob damage = dmg range + str×0.2. Auto-loot coins to killer.

## Primary stats

- Per class in `server/data.js`: base `{str, agi, sta, int}` + per-level `growth`.
  Warrior 18/10/16/6 (+3/+1/+4/+1), Ranger 10/18/12/8 (+1/+3/+2/+1), Mage 6/10/10/18 (+1/+1/+2/+4).
  Mobs have simple str/sta (+ armor + level).
- Derived (recalculated on level/gear change):
  - Attack Power = 1.5 × primary stat (warriors str, rangers agi, mages int = spell power)
  - Max HP = 20 + sta × 6 (+ gear maxHp); Max MP = 10 + int × 5
  - Dodge = 5 % + 25 % × (1 − e^(−agi/60)), cap 30 %
  - Parry = warrior 10 % + 20 % × (1 − e^(−str/60)) (cap 35 %), others 3 %; melee only
  - Crit = 5 % + (agi + int) × 0.15 %, cap 40 %
- Level-up: applies the growth table, recalculates derived stats, keeps current
  HP/MP ratios (no full heal). `/level` (GM) recomputes stats from the level table and fully restores.
- `hello`/`stats` carry the `stats` sheet; the client character panel (👤) shows
  Strength / Agility / Stamina / Intellect / Attack (or Spell) Power / Armor /
  Dodge % / Parry % / Crit %.

## GM commands

Game Master status is granted **server-side only**: on login, a character whose
name case-insensitively equals `gamershis17` gets `gm: true` (persisted in
`players.json`). The client never sends or decides this.

Commands are typed in chat with a `/` prefix. Replies are system chat messages
visible only to the GM.

- Non-GM players: `/help` → "No commands available."; any other `/cmd` →
  "Unknown command." (GM commands are never revealed to non-GMs.)
- GM commands:
  - `/help` — list GM commands
  - `/give gold <n>` — add `n` coins (clamped 1–1,000,000 per command)
  - `/give gear` — equip the GM set: GM Greatblade (weapon, +500 attack),
    GM Aegis Plate (armor, +2000 max HP)
  - `/level <n>` — set level 1–10, reset XP, full HP/MP restore
  - `/heal` — restore full HP/MP
  - `/god` — toggle godmode (take no damage); session-only, not persisted
  - `/spawn <boar|wolf|alpha> [n]` — spawn up to 10 mobs near the player
  - `/tp <x> <z>` | `/tp spawn` — teleport (clamped to map bounds)
  - `/speed <mult>` — movement speed multiplier 0.5–3 (persisted)
  - `/killmobs` — kill all active mobs (no loot/XP; cleanup/testing)

## Guilds

Guilds persist in `data/guilds.json`: `{id, name, leader, members:[names], createdAt}`.
Players carry `guildId` (persisted in `players.json`); `hello`/`stats`/`snap`
expose the resolved guild `name`. Commands are available to all players:

- `/gcreate <name>` — 2–24 chars (letters/numbers/spaces), unique; creator becomes leader
- `/ginvite <player>` — invite an online player (60 s expiry); accept `/gaccept`, decline `/gdecline`
- `/gleave` — leave; leadership passes to the oldest remaining member, last member disbands
- `/gkick <player>` — leader only
- `/g <message>` — guild chat (green, members only)

## Hunter pets (Ranger, level 10)

Rangers gain `Tame Beast` (hotbar slot 5, `levelReq: 10` — client shows it
locked/greyed with an "Unlocks at level 10" tooltip before 10; server rejects
the cast below 10) and `Revive Pet` (slot 6). Pets are session-only.

- `Tame Beast`: 3 s channel, 20 m range, target must be a living boar or wolf
  (never the alpha elite). On completion the wild mob is removed and becomes
  the ranger's pet (one per ranger; a new tame releases the old one).
- Pet stats: tamed mob's base HP/damage, +10% per ranger level
  (`maxHp = base × (1 + 0.1 × (level − 1))`, same for swing damage; swing 2 s, range 2.4 m).
- Pet AI: follows ~2.5 m behind the owner, assists by auto-attacking the owner's
  current mob target; `/petfollow` toggles follow/stay.
- Mobs aggro pets like players; pets take damage and can die
  (`_killPet` → owner sees "Your pet has died").
- Pet kills credit the owner for XP/loot.
- Revive: `Revive Pet` (5 s cast, 30 mana, ranger only, must be out of combat)
  or automatic when the ranger respawns. Dead pets show in `snap` with `dead: true`.
- `hello` carries `pet: {id, mob, name, hp, maxHp, dead, follow} | null`;
  `snap` carries pet entities `kind: 'pet'` with `ownerId`/`ownerName`
  (client renders the boar/wolf model with a golden tint, nameplate
  `"<Owner>'s Pet"`, plus a pet HP frame next to the player frame).

## Items (phase 1 — minimal equipment)

`server/data.js` `ITEMS`: slots `weapon` / `armor`.

| id | name | slot | bonus |
|---|---|---|---|
| `gm_greatblade` | GM Greatblade | weapon | +500 attack (golden) |
| `gm_aegis` | GM Aegis Plate | armor | +2000 max HP (golden) |
| `worn_sword` | Worn Sword | weapon | +3 attack |
| `cloth_vest` | Cloth Vest | armor | +25 max HP |

Attack adds flat damage to auto-attacks and all abilities. Equipping armor heals
the gained max-HP difference. Gear persists per character (`gear:{weapon,armor}`
in `players.json`); `hello`/`stats` carry `gear` (ids + names) for the client
equipment display. No drop sources yet — phase 2 hooks loot in.

## Movement

- Speed: warrior 6, mage 5.6, ranger 6.2 m/s (mob: boar 3, wolf 5.5, alpha 6).
- Static colliders (server): village huts (circles r≈3), trees (r≈0.6), well (r≈1.2), fences (segments). Client mirrors them for prediction.
- Map bounds: ±55 m square; spawn clearing at (0, 8).
