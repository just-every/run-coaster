import { canonicalJson } from '../../modules/import-kit/src/d1/index';
import { sha256Hex } from '../session';
import { requireBusiness } from '../settings';
import { categories } from '../items';
import { optionalText, requireThat, type Actor, type Data } from '../types';
import { maskStatementFilename } from './statement-numbers';
import { parseOfx } from './ofx';
import { parseStatementCsv } from './statement-csv';
import { CHARGE_LIMIT, ROW_LIMIT, STATEMENT_LIMIT, cardKey, chargeDate, issuerLabel, normalDescriptor, type Statement, type StatementRow } from './statement';

export type Held = { row: StatementRow; id: string; employee: string; cardId: string; date: string };
const FORMATS = ['ofx', 'qfx', 'csv'];

/** The file as sent, parsed by its documented format only. A full card number is reduced to its last four here, in
 * memory, before anything is kept (SEC-001). */
export function readStatement(b: Data, currency: string): Statement {
  requireThat(typeof b.content === 'string' && b.content.length > 0 && b.content.length <= STATEMENT_LIMIT, `Choose a statement file (at most ${STATEMENT_LIMIT / 1_000_000} MB)`);
  requireThat(FORMATS.includes(b.format), 'Choose OFX, QFX or CSV');
  const name = maskStatementFilename((typeof b.name === 'string' && b.name.trim() ? b.name.trim() : `statement.${b.format}`).replace(/[\u0000-\u001f]/g, '')).slice(0, 200), issuer = issuerLabel(b.issuer);
  if (b.format === 'csv') {
    const mapping = (b.mapping ?? {}) as Data;
    requireThat(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'Map the CSV columns');
    const parsed = parseStatementCsv(b.content, mapping, currency);
    requireThat(parsed.rows.length <= ROW_LIMIT, `Import at most ${ROW_LIMIT} rows per file`);
    return { format: 'csv', name, issuer, cards: parsed.cards, rows: parsed.rows, period: parsed.period, currency: parsed.currency, masked: parsed.masked, mapping, balances: {} };
  }
  const parsed = parseOfx(b.content);
  requireThat(parsed.rows.length <= ROW_LIMIT, `Import at most ${ROW_LIMIT} rows per file`);
  return { format: b.format, name, issuer, cards: parsed.cards, rows: parsed.rows, period: parsed.period, currency: parsed.currency, masked: parsed.masked, mapping: {}, balances: parsed.balances };
}

/** Preview writes nothing: it classifies every row against the cards, earlier charges and imported history, and names the
 * fingerprint a commit must carry (S6, S7). */
export async function planStatement(db: D1Database, b: Data) {
  const business = await requireBusiness(db), statement = readStatement(b, business.currency);
  const category = typeof b.category === 'string' ? b.category : '', costCentre = optionalText(b.costCentre, 'Cost center', 80);
  const exclude = [...new Set(Array.isArray(b.excludeCards) ? b.excludeCards.map(String) : [])].sort(), include = [...new Set(Array.isArray(b.includeRows) ? b.includeRows.map(String) : [])].sort();
  const bytes = new TextEncoder().encode(statement.masked), sha = await sha256Hex(bytes);
  const fingerprint = await sha256Hex(canonicalJson({ sha, format: statement.format, issuer: statement.issuer, mapping: statement.mapping, category, costCentre, exclude, include }));
  const cards = new Map((await db.prepare('SELECT c.id,c.last4,c.employee_email,m.active,m.is_employee FROM c_cards c LEFT JOIN c_members m ON m.email=c.employee_email WHERE lower(c.issuer)=?').bind(statement.issuer.toLowerCase()).all<{ id: string; last4: string; employee_email: string; active: number | null; is_employee: number | null }>()).results.map(c => [c.last4, c]));
  const errors: string[] = [], excluded: { line: number; reason: string }[] = [], duplicates: { line: number; reason: string }[] = [], possible: { line: number; id: string; descriptor: string; amountMinor: number; reason: string }[] = [], credits: { line: number; descriptor: string; amountMinor: number }[] = [], importable: Held[] = [];
  const perCard = new Map(statement.cards.map(c => [c.last4, { last4: c.last4, assignedTo: cards.get(c.last4)?.employee_email ?? null, excluded: exclude.includes(c.last4), rows: 0, totalMinor: 0 }]));
  const unassigned = statement.cards.filter(c => !exclude.includes(c.last4) && !(cards.get(c.last4)?.active && cards.get(c.last4)?.is_employee)).map(c => c.last4);
  if (statement.currency !== business.currency) errors.push(`The statement is in ${statement.currency}; this business is in ${business.currency}, and foreign-currency statements are not imported yet`);
  const seen = new Set<string>(), reasons: Record<string, string> = { payment: 'a payment to the card account', fee: 'a fee', interest: 'interest', other: 'not a purchase or credit' };
  for (const row of statement.rows) {
    const card = perCard.get(row.last4), id = `${row.last4}:${row.key}`;
    if (!row.postedOn) { excluded.push({ line: row.line, reason: 'no posted date' }); continue; }
    if (row.pending) { excluded.push({ line: row.line, reason: 'pending or authorized, not posted' }); continue; }
    if (row.kind === 'credit') { credits.push({ line: row.line, descriptor: row.descriptor, amountMinor: row.amountMinor ?? 0 }); excluded.push({ line: row.line, reason: 'a credit, kept in the original file only' }); continue; }
    if (row.kind !== 'purchase') { excluded.push({ line: row.line, reason: reasons[row.kind] }); continue; }
    const problems = [...row.problems.filter(p => !p.startsWith('DTPOSTED')), ...(row.descriptor ? [] : ['no description'])];
    if (problems.length) { errors.push(`Line ${row.line}: ${problems.join('; ')}`); continue; }
    if (card?.excluded) { excluded.push({ line: row.line, reason: `card ····${row.last4} excluded by the importer` }); continue; }
    if (row.currency !== business.currency) { errors.push(`Line ${row.line}: currency ${row.currency} is not this business's ${business.currency}`); continue; }
    if (!row.key) { errors.push(`Line ${row.line}: no transaction key`); continue; }
    if (seen.has(id)) { errors.push(`Line ${row.line}: transaction ${row.key} appears twice in this file`); continue; }
    seen.add(id);
    const held = cards.get(row.last4);
    if (card) { card.rows++; card.totalMinor += row.amountMinor!; }
    if (!held?.active || !held.is_employee) continue;
    const key = `card:${cardKey(statement.issuer, row.last4)}:${row.key}`, date = chargeDate(row);
    if (await db.prepare('SELECT 1 FROM c_card_charges WHERE transaction_key=?').bind(key).first()) { duplicates.push({ line: row.line, reason: 'this transaction was imported before' }); continue; }
    const history = await db.prepare("SELECT COALESCE(json_extract(value,'$.label'),'history') AS label FROM c_history WHERE kind='expense' AND json_extract(value,'$.employee')=? AND json_extract(value,'$.date')=? AND json_extract(value,'$.amountMinor')=? AND lower(trim(json_extract(value,'$.merchant')))=? LIMIT 1").bind(held.employee_email, date, row.amountMinor, normalDescriptor(row.descriptor)).first<{ label: string }>();
    if (history) { excluded.push({ line: row.line, reason: `already in imported ${history.label}` }); continue; }
    const overlap = (await db.prepare('SELECT descriptor FROM c_card_charges WHERE card_id=? AND posted_on=? AND amount_minor=?').bind(held.id, row.postedOn, row.amountMinor).all<{ descriptor: string }>()).results.find(c => normalDescriptor(c.descriptor) === normalDescriptor(row.descriptor));
    if (overlap && !include.includes(id)) { possible.push({ line: row.line, id, descriptor: row.descriptor, amountMinor: row.amountMinor!, reason: 'same card, posted date, amount and description as a charge imported from another file' }); continue; }
    importable.push({ row, id, employee: held.employee_email, cardId: held.id, date });
  }
  if (importable.length > CHARGE_LIMIT) errors.push(`Import at most ${CHARGE_LIMIT} new charges per file; split the statement`);
  const alreadyImported = !!await db.prepare('SELECT 1 FROM c_statement_files WHERE fingerprint=? AND undone_at IS NULL').bind(fingerprint).first();
  return { statement, bytes, sha, fingerprint, category, costCentre, exclude, include, importable, alreadyImported, review: {
    fingerprint, format: statement.format, issuer: statement.issuer, period: statement.period, masking: 'Card numbers are masked to their last four before anything is kept; the retained original is the masked file.',
    cards: [...perCard.values()], unassigned, importable: importable.length, totalMinor: importable.reduce((n, h) => n + h.row.amountMinor!, 0), credits, excluded, duplicates, possibleDuplicates: possible, errors, alreadyImported,
  } };
}

export const categoryFor = async (db: D1Database, id: string) => {
  const found = (await categories(db)).find(c => c.id === id && c.active === 1);
  requireThat(found, 'Choose the active category a card charge starts in; its coding stays editable on the draft', 400);
  return found;
};
export type Planned = Awaited<ReturnType<typeof planStatement>>;
export type { Actor };
