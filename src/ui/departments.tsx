import { useState } from 'react';
import { call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

/** Departments and their heads (ADMIN-001): the owner or an admin names them, and each person is placed in one under People. */
export function Departments({ state, reload, onNotice }: { state: D; reload: () => Promise<unknown>; onNotice: (words: string) => void }) {
  const [editing, setEditing] = useState<D | null>(null), heads = state.members.filter((m: D) => m.active && m.is_manager).map((m: D) => ({ value: m.email, label: m.name }));
  return <Section title="Departments">
    <p className="muted">A department's head sees the spend of everyone in it, and a manager sees everyone below them in the approving-manager chain. People are placed in a department under People.</p>
    {state.departments.length ? <table className="plain"><thead><tr><th>Department</th><th>Head</th><th className="figure">People</th><th><span className="visually-hidden">Change</span></th></tr></thead><tbody>
      {state.departments.map((d: D) => <tr key={d.id}><td>{d.name}{!d.active && ' (retired)'}</td><td><span className="mobile-label">Head </span>{d.head_email ? state.names[d.head_email] ?? d.head_email : 'None'}</td><td className="figure">{d.members}</td><td><button className="button small" onClick={() => setEditing(d)} aria-label={`Change ${d.name}`}>Change</button></td></tr>)}
    </tbody></table> : <Empty title="No departments yet">Add the departments your reports and budgets group by.</Empty>}
    <div className="sub-form"><h3>{editing ? `Change ${editing.name}` : 'Add a department'}</h3>
      <Form key={editing?.id ?? 'new'} label={editing ? 'Save department' : 'Add department'} onSubmit={async (v, form) => { await call('settings/departments', { ...v, id: editing?.id }); setEditing(null); form.reset(); onNotice('Department saved.'); await reload(); }} secondary={editing ? <button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button> : undefined}>
        <Field label="Department name" name="name" defaultValue={editing?.name} />
        <Field label="Department head" name="head" required={false} defaultValue={editing?.head_email ?? ''} options={heads} hint="An active approver" />
        {editing && <Field label="In use" name="active" type="checkbox" defaultValue={editing.active === 1} />}
      </Form>
    </div>
  </Section>;
}
