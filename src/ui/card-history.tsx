import { useState } from 'react';
import { call, day, fileBase64, money, plural, type D } from './api';
import { Choice, Empty, Section } from './parts';

const TOOLS = [['ramp', 'Ramp'], ['brex', 'Brex'], ['navan', 'Navan']];

/** Card charges from a Ramp, Brex or Navan transaction export, with the receipt files it names, come in as read-only
 * history (MOVE-004): preview writes nothing, import applies exactly what was previewed, and the Imports list undoes it. */
export function CardHistory({ history, currency, onImported }: { history: D[]; currency: string; onImported: () => Promise<void> }) {
  const [tool, setTool] = useState('ramp'), [date, setDate] = useState('YYYY-MM-DD'), [file, setFile] = useState<{ name: string; csv: string }>(), [receipts, setReceipts] = useState<D[]>([]);
  const [preview, setPreview] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const input = () => ({ source: tool, csv: file?.csv, filename: file?.name, mapping: { date }, receipts });
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const s = preview?.summary, charges = history.filter(h => h.card);
  return <Section title="Card history from Ramp, Brex or Navan" label="Card history">
    <p className="muted">Export the card transactions as CSV with the receipt files it names. The charges come in read-only with their memos and coding; Coaster flags anyone who claims one again out of pocket. Refunds and credits come in as negative amounts.</p>
    <div className="record-form">
      <Choice label="Card tool" value={tool} onChange={(e: any) => { setTool(e.target.value); setPreview(undefined); }}>{TOOLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Choice>
      <label className="field field-wide"><span className="field-label">Card export CSV</span><input type="file" accept=".csv,text/csv" onChange={async e => { const f = e.target.files?.[0]; setPreview(undefined); if (f) setFile({ name: f.name, csv: await f.text() }); }} /></label>
      <label className="field field-wide"><span className="field-label">Receipt files</span><input type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" onChange={async e => { setPreview(undefined); setReceipts(await Promise.all([...(e.target.files ?? [])].map(async f => ({ name: f.name, base64: await fileBase64(f) })))); }} /></label>
      <Choice label="Dates in the card export" value={date} onChange={(e: any) => { setDate(e.target.value); setPreview(undefined); }}><option value="YYYY-MM-DD">2026-03-31</option><option value="MM/DD/YYYY">03/31/2026</option><option value="DD/MM/YYYY">31/03/2026</option></Choice>
      <div className="form-end"><button className="button primary" disabled={!file || busy} onClick={() => run(async () => setPreview(await call('import/preview', input())))}>Preview card export</button></div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="reconciled" role="status">{notice}</p>}
    {s && <div className="preview">
      <h3>Preview · nothing imported yet</h3>
      <p>{plural(s.charges, 'charge')} · {plural(s.receipts, 'receipt')} · {money(s.totalMinor, currency)}{s.credits.length ? ` · ${plural(s.credits.length, 'refund or credit', 'refunds or credits')} as negative amounts` : ''}</p>
      <button className="button primary" disabled={busy || s.errors.length > 0} onClick={() => run(async () => { await call('import/commit', { ...input(), fingerprint: preview!.fingerprint }); setNotice(`Imported ${plural(s.charges, 'card charge')}.`); setPreview(undefined); await onImported(); })}>Import {plural(s.charges, 'charge')}</button>
      {s.errors.length > 0 && <><h3>Fix these first</h3><ul className="ruled-list">{s.errors.map((m: string) => <li key={m} className="form-error">{m}</li>)}</ul></>}
      {s.warnings.map((m: string) => <p key={m} className="muted">{m}</p>)}
    </div>}
    {charges.length ? <table className="plain"><thead><tr><th>Charge</th><th>Employee</th><th>Date</th><th>Memo</th><th className="figure">Amount</th></tr></thead><tbody>
      {charges.map(c => <tr key={c.id}><td>{c.label} · {c.merchant}{c.receipt ? ' · receipt kept' : ''}</td><td>{c.employee}</td><td>{day(c.date)}</td><td>{c.memo}</td><td className="figure">{money(c.amountMinor, c.currency)}</td></tr>)}
    </tbody></table> : <Empty title="No card history imported" />}
  </Section>;
}
