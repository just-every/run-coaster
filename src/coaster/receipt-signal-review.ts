import { all, authority, commit, need } from './session';
import { claimState, loadClaim, visible } from './claims';
import { event } from './events';
import { requireThat, text, type Actor, type Data } from './types';

/** Finance records a person's disposition as append-only claim history; this never
 * changes a signal, revision, approval, batch, release or payment. */
export async function reviewReceiptSignal(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person reviews receipt signals', 403);
  const claim = await loadClaim(db, id);
  visible(actor, claim);
  requireThat(b.revision === claim.revision, 'The revision changed; reload before reviewing', 409);
  const row = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id, claim.revision).first<{snapshot:string}>();
  const signal = row && JSON.parse(row.snapshot).receiptSignals?.find((r: Data) => r.item === b.item)?.signals.find((s: Data) => s.code === b.code);
  requireThat(signal, 'Receipt signal not found on this revision', 404);
  const note = text(b.note, 'Review note', 1000);
  const unreviewed = { sql: "NOT EXISTS(SELECT 1 FROM c_events WHERE claim_id=? AND action='receipt-signal-reviewed' AND json_extract(detail,'$.revision')=? AND json_extract(detail,'$.item')=? AND json_extract(detail,'$.code')=?)", params: [id,claim.revision,b.item,b.code] };
  requireThat(!(await db.prepare("SELECT 1 FROM c_events WHERE claim_id=? AND action='receipt-signal-reviewed' AND json_extract(detail,'$.revision')=? AND json_extract(detail,'$.item')=? AND json_extract(detail,'$.code')=?").bind(id,claim.revision,b.item,b.code).first()), 'This signal has already been reviewed', 409);
  await commit(db, all(authority(actor,'finance'), claimState(id,claim.version,[claim.status]), unreviewed), [event(db,actor,'receipt-signal-reviewed',{claim:id},{revision:claim.revision,item:b.item,code:b.code,note,reason:signal.reason})]);
  return {reviewed:true};
}
