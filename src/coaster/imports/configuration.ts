import { canonicalJson, sha256, type ImportMapping, type SourceBundle, type SourceRecord } from '../../modules/import-kit/src/d1/index';
import { sourceIdentity } from '../../modules/import-kit/src/provenance/identity';
import { email, requireThat, text, type Data } from '../types';

const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** A reviewed configuration envelope uses opaque row keys and an explicit crosswalk, never inferred identity. */
export async function configurationSource(db: D1Database, namespace: string, input: unknown, supplied: unknown) {
  const originalText = typeof input === 'string' ? input : canonicalJson(input as Data);
  const config = (typeof input === 'string' ? JSON.parse(input) : input) as Data;
  requireThat(config && typeof config === 'object' && !Array.isArray(config), `Choose a ${namespace} configuration JSON`);
  const crosswalk = { ...(supplied as Record<string,string> ?? {}) };
  const members: Data[] = config.members ?? [], categories: Data[] = config.categories ?? [], chains: Data[] = config.chains ?? [];
  const tags: Data[] = namespace==='expensify' ? config.tags ?? [] : [], cards: Data[] = namespace==='expensify' ? config.cards ?? [] : [];
  requireThat([tags,cards].every(a=>Array.isArray(a)&&a.length<=500),'Import at most 500 tags or cards');
  requireThat([members,categories,chains].every(a => Array.isArray(a) && a.length <= 500), 'Import at most 500 people, categories or chains at a time');
  const entries: Data[] = [...members.map(v => ({...v,kind:'member'})),...categories.map(v => ({...v,kind:'category'})),...chains.map(v => ({...v,kind:'approval-chain'})),...tags.map(v=>({...v,kind:'tag'})),...cards.map(v=>({...v,kind:'card'}))];
  const keys = entries.map(v=>v.key);
  requireThat(keys.every(uuid) && new Set(keys).size === keys.length, 'Each configuration row needs its own opaque UUID key');
  const errors: string[] = [], values = new Map<string,Data>(), references = new Map<string,Data>();
  for (const entry of entries) {
    requireThat(!await db.prepare("SELECT 1 FROM ik_d1_erased_sources WHERE destination='main' AND identity=?").bind(sourceIdentity('main',namespace,entry.kind,entry.key)).first(), 'This source row was erased; it cannot be imported again', 409);
    const persisted = await db.prepare("SELECT value FROM c_history WHERE destination='main' AND kind='crosswalk' AND id=?").bind(namespace+':'+entry.key).first<{value:string}>();
    const prior = persisted ? JSON.parse(persisted.value).targetId : null;
    if (prior && crosswalk[entry.key] && prior !== crosswalk[entry.key]) errors.push(`Row ${entry.key}: crosswalk disagrees with the previous import`);
    crosswalk[entry.key] ??= prior ?? crypto.randomUUID();
    requireThat(uuid(crosswalk[entry.key]), 'Crosswalk targets must be opaque UUIDs');
  }
  requireThat(new Set(Object.values(crosswalk)).size === Object.values(crosswalk).length,'Each source row must map to a separate target');
  for (const m of members) {
    const id=crosswalk[m.key], address=email(m.email), name=text(m.name,'Imported name',120);
    const existing=await db.prepare('SELECT * FROM c_members WHERE member_id=?').bind(id).first<Data>();
    if (existing) { requireThat(existing.email===address,'Crosswalk member email must match the chosen native person'); references.set(m.key,existing); continue; }
    if(await db.prepare('SELECT 1 FROM c_members WHERE email=?').bind(address).first()) errors.push(`Person ${address} already exists: explicitly map its row key to that person's member_id`);
    const v={member_id:id,email:address,name,is_employee:m.employee===false?0:1,is_manager:m.manager===true?1:0,is_finance:m.finance===true?1:0,is_auditor:m.auditor===true?1:0,approver_email:null,active:0,updated_at:'imported'};
    values.set(m.key,v); references.set(m.key,v);
  }
  for(const c of categories){
    const id=crosswalk[c.key], name=text(c.name,'Imported category',100);
    const existing=await db.prepare('SELECT * FROM c_categories WHERE id=?').bind(id).first<Data>();
    if(existing) { references.set(c.key,existing); continue; }
    if(await db.prepare('SELECT 1 FROM c_categories WHERE name=?').bind(name).first()) errors.push(`Category ${name} already exists: explicitly map its row key to that category's id`);
    values.set(c.key,{id,name,account_code:text(c.accountCode,'Account code',40),tax_code:text(c.taxCode,'Tax code',40),limit_minor:null,active:1,receipt_always:/\b(lodging|hotels?|motels?)\b/i.test(name)?1:0,per_person_limit_minor:null,required_fields:'[]'});
  }
  for(const c of chains){
    requireThat(references.has(c.employee) && Array.isArray(c.steps) && c.steps.length>0 && c.steps.length<=20,'A chain needs an imported person and 1–20 ordered managers');
    requireThat(new Set(c.steps).size===c.steps.length && !c.steps.includes(c.employee),'A chain cannot repeat a manager or approve its own employee');
    requireThat(c.steps.every((key:string)=>references.get(key)?.is_manager===1),'Each chain step must map to a manager');
    requireThat(!chains.some(other=>other!==c && other.employee===c.employee),'Import one chain per employee');
    const employeeId=crosswalk[c.employee], id=crosswalk[c.key];
    const existing=await db.prepare('SELECT id FROM c_import_chains WHERE employee_id=? AND id<>?').bind(employeeId,id).first();
    if(existing) errors.push('This employee already has a different approval chain; map the chain key explicitly');
    values.set(c.key,{id,employee_id:employeeId,steps:JSON.stringify(c.steps.map((key:string)=>crosswalk[key]))});
  }
  const tagDimension = namespace+':tags';
  requireThat(new Set(tags.map(t=>t.name)).size===tags.length,'Each imported tag needs a distinct name');
  requireThat(new Set(cards.map(c=>String(c.issuer).toLowerCase()+'|'+c.last4)).size===cards.length,'Each imported card needs a distinct issuer and last four');
  if(tags.length){
    const existing=await db.prepare('SELECT id FROM c_coding_dimensions WHERE id=?').bind(tagDimension).first();
    if(!existing && await db.prepare('SELECT 1 FROM c_coding_dimensions WHERE name=?').bind('Expensify tags').first()) errors.push('Rename the existing Expensify tags dimension before importing tags');
    if(!existing) values.set(tagDimension,{id:tagDimension,name:'Expensify tags',kind:'tag',parent_id:null,required:0,active:1,source:'native',source_company:'',updated_at:'imported'});
  }
  for(const tag of tags){
    const id=crosswalk[tag.key],name=text(tag.name,'Tag',100),existing=await db.prepare('SELECT * FROM c_coding_values WHERE id=?').bind(id).first<Data>();
    if(existing){requireThat(existing.dimension_id===tagDimension,'Map tags only within the Expensify tags dimension');continue;}
    if(await db.prepare('SELECT 1 FROM c_coding_values WHERE dimension_id=? AND name=?').bind(tagDimension,name).first()) errors.push(`Tag ${name} already exists: explicitly map its key`);
    values.set(tag.key,{id,dimension_id:tagDimension,name,parent_value_id:null,owner_email:null,active:1,source_id:'',updated_at:'imported'});
  }
  for(const card of cards){
    const id=crosswalk[card.key],employee=references.get(card.employee);
    requireThat(employee?.is_employee===1,'Each card must name an explicitly imported employee row');
    requireThat(typeof card.last4==='string'&&/^\d{4}$/.test(card.last4),'Import card last four only, never a full card number');
    const issuer=text(card.issuer,'Issuer',60),existing=await db.prepare('SELECT * FROM c_cards WHERE id=?').bind(id).first<Data>();
    if(existing){requireThat(existing.employee_email===employee.email&&existing.issuer===issuer&&existing.last4===card.last4,'Mapped cards must retain the same issuer, last four and employee');continue;}
    if(await db.prepare('SELECT 1 FROM c_cards WHERE lower(issuer)=? AND last4=?').bind(issuer.toLowerCase(),card.last4).first())errors.push(`Card ${issuer} ····${card.last4} already exists: explicitly map its key`);
    values.set(card.key,{id,issuer,last4:card.last4,employee_email:employee.email,assigned_by:'role:owner',assigned_at:'imported'});
  }
  const raw=originalText, bytes=new TextEncoder().encode(raw), artifactHash=sha256(bytes);
  const records:SourceRecord[]=entries.flatMap(e=>{
    const crosswalkValue={sourceKey:e.key,targetId:crosswalk[e.key],kind:e.kind};
    return [{namespace,kind:e.kind,sourceId:e.key,payload:e,payloadHash:sha256(canonicalJson(e)),artifactHash,location:{artifact:namespace==='expensify'?'expensify-configuration.json':'emburse-configuration.json'}},{namespace,kind:'crosswalk',sourceId:e.key,payload:crosswalkValue,payloadHash:sha256(canonicalJson(crosswalkValue)),artifactHash,location:{artifact:namespace==='expensify'?'expensify-configuration.json':'emburse-configuration.json'}}];
  });
  if(values.has(tagDimension))records.unshift({namespace,kind:'tag-dimension',sourceId:tagDimension,payload:values.get(tagDimension)!,payloadHash:sha256(canonicalJson(values.get(tagDimension)!)),artifactHash,location:{artifact:'expensify-configuration.json'}});
  const source:SourceBundle={records,diagnostics:errors.map(message=>({severity:'error',code:'CONFIGURATION',message})),artifacts:[{name:namespace==='expensify'?'expensify-configuration.json':'emburse-configuration.json',sha256:artifactHash,size:bytes.length,original:{status:'available',base64:btoa(unescape(encodeURIComponent(raw)))}}]};
  const mapping:ImportMapping={version:sha256(canonicalJson({kit:'emburse-configuration-v2',crosswalk})),map:r=>({effects:errors.length?[]:r.kind==='crosswalk'?[{targetKind:'crosswalk',targetId:namespace+':'+r.sourceId,value:r.payload}]:values.has(r.sourceId)?[{targetKind:r.kind,targetId:crosswalk[r.sourceId]??tagDimension,value:values.get(r.sourceId)!}]:[],...(errors.length?{rejection:'Resolve configuration errors'}:{})})};
  return {source,mapping,summary:{members:members.length,categories:categories.length,chains:chains.length,tags:tags.length,cards:cards.length,crosswalk,errors,warnings:[...Object.keys(config).filter(k=>!['members','categories','chains','policies','tags','cards'].includes(k)).map(k=>`Configuration ${k} kept in the original but not mapped`),...entries.flatMap(entry=>Object.keys(entry).filter(k=>!['key','name','email','employee','manager','finance','auditor','accountCode','taxCode','steps','kind','issuer','last4','employee'].includes(k)).map(k=>`Row ${entry.key}: ${k} kept in the original but not mapped`))],charges:0,receipts:0,totalMinor:0,credits:[]}};
}
