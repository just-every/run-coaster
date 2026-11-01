import assert from 'node:assert/strict';
import { api } from './http.mjs';
import { hiddenProposals } from './fixtures.mjs';
import { proposalClient } from './proposals.mjs';
import { discoveryClient, verifyPrompts } from './discovery.mjs';

const preparations = ['coaster.claims.propose', 'coaster.batches.propose'];
const jobs = new Map(), financialStates = new Map();
async function financialState(database) {
  const db = await database('DB');
  return {
    claims: (await db.prepare('SELECT * FROM c_claims ORDER BY id').all()).results,
    batches: (await db.prepare('SELECT * FROM c_batches ORDER BY id').all()).results,
  };
}
async function nativeClient({ request, origin, cookie }, run) {
  const owner = api(request, origin, cookie);
  const key = await (await owner('/api/coaster/agent-keys', { label: 'synthetic-coaster-3535' })).json();
  const client = discoveryClient(request, origin, key.token);
  try { return await run(client, owner); }
  finally { await owner(`/api/coaster/agent-keys/${key.id}/revoke`, {}); }
}
export async function beforeStep(context) {
  const { phase, step, database } = context;
  if (preparations.includes(step.tool)) financialStates.set(`${phase}:${step.id}`, await financialState(database));
  if (!['autonomous', 'held'].includes(phase)) return;
  if (step.id === 'context') {
    const db = await database('DB');
    const before = await financialState(database);
    const proposals = (await db.prepare('SELECT * FROM c_proposals ORDER BY id').all()).results;
    jobs.set(phase, await nativeClient(context, client => verifyPrompts(client)));
    assert.deepEqual(await financialState(database), before, 'Retrieving static job instructions performs no native financial action');
    assert.deepEqual((await db.prepare('SELECT * FROM c_proposals ORDER BY id').all()).results, proposals, 'Static job retrieval creates no proposal and changes no existing proposal');
  }
  if (!['claim', 'batch'].includes(step.id)) return;
  const name = step.id === 'claim' ? 'coaster.claims.prepare' : 'coaster.batches.prepare';
  const instructions = jobs.get(phase).byName.get(name).messages.map(message => message.content.text).join('\n');
  for (const tool of ['coaster.workspace.get', step.tool, 'coaster.proposals.get']) {
    assert.ok(instructions.includes(tool), 'The discovered job names the registered context, preparation and readback tools');
  }
}
async function readPrepared(context) {
  const { phase, result, database } = context;
  const before = await financialState(database);
  await nativeClient(context, async (client, owner) => {
    const params = { name: 'coaster.proposals.get', arguments: { id: result.id } };
    let answer = await client('tools/call', params);
    assert.equal(answer.status, 200);
    if (phase === 'held') {
      assert.equal(answer.result.resultType, 'input_required');
      assert.equal(answer.result.structuredContent, undefined, 'Held readback withholds the proposal until company approval');
      const handle = answer.result._meta['com.runeditrun/approval'];
      assert.equal(new URL(handle.url, context.origin).origin, context.origin);
      const path = `/agents/api/approvals/${encodeURIComponent(handle.id)}`;
      const { approval } = await (await owner(path)).json();
      const decision = answer.result._meta['com.runeditrun/decision'];
      assert.equal(approval.id, handle.id);
      assert.equal(approval.decision_id, decision.id);
      assert.equal(approval.revision, decision.revision);
      assert.match(approval.summary_sha256, /^[a-f0-9]{64}$/);
      assert.equal(approval.state, 'pending');
      const approved = await (await owner(`${path}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 })).json();
      assert.equal(approved.approval.state, 'executed');
      assert.deepEqual(await financialState(database), before, 'Company read approval never accepts, submits or creates a native financial record');
      answer = await client('tools/call', { ...params, requestState: answer.result.requestState });
      assert.equal(answer.status, 200);
    }
    assert.equal(answer.result.isError, false);
    assert.deepEqual(answer.result.structuredContent, result, 'The discovered job reads the same native proposal it prepared');
    assert.equal(answer.result._meta['com.runeditrun/untrusted'], true);
    const db = await database('DB');
    const row = await db.prepare('SELECT * FROM c_proposals WHERE id=?').bind(result.id).first();
    assert.deepEqual({ ...row, payload: JSON.parse(row.payload) }, result, 'Company approval and readback leave the native proposal unchanged');
    assert.equal(row.status, 'proposed');
    assert.equal(row.decided_by, null);
    assert.equal(row.result_id, null, 'Preparing and reading never create an accepted claim or batch');
  });
  assert.deepEqual(await financialState(database), before, 'Job readback preserves all native claims and reimbursement batches');
}
export async function afterStep(context) {
  const { phase, step, result, database } = context;
  if (['coaster.claims.propose', 'coaster.batches.propose'].includes(step.tool)) {
    const db = await database('DB');
    const row = await db.prepare('SELECT * FROM c_proposals WHERE id=?').bind(result.id).first();
    assert.deepEqual({ ...row, payload: JSON.parse(row.payload) }, result, 'Linked preparation returns the unchanged native record');
    assert.equal(row.status, 'proposed');
    assert.equal(row.decided_by, null, 'Company policy grants no native acceptance');
    assert.deepEqual(await financialState(database), financialStates.get(`${phase}:${step.id}`), 'Preparation creates only a proposal, never a native claim or batch');
    financialStates.delete(`${phase}:${step.id}`);
  }
  if (['autonomous', 'held'].includes(phase) && ['claim', 'batch'].includes(step.id)) await readPrepared(context);
  if (!['foreign-claim', 'manual-foreign-claim'].includes(step.id)) return;
  const expected = step.id === 'foreign-claim' ? 1250 : 1200;
  assert.equal(result.payload.items[0].amountMinor, expected, 'Native proposal retains the exact converted amount');
  const db = await database('DB');
  const row = await db.prepare('SELECT payload,status,decided_by,agent_label FROM c_proposals WHERE id=?').bind(result.id).first();
  assert.equal(JSON.parse(row.payload).items[0].amountMinor, expected);
  assert.equal(row.status, 'proposed');
  assert.equal(row.decided_by, null, 'Company approval never becomes native human acceptance');
  assert.equal(row.agent_label, 'Agent door conformance');
}
export default async function ({ tool, request, origin, cookie }) {
  const response = await tool('coaster.workspace.get', {});
  assert.equal(response.result.isError, false);
  const owner = api(request, origin, cookie);
  const key = await (await owner('/api/coaster/agent-keys', { label: 'synthetic-coaster-3512' })).json();
  const client = proposalClient(request, origin, key.token);
  const missing = await client('resources/read', { uri: 'coaster://proposals/synthetic-coaster-3599' });
  assert.equal(missing.error.data.code, 'resource_unavailable');
  assert.ok(hiddenProposals.length);
  for (const id of hiddenProposals) assert.deepEqual(await client('resources/read', { uri: `coaster://proposals/${id}` }), missing);
  await owner(`/api/coaster/agent-keys/${key.id}/revoke`, {});
  assert.equal((await client('resources/templates/list')).status, 401);
}
