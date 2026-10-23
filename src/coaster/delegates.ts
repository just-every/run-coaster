import { all, authority, commit, notDeactivated, rolesFrom, type Sql } from './session';
import { can, needRow, rowAuthority } from './permissions';
import { event } from './events';
import { operatorMail } from '../mail.server.mjs';
import type { Bindings } from '../auth.server';
import { email, now, requireThat, uid, type Actor, type Data } from './types';

const levelWords = { submit: 'Submit only', full: 'Full' } as const;
const activeMember = (db: D1Database, address: string) => db.prepare('SELECT name FROM c_members WHERE email=? AND active=1').bind(address).first<{ name: string }>();
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const ownerGrant = (address: unknown) => "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=" + address + " AND o.role='owner')";
/** Managing someone else's delegates is the people row of the matrix (ADMIN-001): the owner for anyone, an admin for anyone
 * but the owner, whose row only the owner hands out (ADMIN-005). Returns the guard that keeps it so at commit. */
async function forSomeoneElse(db: D1Database, actor: Actor, grantor: string): Promise<Sql> {
  needRow(actor, 'people', 'Only the owner or an admin manages delegates for someone else');
  requireThat(actor.roles.owner || !await db.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner'").bind(grantor).first(), 'Only the owner manages the owner\'s delegates', 403);
  return all(rowAuthority(actor, 'people'), actor.roles.owner ? { sql: '1', params: [] } : { sql: `NOT ${ownerGrant('?')}`, params: [grantor] });
}

/** A member grants another member delegate access to their own expenses; the owner, or an admin for anyone but the owner, grants and revokes for others. */
export async function grantDelegate(db: D1Database, env: Bindings, actor: Actor, b: Data) {
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only the person themselves, an admin or the owner grants delegate access', 403);
  const grantor = b.grantor ? email(b.grantor, 'Person') : actor.email;
  const guard = grantor === actor.email ? authority(actor) : await forSomeoneElse(db, actor, grantor);
  const delegate = email(b.delegate, 'Delegate');
  requireThat(delegate !== grantor, 'Choose someone else as the delegate');
  requireThat(b.level === 'submit' || b.level === 'full', 'Choose Submit only or Full access');
  const level: keyof typeof levelWords = b.level, from = await activeMember(db, grantor), to = await activeMember(db, delegate);
  requireThat(from, 'The person granting access must be an active member');
  requireThat(to, 'The delegate must be an active member');
  const live = await db.prepare('SELECT id FROM c_delegates WHERE grantor_email=? AND delegate_email=? AND revoked_at IS NULL').bind(grantor, delegate).first<{ id: string }>();
  const id = uid(), at = now();
  await commit(db, guard, [
    ...(live ? [db.prepare('UPDATE c_delegates SET revoked_by=?,revoked_at=? WHERE id=?').bind(actor.email, at, live.id)] : []),
    db.prepare('INSERT INTO c_delegates(id,grantor_email,delegate_email,level,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(id, grantor, delegate, level, actor.email, at),
    event(db, actor, 'delegate-granted', {}, { id, grantor, delegate, level, replaced: live?.id ?? null }),
  ]);
  // The granting person hears of every grant, whoever made it, and can revoke it at once.
  const mail = operatorMail(env), link = `${env.AUTH_ORIGIN}/app#/settings`;
  const text = `${actor.name} gave ${to.name} (${delegate}) ${levelWords[level]} delegate access to your Coaster expenses. Everything ${to.name} does for you is recorded as theirs, on your behalf. See or revoke it at once in Settings: ${link}`;
  const sent = mail ? await mail.send({ deliveryId: id, from: env.MAIL_FROM ?? '', to: [grantor], subject: `${to.name} can now act for you in Coaster`, text, html: `<p>${escape(text.replace(link, ''))}<a href="${link}">${link}</a></p>`, headers: {} }) : null;
  return { id, grantor, delegate, level, notified: sent?.status ?? 'mail not set up' };
}

/** The granting person, the delegate, the owner or (for anyone but the owner) an admin ends a grant; the delegate's next request is refused. */
export async function revokeDelegate(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.kind === 'person' && !actor.delegate, 'A delegate cannot change delegate access', 403);
  const grant = await db.prepare('SELECT * FROM c_delegates WHERE id=? AND revoked_at IS NULL').bind(id).first<Data>();
  requireThat(grant, 'Delegate access not found', 404);
  const own = [grant.grantor_email, grant.delegate_email].includes(actor.email);
  const guard = own ? authority(actor) : await forSomeoneElse(db, actor, grant.grantor_email);
  await commit(db, guard, [
    db.prepare('UPDATE c_delegates SET revoked_by=?,revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(actor.email, now(), id),
    event(db, actor, 'delegate-revoked', {}, { id, grantor: grant.grantor_email, delegate: grant.delegate_email, level: grant.level }),
  ]);
  return { ok: true };
}

/** Live grants the signed-in person gave or holds; the owner sees everyone's, an admin everyone's but the owner's. */
export async function delegateGrants(db: D1Database, actor: Actor) {
  const me = actor.delegate?.email ?? actor.email, manager = can(actor, 'people') && !actor.delegate;
  const rows = await db.prepare(`SELECT id,grantor_email,delegate_email,level,created_by,created_at,${ownerGrant('g.grantor_email')} AS owner_grant FROM c_delegates g WHERE revoked_at IS NULL ORDER BY created_at DESC`).all<Data>();
  return rows.results.filter(g => (manager && (actor.roles.owner || !g.owner_grant)) || g.grantor_email === me || g.delegate_email === me).map(({ owner_grant: _, ...g }) => g);
}

/** The signed-in person acting as a delegate: the actor becomes the granting person, with roles narrowed by the
 * grant's level (Submit only: their own expenses; Full: their whole row, the owner's included), and names the delegate.
 * Their bank details, delegates, agent keys and sign-in stay theirs alone: those handlers refuse any delegate. The grant
 * ends with the granting person's membership or the deactivation of their sign-in account. */
export async function actingAs(db: D1Database, person: Actor, value: string): Promise<Actor> {
  requireThat(person.kind === 'person', 'Only a person acts as a delegate', 403);
  const grantor = email(value, 'Acting for');
  const grant = await db.prepare(`SELECT g.id,g.level,m.name,m.is_employee,m.is_manager,m.is_finance,m.is_auditor,m.is_admin,m.is_card_admin,m.is_bookkeeper,EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=g.grantor_email AND o.role='owner' AND o.status='active') AS is_owner FROM c_delegates g JOIN c_members m ON m.email=g.grantor_email AND m.active=1 JOIN c_members d ON d.email=g.delegate_email AND d.active=1 WHERE g.grantor_email=? AND g.delegate_email=? AND g.revoked_at IS NULL AND ${notDeactivated('g.grantor_email')}`).bind(grantor, person.email).first<Data>();
  requireThat(grant, 'You are not a delegate for that person, or the access has ended', 403);
  const full = grant.level === 'full', owner = grant.is_owner === 1;
  return { ...person, email: grantor, name: grant.name, roles: rolesFrom(grant, owner, full),
    delegate: { email: person.email, name: person.name, level: grant.level, grant: grant.id } };
}
