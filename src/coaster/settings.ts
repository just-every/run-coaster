import { authority, commit, need } from './session';
import { event } from './events';
import { mileageRates, seedIrsRates, type MileageRate } from './mileage';
import { queueMoves } from './delegation';
import { email, now, optionalAmount, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Business = { name: string; currency: string; timezone: string; per_diem_minor: number; receipt_threshold_minor: number; sales_tax_account: string; sales_tax_code: string; mileage_rates: MileageRate[] };

/** The IRS documentary-evidence line: a new business needs receipts above $75 unless the owner sets another threshold. */
export const DEFAULT_RECEIPT_THRESHOLD_MINOR = 7500;

export async function business(db: D1Database): Promise<Business | null> {
  const found = await db.prepare('SELECT name,currency,timezone,per_diem_minor,receipt_threshold_minor,sales_tax_account,sales_tax_code FROM c_business WHERE id=1').first<Omit<Business, 'mileage_rates'>>();
  return found && { ...found, mileage_rates: await mileageRates(db) };
}
export async function requireBusiness(db: D1Database) {
  const found = await business(db);
  requireThat(found, 'The owner has not set up the business yet', 409);
  return found;
}

export async function saveBusiness(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  const currency = (b.currency === undefined ? 'USD' : text(b.currency, 'Currency', 3)).toUpperCase();
  requireThat(/^[A-Z]{3}$/.test(currency), 'Currency must be a three-letter code such as USD');
  const current = await business(db);
  if (current && current.currency !== currency) {
    const used = await db.prepare('SELECT COUNT(*) AS n FROM c_claims').first<{ n: number }>();
    requireThat(!used?.n, 'The currency is fixed once claims exist', 409);
  }
  const timezone = text(b.timezone, 'Timezone', 64);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { requireThat(false, 'Timezone must be an IANA name such as America/Chicago'); }
  const threshold = b.receiptThreshold === undefined ? current?.receipt_threshold_minor ?? DEFAULT_RECEIPT_THRESHOLD_MINOR : optionalAmount(b.receiptThreshold, 'Receipt threshold') ?? 0;
  const values = [text(b.name, 'Business name', 200), currency, timezone, optionalAmount(b.perDiem, 'Per diem') ?? 0, threshold, optionalText(b.salesTaxAccount, 'Sales tax account', 40), optionalText(b.salesTaxCode, 'Sales tax code', 40), now()] as const;
  // A new US business starts from the IRS mileage table; any other currency adds its own rates.
  const seed = !current && currency === 'USD' && !(await mileageRates(db)).length;
  await commit(db, authority(actor, 'owner'), [
    db.prepare('INSERT INTO c_business(id,name,currency,timezone,per_diem_minor,receipt_threshold_minor,sales_tax_account,sales_tax_code,updated_at) VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,per_diem_minor=excluded.per_diem_minor,receipt_threshold_minor=excluded.receipt_threshold_minor,sales_tax_account=excluded.sales_tax_account,sales_tax_code=excluded.sales_tax_code,updated_at=excluded.updated_at').bind(...values),
    ...(seed ? seedIrsRates(db) : []),
    event(db, actor, 'business-saved', {}, { name: values[0], currency, timezone, perDiemMinor: values[3], receiptThresholdMinor: values[4], salesTaxAccount: values[5], salesTaxCode: values[6], irsMileageRates: seed }),
  ]);
  return business(db);
}

const flag = (v: unknown) => v === true || v === 'true' || v === 'on' ? 1 : 0;
const LODGING = /\b(lodging|hotels?|motels?)\b/i;

export async function saveCategory(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  const id = typeof b.id === 'string' && b.id ? b.id : uid();
  if (b.id) requireThat(await db.prepare('SELECT 1 FROM c_categories WHERE id=?').bind(id).first(), 'Category not found', 404);
  const name = text(b.name, 'Category name', 100);
  const clash = await db.prepare('SELECT id FROM c_categories WHERE name=? AND id<>?').bind(name, id).first();
  requireThat(!clash, 'Another category already has that name', 409);
  // Lodging always needs a receipt at any amount (IRS); the owner can ask the same of any other category.
  const receiptAlways = LODGING.test(name) ? 1 : flag(b.receiptAlways);
  const values = [id, name, text(b.accountCode, 'Account code', 40), text(b.taxCode, 'Tax code', 40), optionalAmount(b.limit, 'Limit per expense'), b.active === false || b.active === 'false' ? 0 : 1, receiptAlways];
  await commit(db, authority(actor, 'owner'), [
    db.prepare('INSERT INTO c_categories(id,name,account_code,tax_code,limit_minor,active,receipt_always) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,account_code=excluded.account_code,tax_code=excluded.tax_code,limit_minor=excluded.limit_minor,active=excluded.active,receipt_always=excluded.receipt_always').bind(...values),
    event(db, actor, 'category-saved', {}, { id, name, accountCode: values[2], taxCode: values[3], limitMinor: values[4], active: values[5] === 1, receiptAlways: values[6] === 1 }),
  ]);
  return db.prepare('SELECT * FROM c_categories WHERE id=?').bind(id).first();
}


export async function saveMember(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  const address = email(b.email);
  const roles = { employee: flag(b.employee), manager: flag(b.manager), finance: flag(b.finance), auditor: flag(b.auditor) };
  requireThat(roles.employee || roles.manager || roles.finance || roles.auditor, 'Choose at least one role');
  let approver: string | null = null;
  if (b.approver) {
    approver = email(b.approver, 'Approving manager');
    requireThat(approver !== address, 'Nobody approves their own claims');
    const manager = await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(approver).first();
    requireThat(manager, 'The approving manager must be an active member with the manager role');
  }
  const active = b.active === false || b.active === 'false' ? 0 : 1;
  const name = text(b.name, 'Name', 120);
  // Deactivating an approver moves their waiting claims to their own manager.
  const was = await db.prepare('SELECT active FROM c_members WHERE email=?').bind(address).first<{ active: number }>();
  const moves = was?.active === 1 && !active ? await queueMoves(db, actor, address, approver) : [];
  await commit(db, authority(actor, 'owner'), [
    db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,is_auditor,approver_email,active,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,is_employee=excluded.is_employee,is_manager=excluded.is_manager,is_finance=excluded.is_finance,is_auditor=excluded.is_auditor,approver_email=excluded.approver_email,active=excluded.active,updated_at=excluded.updated_at').bind(address, name, roles.employee, roles.manager, roles.finance, roles.auditor, approver, active, now()),
    event(db, actor, 'member-saved', {}, { email: address, roles, approver, active: active === 1 }),
    ...moves,
  ]);
  return db.prepare('SELECT * FROM c_members WHERE email=?').bind(address).first();
}
