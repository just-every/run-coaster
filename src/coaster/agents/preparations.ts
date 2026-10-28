import { all, authority, commit, need, sha256Hex, type Sql } from '../session';
import { claimItems, claimState, claimTotal, insertClaim, loadClaim } from '../claims';
import { event } from '../events';
import { requireBusiness } from '../settings';
import { categories } from '../items';
import { findExceptions } from '../exceptions';
import { flatten, itemFields } from '../coding/automatic/model';
import { targetSuggestions } from '../coding/automatic/storage';
import { expenseCodingPlan } from './coding-application';
import { isoDate, now, requireThat, text, uid, type Actor, type Data } from '../types';

function native(actor: Actor) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Prepare and review this work in your own native session', 403);
}
const stampSql = `SELECT json_array(
 (SELECT updated_at FROM c_business WHERE id=1),
 (SELECT COUNT(*) FROM c_capture_receipts),(SELECT COALESCE(MAX(rowid),0) FROM c_capture_lifecycle),
 (SELECT group_concat(s) FROM (SELECT id||':'||version||':'||status AS s FROM c_claims ORDER BY id)),
 (SELECT group_concat(s) FROM (SELECT id||':'||version||':'||status AS s FROM c_batches ORDER BY id)),
 (SELECT group_concat(s) FROM (SELECT id||':'||COALESCE(closed_at,'open') AS s FROM c_card_statements ORDER BY id)),
 (SELECT group_concat(s) FROM (SELECT email||':'||COALESCE(department_id,'') AS s FROM c_members ORDER BY email)),
 (SELECT group_concat(s) FROM (SELECT id||':'||name AS s FROM c_departments ORDER BY id))) AS stamp`;
const stampGuard = (stamp: string): Sql => ({ sql: `(${stampSql})=?`, params: [stamp] });
async function save(db: D1Database, actor: Actor, kind: string, payload: Data, guard: Sql) {
  const id = uid(), label = `${payload.preparation === 'close' ? 'Month-end' : payload.preparation === 'trip' ? 'Trip' : 'Expense'} preparation agent`;
  await commit(db, all(authority(actor, payload.preparation === 'close' ? 'owner' : 'employee'), guard), [
    db.prepare("INSERT INTO c_proposals(id,kind,agent_label,for_email,payload,status,created_at) VALUES(?,?,?,?,?,'proposed',?)").bind(id, kind, label, actor.email, JSON.stringify(payload), now()),
    event(db, actor, 'native-work-proposed', {}, { proposal: id, agent: label, preparation: payload.preparation }),
  ]);
  return { id, kind, agent_label: label, status: 'proposed', payload };
}

/** Close preparation exposes aggregate draft facts only; private originals and draft titles stay private. */
export async function prepareClose(db: D1Database, actor: Actor, b: Data) {
  native(actor); need(actor, 'owner');
  const from = isoDate(b.from, 'Period start'), to = isoDate(b.to, 'Period end');
  requireThat(from <= to && from.slice(0, 7) === to.slice(0, 7), 'Choose a period within one month');
  const settings = await requireBusiness(db), before = (await db.prepare(stampSql).first<{ stamp: string }>())!.stamp;
  const departments = (await db.prepare(`SELECT COALESCE(d.name,'Unassigned') AS department,
    COUNT(DISTINCT c.id) AS claims,COUNT(*) AS expenses,SUM(i.amount_minor) AS amountMinor,
    SUM(CASE WHEN i.kind='receipt' AND i.receipt_id IS NULL AND (c.status<>'draft' OR c.employee_email=?) THEN 1 ELSE 0 END) AS missingEvidence,
    SUM(CASE WHEN c.status IN ('draft','returned') THEN i.amount_minor ELSE 0 END) AS unsubmittedMinor
    FROM c_items i JOIN c_claims c ON c.id=i.claim_id LEFT JOIN c_members m ON m.email=c.employee_email
    LEFT JOIN c_departments d ON d.id=m.department_id
    WHERE i.spent_on>=? AND i.spent_on<=? AND c.status IN ('draft','returned','submitted')
    GROUP BY COALESCE(d.name,'Unassigned') ORDER BY department`).bind(actor.email, from, to).all<Data>()).results;
  const pending = (await db.prepare(`SELECT DISTINCT c.id,c.number,c.status FROM c_claims c JOIN c_items i ON i.claim_id=c.id
    WHERE c.status='submitted' AND i.spent_on>=? AND i.spent_on<=? ORDER BY c.number`).bind(from, to).all<Data>()).results;
  const statements = (await db.prepare('SELECT id,period_start,period_end,closed_at FROM c_card_statements WHERE period_end>=? AND period_end<=? ORDER BY id').bind(from, to).all<Data>()).results;
  const payments = (await db.prepare("SELECT id,number,paid_on,paid_reference FROM c_batches WHERE status='reimbursed' AND paid_on>=? AND paid_on<=? ORDER BY number").bind(from, to).all<Data>()).results;
  const cutoff = await db.prepare(`SELECT COUNT(*) AS outsidePeriod FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE c.status IN ('draft','returned','submitted') AND (i.spent_on<? OR i.spent_on>?)`).bind(from, to).first<Data>();
  const ownInbox = await db.prepare(`SELECT COUNT(*) AS n FROM c_capture_receipts r WHERE r.owner_email=? AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id=r.id AND l.kind IN ('discarded','merged')) AND NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=r.id)`).bind(actor.email).first<{n:number}>();
  const checklist = [
    { label: `${ownInbox!.n} unattached originals in your private inbox; other employees’ private originals are not inspected`, citation: '/app#/claims' },
    ...departments.map(d => ({ label: `${d.department}: ${d.claims} pending claims, ${d.expenses} expenses; ${d.missingEvidence} missing receipts on visible claims`, amountMinor: d.amountMinor, citation: `/api/coaster/reports/unsubmitted?from=${from}&to=${to}`, detail: d })),
    ...pending.map(c => ({ label: `CL-${String(c.number).padStart(4, '0')}: awaiting approval`, citation: `/app#/claims/${c.id}` })),
    ...statements.map(s => ({ label: `Statement ending ${s.period_end}: ${s.closed_at ? 'reconciled' : 'reconciliation open'}`, citation: `/api/coaster/statements/reconciliations/${s.id}` })),
    ...payments.map(p => ({ label: `RB-${String(p.number).padStart(4, '0')}: payment recorded ${p.paid_on}; ledger clearance unverified`, citation: `/app#/batches/${p.id}` })),
    { label: `Cutoff ${to} in ${settings.timezone}; ${cutoff!.outsidePeriod} pending expenses outside this period excluded`, citation: '/api/coaster/reports/unsubmitted' },
    { label: 'Review missing evidence and chase owners through the existing follow-up workflow; no chase sent by this proposal', citation: '/app#/settings' },
    { label: 'Accrual proposal only. Ledger clearance and QuickBooks posting require a connected ledger.', citation: '/app#/batches' },
  ];
  return save(db, actor, 'batch', { preparation: 'close', title: `Close checklist ${from} to ${to}`, from, to, currency: settings.currency, departments, checklist, claims: [], sourceStamp: await sha256Hex(before), accrualMinor: departments.reduce((n, d) => n + d.amountMinor, 0), note: 'Owner review required; nothing posted or sent.' }, stampGuard(before));
}

async function ownDraft(db: D1Database, actor: Actor, id: string) {
  native(actor); need(actor, 'employee');
  const claim = await loadClaim(db, id);
  requireThat(claim.employee_email === actor.email, 'Claim not found', 404);
  requireThat(['draft','returned'].includes(claim.status), 'Choose an editable claim', 409);
  return claim;
}

/** Group existing manual draft expenses without copying evidence or creating a second reimbursable expense. */
export async function prepareTrip(db: D1Database, actor: Actor, b: Data) {
  native(actor); need(actor, 'employee');
  const from = isoDate(b.from, 'Trip start'), to = isoDate(b.to, 'Trip end'), title = text(b.title, 'Trip title', 200);
  requireThat(from <= to, 'Trip ends before it starts');
  requireThat(Array.isArray(b.claims) && b.claims.length > 0 && b.claims.length <= 20 && new Set(b.claims).size === b.claims.length, 'Choose distinct source draft claims (at most 20)');
  const sources: Data[] = [], items: Data[] = [], guards: Sql[] = [];
  for (const id of b.claims) {
    const claim = await ownDraft(db, actor, id);
    requireThat(claim.status === 'draft' && claim.revision === 0, 'Only never-submitted drafts can be grouped', 409);
    requireThat(!await db.prepare('SELECT 1 FROM c_claims WHERE id=? AND auto_key IS NOT NULL UNION ALL SELECT 1 FROM c_advances WHERE claim_id=?').bind(id, id).first(), 'Automatic reports and advance-linked claims stay in their own workflow', 409);
    const selected = (await claimItems(db, id)).filter(i => i.spent_on >= from && i.spent_on <= to);
    for (const item of selected) {
      const end = item.per_diem?.endDate ?? (item.kind === 'per_diem' ? new Date(Date.parse(item.spent_on + 'T00:00:00Z') + (item.days - 1) * 86400000).toISOString().slice(0,10) : item.spent_on);
      requireThat(end <= to, 'A per diem crosses the trip cutoff; choose the complete travel period', 409);
      if (item.receipt_id) {
        const linked = (await db.prepare('SELECT id FROM c_items WHERE receipt_id=?').bind(item.receipt_id).all<{id:string}>()).results;
        requireThat(linked.every(link => selected.some(i => i.id === link.id)), 'This receipt is also linked outside the trip; review its source claim first', 409);
      }
      requireThat(!item.card_charge_id && !item.allowance_id && !await db.prepare('SELECT 1 FROM c_receipts WHERE id=? AND capture_receipt_id IS NOT NULL').bind(item.receipt_id).first(), 'Card, allowance and inbox-linked expenses stay in their original report', 409);
      items.push({ id: item.id, sourceClaim: id, date: item.spent_on, kind: item.kind, merchant: item.merchant, amountMinor: item.amount_minor, receipt: item.receipt_id ? { id: item.receipt_id, sha256: item.receipt_sha256 } : null, perDiem: item.per_diem, allocations: item.allocations, citation: `/app#/claims/${id}` });
    }
    sources.push({ id, version: claim.version }); guards.push(claimState(id, claim.version, ['draft']));
  }
  requireThat(items.length > 0 && items.length <= 50, 'Choose a trip with 1 to 50 expenses');
  return save(db, actor, 'claim', { preparation: 'trip', title, from, to, sources, items, currency: (await requireBusiness(db)).currency, note: 'Existing native expenses only. Travel bookings, calendar, new GSA days and airport routing remain unavailable.' }, all(authority(actor, 'employee'), ...guards));
}

/** An expense close plan cites the current coding and evidence; disputes require human correction. */
export async function prepareExpense(db: D1Database, actor: Actor, id: string) {
  const claim = await ownDraft(db, actor, id), items = await claimItems(db, id), settings = await requireBusiness(db), known = await categories(db);
  const exceptions = await findExceptions(db, claim, items, settings, known);
  const plan = await expenseCodingPlan(db, claim, items);
  const checklist: Data[] = [], guards: Sql[] = [claimState(id, claim.version, ['draft','returned']), ...plan.guards];
  for (const item of items) {
    const suggestions = await targetSuggestions(db, 'item', item.id);
    const proposed = plan.entries.find(entry => entry.item === item.id)!.advice;
    const current = flatten(itemFields(item));
    const disputed = suggestions.some(s => s.status === 'override') && Object.entries(flatten(proposed.fields)).some(([field,value]) => current[field] !== value);
    checklist.push({ label: `${item.merchant}: ${disputed ? 'coding disputed — stop and resolve' : 'review coding and receipt before submission'}`, citation: `/app#/claims/${id}`, item: item.id, coding: item.allocations, proposedCoding: { ...proposed, categoryName: known.find(c => c.id === proposed.fields.category)?.name }, suggestions, receipt: item.receipt_id ? { id: item.receipt_id, sha256: item.receipt_sha256 } : null, issues: exceptions.filter(e => e.item === item.id).map(e => e.message), disputed });
  }
  requireThat(items.length > 0, 'Add an expense before preparing its close plan');
  return save(db, actor, 'claim', { preparation: 'expense', currency: settings.currency, title: claim.title, sourceClaim: id, sourceVersion: claim.version, codingApplication: claim.status === 'draft' && claim.revision === 0 ? { review: plan.review, fingerprint: plan.fingerprint } : null, checklist, items: [], stopped: checklist.some(i => i.disputed), note: 'Review this plan, correct issues and submit through the normal claim screen. No coding or receipt is changed automatically.' }, all(authority(actor,'employee'), ...guards));
}

/** Called only after the proposal recipient and proposed status have been checked. */
export async function acceptPreparation(db: D1Database, actor: Actor, p: Data) {
  native(actor);
  const b = p.payload, guards: Sql[] = [{ sql: "EXISTS(SELECT 1 FROM c_proposals WHERE id=? AND status='proposed')", params: [p.id] }], writes: D1PreparedStatement[] = [];
  let result: string | null = null;
  if (b.preparation === 'close') {
    need(actor, 'owner');
    const current = (await db.prepare(stampSql).first<{ stamp: string }>())!.stamp;
    requireThat(await sha256Hex(current) === b.sourceStamp, 'Close inputs changed; prepare a new checklist', 409);
    guards.push(stampGuard(current));
  }
  else if (b.preparation === 'expense') {
    const claim = await ownDraft(db, actor, b.sourceClaim);
    requireThat(!b.stopped, 'Resolve disputed coding before accepting a new close plan', 409);
    requireThat(claim.version === b.sourceVersion, 'The claim changed; prepare a new close plan', 409);
    guards.push(claimState(claim.id, b.sourceVersion, ['draft','returned'])); result = claim.id;
  } else {
    need(actor, 'employee');
    const settings = await requireBusiness(db); result = uid();
    writes.push(insertClaim(db, result, actor.email, b.title, settings.currency, p.agent_label));
    for (const source of b.sources) {
      const claim = await ownDraft(db, actor, source.id);
      requireThat(claim.version === source.version && claim.revision === 0 && claim.status === 'draft', 'A source changed; prepare the trip again', 409);
      guards.push(claimState(source.id, source.version, ['draft']));
    }
    for (const [position, item] of b.items.entries()) {
      writes.push(db.prepare('UPDATE c_items SET claim_id=?,position=? WHERE id=? AND claim_id=?').bind(result, position, item.id, item.sourceClaim));
      if (item.receipt) writes.push(db.prepare('UPDATE c_receipts SET claim_id=? WHERE id=? AND claim_id=?').bind(result, item.receipt.id, item.sourceClaim));
    }
    for (const source of b.sources) writes.push(claimTotal(db, source.id), event(db, actor, 'trip-expenses-grouped', { claim: source.id }, { proposal: p.id, destination: result, agent: p.agent_label }));
    writes.push(claimTotal(db, result));
  }
  writes.push(db.prepare("UPDATE c_proposals SET status='accepted',decided_by=?,decided_at=?,result_id=? WHERE id=?").bind(actor.email, now(), result, p.id), event(db, actor, 'proposal-accepted', result ? { claim: result } : {}, { proposal: p.id, agent: p.agent_label, preparation: b.preparation }));
  await commit(db, all(authority(actor, b.preparation === 'close' ? 'owner' : 'employee'), ...guards), writes);
  return { proposal: { ...p, status: 'accepted' }, ...(result ? { claim: await loadClaim(db, result) } : {}) };
}
