import { all, authority, commit } from '../session';
import { claimState, claimTotal, loadClaim } from '../claims';
import { requireThat, uid, type Actor, type Data } from '../types';
import { openOriginal, terminal } from './lifecycle';
import { listInbox } from './inbox';

/** The current association is the expense, never a mutable pointer on the original. */
export const attachedSql = `SELECT i.id AS itemId,c.id AS claimId,c.version,c.status,c.title AS claimTitle,i.merchant
 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id JOIN c_claims c ON c.id=i.claim_id WHERE a.capture_receipt_id=?`;

export async function changeAttachment(db: D1Database, actor: Actor, id: string, b: Data, detach: boolean) {
  const { sequence, at } = await terminal(db, actor, id, b, ['expectedSequence','claimId','itemId','version']);
  const claim = await loadClaim(db, b.claimId);
  requireThat(claim.employee_email === actor.email, 'Claim not found', 404);
  requireThat(['draft','returned'].includes(claim.status) && b.version === claim.version, 'Reload an editable draft or returned claim', 409);
  requireThat(typeof b.itemId === 'string', 'Choose an expense');
  const item = await db.prepare('SELECT id,kind,receipt_id FROM c_items WHERE id=? AND claim_id=?').bind(b.itemId,claim.id).first<{ id: string; kind: string; receipt_id: string | null }>();
  requireThat(item, 'Expense not found', 404);
  requireThat(item.kind === 'receipt', 'Choose a purchase expense');
  const current = await db.prepare(attachedSql).bind(id).first<{ itemId: string; claimId: string }>();
  requireThat(detach ? current?.itemId === item.id && current.claimId === claim.id : !current && !item.receipt_id,
    detach ? 'This original is not attached to that expense' : 'Detach the existing receipt before attaching another', 409);
  const alias = uid();
  const statements: D1PreparedStatement[] = detach ? [] : [db.prepare(`INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at,capture_receipt_id)
    SELECT ?,?,owner_email,name,media_type,size,sha256,X'',source,uploaded_by,uploaded_at,id FROM c_capture_receipts WHERE id=?`).bind(alias,claim.id,id)];
  statements.push(db.prepare('UPDATE c_items SET receipt_id=? WHERE id=? AND claim_id=?').bind(detach ? null : alias,item.id,claim.id),
    db.prepare(`INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,claim_id,item_id,at,actor_email,on_behalf_of,channel) VALUES(?,?,?,'',?,?,?,?,?,'app')`)
      .bind(id,sequence+1,detach?'detached':'attached',claim.id,item.id,at,actor.delegate?.email??actor.email,actor.delegate?actor.email:null),claimTotal(db,claim.id));
  const association = detach ? {sql:`EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE i.id=? AND i.claim_id=? AND a.capture_receipt_id=?)`,params:[item.id,claim.id,id]}
    : {sql:`EXISTS(SELECT 1 FROM c_items WHERE id=? AND claim_id=? AND kind='receipt' AND receipt_id IS NULL) AND NOT EXISTS(${attachedSql})`,params:[item.id,claim.id,id]};
  await commit(db,all(authority(actor,'employee'),openOriginal(actor,id,sequence,at),claimState(claim.id,claim.version,['draft','returned']),association),statements);
  return {receipt:(await listInbox(db,actor)).receipts.find(r=>r.id===id),claim:await loadClaim(db,claim.id)};
}
