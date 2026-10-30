import { createAgentDoor, type Trust, type Principal } from '../../modules/agent-door/index.ts';
import { operatorAuth, runtimeBindings, type Bindings } from '../../auth.server';
import { coasterPeople } from './people';
import { coasterBusiness } from './business';
import { coasterTools } from './tools';
import { agent } from '../session';

export const capabilities = ['tools', 'policy', 'pause', 'audit', 'idempotency'] as const;
function trust(env: Bindings): Trust | null {
  const { RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId, RER_OWNER_CLAIM_PUBLIC_KEYS: keys } = env;
  if (![issuer, installationId, keys].some(Boolean)) return null;
  if (!issuer || !installationId || !keys) throw new Error('Incomplete owner-claim trust');
  return { issuer, installationId, appOrigin: env.AUTH_ORIGIN, publicKeys: JSON.parse(keys) };
}
export function coasterAgentDoor(original: Bindings) {
  const env = runtimeBindings(original);
  return createAgentDoor({ seed: 'coaster', name: 'Coaster', specialist: 'Expense controller', db: env.DB, origin: env.AUTH_ORIGIN, trust: trust(env), capabilities,
    people: coasterPeople(env), tools: coasterTools(), resources: [],
    notTools: [ { clauses: ['COA-010'], reason: 'screen' }, { clauses: ['COA-011'], reason: 'import-door' }, { clauses: ['COA-012', 'COA-013'], reason: 'installation' }, { clauses: ['CAPTURE-002', 'API-001'], reason: 'connector' }, { clauses: ['CAPTURE-001'], reason: 'device' } ],
    async localCredentials(request) {
      if (!request.headers.get('authorization')?.startsWith('Bearer cst_')) return null;
      try {
        const a = await agent(request, env);
        const p = await env.DB.prepare("SELECT id FROM oa_operators WHERE lower(email)=? AND status='active'").bind(a.email).first<{id: string}>();
        return p ? { sponsor: { id: p.id }, agent: { id: a.keyId!, name: a.agentLabel! }, clientId: `coaster-key:${a.keyId}`, scopes: ['proposals:read', 'proposals:write'] } : null;
      } catch { return null; }
    },
    async currentScopes(p: Principal) {
      if (!p.clientId?.startsWith('coaster-key:')) return p.scopes;
      return await env.DB.prepare('SELECT 1 FROM c_agent_keys WHERE id=? AND member_email=? AND revoked_at IS NULL').bind(p.clientId.slice(12), p.person.email.toLowerCase()).first() ? p.scopes : [];
    },
  });
}
export async function agentDoorResponse(request: Request, original: Bindings) {
  const env = runtimeBindings(original);
  const settings = await coasterBusiness(env).handle(request);
  if (settings) return settings;
  return coasterAgentDoor(env).handle(request);
}
