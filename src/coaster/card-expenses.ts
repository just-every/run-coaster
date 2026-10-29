import { requireThat, type Data } from './types';

/** Card identity is independent of liability: source-backed charges keep their statement key. */
export const isCardExpense = (item: Data) => item.card_charge_id != null && item.card_charge_id !== '';
/** Individual business charges reimburse the employee; personal and company charges never do. */
export const isReimbursable = (item: Data) => !isCardExpense(item) || item.card_liability === 'individual' && item.card_personal === 0;
export const reimbursableMinor = (items: Data[]) => items.reduce((n, i) => n + (isReimbursable(i) ? i.amount_minor : 0), 0);
/** The SQL form of reimbursableMinor over one claim's expenses. */
export const REIMBURSABLE_SUM = "COALESCE(SUM(CASE WHEN card_charge_id IS NULL OR (card_liability='individual' AND card_personal=0) THEN amount_minor ELSE 0 END),0)";

/** The statement facts a card expense keeps whatever route edits it (the database refuses any other values). */
export function keepsStatementFacts(item: Data, charge: { descriptor: string; amount_minor: number; posted_on: string; transaction_on: string | null }) {
  requireThat(item.kind === 'receipt' && !item.original_minor && item.merchant === charge.descriptor && item.amount_minor === charge.amount_minor && item.spent_on === (charge.transaction_on ?? charge.posted_on),
    'A company-card expense keeps its statement merchant, amount and date; change only its coding, description, attendees and receipt', 409);
}
