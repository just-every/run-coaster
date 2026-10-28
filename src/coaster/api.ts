import { assignPlaidAccount, plaidTransactions } from './plaid/accounts';
import { syncPlaid } from './plaid/sync';
import { plaidSettings, savePlaidSettings, createPlaidLink, exchangePlaidLink, plaidConnections, disconnectPlaid } from './plaid/connections';
import { conversation } from './agents/conversation';
import { receiptEmailSettings, saveReceiptEmail, requestReceiptAlias, confirmReceiptAlias, removeReceiptAlias } from './receipts/mail-settings';
import { receiptEmailSource } from './receipts/mail-intake';
import { payrollConnection, connectPayroll, disconnectPayroll, mapPayrollEmployee } from './payroll/connection';
import { payrollReview, sendPayroll, confirmPayroll } from './payroll/handoff';
import { bankProviders, connectBankProvider, disconnectBankProvider, setBankHold } from './bank/connection';
import { bankPeople, cancelBank, completeBank, myBank, refreshBank, startBank, verifyBank } from './bank/accounts';
import { desktopStatus, connectDesktop, disconnectDesktop, syncDesktop, retryDesktop, mapDesktop, desktopSoap, configuration, connection as desktopConnection } from './accounting/desktop';
import { prepareClose, prepareTrip, prepareExpense } from './agents/preparations';
import { receiptQuestion, answerReceiptQuestion } from './receipts/questions';
import { providerCosts, saveProviderCosts } from './provider-costs';
import { investigations, investigationOutcome, investigationFile } from './investigations';
import { suggestReadingCoding } from './receipts/reading-coding';
import { programFeedApi } from './feeds';
import { readingSettings, saveReadingSettings, setReadingMatchDefault, readReceipt, readingDetail, correctReading } from './receipts/reading';
import { automaticRules, saveAutomaticRule } from './coding/automatic/rules';
import { automaticPreview, receiptCoding, suggestionsFor, decideSuggestion } from './coding/automatic/requests';
import { codingRates } from './coding/automatic/rates';
import { publicApi } from './public-api/routes';
import { changeAttachment } from './receipts/attachments';
import { Hono, type Context } from 'hono';
import { deploymentHealth } from '../base/deployment-health';
import { operatorAuth, runtimeBindings, type Bindings } from '../auth.server';
import { agent, need, person } from './session';
import { saveBusiness, saveCategory, saveMember, savePaymentControls } from './settings';
import { accountablePlan, markNonAccountable } from './accountable-plan';
import { saveMileageRate } from './mileage';
import { createClaim, removeItem, renameClaim, saveItem, submitClaim, uploadReceipt } from './claims';
import { decide, reassign } from './decisions';
import { bulkApprove } from './bulk-approvals';
import { retractClaim, unapproveClaim } from './reversals';
import { releaseHold } from './holds';
import { exceptionQueue, recordFinding, reviewException, saveAuditSample } from './audit-queue';
import { saveWorkflow } from './workflow-configuration';
import { saveEnvelope } from './approval-envelopes';
import { reviewFeedback } from './policy-review-feedback';
import { saveApprovalRule } from './auto-approval';
import { report } from './reports';
import { saveReminderSettings } from './reminders';
import { saveSpendView, spend } from './spend';
import { budgetReport, importBudgets, saveBudget } from './budgets';
import { addExpense, saveAutoSubmit } from './auto-reports';
import { confirmExpiry, placeHold, releaseHold as releaseLegalHold, retention, saveRetention } from './retention';
import { eraseMember, erasures } from './erasure';
import { policies, publishPolicy } from './policy';
import { advice, adoptAdvice } from './policy-advice';
import { allowancesFor, saveAllowance, saveRecurring, stopAllowance, stopRecurring } from './allowances';
import { reportSchedules, scheduleReport, stopReportSchedule } from './report-schedules';
import { addComment, editComment } from './comments';
import { revokeDelegation, saveDelegation } from './delegation';
import { actingAs, grantDelegate, revokeDelegate } from './delegates';
import { createRequest, decideRequest, reassignRequest } from './requests';
import { advancesFor, decideAdvance, linkAdvance, payAdvance, recordReturn, requestAdvance } from './advances';
import { approveBatch, createBatch, markReimbursed, releaseBatch, removeFromBatch } from './batches';
import { batchFile, periodFile, saveExportTemplate } from './exports';
import { acceptProposal, createAgentKey, declineProposal, proposal, proposeBatch, proposeClaim, revokeAgentKey } from './agents';
import { batchDetail, claimDetail, receiptFile, workspace } from './views';
import { auditPack, searchHistory } from './audit';
import { claimPdf, batchPdf } from './claim-pdf';
import { carryOpenReport } from './imports/carry';
import { cutoverReport } from './imports/cutover';
import { importAction, importJobs, importedHistory } from './imports/jobs';
import { categories } from './items';
import { business } from './settings';
import { event } from './events';
import { listInbox, receiveReceipt, inboxReceiptFile } from './receipts/inbox';
import { cashWindow, previewCashWindow, saveCashWindow } from './receipts/cash-drafts';
import { discardReceipt, mergeReceipt } from './receipts/lifecycle';
import { reviewReceiptSignal } from './receipt-signal-review';
import { perDiemLocations, pricePerDiem } from './per-diem';
import { assignCard, commitStatement, statementFile, statementState, undoStatement } from './cards/charges';
import { cardMatchQuestion, chooseCardMatch, matchRule, rejectMatchQuestion, saveMatchRule } from './receipts/card-matching';
import { planStatement } from './cards/plan';
import { closeReconciliation, openReconciliation, reconciliation, reconciliations, resolveDifference } from './cards/reconcile';
import { Fault, requireThat, type Actor, type Data } from './types';
import { can, needRow } from './permissions';
import { saveDepartment } from './departments';
import { saveEscalationChain } from './escalation-chains';
import { codingCatalog, codingOptions, saveDimension, saveCodingValue, saveCodingRequirements } from './coding/catalog';
import { importCoding } from './coding/import';
import { qboStatus, startQbo, finishQbo, refreshQbo, saveQboSchedule, disconnectQbo } from './accounting/qbo';

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

api.post('/api/coaster/accounting/desktop/soap', c => desktopSoap(runtimeBindings(c.env),c.req.raw));
api.get('/api/coaster/accounting/desktop', as(async(a,c)=>desktopStatus(db(c),a)));
api.post('/api/coaster/accounting/desktop/connect', as(async(a,c)=>connectDesktop(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/accounting/desktop/disconnect', as(async(a,c)=>disconnectDesktop(db(c),a)));
api.post('/api/coaster/accounting/desktop/sync', as(async(a,c)=>syncDesktop(db(c),a)));
api.post('/api/coaster/accounting/desktop/mappings', as(async(a,c)=>mapDesktop(db(c),a,await body(c))));
api.post('/api/coaster/accounting/desktop/retry/:id', as(async(a,c)=>retryDesktop(db(c),a,param(c,'id'))));
api.get('/api/coaster/accounting/desktop/configuration', as(async(a,c)=>{
  await desktopStatus(db(c),a); needRow(a,'connections');
  const connection=await desktopConnection(db(c)); requireThat(connection,'Connect Desktop first',409);
  return new Response(configuration(runtimeBindings(c.env),connection),{headers:{'content-type':['application','xml'].join('/'),'content-disposition':'attachment; filename="coaster.qwc"','cache-control':'no-store'}});
}));
api.route('/api/coaster/feeds', programFeedApi);
api.get('/api/coaster/settings/provider-costs', as(async(a,c)=>providerCosts(db(c),a)));
api.post('/api/coaster/settings/provider-costs', as(async(a,c)=>saveProviderCosts(db(c),a,await body(c))));
api.get('/api/coaster/investigations', as(async(a,c)=>investigations(db(c),a)));
api.post('/api/coaster/investigations/:id/outcome', as(async(a,c)=>investigationOutcome(db(c),a,param(c,'id'),await body(c))));
api.get('/api/coaster/investigations/:id/download', as(async(a,c)=>investigationFile(db(c),a,param(c,'id'),runtimeBindings(c.env).COASTER_RECEIPTS)));

api.get('/api/coaster/settings/receipt-email', as(async(a,c)=>receiptEmailSettings(db(c),a)));
api.post('/api/coaster/settings/receipt-email', as(async(a,c)=>saveReceiptEmail(db(c),a,await body(c))));
api.post('/api/coaster/settings/receipt-email/aliases', as(async(a,c)=>requestReceiptAlias(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/settings/receipt-email/aliases/confirm', as(async(a,c)=>confirmReceiptAlias(db(c),a,await body(c))));
api.post('/api/coaster/settings/receipt-email/aliases/remove', as(async(a,c)=>removeReceiptAlias(db(c),a,await body(c))));
api.get('/api/coaster/settings/receipt-email/held/:id', as(async(a,c)=>receiptEmailSource(db(c),runtimeBindings(c.env).COASTER_RECEIPTS,a,param(c,'id'),true)));
api.get('/api/coaster/receipt-inbox/:id/source', as(async(a,c)=>receiptEmailSource(db(c),runtimeBindings(c.env).COASTER_RECEIPTS,a,param(c,'id'))));

api.get('/api/coaster/settings/cash-draft-window', as(async (a, c) => cashWindow(db(c), a)));
api.post('/api/coaster/settings/cash-draft-window/preview', as(async (a, c) => previewCashWindow(db(c), a, await body(c))));
api.post('/api/coaster/settings/cash-draft-window', as(async (a, c) => saveCashWindow(db(c), a, await body(c))));

api.get('/api/coaster/settings/card-matching', as(async (a, c) => { needRow(a, 'policy'); return matchRule(db(c)); }));
api.post('/api/coaster/settings/card-matching', as(async (a, c) => saveMatchRule(db(c), a, await body(c))));
api.post('/api/coaster/receipt-inbox/:id/card-match', as(async (a, c) => chooseCardMatch(db(c), a, param(c, 'id'), await body(c))));
api.get('/api/coaster/receipt-inbox/:id/card-match-question', as(async (a, c) => cardMatchQuestion(db(c), a, param(c, 'id'))));
api.post('/api/coaster/receipt-inbox/:id/card-match-reject', as(async (a, c) => rejectMatchQuestion(db(c), a, param(c, 'id'), await body(c))));

api.get('/api/coaster/settings/receipt-reading', as(async (a, c) => readingSettings(db(c), a)));
api.post('/api/coaster/settings/receipt-reading', as(async (a, c) => saveReadingSettings(db(c), a, await body(c))));
api.post('/api/coaster/settings/receipt-reading/matching', as(async (a, c) => setReadingMatchDefault(db(c), a, await body(c))));
api.get('/api/coaster/receipt-inbox/:id/reading', as(async (a, c) => readingDetail(db(c), a, param(c, 'id'))));
api.post('/api/coaster/receipt-inbox/:id/reading', as(async (a, c) => readReceipt(runtimeBindings(c.env), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/receipt-inbox/:id/reading/coding', as(async (a, c) => suggestReadingCoding(runtimeBindings(c.env), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/receipt-inbox/:id/reading/corrections', as(async (a, c) => correctReading(db(c), a, param(c, 'id'), await body(c))));

api.get('/api/coaster/receipt-inbox/:id/question', as(async(a,c)=>{ await readingDetail(db(c),a,param(c,'id')); return {question:await receiptQuestion(db(c),param(c,'id'))}; }));
api.post('/api/coaster/receipt-inbox/:id/question', as(async(a,c)=>answerReceiptQuestion(db(c),a,param(c,'id'),await body(c))));
api.get('/api/coaster/receipt-inbox', as(async (a, c) => listInbox(db(c), a)));
api.post('/api/coaster/receipt-inbox', as(async (a, c) => receiveReceipt(db(c), runtimeBindings(c.env).COASTER_RECEIPTS, a, c.req.raw)));
api.post('/api/coaster/receipt-inbox/:id/discard', as(async (a, c) => discardReceipt(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/receipt-inbox/:id/merge', as(async (a, c) => mergeReceipt(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/receipt-inbox/:id/attach', as(async (a, c) => changeAttachment(db(c), a, param(c, 'id'), await body(c), false)));
api.post('/api/coaster/receipt-inbox/:id/detach', as(async (a, c) => changeAttachment(db(c), a, param(c, 'id'), await body(c), true)));
api.get('/api/coaster/receipt-inbox/:id', as(async (a, c) => inboxReceiptFile(db(c), runtimeBindings(c.env).COASTER_RECEIPTS, a, param(c, 'id'), c.req.query('inline') === '1')));

api.get('/api/coaster/state', as(async (a, c) => workspace(db(c), a)));
api.get('/api/coaster/claims/:id', as(async (a, c) => claimDetail(db(c), a, param(c, 'id'))));
api.get('/api/coaster/claims/:id/pdf', as(async (a, c) => claimPdf(db(c), a, param(c, 'id'), c.req.query('customer'), c.req.query('project'), runtimeBindings(c.env).COASTER_RECEIPTS)));
api.post('/api/coaster/claims', as(async (a, c) => createClaim(db(c), a, await body(c))));
api.post('/api/coaster/expenses', as(async (a, c) => addExpense(db(c), a, await body(c))));
api.post('/api/coaster/claims/:id/title', as(async (a, c) => renameClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/items', as(async (a, c) => saveItem(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/items/remove', as(async (a, c) => removeItem(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/receipts', as(async (a, c) => uploadReceipt(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/receipt-signals/review', as(async (a, c) => reviewReceiptSignal(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/submit', as(async (a, c) => submitClaim(db(c), a, param(c, 'id'), await body(c), runtimeBindings(c.env).COASTER_RECEIPTS)));
api.post('/api/coaster/claims/:id/decision', as(async (a, c) => decide(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/approvals/bulk', as(async (a, c) => bulkApprove(db(c), a, await body(c))));
api.post('/api/coaster/claims/:id/retract', as(async (a, c) => retractClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/unapprove', as(async (a, c) => unapproveClaim(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/comments', as(async (a, c) => addComment(db(c), runtimeBindings(c.env), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/comments/:id/edit', as(async (a, c) => editComment(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/release', as(async (a, c) => releaseHold(db(c), a, param(c, 'id'), await body(c), runtimeBindings(c.env).COASTER_RECEIPTS)));
api.post('/api/coaster/claims/:id/reassign', as(async (a, c) => reassign(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/requests', as(async (a, c) => createRequest(db(c), a, await body(c))));
api.post('/api/coaster/requests/:id/reassign', as(async (a,c) => reassignRequest(db(c),a,param(c,'id'),await body(c))));
api.post('/api/coaster/requests/:id/decision', as(async (a, c) => decideRequest(db(c), a, param(c, 'id'), await body(c))));
api.get('/api/coaster/advances', as(async (a, c) => advancesFor(db(c), a)));
api.post('/api/coaster/advances', as(async (a, c) => requestAdvance(db(c), a, await body(c))));
api.post('/api/coaster/advances/:id/decision', as(async (a, c) => decideAdvance(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/advances/:id/paid', as(async (a, c) => payAdvance(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/advances/:id/return', as(async (a, c) => recordReturn(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/claims/:id/advance', as(async (a, c) => linkAdvance(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/delegations', as(async (a, c) => saveDelegation(db(c), a, await body(c))));
api.post('/api/coaster/delegations/:id/revoke', as(async (a, c) => revokeDelegation(db(c), a, param(c, 'id'))));
api.post('/api/coaster/delegates', as(async (a, c) => grantDelegate(db(c), runtimeBindings(c.env), a, await body(c))));
api.post('/api/coaster/delegates/:id/revoke', as(async (a, c) => revokeDelegate(db(c), a, param(c, 'id'))));
api.get('/api/coaster/receipts/:id', as(async (a, c) => receiptFile(db(c), a, param(c, 'id'), c.req.query('inline') === '1', runtimeBindings(c.env).COASTER_RECEIPTS)));

api.post('/api/coaster/settings/business', as(async (a, c) => saveBusiness(db(c), a, await body(c))));
api.post('/api/coaster/settings/mileage-rates', as(async (a, c) => saveMileageRate(db(c), a, await body(c))));
api.post('/api/coaster/settings/categories', as(async (a, c) => saveCategory(db(c), a, await body(c))));
api.post('/api/coaster/settings/departments', as(async (a, c) => saveDepartment(db(c), a, await body(c))));
api.post('/api/coaster/settings/escalation-chains', as(async (a, c) => saveEscalationChain(db(c), a, await body(c))));
/** A Coaster admin signs in as a Base `admin` operator, which is what lets them send sign-in invitations (never to another admin);
 * only the owner moves that role, so it follows the admin flag when the owner saves a person who already has an account. */
api.post('/api/coaster/settings/members', as(async (a, c) => {
  const saved = await saveMember(db(c), a, await body(c)) as Data | null;
  if (saved && a.roles.owner && !a.delegate) {
    const account = await db(c).prepare("SELECT id,role FROM oa_operators WHERE lower(email)=? AND status='active'").bind(saved.email).first<{ id: string; role: string }>();
    const want = saved.is_admin === 1 && saved.active === 1 ? 'admin' : 'member';
    if (account && account.role !== 'owner' && account.role !== want) await operatorAuth(runtimeBindings(c.env)).setRole(c.req.raw, account.id, want);
  }
  return saved;
}));
api.post('/api/coaster/settings/members/invite', as(async (a, c) => {
  needRow(a, 'people');
  const b = await body(c), member = await db(c).prepare('SELECT email,name,is_admin FROM c_members WHERE email=? AND active=1').bind(String(b.email ?? '').toLowerCase()).first<{ email: string; name: string; is_admin: number }>();
  requireThat(member, 'Save the member before inviting them', 404);
  requireThat(a.roles.owner || !member.is_admin, 'Only the owner invites another admin', 403);
  const sent = await operatorAuth(runtimeBindings(c.env)).invite(c.req.raw, { email: member.email, displayName: member.name, role: member.is_admin ? 'admin' : 'member', returnTo: '/app' });
  // Recorded only once the sign-in link was handed to the mail provider; a refused invitation adds nothing (AUDIT-001).
  await event(db(c), a, 'member-invited', {}, { email: member.email }).run();
  return sent;
}));

api.get('/api/coaster/batches/:id', as(async (a, c) => batchDetail(db(c), a, param(c, 'id'))));
api.get('/api/coaster/batches/:id/pdf', as(async (a, c) => batchPdf(db(c), a, param(c, 'id'), c.req.query('customer'), c.req.query('project'), runtimeBindings(c.env).COASTER_RECEIPTS)));
api.post('/api/coaster/batches', as(async (a, c) => createBatch(db(c), a, await body(c))));
api.post('/api/coaster/batches/:id/remove', as(async (a, c) => removeFromBatch(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/batches/:id/approve', as(async (a, c) => approveBatch(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/batches/:id/release', as(async (a, c) => releaseBatch(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/batches/:id/paid', as(async (a, c) => markReimbursed(db(c), a, param(c, 'id'), await body(c))));
const file = (c: C) => param(c, 'file').split('.') as [string, string];
api.get('/api/coaster/batches/:id/:file{(accounting|reimbursements)\\.(csv|xlsx)|accounting\\.iif}', as(async (a, c) => batchFile(db(c), a, param(c, 'id'), ...file(c), c.req.query('template') || undefined, runtimeBindings(c.env).AUTH_ORIGIN)));
api.get('/api/coaster/exports/:file{(accounting|reimbursements)\\.(csv|xlsx)|accounting\\.iif}', as(async (a, c) => periodFile(db(c), a, ...file(c), c.req.query(), runtimeBindings(c.env).AUTH_ORIGIN)));
api.post('/api/coaster/export-templates', as(async (a, c) => saveExportTemplate(db(c), a, await body(c))));

api.post('/api/coaster/agent-keys', as(async (a, c) => createAgentKey(db(c), a, await body(c))));
api.post('/api/coaster/agent-keys/:id/revoke', as(async (a, c) => revokeAgentKey(db(c), a, param(c, 'id'))));
api.post('/api/coaster/conversation', as(async (a, c) => conversation(db(c), a, await body(c, 8_000_000))));
api.post('/api/coaster/preparations/close', as(async (a, c) => prepareClose(db(c), a, await body(c))));
api.post('/api/coaster/preparations/trip', as(async (a, c) => prepareTrip(db(c), a, await body(c))));
api.post('/api/coaster/preparations/expenses/:id', as(async (a, c) => prepareExpense(db(c), a, param(c, 'id'))));
api.post('/api/coaster/proposals/:id/accept', as(async (a, c) => acceptProposal(db(c), a, param(c, 'id'))));
api.post('/api/coaster/proposals/:id/decline', as(async (a, c) => declineProposal(db(c), a, param(c, 'id'), await body(c))));

api.get('/api/coaster/agent/context', asAgent(async (a, c) => ({
  for: { email: a.email, name: a.name, roles: a.roles }, agent: a.agentLabel, business: await business(db(c)), categories: (await categories(db(c))).filter(x => x.active === 1),
  approvedClaims: a.roles.finance ? (await db(c).prepare("SELECT id,number,employee_email,title,total_minor,currency FROM c_claims WHERE status='approved' ORDER BY number").all()).results : [],
  proposals: (await db(c).prepare('SELECT id,kind,status,created_at,decided_at,result_id FROM c_proposals WHERE for_email=? ORDER BY created_at DESC LIMIT 50').bind(a.email).all()).results,
})));
api.get('/api/coaster/agent/proposals/:id', asAgent(async (a, c) => { const p = await proposal(db(c), param(c, 'id')); requireThat(p.for_email === a.email && !p.payload.preparation && !p.payload.nativeConversation, 'Proposal not found', 404); return p; }));
api.post('/api/coaster/agent/claims', asAgent(async (a, c) => proposeClaim(db(c), a, await body(c, 8_000_000))));
api.post('/api/coaster/agent/batches', asAgent(async (a, c) => proposeBatch(db(c), a, await body(c))));

api.get('/api/coaster/accountable-plan', as(async (a, c) => accountablePlan(db(c), a)));
api.post('/api/coaster/claims/:id/items/:item/accountable-plan', as(async (a, c) => markNonAccountable(db(c), a, param(c, 'id'), param(c, 'item'), await body(c))));
api.get('/api/coaster/exceptions', as(async (a, c) => exceptionQueue(db(c), a, c.req.query('sort'))));
api.post('/api/coaster/exceptions/review', as(async (a, c) => reviewException(db(c), a, await body(c))));
api.post('/api/coaster/settings/approval-workflow', as(async (a, c) => saveWorkflow(db(c), a, await body(c))));
api.post('/api/coaster/settings/approval-envelope', as(async (a,c)=>saveEnvelope(db(c),a,await body(c))));
api.post('/api/coaster/claims/:id/policy-review-feedback', as(async (a,c)=>reviewFeedback(db(c),a,param(c,'id'),await body(c))));
api.post('/api/coaster/settings/approval-rule', as(async (a, c) => saveApprovalRule(db(c), a, await body(c))));
api.post('/api/coaster/settings/payment-controls', as(async (a, c) => savePaymentControls(db(c), a, await body(c))));
api.post('/api/coaster/settings/auto-submit', as(async (a, c) => saveAutoSubmit(db(c), a, await body(c))));
api.post('/api/coaster/settings/retention', as(async (a, c) => saveRetention(db(c), a, await body(c))));
api.get('/api/coaster/retention', as(async (a, c) => ({ ...await retention(db(c), a), erasures: await erasures(db(c)) })));
api.get('/api/coaster/policy', as(async (a, c) => { requireThat(can(a, 'policy') || a.roles.auditor, 'Owner, admin, finance or auditor access required', 403); return { versions: await policies(db(c)) }; }));
api.post('/api/coaster/policy', as(async (a, c) => { const settings = await business(db(c)); requireThat(settings, 'The owner has not set up the business yet', 409); return { versions: await publishPolicy(db(c), a, await body(c), await categories(db(c)), settings.timezone) }; }));
api.post('/api/coaster/policy/advice', as(async (a, c) => advice(db(c), a, await body(c))));
api.post('/api/coaster/policy/advice/adopt', as(async (a, c) => adoptAdvice(db(c), a, await body(c))));
api.post('/api/coaster/settings/members/erase', as(async (a, c) => eraseMember(db(c), a, await body(c))));
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
api.get('/api/coaster/audit-pack', as(async (a, c) => auditPack(db(c), a, c.req.query('from'), c.req.query('to'), runtimeBindings(c.env).COASTER_RECEIPTS)));

// FEED-002 statement-file import: preview writes nothing, commit applies exactly the previewed file, undo reverses untouched charges.
api.get('/api/coaster/statements', as(async (a, c) => statementState(db(c), a)));
api.get('/api/coaster/statements/:id/file', as(async (a, c) => statementFile(db(c), a, param(c, 'id'))));
api.post('/api/coaster/statements/cards', as(async (a, c) => assignCard(db(c), a, await body(c))));
api.post('/api/coaster/statements/preview', as(async (a, c) => { needRow(a, 'connections'); requireThat(a.kind === 'person', 'Only a person imports statements', 403); return (await planStatement(db(c), await body(c, 2_500_000))).review; }));
api.post('/api/coaster/statements/commit', as(async (a, c) => commitStatement(db(c), a, await body(c, 2_500_000))));
api.post('/api/coaster/statements/:id/undo', as(async (a, c) => undoStatement(db(c), a, param(c, 'id'))));
// FEED-005 statement reconciliation: finance opens a card's statement period, settles each listed difference, and closes it into the card ledger.
api.get('/api/coaster/statements/reconciliations', as(async (a, c) => reconciliations(db(c), a)));
api.get('/api/coaster/statements/reconciliations/:id', as(async (a, c) => reconciliation(db(c), a, param(c, 'id'))));
api.post('/api/coaster/statements/:id/reconcile', as(async (a, c) => openReconciliation(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/statements/reconciliations/:id/resolve', as(async (a, c) => resolveDifference(db(c), a, param(c, 'id'), await body(c))));
api.post('/api/coaster/statements/reconciliations/:id/close', as(async (a, c) => closeReconciliation(db(c), a, param(c, 'id'))));

api.get('/api/coaster/import/cutover', as(async (a, c) => cutoverReport(db(c), a)));
api.get('/api/coaster/import', as(async (a, c) => { need(a, 'owner'); return { jobs: await importJobs(db(c)), history: await importedHistory(db(c)) }; }));
api.post('/api/coaster/import/carry', as(async (a, c) => carryOpenReport(db(c), a, await body(c))));
api.post('/api/coaster/import/:op', as(async (a, c) => importAction(db(c), a, param(c, 'op'), await body(c, 8_000_000))));

// CLAIM-002 reference lookups and nonwriting trip preview use the same pricing as saved expenses.
api.get('/api/coaster/per-diem/locations', as(async (a, c) => { need(a, 'employee'); return perDiemLocations(c.req.query('method')); }));
api.post('/api/coaster/per-diem/quote', as(async (a, c) => { need(a, 'employee'); const b = await body(c); return pricePerDiem(b.date, b.perDiem); }));

api.get('/api/coaster/coding', as(async (_a, c) => codingCatalog(db(c))));
api.get('/api/coaster/coding/options', as(async (_a, c) => codingOptions(await codingCatalog(db(c)), c.req.query('dimension') ?? '', c.req.query('parent') ?? '')));
api.post('/api/coaster/coding/dimensions', as(async (a, c) => saveDimension(db(c), a, await body(c))));
api.post('/api/coaster/coding/values', as(async (a, c) => saveCodingValue(db(c), a, await body(c))));
api.post('/api/coaster/coding/requirements', as(async (a, c) => saveCodingRequirements(db(c), a, await body(c))));
api.post('/api/coaster/coding/import', as(async (a, c) => importCoding(db(c), a, await body(c))));

api.get('/api/coaster/accounting/qbo', as(async (a, c) => qboStatus(runtimeBindings(c.env), a)));
api.post('/api/coaster/accounting/qbo/connect', as(async (a, c) => startQbo(runtimeBindings(c.env), a, await body(c))));
api.get('/api/coaster/accounting/qbo/callback', as(async (a, c) => {
  c.header('referrer-policy', 'no-referrer');
  await finishQbo(runtimeBindings(c.env), a, new URL(c.req.url));
  return c.redirect('/app#/settings', 303);
}));
api.post('/api/coaster/accounting/qbo/refresh', as(async (a, c) => refreshQbo(runtimeBindings(c.env), a)));
api.post('/api/coaster/accounting/qbo/schedule', as(async (a, c) => saveQboSchedule(runtimeBindings(c.env), a, await body(c))));
api.post('/api/coaster/accounting/qbo/disconnect', as(async (a, c) => disconnectQbo(runtimeBindings(c.env), a, await body(c))));

api.route('/api/coaster/public-api', publicApi);

api.get('/api/coaster/coding/automatic/rules', as(async (a,c)=>automaticRules(db(c),a)));
api.post('/api/coaster/coding/automatic/rules', as(async (a,c)=>saveAutomaticRule(db(c),a,await body(c))));
api.post('/api/coaster/coding/automatic/mcc', as(async (a,c)=>saveAutomaticRule(db(c),a,await body(c),'mcc')));
api.post('/api/coaster/coding/automatic/preview', as(async (a,c)=>automaticPreview(db(c),a,await body(c))));
api.get('/api/coaster/coding/automatic/suggestions', as(async (a,c)=>suggestionsFor(db(c),a,c.req.query())));
api.post('/api/coaster/coding/automatic/suggestions/:id/decision', as(async (a,c)=>decideSuggestion(db(c),a,param(c,'id'),await body(c))));
api.post('/api/coaster/coding/automatic/receipts/:id', as(async (a,c)=>receiptCoding(db(c),a,param(c,'id'),await body(c))));
api.get('/api/coaster/coding/automatic/rates', as(async (a,c)=>codingRates(db(c),a)));

api.get('/api/coaster/payroll/gusto', as(async (a,c)=>payrollConnection(runtimeBindings(c.env),a)));
api.post('/api/coaster/payroll/gusto/connect', as(async (a,c)=>connectPayroll(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/payroll/gusto/disconnect', as(async (a,c)=>disconnectPayroll(runtimeBindings(c.env),a)));
api.post('/api/coaster/payroll/gusto/employees', as(async (a,c)=>mapPayrollEmployee(runtimeBindings(c.env),a,await body(c))));
api.get('/api/coaster/bank', as(async (a,c)=>myBank(runtimeBindings(c.env),a)));
api.get('/api/coaster/bank/people', as(async (a,c)=>bankPeople(runtimeBindings(c.env),a)));
api.post('/api/coaster/bank/start', as(async (a,c)=>startBank(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/bank/complete', as(async (a,c)=>completeBank(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/bank/verify', as(async (a,c)=>verifyBank(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/bank/refresh', as(async (a,c)=>refreshBank(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/bank/cancel', as(async (a,c)=>cancelBank(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/bank/hold-period', as(async (a,c)=>setBankHold(runtimeBindings(c.env),a,await body(c))));
api.get('/api/coaster/bank/providers', as(async (a,c)=>bankProviders(runtimeBindings(c.env),a)));
api.post('/api/coaster/bank/providers/connect', as(async (a,c)=>connectBankProvider(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/bank/providers/disconnect', as(async (a,c)=>disconnectBankProvider(runtimeBindings(c.env),a,await body(c))));
api.get('/api/coaster/batches/:id/payroll', as(async (a,c)=>payrollReview(runtimeBindings(c.env),a,param(c,'id'))));
api.post('/api/coaster/batches/:id/payroll', as(async (a,c)=>sendPayroll(runtimeBindings(c.env),a,param(c,'id'),await body(c))));
api.post('/api/coaster/batches/:id/payroll/confirm', as(async (a,c)=>confirmPayroll(runtimeBindings(c.env),a,param(c,'id'))));

api.get('/api/coaster/plaid/settings', as(async(a,c)=>plaidSettings(runtimeBindings(c.env),a)));
api.post('/api/coaster/plaid/settings', as(async(a,c)=>savePlaidSettings(runtimeBindings(c.env),a,await body(c))));
api.get('/api/coaster/plaid/connections', as(async(a,c)=>plaidConnections(runtimeBindings(c.env),a)));
api.post('/api/coaster/plaid/link', as(async(a,c)=>createPlaidLink(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/plaid/exchange', as(async(a,c)=>exchangePlaidLink(runtimeBindings(c.env),a,await body(c))));
api.post('/api/coaster/plaid/connections/:id/assign', as(async(a,c)=>assignPlaidAccount(runtimeBindings(c.env),a,param(c,'id'),await body(c))));
api.get('/api/coaster/plaid/connections/:id/transactions', as(async(a,c)=>plaidTransactions(runtimeBindings(c.env),a,param(c,'id'))));
api.post('/api/coaster/plaid/connections/:id/sync', as(async(a,c)=>syncPlaid(runtimeBindings(c.env),a,param(c,'id'))));
api.post('/api/coaster/plaid/connections/:id/disconnect', as(async(a,c)=>disconnectPlaid(runtimeBindings(c.env),a,param(c,'id'))));
