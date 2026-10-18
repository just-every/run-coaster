import { useCallback, useEffect, useState } from 'react';
import { batchNumber, batchWords, call, claimNumber, day, exceptionWords, money, moment, today, type D } from './api';
import { Badge, Empty, Field, Form, Warning } from './parts';
import { Icon } from './icons';
import { Proposals } from './proposals';
import { describe } from './history';
import { go } from './app';
import type { ViewProps } from './claims';

/** Finance turns approved claims into a reviewed batch, exports it, and records the payment made outside Coaster. */
export function Batches({ state, reload, id }: ViewProps) {
  const ready = state.claims.filter((c: D) => c.status === 'approved');
  const [chosen, setChosen] = useState<string[]>([]);
  const proposals = state.proposals.filter((p: D) => p.kind === 'batch' && p.status === 'proposed');
  const total = ready.filter((c: D) => chosen.includes(c.id)).reduce((n: number, c: D) => n + c.total_minor, 0);
  const currency = state.business?.currency ?? 'USD';
  return <main className="main-wide batches">
    <div className={`batch-columns${id ? ' has-selection' : ''}`}>
      <div className="batch-side">
        <section className="panel section" aria-label="Ready to batch">
          <h2>Approved and ready · {ready.length}</h2>
          {ready.length ? <Form label={`Create batch · ${money(total, currency)}`} onSubmit={async () => { const batch = await call('batches', { claims: chosen }); setChosen([]); await reload(); go('batches', batch.id); }}>
            <ul className="ruled-list field-wide">{ready.map((c: D) => <li key={c.id}><label className="check ready"><input type="checkbox" checked={chosen.includes(c.id)} onChange={e => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter(x => x !== c.id))} /><span className="ready-text"><span className="claim-top"><span>{claimNumber(c.number)}<span className="visually-hidden"> · </span></span><span className="amount">{money(c.total_minor, c.currency)}</span></span><span className="block">{c.title}<span className="visually-hidden"> · </span></span><span className="claim-person">{c.employee_name}</span></span></label></li>)}</ul>
          </Form> : <Empty title="No approved claims waiting">Claims appear here once their manager approves them.</Empty>}
        </section>
        {proposals.length > 0 && <section className="panel section"><Proposals proposals={proposals} reload={reload} claims={state.claims} /></section>}
        <section className="panel section" aria-label="Batches">
          <h2>Batches</h2>
          {state.batches.length ? <ul className="claim-list">{state.batches.map((b: D) => <li key={b.id}><a className={`claim${b.id === id ? ' selected' : ''}`} href={`#/batches/${b.id}`} aria-current={b.id === id ? 'true' : undefined}>
            <span className="claim-top"><span className="claim-id">{batchNumber(b.number)}</span><span className="amount">{money(b.total_minor, b.currency)}</span></span>
            <span className="claim-person">Created {moment(b.created_at)}</span><Badge status={b.status === 'draft' ? 'draft' : b.status === 'approved' ? 'approved' : 'reimbursed'} words={batchWords[b.status]} />
          </a></li>)}</ul> : <Empty title="No batches yet">Choose approved claims above to start one.</Empty>}
        </section>
      </div>
      {id ? <BatchPanel key={id} id={id} reload={reload} names={state.names} /> : <section className="panel section detail-empty batch-empty"><Empty large title="Choose a batch">Review its totals, download the accounting file and record the payment.</Empty></section>}
    </div>
  </main>;
}

function BatchPanel({ id, reload, names }: { id: string; reload: () => Promise<D>; names: Record<string, string> }) {
  const [detail, setDetail] = useState<D>(), [error, setError] = useState('');
  const load = useCallback(async () => { try { setDetail(await call(`batches/${id}`)); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const done = async () => { await Promise.all([load(), reload()]); };
  if (!detail) return <section className="section batch-detail slip slip-foot">{error ? <p role="alert">{error}</p> : <p className="muted">Opening batch…</p>}</section>;
  const { batch, claims, lines, people } = detail, c = batch.currency;
  const linesTotal = lines.reduce((n: number, l: D) => n + l.amountMinor, 0), peopleTotal = people.reduce((n: number, p: D) => n + p.amountMinor, 0);
  const reconciled = linesTotal === batch.total_minor && peopleTotal === batch.total_minor;
  const flagged = lines.filter((l: D) => l.exceptions);
  return <section className="section batch-detail slip slip-foot" aria-label={`Batch ${batchNumber(batch.number)}`}>
    <a className="back" href="#/batches"><Icon name="back" />Back to batches</a>
    <h1>{batchNumber(batch.number)} · {money(batch.total_minor, c)}</h1>
    <div className="metadata"><Badge status={batch.status === 'draft' ? 'draft' : batch.status === 'approved' ? 'approved' : 'reimbursed'} words={batchWords[batch.status]} /><span className="muted">{claims.length} claim{claims.length === 1 ? '' : 's'} · {people.length} {people.length === 1 ? 'person' : 'people'}{batch.prepared_by ? ` · prepared by ${batch.prepared_by}` : ''}</span></div>
    <p className={reconciled ? 'reconciled' : 'form-error'} role="status">{reconciled ? `Reconciled: ${lines.length} accounting line${lines.length === 1 ? '' : 's'} and ${people.length} reimbursement${people.length === 1 ? '' : 's'} ${lines.length === 1 && people.length === 1 ? 'both add' : 'each add'} up to ${money(batch.total_minor, c)}.` : 'These totals do not reconcile. Do not pay this batch.'}</p>
    <h2>Reimbursements</h2>
    <table className="plain"><thead><tr><th>Person</th><th>Claims</th><th className="figure">Amount</th></tr></thead><tbody>{people.map((p: D) => <tr key={p.email}><td>{p.name}</td><td>{p.claims.join(', ')}</td><td className="figure">{money(p.amountMinor, c)}</td></tr>)}</tbody></table>
    <h2>Claims</h2>
    <table className="plain"><thead><tr><th>Claim</th><th>Title</th><th className="figure">Amount</th>{batch.status === 'draft' && <th><span className="visually-hidden">Remove</span></th>}</tr></thead><tbody>{claims.map((x: D) => <tr key={x.claim_id}><td><a href={`#/claims/${x.claim_id}`}>{claimNumber(x.number)}</a></td><td>{x.title}</td><td className="figure">{money(x.amount_minor, c)}</td>{batch.status === 'draft' && <td><button className="button small" onClick={async () => { try { await call(`batches/${id}/remove`, { version: batch.version, claim: x.claim_id }); await done(); } catch (e) { setError((e as Error).message); } }}>Take out</button></td>}</tr>)}</tbody></table>
    {flagged.length > 0 && <><h2>Policy exceptions in this batch</h2><ul className="ruled-list">{flagged.map((l: D, i: number) => <li key={i}>{l.claim} · {l.merchant} · {money(l.amountMinor, c)} <Warning>{l.exceptions.split(' ').map((code: string) => exceptionWords[code] ?? code).join(' · ')}</Warning>{l.explanation && <span className="explanation">Explanation: {l.explanation}</span>}</li>)}</ul></>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {batch.status === 'draft' && <Form label="Approve batch" onSubmit={async v => { if (!v.confirm) throw new Error('Confirm the reconciled total first'); await call(`batches/${id}/approve`, { version: batch.version, expectedTotal: batch.total_minor }); await done(); }}>
      <Field label={`I checked the reimbursements, accounting lines and exceptions add up to ${money(batch.total_minor, c)}`} name="confirm" type="checkbox" />
    </Form>}
    {batch.status !== 'draft' && <div className="downloads"><a className="button" href={`/api/coaster/batches/${id}/accounting.csv`} download>Download accounting CSV</a><a className="button" href={`/api/coaster/batches/${id}/reimbursements.csv`} download>Download reimbursements CSV</a></div>}
    {batch.status === 'approved' && <Form label="Record payment" onSubmit={async v => { await call(`batches/${id}/paid`, { version: batch.version, reference: v.reference, paidOn: v.paidOn }); await done(); }}>
      <Field label="Payment reference" name="reference" placeholder="Bank batch or transfer reference" />
      <Field label="Paid on" name="paidOn" type="date" defaultValue={today()} />
      <p className="muted field-wide">Coaster does not move money: pay the reimbursements file from your bank, then record it here.</p>
    </Form>}
    {batch.status === 'reimbursed' && <p className="paid"><Icon name="check" />Paid on {day(batch.paid_on)} · reference {batch.paid_reference}</p>}
    <div className="history"><h2>History</h2><ol className="timeline">{[...detail.events].reverse().map((e: D, i: number) => <li key={i}><span>{describe(e, names)}</span><time dateTime={e.at}>{moment(e.at)}</time></li>)}</ol></div>
  </section>;
}
