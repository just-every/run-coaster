import { all, commit, type Sql } from './session';
import { can, needRow, rowAuthority } from './permissions';
import { event } from './events';
import { business, type Business } from './settings';
import { categories } from './items';
import { policies } from './policy';
import { currentWorkflow } from './workflow-configuration';
import { ownerPolicyVersion } from './policy-configuration';
import { email, now, optionalAmount, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export const PRIMARY_ENTITY = 'primary';
export type Entity = { id: string; name: string; currency: string; timezone: string; receipt_threshold_minor: number; preapproval_threshold_minor: number | null; sales_tax_account: string; sales_tax_code: string; fx_enabled: number; version: number };
export async function entity(db: D1Database, id = PRIMARY_ENTITY) {
 const found = await db.prepare('SELECT * FROM c_entities WHERE id=?').bind(id).first<Entity>();
 requireThat(found, 'Legal entity not found', 404);
 return found;
}
export async function entityBusiness(db: D1Database, id = PRIMARY_ENTITY): Promise<Business> {
 const base = await business(db);
 requireThat(base, 'The owner has not set up the business yet', 409);
 if (id === PRIMARY_ENTITY) return { ...base, entity_id: id };
 const found = await entity(db,id);
 return { ...base, ...found, entity_id: id, per_diem_minor: 0, mileage_rates: [], auto_submit: null, pay_weekday: null };
}
export const entityMember = (id: string, address: string): Sql => ({ sql:"(EXISTS(SELECT 1 FROM c_entity_members e JOIN c_members m ON m.email=e.email WHERE e.entity_id=? AND e.email=? AND e.active=1 AND m.active=1) OR (?='primary' AND EXISTS(SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner' AND status='active')))",params:[id,address,id,address] });
export async function requireEntityMember(db: D1Database,id: string,address: string) {
 const guard=entityMember(id,address);
 requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(),'This person is not an active member of the legal entity',403);
 return guard;
}
export async function entities(db:D1Database,actor:Actor) {
 const rows=(await db.prepare('SELECT * FROM c_entities ORDER BY created_at,id').all<Entity>()).results;
 const members=(await db.prepare('SELECT entity_id,email FROM c_entity_members WHERE active=1').all<{entity_id:string;email:string}>()).results;
 return Promise.all(rows.filter(e=>can(actor,'settings')||can(actor,'readAll')||members.some(m=>m.entity_id===e.id&&m.email===actor.email)).map(async e=>({ ...e,
  ...(e.id===PRIMARY_ENTITY?await business(db):{}), members:members.filter(m=>m.entity_id===e.id).map(m=>m.email),
  categories:await categories(db,e.id), workflow:can(actor,'settings')?await currentWorkflow(db,e.id):null,
  policies:can(actor,'policy')?await policies(db,e.id):[],
 })));
}
export async function saveEntity(db:D1Database,actor:Actor,b:Data) {
 needRow(actor,'settings'); requireThat(actor.kind==='person','A native person session is required',403);
 const id=b.id?text(b.id,'Entity',64):uid();
 requireThat(id!==PRIMARY_ENTITY,'Use business settings to change the primary entity',409);
 const previous=b.id?await entity(db,id):null;
 requireThat(!previous||b.version===previous.version,'Entity changed; reload before saving',409);
 const currency=text(b.currency,'Currency',3).toUpperCase(),timezone=text(b.timezone,'Time zone',64);
 requireThat(/^[A-Z]{3}$/.test(currency),'Use a three-letter currency code');
 try { new Intl.DateTimeFormat('en',{timeZone:timezone}); } catch { requireThat(false,'Choose an IANA time zone'); }
 if(previous&&currency!==previous.currency)requireThat(!await db.prepare('SELECT 1 FROM c_claims WHERE entity_id=? LIMIT 1').bind(id).first(),'The entity currency is fixed once claims exist',409);
 requireThat(b.fxEnabled===undefined||typeof b.fxEnabled==='boolean','Currency conversion must be on or off');
 const at=now(),name=text(b.name,'Legal entity name',200),threshold=b.receiptThreshold===undefined?previous?.receipt_threshold_minor??7500:optionalAmount(b.receiptThreshold,'Receipt threshold')??0;
 const preapproval=b.preapprovalThreshold===undefined?previous?.preapproval_threshold_minor??null:optionalAmount(b.preapprovalThreshold,'Spend request needed above');
 const salesAccount=b.salesTaxAccount===undefined?previous?.sales_tax_account??'':optionalText(b.salesTaxAccount,'Sales tax account',40),salesCode=b.salesTaxCode===undefined?previous?.sales_tax_code??'':optionalText(b.salesTaxCode,'Sales tax code',40);
 const guard:Sql=previous?{sql:'EXISTS(SELECT 1 FROM c_entities WHERE id=? AND version=?)',params:[id,previous.version]}:{sql:'NOT EXISTS(SELECT 1 FROM c_entities WHERE id=?)',params:[id]};
 await commit(db,all(rowAuthority(actor,'settings'),guard),[
  db.prepare('INSERT INTO c_entities(id,name,currency,timezone,receipt_threshold_minor,preapproval_threshold_minor,sales_tax_account,sales_tax_code,fx_enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,receipt_threshold_minor=excluded.receipt_threshold_minor,preapproval_threshold_minor=excluded.preapproval_threshold_minor,sales_tax_account=excluded.sales_tax_account,sales_tax_code=excluded.sales_tax_code,fx_enabled=excluded.fx_enabled,version=c_entities.version+1,updated_at=excluded.updated_at').bind(id,name,currency,timezone,threshold,preapproval,salesAccount,salesCode,b.fxEnabled===undefined?previous?.fx_enabled??0:b.fxEnabled?1:0,at,at),
  ...ownerPolicyVersion(db,actor.delegate?.email??actor.email,timezone,at,id),
  event(db,actor,'entity-saved',{}, {entity:id,name,currency,timezone}),
 ]);
 return entity(db,id);
}
export async function saveEntityMember(db:D1Database,actor:Actor,id:string,b:Data) {
 needRow(actor,'people');
 await entity(db,id);const address=email(b.email),active=b.active===false?0:1;
 const ownerAccount=await db.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner'").bind(address).first();
 requireThat(actor.roles.owner||!ownerAccount,'Only the owner changes the owner’s membership',403);
 requireThat(await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1').bind(address).first(),'Choose an active member');
 await commit(db,rowAuthority(actor,'people'),[
  db.prepare('INSERT INTO c_entity_members(entity_id,email,active) VALUES(?,?,?) ON CONFLICT(entity_id,email) DO UPDATE SET active=excluded.active').bind(id,address,active),
  event(db,actor,'entity-membership-saved',{}, {entity:id,member:address,active:!!active}),
 ]); return entities(db,actor);
}
