import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { validDiscardReason } from '../../src/coaster/receipts/reasons.mjs';

/** Validate the entire overlay chain and every batch selection before destination writes. */
export async function validateAccountCorrectionsArchive(read) {
  const [corrections, frozen, revisions, claims, batches, batchClaims, events, members] = await Promise.all(
    ['c_account_corrections','c_batch_coding','c_revisions','c_claims','c_batches','c_batch_claims','c_events','c_members'].map(table => read(table)));
  const check = value => { if (!value) throw new PortabilityError('coaster_account_corrections', 409); };
  const seen = new Map();
  for (const c of [...corrections].sort((a,b) => a.sequence-b.sequence)) {
    check(typeof c.id === 'string' && c.id.length && claims.some(claim => claim.id === c.claim_id));
    check(Number.isSafeInteger(c.sequence) && c.sequence === (seen.get(c.claim_id) ?? 0) + 1);
    seen.set(c.claim_id,c.sequence);
    const revision = revisions.find(r => r.claim_id === c.claim_id && r.revision === c.revision);
    const item = revision && JSON.parse(revision.snapshot).items.find(i => i.id === c.item_id);
    const part = item?.allocations.find(p => p.position === c.allocation_position);
    check(item?.kind === 'receipt' && !item.card_charge_id && !item.allowance_id && part);
    const earlier = corrections.filter(p => p.claim_id === c.claim_id && p.revision === c.revision && p.item_id === c.item_id && p.allocation_position === c.allocation_position && p.sequence < c.sequence).sort((a,b) => a.sequence-b.sequence).at(-1);
    check(c.before_account === (earlier?.after_account ?? part.account_code));
    check(typeof c.after_account === 'string' && c.after_account === c.after_account.trim() && c.after_account.length > 0 && c.after_account.length <= 100 && c.after_account !== c.before_account);
    check(validDiscardReason(c.reason,members) && typeof c.actor_email === 'string' && c.actor_email.length && Number.isFinite(Date.parse(c.at)));
    const event = events.find(e => e.claim_id === c.claim_id && e.action === 'account-code-corrected' && JSON.parse(e.detail).correction === c.id);
    const detail = event && JSON.parse(event.detail);
    check(event?.actor_email === c.actor_email && detail.revision === c.revision && detail.sequence === c.sequence && detail.item === c.item_id && detail.allocation === c.allocation_position && detail.before === c.before_account && detail.after === c.after_account && detail.reason === c.reason && (detail.actingFor ?? null) === c.acting_for);
  }
  for (const f of frozen) {
    check(batches.some(b => b.id === f.batch_id) && revisions.some(r => r.claim_id === f.claim_id && r.revision === f.revision));
    check(Number.isSafeInteger(f.correction_sequence) && f.correction_sequence >= 0 && f.correction_sequence <= (seen.get(f.claim_id) ?? 0));
  }
  for (const bc of batchClaims) {
    const relevant = corrections.filter(c => c.claim_id === bc.claim_id && c.revision === bc.revision);
    const f = frozen.find(f => f.batch_id === bc.batch_id && f.claim_id === bc.claim_id);
    // Older archives with no corrections remain valid. New overlays require their exact selection.
    if (relevant.length) check(f && f.revision === bc.revision && relevant.every(c => c.sequence <= f.correction_sequence));
    if (f) check(f.revision === bc.revision);
  }
}
