import { all, commit, type Sql } from '../session';
import { ruleEvent } from '../events';
import { requireBusiness } from '../settings';
import { parseCsv } from '../imports/csv';
import { categoryFor, planStatement, readStatement } from '../cards/plan';
import { chargeStatements, placements } from '../cards/charges';
import { claimTotal } from '../claims';
import { requireThat, uid, now, type Data } from '../types';
import type { Delivery } from './transport';
import type { Feed } from './model';

/** The shared card expense planner is used directly with a schedule identity, never a fabricated person or session. */
export async function receiveDelivery(db: D1Database, f: Feed, delivery: Delivery, authorized: Sql) {
  const mapping=JSON.parse(f.mapping) as Data,business=await requireBusiness(db);
  const input={name:delivery.name,format:'csv',issuer:f.issuer,category:f.category_id,costCentre:f.cost_centre,mapping,content:delivery.content};
  const masked=readStatement(input,business.currency).masked;
  // Parse again after masking: statement descriptors, transaction ids and sequence can never retain a known full card.
  requireThat(!/\d(?:[-_ ]?\d){12,18}/.test(masked),'The delivery contains an unmapped long card/account number; correct its CSV mapping',409);
  const csv=parseCsv(masked),column=mapping.sequence as string;
  requireThat(csv.headers.includes(column),'The program delivery has no mapped issuer sequence column',409);
  const sequences=[...new Set(csv.rows.map(r=>r[column].trim()))];
  requireThat(sequences.length===1&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(sequences[0]),'Every delivery row must carry the same explicit issuer sequence',409);
  const sequence=sequences[0],plan=await planStatement(db,{...input,content:masked});
  const earlier=await db.prepare('SELECT sha256 FROM c_program_deliveries WHERE feed_id=? AND issuer_sequence=?').bind(f.id,sequence).first<{sha256:string}>();
  if(earlier){requireThat(earlier.sha256===plan.sha,'The issuer reused a delivery sequence for changed content; nothing was imported',409);return false;}
  requireThat(!plan.review.errors.length,'The program delivery has invalid rows; correct the issuer file or mapping',409);
  requireThat(!plan.review.unassigned.length,`Assign card ${plan.review.unassigned.map(v=>'····'+v).join(', ')} before the next scheduled program pull`,409);
  // A program CSV's transaction date range is not a card statement period; use the ordinary monthly auto report.
  const id=uid(),at=now(),category=await categoryFor(db,f.category_id),place=await placements(db,plan.importable,f.issuer,null);
  const writes:D1PreparedStatement[]=[],guards:Sql[]=[...place.guards,{sql:'NOT EXISTS(SELECT 1 FROM c_program_deliveries WHERE feed_id=? AND issuer_sequence=?)',params:[f.id,sequence]}];
  let file:string|null=null;
  if(!plan.alreadyImported){
    file=uid();
    writes.push(db.prepare("INSERT INTO c_statement_files(id,name,format,issuer,fingerprint,sha256,size,bytes,period_start,period_end,mapping,excluded_cards,included_rows,charges,total_minor,imported_by,imported_at,source) VALUES(?,?,'csv',?,?,?,?,?,?,?,?,'[]','[]',?,?,?,?,'program-feed')").bind(file,delivery.name,f.issuer,plan.fingerprint,plan.sha,plan.bytes.length,plan.bytes,plan.statement.period.start,plan.statement.period.end,JSON.stringify({...mapping,coding:{category:f.category_id,costCentre:f.cost_centre},delivery:{feed:f.id,sequence,transport:'sftp-pull'}}),plan.importable.length,plan.review.totalMinor,'automation: program feed',at),...place.statements);
    for(const held of plan.importable){
      const [claim,position]=place.where.get(held.id)!.split('|');
      guards.push({sql:'EXISTS(SELECT 1 FROM c_cards c JOIN c_members m ON m.email=c.employee_email AND m.active=1 AND m.is_employee=1 WHERE c.id=? AND c.employee_email=?)',params:[held.cardId,held.employee]});
      const made=await chargeStatements(db,{system:'automation: program feed'},{file,feed:f.id,issuer:f.issuer,category,costCentre:f.cost_centre,held,claim,position:Number(position),at});
      guards.push(made.guard);writes.push(...made.statements);
    }
    for(const claim of place.claims.keys())writes.push(claimTotal(db,claim));
  } else file=(await db.prepare('SELECT id FROM c_statement_files WHERE fingerprint=? AND undone_at IS NULL LIMIT 1').bind(plan.fingerprint).first<{id:string}>())!.id;
  writes.push(db.prepare('INSERT INTO c_program_deliveries(id,feed_id,name,issuer_sequence,sha256,file_id,charges,received_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,f.id,delivery.name,sequence,plan.sha,file,plan.importable.length,at),ruleEvent(db,'automation: program feed','program-feed-delivery-received',{}, {feed:f.id,delivery:id,file,issuer:f.issuer,sequence,sha256:plan.sha,charges:plan.importable.length,duplicates:plan.review.duplicates.length,overlaps:plan.review.possibleDuplicates.length,excluded:plan.review.excluded.length,masked:true,channel:'feed'}));
  // A delivery repeats the same card/role and catalog/epoch predicates for many charges.
  // Keep every distinct predicate while binding each identical guard only once, as native statement import does.
  const distinctGuards=[...new Map(guards.map(guard=>[JSON.stringify(guard),guard])).values()];
  await commit(db,all(authorized,...distinctGuards),writes);
  return true;
}
