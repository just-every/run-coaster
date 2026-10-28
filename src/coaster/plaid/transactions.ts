import { plaidMinor } from './money.mjs';
import { isoDate, requireThat, text, type Data } from '../types';

export type Transaction = { transaction_id: string; account_id: string; pending_transaction_id: string | null; pending: boolean; spent_on: string; posted_on: string; merchant: string; amount_minor: number; provider_amount: string; currency: string };
/** Minimize provider responses immediately. Account names, balances and free-form metadata are never persisted. */
export function transactionFacts(raw: Data): Transaction {
  const minor = plaidMinor(raw.amount);
  requireThat(minor !== null, 'Plaid returned an invalid transaction amount', 502);
  requireThat(typeof raw.pending === 'boolean' && typeof raw.iso_currency_code === 'string' && /^[A-Z]{3}$/.test(raw.iso_currency_code), 'Plaid returned incomplete transaction facts', 502);
  return { transaction_id: text(raw.transaction_id, 'Plaid transaction id', 200), account_id: text(raw.account_id, 'Plaid account id', 200), pending_transaction_id: raw.pending_transaction_id ? text(raw.pending_transaction_id, 'Pending transaction id', 200) : null, pending: raw.pending,
    spent_on: isoDate(raw.authorized_date ?? raw.date, 'Transaction date'), posted_on: isoDate(raw.date, 'Posted date'), merchant: text(raw.merchant_name || raw.name, 'Merchant', 200), amount_minor: minor, provider_amount: String(raw.amount), currency: raw.iso_currency_code };
}
export const transactionColumns = 'connection_id,transaction_id,account_id,pending_transaction_id,status,spent_on,posted_on,merchant,amount_minor,provider_amount,currency,employee_email,scope,item_id,charge_id,updated_at';
