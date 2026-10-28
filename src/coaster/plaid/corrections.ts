import type { Bindings } from '../../auth.server';
import { claimState, claimTotal } from '../claims';
import { event } from '../events';
import { all, authority, commit, need, notDeactivated, type Sql } from '../session';
import { now, requireThat, text, type Actor, type Data } from '../types';
import type { Held } from '../cards/plan';
import { plaidAccess } from './accounts';
import { plaidExpense } from './expenses';
import type { Transaction } from './transactions';

const factsFields = ['transaction_id','account_id','pending_transaction_id','spent_on','posted_on','merchant','amount_minor','currency'];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rows = async (db: D1Database, sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all<Data>()).results;
const neverSubmitted = (item: string, charge: string | null): Sql => ({
  sql: `NOT EXISTS(SELECT 1 FROM c_revisions r,json_each(r.snapshot,'$.items') i
    WHERE json_extract(i.value,'$.id')=? OR (? IS NOT NULL AND json_extract(i.value,'$.card_charge_id')=?))`, params: [item, charge, charge],
});
const unchanged = (table: string, row: Data): Sql => ({
  sql: `EXISTS(SELECT 1 FROM ${table}, (SELECT json(?) AS expected) WHERE ${Object.keys(row).map(k => `${k} IS json_extract(expected,'$.${k}')`).join(' AND ')})`, params: [JSON.stringify(row)],
});

/** Snapshot every retained expense, split and automatic-coding fact before deleting only its mutable projection. */
async function priorExpense(db: D1Database, item: Data) {
  const [allocations, contexts, suggestions, feedback, observations] = await Promise.all([
    rows(db,'SELECT * FROM c_allocations WHERE item_id=? ORDER BY position',item.id),
    rows(db,"SELECT * FROM c_auto_coding_contexts WHERE target_kind='item' AND target_id=?",item.id),
    rows(db,"SELECT * FROM c_auto_coding_suggestions WHERE target_kind='item' AND target_id=? ORDER BY created_at,id",item.id),
    rows(db,"SELECT f.* FROM c_auto_coding_feedback f JOIN c_auto_coding_suggestions s ON s.id=f.suggestion_id WHERE s.target_kind='item' AND s.target_id=? ORDER BY f.suggestion_id",item.id),
    rows(db,"SELECT * FROM c_auto_coding_observations WHERE target_kind='item' AND target_id=? ORDER BY id",item.id),
  ]);
  return { item, allocations, contexts, suggestions, feedback, observations };
}

function pristine(prior: Awaited<ReturnType<typeof priorExpense>>, source: Data, mapping: Data, charge: Data | null, personalCharge: Data | null) {
  const { item, allocations, contexts, feedback, observations } = prior, context = contexts[0];
  requireThat(!item.receipt_id, 'An attached receipt needs separate reconciliation; its original is retained', 409);
  requireThat(contexts.length === 1 && context.version === 1 && equal(JSON.parse(context.human_fields), []) && !feedback.length && !observations.length,
    'Human-edited expense data needs separate reconciliation',409);
  const coding = JSON.parse(context.values_json);
  const expected: Data = { kind:'receipt',spent_on:source.spent_on,merchant:source.merchant,amount_minor:source.amount_minor,
    description:coding.memo??'',explanation:'',distance_hundredths:null,days:null,rate_thousandths:null,receipt_id:null,
    sales_tax_minor:0,sales_tax_account:'',sales_tax_code:'',attendees:'[]',fields:'{}',request_id:null,allowance_id:null,claimed_minor:null,
    billable:0,customer:coding.customer??'',project:coding.project??'',original_minor:null,original_currency:'',fx_rate:'',fx_date:'',fx_source:'',original_sales_tax_minor:null,per_diem:'',card_charge_id:charge?.id??null,personal_card_charge_id:personalCharge?.id??null,receipt_resolution:null };
  requireThat(Object.entries(expected).every(([k,v])=>item[k]===v) && equal(JSON.parse(item.coding),coding.dimensions??{})
    && allocations.length===1 && allocations[0].position===0 && allocations[0].category_id===(coding.category??mapping.coding.category)
    && allocations[0].cost_centre==='' && allocations[0].amount_minor===source.amount_minor && allocations[0].description==='' && allocations[0].original_minor===null,
    'Human-edited expense data needs separate reconciliation',409);
}

/** Native-only, exact-change resolution. Submitted history, private originals and old immutable charges are never changed. */
export async function reconcilePlaid(env: Bindings, actor: Actor, id: string, body: Data) {
  requireThat(actor.kind==='person' && !actor.delegate && !actor.publicCredential,'Use your own native session to reconcile Plaid',403);
  const { connection: c, guard: access } = await plaidAccess(env,actor,id), db=env.DB;
  if(c.scope==='company') need(actor,'owner');
  requireThat(c.status==='connected','Only a connected feed can reconcile a source change',409);
  requireThat(Object.keys(body).every(k=>['transaction','changeSeq','version','consent'].includes(k)) && body.consent===true,'Explicitly consent to the exact provider correction');
  const transaction=text(body.transaction,'Plaid transaction',200);
  requireThat(Number.isSafeInteger(body.changeSeq)&&body.changeSeq>0&&Number.isSafeInteger(body.version)&&body.version>0,'Choose the latest source change and exact claim version');
  const tx=await db.prepare('SELECT * FROM c_plaid_transactions WHERE connection_id=? AND transaction_id=?').bind(id,transaction).first<Data>();
  requireThat(tx?.status==='review'&&tx.item_id,'This transaction has no unresolved mutable source expense',409);
  requireThat(c.scope===tx.scope && (c.scope!=='personal'||tx.employee_email===actor.email),'This expense belongs to a different person',403);
  const [item, change, sync, settings, assignment] = await Promise.all([
    db.prepare('SELECT * FROM c_items WHERE id=?').bind(tx.item_id).first<Data>(),
    db.prepare('SELECT * FROM c_plaid_changes WHERE connection_id=? AND transaction_id=? ORDER BY seq DESC LIMIT 1').bind(id,transaction).first<Data>(),
    db.prepare('SELECT * FROM c_plaid_sync_state WHERE connection_id=?').bind(id).first<Data>(),
    db.prepare('SELECT version FROM c_plaid_settings WHERE id=1').first<Data>(),
    db.prepare('SELECT * FROM c_plaid_assignments WHERE connection_id=? AND account_id=?').bind(id,tx.account_id).first<Data>(),
  ]);
  requireThat(item&&change&&change.seq===body.changeSeq,'The source changed; reload before reconciling',409);
  requireThat(sync&&sync.in_progress===0&&sync.cursor&&sync.last_sync_at&&settings,'Finish the complete source synchronization before reconciling',409);
  const claim=await db.prepare('SELECT * FROM c_claims WHERE id=?').bind(item.claim_id).first<Data>();
  requireThat(claim&&['draft','returned'].includes(claim.status)&&claim.version===body.version,'The claim changed or has entered submission; reload',409);
  requireThat(assignment && claim.employee_email===tx.employee_email&&assignment.employee_email===tx.employee_email,'This expense belongs to a different person',403);
  const charge=tx.charge_id?await db.prepare('SELECT * FROM c_card_charges WHERE id=?').bind(tx.charge_id).first<Data>():null;
  requireThat(c.scope==='company'?charge&&charge.item_id===item.id&&charge.employee_email===tx.employee_email&&charge.card_id===assignment.card_id:!charge&&!item.card_charge_id,'The immutable financial source differs; reconcile separately',409);
  // Reconnection may keep its source under an earlier connection. Creation events identify personal originals exactly.
  const personalCharge = item.personal_card_charge_id ? await db.prepare('SELECT * FROM c_plaid_personal_charges WHERE id=?').bind(item.personal_card_charge_id).first<Data>() : null;
  requireThat(c.scope === 'personal' || !item.personal_card_charge_id, 'A company expense cannot carry personal card provenance',409);
  requireThat(!item.personal_card_charge_id || personalCharge && personalCharge.item_id === item.id && personalCharge.employee_email === tx.employee_email && personalCharge.claim_id === claim.id && personalCharge.transaction_on === item.spent_on && personalCharge.descriptor === item.merchant && personalCharge.amount_minor === item.amount_minor && personalCharge.currency === tx.currency, 'The personal card custody changed',409);
  const sourceCharge = charge ?? personalCharge;
  const originals=sourceCharge?await rows(db,'SELECT * FROM c_plaid_sources WHERE id=?',sourceCharge.file_id):await rows(db,`SELECT s.* FROM c_plaid_sources s WHERE s.id IN (
    SELECT new_source_id FROM c_plaid_corrections WHERE new_item_id=?
    UNION SELECT s2.id FROM c_plaid_sources s2 JOIN c_events e ON e.action='plaid-expense-created'
      AND json_extract(e.detail,'$.connection')=s2.connection_id AND json_extract(e.detail,'$.transaction')=s2.transaction_id
      WHERE json_extract(e.detail,'$.item')=? AND NOT EXISTS(SELECT 1 FROM c_plaid_corrections cr WHERE cr.new_source_id=s2.id))`,item.id,item.id);
  requireThat(originals.length===1,'The original source is ambiguous; reconcile separately',409);
  const source=originals[0], oldFacts=JSON.parse(new TextDecoder().decode(new Uint8Array(source.bytes))), mapping=JSON.parse(source.mapping);
  requireThat(oldFacts.transaction_id===transaction&&oldFacts.account_id===tx.account_id && (!personalCharge || personalCharge.transaction_id === transaction && personalCharge.connection_id === source.connection_id && personalCharge.posted_on === oldFacts.posted_on && personalCharge.file_id === source.id),'The original source differs; reconcile separately',409);
  const prior=await priorExpense(db,item); pristine(prior,oldFacts,mapping,charge,personalCharge);
  const history=neverSubmitted(item.id,charge?.id??null);
  requireThat(await db.prepare(`SELECT 1 WHERE ${history.sql}`).bind(...history.params).first(),'An expense appearing in any submitted revision needs separate reconciliation',409);
  const removed=change.kind==='removed', current=JSON.parse(change.facts) as Transaction;
  requireThat(removed || change.kind==='modified'&&current.pending===false&&current.amount_minor>0&&factsFields.every(k=>equal(tx[k],(current as unknown as Data)[k])),
    'Only a posted positive purchase replacement or provider removal can be reconciled here',409);
  const card=charge?await db.prepare('SELECT * FROM c_cards WHERE id=?').bind(charge.card_id).first<Data>():null;
  const verified=(JSON.parse(c.accounts) as Data[]).find(a=>a.id===tx.account_id);
  requireThat(verified && (!charge || card && card.last4===verified.last4 && card.employee_email===tx.employee_email) && (!personalCharge || personalCharge.last4===verified.last4),'The verified card custody changed',409);
  const closed:Sql={sql:'NOT EXISTS(SELECT 1 FROM c_card_statements WHERE card_id=? AND closed_at IS NOT NULL AND period_end>=?)',params:[charge?.card_id??'', [oldFacts.spent_on,oldFacts.posted_on,...(removed?[]:[current.spent_on,current.posted_on])].sort()[0]]};
  requireThat(await db.prepare(`SELECT 1 WHERE ${closed.sql}`).bind(...closed.params).first(),'A closed card period needs separate reconciliation',409);
  const clean:Sql={sql:`NOT EXISTS(SELECT 1 FROM c_batch_claims WHERE claim_id=?) AND NOT EXISTS(SELECT 1 FROM c_events WHERE action IN ('expense-changed','receipt-added') AND json_extract(detail,'$.item')=?) AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE item_id=? AND kind IN ('attached','detached'))`,params:[claim.id,item.id,item.id]};
  requireThat(await db.prepare(`SELECT 1 WHERE ${clean.sql}`).bind(...clean.params).first(),'A submitted, batched or human-edited expense needs separate reconciliation',409);
  const soleSource:Sql={sql:'NOT EXISTS(SELECT 1 FROM c_plaid_transactions WHERE item_id=? AND (connection_id<>? OR transaction_id<>?))',params:[item.id,id,transaction]};
  requireThat(await db.prepare(`SELECT 1 WHERE ${soleSource.sql}`).bind(...soleSource.params).first(),'A shared reconnected source needs separate reconciliation',409);
  const auth=all(access,c.scope==='company'?authority(actor,'owner'):authority(actor,'employee'),{sql:'EXISTS(SELECT 1 FROM c_plaid_settings WHERE id=1 AND version=?)',params:[settings.version]});
  const guards:Sql[]=[history,closed,clean,soleSource,claimState(claim.id,body.version,['draft','returned']),unchanged('c_items',item),unchanged('c_plaid_transactions',tx),unchanged('c_plaid_sync_state',sync),unchanged('c_plaid_assignments',assignment),unchanged('c_auto_coding_contexts',prior.contexts[0]),
    {sql:'(SELECT MAX(seq) FROM c_plaid_changes WHERE connection_id=? AND transaction_id=?)=? AND NOT EXISTS(SELECT 1 FROM c_plaid_corrections WHERE connection_id=? AND transaction_id=? AND change_seq=?)',params:[id,transaction,change.seq,id,transaction,change.seq]},
    {sql:`EXISTS(SELECT 1 FROM c_members m WHERE m.email=? AND m.active=1 AND m.is_employee=1 AND ${notDeactivated('m.email')})`,params:[tx.employee_email]},
    {sql:'EXISTS(SELECT 1 FROM c_business WHERE id=1 AND currency=?)',params:[tx.currency]},
    {sql:'(SELECT COUNT(*) FROM c_allocations WHERE item_id=?)=1',params:[item.id]},unchanged('c_allocations',prior.allocations[0])];
  guards.push(unchanged('c_plaid_connections',c as unknown as Data));
  if(card) guards.push(unchanged('c_cards',card));
  if(personalCharge) guards.push(unchanged('c_plaid_personal_charges',personalCharge));
  guards.push({sql: "(SELECT COUNT(*) FROM c_auto_coding_contexts WHERE target_kind='item' AND target_id=?)=? AND (SELECT COUNT(*) FROM c_auto_coding_suggestions WHERE target_kind='item' AND target_id=?)=? AND NOT EXISTS(SELECT 1 FROM c_auto_coding_feedback f JOIN c_auto_coding_suggestions s ON s.id=f.suggestion_id WHERE s.target_kind='item' AND s.target_id=?) AND NOT EXISTS(SELECT 1 FROM c_auto_coding_observations WHERE target_kind='item' AND target_id=?)", params:[item.id,prior.contexts.length,item.id,prior.suggestions.length,item.id,item.id]});
  if (prior.suggestions.length) guards.push({sql:`NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM c_auto_coding_suggestions s WHERE ${Object.keys(prior.suggestions[0]).map(k=>`s.${k} IS json_extract(expected.value,'$.${k}')`).join(' AND ')}))`,params:[JSON.stringify(prior.suggestions)]});
  const at=now(), writes:D1PreparedStatement[]=[];
  let replacement:{item:string;charge:string|null;source:string}|null=null;
  // A correction has a new immutable card identity; the original exact transaction key remains reserved forever.
  if(!removed){
    const held:Held={id:transaction,cardId:assignment.card_id??'',employee:tx.employee_email,date:current.spent_on,row:{line:1,last4:verified.last4,key:`${transaction}:correction:${change.seq}`,kind:'purchase',postedOn:current.posted_on,transactionOn:current.spent_on,descriptor:current.merchant,memo:'',amountMinor:current.amount_minor,signed:current.amount_minor,currency:current.currency,originalCurrency:'',originalMinor:null,pending:false,problems:[]}};
    const made=await plaidExpense(db,actor,id,c.scope,current,assignment,held,claim.id,item.position);
    guards.push(made.guard); writes.push(...made.statements);
    // plaidExpense keeps its generated source private; its INSERT is authoritative and the charge/item select resolves it atomically.
    replacement={item:made.item,charge:made.charge,source:''};
    if(sourceCharge) writes.push(db.prepare(`INSERT INTO c_card_match_rejections(receipt_id,charge_id,transaction_key,sequence)
      SELECT r.receipt_id,n.id,n.transaction_key,r.sequence FROM c_card_match_rejections r JOIN c_receipt_card_charges n ON n.item_id=? WHERE r.charge_id=? OR r.transaction_key=?`).bind(made.item,sourceCharge.id,sourceCharge.transaction_key));
  }
  const sourceExpression=replacement?.charge?'(SELECT file_id FROM c_card_charges WHERE id=?)':replacement?'(SELECT file_id FROM c_receipt_card_charges WHERE item_id=?)':'NULL';
  const sourceParams=replacement?.charge?[replacement.charge]:replacement?[replacement.item]:[];
  writes.push(db.prepare(`INSERT INTO c_plaid_corrections(connection_id,transaction_id,change_seq,scope,employee_email,claim_id,claim_version,old_source_id,old_item_id,old_charge_id,new_source_id,new_item_id,new_charge_id,reason,consent,prior_snapshot,actor_email,at)
    VALUES(?,?,?,?,?,?,?,?,?,?,${sourceExpression},?,?,?,?,?,?,?)`).bind(id,transaction,change.seq,c.scope,tx.employee_email,claim.id,claim.version,source.id,item.id,charge?.id??null,...sourceParams,replacement?.item??null,replacement?.charge??null,removed?'provider-removal':'provider-replacement',1,JSON.stringify(prior),actor.email,at),
    db.prepare('DELETE FROM c_allocations WHERE item_id=?').bind(item.id),db.prepare('DELETE FROM c_items WHERE id=?').bind(item.id),
    db.prepare('UPDATE c_plaid_transactions SET item_id=?,charge_id=?,updated_at=? WHERE item_id=? AND connection_id=? AND transaction_id=? AND scope=?').bind(replacement?.item??null,replacement?.charge??null,at,item.id,id,transaction,c.scope),
    claimTotal(db,claim.id),event(db,actor,'plaid-source-corrected',{claim:claim.id},{connection:id,transaction,changeSeq:change.seq,oldSource:source.id,oldItem:item.id,oldCharge:charge?.id??null,newItem:replacement?.item??null,newCharge:replacement?.charge??null,reason:removed?'provider-removal':'provider-replacement',consent:true,scope:c.scope,channel:'app'}));
  const condition=all(auth,...guards);
  requireThat(condition.params.length<=100,'The correction guard exceeds the database binding limit; no changes were made',409);
  await commit(db,condition,writes);
  return {transaction,changeSeq:change.seq,claim:claim.id,version:claim.version+1,item:replacement?.item??null,charge:replacement?.charge??null,reason:removed?'provider-removal':'provider-replacement'};
}
