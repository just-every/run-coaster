import { claimItems, loadClaim, visible } from '../claims';
import { claimDetail, workspace } from '../views';
import { can } from '../permissions';
import { requireThat, type Actor, type Data } from '../types';

/** Scope-specific projections avoid returning receipts, people, key metadata or audit bodies through claim scope. */
export const claimSummary = (c:Data) => ({id:c.id,number:c.number,title:c.title,employee_email:c.employee_email,status:c.status,revision:c.revision,version:c.version,total_minor:c.total_minor,currency:c.currency,batch_id:c.batch_id,created_at:c.created_at,updated_at:c.updated_at});
export async function visibleClaims(db:D1Database,a:Actor) { return (await workspace(db,a)).claims.map(claimSummary); }
export async function oneClaim(db:D1Database,a:Actor,id:string) { const c=await loadClaim(db,id);visible(a,c);return claimSummary(c); }
export async function draftActor(db:D1Database,a:Actor,id:string):Promise<Actor> {
  const c=await loadClaim(db,id);
  requireThat(c.employee_email===a.email,'Only your own draft can be prepared',403);
  requireThat(c.status==='draft','Only a draft can be prepared by an API credential',409);
  return {...a,publicCredential:{...a.publicCredential!,draftClaim:id}};
}
export async function expenses(db:D1Database,a:Actor,claimId:string) {
  const c=await loadClaim(db,claimId);visible(a,c);
  return (await claimItems(db,c.id)).map(({receipt_sha256,receipt_name,receipt_media,receipt_size,card_match_basis,...item})=>item);
}
export async function oneExpense(db:D1Database,a:Actor,id:string) {
  const row=await db.prepare('SELECT claim_id FROM c_items WHERE id=?').bind(id).first<{claim_id:string}>();
  requireThat(row,'Expense not found',404);
  return (await expenses(db,a,row.claim_id)).find(x=>x.id===id)!;
}
export async function receipts(db:D1Database,a:Actor,claimId:string) {
  const c=await loadClaim(db,claimId);visible(a,c);
  return (await claimDetail(db,a,claimId)).receipts;
}
export async function cards(db:D1Database,a:Actor) {
  requireThat(can(a,'readAll') || a.roles.cardAdmin,'Card spend access required',403);
  return (await db.prepare('SELECT id,issuer,last4,employee_email,assigned_at FROM c_cards ORDER BY id').all()).results;
}
export async function batches(db:D1Database,a:Actor) {
  requireThat(can(a,'readAll'),'Batch read access required',403);
  return (await db.prepare('SELECT id,number,status,currency,total_minor,version,created_at,reviewed_at FROM c_batches ORDER BY number DESC').all()).results;
}
export async function payments(db:D1Database,a:Actor) {
  requireThat(can(a,'readAll'),'Batch read access required',403);
  return (await db.prepare("SELECT id AS batch_id,number,status,paid_reference,paid_on,paid_by,currency,total_minor FROM c_batches WHERE status='reimbursed' ORDER BY number DESC").all()).results;
}
export async function people(db:D1Database,a:Actor) {
  // Matches the workspace's people door: roster for people administrators, own row otherwise.
  const query='SELECT member_id,email,name,is_employee,is_manager,is_finance,is_auditor,is_admin,is_card_admin,is_bookkeeper,department_id,approver_email,active FROM c_members';
  return (await (can(a,'people')?db.prepare(query+' ORDER BY name'):db.prepare(query+' WHERE email=?').bind(a.email)).all()).results;
}
export function page<T>(rows:T[],query:Record<string,string>) {
  const offset=Number(query.offset??0),limit=Number(query.limit??50);
  requireThat(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'Use offset >= 0 and limit 1 to 100');
  return {data:rows.slice(offset,offset+limit),nextOffset:offset+limit<rows.length?offset+limit:null};
}
