import { authority, commit, need } from './session';
import { event } from './events';
import { amount, email, now, optionalAmount, requireThat, text, uid, type Actor, type Data } from './types';

export type Business = { name: string; currency: string; timezone: string; mileage_rate_minor: number; per_diem_minor: number; receipt_threshold_minor: number };

export async function business(db: D1Database): Promise<Business | null> {
  return db.prepare('SELECT name,currency,timezone,mileage_rate_minor,per_diem_minor,receipt_threshold_minor FROM c_business WHERE id=1').first<Business>();
}
export async function requireBusiness(db: D1Database) {
  const found = await business(db);
  requireThat(found, 'The owner has not set up the business yet', 409);
  return found;
}

export async function saveBusiness(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  const currency = text(b.currency, 'Currency', 3).toUpperCase();
  requireThat(/^[A-Z]{3}$/.test(currency), 'Currency must be a three-letter code such as USD');
  const current = await business(db);
  if (current && current.currency !== currency) {
    const used = await db.prepare('SELECT COUNT(*) AS n FROM c_claims').first<{ n: number }>();
    requireThat(!used?.n, 'The currency is fixed once claims exist', 409);
  }
  const timezone = text(b.timezone, 'Timezone', 64);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { requireThat(false, 'Timezone must be an IANA name such as America/Chicago'); }
  const values = [text(b.name, 'Business name', 200), currency, timezone, amount(b.mileageRate, 'Mileage rate per mile'), optionalAmount(b.perDiem, 'Per diem') ?? 0, optionalAmount(b.receiptThreshold, 'Receipt threshold') ?? 0, now()];
  await commit(db, authority(actor, 'owner'), [
    db.prepare('INSERT INTO c_business(id,name,currency,timezone,mileage_rate_minor,per_diem_minor,receipt_threshold_minor,updated_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,mileage_rate_minor=excluded.mileage_rate_minor,per_diem_minor=excluded.per_diem_minor,receipt_threshold_minor=excluded.receipt_threshold_minor,updated_at=excluded.updated_at').bind(...values),
    event(db, actor, 'business-saved', {}, { name: values[0], currency, mileageRateMinor: values[3], perDiemMinor: values[4], receiptThresholdMinor: values[5] }),
  ]);
  return business(db);
}

export async function saveCategory(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  const id = typeof b.id === 'string' && b.id ? b.id : uid();
  if (b.id) requireThat(await db.prepare('SELECT 1 FROM c_categories WHERE id=?').bind(id).first(), 'Category not found', 404);
  const name = text(b.name, 'Category name', 100);
  const clash = await db.prepare('SELECT id FROM c_categories WHERE name=? AND id<>?').bind(name, id).first();
  requireThat(!clash, 'Another category already has that name', 409);
  const values = [id, name, text(b.accountCode, 'Account code', 40), text(b.taxCode, 'Tax code', 40), optionalAmount(b.limit, 'Limit per expense'), b.active === false || b.active === 'false' ? 0 : 1];
  await commit(db, authority(actor, 'owner'), [
    db.prepare('INSERT INTO c_categories(id,name,account_code,tax_code,limit_minor,active) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,account_code=excluded.account_code,tax_code=excluded.tax_code,limit_minor=excluded.limit_minor,active=excluded.active').bind(...values),
    event(db, actor, 'category-saved', {}, { id, name, accountCode: values[2], taxCode: values[3], limitMinor: values[4], active: values[5] === 1 }),
  ]);
  return db.prepare('SELECT * FROM c_categories WHERE id=?').bind(id).first();
}

const flag = (v: unknown) => v === true || v === 'true' || v === 'on' ? 1 : 0;

export async function saveMember(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  const address = email(b.email);
  const roles = { employee: flag(b.employee), manager: flag(b.manager), finance: flag(b.finance) };
  requireThat(roles.employee || roles.manager || roles.finance, 'Choose at least one role');
  let approver: string | null = null;
  if (b.approver) {
    approver = email(b.approver, 'Approving manager');
    requireThat(approver !== address, 'Nobody approves their own claims');
    const manager = await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(approver).first();
    requireThat(manager, 'The approving manager must be an active member with the manager role');
  }
  const active = b.active === false || b.active === 'false' ? 0 : 1;
  const name = text(b.name, 'Name', 120);
  await commit(db, authority(actor, 'owner'), [
    db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,approver_email,active,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,is_employee=excluded.is_employee,is_manager=excluded.is_manager,is_finance=excluded.is_finance,approver_email=excluded.approver_email,active=excluded.active,updated_at=excluded.updated_at').bind(address, name, roles.employee, roles.manager, roles.finance, approver, active, now()),
    event(db, actor, 'member-saved', {}, { email: address, roles, approver, active: active === 1 }),
  ]);
  return db.prepare('SELECT * FROM c_members WHERE email=?').bind(address).first();
}
