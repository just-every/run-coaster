import { useEffect, useState } from 'react';
import { apiHref, call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const REPORTS = [['aging', 'Reimbursement aging'], ['cycle-time', 'Approval cycle time'], ['receipts', 'Receipt compliance'], ['unsubmitted', 'Unsubmitted spend for accruals'], ['exceptions', 'Policy exception trends']].map(([value, label]) => ({ value, label }));

const CADENCES = [{ value: 'last-business-day', label: 'Last US business day of each month, month to date' }, { value: 'first-business-day', label: 'First US business day of each month, for the month before' }];
const titleOf = (report: string) => REPORTS.find(r => r.value === report)?.label ?? report;

/** Operational and compliance reports for the owner, finance and auditors, each downloadable as CSV and sent on a schedule (REPORT-002). */
export function Reports({ owner, schedules: canSchedule }: { owner: boolean; schedules: boolean }) {
  const [shown, setShown] = useState<D>(), [query, setQuery] = useState(''), [schedules, setSchedules] = useState<D[]>([]);
  useEffect(() => { call('report-schedules').then(setSchedules, () => setSchedules([])); }, []);
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
    <div className="sub-form"><h3>Scheduled reports</h3>
      <p className="muted">Sent at 8 am business time to finance, auditors or the owner. The email holds a link that needs a Coaster sign-in{owner ? '; only you can choose to attach the figures' : ''}.</p>
      {schedules.length ? <ul className="ruled-list">{schedules.map(s => <li key={s.id} className="job"><span>{titleOf(s.report)} · {CADENCES.find(c => c.value === s.cadence)?.label} · to {s.recipients.join(', ')}{s.include_figures ? ' · figures attached' : ''}{s.stopped_at ? ' · stopped' : ''}</span>{canSchedule && !s.stopped_at && <button className="button small" onClick={async () => setSchedules(await call(`report-schedules/${s.id}/stop`, {}))}>Stop</button>}</li>)}</ul> : <Empty title="No scheduled reports" />}
      {canSchedule && <Form label="Schedule report" onSubmit={async (v, form) => { setSchedules(await call('report-schedules', v)); form.reset(); }}>
        <Field label="Report" name="report" options={REPORTS} defaultValue="unsubmitted" />
        <Field label="Send on" name="cadence" options={CADENCES} defaultValue="last-business-day" />
        <Field label="Recipients" name="recipients" placeholder="finance@example.com" hint="Comma-separated; finance, auditors or the owner" />
        {owner && <Field label="Attach the figures as CSV" name="includeFigures" type="checkbox" />}
      </Form>}
    </div>
  </Section>;
}
