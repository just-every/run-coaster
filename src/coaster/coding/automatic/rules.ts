import { all, commit } from '../../session';
import { can, needRow, rowAuthority } from '../../permissions';
import { event } from '../../events';
import { categories } from '../../items';
import { codingCatalog, catalogState } from '../model';
import { now, requireThat, text, uid, type Actor, type Data } from '../../types';
import { advanceEpoch, epoch, epochState, fieldsInput, flatten, inactiveReason, merchantKey, type Rule } from './model';

export async function currentRules(db: D1Database): Promise<Rule[]> {
  return (await db.prepare('SELECT r.* FROM c_auto_coding_rules r WHERE r.version=(SELECT MAX(version) FROM c_auto_coding_rules n WHERE n.id=r.id) ORDER BY r.scope,r.merchant_key,r.id').all<Data>()).results.map(r=>({...r,fields:JSON.parse(r.fields)}) as Rule);
}
export async function automaticRules(db: D1Database,actor: Actor) {
  requireThat(actor.kind==='person','A native session is required',403);
  const rules=(await currentRules(db)).filter(r=>r.scope==='finance'&&can(actor,'policy')||r.scope==='personal'&&r.owner_email===actor.email);
  const catalog=await codingCatalog(db),known=await categories(db);
  const flags=can(actor,'policy')?rules.filter(r=>r.active).flatMap(r=>{const reason=inactiveReason(r.fields,catalog,known);return reason?[{rule_id:r.id,rule_version:r.version,catalog_version:catalog.version,reason}]:[];}):[];
  return {version:await epoch(db),rules:rules.filter(r=>r.kind==='merchant'),mccMappings:rules.filter(r=>r.kind==='mcc'),flags};
}
export async function saveAutomaticRule(db:D1Database,actor:Actor,b:Data,kind:'merchant'|'mcc'='merchant') {
  requireThat(actor.kind==='person','Only a person sets coding rules',403);
  requireThat(kind==='mcc'||b.scope==='finance'||b.scope==='personal','Choose finance or personal rule scope');
  requireThat(!actor.delegate,'Set your own personal or finance coding rules from your own sign-in',403);
  const scope=kind==='mcc'?'finance':b.scope as Rule['scope'];
  needRow(actor,scope==='finance'?'policy':'submit');
  const version=await epoch(db); requireThat(b.version===version,'Coding rules changed; reload before saving',409);
  const allRules=await currentRules(db),previous=allRules.find(r=>r.id===b.id);
  requireThat(!b.id||previous,'Coding rule not found',404);
  requireThat(!previous||previous.scope===scope&&previous.kind===kind&&(scope==='finance'||previous.owner_email===actor.email),'This coding rule is outside your access',403);
  const merchant=text(kind==='mcc'?b.mcc:b.merchant,kind==='mcc'?'Merchant category code':'Merchant',200),key=merchantKey(merchant);
  requireThat(kind!=='mcc'||/^\d{4}$/.test(merchant),'Use the four-digit merchant category code');
  const fields=fieldsInput(kind==='mcc'?{category:b.category}:b.coding);
  requireThat(Object.keys(flatten(fields)).length,'Choose at least one coding field');
  const catalog=await codingCatalog(db),known=await categories(db),invalid=inactiveReason(fields,catalog,known);
  requireThat(b.active===false||!invalid,invalid??'Choose active coding');
  requireThat(typeof b.active==='boolean'||b.active===undefined,'Active must be true or false');
  const owner=scope==='personal'?actor.email:'',active=b.active===false?0:1,id=previous?.id??uid(),revision=(previous?.version??0)+1;
  requireThat(!allRules.some(r=>r.id!==id&&r.active&&r.kind===kind&&r.scope===scope&&r.owner_email===owner&&r.merchant_key===key),'An active rule already covers this merchant',409);
  await commit(db,all(rowAuthority(actor,scope==='finance'?'policy':'submit'),epochState(version),catalogState(catalog.version)),[
    db.prepare('INSERT INTO c_auto_coding_rules(id,version,kind,scope,owner_email,merchant,merchant_key,fields,active,set_by,set_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,revision,kind,scope,owner,merchant,key,JSON.stringify(fields),active,actor.email,now()),advanceEpoch(db),
    // Personal rules remain private; finance configuration belongs in the ordinary business history.
    ...(scope==='finance'?[event(db,actor,'automatic-coding-rule-saved',{}, {id,version:revision,kind,merchant,fields,active:!!active})]:[]),
  ]);
  return {...await automaticRules(db,actor),saved:id};
}
