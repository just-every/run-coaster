import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

/** Only Slack's paid network boundary is faked; all Coaster routes are real. */
export function slackFixture() {
  const edge={token:'synthetic-coaster-1',secret:'synthetic-coaster-2',team:'TSYNTHETIC1',app:'ASYNTHETIC1',user:'USYNTHETIC1',messages:[],inactive:new Set(),calls:[]};
  edge.fetch=async request=>{
    const method=new URL(request.url).pathname.split('/').at(-1), body=Object.fromEntries(new URLSearchParams(await request.text()));
    edge.calls.push({method,body});
    assert.equal(request.headers.get('authorization'),'Bearer '+edge.token);
    if(method==='auth.test') return Response.json({ok:true,team_id:edge.team,team:'Synthetic Coaster workspace',bot_id:'BSYNTHETIC1'});
    if(method==='bots.info') return Response.json({ok:true,bot:{app_id:edge.app}});
    if(method==='users.info') { await edge.beforeMember?.(); return Response.json({ok:true,user:{id:body.user,team_id:edge.team,deleted:edge.inactive.has(body.user),is_bot:false}}); }
    if(method==='conversations.open') return Response.json({ok:true,channel:{id:'D'+body.users}});
    if(method==='chat.postMessage') {
      const sent={...body,ts:`1800000000.${String(edge.messages.length+1).padStart(6,'0')}`}; edge.messages.push(sent);
      return Response.json({ok:true,channel:sent.channel,ts:sent.ts});
    }
    throw new Error('Unexpected Slack network method '+method);
  };
  edge.reply=(overrides={})=>{
    const question=edge.messages.findLast(m=>m.text.includes('Reply in this message thread'));
    assert.ok(question,'question was actually sent to Slack');
    const {event={},...outer}=overrides;
    return {type:'event_callback',team_id:edge.team,api_app_id:edge.app,event_id:'synthetic-coaster-3',...outer,event:{type:'message',user:edge.user,channel:question.channel,thread_ts:question.ts,ts:'1800000001.000001',text:'Harbour Bank, the pitch team',...event}};
  };
  return edge;
}
export const connectSlack=(h,edge,cookie=h.owner)=>h.post('chat/slack/connect',{botToken:edge.token,signingSecret:edge.secret,consent:true},cookie);
export async function linkSlack(h,edge,cookie,user=edge.user) {
  await h.post('chat/slack/link/start',{user,consent:true},cookie);
  const code=edge.messages.at(-1).text.match(/code: ([a-f0-9]+)/)?.[1]; assert.ok(code);
  return h.post('chat/slack/link/confirm',{code},cookie);
}
export async function deliverSlack(h,edge,event=edge.reply(),{secret=edge.secret,timestamp=Math.floor(Date.now()/1000)}={}) {
  const body=JSON.stringify(event),signature='v0='+createHmac('sha256',secret).update(`v0:${timestamp}:${body}`).digest('hex');
  const response=await h.mf.dispatchFetch(h.origin+'/api/coaster/chat/slack/events',{method:'POST',headers:{'content-type':'application/json','x-slack-request-timestamp':String(timestamp),'x-slack-signature':signature},body});
  return {status:response.status,value:await response.json()};
}
