import { validDiscardReason } from '../../src/coaster/receipts/reasons.mjs';
import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Submitted bytes anchor every chain; retained selections remain evidence after removal. */
export async function validateAccountingCorrectionsArchive(read) {
  const [corrections,selections,revisions,claims,batches,events,periods,members,batchClaims] = await Promise.all(['c_coding_corrections','c_coding_batch_selections','c_revisions','c_claims','c_batches','c_events','c_accounting_periods','c_members','c_batch_claims'].map(read));
  const legacy = await read('c_account_corrections'), frozen = await read('c_batch_coding');
  const check=ok=>{if(!ok)throw new PortabilityError('coaster_accounting_corrections',409);};
  const allocation=c=>JSON.parse(revisions.find(r=>r.claim_id===c.claim_id&&r.revision===c.revision)?.snapshot??'{}').items?.find(i=>i.id===c.item_id)?.allocations?.[c.allocation];
  const ids=new Set();
  for(const c of corrections){
    const original=allocation(c), chain=corrections.filter(x=>x.claim_id===c.claim_id&&x.revision===c.revision&&x.item_id===c.item_id&&x.allocation===c.allocation).sort((a,b)=>a.sequence-b.sequence);
    check(original&&claims.some(x=>x.id===c.claim_id)&&!ids.has(c.id));ids.add(c.id);
    check(Number.isInteger(c.sequence)&&c.sequence>0&&chain[c.sequence-1]===c&&new Set(chain.map(x=>x.sequence)).size===chain.length);
    check(c.before_code===(c.sequence===1?original.account_code:chain[c.sequence-2].after_code)&&typeof c.after_code==='string'&&c.after_code.trim().length>0&&c.after_code.length<=100&&c.after_code!==c.before_code);
    check(validDiscardReason(c.reason,members)&&typeof c.actor_email==='string'&&c.actor_email.length>0&&Number.isFinite(Date.parse(c.at)));
    const audit=events.filter(e=>e.claim_id===c.claim_id&&e.action==='expense-account-code-corrected').find(e=>JSON.parse(e.detail).correction===c.id),d=audit&&JSON.parse(audit.detail);
    check(audit&&audit.actor_email===c.actor_email&&Number.isFinite(Date.parse(audit.at))&&d.revision===c.revision&&d.item===c.item_id&&d.allocation===c.allocation&&d.sequence===c.sequence&&d.before===c.before_code&&d.after===c.after_code&&d.reason===c.reason);
  }
  for (const e of events.filter(e=>e.action==='expense-account-code-corrected'))
    check(corrections.some(c=>c.id===JSON.parse(e.detail).correction&&c.claim_id===e.claim_id));
  const selected=new Set();
  for(const s of selections){
    const original=allocation(s),c=corrections.find(c=>c.id===s.correction_id),key=JSON.stringify([s.batch_id,s.claim_id,s.revision,s.item_id,s.allocation]);
    check(original&&batches.some(b=>b.id===s.batch_id)&&!selected.has(key));selected.add(key);
    check(s.correction_id===null?s.account_code===(legacy.filter(c=>c.claim_id===s.claim_id&&c.revision===s.revision&&c.item_id===s.item_id&&c.allocation_position===s.allocation&&c.sequence<=(frozen.find(f=>f.batch_id===s.batch_id&&f.claim_id===s.claim_id)?.correction_sequence??0)).sort((a,b)=>a.sequence-b.sequence).at(-1)?.after_account??original.account_code):c&&c.claim_id===s.claim_id&&c.revision===s.revision&&c.item_id===s.item_id&&c.allocation===s.allocation&&s.account_code===c.after_code);
  }
  // Frozen batches must retain every allocation, not merely validate whichever selections remain.
  // Pre-correction installations can have legacy batches without selections; corrected revisions cannot use that fallback.
  const complete=(batch,claim,revision)=>{
    const snapshot=revisions.find(r=>r.claim_id===claim&&r.revision===revision);
    check(snapshot);
    for(const item of JSON.parse(snapshot.snapshot).items)for(const allocation of item.allocations.keys())
      check(selected.has(JSON.stringify([batch,claim,revision,item.id,allocation])));
  };
  for(const s of selections)complete(s.batch_id,s.claim_id,s.revision);
  for(const bc of batchClaims){
    const frozen=events.some(e=>e.batch_id===bc.batch_id&&e.action==='batch-created'&&JSON.parse(e.detail).codingSelections===1)
      ||selections.some(s=>s.batch_id===bc.batch_id)
      ||corrections.some(c=>c.claim_id===bc.claim_id&&c.revision===bc.revision);
    if(frozen)complete(bc.batch_id,bc.claim_id,bc.revision);
  }
  for(const p of periods)check(p.ledger==='desktop'&&/^\d{4}-\d{2}-\d{2}$/.test(p.start_on)&&/^\d{4}-\d{2}-\d{2}$/.test(p.end_on)&&p.start_on<=p.end_on&&(p.closed_at===null||Number.isFinite(Date.parse(p.closed_at))));
}
