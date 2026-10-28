import { useState } from 'react';
import { amountText, call, money, type D } from './api';
import { Choice, Empty, Field, Form, Section } from './parts';
import { PolicyRules } from './policy';
import { WorkflowEditor } from './workflow-editor';

/** Entity configuration stays beside the existing business configuration in Settings. */
export function EntitySettings({ state, reload, onNotice }: { state: D; reload: () => Promise<D>; onNotice: (message: string) => void }) {
  const [selected, setSelected] = useState('primary');
  const entity = state.entities.find((entry: D) => entry.id === selected);
  const saved = async (message: string) => { await reload(); onNotice(message); };
  const entityState = entity && { ...state, business: { ...state.business, ...entity }, categories: entity.categories, members: state.members.filter((member: D) => entity.members.includes(member.email)), approvalWorkflow: entity.workflow };
  return <>
    <Section title="Entities">
      <Choice label="Configure entity" value={selected} onChange={(event: any) => setSelected(event.target.value)}>
        {state.entities.map((entry: D) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.currency}</option>)}
        <option value="new">Add an entity…</option>
      </Choice>
      {entity?.id === 'primary' ? <p className="muted">Configure {entity.name} in Business, Expense categories, Approval workflows and Expense policy. Manage its membership below.</p> : <div className="sub-form">
        <h3>{entity ? entity.name : 'New entity'}</h3>
        <Form key={`${selected}:${entity?.version ?? 'new'}`} label={entity ? 'Save entity' : 'Create entity'} onSubmit={async values => {
          const created = await call('settings/entities', { ...values, ...(entity ? { id: entity.id, version: entity.version } : {}) });
          await saved(entity ? 'Entity saved.' : 'Entity created. Assign its people, then configure categories and approvals.');
          if (!entity) setSelected(created.id);
        }}>
          <Field label="Entity name" name="name" defaultValue={entity?.name} />
          <Field label="Currency" name="currency" defaultValue={entity?.currency ?? 'USD'} maxLength={3} pattern="[A-Za-z]{3}" />
          <Field label="Time zone" name="timezone" defaultValue={entity?.timezone ?? state.business.timezone} placeholder="America/Toronto" />
          <Field label="Receipts required above" name="receiptThreshold" inputMode="decimal" required={false} defaultValue={entity ? amountText(entity.receipt_threshold_minor) : '75.00'} />
          <Field label="Spend request needed above" name="preapprovalThreshold" inputMode="decimal" required={false} defaultValue={amountText(entity?.preapproval_threshold_minor)} />
          <Field label="Sales tax account" name="salesTaxAccount" required={false} defaultValue={entity?.sales_tax_account ?? ''} />
          <Field label="Sales tax code" name="salesTaxCode" required={false} defaultValue={entity?.sales_tax_code ?? ''} />
          <Field label="ECB currency conversion" name="fxEnabled" type="checkbox" defaultValue={!!entity?.fx_enabled} />
        </Form>
      </div>}
      {entity && <EntityMembers entity={entity} state={state} saved={saved} onNotice={onNotice} />}
    </Section>
    {entity && entity.id !== 'primary' && <>
      <EntityCategories key={entity.id} entity={entity} saved={saved} />
      <WorkflowEditor key={`workflow:${entity.id}`} state={entityState} reload={reload} endpoint={`settings/entities/${entity.id}/workflow`} />
      <PolicyRules key={`policy:${entity.id}`} state={entityState} onChanged={reload} onNotice={onNotice} endpoint={`settings/entities/${entity.id}/policy`} configuredVersions={entity.policies} />
    </>}
  </>;
}

function EntityMembers({ entity, state, saved, onNotice }: { entity: D; state: D; saved: (message: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const members: D[] = state.members.filter((person: D) => person.active || entity.members.includes(person.email));
  return <div className="sub-form"><h3>{entity.name} · People</h3>
    <p className="muted">People may belong to several entities. Membership allows them to start claims for this entity.</p>
    {members.length ? <ul className="ruled-list">{members.map(person => <li key={person.email}>
      <label className="check"><input type="checkbox" checked={entity.members.includes(person.email)} disabled={busy || !person.active} onChange={async event => {
        setBusy(true);
        try { await call(`settings/entities/${entity.id}/members`, { email: person.email, active: event.target.checked }); await saved('Entity membership saved.'); }
        catch (error) { onNotice((error as Error).message); }
        finally { setBusy(false); }
      }} />{person.name}{!person.active ? ' (inactive)' : ''}</label>
      <span className="muted">{person.email} · {state.entities.filter((entry: D) => entry.members.includes(person.email)).map((entry: D) => entry.name).join(', ') || 'No entities assigned'}</span>
    </li>)}</ul> : <Empty title="No people to assign">Add people under People, then assign their entities here.</Empty>}
  </div>;
}

function EntityCategories({ entity, saved }: { entity: D; saved: (message: string) => Promise<void> }) {
  const [category, setCategory] = useState<D | null>(null);
  return <Section title={`${entity.name} · Expense categories`}>
    {entity.categories.length ? <table className="plain"><thead><tr><th>Category</th><th>Account</th><th>Tax code</th><th className="figure">Limit per expense</th><th>Receipt</th><th>Status</th><th><span className="visually-hidden">Change</span></th></tr></thead><tbody>
      {entity.categories.map((entry: D) => <tr key={entry.id}>
        <td>{entry.name}</td><td><span className="mobile-label">Account </span>{entry.account_code}{entry.ledger_account && <span className="muted"> · {entry.ledger_account.name}</span>}</td><td><span className="mobile-label">Tax </span>{entry.tax_code || '—'}</td>
        <td className="figure">{entry.limit_minor == null ? 'No limit' : money(entry.limit_minor, entity.currency)}</td><td>{entry.receipt_always ? 'Always' : 'Over the threshold'}</td><td>{entry.active ? 'In use' : 'Retired'}</td>
        <td><button className="button small" onClick={() => setCategory(entry)}>Change</button></td>
      </tr>)}
    </tbody></table> : <Empty title="No categories yet">Add the categories and account mappings for this entity.</Empty>}
    <div className="sub-form"><h3>{category ? `Change ${category.name}` : 'Add a category'}</h3>
      <Form key={category?.id ?? 'new'} label={category ? 'Save category' : 'Add category'} onSubmit={async values => {
        await call(`settings/entities/${entity.id}/categories`, { ...values, id: category?.id }); setCategory(null); await saved('Entity category saved.');
      }} secondary={category && <button type="button" className="button" onClick={() => setCategory(null)}>Cancel</button>}>
        <Field label="Category name" name="name" defaultValue={category?.name} />
        <Field label="Account code" name="accountCode" defaultValue={category?.account_code} />
        <Field label="Tax code" name="taxCode" defaultValue={category?.tax_code} />
        <Field label={`Limit per expense (${entity.currency})`} name="limit" inputMode="decimal" required={false} defaultValue={amountText(category?.limit_minor)} />
        <Field label={`Limit per person (${entity.currency})`} name="perPersonLimit" inputMode="decimal" required={false} defaultValue={amountText(category?.per_person_limit_minor)} />
        <Field label="Required fields" name="requiredFields" required={false} defaultValue={category?.required_fields.join(', ') ?? ''} />
        <Field label="Always needs a receipt" name="receiptAlways" type="checkbox" defaultValue={!!category?.receipt_always} />
        <Field label="In use" name="active" type="checkbox" defaultValue={category ? !!category.active : true} />
      </Form>
    </div>
  </Section>;
}
