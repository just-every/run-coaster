import { now, uid, type Actor, type Data } from './types';

/** One append-only history line, numbered in write order (seq survives export and restore); agents are named alongside the person they act for. */
export function event(db: D1Database, actor: Actor, action: string, target: { claim?: string; batch?: string }, detail: Data = {}) {
  const who = actor.kind === 'agent' ? { ...detail, agent: actor.agentLabel } : detail;
  return db.prepare('INSERT INTO c_events(id,seq,at,actor_email,action,claim_id,batch_id,detail) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM c_events),?,?,?,?,?,?)').bind(uid(), now(), actor.email, action, target.claim ?? null, target.batch ?? null, JSON.stringify(who));
}
