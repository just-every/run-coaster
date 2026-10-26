import type { Bindings } from '../../auth.server';
import { all, authority, commit, holds, need, sha256Hex, type Sql } from '../session';
import { now, requireThat, uid, type Actor, type Data } from '../types';
import { normalizeInbound } from './mail-parser.mjs';
import { mailReceiptFiles } from './mail-content';
import { originalBytes, receiptBucket, storeReceipt } from './storage';
import { isCommentReply, recognizeCommentReply } from '../comment-email';

const LIMIT=25_000_000;
const ownerQuery=`SELECT m.email FROM c_members m WHERE m.active=1 AND (${holds('employee','m')} OR EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.role='owner' AND o.status='active')) AND NOT EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.status<>'active') AND (m.email=? OR EXISTS(SELECT 1 FROM c_receipt_mail_aliases a WHERE a.owner_email=m.email AND a.email=? AND a.confirmed_at IS NOT NULL))`;
async function rawBytes(message:ForwardableEmailMessage) {
 requireThat(message.rawSize>0&&message.rawSize<=LIMIT,'Receipt email exceeds 25 MB',413);
 const reader=message.raw.getReader(),chunks:Uint8Array[]=[];let length=0;
 try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>LIMIT){await reader.cancel();throw new Error('Receipt email exceeds 25 MB');}chunks.push(part.value);}}
 finally {reader.releaseLock();}
 requireThat(length===message.rawSize,'Email size does not match its original');
 const bytes=new Uint8Array(length);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}return bytes;
}
/** This entry is called only by the platform email event, never by an HTTP route. */
export async function receiveEmail(message:ForwardableEmailMessage,env:Bindings) {
 const db=env.DB,settings=await db.prepare('SELECT address,version FROM c_receipt_mail_settings WHERE id=1').first<{address:string;version:number}>();
 if(!settings||message.to.toLowerCase()!==settings.address){message.setReject('Receipt address is not enabled');return;}
 const bytes=await rawBytes(message),hash=await sha256Hex(bytes),bucket=receiptBucket(env.COASTER_RECEIPTS);
 const existing=await db.prepare('SELECT id FROM c_receipt_mail_messages WHERE sha256=?').bind(hash).first<{id:string}>();
 const sender=message.from.toLowerCase(),owners=(await db.prepare(ownerQuery).bind(sender,sender).all<{email:string}>()).results,owner=owners.length===1?owners[0]:null;
 let subject='',reason=owner?'':'Unknown sender; no inbox assignment',files:Awaited<ReturnType<typeof mailReceiptFiles>>=[],parsed:Awaited<ReturnType<typeof normalizeInbound>>|null=null,reply=false;
 try {
  parsed=await normalizeInbound({provider:'cloudflare',message:{from:sender,to:message.to,headers:message.headers,raw:new Blob([bytes]).stream(),rawSize:bytes.length}},{maxRawBytes:LIMIT,maxBodyBytes:1_000_000,maxAttachments:30,maxAttachmentBytes:10_000_000,maxTotalAttachmentBytes:20_000_000});
  subject=parsed.subject;
  reply=isCommentReply(parsed);
  if(owner&&!reply&&!existing)files=await mailReceiptFiles(parsed);
 } catch {reason=owner?'Receipt content could not be read; source held without assignment':reason;}
 if(existing)return;
 if(reply&&parsed){
  const answer=await recognizeCommentReply(db,env,{messageHash:hash,sender,recipient:message.to,message:parsed});
  if(answer.matched&&answer.status==='accepted')return;
 }
 if(reply)reason='Email question reply retained without receipt assignment';
 if(owner&&!files.length)reason=reason||'No supported receipt content; source held without assignment';
 const employee=reason?null:owner!.email,id=uid(),at=now(),key=`receipt-mail/${id}/${hash}`;
 const uploaded:string[]=[],writes:D1PreparedStatement[]=[];
 const configuration:Sql={sql:'EXISTS(SELECT 1 FROM c_receipt_mail_settings WHERE id=1 AND address=? AND version=?)',params:[settings.address,settings.version]};
 const identity:Sql=employee?{sql:`(SELECT COUNT(*) FROM (${ownerQuery}))=1 AND EXISTS(${ownerQuery} AND m.email=?)`,params:[sender,sender,sender,sender,employee]}:{sql:'1',params:[]};
 try {
  await storeReceipt(bucket,key,bytes,'message/rfc822',hash);uploaded.push(key);
  writes.push(db.prepare('INSERT INTO c_receipt_mail_messages(id,sha256,object_key,size,sender,recipient,subject,owner_email,received_at,held_reason) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,hash,key,bytes.length,sender,settings.address,subject,employee,at,reason));
  for(const file of employee?files:[]){
   const receiptId=uid(),digest=await sha256Hex(file.bytes),objectKey=`receipt-inbox/${receiptId}/${digest}`;
   await storeReceipt(bucket,objectKey,file.bytes,file.mediaType,digest);uploaded.push(objectKey);
   writes.push(db.prepare("INSERT INTO c_capture_receipts(id,owner_email,name,media_type,size,sha256,object_key,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,'upload',?,?)").bind(receiptId,employee,file.name,file.mediaType,file.bytes.length,digest,objectKey,'automation: email intake',at),
    db.prepare('INSERT INTO c_receipt_mail_sources(receipt_id,message_id,origin) VALUES(?,?,?)').bind(receiptId,id,file.origin));
   for(const [sequence,state,reason] of [[1,'received',''],[2,'needs-attention','Forwarded original retained. Enter details or explicitly choose receipt reading.']] as const)
    writes.push(db.prepare("INSERT INTO c_capture_receipt_events(receipt_id,sequence,state,reason,at,actor_email,on_behalf_of,channel) VALUES(?,?,?,?,?,'automation: email intake',?,'app')").bind(receiptId,sequence,state,reason,at,employee));
  }
  await commit(db,all({sql:`(${configuration.sql}) AND (${identity.sql})`,params:[...configuration.params,...identity.params]}, {sql:'NOT EXISTS(SELECT 1 FROM c_receipt_mail_messages WHERE sha256=?)',params:[hash]}),writes);
 } catch(error){
  const saved=await db.prepare('SELECT id FROM c_receipt_mail_messages WHERE sha256=?').bind(hash).first<{id:string}>();
  if(saved?.id!==id)await Promise.all(uploaded.map(objectKey=>bucket.delete(objectKey)));
  if(!saved)throw error;
 }
}
export async function receiptEmailSource(db:D1Database,bucket:R2Bucket|undefined,a:Actor,id:string,held=false) {
 requireThat(a.kind==='person'&&!a.publicCredential,'Use a native session to download source mail',403);
 need(a,held?'owner':'employee');if(held)requireThat(!a.delegate,'Owner native session required',403);
 const row=held?await db.prepare('SELECT * FROM c_receipt_mail_messages WHERE id=? AND owner_email IS NULL').bind(id).first<Data>():await db.prepare('SELECT m.* FROM c_receipt_mail_messages m JOIN c_receipt_mail_sources s ON s.message_id=m.id JOIN c_capture_receipts r ON r.id=s.receipt_id WHERE r.id=? AND r.owner_email=?').bind(id,a.email).first<Data>();
 requireThat(row,'Source message not found',404);
 const bytes=await originalBytes(receiptBucket(bucket),row as {object_key:string;sha256:string;size:number});
 return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="source-message.eml"','content-security-policy':"default-src 'none'; sandbox",'x-content-type-options':'nosniff','cache-control':'private, no-store'}});
}
