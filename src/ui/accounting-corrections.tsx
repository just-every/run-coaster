import { call, moment, type D } from './api';
import { Details, Field, Form } from './parts';

/** Account overrides stay beside the submitted evidence, with the existing claim form controls. */
export function AccountingCorrections({ detail, done }: { detail: D; done: () => Promise<void> }) {
  const { claim, accountCoding } = detail, revision = detail.revisions.find((r: D) => r.revision === claim.revision);
  if (!revision) return null;
  const history: D[] = accountCoding.corrections, choices = revision.snapshot.items
    .filter((i: D) => i.kind === 'receipt' && !i.card_charge_id)
    .flatMap((i: D) => i.allocations.map((a: D) => ({ value: `${i.id}:${a.position}`, label: `${i.merchant} · ${a.category_name}${a.cost_centre ? ` · ${a.cost_centre}` : ''}`, item: i.id, allocation: a.position, original: a.account_code })));
  if (!choices.length) return null;
  return <section className="panel-block" aria-label="Account coding">
    <h3>Account coding</h3>
    <p className="muted">Native exports use the effective account code. The submitted evidence and reimbursement amounts stay as submitted.</p>
    <ul className="ruled-list">{choices.map((c: D) => {
      const selected = history.filter(h => h.revision === claim.revision && h.item_id === c.item && h.allocation_position === c.allocation).at(-1);
      return <li key={c.value}><strong>{c.label}</strong><p>Submitted account: {c.original || 'No account code'} · Effective account: {(selected?.after_account ?? c.original) || 'No account code'}{selected ? ` · correction ${selected.sequence}` : ''}</p></li>;
    })}</ul>
    {accountCoding.mayCorrect && <Details label="Correct an account code">
      <Form label="Save account correction" onSubmit={async v => {
        const choice = choices.find((c: D) => c.value === v.allocation);
        await call(`claims/${claim.id}/account-corrections`, { version: claim.version, revision: claim.revision, sequence: accountCoding.sequence, item: choice.item, allocation: choice.allocation, accountCode: v.accountCode, reason: v.reason });
        await done();
      }}>
        <Field label="Submitted allocation" name="allocation" options={choices} />
        <Field label="Effective account code" name="accountCode" />
        <Field label="Correction reason" name="reason" />
      </Form>
    </Details>}
    {history.length > 0 && <Details label="Account correction history"><ol className="timeline">{history.map(h => <li key={h.id}><span>Correction {h.sequence} · revision {h.revision}: {h.before_account || 'No account code'} → {h.after_account}. {h.reason}</span><time dateTime={h.at}>{moment(h.at)}</time></li>)}</ol></Details>}
  </section>;
}
