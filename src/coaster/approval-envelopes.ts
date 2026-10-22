import { all, authority, commit, need } from './session';
import { event } from './events';
import { now, optionalAmount, requireThat, type Actor, type Data } from './types';

export type Envelope={version:number;enabled:number;limit_minor:number|null;set_by:string;set_at:string};
export const currentEnvelope=(db:D1Database)=>db.prepare('SELECT * FROM c_approval_envelopes ORDER BY version DESC LIMIT 1').first<Envelope>();
export const envelopeStill=(version:number)=>({sql:'COALESCE((SELECT MAX(version) FROM c_approval_envelopes),0)=?',params:[version]});
/** A native owner explicitly grants authority; keys, admins and Full delegates do not. */
export async function saveEnvelope(db:D1Database,a:Actor,b:Data){
 need(a,'owner');requireThat(a.kind==='person'&&!a.delegate&&!a.publicCredential,'Only the native owner grants or revokes the policy agent envelope',403);
 requireThat(Object.keys(b).every(k=>['version','enabled','limit','consent'].includes(k))&&typeof b.enabled==='boolean','Choose the policy agent envelope on or off');
 requireThat(!b.enabled||b.consent===true,'Explicit consent to approvals on the owner’s behalf is required');
 const prior=await currentEnvelope(db),version=(prior?.version??0)+1,limit=optionalAmount(b.limit,'Every expense under');
 requireThat(b.version===version-1,'The envelope changed; reload before granting authority',409);
 requireThat(!b.enabled||limit!==null&&limit>0,'Set a positive compliant-spend limit');
 await commit(db,all(authority(a,'owner'),envelopeStill(version-1)),[
  db.prepare('INSERT INTO c_approval_envelopes(version,enabled,limit_minor,set_by,set_at) VALUES(?,?,?,?,?)').bind(version,b.enabled?1:0,b.enabled?limit:null,a.email,now()),
  event(db,a,b.enabled?'policy-agent-envelope-granted':'policy-agent-envelope-revoked',{}, {version,limitMinor:b.enabled?limit:null,explicitConsent:b.enabled}),
 ]);
 return currentEnvelope(db);
}
