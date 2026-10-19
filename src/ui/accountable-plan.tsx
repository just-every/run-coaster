import { useCallback, useEffect, useState } from 'react';
import { call, day, money, plural, type D } from './api';
import { Empty, Field, Form, Section } from './parts';
import { settlement } from './advances';

/** Finance's accountable-plan list (CLAIM-008): expenses filed more than 60 days after the spend, and the expenses
 * finance treats as non-accountable, which the reimbursement files label as taxable pay. */
export function AccountablePlan({ state }: { state: D }) {
  const [plan, setPlan] = useState<D>(), [error, setError] = useState('');
  const load = useCallback(async () => { try { setPlan(await call('accountable-plan')); setError(''); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { load(); }, [load]);
  const finance = state.actor.roles.finance, currency = state.business?.currency ?? 'USD';
  if (!plan) return <Section title="Accountable plan" label="Accountable plan"><p className="muted">{error || 'Opening the accountable plan…'}</p></Section>;
  const mark = (x: D, nonAccountable: boolean) => async (v: D) => { setPlan(await call(`claims/${x.claimId}/items/${x.item}/accountable-plan`, { nonAccountable, reason: v.reason })); };
  return <Section title={`Accountable plan · ${plural(plan.lapsed.length, 'late expense')}`} label="Accountable plan">
    <p className="muted">An accountable plan expects each expense within {plan.substantiationDays} days of the spend. Expenses you treat as non-accountable stay reimbursed, and the reimbursement files mark them as taxable pay for payroll; contractors’ reimbursements are flagged for 1099 review. Coaster supplies the flags; taxability stays with your accountant.</p>
    {plan.lapsed.length ? <ul className="ruled-list">{plan.lapsed.map((x: D) => <li key={x.item} className="job">
      <span><strong>{x.claim}</strong> · {state.names[x.employee] ?? x.employee} · {x.merchant} · {money(x.amountMinor, currency)} · spent {day(x.spentOn)}, filed {day(x.filedOn)} · {x.daysAfterSpend} days{x.nonAccountable ? ` · non-accountable: ${x.nonAccountable.reason}` : ''}</span>
      {finance && <Form label={x.nonAccountable ? 'Treat as accountable' : 'Mark non-accountable'} className="record-form-inline" onSubmit={mark(x, !x.nonAccountable)}>
        <Field label="Reason" name="reason" placeholder="Filed after the 60-day window" />
      </Form>}
    </li>)}</ul> : <Empty title="No late expenses">Every expense was filed within {plan.substantiationDays} days of the spend.</Empty>}
    <h3>Advance excess not returned within {plan.returnDays} days</h3>
    {plan.excessOverdue.length ? <ul className="ruled-list">{plan.excessOverdue.map((a: D) => <li key={a.id} className="job"><span><strong>{a.advance}</strong> · {state.names[a.employee_email] ?? a.employee_email} · {a.purpose} · {money(a.amount_minor, a.currency)} paid {day(a.paid_on)} · {settlement(a)}</span></li>)}</ul> : <Empty title="No overdue advance excess">Every advance’s excess was returned or is not yet due.</Empty>}
  </Section>;
}
