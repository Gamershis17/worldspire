// Client copy of the achievement table (server/data.js is authoritative for
// unlocking; this mirrors names/descriptions/points for the panel).
export const ACH_CATEGORIES = ['Character', 'Combat', 'Exploration', 'Wealth', 'Social'];
export const ACHIEVEMENTS = [
  { id: 'first_blood',  name: 'First Blood',     desc: 'Slay your first foe.',            category: 'Combat',      points: 5,  icon: '🩸', track: { counter: 'kills.total', goal: 1 } },
  { id: 'boar_hunter',  name: 'Boar Hunter',     desc: 'Slay 25 boars.',                   category: 'Combat',      points: 10, icon: '🐗', track: { counter: 'kills.boar',  goal: 25 } },
  { id: 'wolf_slayer',  name: 'Wolf Slayer',     desc: 'Slay 25 wolves.',                  category: 'Combat',      points: 10, icon: '🐺', track: { counter: 'kills.wolf',  goal: 25 } },
  { id: 'alpha_down',   name: 'Alpha Down',      desc: 'Bring down the Alpha Wolf.',       category: 'Combat',      points: 15, icon: '👑', track: { counter: 'kills.alpha', goal: 1 } },
  { id: 'rising_hero',  name: 'Rising Hero',     desc: 'Reach level 5.',                   category: 'Character',   points: 10, icon: '⚔️',  track: { counter: 'level',       goal: 5 } },
  { id: 'veteran',      name: 'Veteran',         desc: 'Reach level 10.',                  category: 'Character',   points: 15, icon: '🛡️',  track: { counter: 'level',       goal: 10 } },
  { id: 'beast_master', name: 'Beast Master',    desc: 'Tame a wild beast.',               category: 'Character',   points: 10, icon: '🐾', track: { counter: 'petsTamed',   goal: 1 } },
  { id: 'survivor',     name: 'Survivor',        desc: 'Return from death.',               category: 'Character',   points: 5,  icon: '💪', track: { counter: 'deaths',      goal: 1 } },
  { id: 'wanderer',     name: 'Wanderer',        desc: 'Walk 2,000 meters.',               category: 'Exploration', points: 10, icon: '🥾', track: { counter: 'distanceM',   goal: 2000 } },
  { id: 'hoarder',      name: 'Treasure Hoarder', desc: 'Hold 1,000 coins at once.',      category: 'Wealth',      points: 10, icon: '💰', track: { counter: 'coinsMax',    goal: 1000 } },
  { id: 'chatter',      name: 'Chatter',         desc: 'Send 25 chat messages.',           category: 'Social',      points: 5,  icon: '💬', track: { counter: 'chatMsgs',    goal: 25 } },
  { id: 'guilded',      name: 'Guilded',         desc: 'Join a guild.',                    category: 'Social',      points: 10, icon: '🏰', track: { counter: 'guilded',     goal: 1 } },
  { id: 'dancer',       name: 'Dancer',          desc: 'Dance like nobody is watching.',   category: 'Social',      points: 5,  icon: '💃', track: { counter: 'danced',      goal: 1 } },
  { id: 'jokester',     name: 'Jokester',        desc: 'Tell a joke in the wilds.',        category: 'Social',      points: 5,  icon: '🃏', track: { counter: 'joked',       goal: 1 } },
];
