import { replaceDiscardIdentity } from './receipts/reasons.mjs';
import { advancesFor } from './advances';
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
  ['c_account_corrections', ['actor_email', 'acting_for']],
  ['c_plaid_settings', ['set_by']], ['c_plaid_connections', ['connected_by']],
  ['c_receipt_mail_messages',['sender','owner_email']], ['c_receipt_mail_settings',['set_by']],
  ['c_payroll_handoffs', ['created_by']], ['c_gusto_connection', ['connected_by']], ['c_bank_providers', ['connected_by']], ['c_bank_settings', ['set_by']],
  ['c_program_feeds', ['connected_by']], ['c_receipt_reading_settings', ['set_by']], ['c_receipt_readings', ['actor_email', 'on_behalf_of']],
  ['c_auto_coding_rules',['owner_email','set_by']], ['c_auto_coding_contexts',['employee_email']], ['c_auto_coding_suggestions',['employee_email']], ['c_auto_coding_feedback',['actor_email']], ['c_auto_coding_observations',['employee_email']],
  ['c_workflow_tasks', ['email','on_behalf_of']], ['c_approval_workflows',['created_by']],
  ['c_claims', ['employee_email', 'approver_email', 'prepared_by', 'on_behalf_of', 'held_by']],
  ['c_receipts', ['owner_email', 'uploaded_by']],
  ['c_capture_receipts', ['owner_email', 'uploaded_by']],
  ['c_capture_receipt_events', ['actor_email', 'on_behalf_of']],
  ['c_capture_lifecycle', ['actor_email', 'on_behalf_of']],
  ['c_card_match_rules', ['set_by']], ['c_card_match_generations', ['employee_email']],
  ['c_revisions', ['submitted_by']],
  ['c_decisions', ['actor_email', 'on_behalf_of']],
  ['c_batches', ['created_by', 'prepared_by', 'reviewed_by', 'first_released_by', 'released_by', 'paid_by']],
  ['c_events', ['actor_email']],
  ['c_accounting_corrections', ['actor_email', 'on_behalf_of']],
  ['c_proposals', ['for_email', 'decided_by']],
  ['c_requests', ['employee_email', 'approver_email', 'on_behalf_of', 'submitted_by', 'decided_by', 'decided_on_behalf_of']],
  ['c_comments', ['on_behalf_of', 'asks_email']],
  ['c_export_templates', ['created_by']],
  ['c_advances', ['employee_email', 'approver_email', 'on_behalf_of', 'submitted_by', 'decided_by', 'decided_on_behalf_of', 'paid_by']], ['c_advance_returns', ['recorded_by']],
  ['c_exception_reviews', ['reviewed_by']], ['c_nonaccountable', ['marked_by']],
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
  ['c_policies', ['published_by']],
  ['c_approval_envelopes',['set_by']], ['c_cards', ['employee_email', 'assigned_by']], ['c_card_charges', ['employee_email']], ['c_card_charge_undo_history', ['employee_email']], ['c_statement_files', ['imported_by', 'undone_by']],
  ['c_card_statements', ['opened_by', 'closed_by']], ['c_card_statement_resolutions', ['resolved_by']],
  ['c_departments', ['head_email', 'created_by']], ['c_escalation_chains', ['set_by']], ['c_card_handoffs', ['from_email', 'to_email', 'by_email']],
  ['c_qbd_connection', ['connected_by']], ['c_coding_values', ['owner_email']], ['c_qbo_connections', ['connected_by']],
];
/** JSON columns that may name a member's address as a string value. */
const JSON_COLUMNS: [string, string[]][] = [
  ['c_payroll_handoffs', ['lines']],
  ['c_batch_accounting_coding', ['selections']],
  ['c_qbd_requests', ['payload']],
  ['c_receipt_readings', ['fields_json']],
  ['c_auto_coding_rules',['fields']], ['c_auto_coding_contexts',['values_json']], ['c_auto_coding_suggestions',['fields','evidence']], ['c_auto_coding_feedback',['values_json']], ['c_auto_coding_observations',['fields']],
  ['c_approval_workflows',['rules']], ['c_requests',['workflow']],
  ['c_claim_chains', ['steps']], ['c_revisions', ['snapshot']], ['c_decisions', ['exceptions']], ['c_events', ['detail']], ['c_proposals', ['payload']],
  ['c_report_schedules', ['recipients']], ['c_report_deliveries', ['recipients']], ['c_escalations', ['recipients']], ['c_budget_alerts', ['recipients']],
  ['c_spend_views', ['query']], ['c_expiry_proposals', ['claims', 'receipt']], ['c_items', ['attendees', 'fields']],
];
/** Imported history names the person at these paths: history values, Expensify payloads and each card or Emburse export's raw row. */
const IMPORTED_PATHS = [['employee'], ['manager'], ['approver'], ['accountEmail'], ['managerEmail'], ...[...new Set(Object.values(HISTORY_SOURCES).flatMap(p => [p.employee, p.approver ?? []].flat()))].map(c => [c])];
/** Kept as US business records: every claim, expense, split, receipt and batch, and every history line. */
const RETAINED = ['claim, spend request and cash advance amounts, dates, merchants, categories, coding, descriptions and statuses', 'receipt bytes and SHA-256 hashes', 'decisions, revisions, reimbursement batches and history lines, under the opaque label', 'imported history amounts, dates and merchants', 'what other people wrote in their own comments'];

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
  const member = await db.prepare('SELECT email,name,active,member_id FROM c_members WHERE email=?').bind(address).first<{ email: string; name: string; active: number; member_id: string }>();
  requireThat(member, 'Person not found', 404);
  requireThat(member.active === 0, `Deactivate ${member.name} before erasing their personal data`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner'").bind(address).first(), 'The owner cannot be erased', 409);
  const claims = (await db.prepare('SELECT id,number,employee_email,status,total_minor FROM c_claims WHERE employee_email=? ORDER BY number').bind(address).all<{ id: string; number: number; employee_email: string; status: string; total_minor: number }>()).results;
  const unpaid = claims.filter(c => !['reimbursed', 'rejected'].includes(c.status));
  requireThat(!unpaid.length, `${member.name} still has unpaid claims (${unpaid.map(c => claimNumber(c.number)).join(', ')}); pay, reject or remove them first`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM c_requests WHERE employee_email=? AND status='submitted'").bind(address).first(), `${member.name} has a spend request waiting for a decision`, 409);
  // A cash advance still waiting, unpaid or with excess owed is an open financial record (CLAIM-004).
  requireThat(!await db.prepare("SELECT 1 FROM c_workflow_tasks t WHERE (t.email=? OR t.on_behalf_of=?) AND ((t.kind='claim' AND EXISTS(SELECT 1 FROM c_claims c WHERE c.id=t.record_id AND c.revision=t.revision AND c.status='submitted')) OR (t.kind='request' AND EXISTS(SELECT 1 FROM c_requests r WHERE r.id=t.record_id AND r.status='submitted'))) LIMIT 1").bind(address,address).first(), 'Workflow reviews are still open; complete or return them before erasure',409);
  requireThat(!await db.prepare("SELECT 1 FROM c_revisions v JOIN c_claims c ON c.id=v.claim_id AND c.revision=v.revision WHERE c.status='submitted' AND instr(v.snapshot,?)>0 UNION ALL SELECT 1 FROM c_requests WHERE status='submitted' AND instr(workflow,?)>0 LIMIT 1").bind(JSON.stringify(address),JSON.stringify(address)).first(), 'A pending frozen workflow names this member; finish it before erasure',409);
  const advance = (await advancesFor(db, { ...actor, roles: { ...actor.roles, owner: true } })).advances.find(a => a.employee_email === address && (['submitted', 'approved'].includes(a.status) || a.owedMinor > 0));
  requireThat(!advance, `${member.name} has cash advance ${advance?.advance} still open; settle it first`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM c_claims WHERE approver_email=? AND status='submitted'").bind(address).first(), `Claims are still waiting for ${member.name} to decide; reassign them first`, 409);
  requireThat(!await db.prepare("SELECT 1 FROM c_claim_chains cc JOIN c_claims c ON c.id=cc.claim_id AND c.revision=cc.revision JOIN json_each(cc.steps) s WHERE c.status='submitted' AND CAST(s.key AS INTEGER)>=cc.position AND json_extract(s.value,'$.memberId')=?").bind(member.member_id).first(), `Claims are still waiting for ${member.name} in an approval chain; complete or return them first`, 409);
  // The person themselves (a hold on them or the business), then each claim's expense dates.
  const hold = await holdOn(db, [{ id: '', employee_email: address }, ...claims]);
  if (hold) throw new Fault(409, `A legal hold covers ${member.name} (${hold.reason}); release it before erasing`);

  const memberSources = (await db.prepare("SELECT substr(id,1,instr(id,':')-1) AS namespace,json_extract(value,'$.sourceKey') AS key FROM c_history WHERE kind='crosswalk' AND json_extract(value,'$.targetId')=?").bind(member.member_id).all<{namespace:string;key:string}>()).results;
  const { subject, label } = opaque(), at = now(), id = uid(), quoted = JSON.stringify(address), quotedLabel = JSON.stringify(subject);
  const receipts = (await db.prepare('SELECT r.sha256 FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id JOIN c_claims c ON c.id=i.claim_id WHERE c.employee_email=? UNION SELECT sha256 FROM c_capture_receipts WHERE owner_email=? ORDER BY sha256').bind(address, address).all<{ sha256: string }>()).results.map(r => r.sha256);
  const count = async (query: string, ...params: unknown[]) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${query}`).bind(...params).first<{ n: number }>())!.n;
  const operator = await db.prepare('SELECT id FROM oa_operators WHERE lower(email)=?').bind(address).first<{ id: string }>();
  // Matching rows and old values are guarded before the erasure batch writes.
  const matchReasons = 'instr(lower(reason),?)>0 OR instr(reason,?)>0';
  const discardReasons = (await db.prepare(`SELECT receipt_id,sequence,reason FROM c_capture_lifecycle WHERE ${matchReasons}`).bind(address, member.name).all<{ receipt_id: string; sequence: number; reason: string }>()).results;
  const members = (await db.prepare('SELECT email,name FROM c_members').all<{email:string;name:string}>()).results;
  const matchRows = (await db.prepare('SELECT receipt_id,sequence,match_data FROM c_capture_lifecycle WHERE match_data IS NOT NULL').all<{receipt_id:string;sequence:number;match_data:string}>()).results;
  const rewrittenMatches = matchRows.map(row => {
    const value = JSON.parse(row.match_data);
    if (typeof value.merchant === 'string') value.merchant = replaceDiscardIdentity(value.merchant,members,address,member.name,subject,label);
    return {...row,replaced:JSON.stringify(value)};
  }).filter(row=>row.replaced!==row.match_data);
  const rewrittenReasons = discardReasons.map(row => ({ ...row, replaced: replaceDiscardIdentity(row.reason, members, address, member.name, subject, label) })).filter(row => row.reason !== row.replaced);
  const removed = {
    name: true, email: true, signInAccount: Boolean(operator),
    personalPlaidConnections: await count('c_plaid_connections WHERE personal_email=?', address),
    plaidLinkRequests: await count('c_plaid_links WHERE member_email=?', address),
    agentKeys: await count('c_agent_keys WHERE member_email=?', address),
    delegations: await count('c_delegations WHERE approver_email=? OR delegate_email=?', address, address) + await count('c_delegates WHERE grantor_email=? OR delegate_email=?', address, address),
    approverAssignments: await count('c_members WHERE approver_email=?', address),
    comments: await count('c_comments WHERE author_email=?', address),
    reminders: await count('c_reminder_items WHERE person=?', address),
    discardReasons: rewrittenReasons.length,
    bankAccounts: await count('c_bank_accounts WHERE member_email=?', address),
  };
  const retained = { subject, claims: claims.map(c => ({ claim: claimNumber(c.number), status: c.status, totalMinor: c.total_minor })), receiptSha256: receipts, kept: RETAINED };
  const state = sql("EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=0) AND NOT EXISTS(SELECT 1 FROM c_claims WHERE employee_email=? AND status NOT IN ('reimbursed','rejected')) AND NOT EXISTS(SELECT 1 FROM c_legal_holds WHERE released_at IS NULL AND (scope='business' OR (scope='person' AND member_email=?)))", address, address, address);
  const guard = authority(actor, 'owner');
  const check = sql(`INSERT INTO c_guard SELECT CASE WHEN (${guard.sql}) AND (${state.sql}) THEN 1 ELSE 0 END`, ...guard.params, ...state.params!);
  const native: D1Sql[] = [
    check, sql(`INSERT INTO c_guard SELECT CASE WHEN (SELECT COUNT(*) FROM c_capture_lifecycle WHERE ${matchReasons})=? THEN 1 ELSE 0 END`, address, member.name, discardReasons.length),
    ...matchRows.map(row => sql('INSERT INTO c_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND sequence=? AND match_data=?) THEN 1 ELSE 0 END',row.receipt_id,row.sequence,row.match_data)),
    ...discardReasons.map(row => sql('INSERT INTO c_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND sequence=? AND reason=?) THEN 1 ELSE 0 END', row.receipt_id, row.sequence, row.reason)),
    sql('INSERT INTO c_erasing(email) VALUES(?)', address), sql('INSERT INTO c_capture_erasing(email) VALUES(?)', address),
    // Removed outright: their own comments (replies by others stay, as top-level comments), agent keys, delegations and reminders.
    sql('UPDATE c_comments SET parent_id=NULL WHERE parent_id IN (SELECT id FROM c_comments WHERE author_email=?)', address),
    sql('DELETE FROM c_comments WHERE author_email=?', address),
    sql("DELETE FROM c_auto_coding_feedback WHERE suggestion_id IN (SELECT id FROM c_auto_coding_suggestions WHERE target_kind='receipt' AND employee_email=?)",address),
    sql("DELETE FROM c_auto_coding_suggestions WHERE target_kind='receipt' AND employee_email=?",address),
    sql("DELETE FROM c_auto_coding_contexts WHERE target_kind='receipt' AND employee_email=?",address),
    sql("DELETE FROM c_auto_coding_observations WHERE target_kind='receipt' AND employee_email=?",address),
    sql("DELETE FROM c_auto_coding_rules WHERE scope='personal' AND owner_email=?",address),
    sql('DELETE FROM c_agent_keys WHERE member_email=?', address),
    sql('DELETE FROM c_public_keys WHERE member_email=?', address),
    sql('UPDATE c_capture_receipts SET uploaded_by=? WHERE uploaded_by IN (SELECT email FROM c_receipt_mail_aliases WHERE owner_email=?)',subject,address),
    sql('UPDATE c_receipt_mail_messages SET sender=? WHERE owner_email=?',subject,address),
    sql('DELETE FROM c_receipt_mail_aliases WHERE owner_email=?',address),
    sql('DELETE FROM c_receipt_reading_match_defaults WHERE employee_email=?', address),
    sql('DELETE FROM c_qbo_oauth_states WHERE actor_email=?', address),
    sql('DELETE FROM c_delegations WHERE approver_email=? OR delegate_email=?', address, address),
    sql('DELETE FROM c_delegates WHERE grantor_email=? OR delegate_email=?', address, address),
    sql('DELETE FROM c_gusto_employees WHERE email=?', address),
    // Their bank token and last four (PAY-002); the history lines name only an opaque account id.
    sql('UPDATE c_bank_accounts SET previous_id=NULL WHERE member_email=?', address),
    sql('DELETE FROM c_bank_accounts WHERE member_email=?', address),
    ...['c_escalations', 'c_reminders'].map(t => sql(`DELETE FROM ${t} WHERE key IN (SELECT key FROM c_reminder_items WHERE person=?)`, address)),
    sql('DELETE FROM c_reminder_items WHERE person=?', address),
    sql('UPDATE c_members SET approver_email=NULL WHERE approver_email=?', address),
    sql("DELETE FROM c_import_targets WHERE kind='approval-chain' AND id IN (SELECT id FROM c_import_chains WHERE employee_id=? OR EXISTS(SELECT 1 FROM json_each(steps) WHERE value=?))",member.member_id,member.member_id),
    sql('DELETE FROM c_import_chains WHERE employee_id=? OR EXISTS(SELECT 1 FROM json_each(steps) WHERE value=?)',member.member_id,member.member_id),
    sql("DELETE FROM c_import_targets WHERE kind='member' AND id=?",member.member_id),
    // Text that embeds the address: a receipt-less expense's reimbursement key and an agent's "<label> for <address>" upload.
    sql("UPDATE c_reimbursement_keys SET key='expense:'||?||substr(key,length(?)+9) WHERE substr(key,1,length(?)+9)='expense:'||?||'|'", subject, address, address, address),
    sql("UPDATE c_receipts SET uploaded_by=substr(uploaded_by,1,length(uploaded_by)-length(?))||? WHERE source='agent' AND substr(uploaded_by,-(length(?)+5))=' for '||?", address, subject, address, address),
    sql("UPDATE c_qbd_requests SET source=replace(source,?,?) WHERE instr(source,?)>0",address,subject,address),
    sql("UPDATE c_accounting_corrections SET reason=replace(reason,?,?) WHERE instr(reason,?)>0",address,subject,address),
    sql("UPDATE c_batch_accounting_coding SET selections=replace(selections,?,?) WHERE instr(selections,?)>0",address,subject,address),
    sql("UPDATE c_events SET detail=replace(detail,?,?) WHERE action='accounting-coding-corrected' AND instr(detail,?)>0",address,subject,address),
    sql("UPDATE c_qbd_mappings SET name='vendor:'||? WHERE name='vendor:'||?",subject,address),
    // Kept, under the label: every column holding their address, and their address inside JSON.
    sql(`INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,at,actor_email,on_behalf_of,channel)
      SELECT r.id,(SELECT MAX(sequence)+1 FROM c_capture_lifecycle WHERE receipt_id=r.id),'match-withdrawn','',?,?,r.owner_email,'app'
      FROM c_capture_receipts r WHERE r.owner_email=?
      AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id=r.id AND l.kind IN ('discarded','merged'))
      AND NOT EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=r.id)
      AND (SELECT kind FROM c_capture_lifecycle WHERE receipt_id=r.id AND kind IN ('match-details','match-withdrawn') ORDER BY sequence DESC LIMIT 1)='match-details'`,at,actor.email,address),
    ...rewrittenMatches.map(row=>sql('UPDATE c_capture_lifecycle SET match_data=? WHERE receipt_id=? AND sequence=? AND match_data=?',row.replaced,row.receipt_id,row.sequence,row.match_data)),
    ...(await db.prepare('SELECT id,reason FROM c_account_corrections').all<{id:string;reason:string}>()).results.flatMap(row => {
      const reason = replaceDiscardIdentity(row.reason, members, address, member.name, subject, label);
      return reason === row.reason ? [] : [sql('UPDATE c_account_corrections SET reason=? WHERE id=?', reason, row.id), sql("UPDATE c_events SET detail=json_set(detail,'$.reason',?) WHERE action='account-code-corrected' AND json_extract(detail,'$.correction')=?",reason,row.id)];
    }),
    ...rewrittenReasons.map(row => sql('UPDATE c_capture_lifecycle SET reason=? WHERE receipt_id=? AND sequence=? AND reason=?', row.replaced, row.receipt_id, row.sequence, row.reason)),
    ...ADDRESS.flatMap(([table, columns]) => columns.map(c => sql(`UPDATE ${table} SET ${c}=? WHERE ${c}=?`, subject, address))),
    ...JSON_COLUMNS.flatMap(([table, columns]) => columns.map(c => sql(`UPDATE ${table} SET ${c}=replace(${c},?,?) WHERE instr(${c},?)>0`, quoted, quotedLabel, quoted))),
    sql("UPDATE c_members SET email=?,name=?,member_id=?,approver_email=NULL,updated_at=? WHERE email=?", subject, label, uid(), at, address),
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
    // Native-account deletion dirties this derived cache after address replacement; remove the old identity last.
    sql('DELETE FROM c_card_match_generations WHERE employee_email=?', address),
    sql('DELETE FROM c_plaid_connections WHERE personal_email=?', address), sql('DELETE FROM c_plaid_links WHERE member_email=?', address),
    sql('DELETE FROM c_capture_erasing'), sql('DELETE FROM c_erasing'), sql(`INSERT INTO c_guard SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END`, ...guard.params), sql('DELETE FROM c_guard'),
  ];
  const checkpoint = [...await redactionStatements(db), ...await invalidateTransfersStatements(db)].map(asSql);
  try {
    await retireD1ImportCustody({ target: {kind:'member',id:member.member_id}, values: [address], related: { source: record => (record.namespace==='concur' && ((record.payload as Data).employee===address || (record.payload as Data).approver===address)) || ((record.kind === 'approval-chain' || record.kind === 'card') && (memberSources.some(s=>s.namespace===record.namespace&&s.key===(record.payload as Data).employee) || (record.kind === 'approval-chain' && ((record.payload as Data).steps ?? []).some((key:string)=>memberSources.some(s=>s.namespace===record.namespace&&s.key===key))))), original: bytes => { const content = new TextDecoder().decode(bytes); return content.includes(address) || content.includes(member.name); }, fields: [...IMPORTED_PATHS.map(path => ({ path, value: address, optional: true })), {path:['email'],value:address,optional:true}, {path:['targetId'],value:member.member_id,optional:true}] } }, native, erasureContext(db, actor), checkpoint);
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
