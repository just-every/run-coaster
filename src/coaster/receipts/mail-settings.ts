import type { Bindings } from '../../auth.server';
import { operatorMail } from '../../mail.server.mjs';
import { event } from '../events';
import { all, authority, commit, need, sha256Hex } from '../session';
import { email, now, requireThat, uid, type Actor, type Data } from '../types';

function ownSession(a:Actor) {
 need(a,'employee');
 requireThat(a.kind==='person'&&!a.delegate&&!a.publicCredential,'Use your own native session for receipt email settings',403);
}
export async function receiptEmailSettings(db:D1Database,a:Actor) {
 need(a,'employee');requireThat(a.kind==='person'&&!a.publicCredential,'Use a native employee session',403);
 const settings=await db.prepare('SELECT address FROM c_receipt_mail_settings WHERE id=1').first<{address:string}>();
 const aliases=a.delegate?[]:(await db.prepare('SELECT email,confirmed_at IS NOT NULL AS confirmed FROM c_receipt_mail_aliases WHERE owner_email=? ORDER BY email').bind(a.email).all<{email:string;confirmed:number}>()).results;
 const held=a.roles.owner&&!a.delegate?(await db.prepare('SELECT id,sender AS "from",subject,received_at AS receivedAt,held_reason AS reason FROM c_receipt_mail_messages WHERE owner_email IS NULL ORDER BY received_at DESC LIMIT 100').all<Data>()).results:[];
 return {address:settings?.address??null,owner:a.roles.owner&&!a.delegate,aliases:aliases.map(v=>({...v,confirmed:v.confirmed===1})),held:held.map(v=>({...v,sourceUrl:`/api/coaster/settings/receipt-email/held/${v.id}`}))};
}
export async function saveReceiptEmail(db:D1Database,a:Actor,b:Data) {
 ownSession(a);need(a,'owner');
 requireThat(b.consent===true&&Object.keys(b).every(k=>['address','consent'].includes(k)),'Confirm private receipt-mail storage');
 const address=email(b.address);
 await commit(db,authority(a,'owner'),[db.prepare('INSERT INTO c_receipt_mail_settings(id,address,version,consent_at,set_by) VALUES(1,?,1,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,version=version+1,consent_at=excluded.consent_at,set_by=excluded.set_by').bind(address,now(),a.email),event(db,a,'receipt-email-configured',{}, {consent:true})]);
 return receiptEmailSettings(db,a);
}
export async function requestReceiptAlias(env:Bindings,a:Actor,b:Data) {
 ownSession(a);const address=email(b.email);
 requireThat(Object.keys(b).every(k=>k==='email'),'Supply only the alias address');
 const db=env.DB,existing=await db.prepare('SELECT owner_email,requested_at FROM c_receipt_mail_aliases WHERE email=?').bind(address).first<{owner_email:string;requested_at:string}>();
 requireThat(!existing||existing.owner_email===a.email,'Address unavailable',409);
 requireThat(!existing||Date.now()-Date.parse(existing.requested_at)>60_000,'Wait a minute before requesting another proof',429);
 requireThat(!await db.prepare('SELECT email FROM c_members WHERE email=? AND email<>?').bind(address,a.email).first(),'Address unavailable',409);
 const mail=operatorMail(env);requireThat(mail,'Set up installation email before confirming an alias',409);
 const code=uid(),hash=await sha256Hex(code),at=now(),expires=new Date(Date.now()+15*60_000).toISOString();
 await commit(db,all(authority(a,'employee'),{sql:'NOT EXISTS(SELECT 1 FROM c_receipt_mail_aliases WHERE email=? AND owner_email<>?)',params:[address,a.email]}),[db.prepare('INSERT INTO c_receipt_mail_aliases(email,owner_email,proof_hash,expires_at,confirmed_at,requested_at) VALUES(?,?,?,?,NULL,?) ON CONFLICT(email) DO UPDATE SET proof_hash=excluded.proof_hash,expires_at=excluded.expires_at,confirmed_at=NULL,requested_at=excluded.requested_at').bind(address,a.email,hash,expires,at)]);
 const words=`Confirm this address for your Coaster receipt inbox by entering this one-time code in Settings: ${code}\nThis expires in 15 minutes. If you did not request it, ignore this email.`;
 const sent=await mail.send({deliveryId:uid(),from:env.MAIL_FROM??'',to:[address],subject:'Confirm your Coaster receipt address',text:words,html:`<p>${words}</p>`,headers:{}});
 requireThat(sent.status==='accepted','Proof email was not sent; check installation mail settings',409);
 return {sent:true};
}
export async function confirmReceiptAlias(db:D1Database,a:Actor,b:Data) {
 ownSession(a);const address=email(b.email);
 requireThat(Object.keys(b).every(k=>['email','code'].includes(k))&&typeof b.code==='string'&&b.code.length<=100,'Enter the emailed proof code');
 const hash=await sha256Hex(b.code),at=now();
 await commit(db,all(authority(a,'employee'),{sql:'EXISTS(SELECT 1 FROM c_receipt_mail_aliases WHERE email=? AND owner_email=? AND proof_hash=? AND expires_at>? AND confirmed_at IS NULL)',params:[address,a.email,hash,at]}),[db.prepare("UPDATE c_receipt_mail_aliases SET confirmed_at=?,proof_hash='' WHERE email=? AND owner_email=?").bind(at,address,a.email)]);
 return {confirmed:true};
}
export async function removeReceiptAlias(db:D1Database,a:Actor,b:Data) {
 ownSession(a);const address=email(b.email);
 await commit(db,authority(a,'employee'),[db.prepare('DELETE FROM c_receipt_mail_aliases WHERE email=? AND owner_email=?').bind(address,a.email)]);
 return {removed:true};
}
