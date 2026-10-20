import { sha256Hex } from '../session';
import { requireThat } from '../types';

export type StoredReceipt = { object_key: string; sha256: string; size: number };

export function receiptBucket(bucket: R2Bucket | undefined): R2Bucket {
  requireThat(bucket, 'Receipt storage is unavailable; ask the owner to check the receipt bucket and try again', 503);
  return bucket;
}

/** A committed original is never overwritten or deleted. Only an unpublished
 * object may be removed when the guarded D1 transaction refuses its upload. */
export async function storeReceipt(bucket: R2Bucket, key: string, bytes: Uint8Array, mediaType: string, sha256: string) {
  await bucket.put(key, bytes, { httpMetadata: { contentType: mediaType }, sha256 });
}

export async function originalBytes(bucket: R2Bucket, receipt: StoredReceipt) {
  const object = await bucket.get(receipt.object_key);
  requireThat(object, 'The original receipt is unavailable; ask the owner to check receipt storage', 503);
  requireThat(object.size === receipt.size, 'The stored receipt failed its integrity check', 503);
  const bytes = new Uint8Array(await object.arrayBuffer());
  requireThat(bytes.length === receipt.size && await sha256Hex(bytes) === receipt.sha256, 'The stored receipt failed its integrity check', 503);
  return bytes;
}
