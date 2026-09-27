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
| `chat` | `text` (≤140 chars) | Global say. |
| `respawn` | — | Respawn at village after death (also auto after 8 s). |
| `ping` | `t` | Server replies `pong`. |

## Server → Client

- `hello` — `{op:'hello', id, name, cls, level, xp, xpNext, coins, x, z, hp, maxHp, mp, maxMp, speed, abilities:[{slot,name,icon,mana,cd,castTime,range}], colliders:[{x,z,r}], layout:{spawn:{x,z}, huts:[{x,z,ry}], trees:[{x,z,s}], well:{x,z}, fences:[{x1,z1,x2,z2}], rocks:[{x,z,s}]}}` — full character state on login. `layout` drives BOTH the 3D scenery and is the source of the `colliders` (client mirrors them for movement prediction).
- `stats` — `{op:'stats', hp, maxHp, mp, maxMp, xp, xpNext, level, coins, dead}` — whenever these change.
- `snap` — `{op:'snap', t, ents:[ent...]}` at 10 Hz. Entity:
  `{id, kind:'player'|'mob', name, cls?, mob?, elite?, level, x, z, heading, hp, maxHp, moving, dead, casting?:{label, endsAt, dur}, targetId?}`
  `mob` is `boar`|`wolf`|`alpha`. The client never extrapolates the local player from `snap` (it predicts); `snap` still contains self for reconciliation.
- `ev` — `{op:'ev', ev:'dmg', src, dst, amount, crit, label?}` damage numbers.
  `{op:'ev', ev:'die', id, by?}` · `{op:'ev', ev:'kill', mob, xp, coins}` (to killer)
  `{op:'ev', ev:'lvlup', level}` · `{op:'ev', ev:'chat', from, text, sys?}`
  `{op:'ev', ev:'cast', src, slot, label, dur, endsAt}` · `{op:'ev', ev:'proj', src, dst, kind}` (cosmetic projectile)
  `{op:'ev', ev:'buff', id, label, dur}` · `{op:'ev', ev:'respawn', id, x, z}`
  `{op:'ev', ev:'leash', id}` (mob returned home)
- `err` — `{op:'err', msg}`

## Combat rules (server-enforced)

- Auto-attack: requires target, range (melee 4 m, ranged 26 m), 2 s swing (mage 1.6 s).
- Abilities per class (slot: name — mana, cooldown, range, effect):
  - Warrior: 1 Strike — 8, 0 s, 4 m, 8+2/lvl dmg · 2 Charge — 0, 15 s, 25 m, dash to target + 4+1/lvl dmg · 3 Shield Block — 0, 20 s, self, −50 % dmg taken 6 s · 4 Whirlwind — 15, 8 s, 6 m AoE, 7+1.5/lvl dmg
  - Mage: 1 Fireball — 15, 0 s, 28 m, 1.5 s cast, 14+3/lvl · 2 Frostbolt — 10, 0 s, 28 m, 1.2 s cast, 9+2/lvl + 40 % slow 4 s · 3 Blink — 0, 15 s, self, teleport 12 m forward · 4 Arcane Explosion — 25, 10 s, 8 m AoE, 10+2/lvl
  - Ranger: 1 Steady Shot — 12, 0 s, 28 m, 1.0 s cast, 12+2.5/lvl · 2 Multi-Shot — 18, 6 s, 28 m, 8+2/lvl to ≤3 targets · 3 Disengage — 0, 18 s, self, leap 10 m backward · 4 Volley — 22, 12 s, 28 m, 10+2/lvl AoE 6 m at target
- Mana regen 4/s (8/s out of combat). HP regen 2 %/s out of combat (5 s).
- XP: boar 25, wolf 40, alpha 200. `xpNext(level) = 100 * level`. Cap level 10.
- Death: 8 s corpse, respawn at village (0, 8) full HP/MP. No XP loss in phase 1.
- Mobs: boar passive (retaliates), wolf aggressive (aggro 12 m, leash 30 m), alpha elite (aggro 14 m, enrage <30 % HP: +50 % dmg & speed), respawn 20 s (alpha 120 s). Auto-loot coins to killer.

## Movement

- Speed: warrior 6, mage 5.6, ranger 6.2 m/s (mob: boar 3, wolf 5.5, alpha 6).
- Static colliders (server): village huts (circles r≈3), trees (r≈0.6), well (r≈1.2), fences (segments). Client mirrors them for prediction.
- Map bounds: ±55 m square; spawn clearing at (0, 8).
