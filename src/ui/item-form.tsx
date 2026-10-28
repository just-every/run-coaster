import { useState } from 'react';
import { amountText, call, fileBase64, money, today, type D } from './api';
import { Choice, Field, Form } from './parts';
import { CodingFields } from './coding';
import { PerDiemFields, perDiemInput } from './per-diem';

type Part = { category: string; costCentre: string; amount: string; description: string };

/** Attendees one per line: "Name <email>" for a colleague, a plain name for a guest. */
const attendeeLines = (attendees: D[] = []) => attendees.map(a => a.kind === 'employee' ? `${a.name} <${a.email}>` : a.name).join('\n');
const parseAttendees = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const colleague = line.match(/^(.*?)\s*<([^>]+)>$/); return colleague ? { kind: 'employee', name: colleague[1], email: colleague[2] } : { kind: 'guest', name: line }; });

/** Add or change one expense: a receipt purchase, mileage or per diem, optionally split across categories. */
export function ItemForm({ claim, state, item, onDone, onCancel }: { claim: D; state: D; item?: D; onDone: () => Promise<void>; onCancel: () => void }) {
  const primary = claim.entity_id === 'primary';
  const business = state.business, active = state.categories.filter((c: D) => c.active === 1 && (c.entity_id ?? 'primary') === claim.entity_id).map((c: D) => ({ ...c, required_fields: [...new Set([...c.required_fields, ...(state.policyFields ?? []).filter((r: D) => r.category === c.id).map((r: D) => r.field)])] }));
  const [date, setDate] = useState(item?.spent_on ?? today());
  const [perDiem, setPerDiem] = useState<D>({ method: item?.per_diem?.method ?? (item?.kind === 'per_diem' ? 'company' : 'gsa'), locationId: item?.per_diem?.locationId ?? '', endDate: item?.per_diem?.endDate ?? today(), component: item?.per_diem?.component ?? 'mie' });
  const [coding, setCoding] = useState<Record<string,string>>(item?.coding ?? {});
  const [category, setCategory] = useState(item?.allocations?.[0]?.category_id ?? '');
  const selectedCatalog = (kind: string) => state.coding.values.find((v: D) => v.id === coding[v.dimension_id] && state.coding.dimensions.some((d: D) => d.id === v.dimension_id && d.kind === kind));
  const [kind, setKind] = useState<string>(item?.kind ?? 'receipt');
  const [currency, setCurrency] = useState<string>(item?.original_currency || business.currency);
  const [split, setSplit] = useState<Part[] | null>(item && item.allocations.length > 1 ? item.allocations.map((a: D) => ({ category: a.category_id, costCentre: a.cost_centre, amount: amountText(a.original_minor ?? a.amount_minor), description: a.description ?? '' })) : null);
  const categoryOptions = active.map((c: D) => ({ value: c.id, label: c.name }));
  // Custom fields the owner requires in any active category, each saying where it is required.
  const fieldNames: string[] = [...new Set<string>(active.flatMap((c: D) => c.required_fields))];
  const requests = (primary ? state.requests : []).filter((r: D) => r.employee_email === claim.employee_email && r.status === 'approved').map((r: D) => ({ value: r.id, label: `SR-${String(r.number).padStart(4, '0')} ${r.title}` }));
  // Caps this employee claims purchases against, with what is left this period (CLAIM-009).
  const caps = primary && claim.employee_email === state.actor.email ? state.allowances.mine.filter((a: D) => a.type === 'cap').map((a: D) => ({ value: a.id, label: `${a.name} · ${money(a.remaining_minor, business.currency)} left for ${a.period_key}` })) : [];
  const kinds = [{ value: 'receipt', label: 'Purchase with receipt' }, ...(primary && business.mileage_rates.length ? [{ value: 'mileage', label: 'Mileage at the rate for its date' }] : []), ...(primary ? [{ value: 'per_diem', label: 'Per diem · location or company rate' }] : [])];
  async function save(v: D) {
    let version = claim.version, receipt = item?.receipt_id ?? null;
    const file = v.receiptFile as File | undefined;
    if (file && file.size) {
      const uploaded = await call(`claims/${claim.id}/receipts`, { version, name: file.name, base64: await fileBase64(file), source: 'upload' });
      version = uploaded.claim.version; receipt = uploaded.receipt;
    }
    const allocations = split ? split.map(p => ({ category: p.category, costCentre: p.costCentre, amount: p.amount, description: p.description })) : [{ category: v.category, costCentre: v.costCentre }];
    const fields = Object.fromEntries(fieldNames.map(name => [name, v[`field:${name}`] ?? '']));
    await call(`claims/${claim.id}/items`, { version, item: item?.id, kind, date: v.date, merchant: v.merchant, currency: kind === 'receipt' ? currency : business.currency, manualRate: v.manualRate, amount: v.amount, salesTax: v.salesTax, distance: v.distance, days: v.days, ...(kind === 'per_diem' && perDiem.method !== 'company' ? { perDiem: perDiemInput(perDiem, v) } : {}), description: v.description, explanation: v.explanation, receipt, allocations, attendees: parseAttendees(v.attendees ?? ''), fields, request: v.request || null, allowance: kind === 'receipt' ? v.allowance || null : null, billable: !!v.billable, customer: v.customer, project: v.project, coding });
    await onDone();
  }
  const first = item?.allocations?.[0];
  return <Form label={item ? 'Save expense' : 'Add expense'} className="item-form" onSubmit={save} secondary={<button type="button" className="button" onClick={onCancel}>Cancel</button>}>
    <h3 className="form-title">{item ? 'Change expense' : 'Add an expense'}</h3>
    <Choice label="Type" name="kind" value={kind} onChange={(e: any) => setKind(e.target.value)}>{kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}</Choice>
    <Field label="Date" name="date" type="date" value={date} onChange={(e: any) => setDate(e.target.value)} />
    {kind === 'receipt' && <>
      <Field label="Merchant" name="merchant" defaultValue={item?.merchant} />
      <Field label="Currency" name="currency" value={currency} maxLength={3} pattern="[A-Za-z]{3}" onChange={(e: any) => setCurrency(e.target.value.toUpperCase())} hint={`Three-letter currency code; reimbursed in ${business.currency}`} />
      <Field label="Amount" name="amount" inputMode="decimal" placeholder="0.00" defaultValue={amountText(item?.original_minor ?? item?.claimed_minor ?? item?.amount_minor)} hint={currency} />
      {currency !== business.currency && <Field label="Exchange rate (optional)" name="manualRate" inputMode="decimal" required={false} pattern="[0-9]+(\.[0-9]{1,12})?" defaultValue={item?.fx_source === 'rate entered by hand' ? item.fx_rate : ''} hint={`1 ${currency} in ${business.currency}, up to 12 decimal places. ${business.fx_enabled ? 'Leave empty to use the ECB reference rate, not your card’s rate. Enter a rate by hand if the reference rate is unavailable.' : 'ECB conversion is off; enter a rate to convert this purchase.'} A supplied rate is shown to your approver as “rate entered by hand”.`} />}
      {business.sales_tax_account && <Field label="Sales tax" name="salesTax" inputMode="decimal" required={false} placeholder="0.00" defaultValue={amountText(item?.original_sales_tax_minor ?? item?.sales_tax_minor) || ''} hint={`Part of the amount in ${currency}; split the rest across categories`} />}
    </>}
    {kind === 'mileage' && <><Field label="Route" name="merchant" required={false} placeholder="Office to client site" defaultValue={item?.kind === 'mileage' ? item.merchant : ''} /><Field label="Distance (mi)" name="distance" inputMode="decimal" defaultValue={item?.distance_hundredths ? String(item.distance_hundredths / 100) : ''} /></>}
    {kind === 'per_diem' && <PerDiemFields date={date} config={perDiem} onChange={setPerDiem} companyRate={business.per_diem_minor} currency={business.currency} fxEnabled={!!business.fx_enabled} item={item} />}
    <Field label="Description" name="description" required={false} defaultValue={item?.description} />
    {!selectedCatalog('customer') && <Field label="Customer" name="customer" required={false} defaultValue={item?.customer} />}
    {!selectedCatalog('project') && <Field label="Project" name="project" required={false} defaultValue={item?.project} />}
    {primary && <CodingFields catalog={state.coding} value={coding} categories={split ? split.map(p => p.category) : [category]} onChange={setCoding} />}
    <Field label="Billable to this customer" name="billable" type="checkbox" required={false} defaultChecked={!!item?.billable} />
    {split
      ? <fieldset className="split field-wide"><legend>Split across categories{kind === 'receipt' ? ` (${currency})` : ''}</legend>
          {split.map((p, i) => <div className="split-row" key={i}>
            <label className="field"><span className="field-label">Item {i + 1}</span><input value={p.description} placeholder={i === 0 ? 'Room, 3 nights' : 'Room tax'} onChange={e => setSplit(split.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></label>
            <Choice label={`Category ${i + 1}`} value={p.category} required onChange={(e: any) => setSplit(split.map((x, j) => j === i ? { ...x, category: e.target.value } : x))}><option value="">Choose…</option>{categoryOptions.map((o: D) => <option key={o.value} value={o.value}>{o.label}</option>)}</Choice>
            <label className="field"><span className="field-label">Cost center {i + 1}</span><input value={p.costCentre} onChange={e => setSplit(split.map((x, j) => j === i ? { ...x, costCentre: e.target.value } : x))} /></label>
            <label className="field"><span className="field-label">Amount {i + 1}</span><input inputMode="decimal" required value={p.amount} onChange={e => setSplit(split.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></label>
          </div>)}
          <div className="actions"><button type="button" className="button" onClick={() => setSplit([...split, { category: '', costCentre: '', amount: '', description: '' }])}>Add part</button><button type="button" className="button" onClick={() => setSplit(null)}>One category</button></div>
        </fieldset>
      : <><Field label="Category" name="category" options={categoryOptions} value={category} onChange={(e: any) => setCategory(e.target.value)} /><Field label="Cost center" name="costCentre" required={false} defaultValue={first?.cost_centre} /><button type="button" className="button link-button field-wide" onClick={() => setSplit([{ category: first?.category_id ?? '', costCentre: first?.cost_centre ?? '', amount: '', description: '' }, { category: '', costCentre: '', amount: '', description: '' }])}>Split or itemize across categories</button></>}
    {kind === 'receipt' && <label className="field field-wide"><span className="field-label">{item?.receipt_id ? 'Replace receipt (the earlier one stays in the history)' : 'Receipt photo or PDF'}</span><input type="file" name="receiptFile" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" /></label>}
    {kind === 'receipt' && <Field label="Attendees" name="attendees" type="textarea" required={false} defaultValue={attendeeLines(item?.attendees)} hint="For meals: one person per line, yourself included; colleagues as Name <email>, guests by name" />}
    {kind === 'receipt' && caps.length > 0 && <Field label="Claim against allowance" name="allowance" required={false} options={caps} defaultValue={item?.allowance_id ?? ''} hint="Reimbursed up to what is left; the rest is flagged and not reimbursed" />}
    {requests.length > 0 && <Field label="Spend request" name="request" required={false} options={requests} defaultValue={item?.request_id ?? ''} hint="Link the expense to the approved request it was for" />}
    {fieldNames.map(name => <Field key={name} label={name} name={`field:${name}`} required={false} defaultValue={item?.fields?.[name] ?? ''} hint={`Required for ${active.filter((c: D) => c.required_fields.includes(name)).map((c: D) => c.name).join(', ')}`} />)}
    <Field label="Explanation for your approver" name="explanation" type="textarea" required={false} defaultValue={item?.explanation} hint="Needed when an expense breaks policy, for example a missing receipt" />
  </Form>;
}
