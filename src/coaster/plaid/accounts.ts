import type { Bindings } from '../../auth.server';
import { all, commit, type Sql } from '../session';
import { event } from '../events';
import { email, now, requireThat, text, uid, type Actor, type Data } from '../types';
import { categoryFor } from '../cards/plan';
import { plaidPermission, type Connection } from './connections';

/** Every provider operation fences the exact installation custody as well as current native authority. */
export async function plaidAccess(env: Bindings, actor: Actor, id: string) {
  const connection = await env.DB.prepare('SELECT * FROM c_plaid_connections WHERE id=?').bind(id).first<Connection>();
  requireThat(connection, 'Plaid connection not found; restored history cannot execute provider requests', 404);
  requireThat(connection.scope !== 'personal' || connection.personal_email === actor.email && !actor.delegate, 'Only the personal cardholder can access this connection', 403);
  const auth = await plaidPermission(env, actor, connection.scope);
  const guard = all(auth, { sql: 'EXISTS(SELECT 1 FROM c_plaid_connections WHERE id=? AND credentials_sealed=? AND status=?)', params: [id, connection.credentials_sealed, connection.status] });
  return { connection, guard };
}
export async function assignPlaidAccount(env: Bindings, actor: Actor, id: string, body: Data) {
  const { connection: c, guard } = await plaidAccess(env, actor, id);
  requireThat(c.status === 'connected', 'Finish verifying this connection first', 409);
  const account = text(body.account, 'Verified Plaid account', 200);
  const verified = (JSON.parse(c.accounts) as Data[]).find(a => a.id === account);
  requireThat(verified, 'Choose an account verified on this connection', 409);
  const employee = email(body.employee, 'Cardholder');
  requireThat(c.scope !== 'personal' || employee === actor.email, 'A personal account belongs only to its cardholder', 403);
  const member: Sql = { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1)', params: [employee] };
  requireThat(await env.DB.prepare(`SELECT 1 WHERE ${member.sql}`).bind(...member.params).first(), 'Assign an active employee', 409);
  const category = await categoryFor(env.DB, body.category), previous = await env.DB.prepare('SELECT * FROM c_plaid_assignments WHERE connection_id=? AND account_id=?').bind(id, account).first<Data>();
  requireThat(!previous || previous.employee_email === employee && previous.category_id === category.id, 'An account assignment is fixed while connected; disconnect before changing its custody or default category', 409);
  if (previous) return { account, employee, category: category.id };
  const at = now(), writes: D1PreparedStatement[] = [], guards: Sql[] = [guard, member, { sql: 'NOT EXISTS(SELECT 1 FROM c_plaid_assignments WHERE connection_id=? AND account_id=?)', params: [id, account] }];
  let card: string | null = null;
  if (c.scope === 'company') {
    if (body.card) {
      const known = await env.DB.prepare('SELECT id FROM c_cards WHERE id=? AND last4=? AND employee_email=?').bind(body.card, verified.last4, employee).first<{id:string}>();
      requireThat(known, 'The assigned company card must have the verified last four and cardholder', 409); card = known.id;
      guards.push({ sql: 'EXISTS(SELECT 1 FROM c_cards WHERE id=? AND last4=? AND employee_email=?)', params: [card, verified.last4, employee] });
    } else {
      card = uid();
      writes.push(env.DB.prepare('INSERT INTO c_cards(id,issuer,last4,employee_email,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)').bind(card, 'Plaid ' + id.slice(0, 12), verified.last4, employee, actor.delegate?.email ?? actor.email, at));
    }
  }
  writes.push(env.DB.prepare('INSERT INTO c_plaid_assignments VALUES(?,?,?,?,?,?,?)').bind(id, account, employee, category.id, card, actor.delegate?.email ?? actor.email, at), event(env.DB, actor, 'plaid-account-assigned', {}, { connection: id, account, last4: verified.last4, employee, category: category.id, scope: c.scope, channel: 'app' }));
  await commit(env.DB, all(...guards as [Sql, ...Sql[]]), writes);
  return { account, employee, category: category.id };
}
export async function plaidTransactions(env: Bindings, actor: Actor, id: string) {
  await plaidAccess(env, actor, id);
  return { transactions: (await env.DB.prepare('SELECT transaction_id,account_id,status,spent_on,posted_on,merchant,amount_minor,currency,item_id FROM c_plaid_transactions WHERE connection_id=? ORDER BY spent_on DESC,transaction_id').bind(id).all()).results };
}
