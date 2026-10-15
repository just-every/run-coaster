import { business } from './settings';
import { canSee, claimItems, loadClaim, visible, type Claim } from './claims';
import { categories } from './items';
import { findExceptions } from './exceptions';
import { batchLines, loadBatch } from './batches';
import { need } from './session';
import { requireThat, type Actor, type Data } from './types';

/** Everything one person's workspace shows, already narrowed to what they may see. */
export async function workspace(db: D1Database, actor: Actor) {
  const [claims, members, proposals, keys, batches] = await db.batch([
    db.prepare('SELECT id,number,employee_email,approver_email,title,status,revision,version,total_minor,currency,prepared_by,batch_id,created_at,updated_at FROM c_claims ORDER BY number DESC'),
    db.prepare('SELECT email,name,is_employee,is_manager,is_finance,approver_email,active FROM c_members ORDER BY name'),
    db.prepare('SELECT id,kind,agent_label,payload,status,created_at,decided_at,result_id FROM c_proposals WHERE for_email=? ORDER BY created_at DESC').bind(actor.email),
    db.prepare('SELECT id,label,created_at,revoked_at FROM c_agent_keys WHERE member_email=? ORDER BY created_at DESC').bind(actor.email),
    db.prepare('SELECT * FROM c_batches ORDER BY number DESC'),
  ]);
  const seen = (claims.results as Claim[]).filter(c => canSee(actor, c));
  const names = Object.fromEntries((members.results as Data[]).map(m => [m.email, m.name]));
  return {
    actor: { email: actor.email, name: actor.name, roles: actor.roles },
    business: await business(db),
    categories: await categories(db),
    claims: seen.map(c => ({ ...c, employee_name: names[c.employee_email] ?? c.employee_email, approver_name: c.approver_email ? names[c.approver_email] ?? c.approver_email : null })),
    names: Object.fromEntries((members.results as Data[]).filter(m => m.active).map(m => [m.email, m.name])),
    members: actor.roles.owner ? members.results : (members.results as Data[]).filter(m => m.email === actor.email),
    proposals: (proposals.results as Data[]).map(p => ({ ...p, payload: JSON.parse(p.payload) })),
    agentKeys: keys.results,
    batches: actor.roles.finance ? batches.results : [],
  };
}

/** One claim with its expenses, receipts, every revision, decision and history line. */
export async function claimDetail(db: D1Database, actor: Actor, id: string) {
  const claim = await loadClaim(db, id);
  visible(actor, claim);
  const items = await claimItems(db, claim.id);
  const [revisions, decisions, events, receipts] = await db.batch([
    db.prepare('SELECT revision,submitted_by,submitted_at,total_minor,snapshot FROM c_revisions WHERE claim_id=? ORDER BY revision').bind(claim.id),
    db.prepare('SELECT revision,decision,reason,actor_email,at,exceptions FROM c_decisions WHERE claim_id=? ORDER BY revision').bind(claim.id),
    db.prepare('SELECT at,actor_email,action,detail FROM c_events WHERE claim_id=? ORDER BY seq').bind(claim.id),
    db.prepare('SELECT id,name,media_type,size,sha256,source,uploaded_by,uploaded_at FROM c_receipts WHERE claim_id=? ORDER BY uploaded_at, id').bind(claim.id),
  ]);
  const history = (revisions.results as Data[]).map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) }));
  const settings = await business(db);
  const exceptions = ['draft', 'returned'].includes(claim.status) && settings
    ? await findExceptions(db, claim, items, settings, await categories(db))
    : history.at(-1)?.snapshot.exceptions ?? [];
  return {
    claim, items: items.map(({ receipt_sha256, ...item }) => ({ ...item, receipt_sha256 })), exceptions, receipts: receipts.results,
    revisions: history, decisions: (decisions.results as Data[]).map(d => ({ ...d, exceptions: JSON.parse(d.exceptions) })),
    events: (events.results as Data[]).map(e => ({ ...e, detail: JSON.parse(e.detail) })),
  };
}

/** Receipt bytes, for anyone who can see a claim (any revision) or proposal holding them. */
export async function receiptFile(db: D1Database, actor: Actor, id: string, inline: boolean) {
  const receipt = await db.prepare('SELECT r.*, p.for_email FROM c_receipts r LEFT JOIN c_proposals p ON p.id=r.proposal_id WHERE r.id=?').bind(id).first<Data>();
  requireThat(receipt, 'Receipt not found', 404);
  if (receipt.claim_id) visible(actor, await loadClaim(db, receipt.claim_id));
  else requireThat(receipt.for_email === actor.email, 'This receipt is outside your access', 403);
  const image = String(receipt.media_type).startsWith('image/') && receipt.media_type !== 'image/heic';
  const safeName = String(receipt.name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(new Uint8Array(receipt.bytes as ArrayBuffer), { headers: {
    'content-type': receipt.media_type, 'content-disposition': `${inline && image ? 'inline' : 'attachment'}; filename="${safeName}"`,
    'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
  } });
}

export async function batchDetail(db: D1Database, actor: Actor, id: string) {
  need(actor, 'finance');
  const batch = await loadBatch(db, id);
  const [claims, events] = await db.batch([
    db.prepare('SELECT bc.claim_id,bc.revision,bc.amount_minor,c.number,c.title,c.employee_email,c.status FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=? ORDER BY c.number').bind(id),
    db.prepare('SELECT at,actor_email,action,detail FROM c_events WHERE batch_id=? ORDER BY seq').bind(id),
  ]);
  const { lines, people } = await batchLines(db, id);
  return { batch, claims: claims.results, lines, people, events: (events.results as Data[]).map(e => ({ ...e, detail: JSON.parse(e.detail) })) };
}
