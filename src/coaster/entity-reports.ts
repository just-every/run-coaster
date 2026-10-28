import { all, authority, commit } from './session';
import { can, rowAuthority } from './permissions';
import { event } from './events';
import { entity, entityBusiness } from './entities';
import { createFx } from './fx';
import { spendLines } from './spend-lines';
import { isoDate, now, requireThat, uid, type Actor, type Data } from './types';

function reportAccess(actor:Actor) {
 requireThat(actor.kind==='person'&&can(actor,'readAll'),'Consolidated reports require current installation-wide reporting access',403);
}
/** A report retains the exact per-line conversion and only the submitted evidence already shared with finance. */
export async function consolidate(db:D1Database,actor:Actor,b:Data) {
 reportAccess(actor);
 const from=isoDate(b.from,'From'),to=isoDate(b.to,'Until');
 requireThat(to>=from,'The report period must end on or after it starts');
 const settings=await entityBusiness(db),currency=b.currency===undefined?settings.currency:String(b.currency).toUpperCase();
 requireThat(/^[A-Z]{3}$/.test(currency),'Use a three-letter reporting currency');
 const convert=createFx(!!settings.fx_enabled,currency),lines:Data[]=[];
 for(const line of await spendLines(db,from,to,{sql:'',params:[]})) {
  const source=await entity(db,line.entity);
  const fx=await convert(line.amountMinor,line.currency,line.date);
  const {employee,employeeName,...financial}=line;
  lines.push({...financial,entityName:source.name,nativeMinor:line.amountMinor,amountMinor:fx.amount_minor,fx_rate:fx.fx_rate,fx_date:fx.fx_date,fx_source:fx.fx_source||'native currency'});
 }
 const id=uid(),at=now(),totalMinor=lines.reduce((n,l)=>n+l.amountMinor,0);
 requireThat(Number.isSafeInteger(totalMinor),'The report total is too large');
 const snapshot={id,from,to,currency,totalMinor,lines,createdAt:at};
 await commit(db,rowAuthority(actor,'readAll'),[
  db.prepare('INSERT INTO c_entity_reports(id,created_by,created_at,snapshot) VALUES(?,?,?,?)').bind(id,actor.delegate?.email??actor.email,at,JSON.stringify(snapshot)),
  event(db,actor,'consolidated-report-created',{}, {report:id,from,to,currency,totalMinor,lines:lines.length}),
 ]);
 return snapshot;
}
export async function consolidatedReport(db:D1Database,actor:Actor,id:string) {
 reportAccess(actor);
 const row=await db.prepare('SELECT snapshot FROM c_entity_reports WHERE id=?').bind(id).first<{snapshot:string}>();
 requireThat(row,'Consolidated report not found',404);
 return JSON.parse(row.snapshot);
}
