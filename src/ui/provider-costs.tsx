import { useEffect, useState } from 'react';
import { call, type D } from './api';
import { Details, Field, Form, Section } from './parts';
const usd=(micros:number)=>`USD ${(micros/1e6).toFixed(6)}`;
export function ProviderCosts(){
 const [data,setData]=useState<D>(),[error,setError]=useState('');
 useEffect(()=>{call('settings/provider-costs').then(setData).catch(e=>setError(e.message));},[]);
 const s=data?.settings;
 return <Section title="Provider costs in USD" label="Provider costs">
  {error&&<p role="alert">{error}</p>}
  {!data?<p>Opening provider usage…</p>:<>
   <p>Receipt reading and coding use the installation AI provider. Enter its exact model rates before enabling optional processing. These are usage estimates; your provider invoice is authoritative. No rates are guessed.</p>
   <p>Optional receipt reading: {data.readingEnabled?'enabled':'disabled'}.</p>
   <p role="status">{data.month} · {usd(data.usedUsdMicros)} month to date{s?.monthlyCap!==null&&s?.monthlyCap!==undefined?` · cap USD ${Number(s.monthlyCap).toFixed(2)}`:''}{data.paused?' · Optional AI processing paused; manual entry remains available.':''}</p>
   {!s&&<p>No provider pricing configured. Provider tokens remain in private reading history; USD estimates start after you configure rates.</p>}
   <Form key={s?.version??0} label="Save provider costs" onSubmit={async v=>setData(await call('settings/provider-costs',{...v,version:s?.version??0}))}>
    <Field label="Priced AI model" name="model" defaultValue={s?.model} hint="Must exactly match the reader model"/>
    <Field label="USD per million input tokens" name="inputPerMillion" inputMode="decimal" defaultValue={s?.inputPerMillion}/>
    <Field label="USD per million output tokens" name="outputPerMillion" inputMode="decimal" defaultValue={s?.outputPerMillion}/>
    <Field label="USD reservation per page" name="reservePerPage" inputMode="decimal" defaultValue={s?.reservePerPage??'0.10'}/>
    <Field label="Monthly USD cap" name="monthlyCap" inputMode="decimal" required={false} defaultValue={s?.monthlyCap??''} hint="Empty means no cap; zero pauses optional AI processing"/>
    <p>Before each request, the cap includes settled usage and outstanding reservations. A final metered charge may exceed its reservation and pauses later requests. An uncertain attempt keeps its reservation. Core claims and manual coding keep working.</p>
   </Form>
   <Details label="Per-page provider usage"><p>{data.basis}</p><ul className="ruled-list">{data.attempts.map((r:D)=><li key={r.attempt_id} style={{overflowWrap:'anywhere'}}><strong>{r.feature} · {r.pages} {r.pages===1?'page':'pages'} · {usd(r.usd_micros)}</strong><p>{usd(r.usd_micros/r.pages)} per page · {r.model} · pricing v{r.settings_version} · {r.uncertain?'reserved estimate, usage uncertain':`${r.input_tokens} input / ${r.output_tokens} output tokens`} · {r.at}</p><small>Attempt {r.attempt_id}</small></li>)}</ul></Details>
  </>}
 </Section>;
}
