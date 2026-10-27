import { Hono } from 'hono';
import { runtimeBindings, type Bindings } from '../../auth.server';
import { person } from '../session';
import { actingAs } from '../delegates';
import { Fault, requireThat, type Data } from '../types';
import { connectProgramFeed, disconnectProgramFeed, programFeeds } from './configuration';

export const programFeedApi=new Hono<{Bindings:Bindings}>();
programFeedApi.onError((error,c)=>error instanceof Fault?c.json({error:error.message},error.status as 400):error instanceof SyntaxError?c.json({error:'The request body must be JSON'},400):c.json({error:'The program feed request could not be completed'},500));
async function object(request:Request):Promise<Data>{const body=await request.json();requireThat(body&&typeof body==='object'&&!Array.isArray(body),'The request body must be a JSON object');return body as Data;}
programFeedApi.use('*',async(c,next)=>{await next();c.header('cache-control','no-store');c.header('referrer-policy','no-referrer');});
async function feedActor(request:Request,env:Bindings){
  const signedIn=await person(request,env),actingFor=(request.headers.get('x-coaster-acting-for')||new URL(request.url).searchParams.get('actingFor')||'').toLowerCase();
  return actingFor&&actingFor!==signedIn.email?actingAs(runtimeBindings(env).DB,signedIn,actingFor):signedIn;
}
programFeedApi.get('/program',async c=>c.json(await programFeeds(runtimeBindings(c.env),await feedActor(c.req.raw,c.env))));
programFeedApi.post('/program',async c=>{
  const actor=await feedActor(c.req.raw,c.env);requireThat(Number(c.req.header('content-length')??0)<=30_000,'Program feed configuration is too large',413);
  return c.json(await connectProgramFeed(runtimeBindings(c.env),actor,await object(c.req.raw)));
});
programFeedApi.post('/program/:id/disconnect',async c=>c.json(await disconnectProgramFeed(runtimeBindings(c.env),await feedActor(c.req.raw,c.env),c.req.param('id'),await object(c.req.raw))));
