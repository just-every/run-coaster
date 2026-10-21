import { all, authority, commit, need, type Sql } from '../session';
import { event } from '../events';
import { claimState, claimTotal, insertClaim, insertItem } from '../claims';
import type { ItemInput } from '../items';
import { email, now, requireThat, uid, type Actor, type Data } from '../types';
import { categoryFor, planStatement, type Held } from './plan';

const person = (actor: Actor) => requireThat(actor.kind === 'person', 'Only a person imports statements', 403);

/** The owner assigns a card (issuer label and last four) to an active employee. Assignment is prospective: charges already
 * imported keep their cardholder (S5). */
export async function assignCard(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  person(actor);
  requireThat(typeof b.issuer === 'string' && b.issuer.trim() && b.issuer.length <= 60, 'Name the card issuer');
  requireThat(typeof b.last4 === 'string' && /^\d{4}$/.test(b.last4), 'Give the last four digits of the card, and never the full number');
  const issuer = b.issuer.trim().replace(/\s+/g, ' '), holder = email(b.employee, 'Cardholder');
  requireThat(await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1').bind(holder).first(), 'The cardholder must be an active employee', 409);
  const known = await db.prepare('SELECT id,employee_email FROM c_cards WHERE lower(issuer)=? AND last4=?').bind(issuer.toLowerCase(), b.last4).first<{ id: string; employee_email: string }>();
  const id = known?.id ?? uid(), at = now();
  await commit(db, all(authority(actor, 'owner'), { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1)', params: [holder] }), [
    known ? db.prepare('UPDATE c_cards SET employee_email=?,assigned_by=?,assigned_at=? WHERE id=?').bind(holder, actor.email, at, id) : db.prepare('INSERT INTO c_cards(id,issuer,last4,employee_email,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)').bind(id, issuer, b.last4, holder, actor.email, at),
    event(db, actor, 'card-assigned', {}, { card: id, issuer, last4: b.last4, employee: holder, previous: known?.employee_email ?? null }),
  ]);
  return { id, issuer, last4: b.last4, employee: holder };
}

/** Where a charge lands (G5): the cardholder's own draft automatic report for the expense month, never a hand-built claim.
 * A report holds at most 100 expenses, so a busy month continues in a further automatic report. */
async function placements(db: D1Database, held: Held[]) {
  const groups = new Map<string, Held[]>();
  for (const h of held) groups.set(`${h.employee}|${h.date.slice(0, 7)}`, [...(groups.get(`${h.employee}|${h.date.slice(0, 7)}`) ?? []), h]);
  const business = (await db.prepare('SELECT currency FROM c_business WHERE id=1').first<{ currency: string }>())!;
  const claims = new Map<string, { id: string; version: number | null; position: number; room: number; created: boolean; employee: string; month: string }>(), guards: Sql[] = [], statements: D1PreparedStatement[] = [], where = new Map<string, string>();
  for (const [group, rows] of groups) {
    const [employee, month] = group.split('|'), key = `month:${month}`;
    const drafts = (await db.prepare("SELECT c.id,c.version,(SELECT COUNT(*) FROM c_items i WHERE i.claim_id=c.id) AS n,(SELECT COALESCE(MAX(position),-1)+1 FROM c_items i WHERE i.claim_id=c.id) AS next FROM c_claims c WHERE c.employee_email=? AND c.auto_key=? AND c.status='draft' ORDER BY c.number").bind(employee, key).all<{ id: string; version: number; n: number; next: number }>()).results;
    let open = drafts.map(d => ({ id: d.id, version: d.version as number | null, position: d.next, room: 100 - d.n, created: false, employee, month })).filter(d => d.room > 0)[0];
    for (const h of rows) {
      if (!open || open.room <= 0) {
        open = { id: uid(), version: null, position: 0, room: 100, created: true, employee, month };
        statements.push(insertClaim(db, open.id, employee, `Expenses · ${month}`, business.currency, null), db.prepare('UPDATE c_claims SET auto_key=? WHERE id=?').bind(key, open.id));
      }
      claims.set(open.id, open);
      where.set(h.id, `${open.id}|${open.position}`);
      open.position++; open.room--;
    }
  }
  for (const c of claims.values()) if (!c.created) guards.push(claimState(c.id, c.version!, ['draft']));
  return { claims, guards, statements, where };
}

/** Commit applies exactly the previewed bytes and mapping: each importable purchase becomes one company-card expense. */
export async function commitStatement(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'finance');
  person(actor);
  const plan = await planStatement(db, b), { review } = plan, category = await categoryFor(db, plan.category);
  requireThat(b.fingerprint === plan.fingerprint, 'The file or its choices changed since the preview; preview again', 409);
  requireThat(!plan.alreadyImported, 'This file and mapping were already imported; undo that import first to import it again', 409);
  requireThat(!review.errors.length, `Resolve the file errors before importing: ${review.errors.slice(0, 3).join('; ')}`, 409);
  requireThat(!review.unassigned.length, `Assign card ····${review.unassigned.join(', ····')} to an employee, or exclude it, before importing`, 409);
  requireThat(plan.importable.length > 0, 'This file has no new purchases to import', 409);
  const id = uid(), at = now(), place = await placements(db, plan.importable);
  const statements: D1PreparedStatement[] = [
    db.prepare('INSERT INTO c_statement_files(id,name,format,issuer,fingerprint,sha256,size,bytes,period_start,period_end,mapping,excluded_cards,included_rows,charges,total_minor,imported_by,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, plan.statement.name, plan.statement.format, plan.statement.issuer, plan.fingerprint, plan.sha, plan.bytes.length, plan.bytes, plan.statement.period.start, plan.statement.period.end, JSON.stringify({ ...plan.statement.mapping, coding: { category: plan.category, costCentre: plan.costCentre } }), JSON.stringify(plan.exclude), JSON.stringify(plan.include), plan.importable.length, review.totalMinor, actor.email, at),
    ...place.statements,
  ];
  const cardGuards: Sql[] = [...new Set(plan.importable.map(h => `${h.cardId}|${h.employee}`))].map(x => { const [card, holder] = x.split('|'); return { sql: 'EXISTS(SELECT 1 FROM c_cards c JOIN c_members m ON m.email=c.employee_email AND m.active=1 AND m.is_employee=1 WHERE c.id=? AND c.employee_email=?)', params: [card, holder] }; });
  const issuer = plan.statement.issuer;
  for (const h of plan.importable) {
    const [claimId, position] = place.where.get(h.id)!.split('|'), chargeId = uid(), itemId = uid(), r = h.row;
    const item: ItemInput = { kind: 'receipt', spent_on: h.date, merchant: r.descriptor.slice(0, 200), description: r.memo, amount_minor: r.amountMinor!, distance_hundredths: null, days: null, rate_thousandths: null, explanation: '', allocations: [{ category_id: category.id, cost_centre: plan.costCentre, amount_minor: r.amountMinor! }], sales_tax_minor: 0, sales_tax_account: '', sales_tax_code: '', attendees: [], fields: {}, billable: false, customer: '', project: '', card_charge_id: chargeId };
    statements.push(
      db.prepare('INSERT INTO c_card_charges(id,file_id,card_id,employee_email,transaction_key,posted_on,transaction_on,descriptor,memo,amount_minor,currency,original_minor,original_currency,item_id,category_id,created_at,claim_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(chargeId, id, h.cardId, h.employee, `card:${issuer.toLowerCase()}|${r.last4}:${r.key}`, r.postedOn, r.transactionOn, item.merchant, r.memo, r.amountMinor, r.currency, r.originalMinor, r.originalCurrency, itemId, category.id, at, claimId),
      ...insertItem(db, claimId, itemId, Number(position), item, null),
      event(db, actor, 'import-card-charge-created', { claim: claimId }, { charge: chargeId, file: id, issuer, last4: r.last4, merchant: item.merchant, amountMinor: r.amountMinor, postedOn: r.postedOn, transactionOn: r.transactionOn, cardholder: h.employee, reimbursable: false }),
    );
  }
  for (const c of place.claims.values()) statements.push(claimTotal(db, c.id));
  statements.push(event(db, actor, 'import-statement-committed', {}, { file: id, name: plan.statement.name, format: plan.statement.format, issuer, sha256: plan.sha, charges: plan.importable.length, totalMinor: review.totalMinor, period: plan.statement.period, excludedCards: plan.exclude, includedRows: plan.include, duplicates: review.duplicates.length, excludedRows: review.excluded.length, masked: true }));
  await commit(db, all(authority(actor, 'finance'), ...place.guards, ...cardGuards, { sql: 'NOT EXISTS(SELECT 1 FROM c_statement_files WHERE fingerprint=? AND undone_at IS NULL)', params: [plan.fingerprint] }), statements);
  return { ...review, file: id, claims: [...place.claims.keys()] };
}

/** An undo removes only charges still exactly as imported: on a draft report, with no receipt and no edit. It lists the rest. */
export async function undoStatement(db: D1Database, actor: Actor, id: string) {
  need(actor, 'finance');
  person(actor);
  const file = await db.prepare('SELECT id,name,mapping,undone_at FROM c_statement_files WHERE id=?').bind(id).first<{ id: string; name: string; mapping: string; undone_at: string | null }>();
  requireThat(file, 'Statement import not found', 404);
  requireThat(!file.undone_at, 'This import was already undone', 409);
  const coding = JSON.parse(file.mapping).coding as { category: string; costCentre: string };
  const rows = (await db.prepare(`SELECT ch.id AS charge,ch.item_id,ch.descriptor,ch.amount_minor,ch.memo,i.claim_id,c.status,c.version,i.receipt_id,i.explanation,i.description,i.attendees,i.fields,i.request_id,i.billable,i.customer,i.project,i.sales_tax_minor,i.allowance_id,
      (SELECT COUNT(*) FROM c_allocations a WHERE a.item_id=i.id) AS parts,(SELECT COUNT(*) FROM c_allocations a WHERE a.item_id=i.id AND a.category_id=? AND a.cost_centre=? AND a.amount_minor=i.amount_minor AND a.description='') AS as_imported
    FROM c_card_charges ch LEFT JOIN c_items i ON i.id=ch.item_id LEFT JOIN c_claims c ON c.id=i.claim_id WHERE ch.file_id=? ORDER BY ch.created_at,ch.id`).bind(coding.category, coding.costCentre, id).all<Data>()).results;
  const reason = (r: Data) => !r.claim_id ? 'its expense is gone' : r.status !== 'draft' ? `its report is ${r.status}` : r.receipt_id ? 'it has a receipt' : (r.explanation || r.description !== r.memo || r.attendees !== '[]' || r.fields !== '{}' || r.request_id || r.billable || r.customer || r.project || r.sales_tax_minor || r.allowance_id || r.parts !== 1 || !r.as_imported) ? 'it was edited' : '';
  const removable = rows.filter(r => !reason(r)), kept = rows.filter(r => reason(r)).map(r => ({ charge: r.charge, merchant: r.descriptor, amountMinor: r.amount_minor, reason: reason(r) }));
  const claims = new Map(removable.map(r => [r.claim_id as string, r.version as number]));
  const at = now();
  await commit(db, all(authority(actor, 'finance'), { sql: 'EXISTS(SELECT 1 FROM c_statement_files WHERE id=? AND undone_at IS NULL)', params: [id] }, ...[...claims].map(([claim, version]) => claimState(claim, version, ['draft']))), [
    db.prepare('UPDATE c_statement_files SET undone_at=?,undone_by=? WHERE id=? AND undone_at IS NULL').bind(at, actor.email, id),
    ...removable.flatMap(r => [
      db.prepare('DELETE FROM c_allocations WHERE item_id=?').bind(r.item_id), db.prepare('DELETE FROM c_items WHERE id=?').bind(r.item_id), db.prepare('DELETE FROM c_card_charges WHERE id=?').bind(r.charge),
      event(db, actor, 'import-card-charge-removed', { claim: r.claim_id }, { charge: r.charge, file: id, merchant: r.descriptor, amountMinor: r.amount_minor }),
    ]),
    ...[...claims.keys()].map(claim => claimTotal(db, claim)),
    event(db, actor, 'import-statement-undone', {}, { file: id, name: file.name, removed: removable.length, kept: kept.length }),
  ]);
  return { file: id, removed: removable.length, kept };
}

/** Cards, statement files and charges for the roles that read card spend (owner, finance, auditors). */
export async function statementState(db: D1Database, actor: Actor) {
  requireThat(actor.kind === 'person' && (actor.roles.owner || actor.roles.finance || actor.roles.auditor), 'Owner, finance or auditor access required', 403);
  const [cards, files, charges] = await db.batch([
    db.prepare('SELECT id,issuer,last4,employee_email,assigned_by,assigned_at FROM c_cards ORDER BY issuer,last4'),
    db.prepare("SELECT id,name,format,issuer,fingerprint,sha256,size,'card numbers masked' AS label,period_start,period_end,charges,total_minor,imported_by,imported_at,undone_at,undone_by FROM c_statement_files ORDER BY imported_at DESC,id"),
    db.prepare('SELECT ch.id,ch.file_id,ch.employee_email,ch.posted_on,ch.transaction_on,ch.descriptor,ch.amount_minor,ch.currency,ch.item_id,c.issuer,c.last4,i.claim_id FROM c_card_charges ch JOIN c_cards c ON c.id=ch.card_id LEFT JOIN c_items i ON i.id=ch.item_id ORDER BY ch.posted_on DESC,ch.id LIMIT 500'),
  ]);
  return { cards: cards.results, files: files.results, charges: charges.results };
}

/** The masked original of an import, as retained. */
export async function statementFile(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.kind === 'person' && (actor.roles.owner || actor.roles.finance || actor.roles.auditor), 'Owner, finance or auditor access required', 403);
  const file = await db.prepare('SELECT name,bytes FROM c_statement_files WHERE id=?').bind(id).first<{ name: string; bytes: ArrayBuffer }>();
  requireThat(file, 'Statement import not found', 404);
  return new Response(Uint8Array.from(file.bytes as unknown as ArrayLike<number>), { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${file.name.replace(/[^\w.-]/g, '_')}.card-numbers-masked.txt"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
