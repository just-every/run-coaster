import { all, authority, commit } from '../session';
import { claimState, claimTotal, loadClaim } from '../claims';
import { event } from '../events';
import { requireThat, type Actor, type Data } from '../types';

/** The cardholder classifies their own unsubmitted charge; source liability and money facts never change. */
export async function classifyCharge(db: D1Database, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use your own native sign-in to classify a card charge', 403);
  const claim = await loadClaim(db, id);
  requireThat(claim.employee_email === actor.email, 'Only the cardholder classifies their charge', 403);
  requireThat(['draft', 'returned'].includes(claim.status) && b.version === claim.version, 'This claim changed or is frozen; reload', 409);
  requireThat(typeof b.personal === 'boolean', 'Say whether this charge is personal');
  const item = await db.prepare('SELECT i.id,i.card_charge_id,i.card_personal FROM c_items i JOIN c_card_charges ch ON ch.id=i.card_charge_id WHERE i.id=? AND i.claim_id=? AND ch.liability=\'individual\' AND ch.employee_email=?').bind(b.item, id, actor.email).first<{id:string;card_charge_id:string;card_personal:number}>();
  requireThat(item, 'An individual-liability charge on your claim is required', 409);
  await commit(db, all(authority(actor, 'employee'), claimState(id, claim.version, ['draft','returned'])), [
    db.prepare('UPDATE c_items SET card_personal=? WHERE id=?').bind(b.personal ? 1 : 0, item.id),
    claimTotal(db, id),
    event(db, actor, 'card-charge-classified', {claim:id}, {charge:item.card_charge_id,item:item.id,liability:'individual',beforePersonal:!!item.card_personal,personal:b.personal}),
  ]);
  return loadClaim(db, id);
}
