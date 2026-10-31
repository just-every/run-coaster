import { operatorAuth, authConfig, type Bindings } from '../../auth.server';
import { operatorAuthPeople, type PeopleAdapter, type Person, ToolRefusal, type ToolContext } from '../../modules/agent-door/index.ts';
import { rolesFrom, type MemberFlags } from '../session';
import type { Actor } from '../types';

/** Operator ids bind Business subjects; Coaster membership remains authoritative. */
export function coasterPeople(env: Bindings): PeopleAdapter {
  const native = operatorAuthPeople({ db: env.DB, allowList: authConfig(env).allowList, session: r => operatorAuth(env).getSession(r) });
  async function admitted(p: Person | null) {
    if (!p?.active) return null;
    // Owners can administer the door; tools still require a live Coaster member.
    if (p.role !== 'owner' && !await env.DB.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1').bind(p.email.toLowerCase()).first()) return null;
    return p;
  }
  return { ...native, person: async id => admitted(await native.person(id)), sponsor: async claims => admitted(await native.sponsor(claims)), session: async r => admitted(await native.session(r)) };
}

export async function nativeAgent(ctx: ToolContext): Promise<Actor> {
  const member = await ctx.db.prepare(`SELECT m.*,o.id AS operatorId FROM c_members m JOIN oa_operators o ON lower(o.email)=m.email
    WHERE o.id=? AND m.email=? AND o.status='active' AND m.active=1`).bind(ctx.person.id, ctx.person.email.toLowerCase()).first<MemberFlags & { name: string; operatorId: string }>();
  if (!member) throw new ToolRefusal('native_authority_required');
  const state = await ctx.db.prepare('SELECT envelope,local_document,local_revision FROM agent_door_state WHERE id=1').first<{ envelope: string | null; local_document: string | null; local_revision: number }>();
  if (!state) throw new ToolRefusal('policy_unset');
  return { kind: 'agent', email: ctx.person.email.toLowerCase(), name: member.name, roles: rolesFrom(member, false),
    operatorId: member.operatorId, agentLabel: ctx.agent.name,
    doorCredential: { operatorId: member.operatorId, agentId: ctx.agent.id, envelope: state.envelope, document: state.local_document, revision: state.local_revision,
      ...(ctx.clientId?.startsWith('coaster-key:') ? { localKey: ctx.clientId.slice(12) } : {}) } };
}
