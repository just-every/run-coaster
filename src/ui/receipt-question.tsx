import { useState } from 'react';
import { apiHref, call, type D } from './api';
import { Field, Form } from './parts';
import { ReadingFields } from './receipt-reading-fields';

export function ReceiptQuestion({question:q,receipt,after}:{question:D;receipt:D;after:()=>Promise<void>}){
 const [show,setShow]=useState(false);
 const fields=Object.fromEntries(q.conflicts.map((c:D)=>[c.field,{value:c.read,source:'reader',review:true,regions:c.regions}]));
 return <section aria-label="Receipt question" className="panel-block">
  <h3>One question about this receipt</h3><p>{q.prompt}</p>
  {['image/png','image/jpeg','image/webp'].includes(receipt.mediaType)&&q.conflicts.find((c:D)=>c.field==='total')?.regions[0]&&<ReceiptCrop receipt={receipt} region={q.conflicts.find((c:D)=>c.field==='total').regions[0]}/>}
  <dl>{q.conflicts.map((c:D)=><div key={c.field}><dt>{c.field}</dt><dd>Receipt reading: {c.read??'Not read'}{c.card!==null&&<> · posted card charge: {c.card}</>}
    {c.sources?.map((source:D)=><div key={source.receiptId}>{source.kind==='merchant-email'?'Merchant email body':'Email attachment'}: {source.value} · <a href={apiHref(`receipt-inbox/${source.receiptId}?inline=1`)} target="_blank" rel="noreferrer">View source original</a>
     {show&&<ReadingFields fields={{[c.field]:{value:source.value,review:true,source:'reader',regions:source.regions}}} receipt={{id:source.receiptId,mediaType:source.mediaType}}/>}
    </div>)}
   </dd></div>)}</dl>
  <a href={apiHref(`receipt-inbox/${receipt.id}?inline=1`)} target="_blank" rel="noreferrer">View unchanged original</a>
  <button className="button small" type="button" onClick={()=>setShow(!show)}>{show?'Hide receipt crops':'Show receipt crops'}</button>
  {show&&<ReadingFields fields={fields} receipt={receipt}/>}
  <Form label="Confirm receipt answer" onSubmit={async v=>{const {consent,...values}=v;await call(`receipt-inbox/${receipt.id}/question`,{questionId:q.id,expectedSequence:receipt.lifecycleSequence,expectedReadingSequence:q.readingSequence,version:q.version,values:Object.fromEntries(Object.entries(values).filter(([,v])=>v!=='')),consent});await after();}}>
   {[...q.conflicts,...['total','currency'].filter(key=>!q.conflicts.some((c:D)=>c.field===key)).map(field=>({field,read:q.receiptValues[field]}))].map((c:D)=><Field key={c.field} label={`Confirmed receipt ${c.field}`} name={c.field} defaultValue={c.read} />)}
   {q.conflicts.some((c:D)=>c.field==='total')&&!q.conflicts.some((c:D)=>c.field==='tip')&&<Field label="Confirmed receipt tip" name="tip" required={false} hint="Enter only a tip you can see on the original"/>}
   <p className="field-wide">{q.notice}</p><Field type="checkbox" name="consent" label="I checked these values and authorize saving them on this expense"/>
  </Form>
  <p>Leave this unanswered to keep every expense value unchanged.</p>
 </section>;
}

/** Render the exact source rectangle; the complete immutable original stays linked. */
function ReceiptCrop({receipt,region}:{receipt:D;region:D}){
 const [size,setSize]=useState({width:1,height:1});
 return <figure style={{margin:'12px 0',maxWidth:420}}><div style={{position:'relative',overflow:'hidden',width:'100%',aspectRatio:(region.width*size.width)/(region.height*size.height),border:'1px solid currentColor'}}><img alt="Original receipt total crop" src={apiHref(`receipt-inbox/${receipt.id}?inline=1`)} onLoad={e=>setSize({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight})} style={{position:'absolute',maxWidth:'none',width:`${100/region.width}%`,height:'auto',left:`${-100*region.x/region.width}%`,top:`${-100*region.y/region.height}%`}}/></div><figcaption>Unchanged source region · page {region.page}</figcaption></figure>;
}
