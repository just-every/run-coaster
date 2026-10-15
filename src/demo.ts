import type { Bindings } from './auth.server';
import { claimItems, claimNumber, insertItem } from './coaster/claims';
import { batchNumber } from './coaster/batches';
import { exactKey, findExceptions } from './coaster/exceptions';
import { itemInput, type Category } from './coaster/items';
import { sha256Hex } from './coaster/session';
import { business, batches, categories, claims, people, proposal, type DemoClaim, type Expense, type Person } from './demo-data';
import { receiptPdf } from './demo-receipt';
import type { Data } from './coaster/types';

const DAY = 86_400_000;
type Event = { id: string; at: string; actor: string; action: string; claim?: string; batch?: string; detail: Data };

/**
 * `rer demo` and the hosted demo: Harbour & Finch Studio's claims at every stage, written once
 * after the owner exists. Claims waiting for the owner's approval, a draft batch for them to
 * review, approved claims to batch and an agent's proposal are left for the visitor to act on.
 * Fixed ids; a workspace that already has a business is left as it is. It never fetches.
 */
export async function seedDemo(env: Bindings, { ownerEmail, now }: { ownerEmail: string; now: Date }) {
  const db = env.DB, ownerAddress = ownerEmail.toLowerCase(), t = now.getTime();
  const at = (days: number, minutes = 0) => new Date(t - days * DAY + minutes * 60_000).toISOString();
  const date = (days: number) => at(days).slice(0, 10);
  const email = (p: Person) => p === 'owner' ? ownerAddress : people[p].email;
  const owner = await db.prepare('SELECT id,display_name FROM oa_operators WHERE lower(email)=? AND role=\'owner\'').bind(ownerAddress).first<{ id: string; display_name: string }>();
  if (!owner) throw new Error('The demo owner does not exist yet');
  const policy = { name: business.name, currency: business.currency, timezone: business.timezone, mileage_rate_minor: business.mileageRateMinor, per_diem_minor: business.perDiemMinor, receipt_threshold_minor: business.receiptThresholdMinor };
  const known: Category[] = categories.map(c => ({ id: c.id, name: c.name, account_code: c.account, tax_code: c.tax, limit_minor: c.limitMinor, active: 1 }));
  const raw = (e: Expense) => ({ kind: e.kind, date: date(e.day), merchant: e.merchant, description: e.description, explanation: e.explanation,
    amount: e.kind === 'receipt' ? e.amount : undefined, distance: e.kind === 'mileage' ? e.km : undefined, days: e.kind === 'per_diem' ? e.days : undefined,
    allocations: e.split ? e.split.map(([category, costCentre, amount]) => ({ category: `demo-cat-${category}`, costCentre, amount })) : [{ category: `demo-cat-${e.category}`, costCentre: e.costCentre }] });
  const ordered = [...claims].sort((a, b) => b.created - a.created), number = new Map(ordered.map((c, i) => [c.id, i + 1]));
  const batchOf = new Map(batches.map(b => [b.id, b]));
  const status = (c: DemoClaim) => {
    const batch = c.batch ? batchOf.get(c.batch) : undefined;
    return batch ? batch.paid ? 'reimbursed' : 'batched' : c.decision?.decision ?? (c.submitted === undefined ? 'draft' : 'submitted');
  };
  const approverOf = (p: Person) => p === 'owner' ? 'priya' : people[p].approver;
  const events: Event[] = [];
  const event = (id: string, when: string, actor: string, action: string, target: { claim?: string; batch?: string }, detail: Data = {}) => events.push({ id: `demo-event-${id}`, at: when, actor, action, ...target, detail });

  // The business, its policy and its people, then every claim's expenses and receipt files.
  if (!await db.prepare('SELECT 1 FROM c_business WHERE id=1').first()) {
    const setup: D1PreparedStatement[] = [
      db.prepare('INSERT INTO c_business(id,name,currency,timezone,mileage_rate_minor,per_diem_minor,receipt_threshold_minor,updated_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(business.name, business.currency, business.timezone, business.mileageRateMinor, business.perDiemMinor, business.receiptThresholdMinor, at(42)),
      ...known.map(c => db.prepare('INSERT INTO c_categories(id,name,account_code,tax_code,limit_minor,active) VALUES(?,?,?,?,?,1) ON CONFLICT DO NOTHING').bind(c.id, c.name, c.account_code, c.tax_code, c.limit_minor)),
      db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,approver_email,active,updated_at) VALUES(?,?,1,1,1,?,1,?) ON CONFLICT DO NOTHING').bind(ownerAddress, owner.display_name, people.priya.email, at(42)),
      ...Object.values(people).map(p => db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,approver_email,active,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(p.email, p.name, +p.employee, +p.manager, +p.finance, p.approver && email(p.approver), +p.active, at(42))),
      db.prepare('INSERT INTO oa_first_run(singleton,completed_by,completed_at) VALUES(1,?,?) ON CONFLICT DO NOTHING').bind(owner.id, t - 42 * DAY),
    ];
    for (const c of claims) {
      const employee = email(c.employee), items = c.expenses.map(e => itemInput(raw(e), policy, known));
      const files = await Promise.all(c.expenses.map(async (e, i) => {
        if (e.kind !== 'receipt' || e.noReceipt) return null;
        const lines = e.lines ?? [[e.description ?? e.merchant, e.amount]];
        const bytes = receiptPdf([e.merchant, `Tax invoice  ${date(e.day)}`, ...lines.map(([what, amount]) => `${what}  ${amount}`), `Total AUD ${e.amount}`, 'GST included', 'Thank you']);
        return { id: `${c.id}-receipt-${i + 1}`, name: `${e.merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${date(e.day)}.pdf`, bytes, sha: await sha256Hex(bytes) };
      }));
      const submitted = c.submitted !== undefined, decided = c.decision ? 1 : 0, batched = c.batch ? 1 : 0, paid = c.batch && batchOf.get(c.batch)?.paid ? 1 : 0;
      const version = 1 + items.length + files.filter(Boolean).length + +submitted + decided + batched + paid;
      setup.push(db.prepare('INSERT INTO c_claims(id,number,employee_email,approver_email,title,status,revision,version,total_minor,currency,batch_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(c.id, number.get(c.id), employee, submitted ? email(approverOf(c.employee)!) : null, c.title, status(c), +submitted, version, items.reduce((n, i) => n + i.amount_minor, 0), business.currency, null, at(c.created), at(Math.min(c.created, c.submitted ?? c.created, c.decision?.day ?? c.created))));
      files.forEach(f => f && setup.push(db.prepare("INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,'application/pdf',?,?,?,'upload',?,?) ON CONFLICT DO NOTHING").bind(f.id, c.id, employee, f.name, f.bytes.length, f.sha, f.bytes, employee, at(c.created, 5))));
      items.forEach((item, i) => setup.push(...insertItem(db, c.id, `${c.id}-item-${i + 1}`, i, item, files[i]?.id ?? null)));
    }
    await db.batch(setup);
  }

  // History: each claim's own lines, its frozen submitted revision and its decision, as Coaster records them.
  const history: D1PreparedStatement[] = [], totals = new Map<string, number>();
  for (const c of claims) {
    const employee = email(c.employee), claimNo = number.get(c.id)!;
    event(`${c.id}-created`, at(c.created), employee, 'claim-created', { claim: c.id }, { title: c.title });
    const items = await claimItems(db, c.id);
    items.forEach((item, i) => {
      if (item.receipt_id) event(`${c.id}-receipt-${i + 1}`, at(c.created, 2 + i * 2), employee, 'receipt-added', { claim: c.id }, { receipt: item.receipt_id, name: item.receipt_name, sha256: item.receipt_sha256, size: item.receipt_size, item: null, source: 'upload' });
      event(`${c.id}-item-${i + 1}`, at(c.created, 3 + i * 2), employee, 'expense-added', { claim: c.id }, { item: item.id, merchant: item.merchant, amountMinor: item.amount_minor, receipt: item.receipt_id });
    });
    if (c.submitted === undefined) continue;
    const approver = email(approverOf(c.employee)!), claim = { id: c.id, employee_email: employee };
    const exceptions = await findExceptions(db, claim, items, policy, known), total = items.reduce((n, i) => n + i.amount_minor, 0);
    totals.set(c.id, total);
    const snapshot = { title: c.title, approver, currency: business.currency, total_minor: total, exceptions, items: items.map(({ receipt_sha256, receipt_name, receipt_media, receipt_size, ...item }) => ({ ...item, receipt: item.receipt_id ? { id: item.receipt_id, name: receipt_name, sha256: receipt_sha256, size: receipt_size, media_type: receipt_media } : null })) };
    history.push(db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,1,?,?,?,?) ON CONFLICT DO NOTHING').bind(c.id, employee, at(c.submitted, 60), total, JSON.stringify(snapshot)));
    event(`${c.id}-submitted`, at(c.submitted, 60), employee, 'claim-submitted', { claim: c.id }, { revision: 1, totalMinor: total, exceptions: exceptions.length, note: '' });
    if (c.decision) {
      const d = c.decision, reason = d.reason ?? '';
      history.push(db.prepare('INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions) VALUES(?,?,1,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(`${c.id}-decision`, c.id, d.decision, reason, email(d.by), at(d.day, 120), JSON.stringify(exceptions)));
      event(`${c.id}-decided`, at(d.day, 120), email(d.by), `claim-${d.decision}`, { claim: c.id }, { revision: 1, reason, exceptionsAcknowledged: d.decision === 'approved' ? exceptions.length : 0 });
    }
    const batch = c.batch ? batchOf.get(c.batch) : undefined;
    if (batch) {
      history.push(db.prepare('UPDATE c_claims SET batch_id=? WHERE id=? AND batch_id IS NULL').bind(batch.id, c.id));
      history.push(db.prepare('INSERT INTO c_batch_claims(batch_id,claim_id,revision,amount_minor) VALUES(?,?,1,?) ON CONFLICT DO NOTHING').bind(batch.id, c.id, total));
      for (const item of items) history.push(db.prepare('INSERT INTO c_reimbursement_keys(key,batch_id,claim_id,item_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(exactKey(employee, item), batch.id, c.id, item.id));
      event(`${c.id}-batched`, at(batch.created, claimNo), email(batch.createdBy), 'claim-batched', { claim: c.id, batch: batch.id }, { claim: claimNumber(claimNo), batch: batchNumber(batch.number) });
    }
  }

  // Reimbursement batches: one paid, one draft waiting for review.
  for (const b of batches) {
    const members = claims.filter(c => c.batch === b.id);
    const total = members.reduce((n, c) => n + totals.get(c.id)!, 0);
    const state = b.paid ? 'reimbursed' : b.reviewedBy ? 'approved' : 'draft', version = 1 + (b.reviewedBy ? 1 : 0) + (b.paid ? 1 : 0);
    history.unshift(db.prepare('INSERT INTO c_batches(id,number,status,currency,total_minor,version,created_by,created_at,reviewed_by,reviewed_at,paid_reference,paid_on,paid_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(b.id, b.number, state, business.currency, total, version, email(b.createdBy), at(b.created, 30), b.reviewedBy ? email(b.reviewedBy) : null, b.reviewed !== undefined ? at(b.reviewed, 60) : null, b.paid?.reference ?? null, b.paid ? date(b.paid.day) : null, b.paid ? email(b.paid.by) : null));
    event(`${b.id}-created`, at(b.created, 30), email(b.createdBy), 'batch-created', { batch: b.id }, { claims: members.length, totalMinor: total, preparedBy: null });
    if (b.reviewedBy && b.reviewed !== undefined) event(`${b.id}-approved`, at(b.reviewed, 60), email(b.reviewedBy), 'batch-approved', { batch: b.id }, { totalMinor: total, claims: members.length });
    if (b.exported !== undefined) event(`${b.id}-exported`, at(b.exported, 90), email(b.reviewedBy ?? b.createdBy), 'batch-exported', { batch: b.id }, { file: 'accounting', rows: members.reduce((n, c) => n + c.expenses.length, 0), totalMinor: total });
    if (b.paid) event(`${b.id}-paid`, at(b.paid.day, 30), email(b.paid.by), 'batch-reimbursed', { batch: b.id }, { reference: b.paid.reference, paidOn: date(b.paid.day), note: '' });
  }

  // The owner's agent key and the claim its agent has prepared for them to accept or decline.
  const agentFor = `${proposal.agent} for ${ownerAddress}`, keyHash = await sha256Hex(`demo-agent-key:${crypto.randomUUID()}`);
  history.push(db.prepare('INSERT INTO c_agent_keys(id,member_email,label,token_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(proposal.key, ownerAddress, proposal.agent, keyHash, at(14)));
  const proposalReceipts: D1PreparedStatement[] = [];
  const proposed = await Promise.all(proposal.items.map(async (item, i) => {
    const bytes = receiptPdf(['Uber', `Trip receipt  ${date(item.day)}`, `${item.description}  ${item.amount}`, `Total AUD ${item.amount}`, 'GST included']);
    const id = `${proposal.id}-receipt-${i + 1}`;
    proposalReceipts.push(db.prepare("INSERT INTO c_receipts(id,proposal_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,'application/pdf',?,?,?,'agent',?,?) ON CONFLICT DO NOTHING").bind(id, proposal.id, ownerAddress, `uber-${date(item.day)}.pdf`, bytes.length, await sha256Hex(bytes), bytes, agentFor, at(proposal.created)));
    const amountMinor = itemInput({ kind: 'receipt', date: date(item.day), merchant: item.merchant, amount: item.amount, category: `demo-cat-${item.category}` }, policy, known).amount_minor;
    return { kind: 'receipt', date: date(item.day), merchant: item.merchant, amount: item.amount, description: item.description, category: `demo-cat-${item.category}`, receiptId: id, amountMinor };
  }));
  history.push(db.prepare("INSERT INTO c_proposals(id,kind,agent_label,for_email,payload,status,created_at) VALUES(?,'claim',?,?,?,'proposed',?) ON CONFLICT DO NOTHING").bind(proposal.id, proposal.agent, ownerAddress, JSON.stringify({ title: proposal.title, note: proposal.note, items: proposed }), at(proposal.created)), ...proposalReceipts);
  event('agent-key', at(14), ownerAddress, 'agent-key-created', {}, { key: proposal.key, label: proposal.agent });
  event('proposal', at(proposal.created), ownerAddress, 'claim-proposed', {}, { proposal: proposal.id, title: proposal.title, expenses: proposed.length, agent: proposal.agent });

  // History lines are numbered in the order they happened.
  events.sort((a, b) => a.at.localeCompare(b.at));
  history.push(...events.map((e, i) => db.prepare('INSERT INTO c_events(id,seq,at,actor_email,action,claim_id,batch_id,detail) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(e.id, i + 1, e.at, e.actor, e.action, e.claim ?? null, e.batch ?? null, JSON.stringify(e.detail))));
  await db.batch(history);
}
