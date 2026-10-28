import type { Bindings } from '../../auth.server';
import { notDeactivated, type Sql } from '../session';
import { event } from '../events';
import { placements } from '../cards/charges';
import { type Held } from '../cards/plan';
import { normalDescriptor } from '../cards/statement';
import { claimTotal } from '../claims';
import { now, requireThat, type Actor, type Data } from '../types';
import type { Connection } from './connections';
import { plaidExpense } from './expenses';
import { transactionColumns, type Transaction } from './transactions';
import type { Change } from './pages';

const sameFacts = (a: Data, b: Transaction) => ['account_id','spent_on','posted_on','merchant','amount_minor','provider_amount','currency'].every(k => a[k] === b[k as keyof Transaction]);

/** Resolve the complete update before any financial write, including cross-page pending removals. */
export async function prepareSync(db: D1Database, c: Connection, assignments: Data[], changes: Change[]) {
  const id = c.id;
  const current = new Map((await db.prepare('SELECT * FROM c_plaid_transactions WHERE connection_id=?').bind(id).all<Data>()).results.map(t => [t.transaction_id, t]));
  const latest = new Map((await db.prepare('SELECT transaction_id,kind FROM c_plaid_changes WHERE connection_id=? ORDER BY seq').bind(id).all<{transaction_id:string;kind:string}>()).results.map(row=>[row.transaction_id,row.kind]));
  const audit = new Map<string, D1PreparedStatement[]>(), dirty = new Set<string>();
  const record = (id: string, statement: D1PreparedStatement) => { audit.set(id, [...(audit.get(id) ?? []), statement]); dirty.add(id); };
  const planned = new Map<string, Data>(), at = now();
  const currency = (await db.prepare('SELECT currency FROM c_business WHERE id=1').first<{currency:string}>())?.currency;
  let added = 0, modified = 0, removed = 0;
  // Apply facts first, then removals, so pending ids can be linked regardless of their page order.
  for (const change of changes.filter(v => v.tx)) {
    const tx = change.tx!, assignment = assignments.find(a => a.account_id === tx.account_id);
    requireThat(assignment, 'Plaid returned an account outside the verified assignments; nothing was committed', 409);
    requireThat(tx.currency === currency, 'Plaid transaction currency differs from the business currency; no partial cursor was committed', 409);
    const foreign = await db.prepare('SELECT * FROM c_plaid_transactions WHERE transaction_id=? AND connection_id<>? AND item_id IS NOT NULL LIMIT 1').bind(tx.transaction_id,id).first<Data>();
    requireThat(!foreign || foreign.account_id===tx.account_id && foreign.employee_email===assignment.employee_email && foreign.scope===c.scope, 'This transaction already has different financial custody; reconcile before syncing',409);
    const previous = current.get(tx.transaction_id) ?? foreign;
    if (previous && previous.connection_id===id && sameFacts(previous, tx) && ((tx.pending && previous.status === 'pending') || (!tx.pending && previous.status !== 'pending' && previous.status !== 'removed' && latest.get(tx.transaction_id)!=='removed'))) continue;
    const pending = tx.pending_transaction_id ? current.get(tx.pending_transaction_id) : null;
    requireThat(!pending || pending.account_id === tx.account_id, 'A pending transaction changed account; reconcile it explicitly', 409);
    const item = previous?.item_id ?? pending?.item_id ?? null, charge = previous?.charge_id ?? pending?.charge_id ?? null;
    const row: Data = { ...tx, connection_id: id, employee_email: assignment.employee_email, scope: c.scope, item_id: item, charge_id: charge, updated_at: at,
      status: item ? previous && sameFacts(previous, tx) ? previous.status : 'review' : tx.pending ? 'pending' : tx.amount_minor <= 0 ? 'credit' : 'posted' };
    const retired=await db.prepare("SELECT 1 FROM c_plaid_corrections WHERE transaction_id=? AND reason='provider-removal'").bind(tx.transaction_id).first();
    if(retired&&!item)row.status='review';
    if (!tx.pending && tx.amount_minor > 0 && !item && !retired) {
      const history = (await db.prepare("SELECT value FROM c_history WHERE kind='expense' AND json_extract(value,'$.employee')=? AND json_extract(value,'$.date')=? AND json_extract(value,'$.amountMinor')=?").bind(assignment.employee_email, tx.spent_on, tx.amount_minor).all<{value:string}>()).results;
      const overlap = history.some(h => (change.merchants??[normalDescriptor(tx.merchant)]).includes(normalDescriptor(JSON.parse(h.value).merchant)));
      const native = (await db.prepare('SELECT id,item_id,descriptor FROM c_card_effective_charges WHERE employee_email=? AND COALESCE(transaction_on,posted_on)=? AND amount_minor=?').bind(assignment.employee_email, tx.spent_on, tx.amount_minor).all<Data>()).results.find(ch => (change.merchants??[normalDescriptor(tx.merchant)]).includes(normalDescriptor(ch.descriptor)));
      if (overlap || native) { row.status = 'overlap'; row.charge_id = native?.id ?? null; row.item_id = native?.item_id ?? null; }
      else {
        planned.set(tx.transaction_id, assignment);
      }
    }
    current.set(tx.transaction_id, row);
    record(tx.transaction_id, db.prepare('INSERT INTO c_plaid_changes(connection_id,transaction_id,kind,facts,at) VALUES(?,?,?,?,?)').bind(id, tx.transaction_id, change.kind, JSON.stringify(tx), at));
    latest.set(tx.transaction_id,change.kind);
    change.kind === 'added' ? added++ : modified++;
  }
  for (const change of changes.filter(v => v.removed)) {
    const previous = current.get(change.removed!);
    if (!previous || previous.status === 'removed' || latest.get(change.removed!)==='removed') continue;
    previous.status = previous.item_id && previous.status !== 'overlap' ? 'review' : 'removed'; previous.updated_at = at;
    record(change.removed!, db.prepare("INSERT INTO c_plaid_changes(connection_id,transaction_id,kind,facts,at) VALUES(?,?,'removed',?,?)").bind(id, change.removed, JSON.stringify({ transaction_id: change.removed, status: previous.status }), at)); latest.set(change.removed!,'removed'); removed++;
  }
  return { rows: [...dirty].map(key => current.get(key)!), audit, planned, added, modified, removed, currency };
}

/** Each batch independently places expenses against the reports that are durable now. */
export async function financialBatch(env: Bindings, actor: Actor, c: Connection, assignments: Data[], plan: Awaited<ReturnType<typeof prepareSync>>, rows: Data[]) {
  const db = env.DB, id = c.id, writes: D1PreparedStatement[] = [], guards: Sql[] = [];
  let expenses = 0;
  const custody = new Map<string, Data>();
  for (const row of rows) {
    const assignment = assignments.find(a => a.account_id === row.account_id);
    requireThat(assignment, 'The source account assignment is missing; reconcile before syncing', 409);
    custody.set(row.account_id, assignment);
    writes.push(...(plan.audit.get(row.transaction_id) ?? []));
  }
  guards.push({ sql: `NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(
    SELECT 1 FROM c_plaid_assignments a JOIN c_members m ON m.email=a.employee_email
    WHERE a.connection_id=? AND a.account_id=json_extract(expected.value,'$.account_id')
    AND a.employee_email=json_extract(expected.value,'$.employee_email') AND a.category_id=json_extract(expected.value,'$.category_id')
    AND a.card_id IS json_extract(expected.value,'$.card_id') AND m.active=1 AND m.is_employee=1 AND ${notDeactivated('m.email')}))`,
    params: [JSON.stringify([...custody.values()]), id] });
  guards.push({ sql: 'EXISTS(SELECT 1 FROM c_business WHERE id=1 AND currency=?)', params: [plan.currency] });
  const held: Held[] = [], newRows: Data[] = [];
  for (const row of rows) {
    const transaction = row.transaction_id, assignment = assignments.find(a => a.account_id === row.account_id)!;
    if (!plan.planned.has(transaction)) continue;
    if(row.status!=='posted'||row.item_id)continue;
    const verified=(JSON.parse(c.accounts) as Data[]).find(a=>a.id===row.account_id)!;
    if(assignment.card_id) guards.push({sql:'EXISTS(SELECT 1 FROM c_cards WHERE id=? AND employee_email=? AND last4=?)',params:[assignment.card_id,assignment.employee_email,verified.last4]});
    held.push({id:transaction,cardId:assignment.card_id??'',employee:assignment.employee_email,date:row.spent_on,row:{line:1,last4:verified.last4,key:transaction,kind:'purchase',postedOn:row.posted_on,transactionOn:row.spent_on,descriptor:row.merchant,memo:'',amountMinor:row.amount_minor,signed:row.amount_minor,currency:row.currency,originalCurrency:'',originalMinor:null,pending:false,problems:[]}});
    newRows.push(row);
  }
  guards.push({ sql: 'NOT EXISTS(SELECT 1 FROM c_plaid_transactions WHERE item_id IS NOT NULL AND transaction_id IN (SELECT value FROM json_each(?)))', params: [JSON.stringify(newRows.map(r => r.transaction_id))] });
  const place = await placements(db, held, 'Plaid', null);
  writes.push(...place.statements); guards.push(...place.guards);
  for (const row of newRows) {
    const assignment = assignments.find(a => a.account_id === row.account_id)!, [claim, position] = place.where.get(row.transaction_id)!.split('|');
    const result = await plaidExpense(db, actor, id, c.scope, row as Transaction, assignment, held.find(h => h.id === row.transaction_id)!, claim, Number(position));
    row.item_id = result.item; row.charge_id = result.charge; writes.push(...result.statements); guards.push(result.guard); expenses++;
    writes.push(event(db, actor, 'plaid-expense-created', { claim }, { connection: id, transaction: row.transaction_id, item: row.item_id, scope: c.scope, reimbursable: c.scope === 'personal', channel: 'app' }));
  }
  for (const row of rows) {
    writes.push(db.prepare(`INSERT INTO c_plaid_transactions(${transactionColumns}) VALUES(${transactionColumns.split(',').map(() => '?').join(',')}) ON CONFLICT(connection_id,transaction_id) DO UPDATE SET account_id=excluded.account_id,pending_transaction_id=excluded.pending_transaction_id,status=excluded.status,spent_on=excluded.spent_on,posted_on=excluded.posted_on,merchant=excluded.merchant,amount_minor=excluded.amount_minor,provider_amount=excluded.provider_amount,currency=excluded.currency,item_id=excluded.item_id,charge_id=excluded.charge_id,updated_at=excluded.updated_at`).bind(...transactionColumns.split(',').map(k => row[k] ?? null)));
  }
  for (const claim of place.claims.keys()) writes.push(claimTotal(db, claim));
  return { writes, guards, expenses };
}
