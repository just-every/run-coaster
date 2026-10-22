import { all, authority, commit, type Sql } from '../../session';
import { now, requireThat, uid, type Actor, type Data } from '../../types';
import { originalBytes, receiptBucket } from '../storage';
import { expected, latestReading, originalStill, ownOriginal, crossSources, captureState } from './access';
import { currentSettings, settingsStill, READING_CONSENT } from './settings';
import { readingDetail, readingLine } from './history';
import { normalizeReading, correctedFields, safePrefill } from './normalize';
import { invokeReader, readerFailure, type ReaderBindings } from './provider';
import { receiptInput } from './media';
import { FIELD_NAMES, type Fields, type LineItem } from './model';
export { readingSettings, saveReadingSettings, setReadingMatchDefault, DEFAULT_READER_MODEL, READING_CONSENT } from './settings';
export { readingDetail } from './history';
export type { ReaderBindings } from './provider';
export type { Fields, ReadField, LineItem } from './model';

/** Explicit consent starts exactly one paid attempt. An expired in-flight attempt requires a fresh human retry. */
export async function readReceipt(env:ReaderBindings,a:Actor,id:string,b:Data) {
  requireThat(Object.keys(b).every(k=>['expectedSequence','expectedReadingSequence','consent'].includes(k))&&b.consent===true,'Explicit consent to send this original for AI reading is required');
  const db=env.DB,r=await ownOriginal(db,a,id),latest=await latestReading(db,id);expected(b,r,latest);
  requireThat(!latest||latest.kind!=='started'||Date.now()-Date.parse(latest.at)>=120000,'This original is already being read',409);
  const settings=(await currentSettings(db))!;requireThat(settings.enabled,'Receipt reading is disabled; ask an owner or admin to review and enable it',409);
  const attempt=uid(),sequence=latest?.sequence??0,base=originalStill(a,r,b.expectedSequence,sequence),live=all(authority(a,'employee'),base,settingsStill(settings.version));
  await commit(db,live,[readingLine(db,a,r,sequence+1,'started',attempt,settings.version,settings.model,{},{consent:true,notice:READING_CONSENT}),captureState(db,a,id,'reading','This person consented to one AI reading attempt')]);
  let fields:Fields|{}={},usage:Data={},model=settings.model,pages=1,failure:{code:string;message:string}|null=null;
  try {
    const input=await receiptInput(await originalBytes(receiptBucket(env.COASTER_RECEIPTS),r as {object_key:string;sha256:string;size:number}),r.media_type);pages=input.pages;
    const permitted=all(originalStill(a,{...r,state_sequence:r.state_sequence+1},b.expectedSequence,sequence+1),settingsStill(settings.version));
    requireThat(await db.prepare(`SELECT 1 AS ok WHERE ${permitted.sql}`).bind(...permitted.params).first(),'Receipt access or processing consent changed; reload',409);
    const result=await invokeReader(env,settings.model,input.content);model=result.model;usage={...result.usage,pages};
    fields=normalizeReading(result.raw,settings.threshold,pages,await crossSources(db,id));
  } catch(error) {failure=readerFailure(error);}
  const state=failure?'needs-attention':Object.values(fields).some(f=>f.review)?'needs-attention':'read';
  await commit(db,all(authority(a,'employee'),originalStill(a,{...r,state_sequence:r.state_sequence+1},b.expectedSequence,sequence+1),settingsStill(settings.version)),[
    readingLine(db,a,r,sequence+2,failure?'failed':'read',attempt,settings.version,model,fields,{...usage,pages},failure?.code??''),
    captureState(db,a,id,state,failure?.message??(state==='read'?'Receipt fields read; review before submitting':'Review the flagged receipt fields before using them')),
  ]);
  return readingDetail(db,a,id);
}
export async function correctReading(db:D1Database,a:Actor,id:string,b:Data) {
  requireThat(Object.keys(b).every(k=>['expectedSequence','expectedReadingSequence','values'].includes(k)),'Only current sequences and receipt field corrections are accepted');
  const r=await ownOriginal(db,a,id),latest=await latestReading(db,id);expected(b,r,latest);
  requireThat(latest&&latest.kind!=='started','Read this original first, or wait for the running reading',409);
  const prior=Object.keys(JSON.parse(latest.fields_json)).length?JSON.parse(latest.fields_json) as Fields:Object.fromEntries(FIELD_NAMES.map(name=>[name,{value:null,confidence:0,regions:[],review:true,reasons:['Not read'],source:'reader'}])) as unknown as Fields;
  const pages=JSON.parse(latest.usage_json).pages??1,fields=correctedFields(prior,b.values,pages,await crossSources(db,id));
  const state=Object.values(fields).some(f=>f.review)?'needs-attention':'read';
  await commit(db,originalStill(a,r,b.expectedSequence,latest.sequence),[
    readingLine(db,a,r,latest.sequence+1,'corrected',latest.attempt_id,latest.settings_version,latest.model,fields,{pages}),
    captureState(db,a,id,state,state==='read'?'Receipt fields confirmed by the person':'Receipt correction kept; review the remaining flagged fields'),
  ]);
  return readingDetail(db,a,id);
}
/** Trusted handoff: CODE-002 callers must include this guard in their own exact commit. Never accepts client OCR facts. */
export async function readingCodingInput(db:D1Database,a:Actor,id:string):Promise<{guard:Sql;receiptId:string;employee:string;merchant:string;lineItems:LineItem[];prefill:Data}> {
  const r=await ownOriginal(db,a,id),latest=await latestReading(db,id);requireThat(latest&&['read','corrected'].includes(latest.kind),'A completed receipt reading is required',409);
  const fields=JSON.parse(latest.fields_json) as Fields,prefill=safePrefill(fields);
  requireThat(typeof prefill.merchant==='string','Confirm the merchant before preparing receipt-based coding',409);
  return {guard:originalStill(a,r,r.lifecycle_sequence,latest.sequence),receiptId:id,employee:a.email,merchant:prefill.merchant,lineItems:prefill.lineItems??[],prefill};
}
