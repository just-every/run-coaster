import { all, authority, commit, need, sha256Hex } from './session';
import { event } from './events';
import { claimNumber } from './claims';
import { claimReceiptBytes } from './receipts/claim-storage';
import { zip } from './zip';
import { requireThat, text, type Actor, type Data } from './types';

function access(a:Actor) { requireThat(a.kind==='person'&&!a.publicCredential,'A native finance session is required',403); need(a,'finance'); }
const merchant=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
/** Investigate existing POLICY-002 observations using frozen submitted facts only.
 * Graph edges are explicit comparison references or the same merchant within 30 days.
 * This door has no provider, notification, claim or payment mutation. */
export async function investigations(db:D1Database,a:Actor) {
 access(a);
 const rows=(await db.prepare('SELECT c.id,c.number,c.employee_email,c.status,c.currency,r.revision,r.snapshot FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id WHERE r.revision=(SELECT MAX(v.revision) FROM c_revisions v WHERE v.claim_id=c.id) ORDER BY c.number').all<Data>()).results;
 const records:Data[]=rows.flatMap(c=>{const s=JSON.parse(c.snapshot);return s.items.map((i:Data)=>({claim:c.id,number:claimNumber(c.number),revision:c.revision,employee:c.employee_email,currency:c.currency,item:i.id,merchant:i.merchant,date:i.spent_on,amountMinor:i.amount_minor,cardCharge:i.card_charge_id??null,receipt:i.receipt?{id:i.receipt.id,sha256:i.receipt.sha256,name:i.receipt.name,mediaType:i.receipt.media_type}:null,signals:s.receiptSignals?.find((r:Data)=>r.item===i.id)?.signals??[]}));});
 const links=new Map<string,Set<string>>(records.map(r=>[r.item,new Set([r.item])]));
 const connect=(x:string,y:string)=>{if(links.has(x)&&links.has(y)){links.get(x)!.add(y);links.get(y)!.add(x);}};
 for(const r of records){
  for(const s of r.signals){if(s.evidence?.item)connect(r.item,s.evidence.item);for(const p of s.evidence?.purchases??[])connect(r.item,p.item);}
  for(const other of records)if(merchant(r.merchant)&&merchant(r.merchant)===merchant(other.merchant)&&Math.abs(Date.parse(r.date)-Date.parse(other.date))<=30*86400000)connect(r.item,other.item);
 }
 const outcomes=(await db.prepare("SELECT detail,actor_email,at FROM c_events WHERE action='investigation-outcome-recorded' ORDER BY seq").all<Data>()).results.map(e=>({...JSON.parse(e.detail),by:e.actor_email,at:e.at}));
 const visited=new Set<string>(),packs:Data[]=[];
 for(const r of records.filter(r=>r.signals.length)){
  if(visited.has(r.item))continue;
  const ids=new Set<string>(),todo=[r.item];while(todo.length){const id=todo.pop()!;if(ids.has(id))continue;ids.add(id);visited.add(id);todo.push(...links.get(id)!);}
  const related=records.filter(r=>ids.has(r.item)).sort((a,b)=>a.item.localeCompare(b.item));
  const id=await sha256Hex(JSON.stringify(related.map(r=>[r.claim,r.revision,r.item,r.receipt?.sha256??null,r.signals.map((s:Data)=>s.code)])));
  packs.push({id,label:'Possible, needs finance review',records:related,employees:[...new Set(related.map(r=>r.employee))],from:related.map(r=>r.date).sort()[0],through:related.map(r=>r.date).sort().at(-1),outcome:outcomes.find(o=>o.pack===id)??null});
 }
 return {packs,boundary:'Submitted evidence only. No employee contact, payment hold or conclusion of wrongdoing. Finance records its own outcome.'};
}
export async function investigationOutcome(db:D1Database,a:Actor,id:string,b:Data){
 access(a);requireThat(Object.keys(b).every(k=>['outcome','note'].includes(k)),'Only an outcome and review note are accepted');
 const pack=(await investigations(db,a)).packs.find(p=>p.id===id);requireThat(pack,'This evidence pack changed; reload',409);
 requireThat(!pack.outcome,'Finance already recorded the outcome for this evidence',409);
 requireThat(!pack.employees.includes(a.email)&&!pack.employees.includes(a.delegate?.email),'Someone else in finance must review your own expenses',403);
 requireThat(['explained','needs-follow-up'].includes(b.outcome),'Choose explained or needs follow-up');const note=text(b.note,'Finance outcome note',2000);
 const guards=pack.records.map((r:Data)=>({sql:'EXISTS(SELECT 1 FROM c_revisions WHERE claim_id=? AND revision=?)',params:[r.claim,r.revision]}));
 await commit(db,all(authority(a,'finance'),...guards,{sql:"NOT EXISTS(SELECT 1 FROM c_events WHERE action='investigation-outcome-recorded' AND json_extract(detail,'$.pack')=?)",params:[id]}),[event(db,a,'investigation-outcome-recorded',{}, {pack:id,claims:[...new Set(pack.records.map((r:Data)=>r.claim))],outcome:b.outcome,note})]);
 return investigations(db,a);
}
export async function investigationFile(db:D1Database,a:Actor,id:string,bucket?:R2Bucket){
 const pack=(await investigations(db,a)).packs.find(p=>p.id===id);requireThat(pack,'Evidence pack not found',404);
 const files:{name:string;bytes:Uint8Array}[]=[{name:'evidence.json',bytes:new TextEncoder().encode(JSON.stringify(pack,null,2))}];let size=0;
 for(const r of pack.records.filter((r:Data)=>r.receipt)){
  if(files.some(f=>f.name===`receipts/${r.receipt.sha256}`))continue;
  const receipt=await db.prepare('SELECT * FROM c_receipts WHERE id=? AND claim_id=? AND sha256=?').bind(r.receipt.id,r.claim,r.receipt.sha256).first<Data>();
  requireThat(receipt,'A retained original is no longer available',409);size+=receipt.size;requireThat(size<=60_000_000,'This pack exceeds the 60 MB download limit',413);
  files.push({name:`receipts/${r.receipt.sha256}`,bytes:await claimReceiptBytes(db,receipt,bucket)});
 }
 return new Response(zip(files,new Date()),{headers:{'content-type':'application/zip','content-disposition':'attachment; filename="coaster-investigation.zip"','cache-control':'no-store'}});
}
