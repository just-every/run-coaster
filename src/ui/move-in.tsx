import { useEffect, useState } from 'react';
import { call, day, money, plural, type D } from './api';
import { Choice, Empty, PageHead, Section } from './parts';
import { Work } from './shell';
import type { ViewProps } from './claims';
import { CardHistory } from './card-history';
import { EmburseConfiguration } from './emburse-configuration';
import { ConcurImport } from './concur-import';

const HISTORY = [['open', 'Open (not submitted)'], ['submitted', 'Submitted'], ['approved', 'Approved'], ['reimbursed', 'Reimbursed'], ['closed', 'Closed']];
const JOB_WORDS: Record<string, string> = { completed: 'Imported', undone: 'Undone', queued: 'Waiting to import', applying: 'Importing', failed: 'Stopped part way', undoing: 'Undoing' };
const SOURCE_NAMES: Record<string, string> = { expensify: 'Expensify', ramp: 'Ramp', brex: 'Brex', navan: 'Navan', certify: 'Certify', chromeriver: 'Chrome River', abacus: 'Abacus', concur: 'SAP Concur' };
const GUESS: Record<string, string> = { open: 'open', processing: 'submitted', approved: 'approved', reimbursed: 'reimbursed', closed: 'closed', archived: 'closed', paid: 'reimbursed' };

/** The Expensify move-in kit: preview writes nothing, import applies exactly what was previewed, undo reverses it. */
export function MoveIn({ state, reload }: ViewProps) {
  const [file, setFile] = useState<{ name: string; csv: string }>(), [date, setDate] = useState('YYYY-MM-DD'), [statuses, setStatuses] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<D>(), [jobs, setJobs] = useState<D>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const refresh = async () => { setJobs(await call('import')); await reload(); };
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  const input = () => ({ csv: file?.csv, filename: file?.name, mapping: { date, statuses } });
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function look(mapping = statuses) {
    const result = await call('import/preview', { ...input(), mapping: { date, statuses: mapping } });
    const filled = { ...mapping };
    for (const s of result.summary.statuses) if (!filled[s] && GUESS[s.toLowerCase()]) filled[s] = GUESS[s.toLowerCase()];
    if (JSON.stringify(filled) !== JSON.stringify(mapping)) { setStatuses(filled); return look(filled); }
    setPreview(result);
  }
  const s = preview?.summary, currency = state.business?.currency ?? 'USD';
  return <Work className="move-in">
    <PageHead title="Move in from Expensify" line="Past Expensify reports come in as read-only history: never claims to approve or pay, but Coaster uses them to flag an expense someone claims again." />
    <div className="cards">
      <div className="cards-2">
        <Section title="Import a file" label="Import a file">
          <p className="muted">Build the export with the <a href="https://integrations.expensify.com/Integration-Server/doc/export_report_template.html" target="_blank" rel="noreferrer">Expensify export template</a>, then choose the file. Preview writes nothing; import applies exactly what you previewed.</p>
          <div className="record-form">
            <label className="field field-wide"><span className="field-label">Expensify CSV</span><input type="file" accept=".csv,text/csv" onChange={async e => { const f = e.target.files?.[0]; setPreview(undefined); if (f) setFile({ name: f.name, csv: await f.text() }); }} /></label>
            <Choice label="Dates in the file" value={date} onChange={(e: any) => { setDate(e.target.value); setPreview(undefined); }}><option value="YYYY-MM-DD">2026-03-31</option><option value="MM/DD/YYYY">03/31/2026</option><option value="DD/MM/YYYY">31/03/2026</option></Choice>
            <div className="form-end"><button className="button primary" disabled={!file || busy} onClick={() => run(() => look())}>Preview</button></div>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="reconciled" role="status">{notice}</p>}
          {s && <div className="preview">
            <h3>Preview · nothing imported yet</h3>
            <p>{s.reports} reports · {s.expenses} expenses · {money(s.totalMinor, currency)}</p>
            <div className="record-form">{s.statuses.map((status: string) => <Choice key={status} label={`Expensify “${status}” becomes`} value={statuses[status] ?? ''} onChange={(e: any) => setStatuses({ ...statuses, [status]: e.target.value })}><option value="">Choose…</option>{HISTORY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Choice>)}</div>
            <div className="actions"><button className="button" disabled={busy} onClick={() => run(() => look())}>Preview again with this mapping</button>
            <button className="button primary" disabled={busy || s.errors.length > 0} onClick={() => run(async () => { const r = await call('import/commit', { ...input(), fingerprint: preview!.fingerprint }); setNotice(r.job.state === 'completed' ? `Imported ${plural(s.reports, 'report')} with ${plural(s.expenses, 'expense')}.` : `Imported ${r.job.checkpoint} of ${r.job.total} records; resume to finish.`); setPreview(undefined); await refresh(); })}>Import {plural(s.reports, 'report')}</button></div>
            {s.errors.length > 0 && <><h3>Fix these first</h3><ul className="ruled-list">{s.errors.map((m: string) => <li key={m} className="form-error">{m}</li>)}</ul></>}
            {s.warnings.map((m: string) => <p key={m} className="muted">{m}</p>)}
          </div>}
        </Section>
        <Section title="Imports" label="Imports">
          {jobs?.jobs.length ? <ul className="ruled-list">{jobs.jobs.map((j: D) => <li key={j.id} className="job">
            <span>{SOURCE_NAMES[j.source] ?? j.source} · {JOB_WORDS[j.state] ?? 'Import'} · {j.state === 'completed' || j.state === 'undone' ? `${j.total} records` : `${j.checkpoint} of ${j.total} records`}</span>
            <span className="actions">{['queued', 'applying', 'failed'].includes(j.state) && <button className="button small" disabled={busy} onClick={() => run(async () => { await call('import/resume', { source: j.source, id: j.id, mappingVersion: j.mappingVersion }); await refresh(); })}>Resume</button>}
              {j.state === 'completed' && <button className="button small" disabled={busy} onClick={() => run(async () => { await call('import/undo', { source: j.source, id: j.id, mappingVersion: j.mappingVersion }); setNotice('Import undone.'); await refresh(); })}>Undo import</button>}</span>
          </li>)}</ul> : <Empty title="Nothing imported yet">Each import is listed here with its records, and can be undone.</Empty>}
        </Section>
      </div>
      <Section title="Imported history" label="Imported history">
        {jobs?.history.filter((h: D) => h.kind === 'report').length ? <table className="plain"><thead><tr><th>Report</th><th>Employee</th><th>Status</th><th className="figure">Total</th></tr></thead><tbody>
          {jobs.history.filter((h: D) => h.kind === 'report').map((r: D) => <tr key={r.id}><td>{r.name}</td><td>{r.employee}</td><td>{HISTORY.find(([v]) => v === r.status)?.[1] ?? r.status}{r.reimbursed ? ` · ${day(r.reimbursed)}` : ''}</td><td className="figure">{money(r.totalMinor, r.currency)}</td></tr>)}
        </tbody></table> : <Empty title="No imported reports">Reports you import from Expensify appear here, read-only.</Empty>}
      </Section>
      <CardHistory kind="card" history={jobs?.history ?? []} currency={currency} onImported={refresh} />
      <EmburseConfiguration state={state} onImported={refresh} />
      <CardHistory kind="emburse" history={jobs?.history ?? []} currency={currency} onImported={refresh} />
      <ConcurImport state={state} history={jobs?.history??[]} onImported={refresh}/>
    </div>
  </Work>;
}
