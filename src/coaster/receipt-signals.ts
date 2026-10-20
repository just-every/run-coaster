import { inspectReceiptMetadata } from './receipt-metadata';

/** Advisory signals are deliberately separate from policy exceptions: their presence
 * never changes submission, approval, batching, release or payment eligibility. */
export async function receiptSignals(db: D1Database, claimId: string) {
  const rows = (await db.prepare('SELECT i.id AS item,i.spent_on,r.id AS receipt,r.sha256,r.media_type,r.bytes FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id WHERE i.claim_id=? ORDER BY i.position').bind(claimId).all<{ item: string; spent_on: string; receipt: string; sha256: string; media_type: string; bytes: ArrayBuffer }>()).results;
  return rows.map(row => ({ item: row.item, receipt: row.receipt, sha256: row.sha256,
    ...inspectReceiptMetadata(new Uint8Array(row.bytes), row.media_type, row.spent_on) }));
}
