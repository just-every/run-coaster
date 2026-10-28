import type { Transaction } from './transactions';
import { now, uid } from '../types';

/** Receipt matching reads personal provenance without marking the expense as paid by the company. */
export function personalCharge(db: D1Database, source: string, connection: string, tx: Transaction, employee: string, item: string, category: string, claim: string, last4: string) {
  const id = uid();
  const statement = db.prepare('INSERT INTO c_plaid_personal_charges(id,file_id,connection_id,transaction_id,employee_email,transaction_key,posted_on,transaction_on,descriptor,amount_minor,currency,item_id,category_id,claim_id,last4,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id,source,connection,tx.transaction_id,employee,'plaid-personal:'+tx.transaction_id+':'+source,tx.posted_on,tx.spent_on,tx.merchant,tx.amount_minor,tx.currency,item,category,claim,last4,now());
  return {id,statement};
}
