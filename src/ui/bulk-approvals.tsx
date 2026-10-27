import { useState } from 'react';
import { apiHref, call, claimNumber, money, plural, type D } from './api';

/** Selection never grants authority; every opened revision is checked again when decided. */
export function BulkApprovals({ waiting, names, reload }: { waiting: D[]; names: Record<string, string>; reload: () => Promise<D> }) {
  const [selected, setSelected] = useState<string[]>([]), [reviews, setReviews] = useState<D[]>([]);
  const [checks, setChecks] = useState<Record<string, boolean>>({}), [overrides, setOverrides] = useState<Record<string, string>>({});
  const [results, setResults] = useState<D[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function review() {
    setBusy(true); setError(''); setChecks({}); setOverrides({}); setResults([]);
    try { setReviews(await Promise.all(selected.map(id => call(`claims/${id}`)))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true); setError('');
    try {
      const answer = await call(['approvals', 'bulk'].join('/'), { claims: reviews.map(d => ({ id: d.claim.id, version: d.claim.version, revision: d.claim.revision, reviewed: checks[d.claim.id], acknowledge: checks[d.claim.id], override: overrides[d.claim.id] })) });
      setResults(answer.results.map((r: D) => ({ ...r, title: reviews.find(d => d.claim.id === r.id)?.claim.title }))); setReviews([]); setSelected([]); await reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel bulk-approvals" aria-label="Bulk approval">
    <details className="disclosure"><summary>Approve several claims</summary>
      <p>Choose claims, then review each expense and exception before approving its current step.</p>
      {!reviews.length && <>
        <ul className="ruled-list">{waiting.map(c => <li key={c.id}><label className="check"><input type="checkbox" checked={selected.includes(c.id)} disabled={busy || (!selected.includes(c.id) && selected.length >= 25)} onChange={e => setSelected(e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id))} />{c.title} · {names[c.employee_email] ?? c.employee_email} · {claimNumber(c.number)} · {money(c.total_minor, c.currency)}</label></li>)}</ul>
        <button className="button" disabled={busy || !selected.length} onClick={review}>Review selected claims</button>
      </>}
      {reviews.map(d => <article className="panel-block" key={d.claim.id} aria-label={`Review ${d.claim.title}`}>
        <h3>{d.claim.title} · {money(d.claim.total_minor, d.claim.currency)}</h3>
        <p>{names[d.claim.employee_email] ?? d.claim.employee_email} · {claimNumber(d.claim.number)} · revision {d.claim.revision} · <a href={`#/approvals/${d.claim.id}`}>Open full claim</a></p>
        <ul className="ruled-list">{d.items.map((item: D) => <li key={item.id}>{item.merchant} · {money(item.amount_minor, d.claim.currency)}{item.receipt_id && <> · <a href={apiHref(`receipts/${item.receipt_id}`)} target="_blank" rel="noreferrer">Open receipt</a></>}{item.explanation && <p>Explanation: {item.explanation}</p>}</li>)}</ul>
        {d.exceptions.length ? <ul>{d.exceptions.map((exception: D, i: number) => <li key={i}>{exception.message}</li>)}</ul> : <p>No policy exceptions.</p>}
        {d.exceptions.some((x: D) => x.code === 'needs-pre-approval') && <label className="field"><span className="field-label">Reason to approve {d.claim.title} without a spend request</span><textarea maxLength={1000} value={overrides[d.claim.id] ?? ''} onChange={e => setOverrides({ ...overrides, [d.claim.id]: e.target.value })} /></label>}
        <label className="check"><input type="checkbox" disabled={busy} checked={!!checks[d.claim.id]} onChange={e => setChecks({ ...checks, [d.claim.id]: e.target.checked })} />I reviewed {d.claim.title}, its expenses, exceptions and explanations</label>
      </article>)}
      {!!reviews.length && <div className="form-end"><button className="button primary" disabled={busy || reviews.some(d => !checks[d.claim.id] || (d.exceptions.some((x: D) => x.code === 'needs-pre-approval') && !overrides[d.claim.id]?.trim()))} onClick={approve}>Approve {plural(reviews.length, 'claim')}</button><button className="button" disabled={busy} onClick={() => setReviews([])}>Change selection</button></div>}
      {!!results.length && <div role="status"><h3>Bulk approval results</h3><ul className="ruled-list">{results.map(r => <li key={r.id}>{r.title ?? r.id} · revision {r.revision}: {r.approved ? r.claimStatus === 'submitted' ? 'Step approved; further review required' : 'Approved' : `Not approved: ${r.error}`}</li>)}</ul></div>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </details>
  </section>;
}
