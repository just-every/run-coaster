import type { Bindings } from '../../auth.server';
import { all, commit, notDeactivated, type Sql } from '../session';
import { event } from '../events';
import { placements } from '../cards/charges';
import { type Held } from '../cards/plan';
import { normalDescriptor } from '../cards/statement';
import { claimTotal } from '../claims';
import { runCardMatching } from '../receipts/card-matching';
import { now, requireThat, text, type Actor, type Data } from '../types';
import { openPlaid } from './connections';
import { plaidAccess } from './accounts';
import { reservePlaidMonth } from './metering';
import { plaidJson } from './network';
import { plaidExpense } from './expenses';
import { transactionFacts, transactionColumns, type Transaction } from './transactions';

type State = { version: number; cursor: string };
async function check(db: D1Database, guard: Sql) {
  requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(), 'Plaid authority, connection or cursor changed; reload', 409);
}
const sameFacts = (a: Data, b: Transaction) => ['account_id','spent_on','posted_on','merchant','amount_minor','currency'].every(k => a[k] === b[k as keyof Transaction]);

/** Fetch an entire cursor update before committing: a pending removal may precede its posting on another page. */
export async function syncPlaid(env: Bindings, actor: Actor, id: string) {
  const db = env.DB, { connection: c, guard: access } = await plaidAccess(env, actor, id);
  requireThat(c.status === 'connected', 'Verify this connection before syncing', 409);
  const state = await db.prepare('SELECT * FROM c_plaid_sync_state WHERE connection_id=?').bind(id).first<State>() ?? { version: 0, cursor: '' };
  const stable: Sql = { sql: 'COALESCE((SELECT version FROM c_plaid_sync_state WHERE connection_id=?),0)=?', params: [id, state.version] };
  const paid = await reservePlaidMonth(env, actor, c, access);
  const assignments = (await db.prepare('SELECT * FROM c_plaid_assignments WHERE connection_id=? ORDER BY account_id').bind(id).all<Data>()).results;
  requireThat(assignments.length === JSON.parse(c.accounts).length, 'Assign every verified account to an active cardholder and category before syncing', 409);
  const credentials = await openPlaid(env, 'plaid:' + id, c.credentials_sealed);
  const changes: { kind: string; tx?: Transaction; merchants?: string[]; removed?: string }[] = [];
  let cursor = state.cursor, pages = 0, more = true;
  while (more) {
    await check(db, all(paid,stable));
    const page = await plaidJson(credentials, '/transactions/sync', { ...(cursor ? { cursor } : {}), count: 100 });
    requireThat(Array.isArray(page.added) && Array.isArray(page.modified) && Array.isArray(page.removed) && typeof page.has_more === 'boolean', 'Plaid returned an incomplete sync page', 502);
    const next = text(page.next_cursor, 'Plaid next cursor', 2000);
    requireThat(!page.has_more || next !== cursor, 'Plaid did not advance its sync cursor', 502);
    for (const kind of ['added', 'modified'] as const) for (const raw of page[kind]) changes.push({ kind, tx: transactionFacts(raw), merchants: [raw.name,raw.merchant_name].filter((value): value is string=>typeof value==='string'&&value.length>0).map(normalDescriptor) });
    for (const raw of page.removed) changes.push({ kind: 'removed', removed: text(raw.transaction_id, 'Removed transaction id', 200) });
    requireThat(changes.length <= 150 && ++pages <= 20, 'This sync update exceeds the bounded import size; no cursor or expense was committed', 409);
    cursor = next; more = page.has_more;
  }
  const current = new Map((await db.prepare('SELECT * FROM c_plaid_transactions WHERE connection_id=?').bind(id).all<Data>()).results.map(t => [t.transaction_id, t]));
  const writes: D1PreparedStatement[] = [], guards: Sql[] = [paid, stable];
  const planned = new Map<string, Data>(), at = now();
  let added = 0, modified = 0, removed = 0, expenses = 0;
  // Apply facts first, then removals, so pending ids can be linked regardless of their page order.
  for (const change of changes.filter(v => v.tx)) {
    const tx = change.tx!, assignment = assignments.find(a => a.account_id === tx.account_id);
    requireThat(assignment, 'Plaid returned an account outside the verified assignments; nothing was committed', 409);
    requireThat(tx.currency === (await db.prepare('SELECT currency FROM c_business WHERE id=1').first<{currency:string}>())?.currency, 'Plaid transaction currency differs from the business currency; no partial cursor was committed', 409);
    guards.push({ sql: `EXISTS(SELECT 1 FROM c_plaid_assignments a JOIN c_members m ON m.email=a.employee_email WHERE a.connection_id=? AND a.account_id=? AND a.employee_email=? AND a.category_id=? AND m.active=1 AND m.is_employee=1 AND ${notDeactivated('m.email')})`, params: [id, tx.account_id, assignment.employee_email, assignment.category_id] });
    const foreign = await db.prepare('SELECT * FROM c_plaid_transactions WHERE transaction_id=? AND connection_id<>? AND item_id IS NOT NULL LIMIT 1').bind(tx.transaction_id,id).first<Data>();
    requireThat(!foreign || foreign.account_id===tx.account_id && foreign.employee_email===assignment.employee_email && foreign.scope===c.scope, 'This transaction already has different financial custody; reconcile before syncing',409);
    const previous = current.get(tx.transaction_id) ?? foreign;
    if (previous && previous.connection_id===id && sameFacts(previous, tx) && ((tx.pending && previous.status === 'pending') || (!tx.pending && previous.status !== 'pending' && previous.status !== 'removed'))) continue;
    const pending = tx.pending_transaction_id ? current.get(tx.pending_transaction_id) : null;
    requireThat(!pending || pending.account_id === tx.account_id, 'A pending transaction changed account; reconcile it explicitly', 409);
    const item = previous?.item_id ?? pending?.item_id ?? null, charge = previous?.charge_id ?? pending?.charge_id ?? null;
    const row: Data = { ...tx, connection_id: id, employee_email: assignment.employee_email, scope: c.scope, item_id: item, charge_id: charge, updated_at: at,
      status: item ? previous && sameFacts(previous, tx) ? previous.status : 'review' : tx.pending ? 'pending' : tx.amount_minor <= 0 ? 'credit' : 'posted' };
    if (!tx.pending && tx.amount_minor > 0 && !item) {
      const history = (await db.prepare("SELECT value FROM c_history WHERE kind='expense' AND json_extract(value,'$.employee')=? AND json_extract(value,'$.date')=? AND json_extract(value,'$.amountMinor')=?").bind(assignment.employee_email, tx.spent_on, tx.amount_minor).all<{value:string}>()).results;
      const overlap = history.some(h => (change.merchants??[normalDescriptor(tx.merchant)]).includes(normalDescriptor(JSON.parse(h.value).merchant)));
      const native = (await db.prepare('SELECT id,item_id,descriptor FROM c_card_charges WHERE employee_email=? AND COALESCE(transaction_on,posted_on)=? AND amount_minor=?').bind(assignment.employee_email, tx.spent_on, tx.amount_minor).all<Data>()).results.find(ch => (change.merchants??[normalDescriptor(tx.merchant)]).includes(normalDescriptor(ch.descriptor)));
      if (overlap || native) { row.status = 'overlap'; row.charge_id = native?.id ?? null; row.item_id = native?.item_id ?? null; }
      else {
        planned.set(tx.transaction_id, assignment);
      }
    }
    current.set(tx.transaction_id, row);
    writes.push(db.prepare('INSERT INTO c_plaid_changes(connection_id,transaction_id,kind,facts,at) VALUES(?,?,?,?,?)').bind(id, tx.transaction_id, change.kind, JSON.stringify(tx), at));
    change.kind === 'added' ? added++ : modified++;
  }
  for (const change of changes.filter(v => v.removed)) {
    const previous = current.get(change.removed!);
    if (!previous || previous.status === 'removed' || previous.status === 'review') continue;
    previous.status = previous.item_id && previous.status !== 'overlap' ? 'review' : 'removed'; previous.updated_at = at;
    writes.push(db.prepare("INSERT INTO c_plaid_changes(connection_id,transaction_id,kind,facts,at) VALUES(?,?,'removed',?,?)").bind(id, change.removed, JSON.stringify({ transaction_id: change.removed, status: previous.status }), at)); removed++;
  }
  const held: Held[] = [], newRows: Data[] = [];
  for(const [transaction,assignment] of planned) {
    const row=current.get(transaction)!;
    if(row.status!=='posted'||row.item_id)continue;
    const verified=(JSON.parse(c.accounts) as Data[]).find(a=>a.id===row.account_id)!;
    guards.push({sql:'NOT EXISTS(SELECT 1 FROM c_plaid_transactions WHERE transaction_id=? AND item_id IS NOT NULL)',params:[transaction]});
    if(assignment.card_id) guards.push({sql:'EXISTS(SELECT 1 FROM c_cards WHERE id=? AND employee_email=? AND last4=?)',params:[assignment.card_id,assignment.employee_email,verified.last4]});
    held.push({id:transaction,cardId:assignment.card_id??'',employee:assignment.employee_email,date:row.spent_on,row:{line:1,last4:verified.last4,key:transaction,kind:'purchase',postedOn:row.posted_on,transactionOn:row.spent_on,descriptor:row.merchant,memo:'',amountMinor:row.amount_minor,signed:row.amount_minor,currency:row.currency,originalCurrency:'',originalMinor:null,pending:false,problems:[]}});
    newRows.push(row);
  }
  const place = await placements(db, held, 'Plaid', null);
  writes.push(...place.statements); guards.push(...place.guards);
  for (const row of newRows) {
    const assignment = assignments.find(a => a.account_id === row.account_id)!, [claim, position] = place.where.get(row.transaction_id)!.split('|');
    const result = await plaidExpense(db, actor, id, c.scope, row as Transaction, assignment, held.find(h => h.id === row.transaction_id)!, claim, Number(position));
    row.item_id = result.item; row.charge_id = result.charge; writes.push(...result.statements); guards.push(result.guard); expenses++;
    writes.push(event(db, actor, 'plaid-expense-created', { claim }, { connection: id, transaction: row.transaction_id, item: row.item_id, scope: c.scope, reimbursable: c.scope === 'personal', channel: 'app' }));
  }
  for (const row of current.values()) {
    if (row.updated_at !== at) continue;
    writes.push(db.prepare(`INSERT INTO c_plaid_transactions(${transactionColumns}) VALUES(${transactionColumns.split(',').map(() => '?').join(',')}) ON CONFLICT(connection_id,transaction_id) DO UPDATE SET account_id=excluded.account_id,pending_transaction_id=excluded.pending_transaction_id,status=excluded.status,spent_on=excluded.spent_on,posted_on=excluded.posted_on,merchant=excluded.merchant,amount_minor=excluded.amount_minor,currency=excluded.currency,item_id=excluded.item_id,charge_id=excluded.charge_id,updated_at=excluded.updated_at`).bind(...transactionColumns.split(',').map(k => row[k] ?? null)));
  }
  for (const claim of place.claims.keys()) writes.push(claimTotal(db, claim));
  writes.push(db.prepare('INSERT INTO c_plaid_sync_state(connection_id,version,cursor,last_sync_at) VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET version=excluded.version,cursor=excluded.cursor,last_sync_at=excluded.last_sync_at').bind(id, state.version + 1, cursor, at), event(db, actor, 'plaid-synced', {}, { connection: id, scope: c.scope, added, modified, removed, expenses, pages, channel: 'app' }));
  await commit(db, all(paid, ...[...new Map(guards.map(g => [JSON.stringify(g), g])).values()]), writes);
  await runCardMatching(db, new Date());
  return { added, modified, removed, expenses, cursor };
}
