import { all, authority, commit, need, type Sql } from './session';
import { event } from './events';
import { now, optionalText, requireThat, uid, type Actor, type Data } from './types';
const current=(db:D1Database)=>db.prepare('SELECT * FROM c_provider_cost_settings ORDER BY version DESC LIMIT 1').first<Data>();
const month=()=>new Date().toISOString().slice(0,7);
const spent="SELECT COALESCE(SUM(c.usd_micros),0) FROM c_provider_costs c WHERE c.month=? AND (c.kind='settled' OR NOT EXISTS(SELECT 1 FROM c_provider_costs s WHERE s.attempt_id=c.attempt_id AND s.kind='settled'))";
const usd=(v:unknown,label:string)=>{const s=String(v??'');requireThat(/^\d{1,7}(\.\d{1,6})?$/.test(s),`${label} must be USD with at most six decimal places`);return Math.round(Number(s)*1e6);};
export async function providerCosts(db:D1Database,a:Actor){
 requireThat(a.kind==='person'&&!a.publicCredential&&!a.delegate,'Use the owner’s native session',403);need(a,'owner');
 const enabled=await db.prepare('SELECT enabled FROM c_receipt_reading_settings ORDER BY version DESC LIMIT 1').first<{enabled:number}>();
 const settings=await current(db),rows=(await db.prepare("SELECT * FROM c_provider_costs ORDER BY at,attempt_id,kind").all<Data>()).results;
 const attempts:Data[]=rows.filter(r=>r.kind==='reserved').map(r=>({...r,...rows.find(s=>s.attempt_id===r.attempt_id&&s.kind==='settled'),reservedUsdMicros:r.usd_micros}));
 const m=month(),used=attempts.filter(r=>r.month===m).reduce((n,r)=>n+r.usd_micros,0);
 return {readingEnabled:!!enabled?.enabled,currency:'USD',month:m,settings:settings?{version:settings.version,model:settings.model,inputPerMillion:settings.input_usd_micros_per_million/1e6,outputPerMillion:settings.output_usd_micros_per_million/1e6,reservePerPage:settings.reserve_usd_micros/1e6,monthlyCap:settings.cap_usd_micros===null?null:settings.cap_usd_micros/1e6}:null,usedUsdMicros:used,paused:settings?.cap_usd_micros!==null&&settings?.cap_usd_micros!==undefined&&used+settings.reserve_usd_micros>settings.cap_usd_micros,attempts,
  basis:'USD estimates from provider-reported input/output tokens at the owner-entered model rates, not provider invoices. A reservation is retained for uncertain or unmetered attempts. Caps check settled usage plus outstanding reservations before each optional request; a final provider charge can exceed its reservation and pauses subsequent requests. No receipt, filename, employee or reading text enters this ledger.'};
}
export async function saveProviderCosts(db:D1Database,a:Actor,b:Data){
 requireThat(a.kind==='person'&&!a.publicCredential&&!a.delegate,'Only the native owner sets provider pricing and caps',403);need(a,'owner');
 requireThat(Object.keys(b).every(k=>['version','model','inputPerMillion','outputPerMillion','reservePerPage','monthlyCap'].includes(k)),'Only model pricing and its cap are accepted');
 const previous=await current(db),v=previous?.version??0;requireThat(b.version===v,'Reload current provider costs',409);
 const model=optionalText(b.model,'Exact AI model',120);requireThat(/^[A-Za-z0-9@][A-Za-z0-9._@/-]*$/.test(model),'Choose an exact AI model');
 const input=usd(b.inputPerMillion,'Input token rate'),output=usd(b.outputPerMillion,'Output token rate'),reserve=usd(b.reservePerPage,'Per-page reservation'),cap=b.monthlyCap===null||b.monthlyCap===''?null:usd(b.monthlyCap,'Monthly cap');requireThat(reserve>0,'Reserve a positive USD amount per page');
 await commit(db,all(authority(a,'owner'),{sql:'(SELECT COALESCE(MAX(version),0) FROM c_provider_cost_settings)=?',params:[v]}),[
  db.prepare('INSERT INTO c_provider_cost_settings VALUES(?,?,?,?,?,?,?)').bind(v+1,model,input,output,reserve,cap,now()),event(db,a,'provider-cost-settings-saved',{}, {version:v+1,model,inputPerMillion:input/1e6,outputPerMillion:output/1e6,reservePerPage:reserve/1e6,monthlyCap:cap===null?null:cap/1e6}),
 ]);return providerCosts(db,a);
}
/** Internal paid boundary. Reservations are serializable with usage and current consent.
 * No settings means usage metering has not been configured; no price is invented. */
export async function reserveProviderCost(db:D1Database,guard:Sql,feature:'receipt-reading'|'receipt-coding',model:string,pages:number,attempt=uid()){
 const s=await current(db);if(!s)return null;
 requireThat(s.model===model,'Configure costs for the exact AI model before reading',409);
 const reserved=s.reserve_usd_micros*pages,m=month();
 const budget={sql:`(SELECT MAX(version) FROM c_provider_cost_settings)=? AND (? IS NULL OR (${spent})+?<=?)`,params:[s.version,s.cap_usd_micros,m,reserved,s.cap_usd_micros]};
 const allowed=await db.prepare(`SELECT 1 WHERE ${budget.sql}`).bind(...budget.params).first();
 if(!allowed)throw Object.assign(new Error('Optional AI service paused at the owner monthly cap; enter details manually'),{code:'budget_exhausted'});
 await commit(db,all(guard,budget),[db.prepare("INSERT INTO c_provider_costs VALUES(?,'reserved',?,?,?,?,?,?,NULL,NULL,1,?)").bind(attempt,m,feature,model,s.version,pages,reserved,now())]);
 return {attempt,month:m,feature,model,settings:s,pages,reserved};
}
export async function settleProviderCost(db:D1Database,reservation:Awaited<ReturnType<typeof reserveProviderCost>>,usage:Data={}){
 if(!reservation)return null;
 const r=reservation,s=r.settings,known=Number.isSafeInteger(usage.input_tokens)&&usage.input_tokens>=0&&Number.isSafeInteger(usage.output_tokens)&&usage.output_tokens>=0;
 const cost=known?Number((BigInt(usage.input_tokens)*BigInt(s.input_usd_micros_per_million)+BigInt(usage.output_tokens)*BigInt(s.output_usd_micros_per_million)+999999n)/1000000n):r.reserved;
 requireThat(Number.isSafeInteger(cost),'The provider usage cost is outside the supported range',502);
 // Financial usage is recorded even if the original owner or delegate loses access while the provider runs.
 await db.prepare("INSERT INTO c_provider_costs VALUES(?,'settled',?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(r.attempt,r.month,r.feature,r.model,s.version,r.pages,cost,known?usage.input_tokens:null,known?usage.output_tokens:null,known?0:1,now()).run();
 return {attemptId:r.attempt,currency:'USD',usdMicros:cost,pages:r.pages,perPageUsdMicros:cost/r.pages,uncertain:!known,pricingVersion:s.version};
}
