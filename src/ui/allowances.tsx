import { amountText, call, money, type D } from './api';
import { Badge, Empty, Field, Form, Section } from './parts';

const PERIODS = ['monthly', 'quarterly', 'yearly'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const TAX = [{ value: 'accountable', label: 'Accountable plan (not taxed)' }, { value: 'taxable', label: 'Taxable pay' }];

/** Stipends, caps and recurring expenses (CLAIM-009): each employee sees what is left of their allowances and keeps their
 * own recurring expenses; finance and the owner set and stop allowances for one employee or everyone. */
export function Allowances({ state, reload, onNotice }: { state: D; reload: () => Promise<D>; onNotice: (words: string) => void }) {
  const { mine, all, recurring } = state.allowances, currency = state.business.currency, roles = state.actor.roles;
  const setter = roles.finance || roles.owner, categories = state.categories.filter((c: D) => c.active === 1).map((c: D) => ({ value: c.id, label: c.name }));
  const act = async (path: string, body: D, words: string) => { await call(path, body); onNotice(words); await reload(); };
  const who = (a: D) => a.member_email ? state.names[a.member_email] ?? a.member_email : 'Every employee';
  const terms = (a: D) => a.type === 'stipend' ? `${money(a.amount_minor, currency)} ${a.period} stipend · ${a.tax === 'taxable' ? 'taxable pay' : 'accountable plan'}` : `${money(a.amount_minor, currency)} ${a.period} cap`;
  return <Section title="Allowances">
    <p className="muted">A stipend is paid each period as its own claim, without a receipt, through your approver. A cap is claimed against with receipts; anything over what is left is not reimbursed.</p>
    {mine.length ? <ul className="ruled-list">{mine.map((a: D) => <li key={a.id}><strong>{a.name}</strong> · {terms(a)}<br />
      <span className="muted">{a.type === 'cap' ? `${money(a.remaining_minor, currency)} left for ${a.period_key} (${money(a.claimed_minor, currency)} claimed)` : a.paid_this_period ? `Paid for ${a.period_key}` : `Not yet paid for ${a.period_key}`}</span></li>)}</ul>
      : roles.employee && <Empty title="No allowances" />}
    {roles.employee && !state.actor.delegate && <div className="sub-form"><h3>Your recurring expenses</h3>
      <p className="muted">Each period Coaster opens a draft claim for it and asks for that period's receipt.</p>
      {recurring.length > 0 && <ul className="ruled-list">{recurring.map((r: D) => <li key={r.id} className="job"><span>{r.merchant} · {money(r.amount_minor, currency)} {r.period} · {r.category_name}</span>{r.stopped_at ? <Badge status="declined" words="Stopped" /> : <button className="button small" onClick={() => act(`recurring/${r.id}/stop`, {}, 'Recurring expense stopped.')}>Stop</button>}</li>)}</ul>}
      <Form label="Add recurring expense" onSubmit={async (v, form) => { await act('recurring', v, 'Recurring expense saved.'); form.reset(); }}>
        <Field label="Merchant" name="merchant" placeholder="Figma" />
        <Field label="Amount" name="amount" inputMode="decimal" placeholder="0.00" hint={currency} />
        <Field label="Every" name="period" options={PERIODS} defaultValue="monthly" />
        <Field label="Category" name="category" options={categories} />
        <Field label="Starts on" name="startsOn" type="date" required={false} />
        <Field label="Description" name="description" required={false} />
      </Form>
    </div>}
    {setter && <div className="sub-form"><h3>Every allowance</h3>
      {all.length ? <ul className="ruled-list">{all.map((a: D) => <li key={a.id} className="job"><span>{a.name} · {terms(a)} · {who(a)}{a.category_name ? ` · ${a.category_name}` : ''} · from {a.starts_on}</span>{a.stopped_at ? <Badge status="declined" words="Stopped" /> : <button className="button small" onClick={() => act(`allowances/${a.id}/stop`, {}, 'Allowance stopped.')}>Stop</button>}</li>)}</ul> : <Empty title="No allowances set" />}
      <Form label="Save allowance" onSubmit={async (v, form) => { await act('allowances', v, 'Allowance saved.'); form.reset(); }}>
        <Field label="Allowance name" name="name" placeholder="Phone stipend" />
        <Field label="Kind" name="type" options={[{ value: 'stipend', label: 'Stipend paid each period' }, { value: 'cap', label: 'Cap claimed against with receipts' }]} defaultValue="stipend" />
        <Field label="Amount" name="amount" inputMode="decimal" defaultValue={amountText(7500)} hint={currency} />
        <Field label="Every" name="period" options={PERIODS} defaultValue="monthly" />
        <Field label="Employee" name="member" required={false} options={Object.entries(state.names).map(([value, label]) => ({ value, label: String(label) }))} hint="Leave empty for every employee" />
        <Field label="Category" name="category" required={false} options={categories} hint="Where a stipend is coded" />
        <Field label="Tax treatment" name="tax" required={false} options={TAX} hint="For stipends" />
        <Field label="Starts on" name="startsOn" type="date" required={false} />
      </Form>
    </div>}
  </Section>;
}
