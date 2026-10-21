import { requireThat, type Data } from './types';

/** A company-card expense is an ordinary expense row that carries its statement charge. The company paid it, so it never
 * adds to what is reimbursed (FEED-004): claim totals, batches and both reimbursement files sum the other rows only. */
export const isCardExpense = (item: Data) => item.card_charge_id != null && item.card_charge_id !== '';
export const reimbursableMinor = (items: Data[]) => items.reduce((n, i) => n + (isCardExpense(i) ? 0 : i.amount_minor), 0);
/** The SQL form of reimbursableMinor over one claim's expenses. */
export const REIMBURSABLE_SUM = "COALESCE(SUM(CASE WHEN card_charge_id IS NULL THEN amount_minor ELSE 0 END),0)";

/** The statement facts a card expense keeps whatever route edits it (the database refuses any other values). */
export function keepsStatementFacts(item: Data, charge: { descriptor: string; amount_minor: number; posted_on: string; transaction_on: string | null }) {
  requireThat(item.kind === 'receipt' && !item.original_minor && item.merchant === charge.descriptor && item.amount_minor === charge.amount_minor && item.spent_on === (charge.transaction_on ?? charge.posted_on),
    'A company-card expense keeps its statement merchant, amount and date; change only its coding, description, attendees and receipt', 409);
}
