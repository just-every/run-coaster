import { useCallback, useEffect, useState } from 'react';
import { batchNumber, batchStage, batchWords, call, claimNumber, day, exceptionWords, money, moment, plural, shortDay, today, type D } from './api';
import { Badge, Empty, Field, Form, Initials, PageHead, Section, Tiles, Warning } from './parts';
import { Icon } from './icons';
import { AgentStrip } from './proposals';
import { describe } from './history';
import { Work } from './shell';
import { go } from './app';
import { matches, type ViewProps } from './claims';
import { BatchDownloads, Exports } from './exports';
import { ExceptionQueue } from './exception-queue';
import { AccountablePlan } from './accountable-plan';
import { CashAdvances } from './advances';

const batchStatus = (b: D) => b.status === 'draft' ? 'draft' : b.status === 'approved' ? 'approved' : 'reimbursed';
const tone = (b: D) => b.status === 'reimbursed' || batchStage(b) === 'released' ? 'done' : 'wait';
const sum = (rows: D[]) => rows.reduce((n, r) => n + r.total_minor, 0);

/** Finance turns approved claims into a reviewed batch, releases it, exports it, and records the payment made outside Coaster. */
export function Batches({ state, reload, id, query }: ViewProps) {
  const ready = state.claims.filter((c: D) => c.status === 'approved'), shown = ready.filter((c: D) => matches(c, query));
  const [chosen, setChosen] = useState<string[]>([]);
  const proposals = state.proposals.filter((p: D) => p.kind === 'batch' && p.status === 'proposed');
  const total = ready.filter((c: D) => chosen.includes(c.id)).reduce((n: number, c: D) => n + c.total_minor, 0);
  const currency = state.business?.currency ?? 'USD';
  const drafts = state.batches.filter((b: D) => b.status === 'draft'), reviewed = state.batches.filter((b: D) => b.status === 'approved'), paid = state.batches.filter((b: D) => b.status === 'reimbursed');
  const panel = id ? <BatchPanel key={id} id={id} reload={reload} names={state.names} templates={state.exportTemplates} />
    : <aside className="side side-empty"><Empty large title="Choose a batch">Review its totals, download the accounting and reimbursement files, and record the payment.</Empty></aside>;
  return <Work panel={panel} wide selected={!!id} className="batches-work">
    <PageHead title="Batches" line={`${plural(ready.length, 'approved claim')} ready to batch, ${plural(drafts.length, 'batch', 'batches')} to review, ${reviewed.length} to release or pay`} />
    <Tiles label="Batch totals" tiles={[
      { label: 'To review or pay', value: drafts.length + reviewed.length, note: money(sum([...drafts, ...reviewed]), currency) },
      { label: 'Paid', value: paid.length, note: paid[0] ? `Last paid ${shortDay(paid[0].paid_on)} · ${money(sum(paid), currency)}` : 'None yet' },
      { label: 'Approved and ready', value: ready.length, note: money(sum(ready), currency), wash: true },
    ]} />
    <AgentStrip proposals={proposals} reload={reload} claims={state.claims} />
    <div className="cards">
      <Section title={`Approved and ready · ${ready.length}`} label="Ready to batch">
        {ready.length ? <Form label={`Create batch · ${money(total, currency)}`} onSubmit={async () => { const batch = await call('batches', { claims: chosen }); setChosen([]); await reload(); go('batches', batch.id); }}>
          <div className="table-wrap field-wide"><table className="data" aria-label="Approved claims">
            <colgroup><col style={{ width: '34%' }} /><col style={{ width: '36%' }} /><col style={{ width: '16%' }} /><col style={{ width: '14%' }} /></colgroup>
            <thead><tr><th>Person</th><th>Claim</th><th className="figure">Amount</th><th>Approved</th></tr></thead>
            <tbody>{shown.map((c: D) => <tr key={c.id} className={chosen.includes(c.id) ? 'selected row-done' : undefined}>
              <td data-cell="person"><label className="row-check"><input type="checkbox" checked={chosen.includes(c.id)} onChange={e => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter(x => x !== c.id))} /><Initials name={c.employee_name} /><span>{c.employee_name}<span className="visually-hidden"> · {claimNumber(c.number)} · {c.title}</span></span></label></td>
              <td data-cell="title"><span className="block">{c.title}</span><span className="sub">{claimNumber(c.number)} · approved by {c.approver_name}</span></td>
              <td data-cell="amount" className="figure amount">{money(c.total_minor, c.currency)}</td>
              <td data-cell="updated" className="soft nowrap">{shortDay(c.updated_at)}</td>
            </tr>)}</tbody>
          </table></div>
        </Form> : <Empty title="No approved claims waiting">Claims appear here once their manager approves them.</Empty>}
      </Section>
      <Section title="Batches" label="Batches">
        {state.batches.length ? <div className="table-wrap"><table className="data" aria-label="Batches">
          <colgroup><col style={{ width: '24%' }} /><col style={{ width: '26%' }} /><col style={{ width: '20%' }} /><col style={{ width: '30%' }} /></colgroup>
          <thead><tr><th>Batch</th><th>Created</th><th className="figure">Total</th><th>Status</th></tr></thead>
          <tbody>{state.batches.map((b: D) => <tr key={b.id} className={b.id === id ? `selected row-${batchStatus(b) === 'draft' ? 'wait' : 'done'}` : undefined}>
            <td data-cell="person"><a className="title-link" href={`#/batches/${b.id}`} aria-current={b.id === id ? 'true' : undefined}>{batchNumber(b.number)}</a></td>
            <td data-cell="updated" className="soft nowrap">{shortDay(b.created_at)}</td>
            <td data-cell="amount" className="figure amount">{money(b.total_minor, b.currency)}</td>
            <td data-cell="status"><Badge status={batchStatus(b)} tone={tone(b)} words={batchWords[batchStage(b)]} /></td>
          </tr>)}</tbody>
        </table></div> : <Empty title="No batches yet">Choose approved claims above to start one.</Empty>}
      </Section>
      <ExceptionQueue state={state} />
      {state.actor.roles.finance && <CashAdvances state={state} reload={reload} mode="finance" />}
      <AccountablePlan state={state} />
      <Exports state={state} reload={reload} />
    </div>
  </Work>;
}

function BatchPanel({ id, reload, names, templates }: { id: string; reload: () => Promise<D>; names: Record<string, string>; templates: D[] }) {
  const [detail, setDetail] = useState<D>(), [error, setError] = useState('');
  const load = useCallback(async () => { try { setDetail(await call(`batches/${id}`)); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const done = async () => { await Promise.all([load(), reload()]); };
  const close = <a className="panel-close" href="#/batches" aria-label="Back to batches"><Icon name="cross" /></a>;
  if (!detail) return <aside className="side detail">{error ? <><div className="panel-head"><h2>Batch</h2>{close}</div><p role="alert">{error}</p></> : <p className="muted">Opening batch…</p>}</aside>;
  const { batch, claims, lines, people } = detail, c = batch.currency;
  const linesTotal = lines.reduce((n: number, l: D) => n + l.amountMinor, 0), peopleTotal = people.reduce((n: number, p: D) => n + p.amountMinor, 0);
  const reconciled = linesTotal === batch.total_minor && peopleTotal === batch.total_minor;
  const flagged = lines.filter((l: D) => l.exceptions);
  return <aside className="side detail batch-detail" aria-label={`Batch ${batchNumber(batch.number)}`}>
    <div className="panel-head"><h2>{batchNumber(batch.number)} · {money(batch.total_minor, c)}</h2>{close}</div>
    <p className="panel-amount">{plural(claims.length, 'claim')} · {plural(people.length, 'person', 'people')}{batch.prepared_by ? ` · prepared by ${batch.prepared_by}` : ''}</p>
    <p className="panel-date">Created {day(batch.created_at)}</p>
    <div className="metadata panel-block"><Badge status={batchStatus(batch)} tone={tone(batch)} words={batchWords[batchStage(batch)]} /></div>
    {reconciled
      ? <p className="reconciled" role="status"><Icon name="check" /><span>Reconciled: {plural(lines.length, 'accounting line')} and {plural(people.length, 'reimbursement')} {lines.length === 1 && people.length === 1 ? 'both add' : 'each add'} up to {money(batch.total_minor, c)}.</span></p>
      : <div className="banner" role="status"><span className="banner-mark" aria-hidden="true">!</span><p><strong>These totals do not reconcile.</strong> Do not pay this batch.</p></div>}
    <section className="panel-block" aria-label="Reimbursements">
      <h3>Reimbursements</h3>
      <table className="mini"><thead><tr><th>Person</th><th>Claims</th><th className="figure">Amount</th></tr></thead><tbody>{people.map((p: D) => <tr key={p.email}><td>{p.name}</td><td>{p.claims.join(', ')}</td><td className="figure amount">{money(p.amountMinor, c)}</td></tr>)}</tbody></table>
    </section>
    <section className="panel-block" aria-label="Claims in this batch">
      <h3>Claims</h3>
      <table className="mini"><thead><tr><th>Claim</th><th>Title</th><th className="figure">Amount</th>{batch.status === 'draft' && <th><span className="visually-hidden">Remove</span></th>}</tr></thead><tbody>{claims.map((x: D) => <tr key={x.claim_id}><td className="nowrap"><a href={`#/claims/${x.claim_id}`}>{claimNumber(x.number)}</a></td><td>{x.title}</td><td className="figure amount">{money(x.amount_minor, c)}</td>{batch.status === 'draft' && <td className="figure"><button className="button small" onClick={async () => { try { await call(`batches/${id}/remove`, { version: batch.version, claim: x.claim_id }); await done(); } catch (e) { setError((e as Error).message); } }}>Take out</button></td>}</tr>)}</tbody></table>
    </section>
    {flagged.length > 0 && <section className="panel-block" aria-label="Policy exceptions in this batch"><h3>Policy exceptions in this batch</h3><ul className="ruled-list">{flagged.map((l: D, i: number) => <li key={i}>{l.claim} · {l.merchant} · {money(l.amountMinor, c)} <Warning>{l.exceptions.split(' ').map((code: string) => exceptionWords[code] ?? code).join(' · ')}</Warning>{l.explanation && <span className="explanation">Explanation: {l.explanation}</span>}</li>)}</ul></section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {batch.status === 'draft' && <section className="panel-block" aria-label="Review"><Form label="Approve batch" className="record-form-inline" onSubmit={async v => { if (!v.confirm) throw new Error('Confirm the reconciled total first'); await call(`batches/${id}/approve`, { version: batch.version, expectedTotal: batch.total_minor }); await done(); }}>
      <Field label={`I checked the reimbursements, accounting lines and exceptions add up to ${money(batch.total_minor, c)}`} name="confirm" type="checkbox" />
    </Form></section>}
    {batch.status !== 'draft' && <BatchDownloads id={id} templates={templates} />}
    {batch.status === 'approved' && !batch.released_at && <section className="panel-block" aria-label="Release"><h3>Release for payment</h3>
      {batch.first_released_by && <p className="muted">Released once by {names[batch.first_released_by] ?? batch.first_released_by} on {moment(batch.first_released_at)}; a second, different person releases it.</p>}
      <Form label={batch.first_released_by ? 'Second release' : 'Release payment'} className="record-form-inline" onSubmit={async () => { await call(`batches/${id}/release`, { version: batch.version }); await done(); }}>
        <p className="muted field-wide">Releasing needs a sign-in within the last 10 minutes and release access from the owner; nobody releases a batch holding their own claim.</p>
      </Form></section>}
    {batch.status === 'approved' && batch.released_at && <section className="panel-block" aria-label="Payment"><h3>Record payment</h3><p className="muted">Released by {names[batch.released_by] ?? batch.released_by}{batch.first_released_by ? ` after ${names[batch.first_released_by] ?? batch.first_released_by}` : ''} on {moment(batch.released_at)}.</p><Form label="Record payment" className="record-form-inline" onSubmit={async v => { await call(`batches/${id}/paid`, { version: batch.version, reference: v.reference, paidOn: v.paidOn }); await done(); }}>
      <Field label="Payment reference" name="reference" placeholder="Bank batch or ACH reference" />
      <Field label="Paid on" name="paidOn" type="date" defaultValue={today()} />
      <p className="muted field-wide">Coaster does not move money: pay the reimbursements file from your bank, then record it here.</p>
    </Form></section>}
    {batch.status === 'reimbursed' && <p className="paid"><Icon name="check" /><span>Paid on {day(batch.paid_on)} · reference {batch.paid_reference}</span></p>}
    <section className="panel-block history" aria-label="History"><h3>History</h3><ol className="timeline">{[...detail.events].reverse().map((e: D, i: number) => <li key={i}><span>{describe(e, names)}</span><time dateTime={e.at}>{moment(e.at)}</time></li>)}</ol></section>
  </aside>;
}
