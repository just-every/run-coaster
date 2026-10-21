import { all, commit } from './session';
import { event } from './events';
import { needRow, rowAuthority } from './permissions';
import { now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Department = { id: string; name: string; head_email: string | null; active: number; members: number };

/** Departments with their head (an approver) and active members (ADMIN-001). */
export async function departments(db: D1Database): Promise<Department[]> {
  return (await db.prepare('SELECT d.id,d.name,d.head_email,d.active,(SELECT COUNT(*) FROM c_members m WHERE m.department_id=d.id AND m.active=1) AS members FROM c_departments d ORDER BY d.name').all<Department>()).results;
}

/** The owner or an admin names a department, or renames it and changes its head. The head is an active approver, and a
 * department that has people is retired rather than deleted. */
export async function saveDepartment(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'settings');
  requireThat(actor.kind === 'person', 'Only a person sets up departments', 403);
  const id = typeof b.id === 'string' && b.id ? b.id : uid(), name = text(b.name, 'Department name', 100), head = optionalText(b.head, 'Department head', 254).toLowerCase() || null;
  if (b.id) requireThat(await db.prepare('SELECT 1 FROM c_departments WHERE id=?').bind(id).first(), 'Department not found', 404);
  requireThat(!await db.prepare('SELECT 1 FROM c_departments WHERE name=? AND id<>?').bind(name, id).first(), 'Another department already has that name', 409);
  requireThat(!head || await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(head).first(), 'The department head must be an active approver');
  const active = b.active === false || b.active === 'false' ? 0 : 1, at = now();
  await commit(db, all(rowAuthority(actor, 'settings'), { sql: head ? 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1)' : '1', params: head ? [head] : [] }), [
    db.prepare('INSERT INTO c_departments(id,name,head_email,active,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,head_email=excluded.head_email,active=excluded.active,updated_at=excluded.updated_at').bind(id, name, head, active, actor.delegate?.email ?? actor.email, at, at),
    event(db, actor, 'department-saved', {}, { department: id, name, head, active: active === 1 }),
  ]);
  return (await departments(db)).find(d => d.id === id)!;
}

/** SQL for "this claim's employee is in the actor's reporting scope": everyone below them in the manager hierarchy (their
 * approving-manager chain, however many levels), and every member of a department they head. Bind `email` twice. */
export const inScope = (column: string) => `${column} IN (WITH RECURSIVE below(email) AS (SELECT email FROM c_members WHERE approver_email=? UNION SELECT m.email FROM c_members m JOIN below b ON m.approver_email=b.email) SELECT email FROM below UNION SELECT m.email FROM c_members m JOIN c_departments d ON d.id=m.department_id AND d.active=1 WHERE d.head_email=?)`;
export const scopeParams = (email: string) => [email, email];

/** Whether `employee` is in `manager`'s scope (the same rule as inScope, read for one person). */
export async function inManagersScope(db: D1Database, manager: string, employee: string) {
  return !!await db.prepare(`SELECT 1 WHERE ${inScope('?')}`).bind(employee, manager, manager).first();
}
