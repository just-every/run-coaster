import { Hono, type Context } from 'hono';
import { runtimeBindings, type Bindings } from '../../auth.server';
import { person } from '../session';
import { createClaim, saveItem, removeItem, renameClaim, uploadReceipt } from '../claims';
import { receiptFile } from '../views';
import { report } from '../reports';
import { spend } from '../spend';
import { requireThat, type Actor, type Data } from '../types';
import { authenticate, createKey, nativeOwner, revokeKey } from './credentials';
import { authorize, exchange, registerClient, revokeClient } from './oauth';
import * as resources from './resources';
import { finalReport } from './final-report';
import { createSubscription, revokeSubscription, subscriptions } from './webhooks';

type C=Context<{Bindings:Bindings}>;
export const publicApi=new Hono<{Bindings:Bindings}>();
const db=(c:C)=>runtimeBindings(c.env).DB;
const id=(c:C)=>c.req.param('id')!;
async function rawBody(c:C):Promise<string> {
  const reader=c.req.raw.body?.getReader();if(!reader) return '';
  const decoder=new TextDecoder(),parts:string[]=[];let size=0;
  try {
    for(;;) { const chunk=await reader.read();if(chunk.done) break;size+=chunk.value.byteLength;requireThat(size<=3000000,'Request too large',413);parts.push(decoder.decode(chunk.value,{stream:true})); }
    parts.push(decoder.decode());return parts.join('');
  } finally { await reader.cancel(); }
}
async function body(c:C):Promise<Data> {
  const data=JSON.parse(await rawBody(c));requireThat(data&&typeof data==='object'&&!Array.isArray(data),'JSON object required');return data;
}
const native=(handler:(a:Actor,c:C)=>Promise<unknown>)=>async(c:C)=>{
  const a=await person(c.req.raw,c.env);nativeOwner(a);
  requireThat(!c.req.header('authorization')&&!c.req.header('x-coaster-acting-for')&&!c.req.query('actingFor'),'Use the owner native session without delegation',403);
  return c.json(await handler(a,c));
};
const scoped=(scope:string,handler:(a:Actor,c:C)=>Promise<unknown>)=>async(c:C)=>{
  const a=await authenticate(c.req.raw,runtimeBindings(c.env),scope),result=await handler(a,c);
  return result instanceof Response?result:c.json(result);
};
publicApi.post('/keys',native((a,c)=>body(c).then(b=>createKey(db(c),a,b))));
publicApi.get('/keys',native(async(a,c)=>({data:(await db(c).prepare('SELECT id,label,scopes,expires_at,created_at,revoked_at,oauth_client FROM c_public_keys WHERE member_email=? ORDER BY created_at DESC').bind(a.email).all()).results.map((k:Data)=>({...k,scopes:JSON.parse(k.scopes)}))})));
publicApi.post('/keys/:id/revoke',native((a,c)=>revokeKey(db(c),a,id(c))));
publicApi.post('/oauth/clients',native((a,c)=>body(c).then(b=>registerClient(db(c),a,b))));
publicApi.post('/oauth/clients/:id/revoke',native((a,c)=>revokeClient(db(c),a,id(c))));
publicApi.post('/oauth/authorize',native((a,c)=>body(c).then(b=>authorize(db(c),a,b))));
publicApi.post('/oauth/token',async c=>{
  requireThat(new URL(c.req.url).origin===runtimeBindings(c.env).AUTH_ORIGIN,'Invalid host',403);
  const b=c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')?Object.fromEntries(new URLSearchParams(await rawBody(c))):await body(c);
  return c.json(await exchange(db(c),b));
});
publicApi.get('/webhooks',native((a,c)=>subscriptions(db(c),a)));
publicApi.post('/webhooks',native((a,c)=>body(c).then(b=>createSubscription(runtimeBindings(c.env),a,b))));
publicApi.post('/webhooks/:id/revoke',native((a,c)=>revokeSubscription(db(c),a,id(c))));

publicApi.get('/v1/claims',scoped('claims:read',async(a,c)=>resources.page(await resources.visibleClaims(db(c),a),c.req.query())));
publicApi.get('/v1/claims/:id',scoped('claims:read',(a,c)=>resources.oneClaim(db(c),a,id(c))));
publicApi.get('/v1/claims/:id/final-report',scoped('claim-reports:read',(a,c)=>finalReport(db(c),a,id(c),c.req.query('revision'))));
publicApi.post('/v1/claims',scoped('claims:write',async(a,c)=>resources.claimSummary(await createClaim(db(c),a,await body(c)))));
publicApi.post('/v1/claims/:id/title',scoped('claims:write',async(a,c)=>resources.claimSummary(await renameClaim(db(c),await resources.draftActor(db(c),a,id(c)),id(c),await body(c)))));
publicApi.get('/v1/expenses',scoped('expenses:read',async(a,c)=>{
  const claim=c.req.query('claimId');requireThat(claim,'claimId required');return resources.page(await resources.expenses(db(c),a,claim),c.req.query());
}));
publicApi.get('/v1/expenses/:id',scoped('expenses:read',(a,c)=>resources.oneExpense(db(c),a,id(c))));
publicApi.post('/v1/expenses',scoped('expenses:write',async(a,c)=>{
  const b=await body(c);requireThat(typeof b.claimId==='string'&&!b.item,'Choose an existing draft claim; use the expense update route to replace an item');
  const aDraft=await resources.draftActor(db(c),a,b.claimId);
  const claim=await saveItem(db(c),aDraft,b.claimId,b);return {claim:resources.claimSummary(claim)};
}));
publicApi.post('/v1/expenses/:id',scoped('expenses:write',async(a,c)=>{
  const b=await body(c),item=await resources.oneExpense(db(c),a,id(c)),aDraft=await resources.draftActor(db(c),a,item.claim_id);
  return {claim:resources.claimSummary(await saveItem(db(c),aDraft,item.claim_id,{...b,item:id(c)}))};
}));
publicApi.post('/v1/expenses/:id/remove',scoped('expenses:write',async(a,c)=>{
  const b=await body(c),item=await resources.oneExpense(db(c),a,id(c)),aDraft=await resources.draftActor(db(c),a,item.claim_id);
  return {claim:resources.claimSummary(await removeItem(db(c),aDraft,item.claim_id,{...b,item:id(c)}))};
}));
publicApi.get('/v1/receipts',scoped('receipts:read',async(a,c)=>{
  const claim=c.req.query('claimId');requireThat(claim,'claimId required');return resources.page(await resources.receipts(db(c),a,claim),c.req.query());
}));
publicApi.get('/v1/receipts/:id',scoped('receipts:read',(a,c)=>receiptFile(db(c),a,id(c),false,runtimeBindings(c.env).COASTER_RECEIPTS)));
publicApi.post('/v1/claims/:id/receipts',scoped('receipts:write',async(a,c)=>{
  const result=await uploadReceipt(db(c),await resources.draftActor(db(c),a,id(c)),id(c),await body(c));return {...result,claim:resources.claimSummary(result.claim)};
}));
for(const [name,scope,read] of [
  ['cards','cards:read',resources.cards],['batches','batches:read',resources.batches],['payments','payments:read',resources.payments],['people','people:read',resources.people],
] as const) publicApi.get('/v1/'+name,scoped(scope,async(a,c)=>resources.page(await read(db(c),a),c.req.query())));
publicApi.get('/v1/reports/:id',scoped('reports:read',(a,c)=>id(c)==='spend'?spend(db(c),a,c.req.query()):report(db(c),a,id(c),c.req.query())));
// Closed route vocabulary: credentials can never reach security, submission, decisions, release or payment writes.
publicApi.all('/v1/*',async c=>{await authenticate(c.req.raw,runtimeBindings(c.env),'claims:write');return c.json({error:'Public API credentials prepare drafts and read scoped resources only'},403);});
