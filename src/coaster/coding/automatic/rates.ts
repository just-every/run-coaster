import { needRow } from '../../permissions';
import { requireThat, type Actor, type Data } from '../../types';
import { currentRules } from './rules';
import { flatten } from './model';

/** The unit is one suggestion per source/rule; a partially changed recommendation counts as overridden for its source.
 * Pending advice stays in the denominator shown, while rate is accepted / (accepted + overridden), or null. */
export async function codingRates(db:D1Database,actor:Actor) {
  needRow(actor,'policy');requireThat(actor.kind==='person','A native finance sign-in is required',403);
  const rules=(await currentRules(db)).filter(r=>r.scope==='finance');
  const rows=(await db.prepare('SELECT s.fields,s.evidence,f.action,f.values_json FROM c_auto_coding_suggestions s LEFT JOIN c_auto_coding_feedback f ON f.suggestion_id=s.id').all<Data>()).results;
  const bySource=new Map<string,Data>(),byRule=new Map<string,Data>();
  const entry=(map:Map<string,Data>,key:string,extra:Data)=>{if(!map.has(key))map.set(key,{...extra,accepted:0,overridden:0,pending:0});return map.get(key)!;};
  for(const row of rows) {
    const evidence=JSON.parse(row.evidence) as Data[],proposed=flatten(JSON.parse(row.fields)),actual=row.action?flatten(JSON.parse(row.values_json)):{};
    const groups=new Map<string,Data[]>();
    for(const e of evidence) {const key=`${e.source}|${e.rule??''}`;groups.set(key,[...(groups.get(key)??[]),e]);}
    for(const fields of groups.values()) {
      const e=fields[0],status=!row.action?'pending':fields.every(f=>actual[f.field]===proposed[f.field])?'accepted':'overridden';
      entry(bySource,e.source,{source:e.source})[status]++;
      if(e.rule&&rules.some(r=>r.id===e.rule))entry(byRule,e.rule,{id:e.rule,merchant:rules.find(r=>r.id===e.rule)!.merchant})[status]++;
    }
  }
  const rate=(row:Data)=>({...row,rate:row.accepted+row.overridden?Math.round(row.accepted*10000/(row.accepted+row.overridden))/100:null});
  return {rules:rules.map(r=>rate(byRule.get(r.id)??{id:r.id,merchant:r.merchant,accepted:0,overridden:0,pending:0})),sources:[...bySource.values()].map(rate)};
}
