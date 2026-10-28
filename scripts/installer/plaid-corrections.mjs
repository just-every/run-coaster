import { PortabilityError } from '@runeditrun/rer/modules/portability';

const check = condition => { if (!condition) throw new PortabilityError('coaster_plaid_correction', 409); };
const key = row => JSON.stringify([row.connection_id, row.transaction_id]);
const parse = value => { try { return JSON.parse(value); } catch { check(false); } };
const body = value => value && typeof value.blob === 'string' ? Buffer.from(value.blob, 'base64') : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value ?? []);
const facts = source => parse(body(source.bytes).toString('utf8'));
const sameFacts = (a, b) => ['transaction_id','account_id','pending_transaction_id','pending','spent_on','posted_on','merchant','amount_minor','provider_amount','currency'].every(k => a[k] === b[k]);
const nonempty = value => typeof value === 'string' && value.length > 0;

/** Validate correction provenance before the ordinary source validator uses its maps.
 * sources: source id -> { item, charge, personalCharge, snapshot, replacement }; effective: connection and transaction key -> correction.
 */
export async function validatePlaidCorrections(read) {
  const [corrections, changes, sources, charges, personalCharges, items, claims, revisions, events] = await Promise.all(
    ['c_plaid_corrections','c_plaid_changes','c_plaid_sources','c_card_charges','c_plaid_personal_charges','c_items','c_claims','c_revisions','c_events'].map(read));
  const bySource = new Map(sources.map(row => [row.id,row])), byChange = new Map(changes.map(row => [row.seq,row]));
  const byCharge = new Map(charges.map(row => [row.id,row])), byPersonal = new Map(personalCharges.map(row => [row.id,row])), byItem = new Map(items.map(row => [row.id,row]));
  const expected = new Map(), effective = new Map(), previous = new Map(), oldItems = new Set(), newItems = new Set();
  for (const row of [...corrections].sort((a,b) => a.seq-b.seq)) {
    const change = byChange.get(row.change_seq), old = bySource.get(row.old_source_id), replacement = bySource.get(row.new_source_id);
    const snapshot = parse(row.prior_snapshot), item = snapshot?.item, chain = previous.get(key(row));
    check(Number.isSafeInteger(row.seq) && row.seq > 0 && change && change.connection_id === row.connection_id && change.transaction_id === row.transaction_id && old);
    check(['draft','returned'].includes(row.claim_state) && ['company','personal'].includes(row.scope) && row.consent === 1 && nonempty(row.actor_email) && nonempty(row.employee_email) && nonempty(row.at) && Number.isSafeInteger(row.claim_version) && row.claim_version > 0);
    const lineage = expected.get(row.old_source_id);
    check(!lineage || lineage.item === row.old_item_id && lineage.charge === row.old_charge_id);
    check(old.transaction_id === row.transaction_id && (!chain || chain.new_source_id === row.old_source_id && chain.new_item_id === row.old_item_id && chain.new_charge_id === row.old_charge_id && chain.change_seq < row.change_seq));
    check(!oldItems.has(row.old_item_id) && !newItems.has(row.new_item_id) && item && item.id === row.old_item_id && item.claim_id === row.claim_id && Array.isArray(snapshot.allocations) && snapshot.allocations.length === 1 && snapshot.allocations[0].item_id === item.id);
    check(['contexts','suggestions','feedback','observations'].every(name => Array.isArray(snapshot[name])) && snapshot.contexts.length === 1 && snapshot.contexts[0].target_id === item.id);
    check(item.receipt_id === null && item.card_charge_id === row.old_charge_id && (claims.some(claim => claim.id === row.claim_id && claim.employee_email === row.employee_email) || events.some(event => event.action === 'claim-expired' && event.claim_id === row.claim_id)));
    const originalFacts = facts(old);
    check(item.merchant === originalFacts.merchant && item.amount_minor === originalFacts.amount_minor && item.spent_on === originalFacts.spent_on);
    const submitted=revisions.flatMap(revision => (parse(revision.snapshot).items ?? []).filter(entry=>entry.id===item.id||row.old_charge_id&&entry.card_charge_id===row.old_charge_id));
    check(!submitted.length || row.claim_state==='returned' && submitted.every(entry=>entry.amount_minor===originalFacts.amount_minor&&entry.merchant===originalFacts.merchant&&entry.spent_on===originalFacts.spent_on&&entry.card_charge_id===item.card_charge_id));
    let oldPersonal = null;
    if (row.scope === 'company') {
      const charge = byCharge.get(row.old_charge_id);
      check(charge && charge.file_id === old.id && charge.item_id === item.id && charge.claim_id === row.claim_id && charge.employee_email === row.employee_email && charge.transaction_on === originalFacts.spent_on && charge.posted_on === originalFacts.posted_on && charge.descriptor === originalFacts.merchant && charge.amount_minor === originalFacts.amount_minor && charge.currency === originalFacts.currency && item.personal_card_charge_id === null);
    } else {
      check(row.old_charge_id === null && item.card_charge_id === null);
      if (item.personal_card_charge_id !== null) {
        oldPersonal = byPersonal.get(item.personal_card_charge_id);
        check(oldPersonal && oldPersonal.file_id === old.id && oldPersonal.connection_id === old.connection_id && oldPersonal.item_id === item.id && oldPersonal.claim_id === row.claim_id && oldPersonal.employee_email === row.employee_email && oldPersonal.transaction_id === row.transaction_id && oldPersonal.transaction_on === item.spent_on && oldPersonal.posted_on === originalFacts.posted_on && oldPersonal.descriptor === item.merchant && oldPersonal.amount_minor === item.amount_minor && oldPersonal.currency === originalFacts.currency);
      }
    }
    if (row.reason === 'provider-removal') check(change.kind === 'removed' && row.new_source_id === null && row.new_item_id === null && row.new_charge_id === null);
    else {
      check(row.reason === 'provider-replacement' && change.kind === 'modified' && replacement && replacement.connection_id === row.connection_id && replacement.transaction_id === row.transaction_id && nonempty(row.new_item_id) && row.new_item_id !== row.old_item_id && row.new_source_id !== row.old_source_id);
      const current = parse(change.facts), revised = facts(replacement);
      check(current.pending === false && current.amount_minor > 0 && sameFacts(current,revised));
      if (row.scope === 'company') {
        const charge = byCharge.get(row.new_charge_id);
        check(charge && charge.file_id === replacement.id && charge.item_id === row.new_item_id && charge.claim_id === row.claim_id && charge.employee_email === row.employee_email && charge.transaction_on === revised.spent_on && charge.posted_on === revised.posted_on && charge.descriptor === revised.merchant && charge.amount_minor === revised.amount_minor && charge.currency === revised.currency && charge.id !== row.old_charge_id);
      } else {
        check(row.new_charge_id === null);
        const next = personalCharges.filter(charge => charge.item_id === row.new_item_id);
        check(next.length === 1 && next[0].file_id === replacement.id && next[0].connection_id === replacement.connection_id && next[0].claim_id === row.claim_id && next[0].employee_email === row.employee_email && next[0].transaction_id === row.transaction_id && next[0].transaction_on === revised.spent_on && next[0].posted_on === revised.posted_on && next[0].descriptor === revised.merchant && next[0].amount_minor === revised.amount_minor && next[0].currency === revised.currency);
      }
      const personalCharge = row.scope === 'personal' ? personalCharges.find(charge => charge.item_id === row.new_item_id).id : null;
      expected.set(row.new_source_id,{item:row.new_item_id,charge:row.new_charge_id,personalCharge,snapshot:null,replacement:true});
      newItems.add(row.new_item_id);
    }
    check(!byItem.has(row.old_item_id));
    expected.set(row.old_source_id,{item:row.old_item_id,charge:row.old_charge_id,personalCharge:oldPersonal?.id ?? null,snapshot,replacement:!!chain});
    oldItems.add(row.old_item_id); previous.set(key(row),row); effective.set(key(row),row);
  }
  return { sources: expected, effective };
}
