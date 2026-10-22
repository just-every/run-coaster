import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Old archives have no automatic coding records. New records retain historical inactive choices, but never forged
 * category/dimension references, feedback without a suggestion, or a context attributed to another expense/receipt owner. */
export async function validateAutomaticCodingArchive(read) {
  const names=['c_auto_coding_epoch','c_auto_coding_rules','c_auto_coding_contexts','c_auto_coding_suggestions','c_auto_coding_feedback','c_auto_coding_observations','c_auto_coding_flags','c_categories','c_coding_dimensions','c_coding_values','c_items','c_claims','c_capture_receipts'];
  const [epochs,rules,contexts,suggestions,feedback,observations,flags,categories,dimensions,values,items,claims,receipts]=await Promise.all(names.map(read));
  const check=value=>{if(!value)throw new PortabilityError('coaster_automatic_coding',409);};
  if(!epochs.length){check(![rules,contexts,suggestions,feedback,observations,flags].some(rows=>rows.length));return;}
  check(epochs.length===1&&epochs[0].id===1&&Number.isSafeInteger(epochs[0].version)&&epochs[0].version>=0);
  const category=new Set(categories.map(c=>c.id)),dimension=new Map(dimensions.map(d=>[d.id,d])),value=new Map(values.map(v=>[v.id,v]));
  const parse=raw=>{let object;try{object=JSON.parse(raw);}catch{check(false);}return object;};
  const fields=raw=>{
    const f=parse(raw);check(f&&typeof f==='object'&&!Array.isArray(f)&&Object.keys(f).every(k=>['category','dimensions','project','customer','memo'].includes(k)));
    if(f.category)check(category.has(f.category));
    if(f.dimensions){check(typeof f.dimensions==='object'&&!Array.isArray(f.dimensions));for(const [id,choice]of Object.entries(f.dimensions)){check(dimension.has(id)&&value.get(choice)?.dimension_id===id);}}
    for(const key of ['project','customer','memo'])check(f[key]===undefined||typeof f[key]==='string'&&f[key].length<=500);
    return f;
  };
  for(const rule of rules){check(['merchant','mcc'].includes(rule.kind)&&['finance','personal'].includes(rule.scope)&&Number.isSafeInteger(rule.version)&&rule.version>0&&[0,1].includes(rule.active));check(rule.scope==='finance'?rule.owner_email==='':typeof rule.owner_email==='string'&&rule.owner_email.length>0);fields(rule.fields);}
  for(const context of contexts){
    check(['item','receipt'].includes(context.target_kind)&&Number.isSafeInteger(context.version)&&context.version>0);fields(context.values_json);
    const human=parse(context.human_fields);check(Array.isArray(human)&&human.every(f=>['category','project','customer','memo'].includes(f)||f.startsWith('dimension:')&&dimension.has(f.slice(10))));
    const target=context.target_kind==='receipt'?receipts.find(r=>r.id===context.target_id):items.find(i=>i.id===context.target_id);
    const owner=context.target_kind==='receipt'?target?.owner_email:claims.find(c=>c.id===target?.claim_id)?.employee_email;
    check(target&&owner===context.employee_email);
    check(typeof context.mcc==='string'&&(!context.mcc||/^\d{4}$/.test(context.mcc)));
  }
  const suggestion=new Map(suggestions.map(s=>[s.id,s]));
  for(const row of suggestions){fields(row.fields);const applied=parse(row.applied_fields),evidence=parse(row.evidence);check(Array.isArray(applied)&&Array.isArray(evidence)&&evidence.every(e=>applied.includes(e.field)&&typeof e.source==='string'&&typeof e.reason==='string'));check(Number.isSafeInteger(row.context_version)&&row.context_version>0);}
  for(const row of feedback){check(suggestion.has(row.suggestion_id)&&['accept','override'].includes(row.action));fields(row.values_json);}
  for(const row of observations){check(['item','receipt'].includes(row.target_kind));fields(row.fields);}
  for(const flag of flags)check(rules.some(r=>r.id===flag.rule_id&&r.version===flag.rule_version));
}
