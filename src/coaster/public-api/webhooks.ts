import type { Bindings } from '../../auth.server';
import { all, authority, commit } from '../session';
import { event } from '../events';
import { Fault, now, requireThat, uid, type Actor, type Data } from '../types';
import { identityStill, nativeOwner, randomSecret, snapshot } from './credentials';
import { seal, signature, unseal } from './crypto';

export const WEBHOOK_EVENTS={'claim-created':'claim.created','claim-submitted':'claim.submitted','claim-approved':'claim.approved','claim-returned':'claim.returned','claim-rejected':'claim.rejected','batch-reimbursed':'payment.settled'} as const;
const statuses:Record<string,string>={'claim-created':'draft','claim-submitted':'submitted','claim-approved':'approved','claim-returned':'returned','claim-rejected':'rejected','batch-reimbursed':'reimbursed'};
/** Exact owner allowlist is the subscription URL. Literal global IPv4 prevents DNS rebinding;
 * domain names require a future public-egress boundary that pins DNS resolution to the connection. */
export function destination(value:unknown) {
  requireThat(typeof value==='string'&&value.length<=2000,'HTTPS destination required');
  let url:URL; try { url=new URL(value); } catch { requireThat(false,'Invalid webhook destination'); }
  requireThat(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search&&(!url.port||url.port==='443'),'Use HTTPS without credentials, query, fragment or custom port');
  requireThat(/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname),'Webhook destinations currently require a global public IPv4 literal');
  const [a,b,c]=url.hostname.split('.').map(Number);
  const blocked=a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113);
  requireThat(!blocked,'Webhook destination must be a global public address');
  return url.href;
}
export async function createSubscription(env:Bindings,a:Actor,b:Data) {
  nativeOwner(a);
  requireThat(b.consent===true,'Explicit consent to send minimal event metadata is required');
  const target=destination(b.destination),known=Object.values(WEBHOOK_EVENTS) as string[];
  requireThat(Array.isArray(b.events)&&b.events.length>0&&b.events.length<=known.length&&b.events.every((x:unknown)=>typeof x==='string'&&known.includes(x)),'Choose supported webhook events');
  const events=[...new Set(b.events as string[])].sort(),id=uid(),secret=randomSecret('cpw_'),access=await snapshot(env.DB,a.email);
  await commit(env.DB,all(authority(a,'owner'),identityStill(a.email,access),{sql:'(SELECT COUNT(*) FROM c_public_webhooks WHERE revoked_at IS NULL)<100',params:[]}),[
    env.DB.prepare('INSERT INTO c_public_webhooks(id,destination,secret_sealed,events,created_by,access_snapshot,start_seq,created_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0) FROM c_events),?)').bind(id,target,await seal(env.SESSION_SECRET,id,secret),JSON.stringify(events),a.email,access,now()),
    event(env.DB,a,'public-webhook-consented',{}, {subscription:id,destination:target,events,payload:'event id, type, time, record id and status only'}),
  ]);
  return {id,destination:target,events,secret};
}
export async function revokeSubscription(db:D1Database,a:Actor,id:string) {
  nativeOwner(a);requireThat(await db.prepare('SELECT 1 FROM c_public_webhooks WHERE id=?').bind(id).first(),'Webhook not found',404);
  await commit(db,authority(a,'owner'),[db.prepare('UPDATE c_public_webhooks SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now(),id),event(db,a,'public-webhook-revoked',{}, {subscription:id})]);return {id};
}
export async function subscriptions(db:D1Database,a:Actor) {
  nativeOwner(a);
  const rows=(await db.prepare('SELECT id,destination,events,created_at,revoked_at FROM c_public_webhooks ORDER BY created_at DESC').all<Data>()).results;
  const deliveries=(await db.prepare('SELECT subscription_id,event_id,attempt,next_at,delivered_at,last_status FROM c_public_webhook_deliveries ORDER BY event_id LIMIT 500').all()).results;
  return {data:rows.map(x=>({...x,events:JSON.parse(x.events)})),deliveries};
}
/** Durable outbox derives from transactionally committed native history, so rolled-back decisions never send. */
export async function deliverWebhooks(env:Bindings,at:Date) {
  const db=env.DB,clock=at.getTime(),subscriptions=(await db.prepare('SELECT * FROM c_public_webhooks WHERE revoked_at IS NULL ORDER BY created_at LIMIT 100').all<Data>()).results;
  for(const sub of subscriptions) {
    const live=identityStill(sub.created_by,sub.access_snapshot);
    const active={sql:`EXISTS(SELECT 1 FROM c_public_webhooks WHERE id=? AND revoked_at IS NULL) AND (${live.sql})`,params:[sub.id,...live.params]};
    if(!await db.prepare(`SELECT 1 AS ok WHERE ${active.sql}`).bind(...active.params).first()) continue;
    const events=JSON.parse(sub.events) as string[],actions=Object.keys(WEBHOOK_EVENTS).filter(k=>events.includes(WEBHOOK_EVENTS[k as keyof typeof WEBHOOK_EVENTS]));
    try {
      await commit(db,active,[db.prepare(`INSERT OR IGNORE INTO c_public_webhook_deliveries(subscription_id,event_id) SELECT ?,id FROM c_events WHERE seq>? AND action IN (${actions.map(()=>'?').join(',')})`).bind(sub.id,sub.start_seq,...actions)]);
    } catch(error) { if(error instanceof Fault && error.status===409) continue;throw error; }
    const due=(await db.prepare('SELECT d.*,e.at,e.action,e.claim_id,e.batch_id FROM c_public_webhook_deliveries d JOIN c_events e ON e.id=d.event_id WHERE d.subscription_id=? AND d.delivered_at IS NULL AND d.attempt<6 AND d.next_at<=? AND d.lease_until<=? ORDER BY e.seq LIMIT 50').bind(sub.id,clock,clock).all<Data>()).results;
    for(const delivery of due) {
      // A unique lease is committed before the external effect, and a second worker cannot claim it.
      const lease=clock+60000;
      const attempt=delivery.attempt+1;
      try {
        await commit(db,all(active,{sql:'EXISTS(SELECT 1 FROM c_public_webhook_deliveries WHERE subscription_id=? AND event_id=? AND delivered_at IS NULL AND attempt=? AND next_at<=? AND lease_until<=?)',params:[sub.id,delivery.event_id,delivery.attempt,clock,clock]}),[
          db.prepare('UPDATE c_public_webhook_deliveries SET attempt=?,lease_until=?,next_at=? WHERE subscription_id=? AND event_id=?').bind(attempt,lease,clock+3600000*2**delivery.attempt,sub.id,delivery.event_id),
        ]);
      } catch(error) { if(error instanceof Fault && error.status===409) continue;throw error; }
      let status=0;
      try {
        const target=destination(sub.destination),body=JSON.stringify({id:delivery.event_id,type:WEBHOOK_EVENTS[delivery.action as keyof typeof WEBHOOK_EVENTS],time:delivery.at,record:{id:delivery.claim_id??delivery.batch_id,status:statuses[delivery.action]}}),timestamp=String(Math.floor(Date.now()/1000));
        const secret=await unseal(env.SESSION_SECRET,sub.id,sub.secret_sealed);
        // Check revocation again immediately before dispatch; revocation cannot retract a request already in flight.
        if(!await db.prepare(`SELECT 1 AS ok WHERE ${active.sql}`).bind(...active.params).first()) continue;
        const response=await fetch(target,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json','x-coaster-event-id':delivery.event_id,'x-coaster-timestamp':timestamp,'x-coaster-signature':'v1='+await signature(secret,timestamp,body)},body});
        status=response.status;
        if(response.body) await response.body.cancel();
      } catch { /* Only status 0 is retained; response bodies and transport errors may contain secrets. */ }
      // Retain the outcome of an already dispatched attempt even when consent ended in flight.
      try {
        await commit(db,all({sql:'1',params:[]},{sql:'EXISTS(SELECT 1 FROM c_public_webhook_deliveries WHERE subscription_id=? AND event_id=? AND attempt=? AND lease_until=? AND delivered_at IS NULL)',params:[sub.id,delivery.event_id,attempt,lease]}),[
          db.prepare('UPDATE c_public_webhook_deliveries SET last_status=?,delivered_at=?,lease_until=0 WHERE subscription_id=? AND event_id=?').bind(status,status>=200&&status<300?now():null,sub.id,delivery.event_id),
        ]);
      } catch(error) { if(!(error instanceof Fault && error.status===409)) throw error; }

    }
  }
}
