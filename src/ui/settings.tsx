import { useState } from 'react';
import { amountText, call, money, moment, rate, rateText, type D } from './api';
import { Badge, Empty, Field, Form, PageHead, Section } from './parts';
import { Work } from './shell';
import type { ViewProps } from './claims';

/** Business policy, categories and people for the owner; everyone manages their own agent keys here. */
export function Settings({ state, reload }: ViewProps) {
  const owner = state.actor.roles.owner, b = state.business;
  const [category, setCategory] = useState<D | null>(null), [member, setMember] = useState<D | null>(null), [notice, setNotice] = useState(''), [token, setToken] = useState<D>();
  const saved = async (message: string) => { setNotice(message); await reload(); };
  const managers = state.members.filter((m: D) => m.is_manager && m.active);
  return <Work className="settings">
    <PageHead title="Settings" line={owner ? b ? `${b.name} · ${b.currency} · ${b.timezone} · mileage ${rate(b.mileage_rate_thousandths, b.currency)} a mile` : 'Name the business first; categories and people follow.' : 'Your agent keys. The owner manages the business, categories and people.'} />
    <p className="notice" role="status" aria-live="polite">{notice}</p>
    <div className="cards">
    <div className="cards-2">
    {owner && <Section title="Business" className="business">
      <Form label="Save business" onSubmit={async v => { await call('settings/business', v); await saved('Business saved.'); }}>
        <Field label="Business name" name="name" defaultValue={b?.name} />
        <Field label="Currency" name="currency" defaultValue={b?.currency ?? 'USD'} maxLength={3} hint="Fixed once claims exist" />
        <Field label="Timezone" name="timezone" defaultValue={b?.timezone ?? 'America/Chicago'} />
        <Field label="Mileage rate per mile" name="mileageRate" inputMode="decimal" defaultValue={b ? rateText(b.mileage_rate_thousandths) : '0.725'} hint="The IRS standard business rate for 2026 is 72.5¢ a mile (0.725)" />
        <Field label="Per diem per day" name="perDiem" inputMode="decimal" required={false} defaultValue={b?.per_diem_minor ? amountText(b.per_diem_minor) : ''} hint="Leave empty if you do not pay per diems" />
        <Field label="Receipts required above" name="receiptThreshold" inputMode="decimal" required={false} defaultValue={b?.receipt_threshold_minor ? amountText(b.receipt_threshold_minor) : ''} hint="Leave empty to require a receipt for every purchase" />
      </Form>
    </Section>}
    <Section title="Agent keys">
      <p className="muted">An agent with your key can prepare draft claims{state.actor.roles.finance ? ' and batch proposals' : ''} for you to accept. It cannot submit, approve, batch or pay anything.</p>
      {token && <div className="notice key-once" role="status"><label htmlFor="new-agent-key">Copy this key now; Coaster shows it only once.</label><input id="new-agent-key" className="key-field" readOnly value={token.token} onFocus={e => e.currentTarget.select()} /></div>}
      {state.agentKeys.length ? <ul className="ruled-list">{state.agentKeys.map((k: D) => <li key={k.id} className="job"><span>{k.label} · made {moment(k.created_at)}</span>{k.revoked_at ? <Badge status="declined" words="Revoked" /> : <button className="button small" onClick={async () => { await call(`agent-keys/${k.id}/revoke`, {}); await saved('Key revoked.'); }}>Revoke</button>}</li>)}</ul> : <Empty title="No agent keys" />}
      <div className="sub-form"><Form label="Make agent key" onSubmit={async (v, form) => { setToken(await call('agent-keys', v)); form.reset(); await reload(); }}>
        <Field label="Agent name" name="label" placeholder="Receipt inbox agent" />
      </Form></div>
    </Section>
    </div>
    {owner && b && <Section title="Expense categories">
      {state.categories.length ? <table className="plain"><thead><tr><th>Category</th><th>Account</th><th>Tax code</th><th className="figure">Limit per expense</th><th>Status</th><th><span className="visually-hidden">Change</span></th></tr></thead><tbody>
        {state.categories.map((c: D) => <tr key={c.id}><td>{c.name}</td><td><span className="mobile-label">Account </span>{c.account_code}</td><td><span className="mobile-label">Tax </span>{c.tax_code}</td><td className="figure">{c.limit_minor == null ? 'No limit' : money(c.limit_minor, b.currency)}</td><td>{c.active ? 'In use' : 'Retired'}</td><td><button className="button small" onClick={() => setCategory(c)}>Change</button></td></tr>)}
      </tbody></table> : <Empty title="No categories yet">Add the categories your accountant expects, with their account and tax codes.</Empty>}
      <div className="sub-form"><h3>{category ? `Change ${category.name}` : 'Add a category'}</h3><Form key={category?.id ?? 'new'} label={category ? 'Save category' : 'Add category'} onSubmit={async v => { await call('settings/categories', { ...v, id: category?.id }); setCategory(null); await saved('Category saved.'); }} secondary={category ? <button type="button" className="button" onClick={() => setCategory(null)}>Cancel</button> : undefined}>
        <Field label="Category name" name="name" defaultValue={category?.name} />
        <Field label="Account code" name="accountCode" defaultValue={category?.account_code} />
        <Field label="Tax code" name="taxCode" defaultValue={category?.tax_code} hint="For example TAX or NON" />
        <Field label="Limit per expense" name="limit" inputMode="decimal" required={false} defaultValue={category?.limit_minor == null ? '' : amountText(category.limit_minor)} />
        <Field label="In use" name="active" type="checkbox" defaultValue={category ? category.active === 1 : true} />
      </Form></div>
    </Section>}
    {owner && b && <Section title="People">
      {state.members.length ? <table className="plain"><thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Approver</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>
        {state.members.map((m: D) => <tr key={m.email}><td>{m.name}{!m.active && ' (inactive)'}</td><td>{m.email}</td><td>{[m.is_employee && 'Employee', m.is_manager && 'Manager', m.is_finance && 'Finance'].filter(Boolean).join(', ')}</td><td><span className="mobile-label">Approver </span>{state.members.find((x: D) => x.email === m.approver_email)?.name ?? '—'}</td><td className="row-actions"><button className="button small" onClick={() => setMember(m)}>Change</button><button className="button small" onClick={async () => { try { await call('settings/members/invite', { email: m.email }); setNotice(`Invitation sent to ${m.email}.`); } catch (e) { setNotice((e as Error).message); } }}>Invite</button></td></tr>)}
      </tbody></table> : <Empty title="Nobody added yet">Add yourself and your team. Each employee needs an approving manager.</Empty>}
      <div className="sub-form"><h3>{member ? `Change ${member.name}` : 'Add a person'}</h3><Form key={member?.email ?? 'new'} label={member ? 'Save person' : 'Add person'} onSubmit={async v => { await call('settings/members', v); setMember(null); await saved('Person saved.'); }} secondary={member ? <button type="button" className="button" onClick={() => setMember(null)}>Cancel</button> : undefined}>
        <Field label="Name" name="name" defaultValue={member?.name} />
        <Field label="Email" name="email" type="email" defaultValue={member?.email} readOnly={!!member} />
        <fieldset className="roles field-wide"><legend>Roles</legend>
          <Field label="Employee" name="employee" type="checkbox" defaultValue={member ? member.is_employee : true} />
          <Field label="Manager" name="manager" type="checkbox" defaultValue={member?.is_manager} />
          <Field label="Finance" name="finance" type="checkbox" defaultValue={member?.is_finance} />
        </fieldset>
        <Field label="Approving manager" name="approver" required={false} defaultValue={member?.approver_email ?? ''} options={managers.filter((m: D) => m.email !== member?.email).map((m: D) => ({ value: m.email, label: m.name }))} />
        <Field label="Active" name="active" type="checkbox" defaultValue={member ? member.active === 1 : true} />
      </Form></div>
    </Section>}
    </div>
  </Work>;
}
