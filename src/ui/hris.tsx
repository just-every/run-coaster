import { useEffect, useState } from 'react';
import { call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';
const root = ['hris','gusto'].join('/');

export function HrisSettings({ reload }: { reload: () => Promise<unknown> }) {
  const [status,setStatus]=useState<D>(),[review,setReview]=useState<D>(),[notice,setNotice]=useState('');
  const load=async()=>setStatus(await call(root));
  useEffect(()=>{load().catch(e=>setNotice(e.message));},[]);
  return <Section title="Gusto roster" label="Gusto HRIS roster">
    <p className="muted">Review one sandbox employee at a time. New hires receive only employee access. Existing roles stay as assigned in People. Card freezing requires an issuing connection and is unavailable here.</p>
    <p role="status">{notice}</p>
    {status && !status.connection && <Form label="Connect HRIS sandbox" onSubmit={async(v,form)=>{
      await call(root+'/connect',{company:v.company,token:v.token,consent:!!v.consent});form.reset();await load();setNotice('HRIS connected. Review the roster before applying changes.');
    }}>
      <Field label="HRIS company UUID" name="company" autoComplete="off" />
      <Field label="HRIS access token" name="token" type="password" autoComplete="off" />
      <Field label="I authorize reading this sandbox company and explicitly reviewing native roster changes" name="consent" type="checkbox" />
    </Form>}
    {status?.connection && <>
      <p>Connected to {status.connection.company_name}.</p>
      <Form label="Review HRIS roster" onSubmit={async()=>{setReview(await call(root+'/preview'));setNotice('Review the identity, manager and status of each person before syncing.');}}>{null}</Form>
      {review && (review.employees.length ? review.employees.map((person:D)=><div className="sub-form" key={person.employee}>
        <h3>{person.name} · {person.terminated?'Terminated':'Active'}</h3>
        <p className="muted">Manager: {review.employees.find((p:D)=>p.employee===person.manager)?.name ?? (person.manager?'Unmapped manager':'None')}.</p>
        <Form label={'Sync '+person.name} onSubmit={async v=>{
          await call(root+'/sync',{employee:person.employee,email:v.email,successor:v.successor,fingerprint:review.fingerprint,consent:!!v.consent});
          await reload();setReview(await call(root+'/preview'));setNotice('Roster change saved. Card freezing is unavailable.');
        }}>
          <Field label={'Coaster email for '+person.name} name="email" type="email" defaultValue={review.mappings.find((m:D)=>m.employee_uuid===person.employee)?.email ?? person.email ?? ''} />
          {person.terminated && <Field label={'Successor for '+person.name} name="successor" required={false} hint="Leave empty to use the approving manager." options={[...review.members.filter((m:D)=>m.active).map((m:D)=>({value:m.email,label:m.name}))]} />}
          <Field label={'I confirmed the identity and change for '+person.name} name="consent" type="checkbox" />
        </Form>
      </div>) : <Empty title="No roster employees">No native person is changed by an empty provider roster.</Empty>)}
      <div className="sub-form"><Form label="Disconnect HRIS" onSubmit={async v=>{
        if(!v.consent)throw new Error('Confirm disconnection first.');
        await call(root+'/disconnect',{});setReview(undefined);await load();setNotice('HRIS disconnected. Native people and numbered history remain.');
      }}><Field label="Disconnect this HRIS company" name="consent" type="checkbox" /></Form></div>
    </>}
  </Section>;
}
