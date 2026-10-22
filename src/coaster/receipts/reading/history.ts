import { now, type Actor, type Data } from '../../types';
import { type Fields, type ReadingRow } from './model';
import { safePrefill } from './normalize';
import { ownOriginal } from './access';
import { READING_CONSENT } from './settings';
export function readingLine(db:D1Database,a:Actor,receipt:Data,sequence:number,kind:ReadingRow['kind'],attempt:string,settings:number,model:string,fields:Fields|{},usage:Data={},error='') {
  return db.prepare('INSERT INTO c_receipt_readings(receipt_id,sequence,kind,attempt_id,settings_version,original_sha256,model,fields_json,error_code,usage_json,actor_email,on_behalf_of,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(receipt.id,sequence,kind,attempt,settings,receipt.sha256,model,JSON.stringify(fields),error,JSON.stringify(usage),a.delegate?.email??a.email,a.delegate?a.email:null,now());
}
export async function readingDetail(db:D1Database,a:Actor,id:string) {
  const r=await ownOriginal(db,a,id),rows=(await db.prepare('SELECT * FROM c_receipt_readings WHERE receipt_id=? ORDER BY sequence').bind(id).all<ReadingRow>()).results,latest=rows.at(-1);
  const fields=latest&&['read','corrected'].includes(latest.kind)?JSON.parse(latest.fields_json) as Fields:null;
  const expired=latest?.kind==='started'&&Date.now()-Date.parse(latest.at)>=120000;
  const state=!latest?'needs-attention':latest.kind==='started'?(expired?'needs-attention':'reading'):latest.kind==='failed'||fields&&Object.values(fields).some(f=>f.review)?'needs-attention':'read';
  const choice=await db.prepare('SELECT version,enabled FROM c_receipt_reading_match_defaults WHERE employee_email=? ORDER BY version DESC LIMIT 1').bind(a.email).first<{version:number;enabled:number}>();
  return {receiptId:id,sequence:latest?.sequence??0,lifecycleSequence:r.lifecycle_sequence,state,retryable:!latest||latest.kind!=='started'||expired,fields,prefill:fields?safePrefill(fields):{},consentNotice:READING_CONSENT,settingsVersion:latest?.settings_version??0,
    attentionReason:expired?'The reading did not finish. No automatic retry was made; retry explicitly.':latest?.error_code||(!latest?'This original has not been read.':''),
    matchDefault:{version:choice?.version??0,enabled:!!choice?.enabled},
    history:rows.map(row=>({sequence:row.sequence,kind:row.kind,attemptId:row.attempt_id,model:row.model,settingsVersion:row.settings_version,fields:JSON.parse(row.fields_json),errorCode:row.error_code,usage:JSON.parse(row.usage_json),actorEmail:row.actor_email,onBehalfOf:row.on_behalf_of,at:row.at})),
  };
}
