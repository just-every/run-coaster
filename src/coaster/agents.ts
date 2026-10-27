import { acceptPreparation } from './agents/preparations';
import { all, authority, commit, need, sha256Hex } from './session';
import { event } from './events';
import { categories, pricedItem } from './items';
import { insertClaim, insertItem, loadClaim, receiptBytes } from './claims';
import { createBatch } from './batches';
import { requireBusiness } from './settings';
import { now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';
import { checkedCoding } from './coding/validation';

/** A person makes a key for their own agent. The secret is shown once and stored only as a hash. */
export async function createAgentKey(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only the person themselves makes their agent keys', 403);
  requireThat(actor.roles.owner || actor.roles.employee || actor.roles.manager || actor.roles.finance, 'Auditors read records and change nothing', 403);
  const member = await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1').bind(actor.email).first();
  requireThat(member, 'Ask the owner to add you as a member first', 409);
  const label = text(b.label, 'Agent name', 80), id = uid();
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = 'cst_' + btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await commit(db, authority(actor), [
    db.prepare('INSERT INTO c_agent_keys(id,member_email,label,token_hash,created_at) VALUES(?,?,?,?,?)').bind(id, actor.email, label, await sha256Hex(token), now()),
    event(db, actor, 'agent-key-created', {}, { key: id, label }),
  ]);
  return { id, label, token };
}

export async function revokeAgentKey(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only the person themselves or the owner revokes agent keys', 403);
  const key = await db.prepare('SELECT id,member_email,label FROM c_agent_keys WHERE id=? AND revoked_at IS NULL').bind(id).first<{ id: string; member_email: string; label: string }>();
  requireThat(key && (key.member_email === actor.email || actor.roles.owner), 'Agent key not found', 404);
  await commit(db, authority(actor), [db.prepare('UPDATE c_agent_keys SET revoked_at=? WHERE id=?').bind(now(), id), event(db, actor, 'agent-key-revoked', {}, { key: id, label: key.label })]);
  return { id };
}

/** An agent proposes a draft claim from receipts. Nothing is submitted until the employee accepts and submits. */
export async function proposeClaim(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.kind === 'agent', 'Use an agent key', 401);
  return prepareClaim(db, actor, b);
}

/** Native conversation prepares the same reviewable proposal without acquiring an agent key. */
export async function proposeConversationClaim(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use your own native session', 403);
  return prepareClaim(db, { ...actor, agentLabel: 'Conversation assistant' }, b);
}

async function prepareClaim(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  const business = await requireBusiness(db), known = await categories(db);
  const title = text(b.title, 'Claim title', 200);
  requireThat(Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 50, 'Propose between 1 and 50 expenses');
  const checked = await checkedCoding(db, await Promise.all((b.items as Data[]).map(raw => pricedItem(raw, business, known))));
  const id = uid(), statements: D1PreparedStatement[] = [], items: Data[] = [];
  for (const [index, raw] of b.items.entries()) {
    const item = checked.items[index];
    let receipt: string | null = null;
    if (raw.receipt) {
      const { bytes, media, name } = receiptBytes(raw.receipt);
      receipt = uid();
      statements.push(db.prepare("INSERT INTO c_receipts(id,proposal_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,'agent',?,?)").bind(receipt, id, actor.email, name, media, bytes.length, await sha256Hex(bytes), bytes, `${actor.agentLabel} for ${actor.email}`, now()));
    }
    items.push({ ...raw, receipt: undefined, receiptId: receipt, amountMinor: item.amount_minor });
  }
  const payload = { nativeConversation: actor.kind === 'person', title, note: optionalText(b.note, 'Note', 2000), items };
  await commit(db, all(authority(actor, 'employee'), checked.guard), [
    db.prepare("INSERT INTO c_proposals(id,kind,agent_label,for_email,payload,status,created_at) VALUES(?,'claim',?,?,?,'proposed',?)").bind(id, actor.agentLabel, actor.email, JSON.stringify(payload), now()),
    ...statements,
    event(db, actor, 'claim-proposed', {}, { proposal: id, title, expenses: items.length, agent: actor.agentLabel }),
  ]);
  return proposal(db, id);
}

/** An agent proposes which approved claims finance should batch. */
export async function proposeBatch(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.kind === 'agent', 'Use an agent key', 401);
  need(actor, 'finance');
  requireThat(Array.isArray(b.claims) && b.claims.length > 0 && b.claims.length <= 200, 'Propose between 1 and 200 claims');
  for (const claim of b.claims) requireThat(await db.prepare("SELECT 1 FROM c_claims WHERE id=? AND status='approved'").bind(claim).first(), 'Only approved claims can be proposed for a batch', 409);
  const id = uid(), payload = { claims: b.claims, note: optionalText(b.note, 'Note', 2000) };
  await commit(db, authority(actor, 'finance'), [
    db.prepare("INSERT INTO c_proposals(id,kind,agent_label,for_email,payload,status,created_at) VALUES(?,'batch',?,?,?,'proposed',?)").bind(id, actor.agentLabel, actor.email, JSON.stringify(payload), now()),
    event(db, actor, 'batch-proposed', {}, { proposal: id, claims: b.claims.length }),
  ]);
  return proposal(db, id);
}

export async function proposal(db: D1Database, id: string): Promise<Data> {
  const row = await db.prepare('SELECT * FROM c_proposals WHERE id=?').bind(id).first<Data>();
  requireThat(row, 'Proposal not found', 404);
  const payload = JSON.parse(row.payload);
  // Older native proposals used this reserved label before custody was recorded explicitly.
  if (payload.nativeConversation === undefined && row.agent_label === 'Conversation assistant') payload.nativeConversation = true;
  return { ...row, payload };
}

async function mine(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.kind === 'person', 'Only the person the agent works for decides its proposals', 403);
  const p = await proposal(db, id);
  requireThat(p.for_email === actor.email, 'This proposal is for someone else', 403);
  if (p.payload.nativeConversation) requireThat(!actor.delegate && !actor.publicCredential, 'Review this conversation in your own native session', 403);
  requireThat(p.status === 'proposed', 'This proposal was already decided', 409);
  return p;
}
const open = (id: string) => ({ sql: "EXISTS(SELECT 1 FROM c_proposals WHERE id=? AND status='proposed')", params: [id] });

/** Accepting turns the proposal into the person's own draft claim or draft batch, recording who accepted it. */
export async function acceptProposal(db: D1Database, actor: Actor, id: string) {
  const p = await mine(db, actor, id), at = now();
  if (p.payload.preparation) return acceptPreparation(db, actor, p);
  if (p.kind === 'batch') {
    const batch = await createBatch(db, actor, { claims: p.payload.claims }, p.agent_label);
    await commit(db, all(authority(actor, 'finance'), open(id)), [
      db.prepare("UPDATE c_proposals SET status='accepted',decided_by=?,decided_at=?,result_id=? WHERE id=?").bind(actor.email, at, batch.id, id),
      event(db, actor, 'proposal-accepted', { batch: batch.id }, { proposal: id, agent: p.agent_label }),
    ]);
    return { proposal: await proposal(db, id), batch };
  }
  need(actor, 'employee');
  const business = await requireBusiness(db), known = await categories(db), claimId = uid();
  const checked = await checkedCoding(db, await Promise.all((p.payload.items as Data[]).map(raw => pricedItem(raw, business, known))));
  const statements: D1PreparedStatement[] = [insertClaim(db, claimId, actor.email, p.payload.title, business.currency, p.agent_label)];
  for (const [i, raw] of (p.payload.items as Data[]).entries()) statements.push(...insertItem(db, claimId, uid(), i, checked.items[i], raw.receiptId ?? null));
  statements.push(
    db.prepare('UPDATE c_receipts SET claim_id=? WHERE proposal_id=?').bind(claimId, id),
    db.prepare('UPDATE c_claims SET total_minor=(SELECT COALESCE(SUM(amount_minor),0) FROM c_items WHERE claim_id=?) WHERE id=?').bind(claimId, claimId),
    db.prepare("UPDATE c_proposals SET status='accepted',decided_by=?,decided_at=?,result_id=? WHERE id=?").bind(actor.email, at, claimId, id),
    event(db, actor, 'proposal-accepted', { claim: claimId }, { proposal: id, agent: p.agent_label }),
  );
  await commit(db, all(authority(actor, 'employee'), open(id), checked.guard), statements);
  return { proposal: await proposal(db, id), claim: await loadClaim(db, claimId) };
}

export async function declineProposal(db: D1Database, actor: Actor, id: string, b: Data) {
  const p = await mine(db, actor, id);
  if (p.payload.preparation) requireThat(!actor.delegate, 'Review this work in your own native session', 403);
  await commit(db, all(authority(actor), open(id)), [
    db.prepare("UPDATE c_proposals SET status='declined',decided_by=?,decided_at=? WHERE id=?").bind(actor.email, now(), id),
    event(db, actor, 'proposal-declined', {}, { proposal: id, agent: p.agent_label, reason: optionalText(b.reason, 'Reason', 500) }),
  ]);
  return proposal(db, id);
}
