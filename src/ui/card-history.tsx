import { useState } from 'react';
import { call, day, fileBase64, money, plural, type D } from './api';
import { Choice, Empty, Section } from './parts';

/** Card charges from a Ramp, Brex or Navan transaction export (MOVE-004), or expense lines from an Emburse Certify,
 * Chrome River or Abacus report export (MOVE-003), with the receipt files it names. */
const KINDS = {
  card: { title: 'Card history from Ramp, Brex or Navan', label: 'Card history', tools: [['ramp', 'Ramp'], ['brex', 'Brex'], ['navan', 'Navan']], tool: 'Card tool', file: 'Card export CSV', receipts: 'Receipt files', preview: 'Preview card export', dates: 'Dates in the card export', noun: 'charge', imported: 'card charge',
    words: 'Export the card transactions as CSV with the receipt files it names. The charges come in read-only with their memos and coding; Coaster flags anyone who claims one again out of pocket. Refunds and credits come in as negative amounts.', empty: 'No card history imported' },
  emburse: { title: 'Expense history from Emburse', label: 'Emburse history', tools: [['certify', 'Certify'], ['chromeriver', 'Chrome River'], ['abacus', 'Abacus']], tool: 'Emburse product', file: 'Emburse export CSV', receipts: 'Emburse receipt files', preview: 'Preview Emburse export', dates: 'Dates in the Emburse export', noun: 'expense', imported: 'Emburse expense',
    words: 'Export the expense lines of your Certify, Chrome River or Abacus reports as CSV with the receipt files it names. They come in read-only with their report, approver, coding and receipts; Coaster flags anyone who claims one again. Credits come in as negative amounts.', empty: 'No Emburse history imported' },
} as const;

/** Preview writes nothing, import applies exactly what was previewed, and the Imports list undoes it. */
export function CardHistory({ kind, history, currency, onImported }: { kind: keyof typeof KINDS; history: D[]; currency: string; onImported: () => Promise<void> }) {
  const k = KINDS[kind];
  const [tool, setTool] = useState<string>(k.tools[0][0]), [date, setDate] = useState('YYYY-MM-DD'), [file, setFile] = useState<{ name: string; csv: string }>(), [receipts, setReceipts] = useState<D[]>([]);
  const [preview, setPreview] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const input = () => ({ source: tool, csv: file?.csv, filename: file?.name, mapping: { date }, receipts });
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const s = preview?.summary, charges = history.filter(h => kind === 'card' ? h.card : h.emburse);
  return <Section title={k.title} label={k.label}>
    <p className="muted">{k.words}</p>
    <div className="record-form">
      <Choice label={k.tool} value={tool} onChange={(e: any) => { setTool(e.target.value); setPreview(undefined); }}>{k.tools.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Choice>
      <label className="field field-wide"><span className="field-label">{k.file}</span><input type="file" accept=".csv,text/csv" onChange={async e => { const f = e.target.files?.[0]; setPreview(undefined); if (f) setFile({ name: f.name, csv: await f.text() }); }} /></label>
      <label className="field field-wide"><span className="field-label">{k.receipts}</span><input type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" onChange={async e => { setPreview(undefined); setReceipts(await Promise.all([...(e.target.files ?? [])].map(async f => ({ name: f.name, base64: await fileBase64(f) })))); }} /></label>
      <Choice label={k.dates} value={date} onChange={(e: any) => { setDate(e.target.value); setPreview(undefined); }}><option value="YYYY-MM-DD">2026-03-31</option><option value="MM/DD/YYYY">03/31/2026</option><option value="DD/MM/YYYY">31/03/2026</option></Choice>
      <div className="form-end"><button className="button primary" disabled={!file || busy} onClick={() => run(async () => setPreview(await call('import/preview', input())))}>{k.preview}</button></div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="reconciled" role="status">{notice}</p>}
    {s && <div className="preview">
      <h3>Preview · nothing imported yet</h3>
      <p>{plural(s.charges, k.noun)} · {plural(s.receipts, 'receipt')} · {money(s.totalMinor, currency)}{s.credits.length ? ` · ${plural(s.credits.length, 'refund or credit', 'refunds or credits')} as negative amounts` : ''}</p>
      <button className="button primary" disabled={busy || s.errors.length > 0} onClick={() => run(async () => { await call('import/commit', { ...input(), fingerprint: preview!.fingerprint }); setNotice(`Imported ${plural(s.charges, k.imported)}.`); setPreview(undefined); await onImported(); })}>Import {plural(s.charges, k.noun)}</button>
      {s.errors.length > 0 && <><h3>Fix these first</h3><ul className="ruled-list">{s.errors.map((m: string) => <li key={m} className="form-error">{m}</li>)}</ul></>}
      {s.warnings.map((m: string) => <p key={m} className="muted">{m}</p>)}
    </div>}
    {charges.length ? <table className="plain"><thead><tr><th>{kind === 'card' ? 'Charge' : 'Expense'}</th><th>Employee</th><th>Date</th><th>Memo</th><th className="figure">Amount</th></tr></thead><tbody>
      {charges.map(c => <tr key={c.id}><td>{c.label} · {c.merchant}{c.report ? ` · report ${c.report}` : ''}{c.receipt ? ' · receipt kept' : ''}</td><td>{c.employee}{c.approver ? <small className="muted"> · approved by {c.approver}</small> : null}</td><td>{day(c.date)}</td><td>{c.memo}</td><td className="figure">{money(c.amountMinor, c.currency)}</td></tr>)}
    </tbody></table> : <Empty title={k.empty} />}
  </Section>;
}
