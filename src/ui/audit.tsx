import { useState } from 'react';
import { batchNumber, call, claimNumber, moment, type D } from './api';
import { describe } from './history';
import { Empty, Field, Form, Section } from './parts';

/** Search every history line and download a period's audit pack: the owner, finance and auditors. */
export function AuditRecords({ state }: { state: D }) {
  const [lines, setLines] = useState<D[]>(), [more, setMore] = useState(false);
  return <Section title="History and audit pack">
    <p className="muted">Search every claim, batch and setting change: who did it, when, and whether in the app or through an agent. Auditors read everything and change nothing.</p>
    <Form label="Search history" onSubmit={async v => { const found = await call(`history?${new URLSearchParams({ q: v.q ?? '', ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) })}`); setLines(found.lines); setMore(found.more); }}>
      <Field label="Claim, batch, person or words" name="q" required={false} placeholder="CL-0001" />
      <Field label="From" name="from" type="date" required={false} />
      <Field label="Until" name="to" type="date" required={false} />
    </Form>
    {lines && (lines.length ? <ol className="ruled-list audit-lines">{lines.map(l => <li key={l.seq}>
      <span>{describe(l, state.names)}</span>
      <small className="muted">#{l.seq} · {moment(l.at)}{l.claim ? ` · ${claimNumber(l.claim.number)}` : ''}{l.batch ? ` · ${batchNumber(l.batch.number)}` : ''} · {l.channel === 'agent' ? `agent ${l.agent}` : 'in the app'}</small>
    </li>)}</ol> : <Empty title="No history matches" />)}
    {more && <p className="muted">Showing the latest 500 lines; narrow the dates to see earlier ones.</p>}
    <div className="sub-form"><h3>Export an audit pack</h3><Form label="Download audit pack" onSubmit={async v => {
      const response = await fetch(`/api/coaster/audit-pack?${new URLSearchParams({ from: v.from, to: v.to })}`);
      if (!response.ok) { const refusal = (await response.json().catch(() => ({}))) as D; throw new Error(refusal.error || 'The audit pack could not be made'); }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob()); link.download = `coaster-audit-pack-${v.from}-to-${v.to}.zip`; link.click(); URL.revokeObjectURL(link.href);
    }}>
      <Field label="Period from" name="from" type="date" />
      <Field label="Period until" name="to" type="date" hint="Claims submitted in the period, with every receipt, decision, exception and payment reference, and the period's history" />
    </Form></div>
  </Section>;
}
