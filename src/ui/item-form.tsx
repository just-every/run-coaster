import { useState } from 'react';
import { amountText, call, fileBase64, money, rate, today, type D } from './api';
import { Choice, Field, Form } from './parts';

type Part = { category: string; costCentre: string; amount: string };

/** Add or change one expense: a receipt purchase, mileage or per diem, optionally split across categories. */
export function ItemForm({ claim, state, item, onDone, onCancel }: { claim: D; state: D; item?: D; onDone: () => Promise<void>; onCancel: () => void }) {
  const business = state.business, active = state.categories.filter((c: D) => c.active === 1);
  const [kind, setKind] = useState<string>(item?.kind ?? 'receipt');
  const [split, setSplit] = useState<Part[] | null>(item && item.allocations.length > 1 ? item.allocations.map((a: D) => ({ category: a.category_id, costCentre: a.cost_centre, amount: amountText(a.amount_minor) })) : null);
  const categoryOptions = active.map((c: D) => ({ value: c.id, label: c.name }));
  const kinds = [{ value: 'receipt', label: 'Purchase with receipt' }, ...(business.mileage_rate_thousandths ? [{ value: 'mileage', label: `Mileage at ${rate(business.mileage_rate_thousandths, business.currency)} per mile` }] : []), ...(business.per_diem_minor ? [{ value: 'per_diem', label: `Per diem at ${money(business.per_diem_minor, business.currency)} a day` }] : [])];
  async function save(v: D) {
    let version = claim.version, receipt = item?.receipt_id ?? null;
    const file = v.receiptFile as File | undefined;
    if (file && file.size) {
      const uploaded = await call(`claims/${claim.id}/receipts`, { version, name: file.name, base64: await fileBase64(file), source: 'upload' });
      version = uploaded.claim.version; receipt = uploaded.receipt;
    }
    const allocations = split ? split.map(p => ({ category: p.category, costCentre: p.costCentre, amount: p.amount })) : [{ category: v.category, costCentre: v.costCentre }];
    await call(`claims/${claim.id}/items`, { version, item: item?.id, kind, date: v.date, merchant: v.merchant, amount: v.amount, distance: v.distance, days: v.days, description: v.description, explanation: v.explanation, receipt, allocations });
    await onDone();
  }
  const first = item?.allocations?.[0];
  return <Form label={item ? 'Save expense' : 'Add expense'} className="item-form" onSubmit={save} secondary={<button type="button" className="button" onClick={onCancel}>Cancel</button>}>
    <h3 className="form-title">{item ? 'Change expense' : 'Add an expense'}</h3>
    <Choice label="Type" name="kind" value={kind} onChange={(e: any) => setKind(e.target.value)}>{kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}</Choice>
    <Field label="Date" name="date" type="date" defaultValue={item?.spent_on ?? today()} />
    {kind === 'receipt' && <><Field label="Merchant" name="merchant" defaultValue={item?.merchant} /><Field label="Amount" name="amount" inputMode="decimal" placeholder="0.00" defaultValue={amountText(item?.amount_minor)} hint={business.currency} /></>}
    {kind === 'mileage' && <><Field label="Route" name="merchant" required={false} placeholder="Office to client site" defaultValue={item?.kind === 'mileage' ? item.merchant : ''} /><Field label="Distance (mi)" name="distance" inputMode="decimal" defaultValue={item?.distance_hundredths ? String(item.distance_hundredths / 100) : ''} /></>}
    {kind === 'per_diem' && <><Field label="Location" name="merchant" required={false} defaultValue={item?.kind === 'per_diem' ? item.merchant : ''} /><Field label="Days" name="days" type="number" min="1" max="60" defaultValue={item?.days ?? ''} /></>}
    <Field label="Description" name="description" required={false} defaultValue={item?.description} />
    {split
      ? <fieldset className="split field-wide"><legend>Split across categories</legend>
          {split.map((p, i) => <div className="split-row" key={i}>
            <Choice label={`Category ${i + 1}`} value={p.category} required onChange={(e: any) => setSplit(split.map((x, j) => j === i ? { ...x, category: e.target.value } : x))}><option value="">Choose…</option>{categoryOptions.map((o: D) => <option key={o.value} value={o.value}>{o.label}</option>)}</Choice>
            <label className="field"><span className="field-label">Cost center {i + 1}</span><input value={p.costCentre} onChange={e => setSplit(split.map((x, j) => j === i ? { ...x, costCentre: e.target.value } : x))} /></label>
            <label className="field"><span className="field-label">Amount {i + 1}</span><input inputMode="decimal" required value={p.amount} onChange={e => setSplit(split.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></label>
          </div>)}
          <div className="actions"><button type="button" className="button" onClick={() => setSplit([...split, { category: '', costCentre: '', amount: '' }])}>Add part</button><button type="button" className="button" onClick={() => setSplit(null)}>One category</button></div>
        </fieldset>
      : <><Field label="Category" name="category" options={categoryOptions} defaultValue={first?.category_id} /><Field label="Cost center" name="costCentre" required={false} defaultValue={first?.cost_centre} /><button type="button" className="button link-button field-wide" onClick={() => setSplit([{ category: first?.category_id ?? '', costCentre: first?.cost_centre ?? '', amount: '' }, { category: '', costCentre: '', amount: '' }])}>Split across categories</button></>}
    {kind === 'receipt' && <label className="field field-wide"><span className="field-label">{item?.receipt_id ? 'Replace receipt (the earlier one stays in the history)' : 'Receipt photo or PDF'}</span><input type="file" name="receiptFile" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" /></label>}
    <Field label="Explanation for your approver" name="explanation" type="textarea" required={false} defaultValue={item?.explanation} hint="Needed when an expense breaks policy, for example a missing receipt" />
  </Form>;
}
