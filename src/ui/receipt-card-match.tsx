import { useEffect, useState } from 'react';
import { call, money, type D } from './api';
import { Details, Field, Form } from './parts';
import { MATCH_NOTICE } from '../coaster/receipts/match-notice';

/** Extend the existing inbox with its ordinary disclosure and form controls. Consent is never preselected. */
export function ReceiptCardMatch({receipt,currency,reload}:{receipt:D;currency:string;reload:()=>Promise<void>}) {
  const [question,setQuestion]=useState<D|null>(null),[error,setError]=useState('');
  const choice=receipt.matchChoice,details=choice?.details;
  useEffect(()=>{
    let live=true;
    if(choice?.enabled&&!receipt.attachment) call(`receipt-inbox/${receipt.id}/card-match-question`).then(q=>{if(live)setQuestion(q);}).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[receipt.id,receipt.lifecycleSequence,receipt.attachment,choice?.enabled]);
  if(receipt.attachment||receipt.cashDraft) return null;
  return <Details label={`Card matching for ${receipt.name}`}>
    <p>{choice?.enabled?(choice.automationEnabled?'Waiting for a unique posted card charge. Matching runs hourly; this original stays outside the cash-draft window.':'Automatic matching is turned off for this business. Your choice is saved; you can still attach by hand. This original stays outside the cash-draft window.'):'Choose matching for this original by entering its details. You can enter these details by hand or use reviewed receipt-reading values.'}</p>
    {error&&<p role="alert" className="form-error">{error}</p>}
    {question?.ambiguous&&<section aria-label={`Match question for ${receipt.name}`}><p>Which card charge belongs with this receipt? Coaster will not guess.</p>
      {question.candidates.map((c:D)=><Form key={c.chargeId} label="This one" onSubmit={async()=>{await call(`receipt-inbox/${receipt.id}/attach`,{expectedSequence:receipt.lifecycleSequence,claimId:c.claimId,itemId:c.itemId,version:c.version});await reload();}}><p>{c.merchant} · {c.transactionDate??c.postedDate} · posted {c.postedDate} · {money(c.amountMinor,c.currency)} · card ending {c.last4}</p></Form>)}
      <Form label="None of these" onSubmit={async()=>{await call(`receipt-inbox/${receipt.id}/card-match-reject`,{expectedSequence:receipt.lifecycleSequence,chargeIds:question.candidates.map((c:D)=>c.chargeId)});await reload();}}><p>These pairs will never be proposed again.</p></Form>
    </section>}
    <Form key={receipt.lifecycleSequence} label="Match to my card charge" onSubmit={async values=>{
      await call(`receipt-inbox/${receipt.id}/card-match`,{expectedSequence:receipt.lifecycleSequence,enabled:true,merchant:values.merchant,date:values.date,total:values.total,currency:values.currency,last4:values.last4,notice:values.noticeAccepted?MATCH_NOTICE:undefined});await reload();
    }}>
      <Field label="Receipt merchant" name="merchant" maxLength={200} defaultValue={details?.merchant}/>
      <Field label="Purchase date" name="date" type="date" defaultValue={details?.date}/>
      <Field label="Receipt total" name="total" inputMode="decimal" defaultValue={details?(details.totalMinor/100).toFixed(2):undefined}/>
      <Field label="Receipt currency" name="currency" maxLength={3} defaultValue={details?.currency??currency}/>
      <Field label="Card last four (optional)" name="last4" required={false} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={details?.last4??''}/>
      <p>{MATCH_NOTICE}</p><Field type="checkbox" name="noticeAccepted" label="I understand when this receipt will be shared"/>
    </Form>
    {choice?.enabled&&<Form label="Withdraw matching" onSubmit={async()=>{await call(`receipt-inbox/${receipt.id}/card-match`,{expectedSequence:receipt.lifecycleSequence,enabled:false});await reload();}}><p>This stops future automatic attachment of this original.</p></Form>}
  </Details>;
}
