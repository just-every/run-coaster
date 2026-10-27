import type { Bindings } from '../../auth.server';
import { operatorMail } from '../../mail.server.mjs';
import { seal, unseal } from '../public-api/crypto';
import { needRow } from '../permissions';
import { all, commit, type Sql } from '../session';
import { event } from '../events';
import { Fault, now, requireThat, uid, type Actor, type Data } from '../types';
import { providerOf } from './connection';
import { accountOf, activeMember, holdDays, nativeSelf, noDelegate, providerConnected, publicAccount, recentSignIn, requireRecentSignIn, sealId, type Account, type Member, type Provider } from './model';
import { credentials, plaid, stripe, type Credentials } from './network';

/** What a provider confirmed: its token and the last four, nothing else about the account. */
type Draft = { provider: Provider; method: Account['method']; token: string; ref: string; last4: string; label: string };
const INSTANT_AUTH = new Set(['INSTANT_AUTH', 'INSTANT_MATCH']);
const providerId = (value: unknown, label: string) => { requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value), `Choose a valid ${label}`); return value as string; };
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The signed-in employee's own account, any pending one and the providers they can use. */
export async function myBank(env: Bindings, actor: Actor) {
  noDelegate(actor);
  requireThat(actor.roles.employee, 'Only people who submit expenses have a bank account here', 403);
  const connected = await providerConnected(env.DB);
  return { providers: { plaid: connected.has('plaid'), stripe: connected.has('stripe') }, holdDays: await holdDays(env.DB),
    account: publicAccount(await accountOf(env.DB, actor.email, 'active')), pending: publicAccount(await accountOf(env.DB, actor.email, 'pending')) };
}
/** Verification status and last four for every person, for the owner and finance (ADMIN-001's bank-details row). */
export async function bankPeople(env: Bindings, actor: Actor) {
  noDelegate(actor); needRow(actor, 'bank');
  const rows = (await env.DB.prepare("SELECT m.email,m.name,m.active,a.id,a.provider,a.method,a.state,a.last4,a.label,a.created_at,a.verified_at,a.hold_days,a.hold_until,a.hold_released_at,a.replaced_at FROM c_members m LEFT JOIN c_bank_accounts a ON a.member_email=m.email AND a.state IN ('active','pending') ORDER BY m.name,a.state").all<Data>()).results;
  const people = new Map<string, Data>();
  for (const r of rows) {
    const person = people.get(r.email) ?? { email: r.email, name: r.name, active: r.active === 1, status: 'none', account: null, pending: null };
    if (r.id) {
      const shown = publicAccount(r as Account);
      if (r.state === 'active') { person.account = shown; person.status = 'verified'; } else { person.pending = shown; if (!person.account) person.status = 'pending'; }
    }
    people.set(r.email, person);
  }
  return { holdDays: await holdDays(env.DB), people: [...people.values()] };
}

/** Starts a verification the provider completes in the browser: Plaid Link for instant verification, a Stripe SetupIntent for micro-deposits. */
export async function startBank(env: Bindings, actor: Actor, b: Data) {
  nativeSelf(actor); await requireRecentSignIn(env.DB, actor);
  const member = await memberOf(env, actor), provider = providerOf(b.provider), c = await credentials(env, provider, actor);
  requireThat(!await accountOf(env.DB, actor.email, 'pending'), 'Finish or cancel your pending bank account first', 409);
  if (provider === 'plaid') {
    const link = await plaid(c, '/link/token/create', { client_name: 'Coaster', language: 'en', country_codes: ['US'], user: { client_user_id: member.member_id }, products: ['auth'], account_filters: { depository: { account_subtypes: ['checking', 'savings'] } } });
    requireThat(typeof link.link_token === 'string', 'Plaid did not return a link', 502);
    return { provider, linkToken: link.link_token };
  }
  const customer = await stripe(c, 'POST', '/v1/customers', [['description', `Coaster employee ${member.member_id}`]]);
  const intent = await stripe(c, 'POST', '/v1/setup_intents', [['customer', customer.id], ['automatic_payment_methods[enabled]', 'true'], ['automatic_payment_methods[allow_redirects]', 'never'], ['payment_method_options[us_bank_account][verification_method]', 'microdeposits'], ['metadata[coaster_member]', member.member_id]]);
  requireThat(typeof intent.id === 'string' && typeof intent.client_secret === 'string', 'Stripe did not return a setup', 502);
  return { provider, setupIntent: intent.id, clientSecret: intent.client_secret, publishableKey: c.publishableKey };
}

/** The provider has the account; Coaster keeps its token and the last four only. Instant verification activates the account; micro-deposits leave it pending until verified. */
export async function completeBank(env: Bindings, actor: Actor, b: Data) {
  nativeSelf(actor); await requireRecentSignIn(env.DB, actor);
  const member = await memberOf(env, actor), provider = providerOf(b.provider), c = await credentials(env, provider, actor);
  requireThat(!await accountOf(env.DB, actor.email, 'pending'), 'Finish or cancel your pending bank account first', 409);
  if (provider === 'plaid') return activate(env, actor, member, await plaidDraft(c, providerId(b.publicToken, 'Plaid public token'), b.accountId === undefined ? undefined : providerId(b.accountId, 'Plaid account')), c.state!);
  const intent = await setupIntent(c, member, providerId(b.setupIntent, 'Stripe setup'));
  const draft = stripeDraft(intent, intent.status === 'succeeded' ? 'instant' : 'microdeposit', providerId(b.setupIntent, 'Stripe setup'));
  if (intent.status === 'succeeded') return activate(env, actor, member, draft, c.state!);
  requireThat(intent.status === 'requires_action' && intent.next_action?.type === 'verify_with_microdeposits', 'Stripe has not accepted this bank account; start again', 409);
  const id = uid();
  await commit(env.DB, all(nativeSelf(actor), recentSignIn(actor), c.state!, pendingFree(actor.email)), [
    env.DB.prepare("INSERT INTO c_bank_accounts(id,member_email,provider,method,state,token_sealed,last4,label,created_at) VALUES(?,?,?,?,'pending',?,?,?,?)").bind(id, actor.email, provider, 'microdeposit', await sealDraft(env, id, draft), draft.last4, draft.label, now()),
    event(env.DB, actor, 'bank-account-pending', {}, { account: id, provider, method: 'microdeposit' }),
  ]);
  return { status: 'pending', account: publicAccount((await accountOf(env.DB, actor.email, 'pending'))!) };
}

/** The employee enters the two amounts (or the descriptor code) the micro-deposits carried; Stripe says whether they match. */
export async function verifyBank(env: Bindings, actor: Actor, b: Data) {
  nativeSelf(actor); await requireRecentSignIn(env.DB, actor);
  const member = await memberOf(env, actor), pending = await pendingOf(env, actor, b), c = await credentials(env, 'stripe', actor), held = await unsealDraft(env, pending);
  const form: [string, string][] = Array.isArray(b.amounts) && b.amounts.length === 2 && b.amounts.every((n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 100)
    ? b.amounts.map((n: number) => ['amounts[]', String(n)] as [string, string])
    : typeof b.descriptorCode === 'string' && /^SM[A-Z0-9]{4}$/.test(b.descriptorCode) ? [['descriptor_code', b.descriptorCode]] : [];
  requireThat(form.length, 'Enter the two deposit amounts in cents, or the six-character code beginning SM');
  await stripe(c, 'POST', `/v1/setup_intents/${encodeURIComponent(held.ref)}/verify_microdeposits`, form);
  return settle(env, actor, member, c, pending, held);
}
/** Reads the provider again: a pending account verified elsewhere (Stripe's own page) becomes active. */
export async function refreshBank(env: Bindings, actor: Actor, b: Data) {
  nativeSelf(actor); await requireRecentSignIn(env.DB, actor);
  const member = await memberOf(env, actor), pending = await pendingOf(env, actor, b);
  return settle(env, actor, member, await credentials(env, 'stripe', actor), pending, await unsealDraft(env, pending));
}
async function settle(env: Bindings, actor: Actor, member: Member, c: Credentials, pending: Account, held: Draft) {
  const intent = await setupIntent(c, member, held.ref);
  if (intent.status === 'succeeded') return activate(env, actor, member, { ...held, method: 'microdeposit' }, c.state!, pending);
  if (intent.status === 'requires_action') return { status: 'pending', account: publicAccount(pending) };
  await abandon(env, actor, pending, 'verification failed');
  return { status: 'failed' };
}
export async function cancelBank(env: Bindings, actor: Actor, b: Data) {
  nativeSelf(actor); await requireRecentSignIn(env.DB, actor);
  await abandon(env, actor, await pendingOf(env, actor, b), 'cancelled');
  return { status: 'cancelled' };
}
async function abandon(env: Bindings, actor: Actor, pending: Account, reason: string) {
  await commit(env.DB, all(nativeSelf(actor), { sql: "EXISTS(SELECT 1 FROM c_bank_accounts WHERE id=? AND state='pending')", params: [pending.id] }), [
    env.DB.prepare("UPDATE c_bank_accounts SET state='abandoned',token_sealed=NULL WHERE id=?").bind(pending.id),
    event(env.DB, actor, 'bank-account-abandoned', {}, { account: pending.id, reason }),
  ]);
}

const memberOf = async (env: Bindings, actor: Actor) => { const member = await activeMember(env.DB, actor.email); requireThat(member, 'Ask the owner to add you to Coaster', 403); return member; };
const pendingFree = (address: string): Sql => ({ sql: "NOT EXISTS(SELECT 1 FROM c_bank_accounts WHERE member_email=? AND state='pending')", params: [address] });
async function pendingOf(env: Bindings, actor: Actor, b: Data) {
  const pending = await accountOf(env.DB, actor.email, 'pending');
  requireThat(pending && pending.id === b.id && pending.provider === 'stripe', 'There is no pending bank account to verify', 404);
  return pending;
}
const sealDraft = (env: Bindings, id: string, d: Draft) => seal(env.SESSION_SECRET, sealId(id), JSON.stringify({ token: d.token, ref: d.ref }));
async function unsealDraft(env: Bindings, a: Account): Promise<Draft> {
  try { return { provider: a.provider, method: a.method, last4: a.last4, label: a.label, ...JSON.parse(await unseal(env.SESSION_SECRET, sealId(a.id), a.token_sealed!)) }; }
  catch { throw new Fault(409, 'This installation cannot read the pending account; cancel it and add it again'); }
}

/** Link names the account the person chose; an item holding exactly one checking or savings account needs no choice. */
async function plaidDraft(c: Credentials, publicToken: string, accountId?: string): Promise<Draft> {
  const exchange = await plaid(c, '/item/public_token/exchange', { public_token: publicToken });
  requireThat(typeof exchange.access_token === 'string' && typeof exchange.item_id === 'string', 'Plaid did not return the connection', 502);
  const refuse = async (message: string): Promise<never> => {
    // A refused attempt must not leave a live connection behind; a failure to remove it changes nothing about the refusal.
    await plaid(c, '/item/remove', { access_token: exchange.access_token }).catch(() => undefined);
    throw new Fault(409, message);
  };
  const result = await plaid(c, '/accounts/get', { access_token: exchange.access_token }), item = result.item ?? {};
  const eligible = (result.accounts ?? []).filter((a: Data) => a.type === 'depository' && ['checking', 'savings'].includes(a.subtype) && /^\d{4}$/.test(a.mask ?? ''));
  const account = accountId ? eligible.find((a: Data) => a.account_id === accountId) : eligible.length === 1 ? eligible[0] : undefined;
  if (!account) return refuse('Choose a checking or savings account');
  if (!INSTANT_AUTH.has(item.auth_method) || !(item.billed_products ?? []).includes('auth')) return refuse('This bank did not verify the account instantly; add it with micro-deposits instead');
  return { provider: 'plaid', method: 'instant', token: exchange.access_token, ref: account.account_id, last4: account.mask, label: 'Plaid bank account' };
}
async function setupIntent(c: Credentials, member: Member, id: string) {
  const intent = await stripe(c, 'GET', `/v1/setup_intents/${encodeURIComponent(id)}?expand[]=payment_method`);
  requireThat(intent.id === id && intent.metadata?.coaster_member === member.member_id, 'This bank setup does not belong to you', 403);
  return intent;
}
function stripeDraft(intent: Data, method: Account['method'], ref: string): Draft {
  const method_ = intent.payment_method, bank = method_?.us_bank_account;
  requireThat(method_ && typeof method_.id === 'string' && method_.type === 'us_bank_account' && /^\d{4}$/.test(bank?.last4 ?? ''), 'Stripe has no bank account on this setup yet', 409);
  return { provider: 'stripe', method, token: method_.id, ref, last4: bank.last4, label: 'Stripe bank account' };
}

/** Makes the account the person's one active account. Replacing one is the change PAY-002 protects: the old account's token is discarded, payments are held for the cooling-off period, and the address of record is told. */
async function activate(env: Bindings, actor: Actor, member: Member, draft: Draft, connected: Sql, pending?: Account) {
  const previous = await accountOf(env.DB, actor.email, 'active'), id = pending?.id ?? uid(), at = now(), days = await holdDays(env.DB);
  // Replaying a completed setup must not read as a change of account.
  if (previous) {
    // Historical ciphertext from a restored installation cannot grant provider authority.
    // A freshly verified replacement needs no access to that old credential.
    const old = await unsealDraft(env, previous).catch(() => null);
    requireThat(!old || old.token !== draft.token || old.ref !== draft.ref, 'That account is already your active account', 409);
  }
  const outstanding = previous?.hold_until && !previous.hold_released_at ? Date.parse(previous.hold_until) : 0;
  const holdUntil = previous ? new Date(Math.max(Date.parse(at) + days * 86_400_000, outstanding)).toISOString() : null;
  const state: Sql = all(nativeSelf(actor), recentSignIn(actor), connected, previous
    ? { sql: "EXISTS(SELECT 1 FROM c_bank_accounts WHERE id=? AND state='active')", params: [previous.id] }
    : { sql: "NOT EXISTS(SELECT 1 FROM c_bank_accounts WHERE member_email=? AND state='active')", params: [actor.email] },
    pending ? { sql: "EXISTS(SELECT 1 FROM c_bank_accounts WHERE id=? AND state='pending')", params: [pending.id] } : pendingFree(actor.email));
  const sealed = await sealDraft(env, id, draft), detail = { account: id, provider: draft.provider, method: draft.method };
  await commit(env.DB, state, [
    ...(previous ? [env.DB.prepare("UPDATE c_bank_accounts SET state='replaced',token_sealed=NULL,replaced_at=? WHERE id=?").bind(at, previous.id)] : []),
    pending
      ? env.DB.prepare("UPDATE c_bank_accounts SET state='active',verified_at=?,previous_id=?,hold_days=?,hold_until=? WHERE id=?").bind(at, previous?.id ?? null, previous ? days : null, holdUntil, id)
      : env.DB.prepare("INSERT INTO c_bank_accounts(id,member_email,provider,method,state,token_sealed,last4,label,created_at,verified_at,previous_id,hold_days,hold_until) VALUES(?,?,?,?,'active',?,?,?,?,?,?,?,?)").bind(id, actor.email, draft.provider, draft.method, sealed, draft.last4, draft.label, at, at, previous?.id ?? null, previous ? days : null, holdUntil),
    ...(previous ? [
      event(env.DB, actor, 'bank-account-changed', {}, { ...detail, previous: previous.id, holdDays: days, holdUntil }),
      event(env.DB, actor, 'bank-hold-started', {}, { account: id, holdDays: days, holdUntil }),
    ] : [event(env.DB, actor, 'bank-account-added', {}, detail)]),
  ]);
  const notified = previous ? await notifyPreviousContact(env, actor, member, previous, draft, holdUntil!, id) : null;
  return { status: 'active', account: publicAccount((await accountOf(env.DB, actor.email, 'active'))!), notified };
}

/** The notice goes to the address on record before the change: the person's own address, naming the last four of both accounts and when the hold ends. The outcome is its own history line; the hold stands either way. */
async function notifyPreviousContact(env: Bindings, actor: Actor, member: Member, previous: Account, draft: Draft, holdUntil: string, account: string) {
  // This safety notice follows the committed replacement, even if the initiating session ends.
  // The original member identity must still exist and be active; erasure or contact changes refuse it.
  const current: Sql = { sql: 'EXISTS(SELECT 1 FROM c_bank_accounts WHERE id=? AND member_email=?) AND EXISTS(SELECT 1 FROM c_members WHERE member_id=? AND email=? AND active=1)', params: [account, member.email, member.member_id, member.email] };
  if (!await env.DB.prepare(`SELECT (${current.sql}) AS ok`).bind(...current.params).first<{ ok: number }>().then(r => r?.ok)) return 'not sent: access changed';
  const mail = operatorMail(env), link = `${env.AUTH_ORIGIN}/app#/settings`;
  const body = `Your bank account for Coaster reimbursements was changed. The new account ends ${draft.last4} (${draft.label}); the one it replaced ended ${previous.last4}. As a safety measure no payment will be made to you until ${holdUntil.slice(0, 16).replace('T', ' ')} UTC. If you did not make this change, tell the owner or finance now and sign in to review it: ${link}`;
  let status = 'mail not set up';
  if (mail) {
    try { status = (await mail.send({ deliveryId: account, from: env.MAIL_FROM ?? '', to: [member.email], subject: 'Your Coaster bank account was changed', text: body, html: `<p>${escape(body.replace(link, ''))}<a href="${link}">${link}</a></p>`, headers: {} })).status; }
    catch { status = 'failed'; }
  }
  await commit(env.DB, current, [event(env.DB, actor, 'bank-notice-sent', {}, { account, to: member.email, status })]);
  return status;
}
