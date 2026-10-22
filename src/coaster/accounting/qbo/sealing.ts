import { Fault } from '../../types';
import type { QboBindings, Tokens } from './model';

const encoder = new TextEncoder();
const bytes = (v: Uint8Array) => btoa(String.fromCharCode(...v));
async function key(env: QboBindings) {
  const source = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(env.AUTH_ORIGIN), info: encoder.encode('Coaster QuickBooks credentials v1') }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealTokens(env: QboBindings, company: string, tokens: Tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(company) }, await key(env), encoder.encode(JSON.stringify(tokens)));
  return JSON.stringify({ v: 1, iv: bytes(iv), data: bytes(new Uint8Array(encrypted)) });
}
export async function openTokens(env: QboBindings, company: string, sealed: string): Promise<Tokens> {
  try {
    const envelope = JSON.parse(sealed);
    if (envelope.v !== 1) throw new Error();
    const from = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from(envelope.iv), additionalData: encoder.encode(company) }, await key(env), from(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Fault(409, 'QuickBooks credentials cannot be opened; reconnect this company'); }
}
