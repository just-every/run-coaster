import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Validate liability against source provenance and approved money before any destination writes. */
export async function validateLiabilityArchive(read) {
  const [feeds,charges,undone,items,revisions,claims,batchClaims,keys,deliveries] = await Promise.all(['c_program_feeds','c_card_charges','c_card_charge_undo_history','c_items','c_revisions','c_claims','c_batch_claims','c_reimbursement_keys','c_program_deliveries'].map(read));
  const check = ok => { if (!ok) throw new PortabilityError('coaster_card_liability',409); };
  const liability = row => row.card_liability ?? 'company';
  const personal = row => row.card_personal ?? 0;
  const eligible = row => !row.card_charge_id || liability(row)==='individual' && personal(row)===0;
  for (const feed of feeds) check(['company','individual'].includes(feed.liability??'company'));
  for (const charge of [...charges,...undone]) {
    check(['company','individual'].includes(charge.liability??'company'));
    if (charge.program_id) check(feeds.some(f=>f.id===charge.program_id && f.liability===charge.liability) && deliveries.some(d=>d.feed_id===charge.program_id && d.file_id===charge.file_id));
    if (charge.liability==='individual') check(Boolean(charge.program_id));
  }
  const validateItem = item => {
    check([0,1].includes(personal(item)));
    if (!item.card_charge_id) { check(liability(item)==='company' && personal(item)===0); return; }
    const charge=[...charges,...undone].find(c=>c.id===item.card_charge_id);
    check(charge && liability(item)===(charge.liability??'company') && (personal(item)===0 || liability(item)==='individual'));
    if (item.card_transaction_key) check(item.card_transaction_key===charge.transaction_key);
  };
  items.forEach(validateItem);
  for (const revision of revisions) {
    const snapshot=JSON.parse(revision.snapshot);
    snapshot.items.forEach(validateItem);
    check(snapshot.total_minor===snapshot.items.reduce((n,i)=>n+(eligible(i)?i.amount_minor:0),0) && revision.total_minor===snapshot.total_minor);
    const claim=claims.find(c=>c.id===revision.claim_id);
    if (claim?.revision===revision.revision && ['submitted','approved','batched','reimbursed'].includes(claim.status)) {
      for (const item of items.filter(i=>i.claim_id===claim.id && i.card_charge_id)) {
        const frozen=snapshot.items.find(i=>i.id===item.id);
        check(frozen && liability(frozen)===liability(item) && personal(frozen)===personal(item));
      }
    }
  }
  for (const key of keys.filter(k=>k.key.startsWith('card:'))) {
    const bc=batchClaims.find(b=>b.batch_id===key.batch_id && b.claim_id===key.claim_id);
    const revision=bc&&revisions.find(r=>r.claim_id===bc.claim_id && r.revision===bc.revision);
    const item=revision&&JSON.parse(revision.snapshot).items.find(i=>i.id===key.item_id);
    check(item && item.card_charge_id && eligible(item) && key.key===`card:${item.card_transaction_key}`);
  }
}
