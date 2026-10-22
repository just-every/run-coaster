import type { Data } from '../../types';
import { flatten, itemFields, merchantKey, unflatten, type Fields } from './model';

type Sample = { fields: Fields; person: string; department: string; order: number; target?:string };
/** Only the employee's own private corrections participate in their personal learning. Shared learning reads
 * submitted revisions, never another person's draft or inbox, and shares category/catalog choices without memos. */
export async function learningSamples(db:D1Database,employee:string,key:string) {
  const [corrections,submitted,member] = await Promise.all([
    db.prepare(`SELECT * FROM c_auto_coding_observations WHERE employee_email=? AND merchant_key=? AND ((target_kind='item' AND EXISTS(SELECT 1 FROM c_items i WHERE i.id=target_id)) OR (target_kind='receipt' AND EXISTS(SELECT 1 FROM c_capture_receipts r WHERE r.id=target_id AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id=r.id AND l.kind IN ('discarded','merged'))))) ORDER BY id DESC LIMIT 200`).bind(employee,key).all<Data>(),
    db.prepare(`SELECT c.employee_email,m.department_id,r.snapshot FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision LEFT JOIN c_members m ON m.email=c.employee_email WHERE c.status IN ('submitted','approved','batched','reimbursed') ORDER BY r.submitted_at DESC,c.number DESC`).bind().all<Data>(),
    db.prepare('SELECT department_id FROM c_members WHERE email=? AND active=1').bind(employee).first<{department_id:string|null}>(),
  ]);
  const privateSamples:Sample[]=corrections.results.map((r,i)=>({fields:JSON.parse(r.fields),person:employee,department:r.department_id,order:i,target:`${r.target_kind}:${r.target_id}`}));
  const publicSamples:Sample[]=[];
  for(const claim of submitted.results) for(const item of JSON.parse(claim.snapshot).items as Data[]) if(merchantKey(item.merchant)===key) {
    const fields=itemFields(item); delete fields.memo; delete fields.project; delete fields.customer;
    publicSamples.push({fields,person:claim.employee_email,department:claim.department_id??'',order:publicSamples.length,target:`item:${item.id}`});
  }
  const recorded=new Set(privateSamples.map(s=>s.target)),ownHistory=publicSamples.filter(s=>s.person===employee&&!recorded.has(s.target));
  // At most one historical observation per expense; a correction to an existing expense takes precedence over its older history.
  return {person:[...privateSamples,...ownHistory],department:member?.department_id?publicSamples.filter(s=>s.department===member.department_id):[],company:publicSamples};
}
/** A field is learned after two matching human observations. The two most recent matching corrections win;
 * otherwise a strict majority with at least two examples is needed. Ties ask for a human instead of guessing. */
export function learnedFields(samples:Sample[]):Fields {
  const result:Record<string,string>={},fields=new Set(samples.flatMap(s=>Object.keys(flatten(s.fields))));
  for(const field of fields) {
    const values=samples.map(s=>flatten(s.fields)[field]).filter(Boolean);
    if(values.length<2) continue;
    if(values[0]===values[1]) {result[field]=values[0];continue;}
    const count=new Map<string,number>(); for(const value of values) count.set(value,(count.get(value)??0)+1);
    const ranked=[...count].sort((a,b)=>b[1]-a[1]);
    if(ranked[0][1]>=2&&ranked[0][1]*2>values.length) result[field]=ranked[0][0];
  }
  return unflatten(result);
}
