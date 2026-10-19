import { call, moment, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const LEVELS = [{ value: 'submit', label: 'Submit only: capture, build and submit claims' }, { value: 'full', label: 'Full: everything you can do, except your delegates, agent keys and sign-in' }];

/** Delegate access (ADMIN-005): who may act in a person's name, at which level; the person, the delegate or the owner ends it. */
export function Delegates({ state, reload, onNotice }: { state: D; reload: () => Promise<unknown>; onNotice: (text: string) => void }) {
  const me = state.actor.email, owner = state.actor.roles.owner, name = (address: string) => state.names[address] ?? address;
  const people = Object.keys(state.names).map(address => ({ value: address, label: name(address) }));
  return <Section title="Delegates">
    <p className="muted">A delegate is a colleague who works in your name, such as an assistant who files your receipts. Everything they do is recorded as theirs, on your behalf. They never approve their own claims or yours.</p>
    {state.delegates.length ? <ul className="ruled-list">{state.delegates.map((g: D) => <li key={g.id} className="job">
      <span>{g.grantor_email === me ? 'You' : name(g.grantor_email)} → {g.delegate_email === me ? 'you' : name(g.delegate_email)} · {g.level === 'full' ? 'Full' : 'Submit only'} · since {moment(g.created_at)}</span>
      <button className="button small" onClick={async () => { try { await call(`delegates/${g.id}/revoke`, {}); onNotice('Delegate access ended.'); await reload(); } catch (e) { onNotice((e as Error).message); } }}>End access</button>
    </li>)}</ul> : <Empty title="No delegates" />}
    <div className="sub-form"><h3>Give delegate access</h3><Form label="Give access" onSubmit={async (v, form) => { const grant = await call('delegates', v); form.reset(); onNotice(`${name(grant.delegate)} can now act for ${grant.grantor === me ? 'you' : name(grant.grantor)}.`); await reload(); }}>
      {owner && <Field label="For" name="grantor" required={false} options={people} hint="Leave empty for yourself; the owner can grant for anyone" />}
      <Field label="Delegate" name="delegate" options={people.filter(p => p.value !== me)} />
      <Field label="Access" name="level" options={LEVELS} defaultValue="submit" />
    </Form></div>
  </Section>;
}
