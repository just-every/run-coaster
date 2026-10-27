import { useCallback, useEffect, useState } from 'react';
import { call, moment, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

/** The provider scripts the browser loads itself: the person types their bank details into the provider, never into Coaster. */
const PLAID_LINK = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js', STRIPE_JS = 'https://js.stripe.com/v3/';
const scripts = new Map<string, Promise<void>>();
const load = (src: string) => {
  if (!scripts.has(src)) scripts.set(src, new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src; tag.async = true; tag.onload = () => resolve(); tag.onerror = () => { scripts.delete(src); reject(new Error('The bank verification provider could not be reached. Check your connection and try again.')); };
    document.head.appendChild(tag);
  }));
  return scripts.get(src)!;
};
const words = (a: D) => `${a.label} · ends ${a.last4} · ${a.provider === 'plaid' ? 'verified instantly' : 'verified by micro-deposits'}`;

/** Plaid Link gives Coaster a one-time token for the account the person chose. */
async function instant() {
  const { linkToken } = await call(['bank', 'start'].join('/'), { provider: 'plaid' });
  await load(PLAID_LINK);
  return new Promise<D>((resolve, reject) => (window as any).Plaid.create({
    token: linkToken,
    onSuccess: (publicToken: string, metadata: D) => call(['bank', 'complete'].join('/'), { provider: 'plaid', publicToken, accountId: metadata.accounts?.[0]?.id }).then(resolve, reject),
    onExit: (error: D | null) => reject(new Error(error?.display_message || 'Adding the account was cancelled.')),
  }).open());
}
/** Stripe collects the routing and account numbers in its own frame, then sends two small deposits. */
async function microdeposits(name: string) {
  const start = await call(['bank', 'start'].join('/'), { provider: 'stripe' });
  await load(STRIPE_JS);
  const stripe = (window as any).Stripe(start.publishableKey);
  const collected = await stripe.collectBankAccountForSetup({ clientSecret: start.clientSecret, params: { payment_method_type: 'us_bank_account', payment_method_data: { billing_details: { name } } }, expand: ['payment_method'] });
  if (collected.error) throw new Error(collected.error.message || 'Stripe could not collect the account.');
  const confirmed = await stripe.confirmUsBankAccountSetup(start.clientSecret);
  if (confirmed.error) throw new Error(confirmed.error.message || 'Stripe could not set up the account.');
  return call(['bank', 'complete'].join('/'), { provider: 'stripe', setupIntent: start.setupIntent });
}

/** A person's own bank account: add it, verify it, change it. Status and last four only. */
export function MyBank({ name }: { name: string }) {
  const [bank, setBank] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const load_ = useCallback(async () => { setBank(await call('bank')); }, []);
  useEffect(() => { load_().catch(e => setError(e.message)); }, [load_]);
  const run = (done: string, work: () => Promise<unknown>) => async () => {
    setError(''); setNotice('');
    try {
      const result = await work() as D | undefined; await load_();
      setNotice(result?.notified && result.notified !== 'accepted' ? `${done} The change notice was not accepted. Tell finance before payments resume.` : done);
    } catch (e) { setError((e as Error).message); await load_().catch(() => undefined); }
  };
  const account = bank?.account, pending = bank?.pending, can = bank && (bank.providers.plaid || bank.providers.stripe);
  return <Section title="Your bank account" label="Your bank account">
    <p className="muted">Bank verification currently uses sandbox and test providers. Coaster does not send direct deposits. You enter your bank details with the verifying provider; Coaster keeps only the provider’s token and the last four digits. Changing the account needs a sign-in from the last 10 minutes.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {!bank && !error && <p>Loading your bank account…</p>}
    {bank && (account ? <>
      <p><span className="chip tone-done">Verified</span> {words(account)} · added {moment(account.verifiedAt)}</p>
      {account.held && <p><span className="chip tone-wait">Payments held</span> After a change of bank details nothing is paid to you until {moment(account.holdUntil)}.</p>}
    </> : !pending && <Empty title="No bank account yet">{can ? 'Add a test account below to verify the setup.' : 'Ask the owner to connect a bank verification provider in Settings.'}</Empty>)}
    {pending && <>
      <p><span className="chip tone-wait">Waiting for deposits</span> {pending.label} · ends {pending.last4}. Two small deposits arrive in one to two business days; enter them to finish.</p>
      <Form label="Verify deposits" onSubmit={async (v, form) => {
        const amounts = [Number(v.first), Number(v.second)];
        await call(['bank', 'verify'].join('/'), { id: pending.id, ...(v.code ? { descriptorCode: String(v.code).toUpperCase() } : { amounts }) });
        form.reset(); await load_(); setNotice('Bank account verified.');
      }} secondary={<>
        <button type="button" className="button" onClick={run('Checked with the provider.', () => call(['bank', 'refresh'].join('/'), { id: pending.id }))}>Check status</button>
        <button type="button" className="button" onClick={run('Pending account cancelled.', () => call(['bank', 'cancel'].join('/'), { id: pending.id }))}>Cancel account</button>
      </>}>
        <Field label="First deposit (cents)" name="first" inputMode="numeric" required={false} />
        <Field label="Second deposit (cents)" name="second" inputMode="numeric" required={false} />
        <Field label="Or the code from the deposit description" name="code" required={false} hint="Six characters beginning SM" />
      </Form>
    </>}
    {bank && can && !pending && <div className="sub-form">
      {account && <p className="muted">Changing your account tells you at your address on record and holds payments to you for {bank.holdDays} {bank.holdDays === 1 ? 'day' : 'days'}.</p>}
      <div className="form-end">
        {bank.providers.plaid && <button type="button" className="button primary" onClick={run('Bank account added.', instant)}>{account ? 'Change with instant verification' : 'Add with instant verification'}</button>}
        {bank.providers.stripe && <button type="button" className="button" onClick={run(account ? 'Account changed once its deposits are verified.' : 'Waiting for the two deposits.', () => microdeposits(name))}>{account ? 'Change with micro-deposits' : 'Add with micro-deposits'}</button>}
      </div>
    </div>}
  </Section>;
}

/** The owner and finance read every person's verification status and last four, and set the cooling-off period. */
export function BankPeople() {
  const [data, setData] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const reload = useCallback(async () => { setData(await call(['bank', 'people'].join('/'))); }, []);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  return <Section title="Employee bank details" label="Employee bank details">
    <p className="muted">Verification status and last four digits only; no role sees a full account number. After someone changes their account, payments to them are held for the cooling-off period and they are told at their address on record.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {data && <>
      <div className="table-wrap"><table className="mini" aria-label="Employee bank details">
        <thead><tr><th>Person</th><th>Status</th><th>Account</th><th>Payments</th></tr></thead>
        <tbody>{data.people.filter((p: D) => p.active || p.account || p.pending).map((p: D) => <tr key={p.email}>
          <td>{p.name}</td>
          <td>{p.status === 'verified' ? 'Verified' : p.status === 'pending' ? 'Waiting for deposits' : 'No account'}</td>
          <td>{p.account ? `${p.account.label} · ends ${p.account.last4}` : p.pending ? `Ends ${p.pending.last4}` : '—'}</td>
          <td>{p.account?.held ? `Held until ${moment(p.account.holdUntil)}` : p.account ? 'Open' : '—'}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="sub-form"><Form key={data.holdDays} label="Save cooling-off period" onSubmit={async v => {
        await call(['bank', 'hold-period'].join('/'), { days: Number(v.days) }); await reload(); setNotice('Cooling-off period saved.');
      }}>
        <Field label="Hold payments after a bank change (days)" name="days" inputMode="numeric" defaultValue={String(data.holdDays)} hint="1 to 30; a change already made keeps the period it was made under" />
      </Form></div>
    </>}
  </Section>;
}

/** The owner connects the verification providers, once, with consent; their credentials are sealed in the installation. */
export function BankProviders() {
  const [data, setData] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const reload = useCallback(async () => { setData(await call(['bank', 'providers'].join('/'))); }, []);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  const connected = (provider: string) => data?.providers.some((p: D) => p.provider === provider);
  const disconnect = (provider: string) => <div className="sub-form"><Form label={`Disconnect ${provider === 'plaid' ? 'Plaid' : 'Stripe'}`} onSubmit={async v => {
    if (!v.consent) throw new Error('Confirm disconnect first.');
    await call(['bank', 'providers', 'disconnect'].join('/'), { provider }); await reload(); setNotice('Disconnected. People keep their verified accounts; no new ones can be added with it.');
  }}><Field label={`Disconnect ${provider === 'plaid' ? 'Plaid' : 'Stripe'}`} name="consent" type="checkbox" /></Form></div>;
  return <Section title="Bank verification providers" label="Bank verification providers">
    <p className="muted">Employees verify their bank account with Plaid (instant) or Stripe (micro-deposits). Connect the sandbox or test-mode credentials here, in your own session; they are sealed in this installation and never exported. Production keys are not accepted.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {data && <>
      {connected('plaid') ? <><p>Plaid sandbox is connected.</p>{disconnect('plaid')}</> : <Form label="Connect Plaid sandbox" onSubmit={async (v, form) => {
        if (!v.consent) throw new Error('Authorize the connection first.');
        await call(['bank', 'providers', 'connect'].join('/'), { provider: 'plaid', clientId: v.clientId, secret: v.secret, consent: true }); form.reset(); await reload(); setNotice('Plaid sandbox connected.');
      }}>
        <Field label="Plaid client ID" name="clientId" autoComplete="off" />
        <Field label="Plaid sandbox secret" name="secret" type="password" autoComplete="off" />
        <Field label="I authorize Plaid to verify my employees’ bank accounts for this installation" name="consent" type="checkbox" />
      </Form>}
      {connected('stripe') ? <><p>Stripe test mode is connected.</p>{disconnect('stripe')}</> : <Form label="Connect Stripe test mode" onSubmit={async (v, form) => {
        if (!v.consent) throw new Error('Authorize the connection first.');
        await call(['bank', 'providers', 'connect'].join('/'), { provider: 'stripe', secretKey: v.secretKey, publishableKey: v.publishableKey, consent: true }); form.reset(); await reload(); setNotice('Stripe test mode connected.');
      }}>
        <Field label="Stripe test secret key" name="secretKey" type="password" autoComplete="off" />
        <Field label="Stripe test publishable key" name="publishableKey" autoComplete="off" />
        <Field label="I authorize Stripe to verify my employees’ bank accounts for this installation" name="consent" type="checkbox" />
      </Form>}
    </>}
  </Section>;
}
