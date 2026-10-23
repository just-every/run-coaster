import { useEffect, useState } from 'react';
import { apiHref, call, money, moment, type D } from './api';
import { Details, Empty, Field, Form, Section } from './parts';

/** Same finance surface and components as the exception queue; original evidence stays linked. */
export function Investigations({state}:{state:D}){
 const [data,setData]=useState<D>(),[error,setError]=useState('');
 useEffect(()=>{call('investigations').then(setData).catch(e=>setError(e.message));},[]);
 return <Section title="Investigation packs" label="Investigation packs">
  <p>Related receipt and spend observations, for finance to review. No employee is contacted, no payment is held, and a signal is never a conclusion of wrongdoing.</p>
  {error&&<p role="alert">{error}</p>}
  {!data?<p>Opening submitted evidence…</p>:data.packs.length===0?<Empty title="No investigation packs">Submitted POLICY-002 observations appear here with their related records.</Empty>:data.packs.map((p:D)=><Details key={p.id} label={`${p.records.length} related expenses · ${p.employees.length} people · ${p.from} to ${p.through}`}>
   <a className="button small" href={apiHref(`investigations/${p.id}/download`)}>Download evidence pack</a>
   <ul className="ruled-list">{p.records.map((r:D)=><li key={r.item} style={{overflowWrap:'anywhere'}}>
    <p><a href={`#/claims/${r.claim}`}>{r.number} · revision {r.revision}</a> · {state.names[r.employee]??r.employee}</p>
    <strong>{r.merchant} · {money(r.amountMinor,r.currency)}</strong><p>{r.date}{r.cardCharge?' · company card charge':''}</p>
    {r.receipt&&<p><a href={apiHref(`receipts/${r.receipt.id}?inline=1`)} target="_blank" rel="noreferrer">View original receipt</a> · SHA-256 {r.receipt.sha256}</p>}
    {r.signals.map((s:D,i:number)=><p key={i}><strong>Possible, needs review:</strong> {s.reason}</p>)}
   </li>)}</ul>
   {p.outcome?<p role="status">{p.outcome.outcome==='explained'?'Explained':'Needs follow-up'} · {p.outcome.note} · {state.names[p.outcome.by]??p.outcome.by} · {moment(p.outcome.at)}</p>:<Form label="Record investigation outcome" onSubmit={async v=>setData(await call(`investigations/${p.id}/outcome`,v))}>
    <Field label="Finance outcome" name="outcome" options={[{value:'explained',label:'Explained'},{value:'needs-follow-up',label:'Needs follow-up'}]}/><Field label="Finance outcome note" name="note" type="textarea"/>
    <p className="field-wide">Recording an outcome sends no message and changes no expense or payment. Any follow-up is a separate human decision.</p>
   </Form>}
  </Details>)}
 </Section>;
}
