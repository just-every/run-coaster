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
  valid(source.origin===null||['body','attachment'].includes(source.origin));
 }
 const comments=await read('c_comments'),members=await read('c_members');
 const tokens=await read('c_comment_email_tokens'),answers=await read('c_comment_email_answers');
 for(const token of tokens){
  const question=comments.find(c=>c.id===token.question_id),member=members.find(m=>m.member_id===token.member_id);
  valid(question&&member&&question.asks_email===member.email&&!question.parent_id&&/^[a-f0-9]{64}$/.test(token.token_hash)&&typeof token.destination==='string'&&token.destination.includes('@'));
 }
 valid(new Set(tokens.map(t=>t.token_hash)).size===tokens.length&&new Set(answers.map(a=>a.message_sha256)).size===answers.length);
 for(const answer of answers){
  const comment=comments.find(c=>c.id===answer.comment_id);
  valid(/^[a-f0-9]{64}$/.test(answer.message_sha256)&&comment&&!comment.asks_email&&(!comment.parent_id||tokens.some(t=>t.question_id===comment.parent_id&&members.some(m=>m.member_id===t.member_id&&m.email===comment.author_email))));
 }
}
