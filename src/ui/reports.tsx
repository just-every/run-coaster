import { useState } from 'react';
import { apiHref, call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const REPORTS = [['aging', 'Reimbursement aging'], ['cycle-time', 'Approval cycle time'], ['receipts', 'Receipt compliance'], ['unsubmitted', 'Unsubmitted spend for accruals'], ['exceptions', 'Policy exception trends']].map(([value, label]) => ({ value, label }));

/** Operational and compliance reports for the owner, finance and auditors, each downloadable as CSV (REPORT-002). */
export function Reports() {
  const [shown, setShown] = useState<D>(), [query, setQuery] = useState('');
  return <Section title="Reports">
    <p className="muted">Aging of approved claims not yet paid, approval cycle time per approver, receipt compliance, unsubmitted spend for month-end accruals and policy exception trends. Dates are in the business time zone; both ends count.</p>
    <Form label="Run report" onSubmit={async v => { const q = new URLSearchParams({ ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) }).toString(); setShown(await call(`reports/${v.report}${q ? `?${q}` : ''}`)); setQuery(q); }}>
      <Field label="Report" name="report" options={REPORTS} defaultValue="aging" />
      <Field label="From" name="from" type="date" required={false} hint="Defaults to the first of this month" />
      <Field label="Until" name="to" type="date" required={false} hint="Defaults to today" />
    </Form>
    {shown && <div className="report">
      <h3>{shown.title} · {shown.period.from} to {shown.period.to}</h3>
      {shown.rows.length ? <table className="plain"><thead><tr>{shown.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead><tbody>
        {shown.rows.map((row: unknown[], i: number) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell === null ? '—' : String(cell)}</td>)}</tr>)}
      </tbody></table> : <Empty title="Nothing in this period" />}
      <p><a className="button small" href={apiHref(`reports/${shown.report}?${new URLSearchParams(query)}&format=csv`.replace('?&', '?'))} download>Download {shown.title} CSV</a></p>
    </div>}
  </Section>;
}
