import { currentWorkflow } from './workflow-configuration';
import { claimReceiptBytes } from './receipts/claim-storage';
import { policyConfiguration } from './policy-configuration';
import { business } from './settings';
import { canSee, claimItems, loadClaim, visible, type Claim } from './claims';
import { categories } from './items';
import { findExceptions, perPersonShares } from './exceptions';
import { batchLines, loadBatch } from './batches';
import { requireThat, type Actor, type Data } from './types';
import { delegations } from './delegation';
import { delegateGrants } from './delegates';
import { loadRequest, requestsFor } from './requests';
import { claimComments, openQuestions } from './comments';
import { exportTemplates } from './exports';
import { currentRule } from './auto-approval';
import { localDate } from './reports';
import { businessDaysBetween } from './business-days';
import { allowancesFor } from './allowances';
import { policyOn } from './policy';
import { advancesFor, claimAdvance } from './advances';
import { can } from './permissions';
import { departments } from './departments';
import { escalationChains } from './escalation-chains';

/** Everything one person's workspace shows, already narrowed to what they may see. */
export async function workspace(db: D1Database, actor: Actor) {
  const [claims, members, proposals, keys, batches] = await db.batch([
    db.prepare("SELECT id,number,employee_email,approver_email,on_behalf_of,title,status,revision,version,total_minor,currency,prepared_by,batch_id,created_at,updated_at,EXISTS(SELECT 1 FROM c_revisions w WHERE w.claim_id=c_claims.id AND json_type(w.snapshot,'$.workflow')='object') AS workflow_history,(SELECT submitted_at FROM c_revisions r WHERE r.claim_id=c_claims.id AND r.revision=c_claims.revision) AS submitted_at FROM c_claims ORDER BY number DESC"),
    db.prepare('SELECT member_id,email,name,is_employee,is_manager,is_finance,is_auditor,is_admin,is_card_admin,is_bookkeeper,department_id,may_release,is_contractor,approver_email,active FROM c_members ORDER BY name'),
    db.prepare('SELECT id,kind,agent_label,payload,status,created_at,decided_at,result_id FROM c_proposals WHERE for_email=? ORDER BY created_at DESC').bind(actor.email),
    db.prepare('SELECT id,label,created_at,revoked_at FROM c_agent_keys WHERE member_email=? ORDER BY created_at DESC').bind(actor.email),
    db.prepare('SELECT * FROM c_batches ORDER BY number DESC'),
  ]);
  const workflowTasks=(await db.prepare("SELECT t.* FROM c_workflow_tasks t JOIN c_claims c ON t.kind='claim' AND c.id=t.record_id AND c.revision=t.revision").all<import('./workflow-routing').Task>()).results;
  const hydrated=(claims.results as Claim[]).map(c=>{const tasks=workflowTasks.filter(t=>t.record_id===c.id); return {...c,workflow_tasks:tasks,assigned_emails:tasks.filter(t=>t.status==='waiting').map(t=>t.email),workflow_readers:[...new Set(tasks.flatMap(t=>[t.email,...(t.on_behalf_of?[t.on_behalf_of]:[])]))]};});
  const seen = hydrated.filter(c => canSee(actor, c));
  const names = Object.fromEntries((members.results as Data[]).map(m => [m.email, m.name])), questions = await openQuestions(db);
  // A waiting claim shows its business days since submission against the approval service level (FOLLOWUP-002).
  const settings = await business(db), today = settings && localDate(new Date().toISOString(), settings.timezone);
  const policy = settings && await policyOn(db, today!);
  const waiting = (c: Claim & { submitted_at?: string }) => settings && c.status === 'submitted' && c.submitted_at ? businessDaysBetween(localDate(c.submitted_at, settings.timezone), today!) : null;
  return {
    actor: { email: actor.email, name: actor.name, roles: actor.roles, delegate: actor.delegate ?? null },
    business: await business(db),
    categories: await categories(db),
    policyFields: policy?.rules.filter(r => r.kind === 'required-field').map(r => ({ category: r.category, field: r.field })) ?? [],
    claims: seen.map(c => ({ ...c, open_questions: questions[c.id] ?? 0, waiting_business_days: waiting(c), over_service_level: settings ? (waiting(c) ?? 0) > settings.service_level_days : false, employee_name: names[c.employee_email] ?? c.employee_email, approver_name: c.approver_email ? names[c.approver_email] ?? c.approver_email : null })),
    names: Object.fromEntries((members.results as Data[]).filter(m => m.active).map(m => [m.email, m.name])),
    financeReviewers: (members.results as Data[]).filter(m => m.active && m.is_finance).map(m => m.email),
    managers: (members.results as Data[]).filter(m => m.active && m.is_manager).map(m => m.email),
    members: can(actor, 'people') ? members.results : (members.results as Data[]).filter(m => m.email === actor.email),
    departments: await departments(db),
    escalationChains: can(actor, 'policy') ? await escalationChains(db) : [],
    proposals: (proposals.results as Data[]).map(p => ({ ...p, payload: JSON.parse(p.payload) })),
    agentKeys: actor.delegate ? [] : keys.results,
    batches: can(actor, 'readAll') ? batches.results : [],
    exportTemplates: can(actor, 'exportFiles') ? await exportTemplates(db) : [],
    delegations: actor.roles.manager || actor.roles.finance ? await delegations(db, actor) : [],
    delegates: await delegateGrants(db, actor),
    requests: await requestsFor(db, actor),
    approvalWorkflow: can(actor, 'settings') ? await currentWorkflow(db) : null,
    approvalRule: can(actor, 'readAll') ? await currentRule(db) : null,
    allowances: await allowancesFor(db, actor),
    advances: settings ? (await advancesFor(db, actor)).advances : [],
  };
}

/** One claim with its expenses, receipts, every revision, decision and history line. */
export async function claimDetail(db: D1Database, actor: Actor, id: string) {
  const claim = await loadClaim(db, id);
  visible(actor, claim);
  const items = await claimItems(db, claim.id);
  const [revisions, decisions, events, receipts] = await db.batch([
    db.prepare('SELECT revision,submitted_by,submitted_at,total_minor,snapshot FROM c_revisions WHERE claim_id=? ORDER BY revision').bind(claim.id),
    db.prepare('SELECT revision,decision_step,workflow_final,decision,reason,actor_email,on_behalf_of,at,exceptions FROM c_decisions WHERE claim_id=? ORDER BY revision,at,rowid').bind(claim.id),
    db.prepare('SELECT at,actor_email,action,detail FROM c_events WHERE claim_id=? ORDER BY seq').bind(claim.id),
    db.prepare('SELECT id,name,media_type,size,sha256,source,uploaded_by,uploaded_at,capture_receipt_id FROM c_receipts WHERE claim_id=? ORDER BY uploaded_at, id').bind(claim.id),
  ]);
  const history = (revisions.results as Data[]).map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) }));
  const submittedReceipts = new Set(history.flatMap(r => (r.snapshot.items as Data[]).map(i => i.receipt?.id ?? i.receipt_id)));
  const hiddenReceipts = new Set((receipts.results as Data[]).filter(r => r.capture_receipt_id && actor.email !== claim.employee_email && !submittedReceipts.has(r.id)).map(r => r.id));
  const shownReceipts = (receipts.results as Data[]).filter(r => !hiddenReceipts.has(r.id)).map(({ capture_receipt_id, ...r }) => r);
  const shownItems = items.map(item => hiddenReceipts.has(item.receipt_id)
    ? { ...item, receipt_id: null, receipt_sha256: null, receipt_name: null, receipt_media: null, receipt_size: null, card_match_basis: null }
    : item);
  const settings = await business(db), known = await categories(db);
  const configured = settings ? await policyConfiguration(db, settings, known, ['draft', 'returned'].includes(claim.status) ? undefined : history.at(-1)?.snapshot.policyVersion) : { categories: known };
  const byId = new Map(configured.categories.map(c => [c.id, c]));
  const exceptions = ['draft', 'returned'].includes(claim.status) && settings
    ? await findExceptions(db, claim, items, settings, known)
    : history.at(-1)?.snapshot.exceptions ?? [];
  // Estimate against actual for each spend request this claim's expenses link to, seen by anyone who sees the claim.
  const linked = [...new Set(items.map(i => i.request_id).filter(Boolean))];
  const requests = await Promise.all(linked.map(async id => ({ ...(await loadRequest(db, id)), claim_minor: items.filter(i => i.request_id === id).reduce((n, i) => n + i.amount_minor, 0) })));
  return {
    claim, requests, advance: await claimAdvance(db, claim.id), comments: await claimComments(db, claim.id), items: shownItems.map(({ receipt_sha256, ...item }) => ({ ...item, receipt_sha256, per_person: perPersonShares(item, byId) })), exceptions, receipts: shownReceipts,
    revisions: history, decisions: (decisions.results as Data[]).map(d => ({ ...d, exceptions: JSON.parse(d.exceptions) })),
    events: (events.results as Data[]).map(e => ({ ...e, detail: JSON.parse(e.detail) })),
  };
}

/** Receipt bytes, for anyone who can see a claim (any revision) or proposal holding them. */
export async function receiptFile(db: D1Database, actor: Actor, id: string, inline: boolean, bucket?: R2Bucket) {
  const receipt = await db.prepare('SELECT r.*, p.for_email FROM c_receipts r LEFT JOIN c_proposals p ON p.id=r.proposal_id WHERE r.id=?').bind(id).first<Data>();
  requireThat(receipt, 'Receipt not found', 404);
  if (receipt.claim_id) {
    const claim = await loadClaim(db, receipt.claim_id);
    visible(actor, claim);
    if (receipt.capture_receipt_id && actor.email !== claim.employee_email) {
      const submitted = await db.prepare(`SELECT 1 FROM c_revisions v,json_each(v.snapshot,'$.items') i WHERE v.claim_id=? AND COALESCE(json_extract(i.value,'$.receipt.id'),json_extract(i.value,'$.receipt_id'))=? LIMIT 1`).bind(claim.id, receipt.id).first();
      requireThat(submitted, 'Receipt not found', 404);
    }
  } else requireThat(receipt.for_email === actor.email, 'This receipt is outside your access', 403);
  const image = String(receipt.media_type).startsWith('image/') && receipt.media_type !== 'image/heic';
  const safeName = String(receipt.name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(new Uint8Array(await claimReceiptBytes(db, receipt, bucket)), { headers: {
    'content-type': receipt.media_type, 'content-disposition': `${inline && image ? 'inline' : 'attachment'}; filename="${safeName}"`,
    'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
  } });
}

/** Finance and auditors read batches. */
const needBatchReader = (actor: Actor) => requireThat(can(actor, 'readAll'), 'Finance, auditor, admin or bookkeeper access required', 403);

export async function batchDetail(db: D1Database, actor: Actor, id: string) {
  needBatchReader(actor);
  const batch = await loadBatch(db, id);
  const [claims, events] = await db.batch([
    db.prepare('SELECT bc.claim_id,bc.revision,bc.amount_minor,c.number,c.title,c.employee_email,c.status FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=? ORDER BY c.number').bind(id),
    db.prepare('SELECT at,actor_email,action,detail FROM c_events WHERE batch_id=? ORDER BY seq').bind(id),
  ]);
  const { lines, people } = await batchLines(db, id);
  return { batch, claims: claims.results, lines, people, events: (events.results as Data[]).map(e => ({ ...e, detail: JSON.parse(e.detail) })) };
}
