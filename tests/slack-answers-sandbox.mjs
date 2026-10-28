// Held-key qualification. Receives only genuine Slack events; it never manufactures signatures.
// Invoke through the named credential injector and a server heavy slot on the Mac.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

const bot=process.env.SLACK_BOT_TOKEN,userToken=process.env.SLACK_USER_TOKEN,secret=process.env.SLACK_SIGNING_SECRET;
assert.ok(bot&&userToken&&secret,'Inject the held Slack bot, user and signing-secret sources by name');
const sent=[];
async function providerRequest(url,headers,body) {
  return new Promise((resolve,reject)=>{
    const req=httpsRequest(url,{method:'POST',headers,family:4,timeout:20_000},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.on('timeout',()=>req.destroy(new Error('Slack HTTPS request timed out')));req.on('error',reject);req.end(body);
  });
}
async function slack(token,method,body={}) {
  const response=await providerRequest('https://slack.com/api/'+method,{authorization:'Bearer '+token,'content-type':'application/x-www-form-urlencoded'},new URLSearchParams(Object.entries(body).map(([key,value])=>[key,String(value)])).toString());
  const data=await response.json();
  assert.ok(response.ok&&data.ok,`Slack ${method} refused: ${data.error??response.status}`);
  return {data,scopes:(response.headers.get('x-oauth-scopes')??'').split(',')};
}
const identity=await slack(bot,'auth.test'),person=await slack(userToken,'auth.test');
assert.equal(identity.data.team_id,person.data.team_id,'Both tokens must authorize the same held workspace');
assert.ok(identity.data.bot_id&&!person.data.bot_id,'Use a bot grant and a separate authenticated human grant');
const allowed=identity.scopes.includes('im:history');
if(!allowed) {
  console.log(JSON.stringify({botAuthenticated:true,humanAuthenticated:true,sameWorkspace:true,qualified:false,dependency:'Installed Slack bot needs im:history OAuth grant and bot message.im Events subscription; no message subscriptions were changed'}));
  process.exit(3);
}
if(process.argv.includes('--preflight')) {console.log('Slack bot and human grants pass preflight');process.exit(0);}
const {harness,agency}=await import('./harness.mjs');
const {pendingEmailQuestionClaim}=await import('./fixtures/email-question-claim.mjs');
let h,server;
try {
  // Only sign-in mail is a network-edge fake. Every Slack request goes to Slack.
  h=await harness({slackEdge:async request=>{
    const method=new URL(request.url).pathname.split('/').at(-1),body=await request.clone().text();
    const response=await providerRequest(request.url,Object.fromEntries(request.headers),body),data=await response.clone().json();
    if(method==='chat.postMessage'&&data.ok) sent.push({token:bot,channel:data.channel,ts:data.ts,body:new URLSearchParams(body).get('text')});
    return response;
  }});
  const team=await agency(h),address=['sam','harbourfinch.example'].join('@');
  await h.post('chat/slack/connect',{botToken:bot,signingSecret:secret,consent:true});
  await h.post('chat/slack/link/start',{user:person.data.user_id,consent:true},team.sam);
  const challenge=sent.at(-1),history=(await slack(userToken,'conversations.history',{channel:challenge.channel,limit:20})).data;
  const liveChallenge=history.messages.find(message=>message.ts===challenge.ts);
  const code=liveChallenge?.text.match(/code: ([a-f0-9]+)/)?.[1];assert.ok(code,'The authenticated Slack user reads the live private link code');
  await h.post('chat/slack/link/confirm',{code},team.sam);
  const claim=await pendingEmailQuestionClaim(h,team,'Synthetic client workshop');
  const before=await h.get(`claims/${claim.id}`,team.priya);
  const question=await h.post(`claims/${claim.id}/comments`,{body:'Which client was this for?',item:before.items[0].id,asks:address},team.priya);
  assert.equal(question.slack,'sent');
  const message=sent.at(-1);
  if(allowed) {
    // A public relay must forward only this receiver path. No native session is exposed.
    server=createServer(async(req,res)=>{
      if(req.method!=='POST'||req.url!=='/slack-events'){res.writeHead(404);res.end();return;}
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>32_000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const result=await h.mf.dispatchFetch(h.origin+'/api/coaster/chat/slack/events',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)});
      res.writeHead(result.status,{'content-type':'application/json'});res.end(await result.text());
    });
    await new Promise(resolve=>server.listen(Number(process.env.COASTER_SLACK_EVENTS_PORT??0),'127.0.0.1',resolve));
    console.log('SLACK_EVENTS_RECEIVER_PORT '+server.address().port);
    assert.ok(process.env.COASTER_SLACK_EVENTS_PORT,'Set the port already configured by the narrow public Slack relay');
  }
  const reply=(await slack(userToken,'chat.postMessage',{channel:message.channel,thread_ts:message.ts,text:'Synthetic client workshop team',mrkdwn:false})).data;
  sent.push({token:userToken,channel:reply.channel,ts:reply.ts});
  const readback=(await slack(userToken,'conversations.replies',{channel:message.channel,ts:message.ts})).data;
  assert.ok(readback.messages.some(m=>m.ts===reply.ts&&m.user===person.data.user_id&&m.text==='Synthetic client workshop team'),'The real authenticated employee answered in the actual question thread');
    const deadline=Date.now()+90_000;let detail;
    do {detail=await h.get(`claims/${claim.id}`,team.priya);if(!detail.comments.find(c=>c.id===question.comment).open)break;await new Promise(resolve=>setTimeout(resolve,500));}while(Date.now()<deadline);
    assert.equal(detail.comments.find(c=>c.id===question.comment).open,false,'A genuinely signed Slack event closes the native question');
    assert.ok(detail.comments.some(c=>c.parent_id===question.comment&&c.author_email===address&&c.body==='Synthetic client workshop team'));
    const approved=await h.post(`claims/${claim.id}/decision`,{revision:claim.revision,version:claim.version,decision:'approved',acknowledge:true},team.priya);
    assert.equal(approved.status,'approved');assert.deepEqual((await h.get(`claims/${claim.id}`,team.priya)).revisions,before.revisions);
    console.log(JSON.stringify({liveConnection:true,liveSelfLink:true,liveQuestion:true,liveHumanThreadReply:true,nativeSignedAnswer:true,qualified:true}));
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  const cleanup=[];
  try {for(const message of sent.reverse()) {try {await slack(message.token,'chat.delete',{channel:message.channel,ts:message.ts});}catch {cleanup.push('Slack message deletion failed');}}}
  finally {await h?.close();}
  assert.deepEqual(cleanup,[],'All messages created by this qualification are removed');
}
