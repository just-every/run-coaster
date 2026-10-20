import { money, type D } from './api';
import { Empty, Section } from './parts';

const words: Record<string, string> = { 'open-history': 'Open in source · not carried', 'history-only': 'History only', 'left-behind': 'Left behind', erased: 'Erased' };

export function CutoverReport({ report }: { report?: D }) {
  return <Section title="Expensify cutover report" label="Expensify cutover report">
    <p className="muted">This inventory reconciles retained import records. Feeds have not been reconciled. Open source reports can be carried through the API into employee drafts for normal approval; source approval never authorizes payment.</p>
    {report?.imports.length ? <ul className="ruled-list">{report.imports.map((job: D) => <li key={job.id}>
      <p><strong>{job.counts.source} source records</strong> · {job.counts.historyOnly} history only · {job.counts.openHistory} open history · {job.counts.leftBehind} left behind · {job.counts.erased} erased</p>
      <p>{job.openReports} open source reports · {job.carriedReports} reports carried · Import {job.state}</p>
      <details className="disclosure"><summary>Every source record</summary><ul className="ruled-list">{job.records.map((r: D) => <li key={r.ordinal}>
        <strong>{r.kind === 'report' ? 'Report' : 'Expense'} {r.sourceId ?? r.ordinal + 1}: {r.label}</strong>
        <p>{r.carriedClaim ? 'Carried into native claim' : words[r.disposition]}{r.amountMinor != null && r.currency ? ` · ${money(r.amountMinor, r.currency)}` : ''}</p>
        {r.reason && <p className="muted">{r.reason}</p>}
        {r.artifact && <p className="muted">{r.artifact} · row {r.row}{r.employee ? ` · ${r.employee}` : ''}</p>}
      </li>)}</ul></details>
    </li>)}</ul> : <Empty title="No Expensify imports to reconcile">Import a report-template CSV to account for each report and expense.</Empty>}
  </Section>;
}
