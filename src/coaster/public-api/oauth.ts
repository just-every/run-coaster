import { all, authority, commit, sha256Hex } from '../session';
import { event } from '../events';
import { now, requireThat, text, uid, type Actor, type Data } from '../types';
import { identityStill, nativeOwner, randomSecret, scopesFor, snapshot } from './credentials';

export async function registerClient(db:D1Database,a:Actor,b:Data) {
  nativeOwner(a);
  const label=text(b.label,'Application label',80), redirect=text(b.redirectUri,'Redirect URI',2000);
  let uri:URL; try { uri=new URL(redirect); } catch { requireThat(false,'Invalid redirect URI'); }
  requireThat(uri.protocol==='https:' && !uri.username && !uri.password && !uri.hash && uri.href===redirect,'Register an exact HTTPS redirect URI without credentials or fragment');
  const id=uid();
  await commit(db,authority(a,'owner'),[db.prepare('INSERT INTO c_public_oauth_clients(id,label,redirect_uri,created_by,created_at) VALUES(?,?,?,?,?)').bind(id,label,redirect,a.email,now()),event(db,a,'public-oauth-client-registered',{}, {client:id,label,redirectUri:redirect})]);
  return {client_id:id,redirect_uri:redirect};
}
export async function revokeClient(db:D1Database,a:Actor,id:string) {
  nativeOwner(a);
  requireThat(await db.prepare('SELECT 1 FROM c_public_oauth_clients WHERE id=?').bind(id).first(),'OAuth client not found',404);
  await commit(db,authority(a,'owner'),[db.prepare('UPDATE c_public_oauth_clients SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now(),id),event(db,a,'public-oauth-client-revoked',{}, {client:id})]);
  return {id};
}
/** Consent is an explicit owner POST with native same-origin session; no silent authorization GET exists. */
export async function authorize(db:D1Database,a:Actor,b:Data) {
  nativeOwner(a);
  requireThat(b.consent===true && b.response_type==='code' && b.code_challenge_method==='S256','Explicit consent, authorization code and PKCE S256 required');
  const client=await db.prepare('SELECT * FROM c_public_oauth_clients WHERE id=? AND revoked_at IS NULL').bind(text(b.client_id,'Client ID',80)).first<Data>();
  requireThat(client && b.redirect_uri===client.redirect_uri,'Unregistered redirect URI',400);
  const challenge=text(b.code_challenge,'PKCE challenge',43); requireThat(/^[A-Za-z0-9_-]{43}$/.test(challenge),'Invalid PKCE S256 challenge');
  const state=text(b.state,'OAuth state',500), scopes=scopesFor(a,b.scopes), access=await snapshot(db,a.email), code=randomSecret('cpc_'), expiresAt=Date.now()+300000;
  await commit(db,all(authority(a,'owner'),identityStill(a.email,access),{sql:'EXISTS(SELECT 1 FROM c_public_oauth_clients WHERE id=? AND revoked_at IS NULL)',params:[client.id]}),[
    db.prepare('INSERT INTO c_public_oauth_codes(code_hash,client_id,member_email,scopes,access_snapshot,challenge,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(await sha256Hex(code),client.id,a.email,JSON.stringify(scopes),access,challenge,expiresAt,now()),
    event(db,a,'public-oauth-consented',{}, {client:client.id,scopes,expiresAt}),
  ]);
  const redirect=new URL(client.redirect_uri); redirect.searchParams.set('code',code);redirect.searchParams.set('state',state);
  return {redirect_uri:redirect.href,expires_in:300};
}
export async function exchange(db:D1Database,b:Data) {
  requireThat(b.grant_type==='authorization_code','Only authorization_code is supported');
  const verifier=text(b.code_verifier,'PKCE verifier',128);requireThat(/^[A-Za-z0-9._~-]{43,128}$/.test(verifier),'Invalid PKCE verifier');
  const hash=await sha256Hex(text(b.code,'Authorization code',80));
  const row=await db.prepare('SELECT c.*,cl.redirect_uri,cl.label FROM c_public_oauth_codes c JOIN c_public_oauth_clients cl ON cl.id=c.client_id AND cl.revoked_at IS NULL WHERE c.code_hash=? AND c.consumed_at IS NULL AND c.expires_at>unixepoch()*1000').bind(hash).first<Data>();
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const challenge=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  requireThat(row && row.client_id===b.client_id && row.redirect_uri===b.redirect_uri && challenge===row.challenge,'Invalid authorization grant',400);
  const token=randomSecret('cpa_'),id=uid(), expiresAt=Date.now()+3600000;
  const condition={sql:`EXISTS(SELECT 1 FROM c_public_oauth_codes c JOIN c_public_oauth_clients cl ON cl.id=c.client_id AND cl.revoked_at IS NULL WHERE c.code_hash=? AND c.consumed_at IS NULL AND c.expires_at>unixepoch()*1000)`,params:[hash]};
  const personLive=identityStill(row.member_email,row.access_snapshot);
  const live={sql:`(${personLive.sql}) AND EXISTS(SELECT 1 FROM c_public_oauth_clients WHERE id=? AND revoked_at IS NULL)`,params:[...personLive.params,row.client_id]};
  await commit(db,{...all(live,condition),after:live},[
    db.prepare('UPDATE c_public_oauth_codes SET consumed_at=? WHERE code_hash=?').bind(now(),hash),
    db.prepare('INSERT INTO c_public_keys(id,member_email,label,token_hash,scopes,access_snapshot,expires_at,created_at,oauth_client) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,row.member_email,row.label,await sha256Hex(token),row.scopes,row.access_snapshot,expiresAt,now(),row.client_id),
    db.prepare('INSERT INTO c_events(id,seq,at,actor_email,action,detail) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM c_events),?,?,?,?)').bind(uid(),now(),row.member_email,'public-oauth-token-issued',JSON.stringify({client:row.client_id,key:id,channel:'public-api'})),
  ]);
  return {access_token:token,token_type:'Bearer',expires_in:3600,scope:JSON.parse(row.scopes).join(' ')};
}
