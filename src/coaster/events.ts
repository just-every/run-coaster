import { now, uid, type Actor, type Data } from './types';

/** One append-only history line, numbered in write order (seq survives export and restore); agents are named alongside
 * the person they act for, and a delegate's line is theirs with the person they acted for. */
export function event(db: D1Database, actor: Actor, action: string, target: { claim?: string; batch?: string }, detail: Data = {}) {
  const who = actor.publicCredential ? { ...detail, apiCredential: actor.publicCredential.id, channel: 'public-api' } : actor.kind === 'agent' ? { ...detail, agent: actor.agentLabel } : actor.delegate ? { ...detail, actingFor: actor.email } : detail;
  return ruleEvent(db, actor.delegate?.email ?? actor.email, action, target, who);
}

/** A history line written under a name rather than by a signed-in actor: the approval rule's "rule vN" (APPROVE-004). */
export function ruleEvent(db: D1Database, by: string, action: string, target: { claim?: string; batch?: string }, detail: Data = {}) {
  return db.prepare('INSERT INTO c_events(id,seq,at,actor_email,action,claim_id,batch_id,detail) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM c_events),?,?,?,?,?,?)').bind(uid(), now(), by, action, target.claim ?? null, target.batch ?? null, JSON.stringify(detail));
}
