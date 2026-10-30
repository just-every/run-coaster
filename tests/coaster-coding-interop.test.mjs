import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { correctionClaims, correctionPath, correctionBody } from './account-correction-kit.mjs';

test('Both native correction doors export the latest audited allocation and freeze both histories', async () => {
  const h = await harness();
  try {
    const { create, approve, t } = await correctionClaims(h);
    let c = await create();
    const broader = async code => {
      const d = await h.get(`claims/${c.id}/accounting-coding`);
      const result = await h.post(`claims/${c.id}/accounting-coding`, { version:c.version,revision:c.revision,item:d.original[0].id,sequence:d.corrections.at(-1)?.sequence??0,accounts:[code,'6600'],reason:'Correct the native account' });
      c = result.claim;
    };
    await broader('7000');
    let d = await h.get(`claims/${c.id}`);
    c = await h.post(correctionPath(c),correctionBody(d,{accountCode:'7100'}));
    assert.equal((await h.get(`claims/${c.id}/accounting-coding`)).effective[0].allocations[0].account_code,'7100');
    await broader('7200');
    c = await approve(c);
    let batch = await h.post('batches',{claims:[c.id]},t.morgan);
    batch = await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:batch.total_minor});
    const csv = await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`,undefined,t.morgan);
    assert.equal(csv.status,200);assert.ok(csv.text.includes('7200'));assert.ok(!csv.text.includes('7100'));
    assert.equal((await h.get(`claims/${c.id}`)).accountCoding.corrections.length,1);
    assert.equal((await h.get(`claims/${c.id}/accounting-coding`)).corrections.length,2);
  } finally { await h.close(); }
});
