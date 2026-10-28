import { Desktop } from './desktop';
import { ProviderCosts } from './provider-costs';
import { CaptureWindow } from './capture-window';
import { WorkflowEditor } from './workflow-editor';
import { EntitySettings } from './entities';
import { useState } from 'react';
import { amountText, call, day, money, moment, rate, today, type D } from './api';
import { Badge, Empty, Field, Form, PageHead, Section } from './parts';
import { Work } from './shell';
import { AuditRecords } from './audit';
import { Reports } from './reports';
import { SpendAnalytics } from './spend';
import { Budgets } from './budgets';
import { Delegates } from './delegates';
import { Allowances } from './allowances';
import { Retention } from './retention';
import { PolicyAdvice } from './policy-advice';
import { PolicyRules } from './policy';
import { Departments } from './departments';
import { EscalationChains } from './escalation-chains';
import { CardReconciliation } from './card-reconciliation';
import { CodingSettings, CategoryAccountField } from './coding';
import { QuickBooks } from './quickbooks';
import { PayrollSettings } from './payroll';
import { BankPeople, BankProviders, MyBank } from './bank';
import { AutomaticCoding } from './automatic-coding';
import { ProgramFeed } from './program-feed';
import { ReceiptReadingSettings } from './receipt-reading';
import { ReceiptEmailSettings } from './receipt-email';
import type { ViewProps } from './claims';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const US_ZONES = [['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii']].map(([value, label]) => ({ value, label: `${label} (${value})` }));

/** Business policy, mileage rates, categories and people for the owner; everyone manages their own agent keys here. */
export function Settings({ state, reload }: ViewProps) {
  const roles = state.actor.roles, owner = roles.owner, admin = owner || roles.admin, reader = admin || roles.finance || roles.auditor || roles.bookkeeper, b = state.business;
  const auditorOnly = roles.auditor && !roles.employee && !roles.manager && !roles.finance && !owner;
  const [category, setCategory] = useState<D | null>(null), [member, setMember] = useState<D | null>(null), [notice, setNotice] = useState(''), [token, setToken] = useState<D>();
  const saved = async (message: string) => { setNotice(message); await reload(); };
  const primaryCategories = state.categories.filter((c: D) => (c.entity_id ?? 'primary') === 'primary');
  const primaryState = { ...state, categories: primaryCategories };
  const managers = state.members.filter((m: D) => m.is_manager && m.active);
  const mileageNow = b?.mileage_rates.filter((r: D) => r.effective_from <= today()).at(-1);
  const zones = b && !US_ZONES.some(z => z.value === b.timezone) ? [...US_ZONES, { value: b.timezone, label: b.timezone }] : US_ZONES;
  return <Work className="settings">
    <PageHead title="Settings" line={owner ? b ? `${b.name} · ${b.currency} · ${b.timezone}${mileageNow ? ` · mileage ${rate(mileageNow.rate_thousandths, b.currency)} a mile` : ''}` : 'Name the business first; categories and people follow.' : auditorOnly ? 'History and audit packs. Auditors read every record and change nothing.' : 'Your agent keys. The owner manages the business, categories and people.'} />
    <p className="notice" role="status" aria-live="polite">{notice}</p>
    <div className="cards">
    <div className="cards-2">
    {admin && <Section title="Business" className="business">
      <Form label="Save business" onSubmit={async v => { await call('settings/business', v); await saved('Business saved.'); }}>
        <Field label="Business name" name="name" defaultValue={b?.name} />
        <Field label="Currency" name="currency" defaultValue={b?.currency ?? 'USD'} maxLength={3} hint="Fixed once claims exist" />
        <Field label="ECB currency conversion" name="fxEnabled" type="checkbox" required={false} defaultValue={b?.fx_enabled === 1} />
        <p className="muted field-wide">Use the ECB reference rate, not your card’s rate, for foreign-currency purchases and imports. Coaster reads a fixed public European Central Bank rate file with a GET request; no expense, receipt or employee data is sent. Each conversion keeps its rate, date and source. Employees can enter a rate by hand when conversion is off or a reference rate is unavailable; the approver sees its source.</p>
        <Field label="Time zone" name="timezone" defaultValue={b?.timezone ?? 'America/Chicago'} options={zones} />
        <Field label="Company per diem per day" name="perDiem" inputMode="decimal" required={false} defaultValue={b?.per_diem_minor ? amountText(b.per_diem_minor) : ''} hint="Optional company flat daily rate; published government location rates remain available" />
        <Field label="Receipts required above" name="receiptThreshold" inputMode="decimal" required={false} defaultValue={b ? b.receipt_threshold_minor ? amountText(b.receipt_threshold_minor) : '' : '75.00'} hint="$75 is the IRS documentary-evidence line; lodging always needs a receipt. Leave empty to require one for every purchase" />
        <Field label="Spend request needed above" name="preapprovalThreshold" inputMode="decimal" required={false} defaultValue={b?.preapproval_threshold_minor == null ? '' : amountText(b.preapproval_threshold_minor)} hint="Expenses over this need an approved spend request; leave empty to turn it off" />
        <Field label="Sales tax account" name="salesTaxAccount" required={false} defaultValue={b?.sales_tax_account ?? ''} hint="Receipts' sales tax posts here on its own accounting line" />
        <Field label="Sales tax code" name="salesTaxCode" required={false} defaultValue={b?.sales_tax_code ?? ''} hint="For example TAX" />
      </Form>
    </Section>}
    {!auditorOnly && <Section title="Agent keys">
      <p className="muted">An agent with your key can prepare draft claims{state.actor.roles.finance ? ' and batch proposals' : ''} for you to accept. It cannot submit, approve, batch or pay anything.</p>
      {token && <div className="notice key-once" role="status"><label htmlFor="new-agent-key">Copy this key now; Coaster shows it only once.</label><input id="new-agent-key" className="key-field" readOnly value={token.token} onFocus={e => e.currentTarget.select()} /></div>}
      {state.agentKeys.length ? <ul className="ruled-list">{state.agentKeys.map((k: D) => <li key={k.id} className="job"><span>{k.label} · made {moment(k.created_at)}</span>{k.revoked_at ? <Badge status="declined" words="Revoked" /> : <button className="button small" onClick={async () => { await call(`agent-keys/${k.id}/revoke`, {}); await saved('Key revoked.'); }}>Revoke</button>}</li>)}</ul> : <Empty title="No agent keys" />}
      <div className="sub-form"><Form label="Make agent key" onSubmit={async (v, form) => { setToken(await call('agent-keys', v)); form.reset(); await reload(); }}>
        <Field label="Agent name" name="label" placeholder="Receipt inbox agent" />
      </Form></div>
    </Section>}
    </div>
    {admin && b && !state.actor.delegate && <EntitySettings state={state} reload={reload} onNotice={setNotice} />}
    {!auditorOnly && !state.actor.delegate && <Delegates state={state} reload={reload} onNotice={setNotice} />}
    {b && (roles.employee || roles.finance || owner) && <Allowances state={state} reload={reload} onNotice={setNotice} />}
    {(owner || roles.finance) && b && <CaptureWindow />}
    {(owner || roles.finance) && b && <Section title="Reminders">
      <p className="muted">Coaster emails whoever owes something (a receipt, a submission, a held claim, an answer or a decision) on the business days you set after it first opens, on US business days outside quiet hours ({b.timezone}), escalates what stays undone, and stops once it is done.</p>
      <Form label="Save reminders" onSubmit={async v => { await call('settings/reminders', v); await saved('Reminders saved.'); }}>
        <Field label="Remind after these business days" name="days" defaultValue={b.reminder_days.join(', ')} hint="Up to five rising numbers, such as 2, 5, 10" />
        <Field label="Quiet from (hour)" name="quietFrom" inputMode="numeric" defaultValue={String(b.quiet_from)} hint="0 to 23" />
        <Field label="Quiet until (hour)" name="quietUntil" inputMode="numeric" defaultValue={String(b.quiet_until)} />
        <Field label="Approval service level (business days)" name="serviceLevel" inputMode="numeric" defaultValue={String(b.service_level_days)} hint="A claim waiting longer escalates to the approver's manager, then finance" />
        <Field label="Escalate after (business days)" name="escalateAfter" inputMode="numeric" required={false} defaultValue={b.escalation_days == null ? '' : String(b.escalation_days)} hint="After the last reminder, to the person's manager, then the same again to finance; empty turns escalation off" />
      </Form>
    </Section>}
    {b && !state.actor.delegate && (admin || roles.finance || roles.bookkeeper) && <><QuickBooks state={state} /><Desktop state={state} /></>}
    {b && roles.employee && !state.actor.delegate && <MyBank name={state.actor.name} />}
    {b && (owner || roles.finance) && !state.actor.delegate && <BankPeople />}
    {b && owner && !state.actor.delegate && <BankProviders />}
    {b && owner && !state.actor.delegate && <PayrollSettings members={state.members} />}
    {b && !state.actor.delegate && (admin || roles.finance) && <ProgramFeed state={state} />}
    {b && owner && !state.actor.delegate && <ProviderCosts />}
    {b && admin && !state.actor.delegate && <ReceiptReadingSettings />}
    {b && roles.employee && !state.actor.delegate && <ReceiptEmailSettings />}
    {b && admin && <CodingSettings state={primaryState} reload={reload} />}
    {b && !auditorOnly && <AutomaticCoding state={state} />}
    {b && (reader || roles.cardAdmin) && <CardReconciliation state={state} />}
    {b && (reader || roles.manager) && <SpendAnalytics currency={b.currency} canConsolidate={reader} />}
    {b && reader && <Budgets state={state} canSet={admin || roles.finance} />}
    {reader && <Reports owner={owner} schedules={owner || roles.finance} />}
    {(admin || roles.finance || roles.auditor) && <AuditRecords state={state} />}
    {admin && b && <WorkflowEditor state={primaryState} reload={reload} />}
    {admin && b && <Section title="Approval by rule">
      <p className="muted">{state.approvalRule?.enabled ? `Rule v${state.approvalRule.version}: a claim approves itself when every expense is under ${money(state.approvalRule.limit_minor, b.currency)}, has its receipt attached and raises no policy exception. Every other claim goes to its approver.` : 'Off: every claim goes to its approver.'} Rule approvals are recorded with the rule's version and audit-sampled like any approval.</p>
      <Form key={state.approvalRule?.version ?? 0} label="Save approval rule" onSubmit={async v => { await call('settings/approval-rule', v); await saved('Approval rule saved.'); }}>
        <Field label="Approve qualifying claims by rule" name="enabled" type="checkbox" defaultValue={state.approvalRule?.enabled === 1} />
        <Field label="Every expense under" name="limit" inputMode="decimal" required={false} defaultValue={state.approvalRule?.limit_minor ? amountText(state.approvalRule.limit_minor) : '75.00'} hint="Each expense must be under this, carry its receipt and raise no policy exception" />
      </Form>
    </Section>}
    {owner && !state.actor.delegate && b && <Section title="Policy agent approval envelope" label="Policy agent envelope">
      <p className="muted">Off until you grant authority. At submission the policy agent may approve an expense strictly under your limit when policy checks pass, receipt or card-match evidence agrees and coding matches an active finance merchant rule. Uncertain evidence goes to the approver. Reports retain their configured approval workflows; no payment is released.</p>
      <p>{state.approvalEnvelope?.enabled ? `Envelope v${state.approvalEnvelope.version} · every qualifying expense under ${money(state.approvalEnvelope.limit_minor,b.currency)}` : 'No active approval envelope'}</p>
      <Form key={state.approvalEnvelope?.version??0} label="Save policy agent envelope" onSubmit={async v=>{await call('settings/approval-envelope',{...v,version:state.approvalEnvelope?.version??0});await saved('Policy agent envelope saved.');}}>
        <Field label="Enable the policy agent envelope" name="enabled" type="checkbox" defaultValue={state.approvalEnvelope?.enabled===1}/>
        <Field label="Envelope expense limit" name="limit" inputMode="decimal" required={false} defaultValue={state.approvalEnvelope?.limit_minor?amountText(state.approvalEnvelope.limit_minor):'100.00'}/>
        <Field label="I authorize qualifying approvals on my behalf" name="consent" type="checkbox" defaultValue={false}/>
      </Form>
    </Section>}
    {owner && b && <Section title="Payment controls">
      <p className="muted">Releasing a reviewed batch needs you, or a finance member you give release access under People, signed in within the last 10 minutes (a recent sign-in, not a second factor), and never someone with a claim in the batch. On the reimbursement day, at 9:00 ({b.timezone}), Coaster opens a draft batch of every approved claim for finance to review; it never releases one.</p>
      <Form key={`${b.dual_release_over_minor ?? 'off'}-${b.pay_weekday ?? 'off'}-${b.advance_account ?? ''}`} label="Save payment controls" onSubmit={async v => { await call('settings/payment-controls', v); await saved('Payment controls saved.'); }}>
        <Field label="Dual release above" name="dualReleaseOver" inputMode="decimal" required={false} defaultValue={b.dual_release_over_minor == null ? '' : amountText(b.dual_release_over_minor)} hint="A batch over this needs a second, different person to release it; leave empty to turn it off" />
        <Field label="Reimbursement day" name="payWeekday" required={false} defaultValue={b.pay_weekday == null ? '' : WEEKDAYS[b.pay_weekday]} options={WEEKDAYS.map(d => ({ value: d, label: `Every ${d}` }))} hint="Choose… turns it off" />
        <Field label="Cash advance account" name="advanceAccount" required={false} defaultValue={b.advance_account ?? ''} hint="The ledger account an advance a claim draws down posts to, as a negative line" />
      </Form>
    </Section>}
    {admin && b && <Section title="Scheduled submission">
      <p className="muted">Expenses added without choosing a claim collect in a report for their month or trip. On this schedule, at 9:00 ({b.timezone}), each such report submits its complete expenses to the approver; anything missing a receipt, explanation or required field stays behind and keeps being reminded. Claims built by hand are never submitted for anyone.</p>
      <Form key={b.auto_submit ?? 'off'} label="Save schedule" onSubmit={async v => { await call('settings/auto-submit', v); await saved('Schedule saved.'); }}>
        <Field label="Submit automatic reports" name="schedule" required={false} defaultValue={b.auto_submit ?? ''} options={[{ value: 'daily', label: 'Each business day' }, { value: 'weekly', label: 'Weekly (first business day)' }, { value: 'twice-monthly', label: 'Twice a month (1st and 16th)' }, { value: 'monthly', label: 'Monthly (first business day)' }]} hint="Choose… turns it off" />
      </Form>
    </Section>}
    {admin && b && <Departments state={state} reload={reload} onNotice={setNotice} />}
    {(admin || roles.finance) && b && <EscalationChains state={state} reload={reload} onNotice={setNotice} />}
    {(admin || roles.finance) && b && <PolicyRules state={primaryState} onNotice={setNotice} onChanged={reload} />}
    {(admin || roles.finance) && b && <PolicyAdvice state={state} onNotice={setNotice} onChanged={reload} />}
    {owner && b && <Retention state={state} onNotice={setNotice} />}
    {admin && b && <Section title="Mileage rates">
      <p className="muted">Each trip is priced at the rate in force on its date. {b.currency === 'USD' ? 'Seeded with the IRS standard business mileage rates; add next year\'s rate when the IRS announces it.' : 'Add the rate per mile your business pays from the day it applies.'}</p>
      {b.mileage_rates.length ? <table className="plain"><thead><tr><th>From</th><th className="figure">Rate per mile</th><th><span className="visually-hidden">Remove</span></th></tr></thead><tbody>
        {[...b.mileage_rates].reverse().map((r: D) => <tr key={r.effective_from}><td>{day(r.effective_from)}{r === mileageNow ? ' (in force today)' : ''}</td><td className="figure">{rate(r.rate_thousandths, b.currency)}</td><td><button className="button small" onClick={async () => { try { await call('settings/mileage-rates', { effectiveFrom: r.effective_from, remove: true }); await saved('Mileage rate removed.'); } catch (e) { setNotice((e as Error).message); } }}>Remove</button></td></tr>)}
      </tbody></table> : <Empty title="No mileage rates">Mileage stays off until you add a rate.</Empty>}
      <div className="sub-form"><h3>Add or change a rate</h3><Form label="Save rate" onSubmit={async (v, form) => { await call('settings/mileage-rates', v); form.reset(); await saved('Mileage rate saved.'); }}>
        <Field label="Effective from" name="effectiveFrom" type="date" />
        <Field label="Rate per mile" name="rate" inputMode="decimal" placeholder="0.725" hint="In tenths of a cent, as the IRS sets it" />
      </Form></div>
    </Section>}
    {admin && b && <Section title="Expense categories">
      {primaryCategories.length ? <table className="plain"><thead><tr><th>Category</th><th>Account</th><th>Tax code</th><th className="figure">Limit per expense</th><th>Receipt</th><th>Status</th><th><span className="visually-hidden">Change</span></th></tr></thead><tbody>
        {primaryCategories.map((c: D) => <tr key={c.id}><td>{c.name}{c.required_fields.length > 0 && <small className="muted"> · needs {c.required_fields.join(', ')}</small>}</td><td><span className="mobile-label">Account </span>{c.account_code}{c.ledger_account && <small className="muted"><br />Mapped: {c.ledger_account.name} · {c.ledger_account.source === 'native' ? 'Coaster' : 'QuickBooks'} · {c.ledger_account.sourceId || c.ledger_account.id}{!c.ledger_account_available && ' · unavailable'}</small>}</td><td><span className="mobile-label">Tax </span>{c.tax_code}</td><td className="figure">{c.limit_minor == null ? 'No limit' : money(c.limit_minor, b.currency)}{c.per_person_limit_minor != null ? ` · ${money(c.per_person_limit_minor, b.currency)} a person` : ''}</td><td>{c.receipt_always ? 'Always' : 'Over the threshold'}</td><td>{c.active ? 'In use' : 'Retired'}</td><td><button className="button small" onClick={() => setCategory(c)}>Change</button></td></tr>)}
      </tbody></table> : <Empty title="No categories yet">Add the categories your accountant expects, with their account and tax codes.</Empty>}
      <div className="sub-form"><h3>{category ? `Change ${category.name}` : 'Add a category'}</h3><Form key={category?.id ?? 'new'} label={category ? 'Save category' : 'Add category'} onSubmit={async v => { await call('settings/categories', { ...v, id: category?.id }); setCategory(null); await saved('Category saved.'); }} secondary={category ? <button type="button" className="button" onClick={() => setCategory(null)}>Cancel</button> : undefined}>
        <Field label="Category name" name="name" defaultValue={category?.name} />
        <Field label="Account code" name="accountCode" defaultValue={category?.account_code} hint="Manual code used in accounting exports; independent of the chart-account mapping" />
        <CategoryAccountField catalog={state.coding} category={category} />
        <Field label="Tax code" name="taxCode" defaultValue={category?.tax_code} hint="For example TAX or NON" />
        <Field label="Limit per expense" name="limit" inputMode="decimal" required={false} defaultValue={category?.limit_minor == null ? '' : amountText(category.limit_minor)} />
        <Field label="Limit per person" name="perPersonLimit" inputMode="decimal" required={false} defaultValue={category?.per_person_limit_minor == null ? '' : amountText(category.per_person_limit_minor)} hint="For meals: the amount divided among the attendees" />
        <Field label="Required fields" name="requiredFields" required={false} defaultValue={category?.required_fields?.join(', ') ?? ''} placeholder="Business purpose, Client" hint="Comma-separated; submission is refused while one is blank" />
        <Field label="Always needs a receipt (lodging always does)" name="receiptAlways" type="checkbox" defaultValue={category?.receipt_always === 1} />
        <Field label="In use" name="active" type="checkbox" defaultValue={category ? category.active === 1 : true} />
      </Form></div>
    </Section>}
    {admin && b && <Section title="People">
      {state.members.length ? <table className="plain"><thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Approver</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>
        {state.members.map((m: D) => <tr key={m.email}><td>{m.name}{!m.active && ' (inactive)'}</td><td>{m.email}</td><td>{[m.is_employee && 'Employee', m.is_manager && 'Manager', m.is_finance && 'Finance', m.is_auditor && 'Auditor', m.is_admin && 'Admin', m.is_card_admin && 'Card admin', m.is_bookkeeper && 'Bookkeeper', m.department_id && state.departments.find((d: D) => d.id === m.department_id)?.name, m.may_release && 'Releases payments', m.is_contractor && 'Contractor'].filter(Boolean).join(', ')}</td><td><span className="mobile-label">Approver </span>{state.members.find((x: D) => x.email === m.approver_email)?.name ?? '—'}</td><td className="row-actions"><button className="button small" onClick={() => setMember(m)}>Change</button><button className="button small" onClick={async () => { try { await call('settings/members/invite', { email: m.email }); setNotice(`Invitation sent to ${m.email}.`); } catch (e) { setNotice((e as Error).message); } }}>Invite</button>{!m.active && m.email.includes('@') && <button className="button small" onClick={async () => { if (!window.confirm(`Erase ${m.name}'s personal data? Their name, email, sign-in, agent keys, delegations and own comments are removed for good; their claims, receipts and history stay under an anonymous label.`)) return; try { const r = await call('settings/members/erase', { email: m.email }); await saved(`${m.name} is now ${r.label}; the erasure receipt is under Retention.`); } catch (e) { setNotice((e as Error).message); } }}>Erase</button>}</td></tr>)}
      </tbody></table> : <Empty title="Nobody added yet">Add yourself and your team. Each employee needs an approving manager.</Empty>}
      <div className="sub-form"><h3>{member ? `Change ${member.name}` : 'Add a person'}</h3><Form key={member?.email ?? 'new'} label={member ? 'Save person' : 'Add person'} onSubmit={async v => { await call('settings/members', v); setMember(null); await saved('Person saved.'); }} secondary={member ? <button type="button" className="button" onClick={() => setMember(null)}>Cancel</button> : undefined}>
        <Field label="Name" name="name" defaultValue={member?.name} />
        <Field label="Email" name="email" type="email" defaultValue={member?.email} readOnly={!!member} />
        <fieldset className="roles field-wide"><legend>Roles</legend>
          <Field label="Employee" name="employee" type="checkbox" defaultValue={member ? member.is_employee : true} />
          <Field label="Manager" name="manager" type="checkbox" defaultValue={member?.is_manager} />
          <Field label="Finance" name="finance" type="checkbox" defaultValue={member?.is_finance} />
          <Field label="Auditor (reads everything, changes nothing)" name="auditor" type="checkbox" defaultValue={member?.is_auditor} />
          <Field label="Admin (people, settings and workflows; not payments)" name="admin" type="checkbox" defaultValue={member?.is_admin} />
          <Field label="Card admin (assigns and freezes cards)" name="cardAdmin" type="checkbox" defaultValue={member?.is_card_admin} />
          <Field label="Bookkeeper (external; exports and ledger fixes)" name="bookkeeper" type="checkbox" defaultValue={member?.is_bookkeeper} />
          <Field label="May release payments (finance only)" name="release" type="checkbox" defaultValue={member?.may_release} />
          <Field label="Contractor (claims as a non-employee; flagged for 1099 review)" name="contractor" type="checkbox" defaultValue={member?.is_contractor} />
        </fieldset>
        <Field label="Department" name="department" required={false} defaultValue={member?.department_id ?? ''} options={state.departments.filter((d: D) => d.active).map((d: D) => ({ value: d.id, label: d.name }))} />
        <Field label="Successor if deactivated" name="successor" required={false} options={state.members.filter((m: D) => m.active && m.email !== member?.email).map((m: D) => ({ value: m.email, label: m.name }))} hint="Takes over open approvals, their reports and unsubmitted card charges when you untick Active" />
        <Field label="Approving manager" name="approver" required={false} defaultValue={member?.approver_email ?? ''} options={managers.filter((m: D) => m.email !== member?.email).map((m: D) => ({ value: m.email, label: m.name }))} />
        <Field label="Active" name="active" type="checkbox" defaultValue={member ? member.active === 1 : true} />
      </Form></div>
    </Section>}
    </div>
  </Work>;
}
