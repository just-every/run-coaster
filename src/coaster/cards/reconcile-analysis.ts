import { requireBusiness } from '../settings';
import { requireThat } from '../types';
import { readStatement } from './plan';
import { cardKey, type StatementRow } from './statement';

export type StatementRecord = { id: string; file_id: string; card_id: string; period_start: string | null; period_end: string; opening_minor: number; statement_minor: number; opened_by: string; opened_at: string; closed_by: string | null; closed_at: string | null };
export type Resolution = { line: number; resolution: 'add' | 'explain' | 'credit'; amount_minor: number; charge_id: string | null; note: string; resolved_by: string; resolved_at: string };
/** One line the statement and Coaster disagree about. `effectMinor` is how far it moves the statement balance away from
 * Coaster's: a charge the statement has and Coaster lacks is positive, a credit Coaster has not accounted for negative. */
export type Difference = { line: number; kind: 'missing-charge' | 'credit' | 'unclassified' | 'footing'; descriptor: string; postedOn: string | null; amountMinor: number; effectMinor: number; resolvable: boolean; resolution: Resolution | null };
export type HeldCharge = { id: string; item_id: string; category_id: string; amount_minor: number; descriptor: string; posted_on: string };
export type Posting = { row: StatementRow; charge: HeldCharge | null; resolution: Resolution | null };

/** A statement period read back from the retained masked original and the card's charges. Nothing here is stored: the
 * differences are always what the original and the charges say now, less the resolutions finance has recorded. */
export async function analyse(db: D1Database, s: StatementRecord) {
  const [file, card, business] = await Promise.all([
    db.prepare('SELECT id,name,format,issuer,mapping,bytes FROM c_statement_files WHERE id=?').bind(s.file_id).first<{ id: string; name: string; format: string; issuer: string; mapping: string; bytes: ArrayBuffer }>(),
    db.prepare('SELECT id,issuer,last4,employee_email FROM c_cards WHERE id=?').bind(s.card_id).first<{ id: string; issuer: string; last4: string; employee_email: string }>(),
    requireBusiness(db),
  ]);
  requireThat(file && card, 'Statement import not found', 404);
  const statement = readStatement({ content: new TextDecoder().decode(Uint8Array.from(file.bytes as unknown as ArrayLike<number>)), format: file.format, name: file.name, issuer: file.issuer, mapping: JSON.parse(file.mapping) }, business.currency);
  const rows = statement.rows.filter(r => r.last4 === card.last4);
  const [charges, resolutions] = await db.batch([
    db.prepare('SELECT id,transaction_key,item_id,category_id,amount_minor,descriptor,posted_on,liability FROM c_card_charges WHERE card_id=?').bind(card.id),
    db.prepare('SELECT line,resolution,amount_minor,charge_id,note,resolved_by,resolved_at FROM c_card_statement_resolutions WHERE statement_id=? ORDER BY line').bind(s.id),
  ]);
  requireThat((charges.results as { liability: string }[]).every(c => c.liability === 'company'), 'Individual-liability charges belong in employee reimbursement, not the company card ledger', 409);
  const held = new Map((charges.results as (HeldCharge & { transaction_key: string })[]).map(c => [c.transaction_key, c]));
  const resolved = new Map((resolutions.results as Resolution[]).map(r => [r.line, r]));
  const differences: Difference[] = [], postings: Posting[] = [], t = { purchases: 0, held: 0, explained: 0, credits: 0, creditsAccounted: 0, payments: 0, fees: 0, interest: 0 };
  const diff = (row: StatementRow, kind: Difference['kind'], amountMinor: number, effectMinor: number, resolvable: boolean) => differences.push({ line: row.line, kind, descriptor: row.descriptor, postedOn: row.postedOn, amountMinor, effectMinor, resolvable, resolution: resolved.get(row.line) ?? null });
  for (const row of rows) {
    if (row.pending || !row.postedOn) continue;
    const amount = row.amountMinor ?? 0, resolution = resolved.get(row.line) ?? null;
    if (row.problems.length || !amount) { diff(row, 'unclassified', amount, 0, false); continue; }
    if (row.kind === 'purchase') {
      const charge = held.get(`card:${cardKey(statement.issuer, row.last4)}:${row.key}`) ?? null;
      t.purchases += amount;
      if (charge) t.held += charge.amount_minor; else if (resolution?.resolution === 'explain') t.explained += amount;
      if (!charge || resolution) diff(row, 'missing-charge', amount, charge ? 0 : amount, true);
      postings.push({ row, charge, resolution });
    } else if (row.kind === 'credit') {
      t.credits += amount;
      if (resolution) t.creditsAccounted += amount;
      diff(row, 'credit', amount, resolution ? 0 : -amount, true);
      postings.push({ row, charge: null, resolution });
    } else if (row.kind === 'payment' || row.kind === 'fee' || row.kind === 'interest') {
      t[row.kind === 'payment' ? 'payments' : row.kind === 'fee' ? 'fees' : 'interest'] += amount;
      postings.push({ row, charge: null, resolution: null });
    } else diff(row, 'unclassified', amount, 0, false);
  }
  // What the statement's own lines come to against the balance it states; a gap here is the file or the opening balance.
  const footing = s.statement_minor - (s.opening_minor + t.purchases + t.fees + t.interest - t.credits - t.payments);
  if (footing) differences.push({ line: 0, kind: 'footing', descriptor: 'The statement lines do not add up to its balance', postedOn: null, amountMinor: Math.abs(footing), effectMinor: footing, resolvable: false, resolution: null });
  const coasterMinor = s.opening_minor + t.held + t.explained + t.fees + t.interest - t.payments - t.creditsAccounted;
  return {
    card, file, statement, postings, differences,
    totals: { openingMinor: s.opening_minor, statementMinor: s.statement_minor, purchasesMinor: t.purchases, heldMinor: t.held, explainedMinor: t.explained, creditsMinor: t.credits, creditsAccountedMinor: t.creditsAccounted, paymentsMinor: t.payments, feesMinor: t.fees, interestMinor: t.interest, coasterMinor, differenceMinor: s.statement_minor - coasterMinor },
    unresolved: differences.filter(d => !d.resolution).length, signature: `${held.size}:${[...held.values()].reduce((n, c) => n + c.amount_minor, 0)}:${resolved.size}`,
  };
}
export type Analysis = Awaited<ReturnType<typeof analyse>>;
