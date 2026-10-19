import { useCallback, useEffect, useState } from 'react';
import { call, exceptionWords, money, moment, plural, type D } from './api';
import { Badge, Empty, Field, Form, Section } from './parts';

/** Finance's one queue of open policy exceptions across every claim, by risk or by age, and the audit sample. */
export function ExceptionQueue({ state }: { state: D }) {
  const [sort, setSort] = useState('risk'), [queue, setQueue] = useState<D>(), [error, setError] = useState('');
  const load = useCallback(async () => { try { setQueue(await call(`exceptions?sort=${sort}`)); setError(''); } catch (e) { setError((e as Error).message); } }, [sort]);
  useEffect(() => { load(); }, [load]);
  const finance = state.actor.roles.finance;
  if (!queue) return <Section title="Exception queue" label="Exception queue"><p className="muted">{error || 'Opening the queue…'}</p></Section>;
  return <>
    <Section title={`Exception queue · ${queue.open.length}`} label="Exception queue" actions={<label className="field"><span className="field-label">Order</span><select value={sort} onChange={e => setSort(e.target.value)}><option value="risk">Highest risk first</option><option value="age">Oldest first</option></select></label>}>
      {queue.open.length ? <ul className="ruled-list">{queue.open.map((x: D) => <li key={`${x.claim}-${x.item}-${x.code}`} className="job">
        <span><strong>{x.number}</strong> · {state.names[x.employee] ?? x.employee} · {x.merchant} · {money(x.amountMinor, x.currency)} · {exceptionWords[x.code] ?? x.code} (risk {x.risk}) · {plural(x.ageDays, 'day')} old{x.explanation ? ` · “${x.explanation}”` : ''}</span>
        {finance && <Form label="Mark reviewed" className="record-form-inline" onSubmit={async v => { setQueue(await call('exceptions/review', { claim: x.claim, revision: x.revision, item: x.item, code: x.code, note: v.note })); }}>
          <Field label="Review note" name="note" placeholder="Checked with the employee" />
        </Form>}
      </li>)}</ul> : <Empty title="No open exceptions">Every exception on submitted and approved claims has been reviewed.</Empty>}
    </Section>
    <Section title="Audit sample" label="Audit sample">
      <p className="muted">{queue.samplePercent ? `${queue.samplePercent}% of approvals are sampled: exactly ${queue.samplePercent} in every 100, in approval order.` : 'Sampling is off.'}</p>
      {finance && <Form label="Save sample" className="record-form-inline" onSubmit={async v => { await call('settings/audit-sample', { percent: v.percent }); await load(); }}>
        <Field label="Percent of approvals" name="percent" required={false} defaultValue={queue.samplePercent ?? ''} placeholder="10" />
      </Form>}
      {queue.samples.length > 0 && <ul className="ruled-list">{queue.samples.map((s: D) => <li key={`${s.claim_id}-${s.revision}`} className="job">
        <span><strong>{s.number}</strong> revision {s.revision} · {s.title} · {money(s.total_minor, s.currency)} · sampled {moment(s.sampled_at)}</span>
        {s.outcome ? <span><Badge status={s.outcome === 'clean' ? 'approved' : 'returned'} words={s.outcome === 'clean' ? 'Clean' : 'Issue found'} />{s.finding ? ` ${s.finding}` : ''} · {state.names[s.finding_by] ?? s.finding_by}</span>
          : finance && <Form label="Record finding" className="record-form-inline" onSubmit={async v => { setQueue(await call('audit-samples/finding', { claim: s.claim_id, revision: s.revision, outcome: v.outcome, finding: v.finding })); }}>
            <Field label="Outcome" name="outcome" options={[{ value: 'clean', label: 'Clean' }, { value: 'issue', label: 'Issue found' }]} />
            <Field label="Finding" name="finding" required={false} />
          </Form>}
      </li>)}</ul>}
    </Section>
  </>;
}
