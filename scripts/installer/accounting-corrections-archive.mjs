import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Validate portable correction chains and inert batch selections before importing any financial rows. */
export async function validateAccountingCorrectionsArchive(read) {
  const [corrections, frozen, revisions, batches, events] = await Promise.all(['c_accounting_corrections','c_batch_accounting_coding','c_revisions','c_batches','c_events'].map(read));
  const check = ok => { if (!ok) throw new PortabilityError('coaster_accounting_corrections',409); };
  const originals = new Map(revisions.map(r => [`${r.claim_id}:${r.revision}`, JSON.parse(r.snapshot)]));
  const checkChain = rows => {
    const sequences = new Map();
    for (const row of [...rows].sort((a,b)=>a.sequence-b.sequence)) {
      const item = originals.get(`${row.claim_id}:${row.revision}`)?.items.find(i=>i.id===row.item_id);
      check(item && typeof row.reason==='string' && row.reason.trim() && typeof row.actor_email==='string');
      const key = `${row.claim_id}:${row.revision}:${row.item_id}`, previous = sequences.get(key);
      const before = JSON.parse(row.before_json), after = JSON.parse(row.after_json);
      check(row.sequence === (previous?.sequence ?? 0) + 1 && JSON.stringify(before) === JSON.stringify(previous ? JSON.parse(previous.after_json) : {accounts:item.allocations.map(a=>a.account_code)}));
      check(Object.keys(after).join() === 'accounts' && Array.isArray(after.accounts) && after.accounts.length===item.allocations.length && after.accounts.every(a=>typeof a==='string' && a.trim() && a.length<=100));
      check(JSON.stringify(after)!==JSON.stringify(before));
      sequences.set(key,row);
      const audit = events.find(e=>e.action==='accounting-coding-corrected' && JSON.parse(e.detail).correction===row.id);
      const detail = audit && JSON.parse(audit.detail);
      check(audit && audit.claim_id===row.claim_id && audit.actor_email===row.actor_email && detail.item===row.item_id && detail.sequence===row.sequence && JSON.stringify(detail.before)===JSON.stringify(before) && JSON.stringify(detail.after)===JSON.stringify(after));
    }
  };
  checkChain(corrections);
  for (const row of frozen) {
    check(Number.isSafeInteger(row.generation) && row.generation>=0 && batches.some(b=>b.id===row.batch_id) && originals.has(`${row.claim_id}:${row.revision}`));
    const selected=JSON.parse(row.selections);
    check(Array.isArray(selected)); checkChain(selected);
    for(const selection of selected) check(selection.claim_id===row.claim_id && selection.revision===row.revision && corrections.some(c=>JSON.stringify(c)===JSON.stringify(selection)));
  }
}
