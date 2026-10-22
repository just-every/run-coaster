import type { Bindings } from '../../auth.server';
import { Fault } from '../types';
import type { SftpCredentials } from './transport';

const encoder = new TextEncoder();
async function key(env: Bindings) {
  const source = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name:'HKDF',hash:'SHA-256',salt:encoder.encode(env.AUTH_ORIGIN),info:encoder.encode('Coaster SFTP credentials v1') },source,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function seal(env: Bindings, id: string, credentials: SftpCredentials) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(id)},await key(env),encoder.encode(JSON.stringify(credentials)));
  return JSON.stringify({iv:btoa(String.fromCharCode(...iv)),data:btoa(String.fromCharCode(...new Uint8Array(encrypted)))});
}
export async function unseal(env: Bindings, id: string, value: string): Promise<SftpCredentials> {
  try {
    const row=JSON.parse(value),bytes=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(row.iv),additionalData:encoder.encode(id)},await key(env),bytes(row.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Fault(409,'SFTP credentials cannot be opened; disconnect and connect this feed again'); }
}
