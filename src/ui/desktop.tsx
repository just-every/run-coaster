import { useCallback, useEffect, useState } from 'react';
import { apiHref, call, type D } from './api';
import { Field, Form, Section } from './parts';

export function Desktop({ state }: { state:D }) {
  const [status,setStatus]=useState<D>(),[error,setError]=useState(''),[password,setPassword]=useState(''),[notice,setNotice]=useState('');
  const reload=useCallback(async()=>{setStatus(await call(['accounting','desktop'].join('/')));},[]);
  useEffect(()=>{reload().catch(e=>setError(e.message));},[reload]);
  const base=['accounting','desktop'].join('/');
  const labels:D={AccountQuery:'Accounts',ClassQuery:'Classes',CustomerQuery:'Customers',VendorQuery:'Vendors',EmployeeQuery:'Employees',BillAdd:'Bill',CreditCardChargeAdd:'Card charge',BillPaymentCheckAdd:'Recorded bill payment',JournalEntryAdd:'Journal entry'};
  const roles=state.actor.roles,connect=roles.owner||roles.admin||roles.finance,sync=roles.owner||roles.finance||roles.bookkeeper;
  return <Section title="QuickBooks Desktop" label="QuickBooks Desktop">
    <p>Install the connector file in QuickBooks Web Connector on the computer that opens your company file. Its hourly schedule reads accounting choices and posts approved expenses and recorded payments. Map accounts before the first posting.</p>
    {error&&<p role="alert">{error}</p>}<p role="status">{notice}</p>
    {status&&!status.connected&&connect&&<Form label="Create Desktop connector" onSubmit={async v=>{const result=await call(base+'/connect',v);setPassword(result.password);await reload();setNotice('Connector created. Save its password before leaving this page.');}}>
      <Field label="QuickBooks company file path" name="company" hint="The full path on the QuickBooks computer, ending in .QBW"/>
      <Field label="I authorize hourly accounting reads and posting to this company" name="consent" type="checkbox"/>
    </Form>}
    {status?.connected&&<>
      <p>Connected company: <span style={{overflowWrap:'anywhere'}}>{status.company}</span></p>
      {connect&&<p><a className="button" href={apiHref(base+'/configuration')} download>Download connector file</a></p>}
      {password&&<p>One-time connector password: <input aria-label="Connector password" readOnly value={password} onFocus={e=>e.target.select()}/></p>}
      {sync&&<Form label="Queue Desktop sync" onSubmit={async()=>{await call(base+'/sync',{});await reload();setNotice('Sync queued. Run Web Connector to exchange requests.');}}>{null}</Form>}
      <p>{status.catalog.length} accounting choices pulled. {status.requests.filter((r:D)=>r.status==='succeeded').length} requests completed.</p>
      {status.catalog.length>0&&<details><summary>Accounting catalog</summary><ul className="ruled-list">{status.catalog.map((c:D)=><li key={c.kind+c.list_id}>{c.kind}: {c.name}{c.active?'':' · inactive'}</li>)}</ul></details>}
      {sync&&status.catalog.length>0&&<Form label="Save Desktop mapping" onSubmit={async v=>{const selected=status.catalog.find((c:D)=>c.kind+'|'+c.list_id===v.entry);await call(base+'/mappings',{name:v.name,kind:selected.kind,listId:selected.list_id});await reload();setNotice('Mapping saved. Retry the affected failed request.');}}>
        <Field label="Coaster account or person" name="name" options={status.mappingOptions}/>
        <Field label="QuickBooks entry" name="entry" options={status.catalog.filter((c:D)=>c.active).map((c:D)=>({value:c.kind+'|'+c.list_id,label:c.kind+' · '+c.name}))}/>
      </Form>}
      {status.mappings.length>0&&<ul className="ruled-list" aria-label="Desktop mappings">{status.mappings.map((m:D)=><li key={m.name} style={{overflowWrap:'anywhere'}}>{status.mappingOptions.find((o:D)=>o.value===m.name)?.label ?? 'Retained mapping'}: {status.catalog.find((c:D)=>c.kind===m.kind&&c.list_id===m.list_id)?.name}</li>)}</ul>}
      <ul className="ruled-list" aria-label="Desktop sync requests">{status.requests.map((r:D)=><li key={r.id} style={{overflowWrap:'anywhere'}}><span>{labels[r.kind]??r.kind} · {r.status}{r.message&&' · '+r.message}</span>{r.status==='failed'&&sync&&<button className="button small" onClick={async()=>{try{await call(base+'/retry/'+r.id,{});await reload();}catch(e){setError((e as Error).message);}}}>Retry failed request</button>}</li>)}</ul>
      {connect&&<Form label="Disconnect Desktop" onSubmit={async v=>{if(!v.consent)throw Error('Confirm disconnect first.');await call(base+'/disconnect',{});setPassword('');await reload();setNotice('Desktop disconnected. Scheduled access stopped; accounting history remains.');}}><Field label="Stop this connector and keep its posting history" name="consent" type="checkbox"/></Form>}
    </>}
  </Section>;
}
