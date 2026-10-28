import type { Bindings } from '../../auth.server';
import { can, needRow, rowAuthority } from '../permissions';
import { all, authority, commit, sha256Hex } from '../session';
import { event } from '../events';
import { now, requireThat, text, uid, type Actor, type Data } from '../types';
import { connection, connectionState, credentials, directMessage, sealCredentials, slack, slackMember } from './slack-transport';

function native(actor: Actor) { requireThat(actor.kind==='person' && !actor.delegate && !actor.publicCredential,'Use your own native session',403); }
function connectAuthority(actor: Actor) { native(actor); needRow(actor,'connections'); return rowAuthority(actor,'connections'); }
async function member(env: Bindings, actor: Actor) {
  native(actor);
  const m = await env.DB.prepare('SELECT member_id FROM c_members WHERE email=? AND active=1').bind(actor.email).first<{member_id:string}>();
  requireThat(m,'An active native membership is required',403); return m.member_id;
}
export async function slackStatus(env: Bindings, actor: Actor) {
  native(actor);
  const c=await connection(env), m=await env.DB.prepare('SELECT member_id FROM c_members WHERE email=? AND active=1').bind(actor.email).first<{member_id:string}>();
  const link=m&&c?await env.DB.prepare('SELECT user FROM c_slack_links WHERE member_id=? AND connection_id=?').bind(m.member_id,c.id).first<{user:string}>():null;
  return { connected:!!c, workspace:c?.workspace, connection:c?.id, canConnect:can(actor,'connections'), linked:!!link, user:link?.user, eventUrl:can(actor,'connections')?env.AUTH_ORIGIN+'/api/coaster/chat/slack/events':undefined };
}
export async function connectSlack(env: Bindings, actor: Actor, body: Data) {
  const auth=connectAuthority(actor);
  requireThat(body.consent===true,'Confirm permission to send named questions and receive Slack thread answers');
  requireThat(!await connection(env),'Disconnect the current Slack workspace first',409);
  const token=text(body.botToken,'Slack bot token',4000), secret=text(body.signingSecret,'Slack signing secret',4000);
  const identity=await slack(token,'auth.test');
  requireThat(typeof identity.team_id==='string' && typeof identity.bot_id==='string','Use a Slack app bot token',403);
  const bot=await slack(token,'bots.info',{bot:identity.bot_id});
  requireThat(typeof bot.bot?.app_id==='string','Slack app identity was not verified',403);
  const id=uid();
  await commit(env.DB,all(auth,{sql:'NOT EXISTS(SELECT 1 FROM c_slack_connection)',params:[]}),[
    env.DB.prepare('INSERT INTO c_slack_connection(id,team,app,workspace,credentials,connected_at) VALUES(?,?,?,?,?,?)').bind(id,identity.team_id,bot.bot.app_id,text(identity.team,'Workspace',200),await sealCredentials(env,id,token,secret),now()),
    event(env.DB,actor,'slack-connected',{}, {connection:id,consent:true,channel:'app'}),
  ]);
  return slackStatus(env,actor);
}
export async function disconnectSlack(env: Bindings, actor: Actor, body: Data) {
  const auth=connectAuthority(actor), c=await connection(env);
  requireThat(body.consent===true,'Confirm disconnecting Slack'); requireThat(c,'Slack is not connected',409);
  await commit(env.DB,all(auth,connectionState(c)),[env.DB.prepare('DELETE FROM c_slack_connection WHERE id=?').bind(c.id),event(env.DB,actor,'slack-disconnected',{}, {connection:c.id,channel:'app'})]);
  return slackStatus(env,actor);
}
export async function startSlackLink(env: Bindings, actor: Actor, body: Data) {
  const memberId=await member(env,actor), c=await connection(env);
  requireThat(c,'Connect Slack first',409); requireThat(body.consent===true,'Confirm sending questions to your Slack account');
  const user=text(body.user,'Slack member ID',80); requireThat(/^[UW][A-Z0-9]+$/.test(user),'Supply your Slack member ID');
  const {token}=await credentials(env,c); await slackMember(token,c,user);
  const code=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('');
  const auth=all(authority(actor),connectionState(c),{sql:'EXISTS(SELECT 1 FROM c_members WHERE member_id=? AND email=? AND active=1)',params:[memberId,actor.email]});
  await commit(env.DB,auth,[env.DB.prepare('INSERT INTO c_slack_challenges(member_id,connection_id,user,code_hash,expires) VALUES(?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET connection_id=excluded.connection_id,user=excluded.user,code_hash=excluded.code_hash,expires=excluded.expires').bind(memberId,c.id,user,await sha256Hex(code),Date.now()+600_000)]);
  await directMessage(token,user,'Confirm your Coaster Slack link in your own Coaster Settings using this one-time code: ' + code + '. Only enter it if you requested the link. Named expense questions will be sent here; your thread replies will be shared with the claim readers.');
  return {sent:true};
}
export async function confirmSlackLink(env: Bindings, actor: Actor, body: Data) {
  const memberId=await member(env,actor), c=await connection(env); requireThat(c,'Connect Slack first',409);
  const hash=await sha256Hex(text(body.code,'Slack link code',100));
  const q=await env.DB.prepare('SELECT user FROM c_slack_challenges WHERE member_id=? AND connection_id=? AND code_hash=? AND expires>unixepoch()*1000').bind(memberId,c.id,hash).first<{user:string}>();
  requireThat(q,'Link code is invalid or expired',403);
  const {token}=await credentials(env,c); await slackMember(token,c,q.user);
  requireThat(!await env.DB.prepare('SELECT 1 FROM c_slack_links WHERE connection_id=? AND user=? AND member_id<>?').bind(c.id,q.user,memberId).first(),'This Slack account is already linked',409);
  await commit(env.DB,all(authority(actor),connectionState(c),{sql:'EXISTS(SELECT 1 FROM c_members WHERE member_id=? AND email=? AND active=1) AND EXISTS(SELECT 1 FROM c_slack_challenges WHERE member_id=? AND connection_id=? AND user=? AND code_hash=? AND expires>unixepoch()*1000)',params:[memberId,actor.email,memberId,c.id,q.user,hash]}),[
    env.DB.prepare('DELETE FROM c_slack_links WHERE member_id=?').bind(memberId),
    env.DB.prepare('INSERT INTO c_slack_links(member_id,connection_id,user) VALUES(?,?,?)').bind(memberId,c.id,q.user),
    env.DB.prepare('DELETE FROM c_slack_challenges WHERE member_id=?').bind(memberId),
    event(env.DB,actor,'slack-self-linked',{}, {connection:c.id,consent:true,channel:'app'}),
  ]);
  return slackStatus(env,actor);
}
export async function unlinkSlack(env: Bindings, actor: Actor) {
  const memberId=await member(env,actor);
  await commit(env.DB,authority(actor),[env.DB.prepare('DELETE FROM c_slack_links WHERE member_id=?').bind(memberId),env.DB.prepare('DELETE FROM c_slack_challenges WHERE member_id=?').bind(memberId),event(env.DB,actor,'slack-self-unlinked',{}, {channel:'app'})]);
  return slackStatus(env,actor);
}
