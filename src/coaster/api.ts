import { Hono, type Context } from 'hono';
import { deploymentHealth } from '../base/deployment-health';
import { operatorAuth, runtimeBindings, type Bindings } from '../auth.server';
import { agent, need, person } from './session';
import { saveBusiness, saveCategory, saveMember } from './settings';
import { saveMileageRate } from './mileage';
import { createClaim, removeItem, renameClaim, saveItem, submitClaim, uploadReceipt } from './claims';
import { decide } from './decisions';
import { approveBatch, batchFile, createBatch, markReimbursed, removeFromBatch } from './batches';
import { acceptProposal, createAgentKey, declineProposal, proposal, proposeBatch, proposeClaim, revokeAgentKey } from './agents';
import { batchDetail, claimDetail, receiptFile, workspace } from './views';
import { importAction, importJobs, importedHistory } from './imports/jobs';
import { categories } from './items';
import { business } from './settings';
import { Fault, requireThat, type Actor, type Data } from './types';

type C = Context<{ Bindings: Bindings }>;
export const api = new Hono<{ Bindings: Bindings }>();

api.get('/health', c => c.json({ status: 'ok', ...deploymentHealth(c.env) }));
api.use('/api/coaster/*', async (c, next) => { await next(); c.header('cache-control', 'no-store'); c.header('x-content-type-options', 'nosniff'); });
api.onError((error, c) => {
  if (error instanceof Fault) return c.json({ error: error.message }, error.status as 400);
  if (error instanceof SyntaxError) return c.json({ error: 'The request body must be JSON' }, 400);
  console.error(error);
  return c.json({ error: 'Something went wrong; nothing was changed' }, 500);
});

const db = (c: C) => runtimeBindings(c.env).DB;
const param = (c: C, name: string) => { const value = c.req.param(name); requireThat(typeof value === 'string' && value.length > 0, 'Not found', 404); return value; };
async function body(c: C, limit = 3_000_000): Promise<Data> {
  requireThat(Number(c.req.header('content-length') ?? 0) <= limit, 'The request is too large', 413);
  const value = await c.req.json();
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'The request body must be a JSON object');
  return value;
}
/** Every person route checks the current native session itself; agent keys reach only /api/coaster/agent/*. */
const as = (handler: (actor: Actor, c: C) => Promise<unknown>) => async (c: C) => {
  const result = await handler(await person(c.req.raw, c.env), c);
  return result instanceof Response ? result : c.json(result);
};
const asAgent = (handler: (actor: Actor, c: C) => Promise<unknown>) => async (c: C) => c.json(await handler(await agent(c.req.raw, c.env), c));

api.get('/api/coaster/state', as(async (a, c) => workspace(db(c), a)));
api.get('/api/coaster/claims/:id', as(async (a, c) => claimDetail(db(c), a, param(c, 'id'))));
api.post('/api/coaster/claims', as(async (a, c) => createClaim(db(c), a, await body(c))));
api.post('/api/coaster/claims/:id/title', as(async (a, c) => renameClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/items', as(async (a, c) => saveItem(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/items/remove', as(async (a, c) => removeItem(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/receipts', as(async (a, c) => uploadReceipt(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/submit', as(async (a, c) => submitClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/decision', as(async (a, c) => decide(db(c), a, param(c, 'id'), await body(c))));
api.get('/api/coaster/receipts/:id', as(async (a, c) => receiptFile(db(c), a, param(c, 'id'), c.req.query('inline') === '1')));

api.post('/api/coaster/settings/business', as(async (a, c) => saveBusiness(db(c), a, await body(c))));
api.post('/api/coaster/settings/mileage-rates', as(async (a, c) => saveMileageRate(db(c), a, await body(c))));
api.post('/api/coaster/settings/categories', as(async (a, c) => saveCategory(db(c), a, await body(c))));
api.post('/api/coaster/settings/members', as(async (a, c) => saveMember(db(c), a, await body(c))));
api.post('/api/coaster/settings/members/invite', as(async (a, c) => {
  need(a, 'owner');
  const b = await body(c), member = await db(c).prepare('SELECT email,name FROM c_members WHERE email=? AND active=1').bind(String(b.email ?? '').toLowerCase()).first<{ email: string; name: string }>();
  requireThat(member, 'Save the member before inviting them', 404);
  return operatorAuth(runtimeBindings(c.env)).invite(c.req.raw, { email: member.email, displayName: member.name, role: 'member', returnTo: '/app' });
}));

api.get('/api/coaster/batches/:id', as(async (a, c) => batchDetail(db(c), a, param(c, 'id'))));
api.post('/api/coaster/batches', as(async (a, c) => createBatch(db(c), a, await body(c))));
api.post('/api/coaster/batches/:id/remove', as(async (a, c) => removeFromBatch(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/batches/:id/approve', as(async (a, c) => approveBatch(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/batches/:id/paid', as(async (a, c) => markReimbursed(db(c), a, param(c, 'id'), await body(c))));
api.get('/api/coaster/batches/:id/:file{(accounting|reimbursements)\\.csv}', as(async (a, c) => batchFile(db(c), a, param(c, 'id'), param(c, 'file').replace('.csv', ''))));

api.post('/api/coaster/agent-keys', as(async (a, c) => createAgentKey(db(c), a, await body(c))));
api.post('/api/coaster/agent-keys/:id/revoke', as(async (a, c) => revokeAgentKey(db(c), a, param(c, 'id'))));
api.post('/api/coaster/proposals/:id/accept', as(async (a, c) => acceptProposal(db(c), a, param(c, 'id'))));
api.post('/api/coaster/proposals/:id/decline', as(async (a, c) => declineProposal(db(c), a, param(c, 'id'), await body(c))));

api.get('/api/coaster/agent/context', asAgent(async (a, c) => ({
  for: { email: a.email, name: a.name, roles: a.roles }, agent: a.agentLabel, business: await business(db(c)), categories: (await categories(db(c))).filter(x => x.active === 1),
  approvedClaims: a.roles.finance ? (await db(c).prepare("SELECT id,number,employee_email,title,total_minor,currency FROM c_claims WHERE status='approved' ORDER BY number").all()).results : [],
  proposals: (await db(c).prepare('SELECT id,kind,status,created_at,decided_at,result_id FROM c_proposals WHERE for_email=? ORDER BY created_at DESC LIMIT 50').bind(a.email).all()).results,
})));
api.get('/api/coaster/agent/proposals/:id', asAgent(async (a, c) => { const p = await proposal(db(c), param(c, 'id')); requireThat(p.for_email === a.email, 'Proposal not found', 404); return p; }));
api.post('/api/coaster/agent/claims', asAgent(async (a, c) => proposeClaim(db(c), a, await body(c, 8_000_000))));
api.post('/api/coaster/agent/batches', asAgent(async (a, c) => proposeBatch(db(c), a, await body(c))));

api.get('/api/coaster/import', as(async (a, c) => { need(a, 'owner'); return { jobs: await importJobs(db(c)), history: await importedHistory(db(c)) }; }));
api.post('/api/coaster/import/:op', as(async (a, c) => importAction(db(c), a, param(c, 'op'), await body(c))));
