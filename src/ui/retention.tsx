import { useEffect, useState } from 'react';
import { call, day, money, moment, type D } from './api';
import { Badge, Empty, Field, Form, Section } from './parts';

const SCOPES = [{ value: 'person', label: 'One person' }, { value: 'business', label: 'The whole business' }, { value: 'period', label: 'Expense dates' }];

/** Record retention and legal holds (RETAIN-001): the owner sets the period, confirms what the hourly run proposes and
 * places or releases holds; every confirmed expiry keeps its receipt. */
export function Retention({ state, onNotice }: { state: D; onNotice: (words: string) => void }) {
  const [r, setR] = useState<D>(), currency = state.business.currency;
  useEffect(() => { call('retention').then(setR, () => setR(undefined)); }, []);
  const act = async (path: string, body: D, words: string) => { const next = await call(path, body); onNotice(words); setR(path.includes('/confirm') ? await call('retention') : next); };
  if (!r) return null;
  const hold = (h: D) => h.scope === 'business' ? 'Whole business' : h.scope === 'person' ? state.names[h.member_email] ?? h.member_email : `Expenses dated ${day(h.from_day)} to ${day(h.to_day)}`;
  return <Section title="Retention and legal holds">
    <p className="muted">Paid and rejected claims are kept for {r.years} {r.years === 1 ? 'year' : 'years'} after they were paid or rejected. Coaster proposes what has passed that; nothing is removed until you confirm, and each confirmation leaves a receipt. A legal hold stops expiry and erasure for what it covers until you release it.</p>
    <Form key={r.years} label="Save retention" onSubmit={v => act('settings/retention', v, 'Retention saved.')}>
      <Field label="Keep paid and rejected claims for (years)" name="years" inputMode="numeric" defaultValue={String(r.years)} hint="1 to 30; seven years by default" />
    </Form>
    {r.proposal ? <div className="sub-form"><h3>Ready to expire</h3>
      <ul className="ruled-list">{r.proposal.claims.flatMap((u: D) => u.claims).map((c: D) => <li key={c.id}>CL-{String(c.number).padStart(4, '0')} · last changed {moment(c.updated_at)}</li>)}</ul>
      <button className="button" onClick={() => act(`retention/${r.proposal.id}/confirm`, {}, 'Expiry confirmed; its receipt is below.')}>Confirm expiry</button>
    </div> : <p className="muted">Nothing is waiting to expire.</p>}
    <div className="sub-form"><h3>Legal holds</h3>
      {r.holds.length ? <ul className="ruled-list">{r.holds.map((h: D) => <li key={h.id} className="job"><span>{hold(h)} · {h.reason} · placed {moment(h.placed_at)}</span>{h.released_at ? <Badge status="declined" words="Released" /> : <button className="button small" onClick={() => act(`legal-holds/${h.id}/release`, {}, 'Hold released.')}>Release</button>}</li>)}</ul> : <Empty title="No legal holds" />}
      <Form label="Place hold" onSubmit={(v, form) => act('legal-holds', v, 'Hold placed.').then(() => form.reset())}>
        <Field label="Hold" name="scope" options={SCOPES} defaultValue="person" />
        <Field label="Person on hold" name="member" required={false} options={Object.entries(state.names).map(([value, label]) => ({ value, label: String(label) }))} />
        <Field label="Hold expenses from" name="from" type="date" required={false} />
        <Field label="Hold expenses to" name="to" type="date" required={false} />
        <Field label="Hold reason" name="reason" />
      </Form>
    </div>
    {r.receipts.length > 0 && <div className="sub-form"><h3>Expiry receipts</h3><ul className="ruled-list">{r.receipts.map((x: D) => <li key={x.proposal}>{moment(x.confirmedAt)} by {x.confirmedBy} · {x.expired.length} expired ({x.expired.map((e: D) => `${e.claim} ${money(e.totalMinor, currency)}`).join(', ') || 'none'}){x.skipped.length ? ` · ${x.skipped.length} skipped` : ''}</li>)}</ul></div>}
  </Section>;
}
