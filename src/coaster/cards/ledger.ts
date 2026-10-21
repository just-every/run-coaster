import type { Analysis, StatementRecord } from './reconcile-analysis';

export type LedgerLine = { kind: 'opening' | 'purchase' | 'unmatched' | 'credit' | 'payment' | 'fee' | 'interest'; debit: string; credit: string; amountMinor: number; ref: string; memo: string; postedOn: string };
export const liabilityAccount = (card: { issuer: string; last4: string }) => `Card liability · ${card.issuer} ····${card.last4}`;
const UNMATCHED = 'Unmatched card spend', CREDITS = 'Card credits and refunds', CLEARING = 'Card payment clearing', FEES = 'Card fees and interest', OPENING = 'Card opening balance';

/** The double entries a closed statement writes to the native card liability account: each purchase against the expense
 * account of the category it is coded to now, each credit and the statement payment against the liability, and the
 * first statement's opening balance. Posting them to the connected ledger belongs to ACCT-001 to ACCT-003. */
export async function ledgerLines(db: D1Database, a: Analysis, s: StatementRecord, first: boolean): Promise<LedgerLine[]> {
  const liability = liabilityAccount(a.card), lines: LedgerLine[] = [];
  const [categories, allocations] = await db.batch([
    db.prepare('SELECT id,name,account_code FROM c_categories'),
    db.prepare('SELECT ch.id AS charge,a.category_id,a.amount_minor FROM c_card_charges ch JOIN c_allocations a ON a.item_id=ch.item_id WHERE ch.card_id=? ORDER BY ch.id,a.position').bind(s.card_id),
  ]);
  const account = new Map((categories.results as { id: string; name: string; account_code: string }[]).map(c => [c.id, `Expense · ${c.account_code ? c.account_code + ' ' : ''}${c.name}`]));
  const splits = new Map<string, { category: string; amount: number }[]>();
  for (const x of allocations.results as { charge: string; category_id: string; amount_minor: number }[]) splits.set(x.charge, [...(splits.get(x.charge) ?? []), { category: x.category_id, amount: x.amount_minor }]);
  if (first && s.opening_minor) lines.push(s.opening_minor > 0 ? { kind: 'opening', debit: OPENING, credit: liability, amountMinor: s.opening_minor, ref: '', memo: 'Balance brought forward', postedOn: s.period_start ?? s.period_end } : { kind: 'opening', debit: liability, credit: OPENING, amountMinor: -s.opening_minor, ref: '', memo: 'Credit brought forward', postedOn: s.period_start ?? s.period_end });
  for (const { row, charge, resolution } of a.postings) {
    const base = { ref: '', memo: row.descriptor, postedOn: row.postedOn!, amountMinor: row.amountMinor! };
    if (row.kind === 'purchase' && charge) {
      for (const part of splits.get(charge.id) ?? [{ category: charge.category_id, amount: charge.amount_minor }]) lines.push({ ...base, kind: 'purchase', debit: account.get(part.category) ?? UNMATCHED, credit: liability, amountMinor: part.amount, ref: charge.id });
    } else if (row.kind === 'purchase') lines.push({ ...base, kind: 'unmatched', debit: UNMATCHED, credit: liability, ref: `line ${row.line}` });
    else if (row.kind === 'credit') lines.push({ ...base, kind: 'credit', debit: liability, credit: CREDITS, ref: resolution?.charge_id ?? `line ${row.line}` });
    else if (row.kind === 'payment') lines.push({ ...base, kind: 'payment', debit: liability, credit: CLEARING, ref: `line ${row.line}` });
    else lines.push({ ...base, kind: row.kind as 'fee' | 'interest', debit: FEES, credit: liability, ref: `line ${row.line}` });
  }
  return lines;
}

/** What the card liability account holds once every statement closed up to `closedAt` is posted: owed is positive. */
export async function cardAccountMinor(db: D1Database, card: { id: string; issuer: string; last4: string }, closedAt?: string) {
  const liability = liabilityAccount(card);
  const row = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN credit_account=? THEN amount_minor ELSE 0 END),0)-COALESCE(SUM(CASE WHEN debit_account=? THEN amount_minor ELSE 0 END),0) AS owed FROM c_card_ledger WHERE card_id=?${closedAt ? ' AND posted_at<=?' : ''}`).bind(liability, liability, card.id, ...(closedAt ? [closedAt] : [])).first<{ owed: number }>();
  return row!.owed;
}
