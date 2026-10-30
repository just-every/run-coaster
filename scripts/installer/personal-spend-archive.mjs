import { createHash } from 'node:crypto';
import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** A personal obligation remains unpaid and tied to its original source, even after statement undo or erasure. */
export async function validatePersonalSpendArchive(read) {
  const [personal, charges, undone, members, events, handoffs] = await Promise.all(['c_card_personal_spend', 'c_card_charges', 'c_card_charge_undo_history', 'c_members', 'c_events', 'c_card_handoffs'].map(read));
  const check = ok => { if (!ok) throw new PortabilityError('coaster_personal_spend', 409); };
  const key = transaction => createHash('sha256').update(transaction).digest('hex');
  check(new Set(personal.map(p => p.id)).size === personal.length && new Set(personal.map(p => p.source_key)).size === personal.length && new Set(personal.map(p => p.event_id)).size === personal.length);
  for (const p of personal) {
    const source = [...charges, ...undone].find(c => c.id === p.charge_id);
    check(source && source.liability === 'company' && p.source_key === key(source.transaction_key) && p.card_id === source.card_id && p.item_id === source.item_id);
    check(p.liability === 'company' && p.classification === 'personal' && p.channel === 'app' && p.actor_email === p.employee_email);
    check(members.some(m => m.email === p.employee_email) && Number.isSafeInteger(p.amount_minor) && p.amount_minor > 0 && p.amount_minor === source.amount_minor && p.currency === source.currency && p.outstanding_minor === p.amount_minor);
    check(Number.isSafeInteger(p.claim_version) && p.claim_version >= 1 && typeof p.marked_at === 'string' && Number.isFinite(Date.parse(p.marked_at)) && new Date(p.marked_at).toISOString() === p.marked_at);
    // Scheduled splits move the expense but retain its immutable source claim. Follow only recorded moves of this item.
    const placements = new Set([source.claim_id]);
    for (const e of events.filter(e => e.action === 'auto-report-split').sort((a,b) => a.seq-b.seq)) {
      const d = JSON.parse(e.detail);
      if (placements.has(e.claim_id) && d.held?.some(h => h.item === p.item_id)) placements.add(d.heldClaim);
    }
    check((source.employee_email === p.employee_email && placements.has(p.claim_id)) || handoffs.some(h => h.charge_id === source.id && h.from_email === p.employee_email && h.from_claim === p.claim_id));
    const history = events.filter(e => e.id === p.event_id);
    check(history.length === 1);
    const e = history[0], d = JSON.parse(e.detail);
    check(e.action === 'card-charge-marked-personal' && e.actor_email === p.actor_email && e.claim_id === p.claim_id && Number.isSafeInteger(e.seq) && e.seq > 0 && d.personalSpend === p.id && d.charge === p.charge_id && d.sourceKey === p.source_key && d.amountMinor === p.amount_minor && d.outstandingMinor === p.outstanding_minor && d.currency === p.currency && d.liability === 'company' && d.channel === 'app');
    // A source imported again must not acquire a different principal or lose its original obligation.
    for (const c of [...charges, ...undone].filter(c => key(c.transaction_key) === p.source_key)) check(c.liability === 'company' && c.card_id === p.card_id && c.amount_minor === p.amount_minor && c.currency === p.currency);
  }
  for (const e of events.filter(e => e.action === 'card-charge-marked-personal')) check(personal.some(p => p.event_id === e.id));
}
