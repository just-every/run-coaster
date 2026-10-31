import assert from 'node:assert/strict';
import { api } from './http.mjs';
import { hiddenProposals } from './fixtures.mjs';
import { proposalClient } from './proposals.mjs';
export async function afterStep({ step, result, database }) {
  if (['coaster.claims.propose', 'coaster.batches.propose'].includes(step.tool)) {
    const db = await database('DB');
    const row = await db.prepare('SELECT * FROM c_proposals WHERE id=?').bind(result.id).first();
    assert.deepEqual({ ...row, payload: JSON.parse(row.payload) }, result, 'Linked preparation returns the unchanged native record');
    assert.equal(row.status, 'proposed');
    assert.equal(row.decided_by, null, 'Company policy grants no native acceptance');
  }
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
