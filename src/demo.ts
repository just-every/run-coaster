import type { Bindings } from './auth.server';
import { claimItems, claimNumber, insertItem } from './coaster/claims';
import { batchNumber } from './coaster/batches';
import { exactKey, findExceptions } from './coaster/exceptions';
import { itemInput, type Category } from './coaster/items';
import { IRS_MILEAGE_RATES, seedIrsRates } from './coaster/mileage';
import { sha256Hex } from './coaster/session';
import { business, batches, categories, claims, firstClaimNumber, ownerApprover, ownerName, people, proposal, signIns, type DemoClaim, type Expense, type Person } from './demo-data';
import { receiptPdf } from './demo-receipt';
import { ownerPolicyVersion } from './coaster/policy-configuration';
import type { Data } from './coaster/types';

const DAY = 86_400_000;
/** "10/13/2026" as a US till prints it. */
const receiptDay = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
type Event = { id: string; at: string; actor: string; action: string; claim?: string; batch?: string; detail: Data };

/**
 * `rer demo` and the hosted demo: Tallgrass Outdoor Co.'s claims at every stage, written once
 * after the owner exists. Claims waiting for the owner's approval, a draft batch for them to
 * review, approved claims to batch and an agent's proposal are left for the visitor to act on.
 * Fixed ids; a workspace that already has a business is left as it is. It never fetches.
 */
export async function seedDemo(env: Bindings, { ownerEmail, now }: { ownerEmail: string; now: Date }) {
  const db = env.DB, ownerAddress = ownerEmail.toLowerCase();
  // Every day counts back from 8:00 AM in the business's own timezone on the day the demo starts, in working days:
  // day n is the nth weekday before that day, so visits, submissions and approvals never land on a weekend.
  const clock = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: business.timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const t = now.getTime() - (Number(clock.hour) * 60 + Number(clock.minute)) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 8 * 3_600_000;
  const startDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(clock.weekday);
  const calendarDays = (workingDays: number) => {
    let days = 0;
    for (let left = workingDays; left > 0;) { days += 1; const weekday = (startDay - days % 7 + 7) % 7; if (weekday !== 0 && weekday !== 6) left -= 1; }
    return days;
  };
  const at = (days: number, minutes = 0) => new Date(t - calendarDays(days) * DAY + minutes * 60_000).toISOString();
  const date = (days: number) => at(days).slice(0, 10);
  const email = (p: Person) => p === 'owner' ? ownerAddress : people[p].email;
  const owner = await db.prepare('SELECT id FROM oa_operators WHERE lower(email)=? AND role=\'owner\'').bind(ownerAddress).first<{ id: string }>();
  if (!owner) throw new Error('The demo owner does not exist yet');
  const policy = { name: business.name, currency: business.currency, timezone: business.timezone, per_diem_minor: business.perDiemMinor, receipt_threshold_minor: business.receiptThresholdMinor, sales_tax_account: '', sales_tax_code: '', preapproval_threshold_minor: null, audit_sample_percent: null, reminder_days: [2, 5, 10], quiet_from: 20, quiet_until: 8, service_level_days: 3, escalation_days: 2, auto_submit: null, retention_years: 7, dual_release_over_minor: null, pay_weekday: null, mileage_rates: IRS_MILEAGE_RATES };
  const known: Category[] = categories.map(c => ({ id: c.id, name: c.name, account_code: c.account, tax_code: c.tax, limit_minor: c.limitMinor, active: 1, receipt_always: +(c.id === 'demo-cat-lodging'), per_person_limit_minor: null, required_fields: [] }));
  const raw = (e: Expense) => ({ kind: e.kind, date: date(e.day), merchant: e.merchant, description: e.description, explanation: e.explanation,
    amount: e.kind === 'receipt' ? e.amount : undefined, distance: e.kind === 'mileage' ? e.miles : undefined, days: e.kind === 'per_diem' ? e.days : undefined,
    allocations: e.split ? e.split.map(([category, costCentre, amount]) => ({ category: `demo-cat-${category}`, costCentre, amount })) : [{ category: `demo-cat-${e.category}`, costCentre: e.costCentre }] });
  const ordered = [...claims].sort((a, b) => b.created - a.created), number = new Map(ordered.map((c, i) => [c.id, firstClaimNumber + i]));
  const batchOf = new Map(batches.map(b => [b.id, b]));
  const status = (c: DemoClaim) => {
    const batch = c.batch ? batchOf.get(c.batch) : undefined;
    return batch ? batch.paid ? 'reimbursed' : 'batched' : c.decision?.decision ?? (c.submitted === undefined ? 'draft' : 'submitted');
  };
  const approverOf = (p: Person) => p === 'owner' ? ownerApprover : people[p].approver;
  const events: Event[] = [];
  const event = (id: string, when: string, actor: string, action: string, target: { claim?: string; batch?: string }, detail: Data = {}) => events.push({ id: `demo-event-${id}`, at: when, actor, action, ...target, detail });

  // The business, its policy and its people, then every claim's expenses and receipt files.
  if (!await db.prepare('SELECT 1 FROM c_business WHERE id=1').first()) {
    const setup: D1PreparedStatement[] = [
      db.prepare('UPDATE oa_operators SET display_name=? WHERE id=?').bind(ownerName, owner.id),
      db.prepare('INSERT INTO c_business(id,name,currency,timezone,per_diem_minor,receipt_threshold_minor,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(business.name, business.currency, business.timezone, business.perDiemMinor, business.receiptThresholdMinor, at(31)),
      ...seedIrsRates(db),
      ...known.map(c => db.prepare('INSERT INTO c_categories(id,name,account_code,tax_code,limit_minor,active,receipt_always) VALUES(?,?,?,?,?,1,?) ON CONFLICT DO NOTHING').bind(c.id, c.name, c.account_code, c.tax_code, c.limit_minor, c.receipt_always)),
      db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,approver_email,active,updated_at) VALUES(?,?,1,1,1,?,1,?) ON CONFLICT DO NOTHING').bind(ownerAddress, ownerName, people[ownerApprover].email, at(31)),
      ...Object.values(people).map(p => db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,may_release,approver_email,active,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(p.email, p.name, +p.employee, +p.manager, +p.finance, +p.finance, p.approver && email(p.approver), +p.active, at(31))),
      // Jordan, Dana and Ruth sign in as themselves from the demo's sign-in page (one-click, as invited people do).
      ...signIns.map((p, i) => db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES(?,?,?,'member','active',?) ON CONFLICT(email) DO NOTHING").bind(`demo-operator-${p}`, people[p].email, people[p].name, Date.parse(at(31)) + i)),
      db.prepare('INSERT INTO oa_first_run(singleton,completed_by,completed_at) VALUES(1,?,?) ON CONFLICT DO NOTHING').bind(owner.id, Date.parse(at(31))),
    ];
    for (const c of claims) {
      const employee = email(c.employee), items = c.expenses.map(e => itemInput(raw(e), policy, known));
      const files = await Promise.all(c.expenses.map(async (e, i) => {
        if (e.kind !== 'receipt' || e.noReceipt) return null;
        const lines = e.lines ?? [[e.description ?? e.merchant, e.amount]];
        const bytes = receiptPdf([e.merchant, e.city, `Receipt  ${receiptDay(date(e.day))}`, ...lines.map(([what, amount]) => `${what}  $${amount}`), `Total  $${e.amount}`, 'Thank you']);
        return { id: `${c.id}-receipt-${i + 1}`, name: `${e.merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${date(e.day)}.pdf`, bytes, sha: await sha256Hex(bytes) };
      }));
      const submitted = c.submitted !== undefined, decided = c.decision ? 1 : 0, batched = c.batch ? 1 : 0, paid = c.batch && batchOf.get(c.batch)?.paid ? 1 : 0;
      const version = 1 + items.length + files.filter(Boolean).length + +submitted + decided + batched + paid;
      setup.push(db.prepare('INSERT INTO c_claims(id,number,employee_email,approver_email,title,status,revision,version,total_minor,currency,batch_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(c.id, number.get(c.id), employee, submitted ? email(approverOf(c.employee)!) : null, c.title, status(c), +submitted, version, items.reduce((n, i) => n + i.amount_minor, 0), business.currency, null, at(c.created), at(Math.min(c.created, c.submitted ?? c.created, c.decision?.day ?? c.created))));
      files.forEach(f => f && setup.push(db.prepare("INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,'application/pdf',?,?,?,'upload',?,?) ON CONFLICT DO NOTHING").bind(f.id, c.id, employee, f.name, f.bytes.length, f.sha, f.bytes, employee, at(c.created, 5))));
      items.forEach((item, i) => setup.push(...insertItem(db, c.id, `${c.id}-item-${i + 1}`, i, item, files[i]?.id ?? null)));
    }
    setup.push(...ownerPolicyVersion(db, ownerAddress, business.timezone, now.toISOString()));
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
    const submittedAt = at(c.submitted, c.submittedMinutes ?? 60);
    history.push(db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,1,?,?,?,?) ON CONFLICT DO NOTHING').bind(c.id, employee, submittedAt, total, JSON.stringify(snapshot)));
    event(`${c.id}-submitted`, submittedAt, employee, 'claim-submitted', { claim: c.id }, { revision: 1, totalMinor: total, exceptions: exceptions.length, note: '' });
    if (c.decision) {
      const d = c.decision, reason = d.reason ?? '', decidedAt = at(d.day, d.minutes ?? 120);
      history.push(db.prepare('INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions) VALUES(?,?,1,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(`${c.id}-decision`, c.id, d.decision, reason, email(d.by), decidedAt, JSON.stringify(exceptions)));
      event(`${c.id}-decided`, decidedAt, email(d.by), `claim-${d.decision}`, { claim: c.id }, { revision: 1, reason, exceptionsAcknowledged: d.decision === 'approved' ? exceptions.length : 0 });
    }
    const batch = c.batch ? batchOf.get(c.batch) : undefined;
    if (batch) {
      history.push(db.prepare('UPDATE c_claims SET batch_id=? WHERE id=? AND batch_id IS NULL').bind(batch.id, c.id));
      history.push(db.prepare('INSERT INTO c_batch_claims(batch_id,claim_id,revision,amount_minor) VALUES(?,?,1,?) ON CONFLICT DO NOTHING').bind(batch.id, c.id, total));
      for (const item of items) history.push(db.prepare('INSERT INTO c_reimbursement_keys(key,batch_id,claim_id,item_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(exactKey(employee, item), batch.id, c.id, item.id));
      event(`${c.id}-batched`, at(batch.created, (batch.minutes ?? 0) + 30 + claimNo - firstClaimNumber), email(batch.createdBy), 'claim-batched', { claim: c.id, batch: batch.id }, { claim: claimNumber(claimNo), batch: batchNumber(batch.number) });
    }
  }

  // Reimbursement batches: one paid, one draft waiting for review.
  for (const b of batches) {
    const members = claims.filter(c => c.batch === b.id);
    const total = members.reduce((n, c) => n + totals.get(c.id)!, 0);
    const state = b.paid ? 'reimbursed' : b.reviewedBy ? 'approved' : 'draft', version = 1 + (b.reviewedBy ? 1 : 0) + (b.paid ? 1 : 0);
    // A paid batch was released (PAY-004) by whoever recorded its payment, a minute before.
    history.unshift(db.prepare('INSERT INTO c_batches(id,number,status,currency,total_minor,version,created_by,created_at,reviewed_by,reviewed_at,paid_reference,paid_on,paid_by,released_by,released_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(b.id, b.number, state, business.currency, total, version + (b.paid ? 1 : 0), email(b.createdBy), at(b.created, (b.minutes ?? 0) + 30), b.reviewedBy ? email(b.reviewedBy) : null, b.reviewed !== undefined ? at(b.reviewed, (b.minutes ?? 0) + 60) : null, b.paid?.reference ?? null, b.paid ? date(b.paid.day) : null, b.paid ? email(b.paid.by) : null, b.paid ? email(b.paid.by) : null, b.paid ? at(b.paid.day, 29) : null));
    event(`${b.id}-created`, at(b.created, (b.minutes ?? 0) + 30), email(b.createdBy), 'batch-created', { batch: b.id }, { claims: members.length, totalMinor: total, preparedBy: null });
    if (b.reviewedBy && b.reviewed !== undefined) event(`${b.id}-approved`, at(b.reviewed, (b.minutes ?? 0) + 60), email(b.reviewedBy), 'batch-approved', { batch: b.id }, { totalMinor: total, claims: members.length });
    if (b.exported !== undefined) event(`${b.id}-exported`, at(b.exported, (b.minutes ?? 0) + 90), email(b.reviewedBy ?? b.createdBy), 'batch-exported', { batch: b.id }, { file: 'accounting', rows: members.reduce((n, c) => n + c.expenses.length, 0), totalMinor: total });
    if (b.paid) event(`${b.id}-released`, at(b.paid.day, 29), email(b.paid.by), 'batch-released', { batch: b.id }, { totalMinor: total, recentSignIn: at(b.paid.day, 28) });
    if (b.paid) event(`${b.id}-paid`, at(b.paid.day, 30), email(b.paid.by), 'batch-reimbursed', { batch: b.id }, { reference: b.paid.reference, paidOn: date(b.paid.day), note: '' });
  }

  // The owner's agent key and the claim its agent has prepared for them to accept or decline.
  const agentFor = `${proposal.agent} for ${ownerAddress}`, keyHash = await sha256Hex(`demo-agent-key:${crypto.randomUUID()}`);
  history.push(db.prepare('INSERT INTO c_agent_keys(id,member_email,label,token_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(proposal.key, ownerAddress, proposal.agent, keyHash, at(11)));
  const proposalReceipts: D1PreparedStatement[] = [];
  const proposed = await Promise.all(proposal.items.map(async (item, i) => {
    const bytes = receiptPdf(['Lyft', 'Kansas City, MO', `Ride receipt  ${receiptDay(date(item.day))}`, `${item.description}  $${item.amount}`, `Total  $${item.amount}`]);
    const id = `${proposal.id}-receipt-${i + 1}`;
    proposalReceipts.push(db.prepare("INSERT INTO c_receipts(id,proposal_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,'application/pdf',?,?,?,'agent',?,?) ON CONFLICT DO NOTHING").bind(id, proposal.id, ownerAddress, `lyft-${date(item.day)}.pdf`, bytes.length, await sha256Hex(bytes), bytes, agentFor, at(proposal.created)));
    const amountMinor = itemInput({ kind: 'receipt', date: date(item.day), merchant: item.merchant, amount: item.amount, category: `demo-cat-${item.category}` }, policy, known).amount_minor;
    return { kind: 'receipt', date: date(item.day), merchant: item.merchant, amount: item.amount, description: item.description, category: `demo-cat-${item.category}`, receiptId: id, amountMinor };
  }));
  history.push(db.prepare("INSERT INTO c_proposals(id,kind,agent_label,for_email,payload,status,created_at) VALUES(?,'claim',?,?,?,'proposed',?) ON CONFLICT DO NOTHING").bind(proposal.id, proposal.agent, ownerAddress, JSON.stringify({ title: proposal.title, note: proposal.note, items: proposed }), at(proposal.created)), ...proposalReceipts);
  event('agent-key', at(11), ownerAddress, 'agent-key-created', {}, { key: proposal.key, label: proposal.agent });
  event('proposal', at(proposal.created), ownerAddress, 'claim-proposed', {}, { proposal: proposal.id, title: proposal.title, expenses: proposed.length, agent: proposal.agent });

  // History lines are numbered in the order they happened.
  events.sort((a, b) => a.at.localeCompare(b.at));
  history.push(...events.map((e, i) => db.prepare('INSERT INTO c_events(id,seq,at,actor_email,action,claim_id,batch_id,detail) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(e.id, i + 1, e.at, e.actor, e.action, e.claim ?? null, e.batch ?? null, JSON.stringify(e.detail))));
  await db.batch(history);
}
