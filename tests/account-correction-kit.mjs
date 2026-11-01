import { agency, receipt } from './harness.mjs';

export const address = name => name + String.fromCharCode(64) + 'harbourfinch.example';
export const correctionPath = c => `claims/${c.id}/account-corrections`;
export const correctionBody = (d, extra = {}) => ({ version: d.claim.version, revision: d.claim.revision, sequence: d.accountCoding.sequence, item: d.revisions.at(-1).snapshot.items[0].id, allocation: 0, accountCode: '6750', reason: 'Use the expense-specific account', ...extra });
export async function correctionClaims(h) {
  const t = await agency(h);
  await h.post(['settings','business'].join('/'), { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: ['Australia','Sydney'].join('/'), perDiem: '75.00', receiptThreshold: '', salesTaxAccount: 'GST paid', salesTaxCode: 'GST' });
  const dimension=await h.post(['coding','dimensions'].join('/'),{version:(await h.get('coding')).version,name:'Client engagement',kind:'tag'});
  const value=await h.post(['coding','values'].join('/'),{version:dimension.version,dimension:dimension.saved,name:'synthetic-coaster-1'});
  const coding={[dimension.saved]:value.saved};
  let number = 0;
  const create = async (title = 'Client materials', cookie = t.sam, { allowance, fixture = 'bistro' } = {}) => {
    let c = await h.post('claims', { title }, cookie);
    const uploaded = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...await receipt(fixture) }, cookie);
    c = await h.post(`claims/${c.id}/items`, { version: uploaded.claim.version, receipt: uploaded.receipt, allowance, coding, kind: 'receipt', date: '2026-03-10', merchant: `${title} ${++number}`, amount: '110.00', salesTax: '10.00', salesTaxAccount: 'GST paid', salesTaxCode: 'GST', allocations: [{ category: t.c.office, amount: '60.00', costCentre: 'Design' }, { category: t.c.travel, amount: '40.00', costCentre: 'Delivery' }], explanation: 'Client materials' }, cookie);
    return h.post(`claims/${c.id}/submit`, { version: c.version }, cookie);
  };
  const approve = c => h.post(`claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved', acknowledge: true }, t.priya);
  return { t, create, approve };
}
