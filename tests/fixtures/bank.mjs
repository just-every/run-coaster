import assert from 'node:assert/strict';

/** The two providers at the network edge. The full account and routing numbers exist only here, as they do at the real providers: the browser hands them over, Coaster never sees them. */
export const BANK_NUMBERS = ['000111222333', '000444555666', '110000999', '000777888999'];
export const bankFixture = () => {
  const links = new Map(), intents = new Map(), calls = [], removed = [];
  let counter = 0;
  const fixture = {
    clientId: 'synthetic-coaster-210', secret: 'synthetic-coaster-211', stripeKey: 'synthetic-coaster-212', publishableKey: 'synthetic-coaster-213', calls, removed, links, intents, live: false,
    /** What Plaid Link hands the browser after the person signs in to their bank. */
    link(mask = '0000', over = {}) {
      const publicToken = `synthetic-coaster-public-${++counter}`, accountId = `synthetic-coaster-account-${counter}`;
      links.set(publicToken, { accessToken: `synthetic-coaster-access-${counter}`, itemId: `synthetic-coaster-item-${counter}`, account: { account_id: accountId, type: 'depository', subtype: 'checking', mask, name: 'Plaid Checking', ...over.account }, item: { auth_method: 'INSTANT_AUTH', billed_products: ['auth'], institution_name: 'First Platypus Bank', ...over.item } });
      return { publicToken, accountId };
    },
    /** What Stripe.js does in the browser: the numbers go from the person straight to Stripe. */
    collect(setupIntent, last4 = '6789', status = 'requires_action') {
      const intent = intents.get(setupIntent);
      Object.assign(intent, { status, paymentMethod: { id: `synthetic-coaster-pm-${++counter}`, type: 'us_bank_account', us_bank_account: { last4, bank_name: 'STRIPE TEST BANK', routing_number: '110000999', fingerprint: 'synthetic-coaster-fp' } } });
    },
    async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      calls.push({ method: request.method, path });
      if (url.origin === 'https://sandbox.plaid.com') {
        const body = await request.json();
        assert.equal(request.method, 'POST');
        if (body.client_id !== fixture.clientId || body.secret !== fixture.secret) return Response.json({ error_code: 'INVALID_API_KEYS' }, { status: 400 });
        if (path === '/institutions/get_by_id') return Response.json({ institution: { institution_id: body.institution_id } });
        if (path === '/link/token/create') { assert.ok(body.user.client_user_id && !body.user.client_user_id.includes('@'), 'an opaque member id, never an address'); assert.deepEqual(body.products, ['auth']); return Response.json({ link_token: `synthetic-coaster-link-${++counter}` }); }
        const link = [...links.values()].find(l => l.accessToken === body.access_token);
        if (path === '/item/public_token/exchange') { const l = links.get(body.public_token); return l ? Response.json({ access_token: l.accessToken, item_id: l.itemId }) : Response.json({ error_code: 'INVALID_PUBLIC_TOKEN' }, { status: 400 }); }
        if (path === '/accounts/get') return Response.json({ accounts: [link.account], item: { ...link.item, item_id: link.itemId } });
        if (path === '/item/remove') { removed.push(body.access_token); return Response.json({}); }
        assert.fail(`Unexpected Plaid request ${path}`);
      }
      assert.equal(url.origin, 'https://api.stripe.com');
      assert.equal(request.headers.get('authorization'), `Bearer ${fixture.stripeKey}`);
      const form = request.method === 'GET' ? new URLSearchParams() : new URLSearchParams(await request.text());
      if (path === '/v1/balance') return Response.json({ livemode: fixture.live });
      if (path === '/v1/customers') return Response.json({ id: `synthetic-coaster-customer-${++counter}` });
      if (path === '/v1/setup_intents') {
        const id = `synthetic-coaster-intent-${++counter}`;
        assert.equal(form.get('payment_method_options[us_bank_account][verification_method]'), 'microdeposits');
        intents.set(id, { id, status: 'requires_payment_method', metadata: { coaster_member: form.get('metadata[coaster_member]') } });
        return Response.json({ id, client_secret: `${id}-secret` });
      }
      const match = path.match(/^\/v1\/setup_intents\/([^/]+)(\/verify_microdeposits)?$/), intent = match && intents.get(match[1]);
      if (!intent) return Response.json({ error: {} }, { status: 404 });
      if (match[2]) {
        if (intent.status !== 'requires_action' || form.getAll('amounts[]').join() !== '32,45') return Response.json({ error: { code: 'payment_method_microdeposit_verification_amounts_mismatch' } }, { status: 400 });
        intent.status = 'succeeded';
      }
      return Response.json({ id: intent.id, status: intent.status, metadata: intent.metadata, payment_method: intent.paymentMethod, next_action: intent.status === 'requires_action' ? { type: 'verify_with_microdeposits' } : null });
    },
  };
  return fixture;
};

/** Connect both providers as the owner. */
export async function connectBank(h, fixture) {
  await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'plaid', clientId: fixture.clientId, secret: fixture.secret, consent: true });
  await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'stripe', secretKey: fixture.stripeKey, publishableKey: fixture.publishableKey, consent: true });
}
/** Instant verification through Plaid for one signed-in person. */
export async function addInstant(h, fixture, cookie, mask = '0000') {
  await h.post(['bank', 'start'].join('/'), { provider: 'plaid' }, cookie);
  const { publicToken, accountId } = fixture.link(mask);
  return h.post(['bank', 'complete'].join('/'), { provider: 'plaid', publicToken, accountId }, cookie);
}
/** Micro-deposit verification through Stripe for one signed-in person; returns the pending account. */
export async function addMicrodeposits(h, fixture, cookie, last4 = '6789') {
  const start = await h.post(['bank', 'start'].join('/'), { provider: 'stripe' }, cookie);
  fixture.collect(start.setupIntent, last4);
  return { start, ...await h.post(['bank', 'complete'].join('/'), { provider: 'stripe', setupIntent: start.setupIntent }, cookie) };
}
/** Every table's rows as one string, to look for anything that should not be stored. */
export async function everything(h) {
  const tables = (await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
  let all = '';
  for (const { name } of tables) all += JSON.stringify((await h.db.prepare(`SELECT * FROM "${name}"`).all()).results);
  return all;
}
