import { all, authority, holds, type Sql } from '../../session';
import { now, requireThat, type Actor, type Data } from '../../types';
import { type ReadingRow, type Source } from './model';
import { decimal } from '../../types';
import { mailReadings, mailReadingsStill, mailSources } from './mail-sources';
const employeeSql=(alias:string)=>`(${holds('employee',alias)} OR EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=${alias}.email AND o.role='owner' AND o.status='active'))`;
export function nativeEmployee(a:Actor) {requireThat(a.kind==='person'&&!a.publicCredential&&a.roles.employee,'Use a native employee session or live employee delegate',403);}
export async function ownOriginal(db:D1Database,a:Actor,id:string) {
  nativeEmployee(a);
  const r=await db.prepare(`SELECT r.*,COALESCE((SELECT MAX(sequence) FROM c_capture_lifecycle WHERE receipt_id=r.id),0) AS lifecycle_sequence,COALESCE((SELECT MAX(sequence) FROM c_capture_receipt_events WHERE receipt_id=r.id),0) AS state_sequence FROM c_capture_receipts r WHERE r.id=? AND r.owner_email=?`).bind(id,a.email).first<Data>();
  requireThat(r,'Receipt not found',404);
  requireThat(await db.prepare(`SELECT 1 FROM c_members WHERE email=? AND active=1 AND ${employeeSql('c_members')}`).bind(a.email).first(),'Active employee membership required',403);
  r.mailReadings=await mailReadings(db,id);
  return r;
}
export const latestReading=(db:D1Database,id:string)=>db.prepare('SELECT * FROM c_receipt_readings WHERE receipt_id=? ORDER BY sequence DESC LIMIT 1').bind(id).first<ReadingRow>();
export function originalStill(a:Actor,r:Data,sequence:number,readerSequence:number):Sql {
  return all(authority(a,'employee'),mailReadingsStill(r.id,r.mailReadings??[]),{sql:`EXISTS(SELECT 1 FROM c_capture_receipts r JOIN c_members m ON m.email=r.owner_email WHERE r.id=? AND r.owner_email=? AND r.sha256=? AND m.active=1 AND ${employeeSql('m')}) AND (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=?)=? AND (SELECT COALESCE(MAX(sequence),0) FROM c_receipt_readings WHERE receipt_id=?)=? AND (SELECT COALESCE(MAX(sequence),0) FROM c_capture_receipt_events WHERE receipt_id=?)=? AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND kind IN ('discarded','merged'))`,params:[r.id,a.email,r.sha256,r.id,sequence,r.id,readerSequence,r.id,r.state_sequence,r.id]});
}
export function expected(b:Data,r:Data,reading:ReadingRow|null) {requireThat(Number.isSafeInteger(b.expectedSequence)&&b.expectedSequence===r.lifecycle_sequence&&Number.isSafeInteger(b.expectedReadingSequence)&&b.expectedReadingSequence===(reading?.sequence??0),'The receipt changed; reload its current sequences',409);}
export function captureState(db:D1Database,a:Actor,id:string,state:'reading'|'read'|'needs-attention',reason:string) {
  return db.prepare("INSERT INTO c_capture_receipt_events(receipt_id,sequence,state,reason,at,actor_email,on_behalf_of,channel) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM c_capture_receipt_events WHERE receipt_id=?),?,?,?,?,?,'app')").bind(id,id,state,reason,now(),a.delegate?.email??a.email,a.delegate?a.email:null);
}
export async function crossSources(db:D1Database,id:string):Promise<Source[]> {
  const sources:Source[]=mailSources(await mailReadings(db,id));
  const choice=await db.prepare("SELECT kind,match_data FROM c_capture_lifecycle WHERE receipt_id=? AND kind IN ('match-details','match-withdrawn') ORDER BY sequence DESC LIMIT 1").bind(id).first<{kind:string;match_data:string}>();
  if(choice?.kind==='match-details'){const v=JSON.parse(choice.match_data);sources.push({kind:'confirmed-details',values:{merchant:v.merchant,date:v.date,total:decimal(v.totalMinor),currency:v.currency,...(v.last4?{last4:v.last4}:{})}});}
  const rows=(await db.prepare('SELECT ch.descriptor,ch.transaction_on,ch.posted_on,ch.amount_minor,ch.currency,c.last4 FROM c_receipts a JOIN c_items i ON i.receipt_id=a.id JOIN c_card_charges ch ON ch.id=i.card_charge_id JOIN c_cards c ON c.id=ch.card_id WHERE a.capture_receipt_id=?').bind(id).all<Data>()).results;
  for(const row of rows)sources.push({kind:'card-charge',values:{merchant:row.descriptor,date:row.transaction_on??row.posted_on,total:decimal(row.amount_minor),currency:row.currency,last4:row.last4}});
  return sources;
}
