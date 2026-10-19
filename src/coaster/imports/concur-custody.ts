import { sourceIdentity } from '../../modules/import-kit/src/provenance/identity';
import type { SourceBundle } from '../../modules/import-kit/src/d1/index';
import { requireThat, type Data } from '../types';

/** ct 19 Oct 13:17Z: refuse bank/full card data before originals or plans can persist.
 * Known SAE fields plus named columns; values are never included in the refusal. */
export function refuseConcurFinancialData(rows: string[][], headers: string[], positional: boolean) {
  const sensitive = /(?:bank|banking|routing|iban|swift|bic|account\s*(?:number|no\b)|(?:credit\s*)?card\s*(?:number|account))/i;
  const safe = /(?:last\s*(?:four|4)|token)/i;
  const positions = positional ? [16,17,130,154,...Array.from({length:20},(_,i)=>291+i)].map(n=>n-1) : headers.flatMap((h,i)=>sensitive.test(h.replace(/[_-]/g,' '))&&!safe.test(h.replace(/[_-]/g,' '))?[i]:[]);
  requireThat(!rows.some(row=>positions.some(i=>Boolean(row[i]?.trim()))), 'This export contains banking or full card-account fields. Export without banking fields or full card numbers, then preview again. Nothing was retained.');
}
/** Translated configuration is a strict envelope; financial columns cannot hide among unknown configuration fields. */
export function refuseConcurConfigurationData(value: unknown) {
  const visit=(v:unknown):void=>{if(Array.isArray(v)){v.forEach(visit);return;}if(!v||typeof v!=='object')return;for(const [key,field] of Object.entries(v as Data)){if(/(?:bank|routing|iban|swift|account.?number|card.?number)/i.test(key)&&!/last.?4|last.?four|token/i.test(key))requireThat(field===null||field==='', 'Export the Concur configuration without banking fields or full card numbers. Nothing was retained.');visit(field);}};visit(value);
}

/** Erased source identities cannot be admitted again, even after the old job was undone. */
export async function refuseErasedConcurSource(db: D1Database, source: SourceBundle) {
  const identities = source.records.map(r => sourceIdentity('main', r.namespace, r.kind, r.sourceId));
  const retired = await db.prepare("SELECT 1 FROM ik_d1_erased_sources WHERE destination='main' AND identity IN (SELECT value FROM json_each(?)) LIMIT 1").bind(JSON.stringify(identities)).first();
  requireThat(!retired, 'This Concur source contains erased records and cannot be imported again', 409);
}
