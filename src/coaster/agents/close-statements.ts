import { reconciliation } from '../cards/reconcile';
import type { Actor, Data } from '../types';

// Originals and charge facts are immutable. Include their identities and all mutable
// analysis inputs, including undo, balances, resolutions and native ledger entries.
// This deliberately invalidates conservatively when another card's evidence changes.
export const closeStatementStamp = `json_array(
 (SELECT json_group_array(json_array(id,sha256,format,issuer,mapping,period_start,period_end,undone_at)) FROM (SELECT * FROM c_statement_files ORDER BY id)),
 (SELECT json_group_array(json_array(id,file_id,card_id,period_start,period_end,opening_minor,statement_minor,closed_at)) FROM (SELECT * FROM c_card_statements ORDER BY id)),
 (SELECT json_group_array(json_array(id,issuer,last4,employee_email)) FROM (SELECT * FROM c_cards ORDER BY id)),
 (SELECT json_group_array(json_array(id,file_id,card_id,transaction_key,posted_on,transaction_on,descriptor,amount_minor)) FROM (SELECT * FROM c_card_charges ORDER BY id)),
 (SELECT json_group_array(json_array(statement_id,line,resolution,amount_minor,charge_id,note,resolved_by,resolved_at)) FROM (SELECT * FROM c_card_statement_resolutions ORDER BY statement_id,line)),
 (SELECT json_group_array(json_array(id,statement_id,card_id,debit_account,credit_account,amount_minor,posted_at)) FROM (SELECT * FROM c_card_ledger ORDER BY id)))`;

/** Recorded native evidence only: neither a closed card ledger nor a file import
 * establishes provider-feed completeness or connected-ledger clearance. */
export async function closeStatements(db: D1Database, actor: Actor, from: string, to: string) {
  const selected = (await db.prepare(`SELECT id FROM c_card_statements
    WHERE (period_start IS NULL OR period_start<=?) AND (period_end IS NULL OR period_end>=?) ORDER BY period_end,id`)
    .bind(to, from).all<{ id: string }>()).results;
  const statements: Data[] = [];
  for (const { id } of selected) {
    // Use the ordinary reconciliation's exact native calculation, including
    // unresolved lines and signed integer balance difference.
    const detail = await reconciliation(db, actor, id);
    const periodKnown = !!detail.period.start && !!detail.period.end;
    statements.push({ id, file: detail.file, card: detail.card, period: detail.period,
      status: detail.status, periodKnown, unresolved: detail.unresolved,
      openingMinor: detail.openingMinor, statementMinor: detail.statementMinor,
      coasterMinor: detail.coasterMinor, differenceMinor: detail.differenceMinor,
      differences: detail.differences, ledger: detail.ledger,
      verified: periodKnown && detail.status === 'closed' && detail.unresolved === 0 && detail.differenceMinor === 0 && detail.ledger?.matches === true,
    });
  }
  const missing = (await db.prepare(`SELECT f.id AS file,c.id AS cardId,c.issuer,c.last4,
    f.period_start AS periodStart,f.period_end AS periodEnd,COUNT(*) AS charges,SUM(ch.amount_minor) AS amountMinor
    FROM c_card_charges ch JOIN c_cards c ON c.id=ch.card_id JOIN c_statement_files f ON f.id=ch.file_id
    WHERE COALESCE(ch.transaction_on,ch.posted_on)>=? AND COALESCE(ch.transaction_on,ch.posted_on)<=?
    AND NOT EXISTS(SELECT 1 FROM c_card_statements s WHERE s.file_id=f.id AND s.card_id=c.id)
    GROUP BY f.id,c.id ORDER BY f.id,c.id`).bind(from, to).all<Data>()).results;
  return { statements, missing };
}
