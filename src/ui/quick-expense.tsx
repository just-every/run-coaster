import { call, fileBase64, today, type D } from './api';
import { Field, Form, Section } from './parts';
import { go } from './app';

/** An expense added without choosing a claim files itself into this month's report, or its trip's (AUTO-001). */
export function QuickExpense({ state, reload, initial, title = 'Add an expense' }: { state: D; reload: () => Promise<unknown>; initial?: D; title?: string }) {
  const categories = state.categories.filter((c: D) => c.active === 1).map((c: D) => ({ value: c.id, label: c.name }));
  const trips = state.requests.filter((r: D) => r.employee_email === state.actor.email && r.status === 'approved').map((r: D) => ({ value: r.id, label: r.title }));
  const schedule = state.business.auto_submit;
  return <Section title={title}>
    <p className="muted">It goes into your report for its month, or for the trip you link it to{schedule ? `, and submits ${schedule === 'twice-monthly' ? 'twice a month' : schedule === 'daily' ? 'each business day' : schedule === 'weekly' ? 'each week' : 'each month'} once it is complete` : ''}.</p>
    <Form label="Add to report" onSubmit={async (v, form) => {
      const file = v.receiptFile as File | undefined;
      const claim = await call('expenses', { kind: 'receipt', date: v.date, merchant: v.merchant, amount: v.amount, allocations: [{ category: v.category }], request: v.request || null, currency: v.currency || state.business.currency, manualRate: v.manualRate || undefined, salesTax: v.salesTax || undefined, receiptFile: file?.size ? { name: file.name, base64: await fileBase64(file), source: 'upload' } : undefined });
      form.reset(); await reload(); go('claims', claim.id);
    }}>
      <Field label="Expense date" name="date" type="date" defaultValue={initial?.date ?? today()} />
      <Field label="Paid to" name="merchant" defaultValue={initial?.merchant} />
      <Field label="Amount paid" name="amount" inputMode="decimal" placeholder="0.00" defaultValue={initial?.amount ?? initial?.total} hint={initial?.currency ?? state.business.currency} />
      {initial && <Field label="Expense currency" name="currency" defaultValue={initial.currency ?? state.business.currency} maxLength={3} />}
      {initial && initial.currency && initial.currency !== state.business.currency && <Field label="Conversion rate" name="manualRate" required={false} inputMode="decimal" hint={`${state.business.currency} for one ${initial.currency}; needed when automatic conversion is off`} />}
      {initial && state.business.sales_tax_account && <Field label="Expense sales tax" name="salesTax" required={false} inputMode="decimal" defaultValue={initial.salesTax} />}
      <Field label="Expense category" name="category" options={categories} />
      {trips.length > 0 && <Field label="Trip" name="request" required={false} options={trips} hint="Its report collects the trip's expenses" />}
      <label className="field field-wide"><span className="field-label">Its receipt (photo or PDF)</span><input type="file" name="receiptFile" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" /></label>
    </Form>
  </Section>;
}
