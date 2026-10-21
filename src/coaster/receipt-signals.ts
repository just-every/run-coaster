import { inspectReceiptMetadata } from './receipt-metadata';
import { claimReceiptBytes } from './receipts/claim-storage';
import type { Data } from './types';

/** Advisory signals are deliberately separate from policy exceptions: their presence
 * never changes submission, approval, batching, release or payment eligibility. */
export async function receiptSignals(db: D1Database, claimId: string, bucket?: R2Bucket) {
  const rows = (await db.prepare('SELECT i.id AS item,i.spent_on,r.* FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id WHERE i.claim_id=? ORDER BY i.position').bind(claimId).all<Data>()).results;
  return Promise.all(rows.map(async row => ({ item: row.item, receipt: row.id, sha256: row.sha256,
    ...inspectReceiptMetadata(await claimReceiptBytes(db, row, bucket), row.media_type, row.spent_on) })));
}
