import { call, moment, type D } from './api';
import { Details, Field, Form } from './parts';

/** Original submitted coding remains alongside the effective export selection. */
export function AccountingCorrections({claim, item, rows, actor, onDone}: {claim:D;item:D;rows:D[];actor:D;onDone:()=>Promise<void>}) {
  if (!claim.revision) return null;
  const allowed=actor.roles.owner||actor.roles.finance||actor.roles.bookkeeper||actor.roles.manager&&claim.status==='submitted'&&(claim.assigned_emails?.length?claim.assigned_emails.includes(actor.email):claim.approver_email===actor.email);
  return <div aria-label={`Account coding for ${item.merchant}`}>
    {item.allocations.map((part:D,allocation:number)=>{
      const history=rows.filter(c=>c.revision===claim.revision&&c.item_id===item.id&&c.allocation===allocation),latest=history.at(-1);
      return <div key={allocation} className="split-line">
        <span>Account {latest?.after_code??part.account_code} · submitted {part.account_code||'none'}{item.allocations.length>1?` · allocation ${allocation+1}`:''}</span>
        {allowed&&['submitted','approved'].includes(claim.status)&&!claim.batch_id&&<Details label={`Correct account${item.allocations.length>1?` ${allocation+1}`:''}`}>
          <p>Only the account code changes. Submitted evidence and amounts stay in place.</p>
          <Form label="Save account correction" onSubmit={async v=>{await call(`claims/${claim.id}/coding-corrections`,{version:claim.version,revision:claim.revision,item:item.id,allocation,sequence:latest?.sequence??0,accountCode:v.accountCode,reason:v.reason});await onDone();}}>
            <Field label="New account code" name="accountCode" maxLength={100}/>
            <Field label="Correction reason" name="reason" type="textarea" maxLength={1000}/>
          </Form>
        </Details>}
        {history.length>0&&<Details label="Account correction history"><ol style={{overflowWrap:'anywhere'}}>{history.map(c=><li key={c.id}>#{c.sequence}: {c.before_code||'none'} → {c.after_code} · {c.reason} · {c.actor_email}{c.on_behalf_of?` for ${c.on_behalf_of}`:''} · {moment(c.at)}</li>)}</ol></Details>}
      </div>;
    })}
  </div>;
}
