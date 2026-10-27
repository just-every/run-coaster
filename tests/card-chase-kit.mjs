import { agency, receipt } from './harness.mjs';

export const apiPath = (...parts) => parts.join('/');
export async function cardChaseFixture(h, { memo = 'Client supplies', required = false, field = 'Client' } = {}) {
  const t = await agency(h);
  await h.post(apiPath('settings', 'business'), { name: 'Harbour & Finch Studio', currency: 'USD', timezone: ['America', 'Chicago'].join('/'), receiptThreshold: '75.00' });
  await h.post(apiPath('settings', 'reminders'), { days: '1,3,5', quietFrom: '20', quietUntil: '8', escalateAfter: '' }, t.morgan);
  const category = required ? (await h.post(apiPath('settings', 'categories'), { name: 'Client supplies', accountCode: '6501', taxCode: 'None', requiredFields: [field] })).id : t.c.office;
  await h.post(apiPath('settings', 'categories'), { name: 'Unrelated category', accountCode: '6599', taxCode: 'None', requiredFields: ['Unrelated field'] });
  await h.post(apiPath('statements', 'cards'), { issuer: 'Synthetic Card', last4: '1201', employee: 'sam@harbourfinch.example' });
  const input = { format: 'ofx', name: 'synthetic-coaster-120.ofx', issuer: 'Synthetic Card', category,
    content: `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>1201</CCACCTFROM><BANKTRANLIST><DTSTART>20260601<DTEND>20260630<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260601<DTUSER>20260529<TRNAMT>-12.00<FITID>synthetic-coaster-120<NAME>Client supplies<MEMO>${memo}</STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>` };
  const preview = await h.post(apiPath('statements', 'preview'), input, t.morgan);
  const result = await h.post(apiPath('statements', 'commit'), { ...input, fingerprint: preview.fingerprint }, t.morgan);
  const id = result.claims[0];
  const detail = () => h.get(`claims/${id}`, t.sam);
  const tick = async (day, hour = 14) => {
    const before = h.messages.length;
    await (await h.mf.getWorker()).scheduled({ scheduledTime: new Date(`${day}T${String(hour).padStart(2, '0')}:17:00Z`), cron: '17 * * * *' });
    return h.messages.slice(before).filter(m => m.subject === 'Reminder: Complete card expense evidence');
  };
  const attach = async () => {
    const d = await detail();
    return h.post(`claims/${id}/receipts`, { version: d.claim.version, item: d.items[0].id, ...(await receipt('officeworks')) }, t.sam);
  };
  const edit = async over => {
    const d = await detail(), i = d.items[0];
    return h.post(`claims/${id}/items`, { version: d.claim.version, item: i.id, kind: 'receipt', date: i.spent_on,
      merchant: i.merchant, amount: '12.00', category, receipt: i.receipt_id, description: i.description, fields: i.fields, ...over }, t.sam);
  };
  const reminders = async () => (await detail()).events.filter(e => e.action === 'reminder-sent' && e.detail.item.startsWith('card-evidence:'));
  return { ...t, id, category, detail, tick, attach, edit, reminders };
}
