import { useState, type ReactNode } from 'react';
import { call, claimNumber, money, moment, plural, type D } from './api';
import { Field, Form } from './parts';
import { go } from './app';

/** The pick's agent strip: the mark, what each agent prepared for this person in one sentence, and the person's two
    choices. Nothing happens until they accept; agents never submit, approve or pay. */
export function AgentStrip({ proposals, reload, claims = [], idle, currency = 'USD' }: { proposals: D[]; reload: () => Promise<D>; claims?: D[]; idle?: ReactNode; currency?: string }) {
  const [error, setError] = useState('');
  const [codingReview, setCodingReview] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  async function applyCoding(p: D) {
    setError('');
    try {
      const result = await call(`proposals/${p.id}/apply-coding`, { confirm: confirmed, fingerprint: p.payload.codingApplication.fingerprint });
      await reload(); setCodingReview(''); setConfirmed(false); go('claims', result.claim.id);
    } catch (e) { setError((e as Error).message); }
  }
  async function decide(p: D, accept: boolean) {
    setError('');
    try {
      const result = await call(`proposals/${p.id}/${accept ? 'accept' : 'decline'}`, {});
      await reload();
      if (accept && result.claim) go('claims', result.claim.id);
      else if (accept && result.batch) go('batches', result.batch.id);
    } catch (e) { setError((e as Error).message); }
  }
  if (!proposals.length && !idle) return null;
  return <section className="agent" aria-label="Prepared for you">
    {proposals.length ? proposals.map(p => {
      const batched = p.kind === 'batch' ? claims.filter(c => p.payload.claims.includes(c.id)) : [];
      const preparation = p.payload.preparation;
      const total = p.kind === 'claim' ? p.payload.items.reduce((n: number, i: D) => n + i.amountMinor, 0) : batched.reduce((n, c) => n + c.total_minor, 0);
      const count = p.kind === 'claim' ? p.payload.items.length : p.payload.claims.length;
      return <div className="agent-row" key={p.id}>
        <img className="agent-mark" src="/brand/mark.svg" alt="" />
        <div className="agent-text"><p><strong>{p.agent_label}:</strong> {preparation ? <>prepared “{p.payload.title}” for your review.</> : p.kind === 'claim'
          ? <>prepared “{p.payload.title}”, {plural(count, 'expense')} for {money(total, currency)}, for you to check.</>
          : <>proposed a batch of {plural(count, 'approved claim')} ({batched.map(c => claimNumber(c.number)).join(', ')}) for {money(total, currency)}.</>}
          {' '}<span className="muted">{p.payload.note ? `“${p.payload.note}” · ` : ''}{moment(p.created_at)}</span></p>
          {preparation && <details><summary>Review proposal and citations</summary>
            {preparation === 'close' && <p>Proposed pending accrual: {money(p.payload.accrualMinor, p.payload.currency)}. Owner acceptance records review only.</p>}
            <ul>{(p.payload.checklist ?? p.payload.items).map((item: D, i: number) => <li key={i}>
              <a href={item.citation}>{item.label ?? `${item.date} · ${item.merchant} · ${money(item.amountMinor, p.payload.currency ?? currency)}`}</a>
              {typeof item.amountMinor === 'number' && preparation === 'close' && <> · {money(item.amountMinor, p.payload.currency)}</>}
              {item.receipt && <> · Receipt {item.receipt.id} · SHA-256 {item.receipt.sha256}</>}
              {item.allocations && <span> · {item.allocations.map((a: D) => a.category_name).join(', ')}</span>}
              {item.coding && <span> · Coding: {item.coding.map((a: D) => a.category_name).join(', ')}</span>}
              {item.proposedCoding?.fields?.category && <span> · Proposed category: {item.proposedCoding.categoryName ?? item.proposedCoding.fields.category}</span>}
              {item.proposedCoding?.evidence?.length > 0 && <ul>{item.proposedCoding.evidence.map((e: D, i: number) => <li key={i}>Coding proposal: {e.field} · {e.source} · {e.reason}</li>)}</ul>}
              {item.issues?.length > 0 && <ul>{item.issues.map((issue: string) => <li key={issue}>{issue}</li>)}</ul>}
            </li>)}</ul>
          </details>}
          {preparation === 'expense' && p.payload.codingApplication?.review.entries.some((e: D) => e.changes.length) && <>
            {codingReview !== p.id ? <button className="link-button" disabled={p.payload.stopped} onClick={() => { setCodingReview(p.id); setConfirmed(false); }}>Review coding changes</button> : <div className="panel-block" role="group" aria-label="Confirm coding changes">
              <p><strong>Apply these exact coding changes to your draft?</strong> Amounts, source charges and receipt evidence stay as recorded. You still submit the claim yourself.</p>
              <ul>{p.payload.codingApplication.review.entries.filter((e: D) => e.changes.length).map((entry: D) => <li key={entry.item}><strong>{entry.merchant}</strong><ul>{entry.changes.map((change: D) => <li key={change.field}>{change.label}: {change.beforeLabel} → {change.afterLabel}</li>)}</ul></li>)}</ul>
              <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm these exact coding changes</label>
              <div className="agent-actions"><button className="agent-pill" disabled={!confirmed || p.payload.stopped} onClick={() => applyCoding(p)}>Apply reviewed coding</button><button className="link-button" onClick={() => { setCodingReview(''); setConfirmed(false); }}>Cancel coding changes</button></div>
            </div>}
          </>}
        </div>
        <div className="agent-actions"><button className="agent-pill" onClick={() => decide(p, true)}>{preparation === 'close' ? 'Accept checklist' : preparation === 'expense' ? 'Accept review plan' : 'Accept as draft' + (p.kind === 'batch' ? ' batch' : '')}</button><button className="link-button" onClick={() => decide(p, false)}>Decline</button></div>
      </div>;
    }) : <div className="agent-row"><img className="agent-mark" src="/brand/mark.svg" alt="" /><p className="agent-text">{idle}</p></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

/** Existing form controls keep preparation inside the current claims and batch screens. */
export function PrepareNativeWork({ state, reload, close = false }: { state: D; reload: () => Promise<D>; close?: boolean }) {
  const own = state.claims.filter((c: D) => c.employee_email === state.actor.email && ['draft','returned'].includes(c.status));
  const [notice, setNotice] = useState('');
  if (state.actor.delegate || (close ? !state.actor.roles.owner : !state.actor.roles.employee)) return null;
  const prepared = async (path: string, body: D) => { await call(path, body); await reload(); setNotice('Proposal prepared for your review.'); };
  return <details className="panel-block"><summary>{close ? 'Prepare month-end checklist' : 'Prepare a trip or expense review'}</summary>
    {close ? <Form label="Prepare checklist" onSubmit={v => prepared(['preparations','close'].join('/'), v)}>
      <Field label="Close period start" name="from" type="date" /><Field label="Close period end" name="to" type="date" />
    </Form> : <>
      <Form label="Prepare trip proposal" onSubmit={async (v, form) => { await prepared(['preparations','trip'].join('/'), { title: v.title, from: v.from, to: v.to, claims: new FormData(form).getAll('sources') }); }}>
        <Field label="Proposed trip title" name="title" /><Field label="Trip start" name="from" type="date" /><Field label="Trip end" name="to" type="date" />
        <fieldset className="field-wide"><legend>Source drafts</legend>{own.filter((c: D) => c.status === 'draft' && c.revision === 0).map((c: D) => <label className="check" key={c.id}><input name="sources" type="checkbox" value={c.id} /> {claimNumber(c.number)} · {c.title}</label>)}</fieldset>
      </Form>
      <Form label="Prepare expense review" onSubmit={v => prepared(`${['preparations','expenses'].join('/')}/${v.claim}`, {})}>
        <Field label="Claim to review" name="claim" options={own.map((c: D) => ({ value: c.id, label: `${claimNumber(c.number)} · ${c.title}` }))} />
      </Form>
    </>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
