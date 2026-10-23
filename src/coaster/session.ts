import { operatorAuth, runtimeBindings, type Bindings } from '../auth.server';
import { accessSnapshot } from './public-api/identity';
import { Fault, requireThat, type Actor, type Roles } from './types';

export type Sql = { sql: string; params: unknown[]; after?: Sql };
export type Role = 'employee' | 'manager' | 'finance' | 'owner' | 'auditor' | 'admin' | 'cardAdmin' | 'bookkeeper';

/** The member columns that give a role. The employee row of the permission matrix (ADMIN-001) lets every role that submits
 * its own expenses (owner, admin, finance, card admin, approver) do so, so any of them is employee-capable. */
const memberColumns: Record<Exclude<Role, 'owner'>, string[]> = { employee: ['is_employee', 'is_admin', 'is_finance', 'is_card_admin', 'is_manager'], manager: ['is_manager'], finance: ['is_finance'], auditor: ['is_auditor'], admin: ['is_admin'], cardAdmin: ['is_card_admin'], bookkeeper: ['is_bookkeeper'] };
/** SQL true while the member row `alias` holds the role. */
export const holds = (role: Exclude<Role, 'owner'>, alias: string) => `(${memberColumns[role].map(c => `${alias}.${c}=1`).join(' OR ')})`;

export type MemberFlags = { is_employee?: number; is_manager?: number; is_finance?: number; is_auditor?: number; is_admin?: number; is_card_admin?: number; is_bookkeeper?: number };
/** Roles from a member row. A delegate's Submit-only access (`full` false) keeps only the employee row (ADMIN-005). */
export function rolesFrom(m: MemberFlags | null | undefined, owner: boolean, full = true): Roles {
  const has = (v: number | undefined) => owner || v === 1, own = (v: number | undefined) => full && has(v);
  const admin = own(m?.is_admin), finance = own(m?.is_finance), cardAdmin = own(m?.is_card_admin), manager = own(m?.is_manager);
  return { owner: full && owner, employee: owner || m?.is_employee === 1 || m?.is_admin === 1 || m?.is_finance === 1 || m?.is_card_admin === 1 || m?.is_manager === 1, manager, finance, auditor: full && !owner && m?.is_auditor === 1, admin, cardAdmin, bookkeeper: own(m?.is_bookkeeper) };
}
async function memberRoles(db: D1Database, address: string, owner: boolean): Promise<{ roles: Roles; name?: string }> {
  const member = await db.prepare('SELECT name,is_employee,is_manager,is_finance,is_auditor,is_admin,is_card_admin,is_bookkeeper FROM c_members WHERE email=? AND active=1').bind(address).first<MemberFlags & { name: string }>();
  return { roles: rolesFrom(member, owner), name: member?.name };
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
  requireThat(Object.values(roles).some(Boolean), 'Ask the owner to add you to Coaster', 403);
  return { kind: 'person', email: address, name: name ?? session.operator.displayName, roles, operatorId: session.operator.id, session: session.id };
}

export const sha256Hex = async (bytes: Uint8Array | string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes) as BufferSource))].map(b => b.toString(16).padStart(2, '0')).join('');

/** A key acts only while the person who made it can still sign in: deactivating their account stops it at once. */
const activeAccount = "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=k.member_email AND o.status='active')";
/** SQL true unless the sign-in account of `address` (an SQL expression) is deactivated. A delegate acts for someone
 * (ADMIN-005) and a scheduled report reaches them (REPORT-002) only until then; a member added without an account of
 * their own is not refused by it. */
export const notDeactivated = (address: string) => `NOT EXISTS(SELECT 1 FROM oa_operators acct WHERE lower(acct.email)=${address} AND acct.status='inactive')`;

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

/** SQL that is true only while this actor's authority (and one of the roles, if named) still holds; the owner holds every role. */
export function authority(actor: Actor, role?: Role | Role[]): Sql {
  const roles = role === undefined ? [] : Array.isArray(role) ? role : [role], others = roles.filter((r): r is Exclude<Role, 'owner'> => r !== 'owner');
  const ownerOnly = roles.length > 0 && !others.length, orMember = (alias: string) => others.map(r => holds(r, alias)).join(' OR ');
  if (actor.publicCredential) {
    const credential = actor.publicCredential;
    const roleCheck = !roles.length ? '' : ownerOnly ? " AND o.role='owner'" : ` AND (o.role='owner' OR (${orMember('m')}))`;
    const draft = credential.draftClaim ? " AND EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND c.employee_email=k.member_email AND c.status='draft')" : '';
    return { sql: `EXISTS(SELECT 1 FROM c_public_keys k JOIN c_members m ON m.email=k.member_email JOIN oa_operators o ON lower(o.email)=m.email WHERE k.id=? AND k.member_email=? AND k.revoked_at IS NULL AND k.expires_at>unixepoch()*1000 AND m.active=1 AND o.status='active' AND ${accessSnapshot()}=k.access_snapshot AND k.scopes=? AND EXISTS(SELECT 1 FROM json_each(k.scopes) WHERE value=?) AND (k.oauth_client IS NULL OR EXISTS(SELECT 1 FROM c_public_oauth_clients cl WHERE cl.id=k.oauth_client AND cl.revoked_at IS NULL))${roleCheck}${draft})`, params: [credential.id,actor.email,credential.scopes,credential.scope,...(credential.draftClaim ? [credential.draftClaim] : [])] };
  }
  if (actor.kind === 'agent') {
    const roleCheck = roles.length ? (ownerOnly ? ' AND 0' : ` AND (${orMember('m')})`) : '';
    return { sql: `EXISTS(SELECT 1 FROM c_agent_keys k JOIN c_members m ON m.email=k.member_email AND m.active=1 WHERE k.id=? AND k.revoked_at IS NULL AND ${activeAccount}${roleCheck})`, params: [actor.keyId] };
  }
  const session = 'EXISTS(SELECT 1 FROM oa_sessions se JOIN oa_operators o ON o.id=se.operator_id WHERE se.id=? AND o.id=? AND o.version=se.operator_version AND o.status=\'active\' AND se.revoked_at IS NULL AND se.expires_at>unixepoch()*1000';
  if (actor.delegate) {
    // The delegate's own session, their live grant with both people active and the granting person's account not
    // deactivated, and the granting person's role at the grant's level: Submit only covers their own expenses, Full their
    // whole row (the owner's included).
    const owner = "EXISTS(SELECT 1 FROM oa_operators go WHERE lower(go.email)=g.grantor_email AND go.role='owner' AND go.status='active')";
    const level = !roles.length ? '' : roles.length === 1 && roles[0] === 'employee' ? ` AND (${holds('employee', 'gm')} OR ${owner})` : ` AND g.level='full' AND (${[...(others.length ? [orMember('gm')] : []), owner].join(' OR ')})`;
    return { sql: `${session}) AND EXISTS(SELECT 1 FROM c_delegates g JOIN c_members gm ON gm.email=g.grantor_email AND gm.active=1 JOIN c_members dm ON dm.email=g.delegate_email AND dm.active=1 WHERE g.id=? AND g.revoked_at IS NULL AND ${notDeactivated('g.grantor_email')}${level})`, params: [actor.session, actor.operatorId, actor.delegate.grant] };
  }
  if (!roles.length) return { sql: session + ')', params: [actor.session, actor.operatorId] };
  if (ownerOnly) return { sql: session + " AND o.role='owner')", params: [actor.session, actor.operatorId] };
  return { sql: `${session} AND (o.role='owner' OR EXISTS(SELECT 1 FROM c_members m WHERE m.email=lower(o.email) AND m.active=1 AND (${orMember('m')}))))`, params: [actor.session, actor.operatorId] };
}

export function need(actor: Actor, role: Role) {
  requireThat(actor.roles[role], `${role[0].toUpperCase()}${role.slice(1)} access required`, 403);
}
/** Any one of these roles, as the permission matrix names them (ADMIN-001). */
export function needAny(actor: Actor, ...roles: Role[]) {
  requireThat(roles.some(r => actor.roles[r]), `${roles.map(r => r.replace('cardAdmin', 'card admin')).join(', ')} access required`, 403);
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
    if (message.includes('c_cutover_reports.source_key') || message.includes('c_cutover_items.source_key')) throw new Fault(409, 'This source report or expense has already been carried');
    if (message.includes('c_reimbursement_keys.key')) throw new Fault(409, 'An exact duplicate expense is already in a reimbursement batch');
    if (message.includes('c_card_charges.transaction_key')) throw new Fault(409, 'A card transaction in this file was imported at the same time; preview again');
    if (message.includes('c_batches.number')) throw new Fault(409, 'Another batch was created at the same time; reload and try again');
    if (message.includes('c_batch_claims.claim_id')) throw new Fault(409, 'That claim is already in a reimbursement batch');
    throw error;
  }
}
