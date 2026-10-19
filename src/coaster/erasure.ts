import { redactionStatements, invalidateTransfersStatements } from '@runeditrun/rer/modules/portability/journal';
import { retireD1ImportCustody, type D1Sql } from '../modules/import-kit/src/d1/index';
import { authority, need } from './session';
import { event } from './events';
import { claimNumber } from './claims';
import { holdOn } from './retention';
import { erasureContext } from './imports/jobs';
import { HISTORY_SOURCES } from './imports/cards';
import { email, Fault, now, requireThat, uid, type Actor, type Data } from './types';

/** Personal-data erasure with financial-record retention (ERASURE-001). */

/** Columns that hold a member's address as their whole value. */
const ADDRESS: [string, string[]][] = [
  ['c_claims', ['employee_email', 'approver_email', 'prepared_by', 'on_behalf_of', 'held_by']],
  ['c_receipts', ['owner_email', 'uploaded_by']],
  ['c_revisions', ['submitted_by']],
  ['c_decisions', ['actor_email', 'on_behalf_of']],
  ['c_batches', ['created_by', 'prepared_by', 'reviewed_by', 'paid_by']],
  ['c_events', ['actor_email']],
  ['c_proposals', ['for_email', 'decided_by']],
  ['c_requests', ['employee_email', 'approver_email', 'on_behalf_of', 'submitted_by', 'decided_by', 'decided_on_behalf_of']],
  ['c_comments', ['on_behalf_of', 'asks_email']],
  ['c_export_templates', ['created_by']],
  ['c_exception_reviews', ['reviewed_by']],
  ['c_audit_samples', ['finding_by']],
  ['c_approval_rules', ['set_by']],
  ['c_report_schedules', ['created_by', 'stopped_by']],
  ['c_spend_views', ['owner_email', 'created_by']],
  ['c_budgets', ['owner_email', 'set_by']],
  ['c_budget_alerts', ['member']],
  ['c_allowances', ['member_email', 'set_by', 'stopped_by']],
  ['c_recurring', ['member_email']],
  ['c_allowance_runs', ['member_email']],
  ['c_legal_holds', ['member_email', 'placed_by', 'released_by']],
  ['c_expiry_proposals', ['confirmed_by']],
  ['c_delegations', ['created_by', 'revoked_by']],
  ['c_delegates', ['created_by', 'revoked_by']],
];
/** JSON columns that may name a member's address as a string value. */
const JSON_COLUMNS: [string, string[]][] = [
  ['c_revisions', ['snapshot']], ['c_decisions', ['exceptions']], ['c_events', ['detail']], ['c_proposals', ['payload']],
  ['c_report_schedules', ['recipients']], ['c_report_deliveries', ['recipients']], ['c_escalations', ['recipients']], ['c_budget_alerts', ['recipients']],
  ['c_spend_views', ['query']], ['c_expiry_proposals', ['claims', 'receipt']], ['c_items', ['attendees', 'fields']],
];
/** Imported history names the person at these paths: history values, Expensify payloads and each card or Emburse export's raw row. */
const IMPORTED_PATHS = [['employee'], ['manager'], ['approver'], ['accountEmail'], ['managerEmail'], ...[...new Set(Object.values(HISTORY_SOURCES).flatMap(p => [p.employee, p.approver ?? []].flat()))].map(c => [c])];
/** Kept as US business records: every claim, expense, split, receipt and batch, and every history line. */
const RETAINED = ['claim and spend request amounts, dates, merchants, categories, coding, descriptions and statuses', 'receipt bytes and SHA-256 hashes', 'decisions, revisions, reimbursement batches and history lines, under the opaque label', 'imported history amounts, dates and merchants', 'what other people wrote in their own comments'];

const sql = (text: string, ...params: unknown[]): D1Sql => ({ sql: text, params });
/** Workers' D1 prepared statements carry their text and bindings; import-kit takes them as D1Sql. */
const asSql = (s: D1PreparedStatement): D1Sql => { const p = s as unknown as { statement: string; params: unknown[] }; return sql(p.statement, ...p.params); };
/** A random opaque subject (never derived from the person): `former-member-<8 hex>` stands where their address stood, shown as "Former member <8 hex>". */
const opaque = () => { const hex = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join(''); return { subject: 'former-member-' + hex, label: 'Former member ' + hex }; };

/** The owner erases a deactivated member who owes nothing: their name, address, sign-in account, agent keys, delegations,
 * approver assignments, own comments and reminders go; every financial record stays under a random "Former member"
 * label. One transaction with the import-kit erasure and portability's redaction checkpoint, so an archive made before
 * it is refused once the destination or the later archive's journal knows it. */
export async function eraseMember(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only the owner erases personal data', 403);
  const address = email(b.email, 'Person');
  const member = await db.prepare('SELECT email,name,active FROM c_members WHERE email=?').bind(address).first<{ email: string; name: string; active: number }>();
  requireThat(member, 'Person not found', 404);
  requireThat(member.active === 0, `Deactivate ${member.name} before erasing their personal data`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner'").bind(address).first(), 'The owner cannot be erased', 409);
  const claims = (await db.prepare('SELECT id,number,employee_email,status,total_minor FROM c_claims WHERE employee_email=? ORDER BY number').bind(address).all<{ id: string; number: number; employee_email: string; status: string; total_minor: number }>()).results;
  const unpaid = claims.filter(c => !['reimbursed', 'rejected'].includes(c.status));
  requireThat(!unpaid.length, `${member.name} still has unpaid claims (${unpaid.map(c => claimNumber(c.number)).join(', ')}); pay, reject or remove them first`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM c_requests WHERE employee_email=? AND status='submitted'").bind(address).first(), `${member.name} has a spend request waiting for a decision`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM c_claims WHERE approver_email=? AND status='submitted'").bind(address).first(), `Claims are still waiting for ${member.name} to decide; reassign them first`, 409);
  // The person themselves (a hold on them or the business), then each claim's expense dates.
  const hold = await holdOn(db, [{ id: '', employee_email: address }, ...claims]);
  if (hold) throw new Fault(409, `A legal hold covers ${member.name} (${hold.reason}); release it before erasing`);

  const { subject, label } = opaque(), at = now(), id = uid(), quoted = JSON.stringify(address), quotedLabel = JSON.stringify(subject);
  const receipts = (await db.prepare('SELECT DISTINCT r.sha256 FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id JOIN c_claims c ON c.id=i.claim_id WHERE c.employee_email=? ORDER BY r.sha256').bind(address).all<{ sha256: string }>()).results.map(r => r.sha256);
  const count = async (query: string, ...params: unknown[]) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${query}`).bind(...params).first<{ n: number }>())!.n;
  const operator = await db.prepare('SELECT id FROM oa_operators WHERE lower(email)=?').bind(address).first<{ id: string }>();
  const removed = {
    name: true, email: true, signInAccount: Boolean(operator),
    agentKeys: await count('c_agent_keys WHERE member_email=?', address),
    delegations: await count('c_delegations WHERE approver_email=? OR delegate_email=?', address, address) + await count('c_delegates WHERE grantor_email=? OR delegate_email=?', address, address),
    approverAssignments: await count('c_members WHERE approver_email=?', address),
    comments: await count('c_comments WHERE author_email=?', address),
    reminders: await count('c_reminder_items WHERE person=?', address),
  };
  const retained = { subject, claims: claims.map(c => ({ claim: claimNumber(c.number), status: c.status, totalMinor: c.total_minor })), receiptSha256: receipts, kept: RETAINED };
  const state = sql("EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=0) AND NOT EXISTS(SELECT 1 FROM c_claims WHERE employee_email=? AND status NOT IN ('reimbursed','rejected')) AND NOT EXISTS(SELECT 1 FROM c_legal_holds WHERE released_at IS NULL AND (scope='business' OR (scope='person' AND member_email=?)))", address, address, address);
  const guard = authority(actor, 'owner');
  const check = sql(`INSERT INTO c_guard SELECT CASE WHEN (${guard.sql}) AND (${state.sql}) THEN 1 ELSE 0 END`, ...guard.params, ...state.params!);
  const native: D1Sql[] = [
    check, sql('INSERT INTO c_erasing(email) VALUES(?)', address),
    // Removed outright: their own comments (replies by others stay, as top-level comments), agent keys, delegations and reminders.
    sql('UPDATE c_comments SET parent_id=NULL WHERE parent_id IN (SELECT id FROM c_comments WHERE author_email=?)', address),
    sql('DELETE FROM c_comments WHERE author_email=?', address),
    sql('DELETE FROM c_agent_keys WHERE member_email=?', address),
    sql('DELETE FROM c_delegations WHERE approver_email=? OR delegate_email=?', address, address),
    sql('DELETE FROM c_delegates WHERE grantor_email=? OR delegate_email=?', address, address),
    ...['c_escalations', 'c_reminders'].map(t => sql(`DELETE FROM ${t} WHERE key IN (SELECT key FROM c_reminder_items WHERE person=?)`, address)),
    sql('DELETE FROM c_reminder_items WHERE person=?', address),
    sql('UPDATE c_members SET approver_email=NULL WHERE approver_email=?', address),
    // Text that embeds the address: a receipt-less expense's reimbursement key and an agent's "<label> for <address>" upload.
    sql("UPDATE c_reimbursement_keys SET key='expense:'||?||substr(key,length(?)+9) WHERE substr(key,1,length(?)+9)='expense:'||?||'|'", subject, address, address, address),
    sql("UPDATE c_receipts SET uploaded_by=substr(uploaded_by,1,length(uploaded_by)-length(?))||? WHERE source='agent' AND substr(uploaded_by,-(length(?)+5))=' for '||?", address, subject, address, address),
    // Kept, under the label: every column holding their address, and their address inside JSON.
    ...ADDRESS.flatMap(([table, columns]) => columns.map(c => sql(`UPDATE ${table} SET ${c}=? WHERE ${c}=?`, subject, address))),
    ...JSON_COLUMNS.flatMap(([table, columns]) => columns.map(c => sql(`UPDATE ${table} SET ${c}=replace(${c},?,?) WHERE instr(${c},?)>0`, quoted, quotedLabel, quoted))),
    sql("UPDATE c_members SET email=?,name=?,approver_email=NULL,updated_at=? WHERE email=?", subject, label, at, address),
    // The Base sign-in account and everything that let it sign in.
    ...(operator ? [
      sql('DELETE FROM oa_provider_session_pins WHERE session_id IN (SELECT id FROM oa_sessions WHERE operator_id=?)', operator.id),
      sql('DELETE FROM oa_provider_sessions WHERE session_id IN (SELECT id FROM oa_sessions WHERE operator_id=?)', operator.id),
      sql('DELETE FROM oa_step_up_challenges WHERE operator_id=?', operator.id),
      sql('DELETE FROM oa_sessions WHERE operator_id=? OR source_token_id IN (SELECT id FROM oa_tokens WHERE operator_id=?)', operator.id, operator.id),
      ...['oa_tokens', 'oa_credentials', 'oa_external_identities', 'oa_invitation_cancellations', 'oa_owner_signins'].map(t => sql(`DELETE FROM ${t} WHERE operator_id=?`, operator.id)),
      sql('UPDATE oa_auth_audit SET value=replace(value,?,?) WHERE instr(value,?)>0', address, subject, address),
      sql('DELETE FROM oa_operators WHERE id=?', operator.id),
    ] : []),
    sql("INSERT INTO rer_erasure_operations(id,entity,subject,label,phase,step,planned,deleted,retained,requested_at,committed_at,completed_at) VALUES(?,'member',NULL,?,'complete',0,?,?,?,?,?,?)", id, label, JSON.stringify(removed), JSON.stringify(removed), JSON.stringify(retained), at, at, at),
    asSql(event(db, actor, 'member-erased', {}, { member: subject, erasure: id })),
    sql('DELETE FROM c_erasing'), sql(`INSERT INTO c_guard SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END`, ...guard.params), sql('DELETE FROM c_guard'),
  ];
  const checkpoint = [...await redactionStatements(db), ...await invalidateTransfersStatements(db)].map(asSql);
  try {
    await retireD1ImportCustody({ values: [address], related: { fields: IMPORTED_PATHS.map(path => ({ path, value: address, optional: true })) } }, native, erasureContext(db, actor), checkpoint);
  } catch (error) {
    const message = String((error as Error)?.message ?? error); 
    if (message.includes('c_guard') || message.includes('CHECK constraint failed')) throw new Fault(409, 'This changed while you were working, or your access changed; reload and try again');
    throw error;
  }
  return (await erasures(db)).find(e => e.id === id);
}

const erasureReceipt = (r: Data) => ({ id: r.id, label: r.label, erasedBy: r.erased_by, erasedAt: r.completed_at, removed: r.removed, retained: r.retained });

/** Every erasure receipt, newest first, for the owner and auditors. */
export async function erasures(db: D1Database) {
  const rows = (await db.prepare("SELECT o.id,o.label,o.completed_at,o.deleted,o.retained,e.actor_email AS erased_by FROM rer_erasure_operations o LEFT JOIN c_events e ON e.action='member-erased' AND json_extract(e.detail,'$.erasure')=o.id WHERE o.entity='member' ORDER BY o.completed_at DESC").all<Data>()).results;
  return rows.map(r => erasureReceipt({ ...r, removed: JSON.parse(r.deleted), retained: JSON.parse(r.retained) }));
}
