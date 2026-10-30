import { validDiscardReason } from '../../src/coaster/receipts/reasons.mjs';
import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Submitted bytes anchor every chain; retained selections remain evidence after removal. */
export async function validateAccountingCorrectionsArchive(read) {
  const [corrections,selections,revisions,claims,batches,events,periods,members] = await Promise.all(['c_coding_corrections','c_batch_coding','c_revisions','c_claims','c_batches','c_events','c_accounting_periods','c_members'].map(read));
  const check=ok=>{if(!ok)throw new PortabilityError('coaster_accounting_corrections',409);};
  const allocation=c=>JSON.parse(revisions.find(r=>r.claim_id===c.claim_id&&r.revision===c.revision)?.snapshot??'{}').items?.find(i=>i.id===c.item_id)?.allocations?.[c.allocation];
  const ids=new Set();
  for(const c of corrections){
    const original=allocation(c), chain=corrections.filter(x=>x.claim_id===c.claim_id&&x.revision===c.revision&&x.item_id===c.item_id&&x.allocation===c.allocation).sort((a,b)=>a.sequence-b.sequence);
    check(original&&claims.some(x=>x.id===c.claim_id)&&!ids.has(c.id));ids.add(c.id);
    check(Number.isInteger(c.sequence)&&c.sequence>0&&chain[c.sequence-1]===c&&new Set(chain.map(x=>x.sequence)).size===chain.length);
    check(c.before_code===(c.sequence===1?original.account_code:chain[c.sequence-2].after_code)&&typeof c.after_code==='string'&&c.after_code.trim().length>0&&c.after_code.length<=100&&c.after_code!==c.before_code);
    check(validDiscardReason(c.reason,members)&&typeof c.actor_email==='string'&&c.actor_email.length>0&&Number.isFinite(Date.parse(c.at)));
    const audit=events.filter(e=>e.claim_id===c.claim_id&&e.action==='account-code-corrected').find(e=>JSON.parse(e.detail).correction===c.id),d=audit&&JSON.parse(audit.detail);
    check(audit&&audit.actor_email===c.actor_email&&Number.isFinite(Date.parse(audit.at))&&d.revision===c.revision&&d.item===c.item_id&&d.allocation===c.allocation&&d.sequence===c.sequence&&d.before===c.before_code&&d.after===c.after_code&&d.reason===c.reason);
  }
  const selected=new Set();
  for(const s of selections){
    const original=allocation(s),c=corrections.find(c=>c.id===s.correction_id),key=JSON.stringify([s.batch_id,s.claim_id,s.revision,s.item_id,s.allocation]);
    check(original&&batches.some(b=>b.id===s.batch_id)&&!selected.has(key));selected.add(key);
    check(s.correction_id===null?s.account_code===original.account_code:c&&c.claim_id===s.claim_id&&c.revision===s.revision&&c.item_id===s.item_id&&c.allocation===s.allocation&&s.account_code===c.after_code);
  }
  for(const p of periods)check(p.ledger==='desktop'&&/^\d{4}-\d{2}-\d{2}$/.test(p.start_on)&&/^\d{4}-\d{2}-\d{2}$/.test(p.end_on)&&p.start_on<=p.end_on&&(p.closed_at===null||Number.isFinite(Date.parse(p.closed_at))));
}
