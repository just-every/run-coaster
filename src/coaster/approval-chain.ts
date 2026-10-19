import { routeFor } from './delegation';
import type { Sql } from './session';
import { requireThat } from './types';

export type ChainStep = { memberId: string; email: string };
export type ClaimChain = { claim_id: string; revision: number; chain_id: string; steps: ChainStep[]; position: number };
type ChainConfiguration = { id: string; employee_id: string; steps: string; revision: string };

/** The exact configured chain and active identities are fenced at submission.
 * Imported people remain unable to participate until the owner activates them. */
export async function configuredChain(db: D1Database, employee: string) {
  const configured = await db.prepare('SELECT c.* FROM c_import_chains c JOIN c_members m ON m.member_id=c.employee_id WHERE m.email=?').bind(employee).first<ChainConfiguration>();
  if (!configured) return { chain: null, guards: [{ sql: 'NOT EXISTS(SELECT 1 FROM c_import_chains c JOIN c_members m ON m.member_id=c.employee_id WHERE m.email=?)', params: [employee] }] as Sql[] };
  const ids: unknown = JSON.parse(configured.steps);
  requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length, 'The imported approval chain must contain distinct ordered managers; ask the owner to correct it', 409);
  const steps: ChainStep[] = [], guards: Sql[] = [{ sql: 'EXISTS(SELECT 1 FROM c_import_chains WHERE id=? AND employee_id=? AND steps=? AND revision=?)', params: [configured.id, configured.employee_id, configured.steps, configured.revision] }];
  for (const id of ids) {
    const member = await db.prepare('SELECT email FROM c_members WHERE member_id=? AND active=1 AND is_manager=1').bind(id).first<{ email: string }>();
    requireThat(member, 'Every manager in the imported approval chain must be activated by the owner before submission', 409);
    requireThat(member.email !== employee, 'Nobody approves their own claims', 409);
    steps.push({ memberId: id, email: member.email });
    guards.push(managerState(id, member.email));
  }
  return { chain: { id: configured.id, steps }, guards };
}

const managerState = (id: string, email: string): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_members WHERE member_id=? AND email=? AND active=1 AND is_manager=1)', params: [id, email] });

export async function claimChain(db: D1Database, claim: string, revision: number): Promise<ClaimChain | null> {
  const row = await db.prepare('SELECT * FROM c_claim_chains WHERE claim_id=? AND revision=?').bind(claim, revision).first<Omit<ClaimChain, 'steps'> & { steps: string }>();
  return row ? { ...row, steps: JSON.parse(row.steps) } : null;
}

export function chainState(chain: ClaimChain | null, claim: string, revision: number): Sql {
  return chain
    ? { sql: 'EXISTS(SELECT 1 FROM c_claim_chains WHERE claim_id=? AND revision=? AND chain_id=? AND steps=? AND position=?)', params: [claim, revision, chain.chain_id, JSON.stringify(chain.steps), chain.position] }
    : { sql: 'NOT EXISTS(SELECT 1 FROM c_claim_chains WHERE claim_id=? AND revision=?)', params: [claim, revision] };
}

export function freezeChain(db: D1Database, claim: string, revision: number, id: string, steps: ChainStep[], position = 0) {
  return db.prepare('INSERT INTO c_claim_chains(claim_id,revision,chain_id,steps,position) VALUES(?,?,?,?,?)').bind(claim, revision, id, JSON.stringify(steps), position);
}

/** Delegation substitutes only the current step; it never consumes later ones. */
export async function chainRoute(db: D1Database, steps: ChainStep[], position: number, employee: string, day: string) {
  const step = steps[position];
  requireThat(step && step.email !== employee, 'The approval chain has no valid next manager; ask the owner to correct it', 409);
  const guard = managerState(step.memberId, step.email);
  requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(), 'The next approval-chain manager is inactive; ask the owner to activate them', 409);
  const route = await routeFor(db, step.email, employee, day);
  return { ...route, guard: { sql: `(${guard.sql}) AND EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1)`, params: [...guard.params, route.approver] } as Sql };
}

export const advanceChain = (db: D1Database, chain: ClaimChain) => db.prepare('UPDATE c_claim_chains SET position=position+1 WHERE claim_id=? AND revision=?').bind(chain.claim_id, chain.revision);

/** Reports, payment exports and sampling count a completed approval once.
 * Intermediate approvals remain ordinary decisions in the audit history. */
export const finalApproval = (alias: string) => `${alias}.decision='approved' AND NOT EXISTS(SELECT 1 FROM c_claim_chains ch WHERE ch.claim_id=${alias}.claim_id AND ch.revision=${alias}.revision AND ${alias}.decision_step<json_array_length(ch.steps)-1)`;
