import type { Bindings } from '../../auth.server';
import { unseal, seal } from '../public-api/crypto';
import { requireThat, type Data } from '../types';
import type { Sql } from '../session';

export type Connection = { id: string; team: string; app: string; workspace: string; credentials: string };
export const connection = (env: Bindings) => env.DB.prepare('SELECT * FROM c_slack_connection').first<Connection>();
export const connectionState = (c: Connection): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_slack_connection WHERE id=? AND team=? AND app=?)', params: [c.id,c.team,c.app] });
export const sealCredentials = (env: Bindings, id: string, token: string, signingSecret: string) => seal(env.INSTALLATION_KEY, 'slack:' + id, JSON.stringify({ token, signingSecret }));
export const credentials = async (env: Bindings, c: Connection): Promise<{token:string;signingSecret:string}> => JSON.parse(await unseal(env.INSTALLATION_KEY,'slack:' + c.id,c.credentials));

/** Fixed provider endpoint, bounded calls, no redirect or provider-body errors. */
export async function slack(token: string, method: string, body: Data = {}): Promise<Data> {
  const form=new URLSearchParams(Object.entries(body).map(([key,value])=>[key,String(value)]));
  const response = await fetch('https://slack.com/api/' + method, { method:'POST', redirect:'manual', signal:AbortSignal.timeout(10_000), headers:{authorization:'Bearer ' + token,'content-type':'application/x-www-form-urlencoded'}, body:form.toString() });
  requireThat(response.ok, 'Slack could not complete this request', 502);
  const data = await response.json() as Data;
  requireThat(data.ok === true, 'Slack refused this request; check app access and scopes', 502);
  return data;
}
export async function slackMember(token: string, c: Connection, user: string) {
  const data = await slack(token,'users.info',{user});
  requireThat(data.user?.id === user && data.user?.team_id === c.team && !data.user.deleted && !data.user.is_bot && !data.user.is_app_user, 'Slack sender is not an active person in this workspace',403);
}
export async function directMessage(token: string, user: string, text: string) {
  const opened = await slack(token,'conversations.open',{users:user});
  requireThat(typeof opened.channel?.id === 'string', 'Slack did not open a private conversation',502);
  const sent = await slack(token,'chat.postMessage',{channel:opened.channel.id,text,mrkdwn:false,parse:'none',unfurl_links:false,unfurl_media:false});
  requireThat(sent.channel === opened.channel.id && typeof sent.ts === 'string', 'Slack did not identify the posted message',502);
  return {channel:sent.channel as string,thread:sent.ts as string};
}
export async function verifiedBody(request: Request, secret: string) {
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? '', signature = request.headers.get('x-slack-signature') ?? '';
  requireThat(/^\d{10}$/.test(timestamp) && Math.abs(Date.now()/1000 - Number(timestamp)) <= 300 && /^v0=[a-f0-9]{64}$/.test(signature), 'Invalid Slack signature',403);
  requireThat(Number(request.headers.get('content-length') ?? 0) <= 32_000, 'Slack event is too large',413);
  const raw = await request.text();
  requireThat(new TextEncoder().encode(raw).byteLength <= 32_000, 'Slack event is too large',413);
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes = Uint8Array.from(signature.slice(3).match(/../g)!,pair=>parseInt(pair,16));
  requireThat(await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(`v0:${timestamp}:${raw}`)), 'Invalid Slack signature',403);
  try { return JSON.parse(raw) as Data; } catch { requireThat(false,'Invalid Slack event'); }
}
