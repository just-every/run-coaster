import { createAgentDoor, type Trust, type Principal } from '../../modules/agent-door/index.ts';
import { operatorAuth, runtimeBindings, type Bindings } from '../../auth.server';
import { coasterPeople } from './people';
import { coasterBusiness } from './business';
import { coasterTools } from './tools';
import { coasterResources } from './resources';
import { coasterPrompts } from './prompts';
import { agent } from '../session';

const preparationScopes = ['proposals:read', 'proposals:write'];
const allowedKeyScopes = [...preparationScopes, 'events:read'];
async function keyScopes(env: Bindings, id: string, email: string): Promise<string[]> {
  const key = await env.DB.prepare('SELECT scopes FROM c_agent_keys WHERE id=? AND member_email=? AND revoked_at IS NULL').bind(id, email.toLowerCase()).first<{ scopes: string }>();
  if (!key) return [];
  const stored: unknown = JSON.parse(key.scopes);
  return Array.isArray(stored) ? allowedKeyScopes.filter(scope => stored.includes(scope)) : [];
}

export const capabilities = ['tools', 'resources', 'prompts', 'events', 'policy', 'pause', 'audit', 'idempotency'] as const;
function trust(env: Bindings): Trust | null {
  const { RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId, RER_OWNER_CLAIM_PUBLIC_KEYS: keys } = env;
  if (![issuer, installationId, keys].some(Boolean)) return null;
  if (!issuer || !installationId || !keys) throw new Error('Incomplete owner-claim trust');
  return { issuer, installationId, appOrigin: env.AUTH_ORIGIN, publicKeys: JSON.parse(keys) };
}
export async function coasterAgentDoor(original: Bindings) {
  const env = runtimeBindings(original);
  const name = String(await coasterBusiness(env).resolve('display_name', 'Coaster'));
  const tools = coasterTools();
  return createAgentDoor({ seed: 'coaster', name, specialist: 'Expense controller', db: env.DB, origin: env.AUTH_ORIGIN, trust: trust(env), capabilities,
    people: coasterPeople(env), tools, resources: coasterResources(), prompts: coasterPrompts(tools),
    notTools: [ { clauses: ['COA-010'], reason: 'screen' }, { clauses: ['COA-011'], reason: 'import-door' }, { clauses: ['COA-012', 'COA-013'], reason: 'installation' }, { clauses: ['CAPTURE-002', 'API-001'], reason: 'connector' }, { clauses: ['CAPTURE-001'], reason: 'device' } ],
    async localCredentials(request) {
      if (!request.headers.get('authorization')?.startsWith('Bearer cst_')) return null;
      try {
        const a = await agent(request, env);
        const p = await env.DB.prepare("SELECT id FROM oa_operators WHERE lower(email)=? AND status='active'").bind(a.email).first<{id: string}>();
        return p ? { sponsor: { id: p.id }, agent: { id: a.keyId!, name: a.agentLabel! }, clientId: `coaster-key:${a.keyId}`, scopes: await keyScopes(env, a.keyId!, a.email) } : null;
      } catch { return null; }
    },
    async currentScopes(p: Principal) {
      if (!p.clientId?.startsWith('coaster-key:')) return p.scopes;
      const granted = await keyScopes(env, p.clientId.slice(12), p.person.email);
      return p.scopes.filter(scope => granted.includes(scope));
    },
  });
}
export async function agentDoorResponse(request: Request, original: Bindings) {
  const path = new URL(request.url).pathname;
  const businessPath = ['/api/rer/business-settings', '/rer-business-logo', '/rer-business.css'].includes(path);
  const doorPath = ['/mcp', '/api/rer/agent-policy', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/agents'].includes(path) || path.startsWith('/agents/');
  if (!businessPath && !doorPath) return null;
  const env = runtimeBindings(original);
  if (!env.AUTH_ORIGIN) return Response.json({ code: 'door_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  return businessPath ? coasterBusiness(env).handle(request) : (await coasterAgentDoor(env)).handle(request);
}
