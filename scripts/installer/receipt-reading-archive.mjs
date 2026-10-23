import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Readings remain bound to their exact private original and consented settings version after restore. */
export async function validateReceiptReadingArchive(read) {
  const [settings, readings, defaults, originals] = await Promise.all(['c_receipt_reading_settings', 'c_receipt_readings', 'c_receipt_reading_match_defaults', 'c_capture_receipts'].map(read));
  const check = value => { if (!value) throw new PortabilityError('coaster_receipt_reading', 409); };
  if (!settings.length) { check(!readings.length && !defaults.length && !(await read('c_provider_cost_settings')).length && !(await read('c_provider_costs')).length); return; }
  const versions = new Map(settings.map(row => [row.version, row])), receipts = new Map(originals.map(row => [row.id, row]));
  for (const row of settings) check(Number.isSafeInteger(row.version) && row.version >= 0 && [0, 1].includes(row.enabled) && row.threshold >= 0.9 && row.threshold <= 1 && typeof row.model === 'string');
  check(new Set(settings.map(row => row.version)).size === settings.length && settings.every((_, i) => versions.has(i)));
  const prices=await read('c_provider_cost_settings'),costs=await read('c_provider_costs');
  const pricing=new Map(prices.map(p=>[p.version,p]));
  check(pricing.size===prices.length&&prices.every((p,i)=>pricing.has(i+1)&&Number.isSafeInteger(p.input_usd_micros_per_million)&&p.input_usd_micros_per_million>=0&&Number.isSafeInteger(p.output_usd_micros_per_million)&&p.output_usd_micros_per_million>=0&&Number.isSafeInteger(p.reserve_usd_micros)&&p.reserve_usd_micros>0&&(p.cap_usd_micros===null||Number.isSafeInteger(p.cap_usd_micros)&&p.cap_usd_micros>=0)));
  for(const c of costs){
    const p=pricing.get(c.settings_version),reservation=costs.find(r=>r.attempt_id===c.attempt_id&&r.kind==='reserved');
    check(p&&reservation&&['reserved','settled'].includes(c.kind)&&['receipt-reading','receipt-coding'].includes(c.feature)&&c.model===p.model&&/^\d{4}-\d{2}$/.test(c.month)&&Number.isSafeInteger(c.pages)&&c.pages>0&&Number.isSafeInteger(c.usd_micros)&&c.usd_micros>=0&&[0,1].includes(c.uncertain));
    check(c.month===reservation.month&&c.feature===reservation.feature&&c.pages===reservation.pages&&c.model===reservation.model&&c.settings_version===reservation.settings_version);
    if(c.kind==='reserved')check(c.usd_micros===p.reserve_usd_micros*c.pages&&c.uncertain===1&&c.input_tokens===null&&c.output_tokens===null);
    else if(c.uncertain)check(c.usd_micros===reservation.usd_micros&&c.input_tokens===null&&c.output_tokens===null);
    else check(Number.isSafeInteger(c.input_tokens)&&c.input_tokens>=0&&Number.isSafeInteger(c.output_tokens)&&c.output_tokens>=0&&c.usd_micros===Number((BigInt(c.input_tokens)*BigInt(p.input_usd_micros_per_million)+BigInt(c.output_tokens)*BigInt(p.output_usd_micros_per_million)+999999n)/1000000n));
  }
  const sequence = new Map();
  const names = ['merchant', 'date', 'total', 'subtotal', 'salesTax', 'tip', 'currency', 'last4', 'lineItems'];
  for (const row of [...readings].sort((a, b) => a.receipt_id.localeCompare(b.receipt_id) || a.sequence - b.sequence)) {
    const original = receipts.get(row.receipt_id), prior = sequence.get(row.receipt_id) ?? 0;
    check(original && row.original_sha256 === original.sha256 && Number.isSafeInteger(row.sequence) && row.sequence === prior + 1 && versions.has(row.settings_version));
    check((row.on_behalf_of === null ? row.actor_email === original.owner_email : row.on_behalf_of === original.owner_email && typeof row.actor_email === 'string' && row.actor_email.length > 0) && ['started', 'read', 'failed', 'corrected'].includes(row.kind));
    let fields, usage;
    try { fields = JSON.parse(row.fields_json); usage = JSON.parse(row.usage_json); } catch { check(false); }
    check(fields && typeof fields === 'object' && !Array.isArray(fields) && usage && typeof usage === 'object' && !Array.isArray(usage));
    if (['read', 'corrected'].includes(row.kind)) {
      check(Object.keys(fields).length === names.length && names.every(name => Object.hasOwn(fields, name)));
      for (const field of Object.values(fields)) check(field && typeof field === 'object' && typeof field.review === 'boolean' && ['reader', 'person'].includes(field.source) && Number.isFinite(field.confidence) && field.confidence >= 0 && field.confidence <= 1 && Array.isArray(field.regions) && Array.isArray(field.reasons));
    } else check(!Object.keys(fields).length);
    sequence.set(row.receipt_id, row.sequence);
  }
  const items=await read('c_items'),aliases=await read('c_receipts');
  for(const item of items.filter(i=>i.receipt_resolution)){
    let answer;try{answer=JSON.parse(item.receipt_resolution);}catch{check(false);}
    const alias=aliases.find(a=>a.id===item.receipt_id),reading=alias&&readings.find(r=>r.receipt_id===alias.capture_receipt_id&&r.sequence===answer.confirmationSequence&&r.kind==='corrected');
    check(item.card_charge_id&&reading);const f=JSON.parse(reading.fields_json);
    check(answer.receiptTotal===f.total.value&&answer.receiptCurrency===f.currency.value&&/^\d{1,8}\.\d{2}$/.test(answer.receiptTotal)&&/^[A-Z]{3}$/.test(answer.receiptCurrency));
  }
  for (const row of defaults) check(typeof row.employee_email === 'string' && Number.isSafeInteger(row.version) && row.version > 0 && [0, 1].includes(row.enabled));
}
