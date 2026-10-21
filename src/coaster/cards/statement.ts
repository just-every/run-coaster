import { requireThat } from '../types';

/** What a statement row is, as the file says: only a purchase becomes a card expense (S4); a credit is listed and
 * kept in the original only. */
export type StatementRow = {
  line: number; last4: string; key: string; kind: 'purchase' | 'credit' | 'payment' | 'fee' | 'interest' | 'other';
  postedOn: string | null; transactionOn: string | null; descriptor: string; memo: string;
  amountMinor: number | null; signed: number | null; currency: string; originalCurrency: string; originalMinor: number | null;
  pending: boolean; problems: string[];
};
export type StatementCard = { last4: string; label: string };
/** The closing balance a statement file states for one card, as an amount owed (positive) or in credit (negative). */
export type StatementBalance = { owedMinor: number; asOf: string | null };
export type Statement = { format: 'ofx' | 'qfx' | 'csv'; name: string; issuer: string; cards: StatementCard[]; rows: StatementRow[]; period: { start: string | null; end: string | null }; currency: string; masked: string; mapping: Record<string, unknown>; balances: Record<string, StatementBalance> };

export const STATEMENT_LIMIT = 1_500_000;
/** One import is one D1 batch (at most 1,000 statements per invocation), so a file's importable charges are capped. */
export const CHARGE_LIMIT = 150;
export const ROW_LIMIT = 1000;

export const issuerLabel = (value: unknown) => {
  const issuer = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  requireThat(issuer.length >= 1 && issuer.length <= 60, 'Name the card issuer as it should read on the card record (at most 60 characters)');
  return issuer;
};
export const normalDescriptor = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
/** The date the charge counts from: its transaction date when the statement gives one, otherwise its posted date. */
export const chargeDate = (row: Pick<StatementRow, 'transactionOn' | 'postedOn'>) => row.transactionOn ?? row.postedOn!;
export const cardKey = (issuer: string, last4: string) => `${issuer.toLowerCase()}|${last4}`;
