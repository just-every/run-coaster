import { runtimeBindings, type Bindings } from '../../auth.server';
import { all, commit, type Sql } from '../session';
import { ruleEvent } from '../events';
import { requireThat, uid, Fault, now } from '../types';
import { feed, feedState, permittedHost, type Feed } from './model';
import { pullDeliveries } from './transport';
import { unseal } from './sealing';
import { recordMisses } from './health';
import { receiveDelivery } from './delivery';

const leaseState=(f:Feed,id:string):Sql=>all(feedState(f.id,f.version),{sql:'EXISTS(SELECT 1 FROM c_program_feeds WHERE id=? AND lease_id=? AND lease_until>?)',params:[f.id,id,Date.now()]});
async function runFeed(env:Bindings,f:Feed,at:Date){
  const db=env.DB,lease=uid();
  await commit(db,all(feedState(f.id,f.version),{sql:'EXISTS(SELECT 1 FROM c_program_feeds WHERE id=? AND lease_until<? AND next_run_at<=?)',params:[f.id,Date.now(),at.getTime()]}),[db.prepare('UPDATE c_program_feeds SET lease_id=?,lease_until=? WHERE id=?').bind(lease,Date.now()+90_000,f.id)]);
  const authorized=async()=>{const guard=leaseState(f,lease);requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(),'The program feed was disconnected or changed; delivery stopped',409);};
  await recordMisses(db,f,at,leaseState(f,lease));
  try{
    requireThat(f.credentials_sealed,'Connect the program feed again',409);
    const credentials=await unseal(env,f.id,f.credentials_sealed);permittedHost(env,credentials.host);
    const known=new Set((await db.prepare('SELECT name FROM c_program_deliveries WHERE feed_id=?').bind(f.id).all<{name:string}>()).results.map(v=>v.name));
    await pullDeliveries(credentials,authorized,async delivery=>{await receiveDelivery(db,f,delivery,leaseState(f,lease),at);},known,async()=>{await commit(db,leaseState(f,lease),[db.prepare('UPDATE c_program_feeds SET last_success_at=? WHERE id=?').bind(at.toISOString(),f.id)]);});
    await commit(db,all(feedState(f.id,f.version),leaseState(f,lease)),[db.prepare('UPDATE c_program_feeds SET last_success_at=?,last_error=NULL,next_run_at=?,lease_id=NULL,lease_until=0 WHERE id=?').bind(at.toISOString(),at.getTime()+f.interval_minutes*60_000,f.id)]);
  }catch(error){
    const latest=await feed(db,f.id);
    if(!latest?.enabled||latest.lease_id!==lease)return;
    const message=error instanceof Fault?error.message:'The SFTP connection, verified host key or delivery failed; check the program configuration and connect again if needed';
    await commit(db,all(feedState(f.id,f.version),leaseState(f,lease)),[db.prepare('UPDATE c_program_feeds SET last_error=?,next_run_at=?,lease_id=NULL,lease_until=0 WHERE id=?').bind(message,at.getTime()+f.interval_minutes*60_000,f.id),ruleEvent(db,'automation: program feed','program-feed-sync-failed',{}, {feed:f.id,issuer:f.issuer,reason:message,channel:'schedule'})]);
  }
}
/** Public Cron door: actual SFTP pick-up, never a person uploading or an HTTP substitute. */
export async function runProgramFeeds(original:Bindings,at:Date){
  const env=runtimeBindings(original),rows=(await env.DB.prepare('SELECT * FROM c_program_feeds WHERE enabled=1 AND next_run_at<=? AND lease_until<? ORDER BY next_run_at,id LIMIT 10').bind(at.getTime(),Date.now()).all<Feed>()).results;
  for(const f of rows){
    try{await runFeed(env,f,at);}catch(error){const latest=await feed(env.DB,f.id);if(!(error instanceof Fault&&error.status===409&&(!latest?.enabled||latest.lease_until>=Date.now()||latest.next_run_at>at.getTime())))throw error;}
  }
}
