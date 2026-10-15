import { operatorAuth, runtimeBindings, type Bindings } from '../auth.server';
import { Fault, requireThat, type Actor, type Roles } from './types';

export type Sql = { sql: string; params: unknown[]; after?: Sql };
type Role = 'employee' | 'manager' | 'finance' | 'owner';

const memberColumn: Record<Exclude<Role, 'owner'>, string> = { employee: 'is_employee', manager: 'is_manager', finance: 'is_finance' };

async function memberRoles(db: D1Database, address: string, owner: boolean): Promise<{ roles: Roles; name?: string }> {
  const member = await db.prepare('SELECT name,is_employee,is_manager,is_finance FROM c_members WHERE email=? AND active=1').bind(address).first<{ name: string; is_employee: number; is_manager: number; is_finance: number }>();
  if (owner) return { roles: { owner: true, employee: true, manager: true, finance: true }, name: member?.name };
  return { roles: { owner: false, employee: member?.is_employee === 1, manager: member?.is_manager === 1, finance: member?.is_finance === 1 }, name: member?.name };
}

/** The signed-in person, from the native session only. Writes also need a same-origin request. */
export async function person(request: Request, original: Bindings): Promise<Actor> {
  const env = runtimeBindings(original);
  requireThat(new URL(request.url).origin === env.AUTH_ORIGIN, 'Invalid host', 403);
  if (!['GET', 'HEAD'].includes(request.method))
    requireThat(request.headers.get('origin') === env.AUTH_ORIGIN && request.headers.get('sec-fetch-site') !== 'cross-site', 'Invalid origin', 403);
  const session = await operatorAuth(env).getSession(request);
  requireThat(session, 'Sign in required', 401);
  const address = session.operator.email.toLowerCase(), owner = session.operator.role === 'owner';
  const { roles, name } = await memberRoles(env.DB, address, owner);
  requireThat(roles.owner || roles.employee || roles.manager || roles.finance, 'Ask the owner to add you to Coaster', 403);
  return { kind: 'person', email: address, name: name ?? session.operator.displayName, roles, operatorId: session.operator.id, session: session.id };
}

export const sha256Hex = async (bytes: Uint8Array | string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes) as BufferSource))].map(b => b.toString(16).padStart(2, '0')).join('');

/** A key acts only while the person who made it can still sign in: deactivating their account stops it at once. */
const activeAccount = "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=k.member_email AND o.status='active')";

/** An agent key from `Authorization: Bearer`, acting for the person who made it. */
export async function agent(request: Request, original: Bindings): Promise<Actor> {
  const env = runtimeBindings(original);
  const header = request.headers.get('authorization') ?? '';
  requireThat(header.startsWith('Bearer cst_'), 'Agent key required', 401);
  const key = await env.DB.prepare(`SELECT k.id,k.label,k.member_email,m.name FROM c_agent_keys k JOIN c_members m ON m.email=k.member_email AND m.active=1 WHERE k.token_hash=? AND k.revoked_at IS NULL AND ${activeAccount}`).bind(await sha256Hex(header.slice(7))).first<{ id: string; label: string; member_email: string; name: string }>();
  requireThat(key, 'Agent key is unknown or revoked', 401);
  const { roles } = await memberRoles(env.DB, key.member_email, false);
  return { kind: 'agent', email: key.member_email, name: key.name, roles: { ...roles, owner: false }, keyId: key.id, agentLabel: key.label };
}

/** SQL that is true only while this actor's authority (and the role, if named) still holds. */
export function authority(actor: Actor, role?: Role): Sql {
  if (actor.kind === 'agent') {
    const roleCheck = role && role !== 'owner' ? ` AND m.${memberColumn[role]}=1` : role === 'owner' ? ' AND 0' : '';
    return { sql: `EXISTS(SELECT 1 FROM c_agent_keys k JOIN c_members m ON m.email=k.member_email AND m.active=1 WHERE k.id=? AND k.revoked_at IS NULL AND ${activeAccount}${roleCheck})`, params: [actor.keyId] };
  }
  const session = 'EXISTS(SELECT 1 FROM oa_sessions se JOIN oa_operators o ON o.id=se.operator_id WHERE se.id=? AND o.id=? AND o.version=se.operator_version AND o.status=\'active\' AND se.revoked_at IS NULL AND se.expires_at>unixepoch()*1000';
  if (!role) return { sql: session + ')', params: [actor.session, actor.operatorId] };
  if (role === 'owner') return { sql: session + " AND o.role='owner')", params: [actor.session, actor.operatorId] };
  return { sql: `${session} AND (o.role='owner' OR EXISTS(SELECT 1 FROM c_members m WHERE m.email=lower(o.email) AND m.active=1 AND m.${memberColumn[role]}=1)))`, params: [actor.session, actor.operatorId] };
}

export function need(actor: Actor, role: Role) {
  requireThat(actor.roles[role], `${role === 'finance' ? 'Finance' : role === 'manager' ? 'Manager' : role === 'owner' ? 'Owner' : 'Employee'} access required`, 403);
}

/** Guard rows bracket a write batch: any false condition aborts every write in it. */
export const guard = (db: D1Database, condition: Sql) => db.prepare(`INSERT INTO c_guard SELECT CASE WHEN (${condition.sql}) THEN 1 ELSE 0 END`).bind(...condition.params);
/** Authority first, then the record state a write was decided on. The state holds before the
 * write; after it only the authority is re-checked, since the write itself moves the state on. */
export const all = (auth: Sql, ...state: Sql[]): Sql => ({ sql: [auth, ...state].map(c => `(${c.sql})`).join(' AND '), params: [auth, ...state].flatMap(c => c.params), after: auth });

export async function commit(db: D1Database, condition: Sql, statements: D1PreparedStatement[]) {
  try {
    await db.batch([guard(db, condition), ...statements, guard(db, condition.after ?? condition), db.prepare('DELETE FROM c_guard')]);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (message.includes('c_guard') || message.includes('CHECK constraint failed: ok = 1')) throw new Fault(409, 'This changed while you were working, or your access changed; reload and try again');
    if (message.includes('c_reimbursement_keys.key')) throw new Fault(409, 'An exact duplicate expense is already in a reimbursement batch');
    if (message.includes('c_batches.number')) throw new Fault(409, 'Another batch was created at the same time; reload and try again');
    if (message.includes('c_batch_claims.claim_id')) throw new Fault(409, 'That claim is already in a reimbursement batch');
    throw error;
  }
}
