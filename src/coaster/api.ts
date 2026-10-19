import { Hono, type Context } from 'hono';
import { deploymentHealth } from '../base/deployment-health';
import { operatorAuth, runtimeBindings, type Bindings } from '../auth.server';
import { agent, need, person } from './session';
import { saveBusiness, saveCategory, saveMember } from './settings';
import { saveMileageRate } from './mileage';
import { createClaim, removeItem, renameClaim, saveItem, submitClaim, uploadReceipt } from './claims';
import { decide, reassign } from './decisions';
import { retractClaim, unapproveClaim } from './reversals';
import { releaseHold } from './holds';
import { exceptionQueue, recordFinding, reviewException, saveAuditSample } from './audit-queue';
import { saveApprovalRule } from './auto-approval';
import { report } from './reports';
import { saveReminderSettings } from './reminders';
import { saveSpendView, spend } from './spend';
import { budgetReport, importBudgets, saveBudget } from './budgets';
import { addExpense, saveAutoSubmit } from './auto-reports';
import { confirmExpiry, placeHold, releaseHold as releaseLegalHold, retention, saveRetention } from './retention';
import { allowancesFor, saveAllowance, saveRecurring, stopAllowance, stopRecurring } from './allowances';
import { reportSchedules, scheduleReport, stopReportSchedule } from './report-schedules';
import { addComment, editComment } from './comments';
import { revokeDelegation, saveDelegation } from './delegation';
import { actingAs, grantDelegate, revokeDelegate } from './delegates';
import { createRequest, decideRequest } from './requests';
import { approveBatch, createBatch, markReimbursed, removeFromBatch } from './batches';
import { batchFile, periodFile, saveExportTemplate } from './exports';
import { acceptProposal, createAgentKey, declineProposal, proposal, proposeBatch, proposeClaim, revokeAgentKey } from './agents';
import { batchDetail, claimDetail, receiptFile, workspace } from './views';
import { auditPack, searchHistory } from './audit';
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
/** Every person route checks the current native session itself; agent keys reach only /api/coaster/agent/*. A delegate
 * names the person they act for in `x-coaster-acting-for` (or `?actingFor=` on a link). */
const as = (handler: (actor: Actor, c: C) => Promise<unknown>) => async (c: C) => {
  const signedIn = await person(c.req.raw, c.env), actingFor = (c.req.header('x-coaster-acting-for') || c.req.query('actingFor') || '').toLowerCase();
  const result = await handler(actingFor && actingFor !== signedIn.email ? await actingAs(db(c), signedIn, actingFor) : signedIn, c);
  return result instanceof Response ? result : c.json(result);
};
const asAgent = (handler: (actor: Actor, c: C) => Promise<unknown>) => async (c: C) => c.json(await handler(await agent(c.req.raw, c.env), c));

api.get('/api/coaster/state', as(async (a, c) => workspace(db(c), a)));
api.get('/api/coaster/claims/:id', as(async (a, c) => claimDetail(db(c), a, param(c, 'id'))));
api.post('/api/coaster/claims', as(async (a, c) => createClaim(db(c), a, await body(c))));
api.post('/api/coaster/expenses', as(async (a, c) => addExpense(db(c), a, await body(c))));
api.post('/api/coaster/claims/:id/title', as(async (a, c) => renameClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/items', as(async (a, c) => saveItem(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/items/remove', as(async (a, c) => removeItem(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/receipts', as(async (a, c) => uploadReceipt(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/submit', as(async (a, c) => submitClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/decision', as(async (a, c) => decide(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/retract', as(async (a, c) => retractClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/unapprove', as(async (a, c) => unapproveClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/comments', as(async (a, c) => addComment(db(c), runtimeBindings(c.env), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/comments/:id/edit', as(async (a, c) => editComment(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/release', as(async (a, c) => releaseHold(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/reassign', as(async (a, c) => reassign(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/requests', as(async (a, c) => createRequest(db(c), a, await body(c))));
api.post('/api/coaster/requests/:id/decision', as(async (a, c) => decideRequest(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/delegations', as(async (a, c) => saveDelegation(db(c), a, await body(c))));
api.post('/api/coaster/delegations/:id/revoke', as(async (a, c) => revokeDelegation(db(c), a, param(c, 'id'))));
api.post('/api/coaster/delegates', as(async (a, c) => grantDelegate(db(c), runtimeBindings(c.env), a, await body(c))));
api.post('/api/coaster/delegates/:id/revoke', as(async (a, c) => revokeDelegate(db(c), a, param(c, 'id'))));
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
const file = (c: C) => param(c, 'file').split('.') as [string, string];
api.get('/api/coaster/batches/:id/:file{(accounting|reimbursements)\\.(csv|xlsx)|accounting\\.iif}', as(async (a, c) => batchFile(db(c), a, param(c, 'id'), ...file(c), c.req.query('template') || undefined, runtimeBindings(c.env).AUTH_ORIGIN)));
api.get('/api/coaster/exports/:file{(accounting|reimbursements)\\.(csv|xlsx)|accounting\\.iif}', as(async (a, c) => periodFile(db(c), a, ...file(c), c.req.query(), runtimeBindings(c.env).AUTH_ORIGIN)));
api.post('/api/coaster/export-templates', as(async (a, c) => saveExportTemplate(db(c), a, await body(c))));

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

api.get('/api/coaster/exceptions', as(async (a, c) => exceptionQueue(db(c), a, c.req.query('sort'))));
api.post('/api/coaster/exceptions/review', as(async (a, c) => reviewException(db(c), a, await body(c))));
api.post('/api/coaster/settings/approval-rule', as(async (a, c) => saveApprovalRule(db(c), a, await body(c))));
api.post('/api/coaster/settings/auto-submit', as(async (a, c) => saveAutoSubmit(db(c), a, await body(c))));
api.post('/api/coaster/settings/retention', as(async (a, c) => saveRetention(db(c), a, await body(c))));
api.get('/api/coaster/retention', as(async (a, c) => retention(db(c), a)));
api.post('/api/coaster/retention/:id/confirm', as(async (a, c) => confirmExpiry(db(c), a, param(c, 'id'))));
api.post('/api/coaster/legal-holds', as(async (a, c) => placeHold(db(c), a, await body(c))));
api.post('/api/coaster/legal-holds/:id/release', as(async (a, c) => releaseLegalHold(db(c), a, param(c, 'id'))));
api.post('/api/coaster/settings/reminders', as(async (a, c) => saveReminderSettings(db(c), a, await body(c))));
api.post('/api/coaster/settings/audit-sample', as(async (a, c) => saveAuditSample(db(c), a, await body(c))));
api.post('/api/coaster/audit-samples/finding', as(async (a, c) => recordFinding(db(c), a, await body(c))));
api.get('/api/coaster/reports/:name', as(async (a, c) => report(db(c), a, param(c, 'name'), c.req.query())));
api.get('/api/coaster/report-schedules', as(async (a, c) => { requireThat(a.roles.finance || a.roles.auditor || a.roles.owner, 'Finance, auditor or owner access required', 403); return reportSchedules(db(c)); }));
api.post('/api/coaster/report-schedules', as(async (a, c) => scheduleReport(db(c), a, await body(c))));
api.post('/api/coaster/report-schedules/:id/stop', as(async (a, c) => stopReportSchedule(db(c), a, param(c, 'id'))));
api.get('/api/coaster/spend', as(async (a, c) => spend(db(c), a, c.req.query())));
api.post('/api/coaster/spend-views', as(async (a, c) => saveSpendView(db(c), a, await body(c))));
api.get('/api/coaster/budgets', as(async (a, c) => budgetReport(db(c), a, c.req.query('day') || undefined)));
api.post('/api/coaster/budgets', as(async (a, c) => saveBudget(db(c), a, await body(c))));
api.post('/api/coaster/budgets/import', as(async (a, c) => importBudgets(db(c), a, await body(c))));
api.get('/api/coaster/allowances', as(async (a, c) => allowancesFor(db(c), a, c.req.query('day') || undefined)));
api.post('/api/coaster/allowances', as(async (a, c) => saveAllowance(db(c), a, await body(c))));
api.post('/api/coaster/allowances/:id/stop', as(async (a, c) => stopAllowance(db(c), a, param(c, 'id'))));
api.post('/api/coaster/recurring', as(async (a, c) => saveRecurring(db(c), a, await body(c))));
api.post('/api/coaster/recurring/:id/stop', as(async (a, c) => stopRecurring(db(c), a, param(c, 'id'))));
api.get('/api/coaster/history', as(async (a, c) => searchHistory(db(c), a, c.req.query())));
api.get('/api/coaster/audit-pack', as(async (a, c) => auditPack(db(c), a, c.req.query('from'), c.req.query('to'))));

api.get('/api/coaster/import', as(async (a, c) => { need(a, 'owner'); return { jobs: await importJobs(db(c)), history: await importedHistory(db(c)) }; }));
api.post('/api/coaster/import/:op', as(async (a, c) => importAction(db(c), a, param(c, 'op'), await body(c, 8_000_000))));
