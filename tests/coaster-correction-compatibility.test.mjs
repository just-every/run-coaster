import { validateAccountCorrectionsArchive } from '../scripts/installer/account-corrections-archive.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { correctionClaims, correctionBody, correctionPath } from './account-correction-kit.mjs';
import { validateAccountingCorrectionsArchive } from '../scripts/installer/accounting-corrections-archive.mjs';

test('Both correction doors retain their history and freeze the latest effective code in either order', async () => {
  for (const legacyLast of [false, true]) {
    const h = await harness();
    try {
      const { create, approve } = await correctionClaims(h);
      let claim = await create();
      const original = (await h.get(`claims/${claim.id}`)).revisions;
      for (const legacy of legacyLast ? [false, true] : [true, false]) {
        const detail = await h.get(`claims/${claim.id}`);
        const body = correctionBody(detail, { accountCode: legacy ? '6781' : '6782' });
        if (!legacy) body.sequence = 0;
        claim = await h.post(legacy ? correctionPath(claim) : `claims/${claim.id}/coding-corrections`, body);
      }
      claim = await approve(claim);
      const batch = await h.post('batches', { claims: [claim.id] });
      const detail = await h.get(`claims/${claim.id}`);
      assert.deepEqual(detail.revisions, original);
      assert.equal(detail.accountCoding.corrections.length, 1);
      assert.equal(detail.codingCorrections.length, 1);
      const lines = (await h.get(`batches/${batch.id}`)).lines;
      assert.equal(lines[0].account, legacyLast ? '6781' : '6782');
      await validateAccountCorrectionsArchive(async table => (await h.db.prepare(`SELECT * FROM ${table}`).all()).results);
      await validateAccountingCorrectionsArchive(async table => (await h.db.prepare(`SELECT * FROM ${table}`).all()).results);
    } finally { await h.close(); }
  }
});
