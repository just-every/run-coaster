import { all, type Sql } from '../../session';
import { categories } from '../../items';
import { codingCatalog, catalogState } from '../model';
import { requireThat, text, type Data } from '../../types';
import { currentRules } from './rules';
import { learnedFields, learningSamples } from './learning';
import { epoch, epochState, fieldsInput, flatten, inactiveReason, merchantKey, unflatten, type Evidence, type Fields } from './model';

export type Proposal = { fields:Fields; appliedFields:string[]; evidence:Evidence[]; flags:{rule:string;ruleVersion:number;reason:string}[]; catalogVersion:number;contextVersion:number;guard:Sql };
/** Ordered, field-level suggestions. A matched invalid rule stops the path for finance to repair; it never silently
 * falls through to learned coding that would bypass the rule. Receipt reading is deliberately absent until CAPTURE-003. */
export async function proposeCoding(db:D1Database,employee:string,b:Data):Promise<Proposal> {
  const merchant=text(b.merchant,'Merchant',200),key=merchantKey(merchant),existing=flatten(fieldsInput(b.values??{})),protectedFields=new Set<string>(Array.isArray(b.protectedFields)?b.protectedFields:[]);
  const version=await epoch(db);
  const [catalog,known,rules,learned]=await Promise.all([codingCatalog(db),categories(db),currentRules(db),learningSamples(db,employee,key)]);
  const candidates:{fields:Fields;source:string;reason:string;rule?:string;ruleVersion?:number}[]=[];
  const addRule=(scope:'finance'|'personal')=>{const rule=rules.find(r=>r.kind==='merchant'&&r.active&&r.scope===scope&&r.merchant_key===key&&(scope==='finance'||r.owner_email===employee));if(rule)candidates.push({fields:rule.fields,source:scope==='finance'?'merchant-rule':'personal-rule',reason:scope==='finance'?'Finance’s exact merchant rule takes precedence over personal rules and learned coding':'Your exact merchant rule takes precedence over learned coding',rule:rule.id,ruleVersion:rule.version});};
  addRule('finance');addRule('personal');
  for(const source of ['person','department','company'] as const) {
    const samples=learned[source],fields=learnedFields(samples);
    if(Object.keys(flatten(fields)).length)candidates.push({fields,source:`learned-${source}`,reason:`At least two matching ${source==='person'?'personal':source} coding observations; the latest two agreeing choices or a strict historical majority`});
  }
  if(b.mcc) {
    requireThat(typeof b.mcc==='string'&&/^\d{4}$/.test(b.mcc),'Merchant category code must have four digits');
    const rule=rules.find(r=>r.kind==='mcc'&&r.active&&r.merchant_key===b.mcc);
    if(rule)candidates.push({fields:rule.fields,source:'merchant-category',reason:`Finance mapped merchant category code ${b.mcc} to this category`,rule:rule.id,ruleVersion:rule.version});
  }
  const picked:Record<string,string>={},evidence:Evidence[]=[],flags:Proposal['flags']=[];
  for(const candidate of candidates) {
    const invalid=inactiveReason(candidate.fields,catalog,known);
    if(invalid) {
      if(candidate.rule) {flags.push({rule:candidate.rule,ruleVersion:candidate.ruleVersion!,reason:invalid});return {fields:{},appliedFields:[],evidence:[],flags,catalogVersion:catalog.version,contextVersion:version,guard:all(epochState(version),catalogState(catalog.version))};}
      continue;
    }
    for(const [field,value] of Object.entries(flatten(candidate.fields))) if(!existing[field]&&!picked[field]&&!protectedFields.has(field)) {
      // A text project/customer already supplied by a person protects the equivalent catalog choice too.
      if(field.startsWith('dimension:')) {const dimension=catalog.dimensions.find(d=>d.id===field.slice(10));if(dimension&&['project','customer'].includes(dimension.kind)&&existing[dimension.kind])continue;}
      picked[field]=value;evidence.push({field,source:candidate.source,reason:candidate.reason,...(candidate.rule?{rule:candidate.rule,ruleVersion:candidate.ruleVersion}: {})});
    }
  }
  // Cross-source dependent values must still belong to the selected parent. Remove a conflicting child rather than guess.
  let changed=true;while(changed){changed=false;for(const [field,id] of Object.entries(picked)) if(field.startsWith('dimension:')) {
    const dimension=catalog.dimensions.find(d=>d.id===field.slice(10)),value=catalog.values.find(v=>v.id===id);
    if(dimension?.parent_id&&(existing[`dimension:${dimension.parent_id}`]??picked[`dimension:${dimension.parent_id}`])!==value?.parent_value_id){delete picked[field];changed=true;}
  }}
  const category=picked.category?known.find(c=>c.id===picked.category):null;
  const categoryGuard=category?[{sql:'EXISTS(SELECT 1 FROM c_categories WHERE id=? AND active=1 AND ledger_account_id IS ? AND ledger_account_snapshot=?)',params:[category.id,category.ledger_account_id??null,category.ledger_account_snapshot??'{}']}]:[];
  return {fields:unflatten(picked),appliedFields:Object.keys(picked),evidence:evidence.filter(e=>picked[e.field]),flags,catalogVersion:catalog.version,contextVersion:version,guard:all(epochState(version),catalogState(catalog.version),...categoryGuard)};
}
export const proposalView=({guard,...view}:Proposal)=>view;
