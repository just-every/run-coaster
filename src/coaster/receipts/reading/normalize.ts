import { amount, decimal, requireThat, type Data } from '../../types';
import { FIELD_NAMES, type Fields, type FieldName, type ReadField, type Region, type Source, type LineItem } from './model';
const money=new Set<FieldName>(['total','subtotal','salesTax','tip']);
const object=(v:unknown):v is Data=>!!v&&typeof v==='object'&&!Array.isArray(v);
const clean=(s:string)=>s.replace(/(?:\d[ -]?){12,19}/g,'[payment number redacted]').trim();
export function regions(value:unknown,pages:number):Region[] {
  requireThat(Array.isArray(value)&&value.length<=20,'Invalid reader evidence regions',422);
  return value.map(r=>{
    requireThat(object(r)&&Number.isInteger(r.page)&&r.page>=1&&r.page<=pages&&['x','y','width','height'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k])&&r[k]>=0&&r[k]<=1)&&r.width>0&&r.height>0&&r.x+r.width<=1.001&&r.y+r.height<=1.001,'Invalid reader evidence region',422);
    return {page:r.page,x:r.x,y:r.y,width:r.width,height:r.height};
  });
}
export function scalar(name:FieldName,value:unknown):string {
  requireThat(typeof value==='string','Reader field must be text',422);
  const v=value.trim();
  if(money.has(name)){requireThat(/^\d{1,8}\.\d{2}$/.test(v),'Reader money must be decimal text',422);const minor=amount(v);requireThat(name!=='total'||minor>0,'Receipt total must be positive',422);return decimal(minor);}
  if(name==='date') {requireThat(/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,'Invalid receipt date',422);return v;}
  if(name==='currency'){requireThat(/^[A-Z]{3}$/.test(v)&&Intl.supportedValuesOf('currency').includes(v),'Invalid receipt currency',422);return v;}
  if(name==='last4'){requireThat(/^\d{4}$/.test(v),'Only card last four is retained',422);return v;}
  requireThat(v.length>0&&v.length<=200&&!/[\x00-\x1f]/.test(v),'Invalid receipt text',422);return clean(v);
}
function itemDescription(value:string,quantity:number) {
  const original=clean(value),suffix=original.match(/^(.*?)\s*[×x]\s*(\d+(?:\.\d+)?)$/i),prefix=original.match(/^(\d+(?:\.\d+)?)\s*[×x]\s*(.+)$/i);
  if(suffix&&suffix[1].trim()&&Number(suffix[2])===quantity)return {description:suffix[1].trim(),observedDescription:original};
  if(prefix&&Number(prefix[1])===quantity)return {description:prefix[2].trim(),observedDescription:original};
  return {description:original};
}
function lineItems(value:unknown,pages:number):LineItem[] {
  requireThat(Array.isArray(value)&&value.length>0&&value.length<=100,'Invalid receipt line items',422);
  return value.map(item=>{
    requireThat(object(item)&&typeof item.description==='string'&&item.description.trim().length>0&&item.description.length<=200&&typeof item.quantity==='number'&&Number.isFinite(item.quantity)&&item.quantity>0&&item.quantity<=10000&&typeof item.confidence==='number'&&item.confidence>=0&&item.confidence<=1,'Invalid receipt line item',422);
    return {...itemDescription(item.description,item.quantity),amount:scalar('subtotal',item.amount),quantity:item.quantity,confidence:item.confidence,regions:regions(item.regions,pages)};
  });
}
export function flag(fields:Fields,names:FieldName[],reason:string) {for(const name of names){fields[name].review=true;if(!fields[name].reasons.includes(reason))fields[name].reasons.push(reason);}}
/** Provider confidence is advisory; syntax, missing evidence, arithmetic and native facts can only lower it. */
export function normalizeReading(raw:unknown,threshold:number,pages:number,sources:Source[]=[]):Fields {
  requireThat(object(raw)&&Object.keys(raw).length===FIELD_NAMES.length&&FIELD_NAMES.every(k=>Object.hasOwn(raw,k)),'Receipt reader returned an invalid structure',422);
  const result={} as Fields;
  for(const name of FIELD_NAMES){
    const input=raw[name];requireThat(object(input)&&Object.keys(input).every(k=>['value','confidence','regions'].includes(k))&&typeof input.confidence==='number'&&Number.isFinite(input.confidence)&&input.confidence>=0&&input.confidence<=1,'Invalid reader field',422);
    const evidence=regions(input.regions,pages);let value:ReadField['value']=null;const reasons:string[]=[];
    if(input.value!==null){try{value=name==='lineItems'?lineItems(input.value,pages):scalar(name,input.value);}catch{reasons.push('The reader value needs a valid manual correction');}}
    if(value===null)reasons.push('Not read');
    if(input.confidence<threshold)reasons.push('Reader confidence is below the installation threshold');
    if(value!==null&&!evidence.length)reasons.push('No image region supports this field');
    if(name==='lineItems'&&Array.isArray(value)&&value.some(x=>x.confidence<threshold||!x.regions.length))reasons.push('A receipt line needs review');
    result[name]={value,observed:typeof input.value==='string'?clean(input.value.slice(0,200)):null,confidence:input.confidence,regions:evidence,review:reasons.length>0,reasons,source:'reader'};
  }
  return reconcile(result,sources);
}
export function reconcile(fields:Fields,sources:Source[]):Fields {
  const number=(name:FieldName)=>typeof fields[name].value==='string'?amount(fields[name].value):null;
  const parts=['subtotal','salesTax','tip'] as const,total=number('total');
  if(total!==null&&parts.every(n=>number(n)!==null)&&parts.reduce((sum,n)=>sum+number(n)!,0)!==total)flag(fields,['total',...parts],'Subtotal, sales tax and tip do not equal the final total');
  if(Array.isArray(fields.lineItems.value)&&fields.lineItems.value.length&&number('subtotal')!==null&&fields.lineItems.value.reduce((sum,x)=>sum+amount(x.amount),0)!==number('subtotal'))flag(fields,['lineItems','subtotal','total'],'Receipt line items do not equal the subtotal');
  // A confident total is unsafe when its explicit components or line items are themselves uncertain.
  if(total!==null&&parts.some(n=>fields[n].value!==null&&fields[n].review)||total!==null&&Array.isArray(fields.lineItems.value)&&fields.lineItems.review)flag(fields,['total'],'A component of the final amount needs review');
  const key=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
  if(sources.some(source=>source.pending))flag(fields,FIELD_NAMES.filter(name=>fields[name].source!=='person'),'Conflicts with unread email evidence: read its other original or explicitly confirm these values');
  for(const source of sources)for(const name of FIELD_NAMES){const expected=source.values[name],value=fields[name].value;if(expected!==undefined&&typeof value==='string'&&(name==='merchant'?key(value)!==key(expected):value!==expected))flag(fields,[name],`Conflicts with ${source.kind==='card-charge'?'the attached card charge':source.kind==='merchant-email'?'the merchant email body':source.kind==='email-attachment'?'the email attachment':'the person-confirmed receipt details'}`);}
  return fields;
}
export function correctedFields(previous:Fields,values:unknown,pages:number,sources:Source[]):Fields {
  requireThat(object(values)&&Object.keys(values).length>0&&Object.keys(values).every(k=>(FIELD_NAMES as readonly string[]).includes(k)),'Choose receipt fields to correct');
  const fields=structuredClone(previous);
  const dynamic=['Subtotal, sales tax and tip do not equal the final total','Receipt line items do not equal the subtotal','A component of the final amount needs review'];
  for(const field of Object.values(fields)){field.reasons=field.reasons.filter(r=>!dynamic.includes(r)&&!r.startsWith('Conflicts with '));field.review=field.reasons.length>0;}

  for(const [name,value] of Object.entries(values)){
    const field=name as FieldName,normalized=value===null?null:field==='lineItems'?lineItems(value,pages):scalar(field,value);
    fields[field]={value:normalized,observed:typeof normalized==='string'?normalized:null,confidence:normalized===null?0:1,regions:fields[field].regions,review:normalized===null,reasons:normalized===null?['Not supplied']:[],source:'person'};
  }
  return reconcile(fields,sources);
}
export function currentFields(fields:Fields,sources:Source[]):Fields {
  const current=structuredClone(fields);
  for(const field of Object.values(current)){field.reasons=field.reasons.filter(r=>!r.startsWith('Conflicts with '));field.review=field.reasons.length>0;}
  return reconcile(current,sources);
}
export function safePrefill(fields:Fields) {
  const values:Data={};for(const name of FIELD_NAMES){const field=fields[name];if(!field.review&&field.value!==null)values[name]=field.value;}
  if(values.total!==undefined)values.amount=values.total;
  return values;
}
