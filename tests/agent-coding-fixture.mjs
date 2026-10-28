import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fixture, setup, manual, simplified, n } from './automatic-coding-quality.mjs';

export const prepare = (h, cookie, claim) => h.post(`${['preparations','expenses'].join('/')}/${claim}`, {}, cookie);
export const confirm = (h, cookie, proposal, status = 200) => h.post(`proposals/${proposal.id}/apply-coding`, { confirm: true, fingerprint: proposal.payload.codingApplication?.fingerprint }, cookie, status);
const stored = (item, t) => simplified({ category: item.allocations.length === 1 ? item.allocations[0].category_id : undefined, dimensions: item.coding }, t);
const sourceFacts = detail => ({ claim: { id: detail.claim.id, employee: detail.claim.employee_email, total: detail.claim.total_minor, status: detail.claim.status, revision: detail.claim.revision }, receipts: detail.receipts, items: detail.items.map(({ coding, codingSuggestions, allocations, project, customer, ...item }) => ({ ...item, allocations: allocations.map(({ category_id, category_name, account_code, tax_code, ledger_account_id, ledger_account_snapshot, ledger_account, ...part }) => part) })) });

export async function codingCorpus(h) {
  const t = await setup(h);
  // Import first: a late rule and subsequent human history must change persisted coding.
  for (let at = 0; at < fixture.cases.length; at += 40) await t.statement(fixture.cases.slice(at, at + 40));
  const ids = [...new Set((await h.get('statements', t.finance)).charges.map(c => c.claim_id))];
  const before = new Map();
  for (const id of ids) { const detail = await h.get(`claims/${id}`, t.sam); before.set(id, detail); }
  const claims = {};
  for (const employee of ['sam', 'alex', 'bea']) claims[employee] = await h.post('claims', { title: n(8100 + Object.keys(claims).length) }, t[employee]);
  for (const row of fixture.history) claims[row.employee] = await manual(h, t, row, claims[row.employee]);
  for (const employee of ['sam', 'alex', 'bea']) await h.post(`claims/${claims[employee].id}/submit`, { version: claims[employee].version }, t[employee]);
  await t.rule(n(1001), t.fields(1)); await t.rule(n(1002), t.fields(2), 'personal', t.sam);
  for (const [mcc, cat] of [['5812', 2], ['5943', 0]]) await h.post(['coding', 'automatic', 'mcc'].join('/'), { version: (await h.get(['coding', 'automatic', 'rules'].join('/'), t.finance)).version, mcc, category: t.cats[cat].id }, t.finance);
  let catalog = await h.get('coding');
  catalog = await h.post(['coding', 'values'].join('/'), { version: catalog.version, id: t.values.account, active: false });
  await h.post(['coding', 'values'].join('/'), { version: catalog.version, id: t.values.class[3], active: false });
  const records = [], proposals = [];
  for (const id of ids) {
    const proposal = await prepare(h, t.sam, id); proposals.push(proposal);
    const unchanged = await h.get(`claims/${id}`, t.sam);
    assert.deepEqual(unchanged, before.get(id), 'preparation writes no expense coding');
    if (proposal.payload.codingApplication.review.entries.some(e => e.changes.length)) await confirm(h, t.sam, proposal);
    else await h.post(`proposals/${proposal.id}/accept`, {}, t.sam);
    const after = await h.get(`claims/${id}`, t.sam);
    assert.deepEqual(sourceFacts(after), sourceFacts(before.get(id)), 'confirmation preserves all source, receipt, amount, split and reimbursement facts');
    for (const item of after.items) {
      const label = fixture.cases.find(r => item.card_transaction_key.endsWith('id:' + r.id)); assert.ok(label);
      const original = before.get(id).items.find(i => i.id === item.id);
      records.push({ id: label.id, kind: label.kind, repeat: label.repeat, actual: stored(item, t), before: stored(original, t), expected: { category: label.category, class: label.class, project: label.project } });
    }
  }
  assert.equal(records.length, 120, 'every fixed charge remains in the measurement');
  const finance = records.filter(r => r.kind === 'finance'), repeat = records.filter(r => r.repeat);
  const financeMatches = finance.filter(r => JSON.stringify(r.actual) === JSON.stringify(r.expected)).length;
  const repeatMatches = repeat.filter(r => r.expected.category !== null && r.actual.category === r.expected.category).length;
  assert.equal(financeMatches, finance.length, 'saved category and dimensions meet every merchant rule');
  assert.ok(repeatMatches / repeat.length >= .9, `${repeatMatches}/${repeat.length} repeat categories, including retired and abstaining cases`);
  assert.ok(records.filter(r => r.kind === 'finance').every(r => r.before.category !== r.actual.category), 'late merchant rules actually change saved allocations');
  assert.ok(records.filter(r => r.kind === 'person').some(r => r.before.category !== r.actual.category), 'new learned history actually changes saved allocations');
  for (const row of records.filter(r => r.expected.category !== null)) assert.deepEqual(row.actual, row.expected, row.id);
  for (const row of records.filter(r => r.expected.category === null)) assert.deepEqual(row.actual, row.before, 'unknown or retired advice leaves coding unchanged');
  return { t, ids, proposals, records, summary: { charges: records.length, merchantRule: { matched: financeMatches, total: finance.length }, repeatCategory: { matched: repeatMatches, total: repeat.length, percent: 100 * repeatMatches / repeat.length } } };
}

