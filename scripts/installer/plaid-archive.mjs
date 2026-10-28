import { plaidMinor } from '../../src/coaster/plaid/money.mjs';
import { createHash } from 'node:crypto';
import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { validatePlaidCorrections } from './plaid-corrections.mjs';

const check = (ok, code) => { if (!ok) throw new PortabilityError('coaster_plaid_' + code, 409); };
const key = row => JSON.stringify([row.connection_id, row.transaction_id]);
const accountKey = row => JSON.stringify([row.connection_id, row.account_id]);
const body = value => value && typeof value.blob === 'string' ? Buffer.from(value.blob, 'base64') : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value ?? []);
const parse = value => { try { return JSON.parse(value); } catch { check(false, 'facts'); } };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const fields = ['transaction_id', 'account_id', 'pending_transaction_id', 'pending', 'spent_on', 'posted_on', 'merchant', 'amount_minor', 'provider_amount', 'currency'];
const same = (left, right, keys = fields) => keys.every(field => (left[field]??null) === (right[field]??null));
function facts(value) {
  check(object(value) && (Object.keys(value).length === fields.length || Object.keys(value).length === fields.length-1 && !Object.hasOwn(value,'provider_amount')) && Object.keys(value).every(field => fields.includes(field)), 'facts');
  check(['transaction_id', 'account_id', 'merchant'].every(field => nonempty(value[field])) && (value.pending_transaction_id === null || nonempty(value.pending_transaction_id)), 'facts');
  check(typeof value.pending === 'boolean' && Number.isSafeInteger(value.amount_minor) && /^[A-Z]{3}$/.test(value.currency) && date(value.spent_on) && date(value.posted_on), 'facts');
  if(Object.hasOwn(value,'provider_amount')) check(typeof value.provider_amount==='string' && String(Number(value.provider_amount))===value.provider_amount && plaidMinor(Number(value.provider_amount))===value.amount_minor,'facts');
  return value;
}

/** Originals and numbered provider changes travel with financial records, never installation execution custody. */
export async function validatePlaidArchive(read) {
  const names = ['c_plaid_sync_state', 'c_plaid_assignments', 'c_plaid_transactions', 'c_plaid_changes', 'c_plaid_sources', 'c_members', 'c_categories', 'c_cards', 'c_card_charges', 'c_items', 'c_claims', 'c_events', 'c_card_handoffs', 'c_card_charge_aliases', 'c_statement_files', 'c_plaid_personal_charges'];
  const [states, assignments, transactions, changes, sources, members, categories, cards, charges, items, claims, events, handoffs, aliases, files, personal] = await Promise.all(names.map(read));
  const sourceBytes = new Map();
  for (const row of sources) {
    const bytes = body(row.bytes);
    check(bytes.length === row.size && createHash('sha256').update(bytes).digest('hex') === row.sha256, 'source_bytes');
    sourceBytes.set(row.id, bytes);
  }
  const corrections = await validatePlaidCorrections(read);
  const transaction = new Map(transactions.map(row => [key(row), row]));
  const assignment = new Map(assignments.map(row => [accountKey(row), row]));
  const source = new Map(sources.map(row => [row.id, row]));
  check(transaction.size === transactions.length && assignment.size === assignments.length && source.size === sources.length, 'record');
  const details = events.map(event => ({ ...event, detail: parse(event.detail) }));
  const creation = (row, item) => details.find(event => event.action === 'plaid-expense-created' && event.detail.connection === row.connection_id && event.detail.transaction === row.transaction_id && (!item || event.detail.item === item));
  const projection = original => corrections.sources.get(original.id) ?? {
    item: [...charges, ...personal].find(charge => charge.file_id === original.id)?.item_id ?? creation(original)?.detail.item,
    charge: charges.find(charge => charge.file_id === original.id)?.id ?? null, snapshot: null, replacement: false,
  };
  // A reconnect reuses the original financial item and source under its new connection id.
  const sourceFor = row => sources.find(original => original.transaction_id === row.transaction_id && row.item_id && projection(original).item === row.item_id && transaction.get(key(original))?.scope === row.scope);
  const ownerFor = row => {
    let owner = row.employee_email;
    for (const handoff of handoffs.filter(handoff => handoff.charge_id === row.charge_id).sort((left, right) => left.at.localeCompare(right.at))) if (handoff.from_email === owner) owner = handoff.to_email;
    return owner;
  };
  for (const alias of aliases) {
    const charge = charges.find(charge => charge.id === alias.charge_id), file = files.find(file => file.id === alias.file_id), card = charge && cards.find(card => card.id === charge.card_id);
    check(charge && file && card && nonempty(alias.transaction_key) && alias.transaction_key.startsWith(`card:${file.issuer.toLowerCase()}|${card.last4}:`), 'statement_alias');
  }
  for (const state of states) {
    check(nonempty(state.connection_id) && Number.isSafeInteger(state.version) && state.version > 0 && typeof state.cursor==='string' && [0,1].includes(state.in_progress), 'cursor');
    check(state.in_progress===1 || nonempty(state.cursor) && nonempty(state.last_sync_at), 'cursor');
    check(state.attempt_id===null && state.lease_until===null || state.in_progress===1 && nonempty(state.attempt_id) && Number.isSafeInteger(state.lease_until) && state.lease_until>0, 'cursor');
  }
  for (const row of assignments) {
    check(nonempty(row.connection_id) && nonempty(row.account_id) && members.some(member => member.email === row.employee_email) && categories.some(category => category.id === row.category_id), 'assignment');
    check(row.card_id === null || cards.some(card => card.id === row.card_id), 'assignment');
  }
  const history = new Map();
  check(new Set(changes.map(change => change.seq)).size === changes.length, 'history');
  for (const change of [...changes].sort((left, right) => left.seq - right.seq)) {
    const row = transaction.get(key(change)), value = parse(change.facts);
    check(row && Number.isSafeInteger(change.seq) && change.seq > 0 && nonempty(change.at), 'history');
    check(['added', 'modified', 'removed'].includes(change.kind), 'history');
    if (change.kind === 'removed') check(object(value) && Object.keys(value).length === 2 && value.transaction_id === change.transaction_id && ['removed', 'review'].includes(value.status), 'history');
    else { facts(value); check(value.transaction_id === row.transaction_id && value.account_id === row.account_id, 'history'); }
    history.set(key(change), [...(history.get(key(change)) ?? []), { ...change, value }]);
  }
  for (const row of sources) {
    const bytes = sourceBytes.get(row.id);
    const value = facts(parse(bytes.toString('utf8'))), mapping = parse(row.mapping), tx = transaction.get(key(row));
    check(tx && value.transaction_id === tx.transaction_id && value.account_id === tx.account_id && !value.pending && value.amount_minor > 0, 'source');
    check(object(mapping) && Object.keys(mapping).every(field => ['provider', 'coding'].includes(field)) && nonempty(mapping.provider) && object(mapping.coding) && Object.keys(mapping.coding).every(field => ['category', 'costCentre'].includes(field)) && categories.some(category => category.id === mapping.coding.category) && mapping.coding.costCentre === '', 'source');
    check((history.get(key(row)) ?? []).some(change => change.kind !== 'removed' && same(change.value, value)), 'source');
    const projected = projection(row), made = creation(tx, projected.item);
    if (projected.replacement) check(details.some(event => event.action === 'plaid-source-corrected' && event.detail.connection === row.connection_id && event.detail.transaction === row.transaction_id && event.detail.newItem === projected.item && event.detail.scope === tx.scope), 'source');
    else check(made && made.detail.item === projected.item && made.detail.scope === tx.scope && made.detail.reimbursable === (tx.scope === 'personal'), 'source');
    if (tx.scope === 'company') {
      const charge = charges.find(charge => charge.id === projected.charge);
      check(charge && charge.file_id === row.id && charge.item_id === projected.item && charge.employee_email === ownerFor({ ...tx, charge_id: charge.id }) && charge.amount_minor === value.amount_minor && charge.descriptor === value.merchant && charge.posted_on === value.posted_on && charge.transaction_on === value.spent_on && charge.currency === value.currency, 'source_charge');
      if (projected.snapshot) check(projected.snapshot.item.id === charge.item_id && projected.snapshot.item.card_charge_id === charge.id && same(projected.snapshot.item, value, ['amount_minor', 'merchant', 'spent_on']), 'source_charge');
    }
  }
  check(new Set([...charges, ...personal].map(charge => charge.id)).size === charges.length + personal.length, 'personal_charge');
  for (const charge of personal) {
    const original = source.get(charge.file_id), tx = original && transaction.get(key(original)), projected = original && projection(original), value = original && facts(parse(body(original.bytes).toString('utf8')));
    check(original && tx?.scope === 'personal' && charge.connection_id === original.connection_id && charge.transaction_id === original.transaction_id && charge.item_id === projected.item && charge.employee_email === tx.employee_email, 'personal_charge');
    check(charge.transaction_key === `plaid-personal:${charge.transaction_id}:${charge.file_id}` && /^\d{4}$/.test(charge.last4) && categories.some(category => category.id === charge.category_id) && nonempty(charge.created_at), 'personal_charge');
    check(charge.amount_minor === value.amount_minor && charge.descriptor === value.merchant && charge.posted_on === value.posted_on && charge.transaction_on === value.spent_on && charge.currency === value.currency, 'personal_charge');
    const item = items.find(item => item.id === charge.item_id) ?? projected.snapshot?.item;
    if (item) check(!item.card_charge_id && item.personal_card_charge_id === charge.id && (claims.some(claim => claim.id === item.claim_id && claim.employee_email === charge.employee_email) || projected.snapshot && details.some(event => event.action === 'claim-expired' && event.claim_id === item.claim_id)), 'personal_charge');
    else check(details.some(event => event.action === 'expense-removed' && event.detail.item === charge.item_id || event.action === 'claim-expired' && event.claim_id === charge.claim_id), 'personal_charge');
  }
  for (const item of items.filter(item => item.personal_card_charge_id)) check(!item.card_charge_id && personal.some(charge => charge.id === item.personal_card_charge_id && charge.item_id === item.id), 'personal_charge');
  for (const row of transactions) {
    const assigned = assignment.get(accountKey(row)), own = history.get(key(row)) ?? [], latest = own.at(-1), original = sourceFor(row), charge = charges.find(charge => charge.id === row.charge_id);
    check(assigned && assigned.employee_email === row.employee_email && ['company', 'personal'].includes(row.scope) && Boolean(assigned.card_id) === (row.scope === 'company'), 'transaction');
    check(states.some(state => state.connection_id === row.connection_id) && latest && ['pending', 'posted', 'removed', 'review', 'credit', 'overlap'].includes(row.status), 'transaction');
    const previous = own.findLast(change => change.kind !== 'removed');
    check(previous && same(row, previous.value, fields.filter(field => field !== 'pending')), 'transaction');
    if (latest.kind === 'removed') check(row.status === latest.value.status, 'transaction');
    if (row.pending_transaction_id) {
      const pending = transaction.get(key({ ...row, transaction_id: row.pending_transaction_id }));
      check(!pending || pending.account_id === row.account_id && pending.scope === row.scope, 'transaction');
    }
    if (['pending', 'credit'].includes(row.status)) check(!row.item_id && !row.charge_id && !original, 'transaction');
    if (row.status === 'removed') check(!original && (!row.item_id && !row.charge_id || charge && row.item_id === charge.item_id), 'transaction');
    if (row.status === 'pending') check(previous.value.pending, 'transaction');
    if (row.status === 'credit') check(!previous.value.pending && row.amount_minor <= 0, 'transaction');
    const correction = corrections.effective.get(key(row)), resolvedRemoval = [...corrections.effective.values()].some(prior=>prior.transaction_id===row.transaction_id && prior.scope===row.scope && prior.employee_email===row.employee_email && prior.reason==='provider-removal') && !row.item_id && !row.charge_id;
    if (correction?.change_seq === latest.seq) check(row.item_id === correction.new_item_id && row.charge_id === correction.new_charge_id, 'transaction');
    if (row.status === 'posted' || row.status === 'review') check(resolvedRemoval ? !row.item_id && !row.charge_id : original && row.item_id, 'transaction');
    if (row.status === 'posted') check(!previous.value.pending && row.amount_minor > 0 && same(previous.value, facts(parse(body(original.bytes).toString('utf8')))), 'transaction');
    if (row.scope === 'personal' && !['overlap', 'removed'].includes(row.status)) check(!row.charge_id, 'transaction');
    if (row.item_id) {
      const item = items.find(item => item.id === row.item_id), made = creation(original ? transaction.get(key(original)) : row, row.item_id);
      if (item) check(claims.some(claim => claim.id === item.claim_id && claim.employee_email === ownerFor(row)) && (!original || row.scope !== 'personal' || !item.card_charge_id), 'item');
      else check(details.some(event => event.action === 'expense-removed' && event.detail.item === row.item_id || event.action === 'claim-expired' && event.claim_id === (charge?.claim_id ?? made?.claim_id)), 'item');
    }
    if (row.charge_id) check(charge && charge.item_id === row.item_id && charge.employee_email === ownerFor(row), 'charge');
    if (original && row.scope === 'company') check(charge && charge.file_id === original.id, 'charge');
  }
}
