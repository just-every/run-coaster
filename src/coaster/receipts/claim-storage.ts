import { requireThat, type Data } from '../types';
import { originalBytes, receiptBucket } from './storage';

const evidence = ['owner_email', 'name', 'media_type', 'size', 'sha256', 'source', 'uploaded_by', 'uploaded_at'] as const;

/** Call only after the claim or proposal visibility check. An attached inbox
 * receipt keeps one original in R2; its claim row carries immutable evidence. */
export async function claimReceiptBytes(db: D1Database, receipt: Data, bucket?: R2Bucket): Promise<Uint8Array> {
  const bytes = new Uint8Array(receipt.bytes as ArrayBuffer);
  if (receipt.capture_receipt_id == null) return bytes;
  const original = await db.prepare('SELECT * FROM c_capture_receipts WHERE id=?').bind(receipt.capture_receipt_id).first<Data>();
  requireThat(original && bytes.length === 0 && evidence.every(key => receipt[key] === original[key]), 'The attached receipt failed its integrity check', 503);
  return originalBytes(receiptBucket(bucket), { object_key: original.object_key, sha256: original.sha256, size: original.size });
}
