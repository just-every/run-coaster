import { useEffect, useState } from 'react';
import { amountText, call, money, type D } from './api';
import { Empty, Field, Form, Section } from './parts';
import { offered } from './coding';

const SCOPES = [{ value: 'entity', label: 'Whole business' }, { value: 'category', label: 'Category' }, { value: 'cost-centre', label: 'Cost centre' }, { value: 'department', label: 'Department' }, { value: 'project', label: 'Project' }, { value: 'tag', label: 'Tag' }];
const PERIODS = ['monthly', 'quarterly', 'yearly'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

/** Budgets with their actual for this period, approved and pending apart; finance and the owner set them (REPORT-004). */
export function Budgets({ state, canSet }: { state: D; canSet: boolean }) {
  const [list, setList] = useState<D[]>(), [notice, setNotice] = useState(''), currency = state.business.currency;
  useEffect(() => { call('budgets').then(setList, () => setList([])); }, []);
  const line = (r: D) => `${money(r.actualMinor, currency)} of ${money(r.budgetMinor, currency)} (${r.percent}%) · approved ${money(r.approvedMinor, currency)}, pending ${money(r.pendingMinor, currency)} · ${money(r.remainingMinor, currency)} left`;
  return <Section title="Budgets">
    <p className="muted">Out-of-pocket spend counts from submission; company-card spend counts from posting, by expense date. Each alert goes once a period to the budget's owner and finance, naming the percentage and period; only the owner can add the amounts.</p>
    <p className="notice" role="status" aria-live="polite">{notice}</p>
    {list?.length ? <ul className="ruled-list">{list.map(b => <li key={b.id}><strong>{b.name}</strong>{['project','tag'].includes(b.scope) ? ` · ${state.coding.values.find((v: D) => v.id === b.scope_key)?.name ?? b.scope_key}` : ''}{b.scope === 'department' ? ` · ${state.departments.find((d: D) => d.id === b.scope_key)?.name ?? 'department'}${b.scope_category ? ` · ${state.categories.find((c: D) => c.id === b.scope_category)?.name ?? ''}` : ''}` : ''} · {b.period} · {b.period_key} · v{b.version}{b.per_member ? ' · per person' : ''}<br />
      {b.members ? b.members.length ? b.members.map((m: D) => <span key={m.member} className="muted">{m.member}: {line(m)}<br /></span>) : <span className="muted">No spend yet</span> : <span className="muted">{line(b)}</span>}</li>)}</ul> : <Empty title="No budgets" />}
    {canSet && <div className="sub-form"><h3>Add a budget</h3><Form label="Save budget" onSubmit={async (v, form) => { setList(await call('budgets', { ...v, scopeKey: v.scope === 'department' ? v.department : ['project','tag'].includes(v.scope) ? v.codingValue : v.scopeKey })); form.reset(); setNotice('Budget saved.'); }}>
      <Field label="Budget name" name="name" placeholder="Travel" />
      <Field label="Covers" name="scope" options={SCOPES} defaultValue="category" />
      <Field label="Category or cost centre" name="scopeKey" required={false} placeholder="Category id or cost centre" hint={`Categories: ${state.categories.map((c: D) => `${c.name} (${c.id})`).join(', ')}`} />
      <Field label="Project or tag" name="codingValue" required={false} options={state.coding.values.filter((v: D) => offered(state.coding, v) && state.coding.dimensions.some((d: D) => d.id === v.dimension_id && ['project','tag'].includes(d.kind))).map((v: D) => ({ value: v.id,label: `${state.coding.dimensions.find((d: D) => d.id === v.dimension_id)?.name}: ${v.name}` }))} hint="When the budget covers a project or tag" />
      <Field label="Department" name="department" required={false} options={state.departments.filter((d: D) => d.active).map((d: D) => ({ value: d.id, label: d.name }))} hint="When the budget covers a department" />
      <Field label="Narrow a department budget to category" name="category" required={false} options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} hint="For example Sales travel" />
      <Field label="Period" name="period" options={PERIODS} defaultValue="monthly" />
      <Field label="Amount" name="amount" inputMode="decimal" defaultValue={amountText(500000)} />
      <Field label="Owner" name="owner" type="email" defaultValue={state.actor.email} />
      <Field label="Alert at (%)" name="thresholds" defaultValue="80, 100" />
      <Field label="Per person" name="perMember" type="checkbox" />
      <Field label="Mark expenses that would go over as an exception" name="policyRule" type="checkbox" />
      {state.actor.roles.owner && <Field label="Include amounts in alert emails" name="alertAmounts" type="checkbox" />}
    </Form></div>}
  </Section>;
}
