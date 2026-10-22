import type { ClaimItem } from './exceptions';
import { isCardExpense } from './card-expenses';
import { normalDescriptor } from './cards/statement';
import type { Sql } from './session';
import { requireThat } from './types';

/** Refuse a reimbursement for a purchase already paid on a company card, before freezing a submission.
 * The card facts are immutable. Guard the exact candidate set as well as receipt aliases, so a statement
 * arriving or a receipt attaching between the check and commit cannot slip a duplicate through. */
export async function noCardDuplicates(db: D1Database, employee: string, items: ClaimItem[]): Promise<Sql[]> {
  const expected:{date:string;amount:number;ids:string;sha:string|null}[]=[];
  for (const item of items.filter(i => !isCardExpense(i))) {
    const params = [employee, item.spent_on, item.amount_minor];
    const where = 'employee_email=? AND COALESCE(transaction_on,posted_on)=? AND amount_minor=?';
    const candidates = (await db.prepare(`SELECT id,descriptor FROM c_card_charges WHERE ${where} ORDER BY id`).bind(...params).all<{id: string; descriptor: string}>()).results;
    const receiptSql = 'NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id JOIN c_card_charges ch ON ch.id=i.card_charge_id WHERE r.sha256=?)';
    const receiptClear = !item.receipt_sha256 || !!(await db.prepare(`SELECT 1 AS clear WHERE ${receiptSql}`).bind(item.receipt_sha256).first());
    const twin = candidates.find(c => normalDescriptor(c.descriptor) === normalDescriptor(item.merchant));
    requireThat(!twin && receiptClear, `${item.merchant} (${item.spent_on}) repeats a purchase the company card already paid; correct or remove the out-of-pocket expense before submitting`, 409);
    expected.push({date:item.spent_on,amount:item.amount_minor,ids:candidates.map(c=>c.id).join(','),sha:item.receipt_sha256??null});
  }
  if(!expected.length)return [];
  // One JSON binding preserves the same exact candidate/receipt guard for a 100-expense report within D1's bind limit.
  return [{sql:`NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE
    (SELECT COALESCE(group_concat(id,','),'') FROM (SELECT id FROM c_card_charges WHERE employee_email=? AND COALESCE(transaction_on,posted_on)=json_extract(e.value,'$.date') AND amount_minor=json_extract(e.value,'$.amount') ORDER BY id))<>json_extract(e.value,'$.ids')
    OR (json_extract(e.value,'$.sha') IS NOT NULL AND EXISTS(SELECT 1 FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id JOIN c_card_charges ch ON ch.id=i.card_charge_id WHERE r.sha256=json_extract(e.value,'$.sha'))))`,params:[JSON.stringify(expected),employee]}];
}
