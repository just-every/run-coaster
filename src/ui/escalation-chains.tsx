import { call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const STEPS = [{ value: 'department-head', label: 'The person\'s department head' }, { value: 'manager', label: 'The person\'s approving manager' }, { value: 'finance', label: 'A named finance approver' }];

/** Finance's escalation chain by department (FOLLOWUP-002): up to two steps, in place of the approving manager then finance. */
export function EscalationChains({ state, reload, onNotice }: { state: D; reload: () => Promise<unknown>; onNotice: (words: string) => void }) {
  const finance = state.members.filter((m: D) => m.active && m.is_finance).map((m: D) => ({ value: m.email, label: m.name }));
  const department = (id: string) => id ? state.departments.find((d: D) => d.id === id)?.name ?? id : 'Every department without its own chain';
  const words = (s: D) => s.kind === 'finance' ? `finance approver ${state.names[s.email] ?? s.email}` : STEPS.find(x => x.value === s.kind)?.label.toLowerCase();
  return <Section title="Escalation chains">
    <p className="muted">When an item passes its service level or runs out of reminders, it escalates along the chain for the owing person's department, one step each time. Without a chain it goes to their approving manager, then finance.</p>
    {state.escalationChains.length ? <ul className="ruled-list">{state.escalationChains.map((c: D) => <li key={c.department_id}><strong>{department(c.department_id)}</strong> · v{c.version}<br /><span className="muted">{c.steps.map(words).join(', then ')}</span></li>)}</ul> : <Empty title="No chains set">Escalation goes to the approving manager, then finance.</Empty>}
    <div className="sub-form"><h3>Set a chain</h3>
      <Form label="Save chain" onSubmit={async (v, form) => {
        const steps = [{ kind: v.first, email: v.firstPerson }, ...(v.second ? [{ kind: v.second, email: v.secondPerson }] : [])].map(s => s.kind === 'finance' ? s : { kind: s.kind });
        await call('settings/escalation-chains', { department: v.department, steps }); form.reset(); onNotice('Escalation chain saved.'); await reload();
      }}>
        <Field label="Chain for" name="department" required={false} options={state.departments.filter((d: D) => d.active).map((d: D) => ({ value: d.id, label: d.name }))} hint="Choose… sets the chain for every department without its own" />
        <Field label="First step" name="first" options={STEPS} />
        <Field label="First step finance approver" name="firstPerson" required={false} options={finance} hint="Only for a named finance approver" />
        <Field label="Second step" name="second" required={false} options={STEPS} />
        <Field label="Second step finance approver" name="secondPerson" required={false} options={finance} hint="Only for a named finance approver" />
      </Form>
    </div>
  </Section>;
}
