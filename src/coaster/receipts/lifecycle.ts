import { all, authority, commit, need, type Sql } from '../session';
import { now, optionalText, requireThat, text, type Actor, type Data } from '../types';
import { listInbox } from './inbox';

/** Both terminal dispositions (discard, merge) share who may act and the exact sequence they act on. */
export async function terminal(db: D1Database, actor: Actor, id: string, b: Data, keys: string[]) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'A native employee sign-in is required', 403);
  const employee = await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1').bind(actor.email).first();
  requireThat(employee, 'Employee access required', 403);
  requireThat(b && !Array.isArray(b) && Object.keys(b).every(key => keys.includes(key)), `Only ${keys.join(', ')} are accepted`);
  const sequence = b.expectedSequence;
  requireThat(Number.isSafeInteger(sequence) && sequence >= 0, 'Reload the inbox and supply its lifecycle sequence');
  const receipt = await db.prepare('SELECT uploaded_at,sha256 FROM c_capture_receipts WHERE id=? AND owner_email=?').bind(id, actor.email).first<{ uploaded_at: string; sha256: string }>();
  requireThat(receipt, 'Receipt not found', 404);
  const at = now();
  requireThat(at >= receipt.uploaded_at, 'The receipt timestamp is ahead of the clock; try again later', 409);
  return { receipt, sequence: sequence as number, at };
}

/** Still-active employee, the original, its exact sequence and that it has no terminal line yet (beside authority()). */
export function openOriginal(actor: Actor, id: string, sequence: number, at: string): Sql {
  return {
    sql: `EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1)
      AND EXISTS(SELECT 1 FROM c_capture_receipts WHERE id=? AND owner_email=? AND uploaded_at<=?)
      AND (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND kind IN ('discarded','merged'))`,
    params: [actor.email, id, actor.email, at, id, sequence, id],
  };
}

/** A discard changes disposition only; the original and reader evidence stay. */
export async function discardReceipt(db: D1Database, actor: Actor, id: string, b: Data) {
  const { sequence, at } = await terminal(db, actor, id, b, ['reason', 'expectedSequence']);
  requireThat(!await db.prepare(`SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=?`).bind(id).first(), 'Detach the receipt before discarding it', 409);
  const reason = text(b.reason, 'Reason', 1000);
  await commit(db, all(authority(actor, 'employee'), openOriginal(actor, id, sequence, at), {sql:'NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=?)',params:[id]}),
    [db.prepare('INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,at,actor_email,on_behalf_of,channel) VALUES(?,?,\'discarded\',?,?,?,?,\'app\')')
      .bind(id, sequence + 1, reason, at, actor.delegate?.email ?? actor.email, actor.delegate ? actor.email : null)]);
  return { receipt: (await listInbox(db, actor)).receipts.find(receipt => receipt.id === id) };
}

/** A merge retires one duplicate into a surviving original of the same employee. The survivor is not written;
 * the reason is required unless both originals have the same SHA-256. */
export async function mergeReceipt(db: D1Database, actor: Actor, id: string, b: Data) {
  const { receipt, sequence, at } = await terminal(db, actor, id, b, ['survivorId', 'reason', 'expectedSequence']);
  requireThat(typeof b.survivorId === 'string' && b.survivorId.length > 0 && b.survivorId !== id, 'Choose a different receipt to keep');
  const survivor = await db.prepare('SELECT sha256,uploaded_at FROM c_capture_receipts WHERE id=? AND owner_email=?').bind(b.survivorId, actor.email).first<{ sha256: string; uploaded_at: string }>();
  requireThat(survivor, 'Receipt to keep not found', 404);
  requireThat(!await db.prepare(`SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id IN (?,?)`).bind(id,b.survivorId).first(), 'Detach receipts before merging them', 409);
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(reason || survivor.sha256 === receipt.sha256, 'Reason is required unless both receipts are identical files (at most 1000 characters)');
  requireThat(at >= survivor.uploaded_at, 'The receipt timestamp is ahead of the clock; try again later', 409);
  const kept = { sql: `EXISTS(SELECT 1 FROM c_capture_receipts WHERE id=? AND owner_email=? AND uploaded_at<=? AND (?<>'' OR sha256=?))
      AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND kind IN ('discarded','merged'))
      AND NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id IN (?,?))`,
    params: [b.survivorId, actor.email, at, reason, receipt.sha256, b.survivorId, id, b.survivorId] };
  await commit(db, all(authority(actor, 'employee'), openOriginal(actor, id, sequence, at), kept),
    [db.prepare('INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,survivor_id,at,actor_email,on_behalf_of,channel) VALUES(?,?,\'merged\',?,?,?,?,?,\'app\')')
      .bind(id, sequence + 1, reason, b.survivorId, at, actor.delegate?.email ?? actor.email, actor.delegate ? actor.email : null)]);
  return { receipt: (await listInbox(db, actor)).receipts.find(receipt => receipt.id === id) };
}
