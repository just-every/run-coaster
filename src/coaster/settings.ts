import { entityBusiness } from './entities';
import { all, authority, commit, need } from './session';
import { needRow, rowAuthority } from './permissions';
import { handOver, openWork } from './handoff';
import { event } from './events';
import { mileageRates, seedIrsRates, type MileageRate } from './mileage';
import { categories } from './items';
import { categoryAccountInput } from './coding/category-accounts';
import { ownerPolicyVersion } from './policy-configuration';
import { email, now, optionalAmount, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Business = { entity_id?: string; fx_enabled: number; name: string; currency: string; timezone: string; per_diem_minor: number; receipt_threshold_minor: number; sales_tax_account: string; sales_tax_code: string; preapproval_threshold_minor: number | null; audit_sample_percent: number | null; reminder_days: number[]; quiet_from: number; quiet_until: number; service_level_days: number; escalation_days: number | null; auto_submit: 'daily' | 'weekly' | 'twice-monthly' | 'monthly' | null; retention_years: number; dual_release_over_minor: number | null; pay_weekday: number | null; advance_account: string; mileage_rates: MileageRate[] };

/** The IRS documentary-evidence line: a new business needs receipts above $75 unless the owner sets another threshold. */
export const DEFAULT_RECEIPT_THRESHOLD_MINOR = 7500;

export async function business(db: D1Database): Promise<Business | null> {
  const found = await db.prepare('SELECT fx_enabled,name,currency,timezone,per_diem_minor,receipt_threshold_minor,sales_tax_account,sales_tax_code,preapproval_threshold_minor,audit_sample_percent,reminder_days,quiet_from,quiet_until,service_level_days,escalation_days,auto_submit,retention_years,dual_release_over_minor,pay_weekday,advance_account FROM c_business WHERE id=1').first<Omit<Business, 'mileage_rates' | 'reminder_days'> & { reminder_days: string }>();
  return found && { ...found, reminder_days: JSON.parse(found.reminder_days) as number[], mileage_rates: await mileageRates(db) };
}
export async function requireBusiness(db: D1Database) {
  const found = await business(db);
  requireThat(found, 'The owner has not set up the business yet', 409);
  return found;
}

export async function saveBusiness(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'settings');
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
  // Expenses above this need an approved spend request (CLAIM-005); empty turns pre-approval off.
  const preapproval = b.preapprovalThreshold === undefined ? current?.preapproval_threshold_minor ?? null : optionalAmount(b.preapprovalThreshold, 'Spend request needed above');
  requireThat(b.fxEnabled === undefined || typeof b.fxEnabled === 'boolean', 'ECB currency conversion must be on or off');
  const fxEnabled = b.fxEnabled === undefined ? current?.fx_enabled ?? 0 : b.fxEnabled ? 1 : 0;
  const values = [text(b.name, 'Business name', 200), currency, timezone, optionalAmount(b.perDiem, 'Per diem') ?? 0, threshold, optionalText(b.salesTaxAccount, 'Sales tax account', 40), optionalText(b.salesTaxCode, 'Sales tax code', 40), preapproval, now()] as const;
  // A new US business starts from the IRS mileage table; any other currency adds its own rates.
  const seed = !current && currency === 'USD' && !(await mileageRates(db)).length;
  await commit(db, rowAuthority(actor, 'settings'), [
    db.prepare('INSERT INTO c_business(id,name,currency,timezone,per_diem_minor,receipt_threshold_minor,sales_tax_account,sales_tax_code,preapproval_threshold_minor,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,per_diem_minor=excluded.per_diem_minor,receipt_threshold_minor=excluded.receipt_threshold_minor,sales_tax_account=excluded.sales_tax_account,sales_tax_code=excluded.sales_tax_code,preapproval_threshold_minor=excluded.preapproval_threshold_minor,updated_at=excluded.updated_at').bind(...values),
    db.prepare('UPDATE c_business SET fx_enabled=? WHERE id=1').bind(fxEnabled),
    db.prepare("UPDATE c_entities SET name=?,currency=?,timezone=?,receipt_threshold_minor=?,preapproval_threshold_minor=?,sales_tax_account=?,sales_tax_code=?,fx_enabled=?,version=version+1,updated_at=? WHERE id='primary'").bind(values[0],currency,timezone,threshold,preapproval,values[5],values[6],fxEnabled,now()),
    ...(seed ? seedIrsRates(db) : []),
    ...ownerPolicyVersion(db, actor.delegate?.email ?? actor.email, timezone, now()),
    event(db, actor, 'business-saved', {}, { name: values[0], currency, timezone, perDiemMinor: values[3], receiptThresholdMinor: values[4], salesTaxAccount: values[5], salesTaxCode: values[6], preapprovalThresholdMinor: values[7], irsMileageRates: seed, fxEnabled: !!fxEnabled }),
  ]);
  return business(db);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The owner's payment controls (PAY-004): dual release above an amount (empty turns it off; a batch over the amount,
 * not at it, needs two releasers) and the weekday the hourly run opens a reimbursement batch (empty turns it off). */
export async function savePaymentControls(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person', 'Only a person changes payment controls', 403);
  await requireBusiness(db);
  const dual = optionalAmount(b.dualReleaseOver, 'Dual release above');
  const weekday = b.payWeekday === undefined || b.payWeekday === null || b.payWeekday === '' ? null : WEEKDAYS.indexOf(String(b.payWeekday));
  requireThat(weekday === null || weekday >= 0, 'Choose a weekday such as Friday, or turn the schedule off');
  // The ledger account cash advances post to when a claim draws one down (CLAIM-004); kept when not sent.
  const advanceAccount = b.advanceAccount === undefined ? (await requireBusiness(db)).advance_account : optionalText(b.advanceAccount, 'Cash advance account', 40);
  await commit(db, authority(actor, 'owner'), [
    db.prepare('UPDATE c_business SET dual_release_over_minor=?,pay_weekday=?,advance_account=?,updated_at=? WHERE id=1').bind(dual, weekday, advanceAccount, now()),
    event(db, actor, 'payment-controls-set', {}, { dualReleaseOverMinor: dual, payWeekday: weekday === null ? null : WEEKDAYS[weekday], advanceAccount }),
  ]);
  return { dualReleaseOverMinor: dual, payWeekday: weekday === null ? null : WEEKDAYS[weekday], advanceAccount };
}

const flag = (v: unknown) => v === true || v === 'true' || v === 'on' ? 1 : 0;
const LODGING = /\b(lodging|hotels?|motels?)\b/i;

export async function saveCategory(db: D1Database, actor: Actor, b: Data, entityId = 'primary') {
  needRow(actor, 'settings');
  const id = typeof b.id === 'string' && b.id ? b.id : uid();
  const previous = b.id ? await db.prepare('SELECT entity_id,ledger_account_id,ledger_account_snapshot FROM c_categories WHERE id=?').bind(id).first<Data>() : null;
  if (b.id) requireThat(previous, 'Category not found', 404);
  requireThat(!previous || previous.entity_id === entityId, 'Category belongs to another legal entity', 409);
  const settings = await entityBusiness(db,entityId);
  requireThat(entityId === 'primary' || !b.ledgerAccountId, 'Provider chart accounts belong to the primary entity; use the native entity chart code', 409);
  const ledgerAccount = await categoryAccountInput(db,b.ledgerAccountId,previous);
  const name = text(b.name, 'Category name', 100);
  const clash = await db.prepare('SELECT id FROM c_categories WHERE name=? AND id<>? AND entity_id=?').bind(name, id, entityId).first();
  requireThat(!clash, 'Another category already has that name', 409);
  // Lodging always needs a receipt at any amount (IRS); the owner can ask the same of any other category.
  const receiptAlways = LODGING.test(name) ? 1 : flag(b.receiptAlways);
  const required = requiredFields(b.requiredFields);
  const values = [id, name, text(b.accountCode, 'Account code', 40), text(b.taxCode, 'Tax code', 40), optionalAmount(b.limit, 'Limit per expense'), b.active === false || b.active === 'false' ? 0 : 1, receiptAlways, optionalAmount(b.perPersonLimit, 'Limit per person'), JSON.stringify(required),ledgerAccount.id,ledgerAccount.snapshot];
  const mappingState = previous ? [{ sql:'EXISTS(SELECT 1 FROM c_categories WHERE id=? AND ledger_account_id IS ? AND ledger_account_snapshot=?)',params:[id,previous.ledger_account_id,previous.ledger_account_snapshot] }] : [];
  await commit(db, all(rowAuthority(actor, 'settings'),...ledgerAccount.guards,...mappingState), [
    db.prepare('INSERT INTO c_categories(id,name,account_code,tax_code,limit_minor,active,receipt_always,per_person_limit_minor,required_fields,ledger_account_id,ledger_account_snapshot,entity_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,account_code=excluded.account_code,tax_code=excluded.tax_code,limit_minor=excluded.limit_minor,active=excluded.active,receipt_always=excluded.receipt_always,per_person_limit_minor=excluded.per_person_limit_minor,required_fields=excluded.required_fields,ledger_account_id=excluded.ledger_account_id,ledger_account_snapshot=excluded.ledger_account_snapshot').bind(...values,entityId),
    ...ownerPolicyVersion(db, actor.delegate?.email ?? actor.email, settings.timezone, now(),entityId),
    event(db, actor, 'category-saved', {}, { id, name, accountCode: values[2], taxCode: values[3], limitMinor: values[4], active: values[5] === 1, receiptAlways: values[6] === 1, perPersonLimitMinor: values[7], requiredFields: required, ledgerAccount: ledgerAccount.id ? JSON.parse(ledgerAccount.snapshot) : null }),
  ]);
  return (await categories(db,entityId)).find(c => c.id === id);
}

/** Custom fields every expense in a category must fill, such as business purpose, client or flight class: a list or comma-separated names. */
function requiredFields(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const names = (Array.isArray(value) ? value : String(value).split(',')).map(v => String(v).trim()).filter(Boolean);
  requireThat(names.length <= 10 && names.every(n => n.length <= 60), 'Name at most 10 required fields of up to 60 characters each');
  return [...new Set(names)];
}


export async function saveMember(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'people');
  const address = email(b.email);
  const roles = { employee: flag(b.employee), manager: flag(b.manager), finance: flag(b.finance), auditor: flag(b.auditor), admin: flag(b.admin), cardAdmin: flag(b.cardAdmin), bookkeeper: flag(b.bookkeeper) };
  requireThat(Object.values(roles).some(Boolean), 'Choose at least one role');
  // The owner account is the owner's alone: an admin assigns every other person's roles, never the owner's (ADMIN-001).
  const ownerAccount = !!await db.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner'").bind(address).first();
  requireThat(actor.roles.owner || !ownerAccount, 'Only the owner changes the owner\'s own record', 403);
  // The release grant (PAY-004) is the owner's to give, and only to finance.
  const release = flag(b.release), contractor = flag(b.contractor);
  // A contractor claims as a non-employee (CLAIM-008): their reimbursements are flagged for 1099 review.
  requireThat(!contractor || roles.employee, 'A contractor claims expenses, so give them the employee role');
  requireThat(!release || roles.finance, 'Only a finance member can be given release access');
  let approver: string | null = null;
  if (b.approver) {
    approver = email(b.approver, 'Approving manager');
    requireThat(approver !== address, 'Nobody approves their own claims');
    const manager = await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(approver).first();
    requireThat(manager, 'The approving manager must be an active member with the manager role');
  }
  let department: string | null = null;
  if (b.department) {
    department = text(b.department, 'Department', 64);
    requireThat(await db.prepare('SELECT 1 FROM c_departments WHERE id=? AND active=1').bind(department).first(), 'Choose an active department', 400);
  }
  const active = b.active === false || b.active === 'false' ? 0 : 1;
  const name = text(b.name, 'Name', 120);
  const was = await db.prepare('SELECT active,may_release FROM c_members WHERE email=?').bind(address).first<{ active: number; may_release: number }>();
  requireThat(actor.roles.owner || release === (was?.may_release ?? 0), 'Only the owner gives or takes away release access', 403);
  // Deactivating hands everything open to a named successor in the same transaction: approvals, reports, a department
  // headed, and unsubmitted card charges. Without a named successor the person's own approving manager takes them.
  let handover: Awaited<ReturnType<typeof handOver>> | null = null, successor: string | null = null;
  if (was?.active === 1 && !active) {
    const open = await openWork(db, address);
    successor = b.successor ? email(b.successor, 'Successor') : approver;
    if (open.manager || open.finance || open.cards || b.successor) {
      requireThat(successor && successor !== address, 'Name an active successor to take over this person\'s open approvals and card charges', 409);
      const holds = await db.prepare('SELECT is_manager,is_finance,is_employee FROM c_members WHERE email=? AND active=1').bind(successor).first<{ is_manager: number; is_finance: number; is_employee: number }>();
      requireThat(holds, 'The successor must be an active member', 409);
      // A named successor must be able to take everything; the person's own manager, used when none is named, takes what its roles allow and the rest waits for the owner to reassign.
      requireThat(!b.successor || !open.manager || holds.is_manager, 'The successor must be an approver to take over open approvals', 409);
      requireThat(!b.successor || !open.finance || holds.is_finance, 'The successor must hold finance to take over finance reviews', 409);
      requireThat(!open.cards || holds.is_employee, 'The successor must be an employee to take over card charges', 409);
      handover = await handOver(db, actor, address, successor!);
    }
  }
  await commit(db, all(rowAuthority(actor, 'people'), ...(handover?.guards ?? [])), [
    ...(handover?.statements ?? []),
    db.prepare('INSERT INTO c_members(email,name,is_employee,is_manager,is_finance,is_auditor,is_admin,is_card_admin,is_bookkeeper,department_id,approver_email,active,may_release,is_contractor,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,is_employee=excluded.is_employee,is_manager=excluded.is_manager,is_finance=excluded.is_finance,is_auditor=excluded.is_auditor,is_admin=excluded.is_admin,is_card_admin=excluded.is_card_admin,is_bookkeeper=excluded.is_bookkeeper,department_id=excluded.department_id,approver_email=excluded.approver_email,active=excluded.active,may_release=excluded.may_release,is_contractor=excluded.is_contractor,updated_at=excluded.updated_at').bind(address, name, roles.employee, roles.manager, roles.finance, roles.auditor, roles.admin, roles.cardAdmin, roles.bookkeeper, department, approver, active, release, contractor, now()),
    event(db, actor, 'member-saved', {}, { email: address, roles, approver, department, active: active === 1, contractor: contractor === 1, ...(successor && handover ? { successor, cardCharges: handover.charges } : {}) }),
    ...(release !== (was?.may_release ?? 0) ? [event(db, actor, release ? 'release-granted' : 'release-revoked', {}, { email: address })] : []),
  ]);
  return db.prepare('SELECT * FROM c_members WHERE email=?').bind(address).first();
}
