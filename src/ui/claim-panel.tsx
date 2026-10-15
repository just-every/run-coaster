import { useCallback, useEffect, useState } from 'react';
import { amount, call, claimNumber, day, money, moment, type D } from './api';
import { Badge, Details, Empty, Form, Warning } from './parts';
import { Icon } from './icons';
import { ItemForm } from './item-form';
import { describe } from './history';

function Receipt({ item }: { item: D }) {
  if (item.kind === 'mileage') return <span className="receipt empty"><Icon name="car" />Mileage</span>;
  if (!item.receipt_id) return <span className="receipt empty"><Icon name="receipt" />No receipt</span>;
  const image = String(item.receipt_media).startsWith('image/') && item.receipt_media !== 'image/heic';
  return <a className="receipt" href={`/api/coaster/receipts/${item.receipt_id}?inline=1`} target="_blank" rel="noreferrer" aria-label={`Open receipt ${item.receipt_name}`}>
    {image ? <img src={`/api/coaster/receipts/${item.receipt_id}?inline=1`} alt="" loading="lazy" /> : <span className="receipt-file">PDF</span>}
  </a>;
}

function split(item: D, currency: string) {
  return item.allocations.map((a: D) => <span key={a.position} className="split-line">{a.category_name}{a.cost_centre ? ` · ${a.cost_centre}` : ''}{item.allocations.length > 1 ? ` · ${money(a.amount_minor, currency)}` : ' · 100%'}</span>);
}

function merchantLine(item: D, currency: string) {
  if (item.kind === 'mileage') return `${item.merchant} · ${item.distance_hundredths / 100}\u00a0km at ${money(item.rate_minor, currency)}`;
  if (item.kind === 'per_diem') return `${item.merchant} · ${item.days} day${item.days === 1 ? '' : 's'} at ${money(item.rate_minor, currency)}`;
  return item.merchant;
}

/** One claim: its expenses with receipts and exceptions, then the action this person can take, then its history. */
export function ClaimPanel({ id, state, reload, back }: { id: string; state: D; reload: () => Promise<D>; back: string }) {
  const [detail, setDetail] = useState<D>(), [error, setError] = useState(''), [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => { try { setDetail(await call(`claims/${id}`)); setError(''); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  // Show the saved claim (and its new version) before closing the form, so the next action never uses a stale version.
  const done = async () => { await Promise.all([load(), reload()]); setEditing(null); };
  if (error && !detail) return <section className="detail slip slip-foot"><a className="back" href={`#/${back}`}><Icon name="back" />Back</a><p role="alert">{error}</p></section>;
  if (!detail) return <section className="detail slip slip-foot"><p className="muted">Opening claim…</p></section>;
  const { claim, items, exceptions } = detail, me = state.actor.email, currency = claim.currency;
  const mine = claim.employee_email === me, editable = mine && ['draft', 'returned'].includes(claim.status);
  const deciding = claim.status === 'submitted' && claim.approver_email === me && !mine;
  const names: Record<string, string> = state.names;
  const lastReturn = [...detail.decisions].reverse().find((d: D) => d.decision === 'returned' && d.revision === claim.revision);
  return <section className="detail slip slip-foot" aria-label={`Claim ${claimNumber(claim.number)}`}>
    <a className="back" href={`#/${back}`}><Icon name="back" />Back to {back === 'approvals' ? 'approvals' : 'claims'}</a>
    <div className="detail-head">
      <h1>{claim.title}</h1>
      <div className="metadata"><Badge status={claim.status} />{claim.revision > 0 && <><span className="separator" /><span>Revision {claim.revision}</span></>}<span className="separator" /><span className="approver">Approver {claim.approver_email ? names[claim.approver_email] ?? claim.approver_email : 'set at submission'}</span></div>
      <p className="claim-who">{claimNumber(claim.number)} · {names[claim.employee_email] ?? claim.employee_email}{claim.prepared_by ? ` · prepared by ${claim.prepared_by}, accepted by the employee` : ''}</p>
    </div>
    {claim.status === 'returned' && lastReturn && <p className="callout" role="status">Returned for correction: “{lastReturn.reason}”. Fix the expenses below and submit again; the earlier revision stays in the history.</p>}
    {items.length ? <table className="expenses">
      <thead><tr><th><span className="visually-hidden">Receipt</span></th><th>Date</th><th>Merchant</th><th>Category split</th><th className="figure">Amount ({currency})</th>{editable && <th><span className="visually-hidden">Change</span></th>}</tr></thead>
      <tbody>{items.map((item: D) => {
        const flags = exceptions.filter((x: D) => x.item === item.id);
        return <tr key={item.id}>
          <td className="receipt-cell"><Receipt item={item} /></td>
          <td className="date"><span className="mobile-label">Date</span>{day(item.spent_on)}</td>
          <td><span className="mobile-label">Merchant</span>{merchantLine(item, currency)}{item.description && <span className="muted block">{item.description}</span>}</td>
          <td><span className="mobile-label">Category split</span>{split(item, currency)}{flags.map((f: D) => <Warning key={f.code}>{f.message}</Warning>)}{flags.length > 0 && item.explanation && <span className="explanation">Explanation: {item.explanation}</span>}</td>
          <td className="figure"><span className="mobile-label">Amount</span>{amount(item.amount_minor)}</td>
          {editable && <td className="row-actions"><button className="button small" onClick={() => setEditing(item.id)} aria-label={`Change ${item.merchant}`}>Change</button><button className="button small" aria-label={`Remove ${item.merchant}`} onClick={async () => { try { await call(`claims/${claim.id}/items/remove`, { version: claim.version, item: item.id }); await done(); } catch (e) { setError((e as Error).message); } }}>Remove</button></td>}
        </tr>;
      })}</tbody>
    </table> : <Empty title="No expenses yet">{editable ? 'Add each expense with its receipt; mileage is priced from the business rate.' : null}</Empty>}
    <div className="total"><span>Claim total</span><span>{money(claim.total_minor, currency)}</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {editable && (editing
      ? <ItemForm key={editing} claim={claim} state={state} item={editing === 'new' ? undefined : items.find((i: D) => i.id === editing)} onDone={done} onCancel={() => setEditing(null)} />
      : <div className="claim-actions">
          <button className="button" onClick={() => setEditing('new')}><Icon name="plus" />Add expense</button>
          <Form label={claim.status === 'returned' ? 'Resubmit for approval' : 'Submit for approval'} className="record-form-inline submit-form" onSubmit={async () => { await call(`claims/${claim.id}/submit`, { version: claim.version }); await done(); }}>
            {exceptions.length > 0 && <p className="muted field-wide">{exceptions.length} policy exception{exceptions.length === 1 ? '' : 's'} will go to your approver with your explanations.</p>}
          </Form>
        </div>)}
    {deciding && <Decision claim={claim} exceptions={exceptions} onDone={done} />}
    <div className="history">
      <h2>History</h2>
      <ol className="timeline">{[...detail.events].reverse().map((e: D, i: number) => <li key={i}><span>{describe(e, names)}</span><time dateTime={e.at}>{moment(e.at)}</time></li>)}</ol>
      {detail.revisions.length > 0 && <Details label="Earlier revisions and receipts">
        {detail.revisions.map((r: D) => <div key={r.revision} className="revision"><h3>Revision {r.revision} · {money(r.total_minor, currency)} · submitted {moment(r.submitted_at)}</h3><ul className="ruled-list">{r.snapshot.items.map((i: D) => <li key={i.id}>{day(i.spent_on)} · {merchantLine(i, currency)} · {money(i.amount_minor, currency)}{i.receipt ? <> · <a href={`/api/coaster/receipts/${i.receipt.id}`}>{i.receipt.name}</a></> : ' · no receipt'}</li>)}</ul>{r.snapshot.exceptions.length > 0 && <p className="muted">Exceptions: {r.snapshot.exceptions.map((x: D) => x.message).join('; ')}</p>}</div>)}
        <h3>All receipts on this claim</h3>
        <ul className="ruled-list">{detail.receipts.map((r: D) => <li key={r.id}><a href={`/api/coaster/receipts/${r.id}`}>{r.name}</a> · {Math.ceil(r.size / 1024)} KB · {r.source === 'agent' ? `prepared by ${r.uploaded_by}` : `uploaded by ${names[r.uploaded_by] ?? r.uploaded_by}`} · {moment(r.uploaded_at)}<span className="machine" title={r.sha256}>Fingerprint (SHA-256) {r.sha256.slice(0, 16)}…</span></li>)}</ul>
      </Details>}
    </div>
  </section>;
}

function Decision({ claim, exceptions, onDone }: { claim: D; exceptions: D[]; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function decide(decision: string) {
    setBusy(true); setError('');
    try { await call(`claims/${claim.id}/decision`, { revision: claim.revision, version: claim.version, decision, reason, acknowledge: acknowledged }); await onDone(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="decision">
    <h2>Decision</h2>
    <label className="field field-wide"><span className="field-label">Reason (required if returning or rejecting)</span><textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Add a reason…" maxLength={1000} /></label>
    {exceptions.length > 0 && <label className="check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> I reviewed the {exceptions.length} policy exception{exceptions.length === 1 ? '' : 's'} and the employee’s explanations</label>}
    <div className="actions">
      <button className="button primary" disabled={busy} onClick={() => decide('approved')}>Approve</button>
      <button className="button" disabled={busy} onClick={() => decide('returned')}>Return for correction</button>
      <button className="button" disabled={busy} onClick={() => decide('rejected')}>Reject</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
