import { all, commit } from './session';
import { event } from './events';
import { needRow, rowAuthority } from './permissions';
import { email, now, requireThat, type Actor, type Data } from './types';

/** Finance's escalation chain by role and department (FOLLOWUP-002, ADMIN-001): up to two steps, each the department head,
 * the person's approving manager or a named active finance member. A department's own chain wins over the default chain. */
export type ChainStep = { kind: 'department-head' | 'manager' | 'finance'; email?: string };
export type EscalationChain = { department_id: string; version: number; steps: ChainStep[]; set_by: string; set_at: string };

export async function chainFor(db: D1Database, person: string): Promise<EscalationChain | null> {
  const row = await db.prepare(`SELECT c.* FROM c_escalation_chains c WHERE c.version=(SELECT MAX(version) FROM c_escalation_chains x WHERE x.department_id=c.department_id)
    AND c.department_id IN ('',COALESCE((SELECT department_id FROM c_members WHERE email=?),'')) ORDER BY c.department_id DESC LIMIT 1`).bind(person).first<Omit<EscalationChain, 'steps'> & { steps: string }>();
  return row ? { ...row, steps: JSON.parse(row.steps) } : null;
}

/** Everyone who must be told at this step, never the person who owes the item; empty when the step names nobody. */
export async function stepRecipients(db: D1Database, person: string, step: ChainStep) {
  const one = async (sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).first<{ email: string }>())?.email;
  const address = step.kind === 'finance' ? step.email : step.kind === 'manager'
    ? await one('SELECT m.approver_email AS email FROM c_members m JOIN c_members a ON a.email=m.approver_email AND a.active=1 WHERE m.email=?', person)
    : await one('SELECT d.head_email AS email FROM c_members m JOIN c_departments d ON d.id=m.department_id AND d.active=1 JOIN c_members h ON h.email=d.head_email AND h.active=1 WHERE m.email=?', person);
  return address && address !== person ? [address] : [];
}

export async function escalationChains(db: D1Database) {
  return (await db.prepare('SELECT c.* FROM c_escalation_chains c WHERE c.version=(SELECT MAX(version) FROM c_escalation_chains x WHERE x.department_id=c.department_id) ORDER BY c.department_id').all<Omit<EscalationChain, 'steps'> & { steps: string }>()).results.map(c => ({ ...c, steps: JSON.parse(c.steps) as ChainStep[] }));
}

export async function saveEscalationChain(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'policy');
  requireThat(actor.kind === 'person', 'Only a person sets escalation chains', 403);
  const department = typeof b.department === 'string' ? b.department : '';
  requireThat(!department || await db.prepare('SELECT 1 FROM c_departments WHERE id=? AND active=1').bind(department).first(), 'Choose an active department, or leave it empty for every department');
  requireThat(Array.isArray(b.steps) && b.steps.length >= 1 && b.steps.length <= 2, 'A chain has one or two steps');
  const steps: ChainStep[] = [];
  for (const s of b.steps) {
    requireThat(s && ['department-head', 'manager', 'finance'].includes(s.kind), 'Each step is the department head, the approving manager or a named finance member');
    if (s.kind === 'finance') {
      const address = email(s.email, 'Finance member');
      requireThat(await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_finance=1').bind(address).first(), 'Name an active finance member');
      steps.push({ kind: 'finance', email: address });
    } else steps.push({ kind: s.kind });
  }
  const version = ((await db.prepare('SELECT MAX(version) AS n FROM c_escalation_chains WHERE department_id=?').bind(department).first<{ n: number | null }>())?.n ?? 0) + 1;
  await commit(db, all(rowAuthority(actor, 'policy'), { sql: 'NOT EXISTS(SELECT 1 FROM c_escalation_chains WHERE department_id=? AND version>=?)', params: [department, version] }), [
    db.prepare('INSERT INTO c_escalation_chains(department_id,version,steps,set_by,set_at) VALUES(?,?,?,?,?)').bind(department, version, JSON.stringify(steps), actor.delegate?.email ?? actor.email, now()),
    event(db, actor, 'escalation-chain-saved', {}, { department: department || null, version, steps }),
  ]);
  return escalationChains(db);
}
