import { receiptTransfer, chargeEvidenceForReceipt } from '../coding/automatic/transfer';
import { codingContext, prepareTarget } from '../coding/automatic/storage';
import { all, authority, commit, type Sql } from '../session';
import { needRow, rowAuthority } from '../permissions';
import { claimState, claimTotal, claimItems } from '../claims';
import { event, ruleEvent } from '../events';
import { createFx, type FxResolver } from '../fx';
import { requireBusiness } from '../settings';
import { amount, Fault, isoDate, now, requireThat, text, uid, type Actor, type Data } from '../types';
import { openOriginal, terminal } from './lifecycle';

export const MATCH_ACTOR = 'automation: card match';
import { MATCH_NOTICE } from './match-notice';
export { MATCH_NOTICE } from './match-notice';
type Rule = { version: number; enabled: number; window_days: number; tip_percent: number; fx_percent: number };
type Original = { id: string; owner_email: string; sequence: number; details_sequence: number; match_data: string; generation: number };
type Charge = { transaction_key: string; id: string; item_id: string; claim_id: string; version: number; employee_email: string; amount_minor: number; currency: string; original_minor: number | null; original_currency: string; descriptor: string; transaction_on: string | null; posted_on: string; last4: string };
export const matchRule = (db: D1Database) => db.prepare('SELECT * FROM c_card_match_rules ORDER BY version DESC LIMIT 1').first<Rule>();
const active = `EXISTS(SELECT 1 FROM c_members m WHERE m.email=r.owner_email AND m.active=1 AND m.is_employee=1)
 AND EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=r.owner_email AND o.status='active')`;
const eligible = `FROM c_capture_receipts r JOIN c_capture_lifecycle d ON d.receipt_id=r.id AND d.kind='match-details'
 AND d.sequence=(SELECT MAX(sequence) FROM c_capture_lifecycle WHERE receipt_id=r.id AND kind IN ('match-details','match-withdrawn'))
 WHERE ${active} AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id=r.id AND l.kind IN ('discarded','merged'))
 AND NOT EXISTS(SELECT 1 FROM c_capture_cash_drafts WHERE receipt_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=r.id)`;
const originalSelect = `SELECT r.id,r.owner_email,d.sequence AS details_sequence,d.match_data,
 (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=r.id) AS sequence,
 COALESCE((SELECT version FROM c_card_match_generations WHERE employee_email=r.owner_email),0) AS generation `;
const unlinked: Sql = { sql: '1', params: [] };
const epoch = async (db: D1Database) => (await db.prepare('SELECT version FROM c_card_match_epoch WHERE id=1').first<{version:number}>())!.version;
const unchanged = (version: number): Sql => ({sql:'EXISTS(SELECT 1 FROM c_card_match_epoch WHERE id=1 AND version=?)',params:[version]});
const noAttachment = (id: string): Sql => ({sql:'NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=?)',params:[id]});
export const privateMatchLine = (db: D1Database, id: string, sequence: number, kind: string, by: string, behalf: string | null, data: unknown = null) =>
  db.prepare("INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,at,actor_email,on_behalf_of,channel,match_data) VALUES(?,?,?,'',?,?,?,'app',?)").bind(id,sequence,kind,now(),by,behalf,data===null?null:JSON.stringify(data));

export async function saveMatchRule(db: D1Database, actor: Actor, b: Data) {
  needRow(actor,'policy'); requireThat(actor.kind==='person','A native owner, admin or finance sign-in is required',403);
  requireThat(Object.keys(b).every(k=>['version','enabled','windowDays','tipPercent','fxPercent'].includes(k)),'Only matching rule settings are accepted');
  requireThat(typeof b.enabled==='boolean','Choose matching on or off');
  for (const [key,max] of [['windowDays',14],['tipPercent',30],['fxPercent',10]] as const)
    requireThat(Number.isInteger(b[key])&&b[key]>=0&&b[key]<=max,`${key} must be an integer from 0 to ${max}`);
  const current = (await matchRule(db))!; requireThat(b.version===current.version,'Reload the current matching rule',409);
  await commit(db,all(rowAuthority(actor,'policy'),{sql:'NOT EXISTS(SELECT 1 FROM c_card_match_rules WHERE version>?)',params:[current.version]}),[
    db.prepare('INSERT INTO c_card_match_rules(version,enabled,window_days,tip_percent,fx_percent,set_by,set_at) VALUES(?,?,?,?,?,?,?)').bind(current.version+1,b.enabled?1:0,b.windowDays,b.tipPercent,b.fxPercent,actor.delegate?.email??actor.email,now()),
    event(db,actor,'card-match-rule-set',{}, {version:current.version+1,enabled:b.enabled,windowDays:b.windowDays,tipPercent:b.tipPercent,fxPercent:b.fxPercent}),
  ]); return matchRule(db);
}

/** Consent is per original, never inferred from role, reading state, installation defaults or an agent key. */
export async function chooseCardMatch(db: D1Database, actor: Actor, id: string, b: Data, inherited: Sql[] = []) {
  const {sequence,at} = await terminal(db,actor,id,b,['expectedSequence','enabled','merchant','date','total','currency','last4','notice']);
  requireThat(typeof b.enabled==='boolean','Choose whether to match this original');
  const business = await requireBusiness(db);
  let details: Data | null = null;
  if (b.enabled) {
    requireThat(b.notice===MATCH_NOTICE,'Read and acknowledge the card matching sharing notice');
    const merchant = text(typeof b.merchant==='string'?b.merchant.trim():b.merchant,'Merchant',200), date = isoDate(b.date,'Purchase date'), totalMinor=amount(b.total,'Total');
    requireThat(totalMinor>0,'Total must be positive');
    const currency = b.currency===undefined || b.currency==='' ? business.currency : b.currency;
    requireThat(typeof currency==='string' && /^[A-Z]{3}$/.test(currency) && Intl.supportedValuesOf('currency').includes(currency),'Use an ISO 4217 currency');
    requireThat(b.last4===undefined || b.last4==='' || typeof b.last4==='string' && /^\d{4}$/.test(b.last4),'Card last four must be four digits, or blank');
    details = {merchant,date,totalMinor,currency,last4:b.last4||null};
  }
  const codingContextBefore=details?await codingContext(db,'receipt',id):null;
  const coding=details&&(!codingContextBefore||codingContextBefore.merchant!==details.merchant)?await prepareTarget(db,{kind:'receipt',id,employee:actor.email,merchant:details.merchant},{},codingContextBefore?.values??{}):null;
  await commit(db,all(authority(actor,'employee'),...inherited,...(coding?[coding.guard]:[]),openOriginal(actor,id,sequence,at),noAttachment(id),
    {sql:'EXISTS(SELECT 1 FROM c_business WHERE id=1 AND currency=?)',params:[business.currency]},
    {sql: b.enabled?'NOT EXISTS(SELECT 1 FROM c_capture_cash_drafts WHERE receipt_id=?)':'1',params:b.enabled?[id]:[]}),[
    ...(coding?.writes??[]),
    privateMatchLine(db,id,sequence+1,b.enabled?'match-details':'match-withdrawn',actor.delegate?.email??actor.email,actor.delegate?actor.email:null,details),
  ]);
  return {sequence:sequence+1,enabled:b.enabled,details,notice:MATCH_NOTICE};
}

/** Unicode letters/digits, a shared 4+ character token, or a contained 4+ character compact typed merchant. Never ranks ties. */
function merchantAgrees(typed: string, statement: string) {
  const tokens = (s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,' ').split(/\s+/).filter(Boolean);
  const a=tokens(typed),b=tokens(statement),compact=a.join('');
  return a.some(t=>[...t].length>=4&&b.includes(t)) || [...compact].length>=4&&b.join('').includes(compact);
}
async function basis(details: Data, charge: Charge, rule: Rule, business: {currency:string}, fx: FxResolver) {
  const days=(Date.parse((charge.transaction_on??charge.posted_on)+'T00:00:00Z')-Date.parse(details.date+'T00:00:00Z'))/86400000;
  if(days < -1 || days > rule.window_days || details.last4 && details.last4!==charge.last4) return null;
  const inOriginal=charge.original_currency===details.currency&&charge.original_minor!==null;
  const same=details.currency===(inOriginal?charge.original_currency:charge.currency);
  const charged=inOriginal?charge.original_minor!:charge.amount_minor;
  let kind:string,reference=details.totalMinor,conversion:Data={};
  if(same&&charged===reference) kind='exact';
  else if(same&&charged>reference&&BigInt(charged)*100n<=BigInt(reference)*BigInt(100+rule.tip_percent)&&merchantAgrees(details.merchant,charge.descriptor)) kind='tip';
  else if(!same&&details.currency!==business.currency&&!inOriginal&&merchantAgrees(details.merchant,charge.descriptor)) {
    try { const rate=await fx(details.totalMinor,details.currency,details.date); reference=rate.amount_minor; conversion={fxRate:rate.fx_rate,fxDate:rate.fx_date,fxSource:rate.fx_source}; }
    catch(error) { if(error instanceof Fault) return null; throw error; }
    if(BigInt(Math.abs(charged-reference))*100n>BigInt(reference)*BigInt(rule.fx_percent)) return null;
    kind='fx';
  } else return null;
  return {ruleVersion:rule.version,basis:kind,enteredTotalMinor:details.totalMinor,enteredCurrency:details.currency,enteredDate:details.date,differenceMinor:charged-reference,differenceCurrency:same?details.currency:business.currency,...conversion};
}
async function chargesFor(db:D1Database,employee:string) {
  return (await db.prepare(`SELECT ch.*,i.claim_id,c.version,cd.last4 FROM c_card_charges ch JOIN c_items i ON i.id=ch.item_id AND i.card_charge_id=ch.id
    JOIN c_claims c ON c.id=i.claim_id JOIN c_cards cd ON cd.id=ch.card_id JOIN c_card_sources f ON f.id=ch.file_id
    WHERE ch.employee_email=? AND c.employee_email=ch.employee_email AND c.status IN ('draft','returned') AND i.receipt_id IS NULL
    AND ch.amount_minor>0 AND f.undone_at IS NULL AND NOT EXISTS(SELECT 1 FROM c_plaid_transactions pt WHERE pt.charge_id=ch.id AND pt.status IN ('review','removed'))`).bind(employee).all<Charge>()).results;
}
async function candidates(db:D1Database,original:Original,charges:Charge[],rule:Rule,business:{currency:string},fx:FxResolver) {
  const rejected=new Set((await db.prepare('SELECT transaction_key FROM c_card_match_rejections WHERE receipt_id=?').bind(original.id).all<{transaction_key:string}>()).results.map(r=>r.transaction_key));
  const details=JSON.parse(original.match_data), found:{charge:Charge; basis:Data}[]=[];
  for(const charge of charges) { if(rejected.has(charge.transaction_key)) continue; const match=await basis(details,charge,rule,business,fx); if(match) found.push({charge,basis:match}); }
  return found;
}
export async function cardMatchQuestion(db:D1Database,actor:Actor,id:string) {
  const original=await db.prepare(originalSelect+eligible+' AND r.id=? AND r.owner_email=?').bind(id,actor.email).first<Original>();
  if(!original) return {candidates:[],notice:MATCH_NOTICE};
  const business=await requireBusiness(db),rule=(await matchRule(db))!, fx=createFx(!!business.fx_enabled,business.currency);
  const found=await candidates(db,original,await chargesFor(db,actor.email),rule,business,fx);
  let ambiguous=found.length>1;
  if(found.length===1) {
    const others=(await db.prepare(originalSelect+eligible+' AND r.owner_email=? AND r.id<>?').bind(actor.email,id).all<Original>()).results;
    for(const other of others) if((await candidates(db,other,[found[0].charge],rule,business,fx)).length) {ambiguous=true;break;}
  }
  return {notice:MATCH_NOTICE,ambiguous,candidates:found.map(({charge:c})=>({chargeId:c.id,claimId:c.claim_id,itemId:c.item_id,version:c.version,merchant:c.descriptor,postedDate:c.posted_on,transactionDate:c.transaction_on,amountMinor:c.amount_minor,currency:c.currency,last4:c.last4}))};
}
export async function rejectMatchQuestion(db:D1Database,actor:Actor,id:string,b:Data) {
  const {sequence,at}=await terminal(db,actor,id,b,['expectedSequence','chargeIds']);
  const e=await epoch(db),question=await cardMatchQuestion(db,actor,id),ids=question.candidates.map(c=>c.chargeId).sort();
  requireThat(Array.isArray(b.chargeIds)&&JSON.stringify([...b.chargeIds].sort())===JSON.stringify(ids)&&ids.length,'The match question changed; reload it',409);
  await commit(db,all(authority(actor,'employee'),openOriginal(actor,id,sequence,at),noAttachment(id),unchanged(e)),[
    privateMatchLine(db,id,sequence+1,'match-rejected',actor.delegate?.email??actor.email,actor.delegate?actor.email:null,{chargeIds:ids}),
    ...ids.map(charge=>db.prepare('INSERT OR IGNORE INTO c_card_match_rejections(receipt_id,charge_id,transaction_key,sequence) SELECT ?,id,transaction_key,? FROM c_card_charges WHERE id=?').bind(id,sequence+1,charge)),
  ]); return {rejected:ids.length,sequence:sequence+1};
}
/** Only the hourly delivery attaches automatically. Candidate uniqueness is checked against every eligible competing
 * original, including those outside this delivery's 100-original decision budget. A global epoch guards that snapshot. */
export async function runCardMatching(db:D1Database,at:Date) {
  const rule=await matchRule(db); if(!rule?.enabled) return;
  let cachedFx:FxResolver|undefined,fxKey='';
  const waiting=(await db.prepare(originalSelect+eligible+` AND NOT EXISTS(SELECT 1 FROM c_card_match_checks k WHERE k.receipt_id=r.id
    AND k.generation=COALESCE((SELECT version FROM c_card_match_generations WHERE employee_email=r.owner_email),0) AND k.rule_version=?)
    ORDER BY COALESCE((SELECT evaluated_at FROM c_card_match_checks WHERE receipt_id=r.id),r.uploaded_at),r.uploaded_at,r.id LIMIT 100`).bind(rule.version).all<Original>()).results;
  for(const pending of waiting) {
    const e=await epoch(db),currentRule=await matchRule(db);
    if(!currentRule?.enabled) break;
    const rule=currentRule,business=await requireBusiness(db),key=`${business.currency}:${business.fx_enabled}`;
    if(key!==fxKey) {cachedFx=createFx(!!business.fx_enabled,business.currency);fxKey=key;}
    const fx=cachedFx!;
    const original=await db.prepare(originalSelect+eligible+' AND r.id=?').bind(pending.id).first<Original>();
    if(!original) continue;
    const charges=await chargesFor(db,original.owner_email),found=await candidates(db,original,charges,rule,business,fx);
    let unique=found.length===1;
    if(unique) {
      const others=(await db.prepare(originalSelect+eligible+' AND r.owner_email=? AND r.id<>?').bind(original.owner_email,original.id).all<Original>()).results;
      for(const other of others) if((await candidates(db,other,[found[0].charge],rule,business,fx)).length) {unique=false;break;}
    }
    const statements:D1PreparedStatement[]=[],codingGuards:Sql[]=[];
    if(unique) {
      const {charge,basis:match}=found[0],alias=uid();
      const item=(await claimItems(db,charge.claim_id)).find(i=>i.id===charge.item_id);
      if(item){const evidence=await chargeEvidenceForReceipt(db,original.id,item.id);statements.push(...evidence.writes);codingGuards.push(...evidence.guards);const coding=await receiptTransfer(db,item,original.id,MATCH_ACTOR);statements.push(...coding.writes);codingGuards.push(...coding.guards);}
      statements.push(db.prepare(`INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at,capture_receipt_id,card_match_basis)
        SELECT ?,?,owner_email,name,media_type,size,sha256,X'',source,uploaded_by,uploaded_at,id,? FROM c_capture_receipts WHERE id=?`).bind(alias,charge.claim_id,JSON.stringify(match),original.id),
        db.prepare('UPDATE c_items SET receipt_id=? WHERE id=? AND receipt_id IS NULL').bind(alias,charge.item_id),
        db.prepare("INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,claim_id,item_id,at,actor_email,on_behalf_of,channel,match_data) VALUES(?,?,'attached','',?,?,?,?,?,'schedule',?)").bind(original.id,original.sequence+1,charge.claim_id,charge.item_id,now(),MATCH_ACTOR,original.owner_email,JSON.stringify(match)),
        claimTotal(db,charge.claim_id),ruleEvent(db,MATCH_ACTOR,'card-charge-matched',{claim:charge.claim_id},{charge:charge.id,ruleVersion:rule.version}));
    }
    statements.push(db.prepare('INSERT INTO c_card_match_checks(receipt_id,generation,rule_version,evaluated_at) VALUES(?,?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET generation=excluded.generation,rule_version=excluded.rule_version,evaluated_at=excluded.evaluated_at').bind(original.id,original.generation,rule.version,at.toISOString()));
    try {
      const guards:Sql[]=[...codingGuards,unchanged(e),{sql:'NOT EXISTS(SELECT 1 FROM c_card_match_rules WHERE version>?)',params:[rule.version]},noAttachment(original.id),
        {sql:`EXISTS(SELECT 1 ${eligible} AND r.id=? AND d.sequence=?) AND (SELECT MAX(sequence) FROM c_capture_lifecycle WHERE receipt_id=?)=?`,params:[original.id,original.details_sequence,original.id,original.sequence]}];
      if(unique) guards.push(claimState(found[0].charge.claim_id,found[0].charge.version,['draft','returned']));
      await commit(db,all(unlinked,...guards),statements);
    } catch(error) {if(!(error instanceof Fault&&error.status===409)) throw error;}
  }
}
