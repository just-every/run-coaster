import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { tokenSubjects, validDiscardReason } from '../../src/coaster/receipts/reasons.mjs';

const check = (ok, code) => { if (!ok) throw new PortabilityError('coaster_capture_' + code, 409); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const mediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const states = new Set(['received', 'reading', 'read', 'needs-attention']);

/** Base verifies each object's actual bytes against its manifest hash before
 * calling this hook. Bind those verified objects to D1's immutable evidence;
 * matching only the object key would allow a re-sealed, inconsistent archive. */
export async function validateCaptureArchive(read, manifest) {
  const [receipts, events, erasing] = await Promise.all([read('c_capture_receipts'), read('c_capture_receipt_events'), read('c_capture_erasing')]);
  check(erasing.length === 0, 'erasure_guard');
  const window = await read('c_capture_window'), drafts = await read('c_capture_cash_drafts'), claims = await read('c_claims');
  check(window.length === 1 && window[0].id === 1 && (window[0].days === null || Number.isInteger(window[0].days) && window[0].days >= 1 && window[0].days <= 90)
    && Number.isSafeInteger(window[0].version) && window[0].version >= 0, 'cash_window');
  for (const draft of drafts) {
    const original = receipts.find(r => r.id === draft.receipt_id), claim = claims.find(c => c.id === draft.claim_id);
    check(original && typeof draft.claim_id === 'string' && draft.claim_id.length > 0 && draft.expense_date === original.uploaded_at.slice(0,10)
      && timestamp(draft.created_at) && draft.created_at >= original.uploaded_at && (!claim || claim.employee_email === original.owner_email), 'cash_draft');
  }
  check(new Set(drafts.map(d => d.receipt_id)).size === drafts.length && new Set(drafts.map(d => d.claim_id)).size === drafts.length, 'cash_draft');
  const objects = manifest?.objects.filter(object => object.bucket === 'COASTER_RECEIPTS') ?? [];
  check(objects.length === receipts.length, 'objects');
  const byKey = new Map(objects.map(object => [object.key, object]));
  const byId = new Map(receipts.map(receipt => [receipt.id, receipt]));
  const lifecycle = await read('c_capture_lifecycle'), members = await read('c_members'), ended = new Map();
  const items = await read('c_items'), aliases = await read('c_receipts');
  const merchantValid = value => {
    if(typeof value!=='string'||value!==value.trim()||!value.length||value.length>4400)return false;
    const subjects=tokenSubjects(members);
    const collapsed=value.replace(/(?:Former member |former-member-)([0-9a-f]{8})/g,(token,hex)=>subjects.has('former-member-'+hex)?'x':token);
    return collapsed.length<=200;
  };
  const cards=await read('c_cards');
  const rules=(await read('c_card_match_rules')).sort((a,b)=>a.version-b.version);
  const ordered = [...lifecycle].sort((a,b) => a.receipt_id.localeCompare(b.receipt_id) || a.sequence-b.sequence);
  const latest = new Map(), associations = new Map();
  for (const event of ordered) {
    const receipt = byId.get(event.receipt_id), previous = latest.get(event.receipt_id);
    check(receipt && !ended.has(event.receipt_id), 'history');
    check(event.sequence === (previous?.sequence ?? 0)+1 && timestamp(event.at)
      && event.at >= (previous?.at ?? receipt.uploaded_at), 'history');
    check((event.channel === 'app' || event.channel === 'schedule' && event.kind === 'attached' && event.actor_email === 'automation: card match') && typeof event.actor_email === 'string' && event.actor_email.length > 0
      && event.on_behalf_of === (event.actor_email === receipt.owner_email ? null : receipt.owner_email), 'lifecycle_provenance');
    check(!Object.hasOwn(event, 'reason_redacted'), 'reason');
    if (['match-details','match-withdrawn','match-rejected'].includes(event.kind)) {
      const attached = associations.get(receipt.id);
      check((!attached || !items.some(i=>i.id===attached.item_id)) && event.reason==='' && event.survivor_id===null && event.claim_id===null && event.item_id===null && event.channel==='app','match_choice');
      if(event.kind==='match-details') {
        let data; try {data=JSON.parse(event.match_data);} catch {check(false,'match_choice');}
        check(data && Object.keys(data).length===5&&['merchant','date','totalMinor','currency','last4'].every(k=>Object.hasOwn(data,k))&&merchantValid(data.merchant)
          && /^\d{4}-\d{2}-\d{2}$/.test(data.date) && Number.isFinite(Date.parse(data.date)) && new Date(data.date).toISOString().slice(0,10)===data.date
          && Number.isSafeInteger(data.totalMinor) && data.totalMinor>0 && data.totalMinor<=1e11 && /^[A-Z]{3}$/.test(data.currency)&&Intl.supportedValuesOf('currency').includes(data.currency)
          && (data.last4===null || /^\d{4}$/.test(data.last4)), 'match_choice');
        check(!drafts.some(d=>d.receipt_id===receipt.id&&d.created_at<=event.at),'match_choice');
      } else if(event.kind==='match-withdrawn') check(event.match_data===null,'match_choice');
      else {let data;try{data=JSON.parse(event.match_data);}catch{check(false,'match_choice');}check(Array.isArray(data?.chargeIds)&&data.chargeIds.length>0&&data.chargeIds.every(id=>typeof id==='string'),'match_choice');}
    } else if (event.kind === 'attached' || event.kind === 'detached') {
      check(event.reason === '' && event.survivor_id === null && typeof event.claim_id === 'string' && event.claim_id.length > 0
        && typeof event.item_id === 'string' && event.item_id.length > 0, 'attachment');
      if(event.channel==='schedule') {
        const charges=[...await read('c_card_charges'),...await read('c_card_charge_undo_history')];
        const charge=charges.find(c=>c.item_id===event.item_id);
        let data;try{data=JSON.parse(event.match_data);}catch{check(false,'match_basis');}
        check(rules.some(r=>r.version===data?.ruleVersion),'match_basis');
        check(data && Number.isSafeInteger(data.ruleVersion)&&['exact','tip','fx'].includes(data.basis)&&data.enteredTotalMinor>0,'match_basis');
        check(charge && charge.employee_email===receipt.owner_email,'match_basis');
        const matchingAliases=aliases.filter(a=>a.capture_receipt_id===receipt.id&&a.claim_id===event.claim_id&&a.card_match_basis===event.match_data);
        check(!items.some(i=>i.id===event.item_id)||matchingAliases.length>0,'match_basis');
        const choice=ordered.filter(e=>e.receipt_id===receipt.id&&e.sequence<event.sequence&&['match-details','match-withdrawn'].includes(e.kind)).at(-1);
        check(choice?.kind==='match-details','match_basis');
        const details=JSON.parse(choice.match_data),rule=rules.find(r=>r.version===data.ruleVersion);
        const keys=['ruleVersion','basis','enteredTotalMinor','enteredCurrency','enteredDate','differenceMinor','differenceCurrency'];
        if(data.basis==='fx') keys.push('fxRate','fxDate','fxSource');
        check(Object.keys(data).length===keys.length&&keys.every(k=>Object.hasOwn(data,k))
          && data.enteredTotalMinor===details.totalMinor&&data.enteredCurrency===details.currency&&data.enteredDate===details.date
          && Number.isSafeInteger(data.differenceMinor)&&/^[A-Z]{3}$/.test(data.differenceCurrency),'match_basis');
        const days=(Date.parse((charge.transaction_on??charge.posted_on)+'T00:00:00Z')-Date.parse(details.date+'T00:00:00Z'))/86400000;
        check(rule.enabled===1&&days>=-1&&days<=rule.window_days
          && (!details.last4||cards.some(c=>c.id===charge.card_id&&c.last4===details.last4)),'match_basis');
        const inOriginal=charge.original_currency===details.currency&&charge.original_minor!==null;
        const shared=details.currency===(inOriginal?charge.original_currency:charge.currency);
        const charged=inOriginal?charge.original_minor:charge.amount_minor;
        check(charge.amount_minor>0,'match_basis');
        if(data.basis==='exact'||data.basis==='tip') {
          check(shared&&data.differenceCurrency===details.currency&&data.differenceMinor===charged-details.totalMinor,'match_basis');
          check(data.basis==='exact'?charged===details.totalMinor:
            charged>details.totalMinor&&BigInt(charged)*100n<=BigInt(details.totalMinor)*BigInt(100+rule.tip_percent),'match_basis');
        } else {
          // Reference rates are frozen evidence; restore does not call ECB or use today's provider setting.
          const reference=charged-data.differenceMinor;
          check(!shared&&!inOriginal&&details.currency!==charge.currency&&data.differenceCurrency===charge.currency
            && reference>0&&BigInt(Math.abs(data.differenceMinor))*100n<=BigInt(reference)*BigInt(rule.fx_percent)
            && typeof data.fxRate==='string'&&/^\d+(?:\.\d{1,12})?$/.test(data.fxRate)&&Number(data.fxRate)>0
            && /^\d{4}-\d{2}-\d{2}$/.test(data.fxDate)&&Number.isFinite(Date.parse(data.fxDate))
            && new Date(data.fxDate).toISOString().slice(0,10)===data.fxDate&&data.fxDate<=details.date
            && data.fxSource==='ECB reference rates','match_basis');
        }
        check(!drafts.some(d=>d.receipt_id===receipt.id&&d.created_at<=event.at),'match_basis');
      }
      const claim = claims.find(c => c.id === event.claim_id);
      check(!claim || claim.employee_email === receipt.owner_email, 'attachment');
      if (event.kind === 'attached') {
        const previousAttachment = associations.get(receipt.id);
        check(!previousAttachment || !items.some(item=>item.id===previousAttachment.item_id), 'attachment');
        associations.set(receipt.id,event);
      } else {
        const attached = associations.get(receipt.id);
        // A native partial approval may move an expense to a correction claim, keeping its id.
        check(attached && attached.item_id === event.item_id, 'attachment');
        associations.delete(receipt.id);
      }
    } else {
      const previousAttachment = associations.get(receipt.id);
      check((!previousAttachment || !items.some(item=>item.id===previousAttachment.item_id)) && event.claim_id === null && event.item_id === null, 'attachment');
      const survivor = event.kind === 'merged' ? byId.get(event.survivor_id) : undefined;
      if (event.kind === 'merged') check(survivor && survivor.id !== receipt.id && survivor.owner_email === receipt.owner_email
        && event.at >= survivor.uploaded_at && (event.reason === '' ? survivor.sha256 === receipt.sha256 : validDiscardReason(event.reason, members)), 'merge');
      else check(event.kind === 'discarded' && event.survivor_id === null && validDiscardReason(event.reason, members), 'reason');
      associations.delete(receipt.id);
      ended.set(event.receipt_id,event);
    }
    latest.set(receipt.id,event);
  }
  for (const event of lifecycle) if (event.kind === 'merged') {
    const later = ended.get(event.survivor_id);
    check(!later || (later.at >= event.at && later.survivor_id !== event.receipt_id), 'merge');
  }
  for (const item of items) {
    const alias = aliases.find(a=>a.id===item.receipt_id);
    if (!alias?.capture_receipt_id) continue;
    const attached = associations.get(alias.capture_receipt_id);
    check(attached && attached.item_id === item.id, 'attachment');
  }
  for (const [id, attached] of associations) {
    const item = items.find(i=>i.id===attached.item_id);
    // A retained history line survives financial-record retention; a live expense must still carry its original.
    if (item) check(aliases.some(a=>a.id===item.receipt_id && a.capture_receipt_id===id), 'attachment');
    // Historical expense ids remain in private history after financial retention, including an expense moved by partial approval.
  }
  // A receipt alias and every submitted revision carry the same frozen basis as the private automation line.
  // Neither an alias nor a snapshot may invent a match or extend its shared fields.
  for(const alias of aliases.filter(a=>a.card_match_basis!==null))
    check(lifecycle.some(e=>e.receipt_id===alias.capture_receipt_id&&e.claim_id===alias.claim_id&&e.channel==='schedule'&&e.match_data===alias.card_match_basis),'match_basis');
  for(const revision of await read('c_revisions')) for(const item of JSON.parse(revision.snapshot).items) {
    const alias=aliases.find(a=>a.id===(item.receipt?.id??item.receipt_id));
    check((item.card_match_basis??null)===(alias?.card_match_basis??null),'match_basis');
  }
  const rejections=await read('c_card_match_rejections');
  const chargeRecords=[...await read('c_card_charges'),...await read('c_card_charge_undo_history')];
  for(const pair of rejections) {
    check(typeof pair.transaction_key==='string'&&pair.transaction_key.startsWith('card:')&&lifecycle.some(e=>e.receipt_id===pair.receipt_id&&e.sequence===pair.sequence&&['match-rejected','detached'].includes(e.kind)),'match_rejection');
    const charge=chargeRecords.find(c=>c.id===pair.charge_id);
    check(!charge||charge.transaction_key===pair.transaction_key&&charge.employee_email===byId.get(pair.receipt_id)?.owner_email,'match_rejection');
  }
  check(new Set(rejections.map(p=>p.receipt_id+'|'+p.transaction_key)).size===rejections.length,'match_rejection');
  check(rules.length>0&&rules.every((r,i)=>r.version===i+1&&[0,1].includes(r.enabled)&&Number.isInteger(r.window_days)&&r.window_days>=0&&r.window_days<=14&&Number.isInteger(r.tip_percent)&&r.tip_percent>=0&&r.tip_percent<=30&&Number.isInteger(r.fx_percent)&&r.fx_percent>=0&&r.fx_percent<=10),'match_rule');
  check(byKey.size === objects.length && byId.size === receipts.length, 'objects');
  const history = new Map();
  for (const event of events) {
    check(byId.has(event.receipt_id), 'event_receipt');
    check(Number.isSafeInteger(event.sequence) && event.sequence > 0 && states.has(event.state)
      && typeof event.reason === 'string' && timestamp(event.at), 'history');
    check(event.channel === 'app' && typeof event.actor_email === 'string' && event.actor_email.length > 0
      && (event.on_behalf_of === null || (typeof event.on_behalf_of === 'string' && event.on_behalf_of.length > 0)), 'provenance');
    check(event.state !== 'needs-attention' || event.reason.trim().length > 0, 'history');
    if (!history.has(event.receipt_id)) history.set(event.receipt_id, []);
    history.get(event.receipt_id).push(event);
  }
  for (const receipt of receipts) {
    check(typeof receipt.id === 'string' && receipt.id.length > 0
      && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256), 'provenance');
    check(typeof receipt.owner_email === 'string' && receipt.owner_email.length > 0
      && typeof receipt.uploaded_by === 'string' && receipt.uploaded_by.length > 0 && timestamp(receipt.uploaded_at)
      && ['upload', 'camera'].includes(receipt.source), 'provenance');
    check(typeof receipt.name === 'string' && receipt.name.trim().length > 0 && receipt.name.length <= 200
      && !/[\u0000-\u001f\u007f]/.test(receipt.name) && mediaTypes.has(receipt.media_type)
      && Number.isSafeInteger(receipt.size) && receipt.size > 0 && receipt.size <= 10_000_000, 'provenance');
    check(receipt.object_key === `receipt-inbox/${receipt.id}/${receipt.sha256}`, 'object_key');
    const object = byKey.get(receipt.object_key);
    check(object && object.size === receipt.size && object.sha256 === receipt.sha256, 'bytes');
    check(object.httpMetadata?.contentType === receipt.media_type
      && Object.keys(object.httpMetadata).length === 1 && Object.keys(object.customMetadata ?? {}).length === 0, 'metadata');
    const own = (history.get(receipt.id) ?? []).sort((a, b) => a.sequence - b.sequence);
    check(own.length > 0 && own[0].state === 'received' && own[0].reason === ''
      && own[0].at === receipt.uploaded_at, 'history');
    check(own[0].actor_email === receipt.uploaded_by
      && own[0].on_behalf_of === (receipt.uploaded_by === receipt.owner_email ? null : receipt.owner_email), 'provenance');
    check(own.every((event, index) => event.sequence === index + 1
      && (index === 0 || event.at >= own[index - 1].at)), 'history');
  }
}
