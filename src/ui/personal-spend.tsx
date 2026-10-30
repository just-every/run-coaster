import { call, money, type D } from './api';
import { Details, Field, Form } from './parts';

export function PersonalSpend({ claim, item, actor, done }: { claim: D; item: D; actor: D; done: () => Promise<void> }) {
  if (!item.card_charge_id || actor.delegate || actor.email !== claim.employee_email) return null;
  if (item.personal_spend) return <p role="status">Personal spend · You owe {money(item.personal_spend.outstanding_minor, item.personal_spend.currency)} · Unpaid</p>;
  if (claim.status !== 'draft' || claim.revision !== 0) return null;
  return <Details label="Mark personal spend">
    <p>This records that you owe the company {money(item.amount_minor, claim.currency)}. The charge stays non-reimbursable. Undoing the statement import keeps this unpaid obligation. Repayment is not available here.</p>
    <Form label="Confirm personal spend" onSubmit={async value => {
      await call(`claims/${claim.id}/personal-spend`, { version: claim.version, item: item.id, charge: item.card_charge_id, confirm: value.confirm });
      await done();
    }}>
      <Field name="confirm" type="checkbox" label="I owe the company this full posted amount" />
    </Form>
  </Details>;
}
