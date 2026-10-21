import { useState } from 'react';
import { apiHref, call, money, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const GROUPINGS = [['employee', 'Employee'], ['category', 'Category'], ['merchant', 'Merchant'], ['cost-centre', 'Cost centre'], ['department', 'Department'], ['month', 'Month'], ['card', 'Card']].map(([value, label]) => ({ value, label }));

/** Spend grouped by employee, category, merchant, cost centre or month, drilled to each expense and its receipt, with saved views (REPORT-001). */
export function SpendAnalytics({ currency }: { currency: string }) {
  const [result, setResult] = useState<D>(), [drill, setDrill] = useState<D>(), [views, setViews] = useState<D[]>();
  const run = async (q: Record<string, string>) => { const r = await call(`spend?${new URLSearchParams(q)}`); setResult(r); setViews(r.views); setDrill(undefined); };
  return <Section title="Spend">
    <p className="muted">Submitted and approved spend, plus company-card charges from posting, by expense date. Managers see the people they approve for; finance, auditors and the owner see everyone.</p>
    <Form label="Show spend" onSubmit={v => run({ by: v.by, from: v.from, to: v.to })}>
      <Field label="Group by" name="by" options={GROUPINGS} defaultValue="category" />
      <Field label="Spent from" name="from" type="date" />
      <Field label="Spent until" name="to" type="date" />
    </Form>
    {views && views.length > 0 && <p>Saved views: {views.map(v => <button key={v.id} className="button small" onClick={() => run({ view: v.id })}>{v.name}</button>)}</p>}
    {result && <div className="report">
      {result.groups.length ? <table className="plain"><thead><tr><th>{GROUPINGS.find(g => g.value === result.by)?.label}</th><th className="figure">Approved</th><th className="figure">Pending</th><th className="figure">Total</th><th>Expenses</th></tr></thead><tbody>
        {result.groups.map((g: D) => <tr key={g.key}><td><button className="button small" onClick={async () => setDrill(await call(`spend?${new URLSearchParams({ by: result.by, from: result.from, to: result.to, key: g.key })}`))}>{g.label}</button></td><td className="figure">{money(g.approvedMinor, currency)}</td><td className="figure">{money(g.pendingMinor, currency)}</td><td className="figure">{money(g.totalMinor, currency)}</td><td>{g.expenses}</td></tr>)}
      </tbody></table> : <Empty title="No spend in this period" />}
      <p className="muted">Total {money(result.totalMinor, currency)}</p>
      <div className="sub-form"><Form label="Save view" onSubmit={async (v, form) => { setViews(await call('spend-views', { name: v.name, by: result.by, from: result.from, to: result.to })); form.reset(); }}>
        <Field label="View name" name="name" placeholder="Q1 travel by employee" />
      </Form></div>
    </div>}
    {drill && <div className="report"><h3>{drill.lines.length} {drill.lines.length === 1 ? 'line' : 'lines'} · {money(drill.totalMinor, currency)}</h3>
      <table className="plain"><thead><tr><th>Date</th><th>Claim</th><th>Employee</th><th>Merchant</th><th>Category</th><th className="figure">Amount</th><th>Receipt</th></tr></thead><tbody>
        {drill.lines.map((l: D, i: number) => <tr key={i}><td>{l.date}</td><td><a href={`#/claims/${l.claim}`}>{l.number}</a></td><td>{l.employeeName}</td><td>{l.merchant}</td><td>{l.categoryName}</td><td className="figure">{money(l.amountMinor, currency)}</td><td>{l.receiptLink ? <a href={apiHref(l.receiptLink.replace('/api/coaster/', '') + '?inline=1')} target="_blank" rel="noreferrer">Open</a> : '—'}</td></tr>)}
      </tbody></table></div>}
  </Section>;
}
