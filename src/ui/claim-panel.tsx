import { useCallback, useEffect, useState } from 'react';
import { amount, apiHref, call, claimNumber, day, exceptionWords, money, moment, plural, rate, type D } from './api';
import { Badge, Details, Empty, Field, Form, Warning } from './parts';
import { Icon } from './icons';
import { ItemForm } from './item-form';
import { describe } from './history';
import { Comments } from './comments';

function Receipt({ item }: { item: D }) {
  if (item.kind === 'mileage') return <span className="receipt" title="Mileage"><Icon name="car" /><span className="visually-hidden">Mileage</span></span>;
  if (item.kind === 'per_diem') return <span className="receipt" title="Per diem"><Icon name="calendar" /><span className="visually-hidden">Per diem</span></span>;
  if (!item.receipt_id) return <span className="receipt missing" title="No receipt"><Icon name="receipt" /><span className="visually-hidden">No receipt</span></span>;
  const image = String(item.receipt_media).startsWith('image/') && item.receipt_media !== 'image/heic';
  return <a className="receipt" href={apiHref(`receipts/${item.receipt_id}?inline=1`)} target="_blank" rel="noreferrer" aria-label={`Open receipt ${item.receipt_name}`}>
    {image ? <img src={apiHref(`receipts/${item.receipt_id}?inline=1`)} alt="" loading="lazy" /> : <span className="receipt-file">PDF</span>}
  </a>;
}

function split(item: D, currency: string) {
  return item.allocations.map((a: D) => <span key={a.position} className="split-line">{a.description ? `${a.description} · ` : ''}{a.category_name}{a.cost_centre ? ` · ${a.cost_centre}` : ''}{item.allocations.length > 1 ? ` · ${money(a.amount_minor, currency)}` : ''}</span>);
}

function merchantLine(item: D, currency: string) {
  if (item.kind === 'mileage') return `${item.merchant} · ${item.distance_hundredths / 100} mi at ${rate(item.rate_thousandths, currency)}`;
  if (item.kind === 'per_diem') return `${item.merchant} · ${plural(item.days, 'day')} at ${rate(item.rate_thousandths, currency)}`;
  return item.sales_tax_minor ? `${item.merchant} · ${money(item.sales_tax_minor, currency)} sales tax` : item.merchant;
}

/** One claim in the panel, as the pick's exception panel: who and how much, the red banner for a return or a policy
    exception, the facts, each expense with its receipt, the action this person can take, then the history. */
export function ClaimPanel({ id, state, reload, back, closable = true }: { id: string; state: D; reload: () => Promise<D>; back: string; closable?: boolean }) {
  const [detail, setDetail] = useState<D>(), [error, setError] = useState(''), [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => { try { setDetail(await call(`claims/${id}`)); setError(''); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  // Show the saved claim (and its new version) before closing the form, so the next action never uses a stale version.
  const done = async () => { await Promise.all([load(), reload()]); setEditing(null); };
  // The claim a screen opens on by itself has nothing to close back to.
  const close = closable && <a className="panel-close" href={`#/${back}`} aria-label={`Back to ${back === 'approvals' ? 'approvals' : 'claims'}`}><Icon name="cross" /></a>;
  if (error && !detail) return <aside className="side detail"><div className="panel-head"><h2>Claim</h2>{close}</div><p role="alert">{error}</p></aside>;
  if (!detail) return <aside className="side detail"><p className="muted">Opening claim…</p></aside>;
  const { claim, items, exceptions } = detail, me = state.actor.email, currency = claim.currency;
  const mine = claim.employee_email === me, editable = mine && ['draft', 'returned'].includes(claim.status);
  const deciding = claim.status === 'submitted' && claim.approver_email === me && !mine;
  const names: Record<string, string> = state.names;
  const lastReturn = [...detail.decisions].reverse().find((d: D) => d.decision === 'returned' && d.revision === claim.revision);
  const lastDecision = detail.decisions.at(-1), submitted = detail.revisions.at(-1);
  // An unapproval sent to the employee keeps its revision; one sent to the approver reopens it as the next revision.
  const unapproved = [...detail.events].reverse().find((e: D) => e.action === 'claim-unapproved' && (e.detail.revision === claim.revision || submitted?.snapshot.reopened?.fromRevision === e.detail.revision));
  const approval = detail.decisions.find((d: D) => d.decision === 'approved' && d.revision === claim.revision);
  const unapprovable = approval && (claim.status === 'approved' || (claim.status === 'batched' && state.actor.roles.finance)) && (state.actor.roles.finance || state.actor.roles.owner || (state.actor.roles.manager && [approval.actor_email, approval.on_behalf_of].includes(me)));
  const merchantOf = (item: string) => items.find((i: D) => i.id === item)?.merchant;
  const categories = [...new Set(items.flatMap((i: D) => i.allocations.map((a: D) => a.category_name)))];
  return <aside className="side detail" aria-label={`Claim ${claimNumber(claim.number)}`}>
    <div className="panel-head"><h2>{claim.title}</h2>{close}</div>
    <p className="panel-amount"><strong>{money(claim.total_minor, currency)}</strong> for {names[claim.employee_email] ?? claim.employee_email}</p>
    <p className="panel-date">{claimNumber(claim.number)} · {submitted ? `submitted ${day(submitted.submitted_at)}` : `started ${day(claim.created_at)}`}</p>
    {claim.status === 'returned' && lastReturn && <div className="banner" role="status"><span className="banner-mark" aria-hidden="true">!</span><p><strong>Returned for correction:</strong> “{lastReturn.reason}”{editable ? <> Fix the expenses below and submit again; the earlier revision stays in the history.</> : null}</p></div>}
    {unapproved && ['returned', 'submitted'].includes(claim.status) && <div className="banner" role="status"><span className="banner-mark" aria-hidden="true">!</span><p><strong>Unapproved by {names[unapproved.actor_email] ?? unapproved.actor_email}:</strong> “{unapproved.detail.reason}”{claim.status === 'submitted' ? ' It is waiting for the approver again.' : editable ? ' Fix the expenses below and submit again.' : null}</p></div>}
    {exceptions.length > 0 && <div className="banner"><span className="banner-mark" aria-hidden="true">!</span><div>
      <p><strong>{plural(exceptions.length, 'policy exception')}</strong>{claim.status === 'draft' || claim.status === 'returned' ? ', sent to the approver with the explanations' : ' on this revision'}</p>
      <ul className="ruled-list banner-list">{exceptions.map((x: D, i: number) => <li key={i}>{merchantOf(x.item) ? `${merchantOf(x.item)}: ` : ''}{x.message}</li>)}</ul>
    </div></div>}
    <section className="panel-block" aria-label="Details">
      <h3>Details</h3>
      <div className="metadata"><Badge status={claim.status} />{claim.revision > 0 && <span className="muted">Revision {claim.revision}</span>}</div>
      <ul className="facts">
        <li><Icon name="person" /><span>{names[claim.employee_email] ?? claim.employee_email}</span></li>
        <li><Icon name="users" /><span className="approver">Approver: {claim.approver_email ? names[claim.approver_email] ?? claim.approver_email : 'set at submission'}{claim.on_behalf_of ? ` on behalf of ${names[claim.on_behalf_of] ?? claim.on_behalf_of}` : ''}</span></li>
        {categories.length > 0 && <li><Icon name="tag" /><span>{categories.join(', ')}</span></li>}
        {lastDecision && <li><Icon name="send" /><span>{lastDecision.decision === 'approved' ? 'Approved' : lastDecision.decision === 'returned' ? 'Returned' : 'Rejected'} by {names[lastDecision.actor_email] ?? lastDecision.actor_email}{lastDecision.on_behalf_of ? ` on behalf of ${names[lastDecision.on_behalf_of] ?? lastDecision.on_behalf_of}` : ''} {day(lastDecision.at)}</span></li>}
        {claim.prepared_by && <li><Icon name="spark" /><span>Prepared by {claim.prepared_by}, accepted by the employee</span></li>}
      </ul>
    </section>
    {detail.requests.length > 0 && <section className="panel-block" aria-label="Spend requests">
      <h3>Spend requests</h3>
      <ul className="facts">{detail.requests.map((r: D) => <li key={r.id}><Icon name="document" /><span>SR-{String(r.number).padStart(4, '0')} {r.title}: estimate {money(r.estimate_minor, currency)}, spent {money(r.actual_minor, currency)}{r.actual_minor !== r.claim_minor ? ` (${money(r.claim_minor, currency)} on this claim)` : ''}{r.actual_minor > r.estimate_minor ? ` · ${money(r.actual_minor - r.estimate_minor, currency)} over` : ''}</span></li>)}</ul>
    </section>}
    <section className="panel-block" aria-label="Expenses">
      <h3>Expenses</h3>
      {items.length ? <ul className="lines">{items.map((item: D) => {
        const flags = exceptions.filter((x: D) => x.item === item.id);
        return <li className="line" key={item.id}>
          <Receipt item={item} />
          <span className="line-main"><strong>{merchantLine(item, currency)}</strong><span className="muted">{day(item.spent_on)}{item.description ? ` · ${item.description}` : ''}</span>{split(item, currency)}
            {item.attendees?.length > 0 && <span className="split-line">Attendees: {item.attendees.map((a: D) => a.kind === 'guest' ? `${a.name} (guest)` : a.name).join(', ')}</span>}
            {Object.entries(item.fields ?? {}).map(([name, value]) => <span key={name} className="split-line">{name}: {String(value)}</span>)}</span>
          <span className="amount">{amount(item.amount_minor)}</span>
          {(flags.length > 0 || editable) && <span className="line-extra">
            {flags.map((f: D) => <Warning key={f.code}>{exceptionWords[f.code] ?? f.code}</Warning>)}
            {flags.length > 0 && item.explanation && <span className="explanation">Explanation: {item.explanation}</span>}
            {editable && <span className="line-actions"><button className="button small" onClick={() => setEditing(item.id)} aria-label={`Change ${item.merchant}`}>Change</button><button className="button small" aria-label={`Remove ${item.merchant}`} onClick={async () => { try { await call(`claims/${claim.id}/items/remove`, { version: claim.version, item: item.id }); await done(); } catch (e) { setError((e as Error).message); } }}>Remove</button></span>}
          </span>}
        </li>;
      })}</ul> : <Empty title="No expenses yet">{editable ? 'Add each expense with its receipt; mileage is priced at the rate for its date.' : null}</Empty>}
      <div className="total"><span>Claim total ({currency})</span><span>{money(claim.total_minor, currency)}</span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {editable && (editing
        ? <ItemForm key={editing} claim={claim} state={state} item={editing === 'new' ? undefined : items.find((i: D) => i.id === editing)} onDone={done} onCancel={() => setEditing(null)} />
        : <div className="claim-actions">
            <button className="button wide" onClick={() => setEditing('new')}><Icon name="plus" />Add expense</button>
            <Form label={claim.status === 'returned' ? 'Resubmit for approval' : 'Submit for approval'} className="record-form-inline submit-form" onSubmit={async () => { await call(`claims/${claim.id}/submit`, { version: claim.version }); await done(); }}>
              {exceptions.length > 0 && <p className="muted field-wide">{plural(exceptions.length, 'policy exception')} will go to your approver with your explanations.</p>}
            </Form>
          </div>)}
    </section>
    {mine && claim.status === 'submitted' && <section className="panel-block" aria-label="Retract">
      <h3>Retract</h3>
      <p className="muted">Take the claim back before anyone decides it, for example to add a forgotten receipt. Submitting again makes the next revision.</p>
      <Form label="Retract claim" onSubmit={async v => { await call(`claims/${claim.id}/retract`, { version: claim.version, reason: v.reason }); await done(); }}>
        <Field label="Reason" name="reason" required={false} placeholder="For example, adding the hotel receipt" />
      </Form>
    </section>}
    {deciding && <Decision claim={claim} exceptions={exceptions} onDone={done} back={back} />}
    {unapprovable && <section className="panel-block" aria-label="Unapprove">
      <h3>Unapprove</h3>
      <p className="muted">Until its batch is reviewed, an approved claim can go back for another look. The approval stays in the history.</p>
      <Form label="Unapprove claim" onSubmit={async v => { await call(`claims/${claim.id}/unapprove`, { version: claim.version, reason: v.reason, to: v.to }); await done(); }}>
        <Field label="Send back to" name="to" options={[{ value: 'approver', label: `The approver (${names[claim.approver_email] ?? claim.approver_email})` }, { value: 'employee', label: `The employee (${names[claim.employee_email] ?? claim.employee_email})` }]} />
        <Field label="Reason" name="reason" placeholder="For example, the client will pay this directly" />
      </Form>
    </section>}
    {state.actor.roles.owner && claim.status === 'submitted' && <section className="panel-block" aria-label="Reassign">
      <h3>Reassign</h3>
      <Form label="Reassign claim" onSubmit={async v => { await call(`claims/${claim.id}/reassign`, { version: claim.version, approver: v.approver, reason: v.reason }); await done(); }}>
        <Field label="New approver" name="approver" options={state.members.filter((m: D) => m.is_manager && m.active && m.email !== claim.employee_email && m.email !== claim.approver_email).map((m: D) => ({ value: m.email, label: m.name }))} />
        <Field label="Reason" name="reason" required={false} placeholder="For example, on leave" />
      </Form>
    </section>}
    {claim.status !== 'draft' || mine ? <Comments claim={claim} items={items} comments={detail.comments} state={state} onDone={done} /> : null}
    <section className="panel-block history" aria-label="History">
      <h3>History</h3>
      <ol className="timeline">{[...detail.events].reverse().map((e: D, i: number) => <li key={i}><span>{describe(e, names)}</span><time dateTime={e.at}>{moment(e.at)}</time></li>)}</ol>
      {detail.revisions.length > 0 && <Details label="Earlier revisions and receipts">
        {detail.revisions.map((r: D) => <div key={r.revision} className="revision"><h3>Revision {r.revision} · {money(r.total_minor, currency)} · submitted {moment(r.submitted_at)}</h3><ul className="ruled-list">{r.snapshot.items.map((i: D) => <li key={i.id}>{day(i.spent_on)} · {merchantLine(i, currency)} · {money(i.amount_minor, currency)}{i.receipt ? <> · <a href={apiHref(`receipts/${i.receipt.id}`)}>{i.receipt.name}</a></> : ' · no receipt'}</li>)}</ul>{r.snapshot.exceptions.length > 0 && <p className="muted">Exceptions: {r.snapshot.exceptions.map((x: D) => x.message).join('; ')}</p>}</div>)}
        <h3>All receipts on this claim</h3>
        <ul className="ruled-list">{detail.receipts.map((r: D) => <li key={r.id}><a href={apiHref(`receipts/${r.id}`)}>{r.name}</a> · {Math.ceil(r.size / 1024)} KB · {r.source === 'agent' ? `prepared by ${r.uploaded_by}` : `uploaded by ${names[r.uploaded_by] ?? r.uploaded_by}`} · {moment(r.uploaded_at)}<span className="machine" title={r.sha256}>Fingerprint (SHA-256) {r.sha256.slice(0, 16)}…</span></li>)}</ul>
      </Details>}
    </section>
  </aside>;
}

const choices: Record<string, string> = { approved: 'Approve', returned: 'Return for correction', rejected: 'Reject' };

/** The approver's decision, asked as the pick asks it: one question, three choices, one button that does the chosen
    thing. Deciding later changes nothing. */
function Decision({ claim, exceptions, onDone, back }: { claim: D; exceptions: D[]; onDone: () => Promise<void>; back: string }) {
  const [choice, setChoice] = useState('approved'), [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function decide() {
    setBusy(true); setError('');
    try { await call(`claims/${claim.id}/decision`, { revision: claim.revision, version: claim.version, decision: choice, reason, acknowledge: acknowledged }); await onDone(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel-block decision" aria-label="Decision">
    <h3 id="decision-question">What do you want to do?</h3>
    <fieldset className="choices" aria-labelledby="decision-question">
      {Object.entries(choices).map(([value, label]) => <label key={value} className="choice"><input type="radio" name="decision" value={value} checked={choice === value} onChange={() => setChoice(value)} />{label}</label>)}
    </fieldset>
    <label className="field"><span className="field-label">Reason (required if returning or rejecting)</span><textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Add a reason…" maxLength={1000} /></label>
    {exceptions.length > 0 && <label className="check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> I reviewed the {plural(exceptions.length, 'policy exception')} and the employee’s explanations</label>}
    <button className="button go" disabled={busy} onClick={decide}>{choices[choice]}</button>
    <a className="button wide" href={`#/${back}`}>Decide later</a>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
