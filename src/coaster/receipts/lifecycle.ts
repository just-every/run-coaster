import { all, authority, commit, need } from '../session';
import { now, requireThat, text, type Actor, type Data } from '../types';
import { listInbox } from './inbox';

/** A discard changes disposition only; the original and reader evidence stay. */
export async function discardReceipt(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'A native employee sign-in is required', 403);
  const employee = await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1').bind(actor.email).first();
  requireThat(employee, 'Employee access required', 403);
  requireThat(b && !Array.isArray(b) && Object.keys(b).every(key => ['reason', 'expectedSequence'].includes(key)), 'Only reason and expectedSequence are accepted');
  const reason = text(b.reason, 'Reason', 1000), sequence = b.expectedSequence;
  requireThat(Number.isSafeInteger(sequence) && sequence >= 0, 'Reload the inbox and supply its lifecycle sequence');
  const receipt = await db.prepare('SELECT uploaded_at FROM c_capture_receipts WHERE id=? AND owner_email=?').bind(id, actor.email).first<{ uploaded_at: string }>();
  requireThat(receipt, 'Receipt not found', 404);
  const at = now();
  requireThat(at >= receipt.uploaded_at, 'The receipt timestamp is ahead of the clock; try again later', 409);
  await commit(db, all(authority(actor, 'employee'), {
    sql: `EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1)
      AND EXISTS(SELECT 1 FROM c_capture_receipts WHERE id=? AND owner_email=? AND uploaded_at<=?)
      AND (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND kind='discarded')`,
    params: [actor.email, id, actor.email, at, id, sequence, id],
  }), [db.prepare('INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,at,actor_email,on_behalf_of,channel) VALUES(?,?,\'discarded\',?,?,?,?,\'app\')')
    .bind(id, sequence + 1, reason, at, actor.delegate?.email ?? actor.email, actor.delegate ? actor.email : null)]);
  return { receipt: (await listInbox(db, actor)).receipts.find(receipt => receipt.id === id) };
}
