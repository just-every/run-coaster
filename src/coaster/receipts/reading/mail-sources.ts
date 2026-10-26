import { type Sql } from '../../session';
import type { Data } from '../../types';
import { FIELD_NAMES, type Fields, type Source } from './model';

/** Only opposite parts of this exact message, still owned by the same active person. */
const peers=`FROM c_receipt_mail_sources own
 JOIN c_capture_receipts original ON original.id=own.receipt_id
 JOIN c_receipt_mail_messages message ON message.id=own.message_id AND message.owner_email=original.owner_email
 JOIN c_members member ON member.email=original.owner_email AND member.active=1
 JOIN c_receipt_mail_sources part ON part.message_id=own.message_id AND part.origin<>own.origin
 JOIN c_capture_receipts r ON r.id=part.receipt_id AND r.owner_email=original.owner_email
 WHERE own.receipt_id=? AND own.origin IN ('body','attachment')
 AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id IN (original.id,r.id) AND l.kind IN ('discarded','merged'))`;
export async function mailReadings(db:D1Database,id:string) {
 return (await db.prepare(`SELECT r.id,r.sha256,r.media_type,part.origin,
 (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=r.id) AS lifecycle_sequence,
 (SELECT COALESCE(MAX(sequence),0) FROM c_capture_receipt_events WHERE receipt_id=r.id) AS state_sequence,
 (SELECT COALESCE(MAX(sequence),0) FROM c_receipt_readings WHERE receipt_id=r.id) AS reading_sequence,
 (SELECT fields_json FROM c_receipt_readings WHERE receipt_id=r.id ORDER BY sequence DESC LIMIT 1) AS fields_json,
 (SELECT kind FROM c_receipt_readings WHERE receipt_id=r.id ORDER BY sequence DESC LIMIT 1) AS reading_kind,
 (SELECT original_sha256 FROM c_receipt_readings WHERE receipt_id=r.id ORDER BY sequence DESC LIMIT 1) AS reading_sha256
 ${peers} ORDER BY r.id`).bind(id).all<Data>()).results;
}
export function mailSources(rows:Data[]):Source[] {
 return rows.map(r=>{
  const ready=['read','corrected'].includes(r.reading_kind)&&r.reading_sha256===r.sha256;
  const fields=ready?JSON.parse(r.fields_json) as Fields:null;
  return {kind:r.origin==='body'?'merchant-email':'email-attachment',receiptId:r.id,readingSequence:r.reading_sequence,mediaType:r.media_type,
   pending:!ready,values:fields?Object.fromEntries(FIELD_NAMES.flatMap(name=>typeof fields[name].value==='string'?[[name,fields[name].value]]:[])):{},
   regions:fields?Object.fromEntries(FIELD_NAMES.map(name=>[name,fields[name].regions])):{}};
 });
}
export function mailComparison(rows:Data[],previous:Data|undefined,names:string[]) {
 const references=rows.map(r=>({receiptId:r.id,readingSequence:r.reading_sequence}));
 return {...(previous&&!Array.isArray(previous)?previous:{}),...Object.fromEntries(names.map(name=>[name,references]))};
}
/** Bind the entire comparison set, including unread parts, to the eventual mutation. */
export function mailReadingsStill(id:string,rows:Data[]):Sql {
 const snapshot=rows.map(({id,sha256,origin,reading_sequence,lifecycle_sequence,state_sequence})=>({id,sha256,origin,reading_sequence,lifecycle_sequence,state_sequence}));
 return {sql:`(SELECT COUNT(*) ${peers})=? AND NOT EXISTS(SELECT 1 ${peers} AND NOT EXISTS(
  SELECT 1 FROM json_each(?) expected WHERE json_extract(expected.value,'$.id')=r.id
   AND json_extract(expected.value,'$.sha256')=r.sha256 AND json_extract(expected.value,'$.origin')=part.origin
   AND json_extract(expected.value,'$.reading_sequence')=(SELECT COALESCE(MAX(sequence),0) FROM c_receipt_readings WHERE receipt_id=r.id)
   AND json_extract(expected.value,'$.lifecycle_sequence')=(SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=r.id)
   AND json_extract(expected.value,'$.state_sequence')=(SELECT COALESCE(MAX(sequence),0) FROM c_capture_receipt_events WHERE receipt_id=r.id)
 ))`,params:[id,rows.length,id,JSON.stringify(snapshot)]};
}
