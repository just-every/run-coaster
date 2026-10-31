import assert from 'node:assert/strict';
export async function afterStep({ step, result, database }) {
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
export default async function ({ tool }) {
  const response = await tool('coaster.workspace.get', {});
  assert.equal(response.result.isError, false);
}
