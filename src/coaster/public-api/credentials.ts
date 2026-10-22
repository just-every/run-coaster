import type { Bindings } from '../../auth.server';
import { authority, all, commit, rolesFrom, sha256Hex } from '../session';
import { event } from '../events';
import { can } from '../permissions';
import { now, requireThat, text, uid, type Actor, type Data } from '../types';

export const SCOPES = ['expenses:read','expenses:write','receipts:read','receipts:write','claims:read','claims:write','cards:read','batches:read','payments:read','people:read','reports:read'] as const;
export { accessSnapshot, liveIdentity } from './identity';
import { accessSnapshot, liveIdentity } from './identity';
export const randomSecret = (prefix: string) => prefix + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export function nativeOwner(a: Actor) { requireThat(a.kind === 'person' && !a.delegate && !a.publicCredential && a.roles.owner, 'The owner must consent with their own native session', 403); }
export function scopesFor(a: Actor, input: unknown): string[] {
  requireThat(Array.isArray(input) && input.length > 0 && input.length <= SCOPES.length && input.every(x => typeof x === 'string' && (SCOPES as readonly string[]).includes(x)), 'Choose known, explicit API scopes');
  const scopes = [...new Set(input as string[])].sort();
  for (const s of scopes) {
    const resource = s.split(':')[0];
    if (s.endsWith(':write')) requireThat(a.roles.employee, 'Submit access required', 403);
    if (resource === 'cards') requireThat(can(a,'readAll') || a.roles.cardAdmin, 'Card spend access required', 403);
    if (resource === 'batches' || resource === 'payments') requireThat(can(a,'readAll'), 'Batch read access required', 403);
    if (resource === 'reports') requireThat(can(a,'exportFiles') || a.roles.manager, 'Report access required', 403);
  }
  return scopes;
}
export async function snapshot(db: D1Database, email: string) {
  const row = await db.prepare(`SELECT ${accessSnapshot()} AS snapshot ${liveIdentity}`).bind(email).first<{snapshot:string}>();
  requireThat(row, 'Active Coaster membership and sign-in account required', 403); return row.snapshot;
}
export function identityStill(email: string, value: string) { return { sql: `EXISTS(SELECT 1 ${liveIdentity} AND ${accessSnapshot()}=?)`, params:[email,value] }; }
export async function createKey(db: D1Database, a: Actor, b: Data) {
  nativeOwner(a);
  requireThat(b.member === undefined || b.member === a.email, 'API credentials are bound to the consenting owner', 403);
  const scopes=scopesFor(a,b.scopes), days=b.expiresInDays ?? 30;
  requireThat(Number.isInteger(days) && days>=1 && days<=90,'Key expiry must be 1 to 90 days');
  const id=uid(), token=randomSecret('cpa_'), label=text(b.label,'API key label',80), access=await snapshot(db,a.email), expiresAt=Date.now()+days*86400000;
  await commit(db,all(authority(a,'owner'),identityStill(a.email,access)),[
    db.prepare('INSERT INTO c_public_keys(id,member_email,label,token_hash,scopes,access_snapshot,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,a.email,label,await sha256Hex(token),JSON.stringify(scopes),access,expiresAt,now()),
    event(db,a,'public-api-key-created',{}, {key:id,label,scopes,expiresAt}),
  ]);
  return {id,label,scopes,expiresAt,token};
}
export async function revokeKey(db:D1Database,a:Actor,id:string) {
  nativeOwner(a);
  requireThat(await db.prepare('SELECT 1 FROM c_public_keys WHERE id=?').bind(id).first(),'API key not found',404);
  await commit(db,authority(a,'owner'),[db.prepare('UPDATE c_public_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now(),id),event(db,a,'public-api-key-revoked',{}, {key:id})]);
  return {id};
}
export async function authenticate(request:Request,env:Bindings,scope:string):Promise<Actor> {
  requireThat(new URL(request.url).origin===env.AUTH_ORIGIN,'Invalid host',403);
  requireThat(!request.headers.has('x-coaster-acting-for') && !new URL(request.url).searchParams.has('actingFor'),'API credentials cannot delegate',403);
  const token=request.headers.get('authorization')?.match(/^Bearer (cpa_[A-Za-z0-9_-]{43})$/)?.[1];
  requireThat(token,'Public API bearer credential required',401);
  const k=await env.DB.prepare(`SELECT k.*,m.*,o.role AS operator_role FROM c_public_keys k JOIN c_members m ON m.email=k.member_email JOIN oa_operators o ON lower(o.email)=m.email WHERE k.token_hash=? AND k.revoked_at IS NULL AND k.expires_at>unixepoch()*1000 AND m.active=1 AND o.status='active' AND ${accessSnapshot()}=k.access_snapshot AND (k.oauth_client IS NULL OR EXISTS(SELECT 1 FROM c_public_oauth_clients cl WHERE cl.id=k.oauth_client AND cl.revoked_at IS NULL))`).bind(await sha256Hex(token)).first<Data>();
  requireThat(k,'API credential expired, revoked or access changed',401);
  const scopes=JSON.parse(k.scopes) as string[];
  requireThat(scopes.includes(scope),'API scope required: '+scope,403);
  const actor:Actor={kind:'person',email:k.member_email,name:k.name,roles:rolesFrom(k,k.operator_role==='owner'),publicCredential:{id:k.id,scope,scopes:k.scopes}};
  scopesFor(actor,[scope]);
  return actor;
}
