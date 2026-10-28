import type { Bindings } from '../../auth.server';
import { canSee, claimNumber, loadClaim } from '../claims';
import { commentWrites } from '../comments';
import { can } from '../permissions';
import { all, commit, rolesFrom, sha256Hex, type Sql } from '../session';
import { Fault, now, requireThat, text, uid, type Actor, type Data } from '../types';
import { connection, connectionState, credentials, directMessage, slackMember, verifiedBody, type Connection } from './slack-transport';

const owner = "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.role='owner' AND o.status='active')";
const activeAccount = "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.status='active') AND NOT EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.status<>'active')";
const flags=['is_employee','is_manager','is_finance','is_auditor','is_admin','is_card_admin','is_bookkeeper'];
const visibility = "EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND (c.employee_email=? OR (c.status<>'draft' AND (? OR (? AND (c.approver_email=? OR c.on_behalf_of=?)) OR EXISTS(SELECT 1 FROM c_workflow_tasks w WHERE w.kind='claim' AND w.record_id=c.id AND w.revision=c.revision AND (w.email=? OR w.on_behalf_of=?))))))";

/** Only a linked named person's pending question leaves the installation. */
export async function deliverSlackQuestion(env: Bindings, questionId: string) {
  const c=await connection(env); if(!c) return 'not linked';
  const q=await env.DB.prepare(`SELECT q.*,m.*,l.user,(${owner}) AS is_owner FROM c_comments q JOIN c_members m ON m.email=q.asks_email AND m.active=1 JOIN c_slack_links l ON l.member_id=m.member_id AND l.connection_id=? WHERE q.id=? AND q.parent_id IS NULL AND ${activeAccount}`).bind(c.id,questionId).first<Data>();
  if(!q) return 'not linked';
  const claim=await loadClaim(env.DB,q.claim_id);
  const actor:Actor={kind:'person',email:q.email,name:q.name,roles:rolesFrom(q,q.is_owner===1)};
  if(!canSee(actor,claim)) return 'not authorized';
  if(claim.status!=='submitted') return 'not pending';
  const {token}=await credentials(env,c); await slackMember(token,c,q.user);
  const sent=await directMessage(token,q.user,`${claimNumber(claim.number)} · ${claim.title}\n${q.body}\nReply in this message thread to answer in Coaster. Your answer is visible to the claim readers. ${env.AUTH_ORIGIN}/app#/claims/${claim.id}`);
  await commit(env.DB,all(connectionState(c),{
    sql:`EXISTS(SELECT 1 FROM c_members m JOIN c_slack_links l ON l.member_id=m.member_id WHERE m.member_id=? AND m.email=? AND m.active=1 AND ${activeAccount} AND l.connection_id=? AND l.user=?)`,params:[q.member_id,q.asks_email,c.id,q.user],
  },{
    sql:"EXISTS(SELECT 1 FROM c_comments WHERE id=? AND asks_email=? AND body=?) AND EXISTS(SELECT 1 FROM c_claims WHERE id=? AND status='submitted' AND revision=? AND version=?) AND NOT EXISTS(SELECT 1 FROM c_comments WHERE parent_id=? AND (author_email=? OR on_behalf_of=?))",params:[q.id,q.asks_email,q.body,claim.id,claim.revision,claim.version,q.id,q.asks_email,q.asks_email],
  }),[env.DB.prepare('INSERT INTO c_slack_threads(question_id,connection_id,member_id,channel,thread,revision) VALUES(?,?,?,?,?,?)').bind(q.id,c.id,q.member_id,sent.channel,sent.thread,claim.revision)]);
  return 'sent';
}

async function answer(env: Bindings, c: Connection, data: Data, token: string) {
  const e=data.event;
  requireThat(data.team_id===c.team && data.api_app_id===c.app,'Unknown Slack workspace or app',403);
  requireThat(data.type==='event_callback' && typeof data.event_id==='string' && data.event_id.length<=200,'Unsupported Slack event');
  requireThat(e?.type==='message' && !e.subtype && !e.bot_id && typeof e.user==='string' && typeof e.channel==='string' && typeof e.thread_ts==='string' && e.ts!==e.thread_ts,'Reply in the original question thread',403);
  const q=await env.DB.prepare(`SELECT q.*,t.member_id,t.revision,t.channel,t.thread,l.user,m.*,(${owner}) AS is_owner FROM c_slack_threads t JOIN c_comments q ON q.id=t.question_id JOIN c_slack_links l ON l.member_id=t.member_id AND l.connection_id=t.connection_id JOIN c_members m ON m.member_id=t.member_id AND m.email=q.asks_email WHERE t.connection_id=? AND t.channel=? AND t.thread=? AND l.user=? AND m.active=1 AND ${activeAccount}`).bind(c.id,e.channel,e.thread_ts,e.user).first<Data>();
  requireThat(q,'Unknown Slack sender or question thread',403);
  await slackMember(token,c,e.user);
  const actor:Actor={kind:'person',email:q.email,name:q.name,roles:rolesFrom(q,q.is_owner===1)};
  const claim=await loadClaim(env.DB,q.claim_id);
  requireThat(canSee(actor,claim),'You can no longer open this claim',403);
  requireThat(claim.revision===q.revision,'The submitted claim revision has changed',409);
  // Both provider delivery and source message identities are opaque digests.
  // Different event IDs for the same message cannot make a second answer.
  const digest=await sha256Hex(JSON.stringify([c.id,c.team,c.app,e.channel,e.thread_ts,e.user,e.ts]));
  const replay=await env.DB.prepare('SELECT comment_id FROM c_slack_answers WHERE digest=?').bind(digest).first<{comment_id:string|null}>();
  if(replay) return {accepted:true,replayed:true};
  requireThat(!await env.DB.prepare('SELECT 1 FROM c_comments WHERE parent_id=? AND (author_email=? OR on_behalf_of=?)').bind(q.id,actor.email,actor.email).first(),'This question has already been answered',409);
  const body=text(e.text,'Slack answer',2000), commentId=uid();
  const live:Sql={
    sql:`(${connectionState(c).sql}) AND EXISTS(SELECT 1 FROM c_members m JOIN c_slack_links l ON l.member_id=m.member_id WHERE m.member_id=? AND m.email=? AND m.active=1 AND ${activeAccount} AND ${flags.map(f=>`m.${f}=?`).join(' AND ')} AND (${owner})=? AND l.connection_id=? AND l.user=?) AND EXISTS(SELECT 1 FROM c_slack_threads WHERE question_id=? AND connection_id=? AND member_id=? AND channel=? AND thread=? AND revision=?) AND ${visibility}`,
    params:[...connectionState(c).params,q.member_id,actor.email,...flags.map(f=>q[f]),q.is_owner,c.id,e.user,q.id,c.id,q.member_id,e.channel,e.thread_ts,claim.revision,claim.id,actor.email,can(actor,'readAll')?1:0,actor.roles.manager?1:0,actor.email,actor.email,actor.email,actor.email],
  };
  try {
    await commit(env.DB,all(live,{
      sql:'EXISTS(SELECT 1 FROM c_claims WHERE id=? AND version=? AND revision=?) AND EXISTS(SELECT 1 FROM c_comments WHERE id=? AND claim_id=? AND asks_email=? AND parent_id IS NULL) AND NOT EXISTS(SELECT 1 FROM c_comments WHERE parent_id=? AND (author_email=? OR on_behalf_of=?)) AND NOT EXISTS(SELECT 1 FROM c_slack_answers WHERE digest=?)',
      params:[claim.id,claim.version,claim.revision,q.id,claim.id,actor.email,q.id,actor.email,actor.email,digest],
    }),[
      ...commentWrites(env.DB,actor,claim.id,{id:commentId,item:q.item_id,parent:q.id,asks:null,parentAsks:actor.email,body,at:now(),channel:'slack'}),
      env.DB.prepare('INSERT INTO c_slack_answers(digest,comment_id) VALUES(?,?)').bind(digest,commentId),
    ]);
  } catch(error) {
    if(await env.DB.prepare('SELECT 1 FROM c_slack_answers WHERE digest=?').bind(digest).first()) return {accepted:true,replayed:true};
    if(error instanceof Fault) throw error;
    throw error;
  }
  return {accepted:true,replayed:false};
}

/** Slack Events API is a signed provider door, independent of native cookies. */
export async function slackEvent(env: Bindings, request: Request) {
  const c=await connection(env); requireThat(c,'Slack is not connected',403);
  const {token,signingSecret}=await credentials(env,c), data=await verifiedBody(request,signingSecret);
  if(data.type==='url_verification') { requireThat(typeof data.challenge==='string' && data.challenge.length<=1000,'Invalid Slack challenge'); return {challenge:data.challenge}; }
  return answer(env,c,data,token);
}
