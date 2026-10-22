import type { Bindings } from '../../auth.server';
import { parsePrivateKey } from '@workeryard/undershell';
import { all, commit } from '../session';
import { event } from '../events';
import { categoryFor } from '../cards/plan';
import { issuerLabel } from '../cards/statement';
import { optionalText, requireThat, text, uid, now, type Actor, type Data } from '../types';
import { connectionAuthority, feed, feedState, permittedHost, publicFeed, type Feed } from './model';
import { seal } from './sealing';
import type { SftpCredentials } from './transport';

export async function programFeeds(env: Bindings, actor: Actor) {
  connectionAuthority(actor);
  const rows = (await env.DB.prepare('SELECT * FROM c_program_feeds ORDER BY connected_at,id').all<Feed>()).results;
  const deliveries = (await env.DB.prepare('SELECT id,feed_id,name,issuer_sequence,sha256,file_id,charges,received_at FROM c_program_deliveries ORDER BY received_at DESC LIMIT 100').all()).results;
  return { feeds: rows.map(publicFeed), deliveries };
}
export async function connectProgramFeed(env: Bindings, actor: Actor, body: Data) {
  const auth=connectionAuthority(actor);
  requireThat(body.consent===true,'Confirm this installation may read files from this SFTP host');
  const host=text(body.host,'SFTP host',100); permittedHost(env,host);
  const port=body.port??22;
  requireThat(Number.isInteger(port)&&port>=1&&port<=65535,'Give an SFTP port from 1 to 65535');
  const directory=text(body.directory,'SFTP directory',300);
  requireThat(/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]*$/.test(directory)&&!directory.split('/').includes('..'),'Use one absolute SFTP delivery directory without parent traversal');
  const fingerprint=text(body.hostKeyFingerprint,'Verified SSH host-key fingerprint',100);
  requireThat(/^SHA256:[a-zA-Z0-9+/]{43}=?$/.test(fingerprint),'Supply the independently verified SHA256 SSH host-key fingerprint');
  const credentials:SftpCredentials={host,port,username:text(body.username,'SFTP username',200),privateKey:text(body.privateKey,'SFTP private key',16_000),hostKeyFingerprint:fingerprint,directory};
  try { await parsePrivateKey(credentials.privateKey); } catch { requireThat(false,'Supply a supported unencrypted SSH private key; it is sealed by this installation'); }
  const issuer=issuerLabel(body.issuer),category=text(body.category,'Initial category',100),costCentre=optionalText(body.costCentre,'Cost center',80),interval=body.intervalMinutes??60;
  requireThat(Number.isInteger(interval)&&interval>=60&&interval<=1440&&interval%60===0,'Choose a whole-hour feed cadence from 60 to 1440 minutes');
  requireThat(body.mapping&&typeof body.mapping==='object'&&!Array.isArray(body.mapping),'Provide the explicit program CSV mapping');
  const allowed=['postedDate','transactionDate','transactionId','description','amount','card','currency','status','type','mcc','sequence','dateFormat','sign'];
  requireThat(Object.keys(body.mapping).every(k=>allowed.includes(k)),'This pull adapter supports only its documented mapped CSV fields');
  for(const key of ['postedDate','transactionId','description','amount','card','sequence','dateFormat','sign']) text(body.mapping[key],`CSV ${key}`,100);
  requireThat(['YYYY-MM-DD','MM/DD/YYYY','DD/MM/YYYY'].includes(body.mapping.dateFormat),'Choose the CSV date format');
  requireThat(['purchases-positive','purchases-negative'].includes(body.mapping.sign),'Choose the CSV amount sign convention');
  for(const value of Object.values(body.mapping)) requireThat(typeof value==='string'&&value.length<=100&&!/[\u0000-\u001f]|\d{13,19}/.test(value),'CSV mapping fields must be safe column names');
  await categoryFor(env.DB,category);
  const id=uid(),at=now();
  await commit(env.DB,all(auth,{sql:'EXISTS(SELECT 1 FROM c_categories WHERE id=? AND active=1)',params:[category]}),[
    env.DB.prepare('INSERT INTO c_program_feeds(id,issuer,credentials_sealed,mapping,category_id,cost_centre,interval_minutes,enabled,version,connected_by,connected_at) VALUES(?,?,?,?,?,?,?,1,1,?,?)').bind(id,issuer,await seal(env,id,credentials),JSON.stringify(body.mapping),category,costCentre,interval,actor.email,at),
    event(env.DB,actor,'program-feed-connected',{}, {feed:id,issuer,format:'mapped-csv',transport:'sftp-pull',intervalMinutes:interval,channel:'app',consent:true}),
  ]);
  return publicFeed((await feed(env.DB,id))!);
}
export async function disconnectProgramFeed(env: Bindings, actor: Actor, id: string, body: Data) {
  const auth=connectionAuthority(actor),held=await feed(env.DB,id);
  requireThat(body.consent===true,'Confirm disconnecting this SFTP program feed');
  requireThat(held&&held.enabled&&held.version===body.version,'The program feed changed; reload before disconnecting',409);
  await commit(env.DB,all(auth,feedState(id,held.version)),[
    env.DB.prepare('UPDATE c_program_feeds SET enabled=0,version=version+1,credentials_sealed=NULL,lease_id=NULL,lease_until=0,disconnected_at=? WHERE id=?').bind(now(),id),
    event(env.DB,actor,'program-feed-disconnected',{}, {feed:id,issuer:held.issuer,credentialsRemoved:true,channel:'app'}),
  ]);
  return publicFeed((await feed(env.DB,id))!);
}
