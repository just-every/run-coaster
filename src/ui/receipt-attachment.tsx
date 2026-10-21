import { useEffect, useState, type ChangeEvent } from 'react';
import { call, claimNumber, money, type D } from './api';
import { Details, Field, Form } from './parts';

/** Choose an existing editable expense before sharing a private inbox original. */
export function ReceiptAttachment({ receipt, claims, employee, reload }: { receipt: D; claims: D[]; employee: string; reload: () => Promise<void> }) {
  const [claimId, setClaimId] = useState(''), [detail, setDetail] = useState<D | null>(null), [error, setError] = useState('');
  const attachment = receipt.attachment;
  const eligible = claims.filter(claim => claim.employee_email === employee && ['draft', 'returned'].includes(claim.status));
  useEffect(() => {
    let current = true;
    setDetail(null); setError('');
    if (claimId) call(`claims/${claimId}`).then(value => {
      if (!current) return;
      if (value.claim.employee_email !== employee || !['draft', 'returned'].includes(value.claim.status)) {
        setError('This claim is no longer editable. Choose another draft or returned claim.');
      } else setDetail(value);
    }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [claimId, employee]);
  if (attachment) return <>
    <p>Attached to <a href={`#/claims/${attachment.claimId}`}>{attachment.claimTitle}</a> · {attachment.merchant}</p>
    {attachment.editable && <Details label={`Detach ${receipt.name}`}>
      <Form label="Detach receipt" onSubmit={async () => {
        await call(`receipt-inbox/${receipt.id}/detach`, { expectedSequence: receipt.lifecycleSequence, claimId: attachment.claimId, itemId: attachment.itemId, version: attachment.version });
        await reload();
      }}><p>The expense will have no receipt. This original stays in your private inbox; earlier submitted revisions keep their receipt.</p></Form>
    </Details>}
  </>;
  const expenses: D[] = detail ? detail.items.filter((item: D) => item.kind === 'receipt' && !item.receipt_id) : [];
  return <Details label={`Attach ${receipt.name} to an expense`}>
    {eligible.length ? <>
      <Field label="Claim" name="claimId" value={claimId} onChange={(e: ChangeEvent<HTMLSelectElement>) => { setDetail(null); setError(''); setClaimId(e.target.value); }} options={eligible.map(claim => ({ value: claim.id, label: `${claimNumber(claim.number)} · ${claim.title}` }))} />
      {error && <p className="form-error" role="alert">{error}</p>}
      {claimId && !detail && !error && <p role="status">Loading expenses…</p>}
      {detail && (expenses.length ? <Form key={claimId} label="Attach receipt" onSubmit={async values => {
        await call(`receipt-inbox/${receipt.id}/attach`, { expectedSequence: receipt.lifecycleSequence, claimId, itemId: values.itemId, version: detail.claim.version });
        await reload();
      }}>
        <Field label="Expense" name="itemId" options={expenses.map(item => ({ value: item.id, label: `${item.merchant} · ${item.spent_on} · ${money(item.original_minor ?? item.amount_minor, item.original_currency ?? detail.claim.currency)}` }))} />
        <p>Approvers and finance can see this receipt once the expense is submitted.</p>
      </Form> : <p>This claim has no purchase expenses without a receipt. Add an expense to the claim first.</p>)}
    </> : <p>Create a draft claim and add a purchase expense without a receipt first.</p>}
  </Details>;
}
