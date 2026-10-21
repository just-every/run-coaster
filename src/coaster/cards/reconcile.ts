import { all, authority, commit, need, type Sql } from '../session';
import { event } from '../events';
import { claimTotal } from '../claims';
import { amount, now, optionalText, requireThat, uid, type Actor, type Data } from '../types';
import { analyse, type Analysis, type StatementRecord } from './reconcile-analysis';
import { cardAccountMinor, ledgerLines } from './ledger';
import { chargeStatements, placements } from './charges';
import { categoryFor } from './plan';
import { chargeDate } from './statement';

const COLUMNS = 'id,file_id,card_id,period_start,period_end,opening_minor,statement_minor,opened_by,opened_at,closed_by,closed_at';
const finance = (actor: Actor) => { need(actor, 'finance'); requireThat(actor.kind === 'person', 'Only a person reconciles card statements', 403); };
const readers = (actor: Actor) => requireThat(actor.kind === 'person' && (actor.roles.owner || actor.roles.finance || actor.roles.auditor), 'Owner, finance or auditor access required', 403);
const isOpen = (id: string): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_card_statements WHERE id=? AND closed_at IS NULL)', params: [id] });

/** A balance as the card owes it: "1234.50", or "-20.00" when the card is in credit. */
function owed(value: unknown, label: string) {
  const raw = typeof value === 'number' ? String(value) : value;
  requireThat(typeof raw === 'string' && /^-?\d+(\.\d{1,2})?$/.test(raw.trim()), `${label} must be an amount like 1234.50 (negative when the card is in credit)`);
  const minor = amount(raw.trim().replace(/^-/, ''), label);
  return raw.trim().startsWith('-') ? -minor : minor;
}
async function load(db: D1Database, id: string) {
  const s = await db.prepare(`SELECT ${COLUMNS} FROM c_card_statements WHERE id=?`).bind(id).first<StatementRecord>();
  requireThat(s, 'Card statement not found', 404);
  return s;
}
const lastClosed = (db: D1Database, cardId: string) => db.prepare('SELECT id,period_end,statement_minor FROM c_card_statements WHERE card_id=? AND closed_at IS NOT NULL ORDER BY period_end DESC LIMIT 1').bind(cardId).first<{ id: string; period_end: string; statement_minor: number }>();

async function view(db: D1Database, s: StatementRecord, a?: Analysis) {
  const analysis = a ?? await analyse(db, s), closed = s.closed_at !== null;
  const ledger = closed ? (await db.prepare('SELECT seq,kind,debit_account,credit_account,amount_minor,ref,memo,posted_on FROM c_card_ledger WHERE statement_id=? ORDER BY seq').bind(s.id).all()).results : [];
  const cardAccount = closed ? await cardAccountMinor(db, analysis.card, s.closed_at!) : null;
  return {
    id: s.id, file: s.file_id, card: { id: analysis.card.id, issuer: analysis.card.issuer, last4: analysis.card.last4 }, period: { start: s.period_start, end: s.period_end },
    status: closed ? 'closed' : 'open', openedBy: s.opened_by, openedAt: s.opened_at, closedBy: s.closed_by, closedAt: s.closed_at,
    ...analysis.totals, differences: analysis.differences, unresolved: analysis.unresolved,
    ledger: closed ? { cardAccountMinor: cardAccount, statementMinor: s.statement_minor, matches: cardAccount === s.statement_minor, entries: ledger } : null,
  };
}

/** Owner, finance and auditors read every statement period with its derived differences and, once closed, its ledger. */
export async function reconciliations(db: D1Database, actor: Actor) {
  readers(actor);
  const rows = (await db.prepare(`SELECT ${COLUMNS} FROM c_card_statements ORDER BY period_end DESC,opened_at DESC,id`).all<StatementRecord>()).results;
  return { statements: await Promise.all(rows.map(s => view(db, s))) };
}
export async function reconciliation(db: D1Database, actor: Actor, id: string) {
  readers(actor);
  return view(db, await load(db, id));
}

/** Finance opens a statement period for one card of an imported statement file, or restates its balances while it is open.
 * The statement balance comes from the file's LEDGERBAL (finance supplies it for a CSV); the opening balance is the previous
 * closed statement's, and finance gives it for a card's first statement. */
export async function openReconciliation(db: D1Database, actor: Actor, fileId: string, b: Data) {
  finance(actor);
  const file = await db.prepare('SELECT id,undone_at,period_end FROM c_statement_files WHERE id=?').bind(fileId).first<{ id: string; undone_at: string | null; period_end: string | null }>();
  requireThat(file, 'Statement import not found', 404);
  requireThat(!file.undone_at, 'This import was undone; there is nothing to reconcile', 409);
  requireThat(typeof b.last4 === 'string' && /^\d{4}$/.test(b.last4), 'Name the card by its last four digits');
  const card = await db.prepare('SELECT c.id,c.issuer,c.last4 FROM c_cards c JOIN c_statement_files f ON lower(f.issuer)=lower(c.issuer) WHERE f.id=? AND c.last4=?').bind(fileId, b.last4).first<{ id: string; issuer: string; last4: string }>();
  requireThat(card, `Assign card ····${b.last4} to an employee before reconciling its statement`, 409);
  const existing = await db.prepare(`SELECT ${COLUMNS} FROM c_card_statements WHERE file_id=? AND card_id=?`).bind(fileId, card.id).first<StatementRecord>();
  requireThat(!existing?.closed_at, 'This card statement is closed', 409);
  const seed: StatementRecord = { id: existing?.id ?? uid(), file_id: fileId, card_id: card.id, period_start: null, period_end: file.period_end ?? '', opening_minor: 0, statement_minor: 0, opened_by: actor.email, opened_at: now(), closed_by: null, closed_at: null };
  // Read the period and the stated balance from the retained original, whatever finance typed.
  const probe = await analyse(db, { ...seed, period_end: file.period_end ?? '1970-01-01' });
  const period = probe.statement.period, stated = probe.statement.balances[card.last4]?.owedMinor;
  requireThat(period.end, 'The statement file names no period end; choose a file that gives the statement period', 409);
  const given = b.statementBalance === undefined || b.statementBalance === '' ? undefined : owed(b.statementBalance, 'Statement balance');
  requireThat(stated === undefined || given === undefined || given === stated, 'The statement file states a different balance; correct the file or leave the balance blank');
  requireThat(stated !== undefined || given !== undefined, 'Enter the closing balance printed on the statement');
  const prior = await lastClosed(db, card.id);
  requireThat(!prior || period.end > prior.period_end, `A statement for ${prior?.period_end} is already closed for this card; reconcile later statements only`, 409);
  const opening = prior ? prior.statement_minor : b.openingBalance === undefined || b.openingBalance === '' ? undefined : owed(b.openingBalance, 'Opening balance');
  requireThat(opening !== undefined, 'Enter this card\'s balance brought forward; it is the first statement Coaster reconciles for it');
  requireThat(!prior || b.openingBalance === undefined || b.openingBalance === '' || owed(b.openingBalance, 'Opening balance') === prior.statement_minor, 'The opening balance must equal the previous closed statement\'s balance');
  const record = { ...seed, period_start: period.start, period_end: period.end, opening_minor: opening, statement_minor: stated ?? given! };
  const detail = { statement: record.id, file: fileId, issuer: card.issuer, last4: card.last4, period: { start: record.period_start, end: record.period_end }, openingMinor: opening, statementMinor: record.statement_minor };
  await commit(db, all(authority(actor, 'finance'), existing ? isOpen(existing.id) : { sql: 'NOT EXISTS(SELECT 1 FROM c_card_statements WHERE file_id=? AND card_id=?)', params: [fileId, card.id] }), [
    existing ? db.prepare('UPDATE c_card_statements SET opening_minor=?,statement_minor=? WHERE id=?').bind(opening, record.statement_minor, record.id)
      : db.prepare('INSERT INTO c_card_statements(id,file_id,card_id,period_start,period_end,opening_minor,statement_minor,opened_by,opened_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(record.id, fileId, card.id, record.period_start, record.period_end, opening, record.statement_minor, actor.email, record.opened_at),
    event(db, actor, existing ? 'card-statement-balances-set' : 'card-statement-opened', {}, detail),
  ]);
  return view(db, record);
}

/** Finance settles one listed difference: a charge the statement has and Coaster lacks is added as a card expense on the
 * cardholder's statement report or explained in writing; a credit is acknowledged, optionally against the charge it refunds. */
export async function resolveDifference(db: D1Database, actor: Actor, id: string, b: Data) {
  finance(actor);
  const s = await load(db, id);
  requireThat(!s.closed_at, 'This card statement is closed', 409);
  requireThat(Number.isInteger(b.line) && b.line >= 0, 'Name the statement line to resolve');
  const a = await analyse(db, s), difference = a.differences.find(d => d.line === b.line);
  requireThat(difference, 'That line is not a listed difference', 404);
  requireThat(difference.resolvable, difference.kind === 'footing' ? 'The statement lines do not add up to its balance; correct the file or the opening balance' : 'This line cannot be classified and blocks the period; correct the file', 409);
  requireThat(!difference.resolution, 'That difference is already resolved', 409);
  const allowed = difference.kind === 'credit' ? ['credit'] : ['add', 'explain'];
  requireThat(allowed.includes(b.resolution), `Resolve this ${difference.kind === 'credit' ? 'credit by acknowledging it' : 'missing charge by adding it or explaining it'}`);
  const note = optionalText(b.note, 'Note', 500), at = now();
  const base = { statement: id, line: b.line, kind: difference.kind, resolution: b.resolution, amountMinor: difference.amountMinor, descriptor: difference.descriptor, last4: a.card.last4 };
  const insert = (charge: string | null) => db.prepare('INSERT INTO c_card_statement_resolutions(statement_id,line,resolution,amount_minor,charge_id,note,resolved_by,resolved_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, b.line, b.resolution, difference.amountMinor, charge, note, actor.email, at);
  const guard: Sql[] = [isOpen(id), { sql: 'NOT EXISTS(SELECT 1 FROM c_card_statement_resolutions WHERE statement_id=? AND line=?)', params: [id, b.line] }];
  if (b.resolution === 'explain') {
    requireThat(note, 'Say why this charge is not a Coaster card expense');
    await commit(db, all(authority(actor, 'finance'), ...guard), [insert(null), event(db, actor, 'card-statement-difference-resolved', {}, { ...base, note })]);
  } else if (b.resolution === 'credit') {
    const charge = typeof b.charge === 'string' && b.charge ? b.charge : null;
    requireThat(charge || note, 'Link the charge this credit refunds, or say what it is');
    requireThat(!charge || await db.prepare('SELECT 1 FROM c_card_charges WHERE id=? AND card_id=?').bind(charge, s.card_id).first(), 'That charge is not on this card', 400);
    await commit(db, all(authority(actor, 'finance'), ...guard), [insert(charge), event(db, actor, 'card-statement-difference-resolved', {}, { ...base, charge, note })]);
  } else {
    const row = a.postings.find(p => p.row.line === b.line)!.row, category = await categoryFor(db, typeof b.category === 'string' ? b.category : '');
    const holder = await db.prepare('SELECT c.employee_email FROM c_cards c JOIN c_members m ON m.email=c.employee_email AND m.active=1 AND m.is_employee=1 WHERE c.id=?').bind(s.card_id).first<{ employee_email: string }>();
    requireThat(holder, 'The card is not assigned to an active employee; assign it before adding its charge', 409);
    const held = { row, id: `${row.last4}:${row.key}`, employee: holder.employee_email, cardId: s.card_id, date: chargeDate(row) };
    const place = await placements(db, [held], a.file.issuer, a.statement.period.end), [claim, position] = place.where.get(held.id)!.split('|');
    const made = chargeStatements(db, actor, { file: s.file_id, issuer: a.file.issuer, category, costCentre: '', held, claim, position: Number(position), at });
    await commit(db, all(authority(actor, 'finance'), ...guard, ...place.guards, { sql: 'EXISTS(SELECT 1 FROM c_cards c JOIN c_members m ON m.email=c.employee_email AND m.active=1 AND m.is_employee=1 WHERE c.id=? AND c.employee_email=?)', params: [s.card_id, holder.employee_email] }), [
      ...place.statements, ...made.statements, insert(made.charge), ...[...place.claims.keys()].map(c => claimTotal(db, c)),
      event(db, actor, 'card-statement-difference-resolved', { claim }, { ...base, charge: made.charge, note }),
    ]);
  }
  return view(db, s);
}

/** Closing needs every difference resolved and the period balanced to the cent: Coaster's accounted balance equals the
 * statement's. It writes the statement's ledger entries once, and the card account then equals the statement balance. */
export async function closeReconciliation(db: D1Database, actor: Actor, id: string) {
  finance(actor);
  const s = await load(db, id);
  requireThat(!s.closed_at, 'This card statement is already closed', 409);
  const a = await analyse(db, s);
  requireThat(!a.unresolved && a.totals.differenceMinor === 0, `Resolve the ${a.unresolved || 'remaining'} listed difference${a.unresolved === 1 ? '' : 's'} before closing; the period is ${a.totals.differenceMinor} minor units from its statement balance`, 409);
  const prior = await lastClosed(db, s.card_id);
  requireThat(!prior || (s.period_end > prior.period_end && s.opening_minor === prior.statement_minor), 'Earlier statements must close first, and this one must open from the previous closing balance', 409);
  const lines = await ledgerLines(db, a, s, !prior), at = now();
  const before = await cardAccountMinor(db, a.card);
  const after = before + lines.reduce((n, l) => n + (l.credit.startsWith('Card liability') ? l.amountMinor : 0) - (l.debit.startsWith('Card liability') ? l.amountMinor : 0), 0);
  requireThat(after === s.statement_minor, 'The ledger entries do not reach the statement balance; nothing was closed', 409);
  await commit(db, all(authority(actor, 'finance'), isOpen(id), { sql: "(SELECT COUNT(*)||':'||COALESCE(SUM(amount_minor),0) FROM c_card_charges WHERE card_id=?)||':'||(SELECT COUNT(*) FROM c_card_statement_resolutions WHERE statement_id=?)=?", params: [s.card_id, id, a.signature] }), [
    db.prepare('UPDATE c_card_statements SET closed_by=?,closed_at=? WHERE id=? AND closed_at IS NULL').bind(actor.email, at, id),
    ...lines.map((l, i) => db.prepare('INSERT INTO c_card_ledger(id,statement_id,card_id,seq,kind,debit_account,credit_account,amount_minor,ref,memo,posted_on,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(uid(), id, s.card_id, i + 1, l.kind, l.debit, l.credit, l.amountMinor, l.ref, l.memo, l.postedOn, at)),
    event(db, actor, 'card-statement-closed', {}, { statement: id, file: s.file_id, issuer: a.card.issuer, last4: a.card.last4, period: { start: s.period_start, end: s.period_end }, statementMinor: s.statement_minor, entries: lines.length, cardAccountMinor: after }),
  ]);
  return view(db, { ...s, closed_by: actor.email, closed_at: at }, a);
}
