import type { Data } from '../types';

/** BASE-AGENT-008: "<agent> for <person>" for personal-agent claim and batch preparations, read back from the retained
 * proposal and its own history lines. Native conversations and native preparations are the person's own work and never
 * read as an agent's; a company policy approval is not a native acceptance and never appears here. */
export type Person = { email: string; name: string };
export type Attribution = {
  proposal: string; kind: 'claim' | 'batch'; agent: string; for: Person; label: string;
  outcome: 'proposed' | 'accepted' | 'declined';
  /** The person who actually decided it in their own session; a delegate is named with the person they acted for. */
  decidedBy?: Person & { onBehalfOf?: Person }; decidedAt?: string;
};

/** Only a personal agent's own preparation reads as an agent act. */
const personalAgent = (p: Data) => {
  const payload = JSON.parse(p.payload);
  return !payload.preparation && !payload.nativeConversation && p.agent_label !== 'Conversation assistant';
};
const proposed = { claim: 'claim-proposed', batch: 'batch-proposed' } as const;

export type Line = { action: string; actor_email: string; claim_id?: string | null; batch_id?: string | null; detail: Data };

async function resolve(db: D1Database, ids: string[]) {
  if (!ids.length) return new Map<string, Data>();
  const json = JSON.stringify([...new Set(ids)]);
  const rows = (await db.prepare('SELECT id,kind,agent_label,for_email,payload,status,decided_at,result_id FROM c_proposals WHERE id IN (SELECT value FROM json_each(?))').bind(json).all<Data>()).results;
  return new Map(rows.filter(personalAgent).map(r => [r.id as string, r]));
}

async function names(db: D1Database, emails: string[]) {
  const json = JSON.stringify([...new Set(emails.filter(Boolean))]);
  const rows = (await db.prepare('SELECT email,name FROM c_members WHERE email IN (SELECT value FROM json_each(?))').bind(json).all<{ email: string; name: string }>()).results;
  const known = new Map(rows.map(r => [r.email, r.name]));
  return (email: string): Person => ({ email, name: known.get(email) ?? email });
}

const base = (p: Data, who: (email: string) => Person) => {
  const sponsor = who(p.for_email);
  return { proposal: p.id, kind: p.kind, agent: p.agent_label, for: sponsor, label: `${p.agent_label} for ${sponsor.name}` };
};

/** The acceptance line that made this exact claim or batch from this exact proposal. */
const acceptance = (p: Data, lines: Line[]) => lines.find(l => l.action === 'proposal-accepted' && l.detail.proposal === p.id && l.detail.agent === p.agent_label
  && (p.kind === 'claim' ? l.claim_id === p.result_id : l.batch_id === p.result_id));

const decider = (l: Line, who: (email: string) => Person): Person & { onBehalfOf?: Person } =>
  ({ ...who(l.actor_email), ...(l.detail.actingFor && l.detail.actingFor !== l.actor_email ? { onBehalfOf: who(l.detail.actingFor) } : {}) });

/** The preparation behind each accepted claim or batch, keyed by its record id. */
export async function recordAttributions(db: D1Database, kind: 'claim' | 'batch', recordIds: string[]) {
  const out = new Map<string, Attribution>();
  if (!recordIds.length) return out;
  const found = (await db.prepare("SELECT id FROM c_proposals WHERE kind=? AND status='accepted' AND result_id IN (SELECT value FROM json_each(?))").bind(kind, JSON.stringify(recordIds)).all<{ id: string }>()).results;
  const proposals = await resolve(db, found.map(r => r.id));
  const accepted = (await db.prepare("SELECT actor_email,action,claim_id,batch_id,detail FROM c_events WHERE action='proposal-accepted' AND json_extract(detail,'$.proposal') IN (SELECT value FROM json_each(?)) ORDER BY seq").bind(JSON.stringify([...proposals.keys()])).all<Data>()).results
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }) as Line);
  const who = await names(db, [...proposals.values()].map(p => p.for_email).concat(accepted.flatMap(l => [l.actor_email, l.detail.actingFor])));
  for (const p of proposals.values()) {
    const line = acceptance(p, accepted);
    if (line && !out.has(p.result_id)) out.set(p.result_id, { ...base(p, who), outcome: 'accepted', decidedBy: decider(line, who), decidedAt: p.decided_at });
  }
  return out;
}

/** History lines for personal-agent proposals, each with the preparer, the person it was for and who decided it. */
export async function annotateLines<T extends Line>(db: D1Database, lines: T[]): Promise<(T & { attribution: Attribution | null })[]> {
  const tracked = ['claim-proposed', 'batch-proposed', 'proposal-accepted', 'proposal-declined'];
  const proposals = await resolve(db, lines.filter(l => tracked.includes(l.action) && typeof l.detail.proposal === 'string').map(l => l.detail.proposal));
  const who = await names(db, [...proposals.values()].map(p => p.for_email).concat(lines.flatMap(l => proposals.has(l.detail.proposal) ? [l.actor_email, l.detail.actingFor] : [])));
  return lines.map(l => {
    const p = proposals.get(l.detail.proposal);
    let attribution: Attribution | null = null;
    if (p && l.action === proposed[p.kind as 'claim' | 'batch']) attribution = { ...base(p, who), outcome: 'proposed' };
    else if (p && l.action === 'proposal-accepted' && p.status === 'accepted' && acceptance(p, [l])) attribution = { ...base(p, who), outcome: 'accepted', decidedBy: decider(l, who), decidedAt: p.decided_at };
    else if (p && l.action === 'proposal-declined' && p.status === 'declined') attribution = { ...base(p, who), outcome: 'declined', decidedBy: decider(l, who), decidedAt: p.decided_at };
    return { ...l, attribution };
  });
}
