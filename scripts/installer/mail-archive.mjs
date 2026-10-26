import { PortabilityError } from '@runeditrun/rer/modules/portability';
export async function validateMailArchive(read,objects,receipts,messages) {
 const valid=ok=>{if(!ok)throw new PortabilityError('coaster_mail_evidence',409);};
 const byKey=new Map(objects.map(o=>[o.key,o]));
 const references=await read('c_capture_objects'),expected=[...receipts,...messages].map(r=>r.object_key);
 valid(references.length===expected.length&&new Set(references.map(r=>r.object_key)).size===expected.length&&references.every(r=>expected.includes(r.object_key)));
 valid(new Set(messages.map(m=>m.id)).size===messages.length&&new Set(messages.map(m=>m.sha256)).size===messages.length);
 for(const m of messages){
  const object=byKey.get(m.object_key);
  valid(object&&object.sha256===m.sha256&&object.size===m.size&&m.object_key===`receipt-mail/${m.id}/${m.sha256}`&&m.size>0&&m.size<=25_000_000);
  valid(typeof m.sender==='string'&&typeof m.recipient==='string'&&typeof m.subject==='string'&&typeof m.received_at==='string'&&new Date(m.received_at).toISOString()===m.received_at);
  valid(m.owner_email===null?typeof m.held_reason==='string'&&m.held_reason.length>0:m.held_reason==='');
 }
 for(const source of await read('c_receipt_mail_sources')){
  const original=receipts.find(r=>r.id===source.receipt_id),message=messages.find(m=>m.id===source.message_id);
  valid(original&&message&&message.owner_email!==null&&original.owner_email===message.owner_email);
 }
}
