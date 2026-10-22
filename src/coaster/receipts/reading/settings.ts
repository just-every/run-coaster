import { MATCH_NOTICE } from '../match-notice';
import { all, commit, authority } from '../../session';
import { needRow, rowAuthority } from '../../permissions';
import { event } from '../../events';
import { now, requireThat, type Actor, type Data } from '../../types';
export const DEFAULT_READER_MODEL='gpt-4.1-2025-04-14';
export const READING_CONSENT='Send this receipt original to the installation AI provider to read its fields and prepare coding suggestions. The original stays private until its expense is submitted. Reading does not choose card matching.';
export type ReadingSettings={version:number;enabled:number;threshold:number;model:string;set_by:string;set_at:string};
export const currentSettings=(db:D1Database)=>db.prepare('SELECT * FROM c_receipt_reading_settings ORDER BY version DESC LIMIT 1').first<ReadingSettings>();
export const settingsStill=(version:number)=>({sql:'(SELECT MAX(version) FROM c_receipt_reading_settings)=?',params:[version]});
export async function readingSettings(db:D1Database,a:Actor) {
  requireThat(a.kind==='person'&&!a.publicCredential,'A native session is required',403);
  const s=(await currentSettings(db))!;
  return {version:s.version,enabled:!!s.enabled,threshold:s.threshold,model:s.model||DEFAULT_READER_MODEL,consentNotice:READING_CONSENT};
}
export async function saveReadingSettings(db:D1Database,a:Actor,b:Data) {
  requireThat(a.kind==='person'&&!a.publicCredential&&!a.delegate,'A native owner or admin must consent to external receipt processing',403);needRow(a,'settings');
  requireThat(Object.keys(b).every(k=>['version','enabled','threshold','model','consent'].includes(k))&&typeof b.enabled==='boolean','Choose reading on or off');
  requireThat(!b.enabled||b.consent===true,'Explicit consent to external receipt processing is required');
  const s=(await currentSettings(db))!,threshold=b.threshold??s.threshold,model=b.model??(s.model||DEFAULT_READER_MODEL);
  requireThat(b.version===s.version,'Reload the current reader settings',409);
  requireThat(typeof threshold==='number'&&Number.isFinite(threshold)&&threshold>=0.9&&threshold<=1,'Reader confidence threshold must be between 0.90 and 1');
  requireThat(typeof model==='string'&&/^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,119}$/.test(model),'Choose an exact vision-capable AI model');
  await commit(db,all(rowAuthority(a,'settings'),settingsStill(s.version)),[
    db.prepare('INSERT INTO c_receipt_reading_settings(version,enabled,threshold,model,set_by,set_at) VALUES(?,?,?,?,?,?)').bind(s.version+1,b.enabled?1:0,threshold,model,a.email,now()),
    event(db,a,b.enabled?'receipt-reading-enabled':'receipt-reading-disabled',{}, {version:s.version+1,threshold,model,externalProcessingConsent:b.enabled}),
  ]);
  return readingSettings(db,a);
}
/** Standing matching choice belongs to the employee themselves; no delegate or role-only administrator can grant it. */
export async function setReadingMatchDefault(db:D1Database,a:Actor,b:Data) {
  requireThat(a.kind==='person'&&!a.publicCredential&&!a.delegate&&a.roles.employee,'Only the employee themselves chooses their standing matching consent',403);
  requireThat(Object.keys(b).every(k=>['version','enabled','consent','notice'].includes(k))&&typeof b.enabled==='boolean'&&(!b.enabled||b.consent===true&&b.notice===MATCH_NOTICE),'Explicit matching consent and acknowledgement of the sharing notice are required');
  const current=await db.prepare('SELECT version FROM c_receipt_reading_match_defaults WHERE employee_email=? ORDER BY version DESC LIMIT 1').bind(a.email).first<{version:number}>();
  requireThat(b.version===(current?.version??0),'Reload the current standing matching choice',409);
  await commit(db,all(authority(a,'employee'),{sql:'(SELECT COALESCE(MAX(version),0) FROM c_receipt_reading_match_defaults WHERE employee_email=?)=?',params:[a.email,b.version]}),[
    db.prepare('INSERT INTO c_receipt_reading_match_defaults(employee_email,version,enabled,set_at) VALUES(?,?,?,?)').bind(a.email,b.version+1,b.enabled?1:0,now()),
  ]);return {version:b.version+1,enabled:b.enabled};
}
