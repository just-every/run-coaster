import type { Bindings } from '../../../auth.server';
import { all, commit, sha256Hex, type Sql } from '../../session';
import { nativeAuthority } from '../qbo/model';
import { can } from '../../permissions';
import { event, ruleEvent } from '../../events';
import { now, uid, text, requireThat, type Actor, type Data } from '../../types';
import { child, value, parseXml, escapeXml, tag, soapResult, qbxml } from './xml';
import { preparePosting, renderPosting } from './posting';

export type Connection = { username: string; password_hash: string; company: string; file_id: string; owner_id: string; connected_by: string };
export const connection = (db: D1Database) => db.prepare('SELECT * FROM c_qbd_connection WHERE id=1').first<Connection>();
const same = (c: Connection): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_qbd_connection WHERE id=1 AND password_hash=?)', params: [c.password_hash] });
export const catalogKinds = ['Account','Class','Customer','Vendor','Employee'];
export async function desktopStatus(db: D1Database, a: Actor) {
  nativeAuthority(a, can(a,'connections') ? 'connections' : 'sync');
  const c = await connection(db);
  const accounts=(await db.prepare('SELECT DISTINCT account_code FROM c_categories ORDER BY account_code').all<{account_code:string}>()).results;
  const people=(await db.prepare('SELECT email,name FROM c_members ORDER BY name').all<{email:string;name:string}>()).results;
  const cards=(await db.prepare('SELECT id,issuer,last4 FROM c_cards ORDER BY issuer,last4').all<{id:string;issuer:string;last4:string}>()).results;
  const journal=(await db.prepare('SELECT debit_account AS name FROM c_card_ledger UNION SELECT credit_account AS name FROM c_card_ledger').all<{name:string}>()).results;
  const classes=(await db.prepare("SELECT DISTINCT cost_centre FROM c_allocations WHERE cost_centre<>''").all<{cost_centre:string}>()).results;
  const options=[{value:'payable',label:'Accounts payable'},{value:'bank',label:'Recorded payment bank account'},...accounts.map(x=>({value:'account:'+x.account_code,label:'Expense account '+(x.account_code||'(default)')})),...people.map(x=>({value:'vendor:'+x.email,label:'Vendor for '+x.name})),...cards.map(x=>({value:'card:'+x.id,label:x.issuer+' ····'+x.last4})),...journal.map(x=>({value:'account:'+x.name,label:x.name})),...classes.map(x=>({value:'class:'+x.cost_centre,label:'Class '+x.cost_centre}))];
  return { mappingOptions:options, connected: !!c, company: c?.company ?? '', catalog: (await db.prepare('SELECT * FROM c_qbd_catalog ORDER BY kind,name').all()).results,
    mappings: (await db.prepare('SELECT * FROM c_qbd_mappings ORDER BY name').all()).results,
    requests: (await db.prepare('SELECT id,source,kind,status,message,txn_id,attempts,created_at,completed_at FROM c_qbd_requests ORDER BY created_at,id LIMIT 500').all()).results };
}
export function configuration(env: Bindings, c: Connection) {
  return `<?xml version="1.0"?><QBWCXML>${tag('AppName','Coaster Desktop')}${tag('AppID','')}${tag('AppURL',env.AUTH_ORIGIN+'/api/coaster/accounting/desktop/soap')}${tag('AppDescription','Consented accounting catalog and posting sync')}${tag('AppSupport',env.AUTH_ORIGIN+'/app')}${tag('UserName',c.username)}${tag('OwnerID',c.owner_id)}${tag('FileID',c.file_id)}<QBType>QBFS</QBType><Scheduler><RunEveryNMinutes>60</RunEveryNMinutes></Scheduler><IsReadOnly>false</IsReadOnly></QBWCXML>`;
}
export async function connectDesktop(env: Bindings, a: Actor, b: Data) {
  const auth = nativeAuthority(a,'connections');
  requireThat(b.consent === true, 'Confirm scheduled catalog reads and accounting posting to this company');
  requireThat(!await connection(env.DB), 'Disconnect the existing Desktop connector first',409);
  requireThat(env.AUTH_ORIGIN.startsWith('https://') || env.AUTH_LOCAL === 'true', 'Web Connector requires HTTPS',409);
  const identity=await env.DB.prepare('SELECT * FROM c_qbd_identity WHERE id=1').first<Data>();
  requireThat(!identity || identity.company===b.company, 'Reconnect the original QuickBooks company file; posting history belongs to that company',409);
  const password = uid()+uid(), c = { username: uid(), password_hash: await sha256Hex(password), company: text(b.company,'QuickBooks company file path',1000), file_id:identity?.file_id ?? '{'+uid().toUpperCase()+'}', owner_id:identity?.owner_id ?? '{'+uid().toUpperCase()+'}', connected_by:a.email };
  await commit(env.DB, all(auth,{ sql:'NOT EXISTS(SELECT 1 FROM c_qbd_connection)',params:[] }),[
    env.DB.prepare('INSERT OR IGNORE INTO c_qbd_identity VALUES(1,?,?,?)').bind(c.company,c.file_id,c.owner_id),
    env.DB.prepare('INSERT INTO c_qbd_connection VALUES(1,?,?,?,?,?,?,?)').bind(c.username,c.password_hash,c.company,c.file_id,c.owner_id,a.email,now()),
    event(env.DB,a,'desktop-connected',{}, { scheduledMinutes:60, consent:true }),
  ]);
  return { password, configuration: configuration(env,c) };
}
export async function disconnectDesktop(db: D1Database, a: Actor) {
  const auth = nativeAuthority(a,'connections');
  await commit(db,auth,[db.prepare('DELETE FROM c_qbd_connection'),db.prepare('DELETE FROM c_qbd_tickets'),db.prepare("UPDATE c_qbd_requests SET status='uncertain',message='Disconnected while awaiting QuickBooks; reconcile before any repost' WHERE status='sent'"),event(db,a,'desktop-disconnected',{})]);
  return { connected:false };
}
export async function mapDesktop(db: D1Database,a: Actor,b: Data) {
  const auth = nativeAuthority(a,'sync'), name=text(b.name,'Mapping name',300),kind=text(b.kind,'Catalog kind',20),id=text(b.listId,'QuickBooks list id',100);
  requireThat(catalogKinds.includes(kind) && await db.prepare('SELECT 1 FROM c_qbd_catalog WHERE kind=? AND list_id=? AND active=1').bind(kind,id).first(),'Choose an active QuickBooks catalog entry');
  await commit(db,auth,[db.prepare('INSERT INTO c_qbd_mappings VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind,list_id=excluded.list_id').bind(name,kind,id),event(db,a,'desktop-mapping-saved',{}, { name,kind,listId:id })]);
  return desktopStatus(db,a);
}
async function queue(db: D1Database, auth: Sql, history: D1PreparedStatement) {
  const statements = catalogKinds.map(kind => db.prepare("INSERT INTO c_qbd_requests(id,source,kind,payload,status,created_at) VALUES(?,?,?,?, 'pending',?)").bind(uid(),'catalog:'+uid(),kind+'Query',JSON.stringify({}),now()));
  statements.push(...await preparePosting(db),history);
  await commit(db,auth,statements);
}
export async function syncDesktop(db: D1Database,a: Actor) {
  const auth=nativeAuthority(a,'sync'),c=await connection(db); requireThat(c,'Connect Desktop first',409);
  await queue(db,all(auth,same(c)),event(db,a,'desktop-sync-queued',{}));
  return desktopStatus(db,a);
}
export async function retryDesktop(db: D1Database,a: Actor,id: string) {
  const auth=nativeAuthority(a,'sync');
  await commit(db,all(auth,{sql:"EXISTS(SELECT 1 FROM c_qbd_requests WHERE id=? AND status='failed')",params:[id]}),[
    db.prepare("UPDATE c_qbd_requests SET status='pending',message='' WHERE id=? AND status='failed'").bind(id),event(db,a,'desktop-retry-queued',{}, {request:id}),
  ]);
  return desktopStatus(db,a);
}

/** The production Web Connector SOAP door. A ticket grants only the explicitly connected company's queue. */
export async function desktopSoap(env: Bindings,request: Request) {
  requireThat(Number(request.headers.get('content-length')??0)<=2_000_000,'XML request too large',413);
  const envelope=parseXml(await request.text()),body=child(envelope,'Body');
  requireThat(envelope.name==='Envelope' && body?.children.length===1,'Expected SOAP envelope');
  const method=body.children[0],name=method.name,db=env.DB;
  if(name==='serverVersion') return soapResult(name,escapeXml('Coaster Desktop 1'));
  if(name==='clientVersion') return soapResult(name,'');
  const c=await connection(db);
  if(name==='authenticate') {
    const valid=c && value(method,'strUserName')===c.username && await sha256Hex(value(method,'strPassword'))===c.password_hash;
    if(!valid) return soapResult(name,'<string></string><string>nvu</string>');
    // Only one connector owns the queue; expired unanswered writes are never automatically repeated.
    const auth= same(c);
    await commit(db,auth,[db.prepare("UPDATE c_qbd_requests SET status='uncertain',message='QuickBooks response was not received; reconcile this request in Desktop before reposting' WHERE status='sent' AND id IN(SELECT request_id FROM c_qbd_tickets WHERE expires<?)").bind(Date.now()),db.prepare('DELETE FROM c_qbd_tickets WHERE expires<?').bind(Date.now())]);
    if(await db.prepare('SELECT 1 FROM c_qbd_tickets').first()) return soapResult(name,'<string></string><string>none</string>');
    await queue(db,auth,ruleEvent(db,'desktop connector','desktop-sync-started',{}, {channel:'schedule'}));
    const ticket=uid()+uid();
    await commit(db,all(auth,{sql:'NOT EXISTS(SELECT 1 FROM c_qbd_tickets)',params:[]}),[db.prepare('INSERT INTO c_qbd_tickets(ticket_hash,expires) VALUES(?,?)').bind(await sha256Hex(ticket),Date.now()+600_000)]);
    return soapResult(name,tag('string',ticket)+tag('string',c.company));
  }
  const hash=await sha256Hex(value(method,'ticket'));
  const ticket=await db.prepare('SELECT * FROM c_qbd_tickets WHERE ticket_hash=? AND expires>?').bind(hash,Date.now()).first<Data>();
  requireThat(c && ticket,'Connector session expired',403);
  const auth=all(same(c),{sql:'EXISTS(SELECT 1 FROM c_qbd_tickets WHERE ticket_hash=? AND expires>?)',params:[hash,Date.now()]});
  if(name==='sendRequestXML') {
    requireThat(!value(method,'strCompanyFileName') || value(method,'strCompanyFileName').toLowerCase()===c.company.toLowerCase(),'Unexpected QuickBooks company',409);
    requireThat(!ticket.request_id,'The previous request needs its QuickBooks response',409);
    const row=await db.prepare("SELECT * FROM c_qbd_requests WHERE status='pending' ORDER BY CASE WHEN kind LIKE '%Query' THEN 0 ELSE 1 END,created_at,id LIMIT 1").first<Data>();
    if(!row) return soapResult(name,'');
    let content: string;
    try { content=row.kind.endsWith('Query') ? `<${row.kind}Rq requestID="${row.id}"><ActiveStatus>All</ActiveStatus></${row.kind}Rq>` : await renderPosting(db,row); }
    catch(error) {
      const message=(error as Error).message;
      await commit(db,auth,[db.prepare("UPDATE c_qbd_requests SET status='failed',message=? WHERE id=? AND status='pending'").bind(message,row.id),ruleEvent(db,'desktop connector','desktop-sync-error',{}, {request:row.id,message})]);
      return soapResult(name,'');
    }
    await commit(db,all(auth,{sql:"EXISTS(SELECT 1 FROM c_qbd_requests WHERE id=? AND status='pending') AND EXISTS(SELECT 1 FROM c_qbd_tickets WHERE ticket_hash=? AND request_id IS NULL)",params:[row.id,hash]}),[
      db.prepare("UPDATE c_qbd_requests SET status='sent',attempts=attempts+1 WHERE id=?").bind(row.id),db.prepare('UPDATE c_qbd_tickets SET request_id=?,last_request=NULL,last_result=NULL WHERE ticket_hash=?').bind(row.id,hash),
    ]);
    return soapResult(name,escapeXml(qbxml(content)));
  }
  if(name==='receiveResponseXML') {
    const response=value(method,'response'),error=value(method,'message') || value(method,'hresult');
    const document=response ? parseXml(response) : null,rs=document && child(document,'QBXMLMsgsRs')?.children[0];
    if(!ticket.request_id && rs?.attributes.requestID===ticket.last_request) return soapResult(name,String(ticket.last_result));
    requireThat(ticket.request_id,'There is no request awaiting a response',409);
    const row=await db.prepare("SELECT * FROM c_qbd_requests WHERE id=? AND status='sent'").bind(ticket.request_id).first<Data>();
    requireThat(row,'Request changed; reconnect',409);
    requireThat(error || rs && rs.attributes.requestID===row.id && rs.name===row.kind+'Rs','Unexpected QuickBooks response',409);
    const success=!error && rs?.attributes.statusCode==='0',uncertain=!!error;
    const message=error || rs?.attributes.statusMessage || 'QuickBooks response has no status';
    const changes: D1PreparedStatement[]=[];
    let txn='';
    if(success && row.kind.endsWith('Query')) {
      const kind=row.kind.slice(0,-5);
      requireThat(rs && Number(rs.attributes.iteratorRemainingCount ?? 0)===0,'Paginated catalog response needs a continuation',409);
      changes.push(db.prepare('UPDATE c_qbd_catalog SET active=0 WHERE kind=?').bind(kind));
      for(const item of rs!.children.filter(x=>x.name===kind+'Ret')) {
        const id=value(item,'ListID'),label=value(item,'FullName') || value(item,'Name');
        requireThat(id && label,'QuickBooks catalog entry is incomplete',409);
        changes.push(db.prepare('INSERT INTO c_qbd_catalog VALUES(?,?,?,?) ON CONFLICT(kind,list_id) DO UPDATE SET name=excluded.name,active=excluded.active').bind(kind,id,label,value(item,'IsActive')==='false'?0:1));
      }
    } else if(success) {
      txn=value(rs!.children[0] ?? rs!,'TxnID'); requireThat(txn,'Successful posting did not return a transaction id',409);
    }
    changes.push(db.prepare('UPDATE c_qbd_requests SET status=?,message=?,txn_id=?,completed_at=? WHERE id=?').bind(success?'succeeded':uncertain?'uncertain':'failed',success?'':message,txn||null,now(),row.id),
      db.prepare('UPDATE c_qbd_tickets SET request_id=NULL,last_request=?,last_result=1,error=? WHERE ticket_hash=?').bind(row.id,success?'':message,hash),
      ruleEvent(db,'desktop connector',success?'desktop-sync-completed':'desktop-sync-error',{}, {request:row.id,kind:row.kind,message:success?'':message,transaction:txn}));
    await commit(db,all(auth,{sql:"EXISTS(SELECT 1 FROM c_qbd_requests WHERE id=? AND status='sent')",params:[row.id]}),changes);
    // A successful bill can now supply its TxnID to the payment request.
    if(success && row.kind==='BillAdd') await commit(db,auth,await preparePosting(db));
    const pending=await db.prepare("SELECT 1 FROM c_qbd_requests WHERE status='pending'").first();
    const progress=pending?1:100;
    await commit(db,auth,[db.prepare('UPDATE c_qbd_tickets SET last_result=? WHERE ticket_hash=?').bind(progress,hash)]);
    return soapResult(name,String(progress));
  }
  if(name==='getLastError') return soapResult(name,escapeXml(ticket.error||'No error'));
  if(name==='connectionError' || name==='closeConnection') {
    await commit(db,auth,[db.prepare("UPDATE c_qbd_requests SET status='uncertain',message='Connector closed without a response; reconcile in QuickBooks' WHERE id=? AND status='sent'").bind(ticket.request_id??''),db.prepare('DELETE FROM c_qbd_tickets WHERE ticket_hash=?').bind(hash)]);
    return soapResult(name,escapeXml(name==='connectionError'?'done':'Connection closed'));
  }
  requireThat(false,'Unsupported Web Connector method',400);
}
