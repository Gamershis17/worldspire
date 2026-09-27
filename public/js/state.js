// Client-side source of truth. net.js writes it; world3d.js and ui.js read it.
export const state = {
  me: null,          // {id,name,cls,level,xp,xpNext,coins,hp,maxHp,mp,maxMp,x,z,heading,dead,abilities[]}
  ents: new Map(),   // id -> ent (players + mobs). ent: {id,kind,name,cls,mob,elite,level,x,z,heading,hp,maxHp,moving,dead,casting,targetId, _px,_pz,_pt,_miss}
  targetId: null,
  chat: [],          // {from,text,sys}
  connected: false,
};

export function upsertEnt(e, now) {
  let ent = state.ents.get(e.id);
  if (!ent) {
    ent = { ...e, _px: e.x, _pz: e.z, _pt: now, _miss: 0 };
    state.ents.set(e.id, ent);
  } else {
    // keep previous pos for interpolation
    ent._px = ent.x; ent._pz = ent.z; ent._pt = now; ent._miss = 0;
    Object.assign(ent, e);
  }
  return ent;
}

export function markSweep(ids, now) {
  for (const [id, ent] of state.ents) {
    if (!ids.has(id)) {
      ent._miss++;
      if (ent._miss >= 4) state.ents.delete(id); // absent ~400ms -> gone
    }
  }
}

export function removeEnt(id) { state.ents.delete(id); }

export function targetEnt() { return state.targetId != null ? state.ents.get(state.targetId) || null : null; }

export function pushChat(from, text, sys, gm, guild, emote) {
  state.chat.push({ from, text, sys: !!sys, gm: !!gm, guild: !!guild, emote: !!emote });
  if (state.chat.length > 120) state.chat.shift();
}
