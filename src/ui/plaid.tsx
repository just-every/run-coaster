import { useCallback, useEffect, useState } from 'react';
import { amountText, call, day, money, moment, type D } from './api';
import { Details, Empty, Field, Form, Section } from './parts';

const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const transactionStatus: Record<string, string> = { pending: 'Pending', posted: 'Posted', removed: 'Removed', review: 'Needs review · original expense retained; submission and payment paused until reconciled', credit: 'Credit · review separately', overlap: 'Already imported · no duplicate expense' };
let script: Promise<void> | undefined;
function loadLink() {
  if (!script) script = new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = LINK_SCRIPT; tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => { script = undefined; tag.remove(); reject(new Error('Plaid Link could not be reached. Check your connection and try again.')); };
    document.head.appendChild(tag);
  });
  return script;
}

async function connect(scope: string) {
  await loadLink();
  const start = await call('plaid/link', { scope, consent: true });
  return new Promise<D>((resolve, reject) => {
    let complete = false;
    const link = (window as any).Plaid.create({
      token: start.linkToken,
      onSuccess: (publicToken: string) => {
        complete = true;
        call('plaid/exchange', { link: start.id, publicToken, consent: true }).then(resolve, reject).finally(() => link.destroy());
      },
      onExit: (error: D | null) => {
        if (complete) return;
        reject(new Error(error?.display_message || 'Connecting the feed was cancelled.'));
        link.destroy();
      },
    });
    link.open();
  });
}

function Costs({ costs }: { costs: D }) {
  return <div aria-label="Plaid estimated costs">
    <p><strong>USD estimate</strong> · {costs.accountMonthlyMinor == null ? 'Account price not configured' : `${money(costs.accountMonthlyMinor)} per connected account each month`} · {costs.monthlyCapMinor == null ? 'No monthly cap' : `${money(costs.monthlyCapMinor)} monthly cap`}</p>
    <p>{costs.month} · <strong>{money(costs.monthToDateMinor)}</strong> estimated so far. Manual claims remain available when the cap pauses feeds.</p>
    <Details label="How feed costs work"><p>{costs.basis}</p><p>Plaid sandbox uses test accounts. These owner-configured USD estimates are not a provider invoice or a billing guarantee. Disconnecting does not refund recorded estimates.</p></Details>
  </div>;
}

function Credentials({ data, changed }: { data: D; changed: () => Promise<void> }) {
  return <Details label={data.configured ? 'Change Plaid sandbox settings' : 'Configure Plaid sandbox'}>
    <p>Use your Plaid sandbox application. Credentials are sealed in this installation, never shown again and excluded from archives. A sign-in from the last 10 minutes is required.</p>
    <Form key={data.version} label={data.configured ? 'Update Plaid sandbox' : 'Configure Plaid sandbox'} onSubmit={async (values, form) => {
      if (!values.consent) throw new Error('Authorize the Plaid sandbox application first.');
      await call('plaid/settings', { ...values, version: data.version, consent: true });
      form.reset(); await changed();
    }}>
      <Field label="Feed Plaid client ID" name="clientId" autoComplete="off" />
      <Field label="Feed Plaid sandbox secret" name="secret" type="password" autoComplete="off" />
      <Field label="Estimated USD per account each month" name="accountMonthly" inputMode="decimal" defaultValue={amountText(data.accountMonthlyMinor)} />
      <Field label="Monthly feed cap in USD" name="monthlyCap" inputMode="decimal" required={false} defaultValue={amountText(data.monthlyCapMinor)} hint="Leave empty for no cap" />
      <Field label="I authorize this Plaid sandbox application and these estimated costs" name="consent" type="checkbox" />
    </Form>
  </Details>;
}

function Transactions({ connection, revision }: { connection: D; revision: number }) {
  const [data, setData] = useState<D>(), [error, setError] = useState(''), [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    call(`plaid/connections/${connection.id}/transactions`).then(value => { if (current) { setData(value); setError(''); } }, reason => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [connection.id, revision, open]);
  return <details className="disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Transaction details</summary><div className="disclosure-body">
      <p className="muted">Pending purchases wait for posting. Posted purchases can become expenses for the assigned employee. Removed purchases remain visible for reconciliation.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <p>Loading transactions…</p>}
      {data && (data.transactions.length ? <ul className="ruled-list" aria-label="Plaid transactions">{data.transactions.map((transaction: D) => <li key={transaction.transaction_id}>
        <strong>{transaction.merchant}</strong> · {money(transaction.amount_minor, transaction.currency)}
        <p className="muted">{day(transaction.spent_on)} · {transactionStatus[transaction.status] ?? transaction.status} · account ends {connection.accounts.find((account: D) => account.id === transaction.account_id)?.last4}</p>
      </li>)}</ul> : <Empty title="No transactions received" />)}
    </div>
  </details>;
}

function Connection({ connection, state, cards, changed }: { connection: D; state: D; cards: D[]; changed: () => Promise<void> }) {
  const [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const path = `plaid/connections/${connection.id}`;
  const employees = state.members.filter((member: D) => member.active && member.is_employee && (connection.scope === 'company' || member.email === state.actor.email));
  return <div className="sub-form" aria-label={`${connection.scope === 'company' ? 'Company' : 'Personal'} Plaid connection`}>
    <h3>{connection.scope === 'company' ? 'Company feed' : 'Your personal card feed'}</h3>
    <p><span className={`chip tone-${connection.status === 'connected' ? 'done' : 'wait'}`} style={{ fontSize: 13 }}>{connection.status === 'connected' ? 'Connected' : 'Awaiting activation'}</span> · added {moment(connection.connectedAt)}{connection.lastSyncAt && ` · last synced ${moment(connection.lastSyncAt)}`}</p>
    <p role="status" aria-live="polite">{notice}</p>
    {connection.accounts.map((account: D) => {
      const assignment = connection.assignments.find((entry: D) => entry.account === account.id);
      return <div key={account.id} className="sub-form" aria-label={`Feed account ending ${account.last4}`}>
        <h4>Account ends {account.last4} · {account.subtype}</h4>
        <p>{assignment ? `Assigned to ${state.names[assignment.employee] ?? assignment.employee} · ${state.categories.find((category: D) => category.id === assignment.category)?.name ?? 'Category unavailable'}` : 'Assign an employee and category before importing expenses.'}</p>
        {assignment && <p className="muted">The employee and category stay fixed while connected. Disconnect this feed before changing its assignment.</p>}
        {connection.status === 'connected' && !assignment && <Details label="Assign this account"><Form label="Assign feed account" onSubmit={async values => {
          await call(path + '/assign', { ...values, account: account.id });
          await changed(); setNotice(`Account ending ${account.last4} assigned.`);
        }}>
          <Field label="Feed employee" name="employee" defaultValue={assignment?.employee} options={employees.map((member: D) => ({ value: member.email, label: member.name }))} />
          <Field label="Feed expense category" name="category" defaultValue={assignment?.category} options={state.categories.filter((category: D) => category.active).map((category: D) => ({ value: category.id, label: category.name }))} />
          {connection.scope === 'company' && <Field label="Existing company card" name="card" required={false} options={cards.filter(card=>card.last4===account.last4).map(card=>({value:card.id,label:`${card.issuer} ····${card.last4} · ${state.names[card.employee_email]??card.employee_email}`}))} hint="Choose the card already used for statement imports. Leave empty to create a new card record" />}
        </Form></Details>}
      </div>;
    })}
    {connection.status === 'connected' && <div className="sub-form"><Form label="Sync feed transactions" onSubmit={async () => {
      const result = await call(path + '/sync', {});
      await changed(); setRevision(value => value + 1);
      setNotice(`Sync complete: ${result.added} added, ${result.modified} modified, ${result.removed} removed; ${result.expenses} expenses created.`);
    }}><p className="muted field-wide">Only assigned accounts create expenses. Sync keeps pending, posted and removed transaction history.</p></Form></div>}
    <Transactions connection={connection} revision={revision} />
    <Details label="Disconnect this feed"><Form label="Disconnect Plaid feed" onSubmit={async values => {
      if (!values.consent) throw new Error('Confirm disconnect first.');
      await call(path + '/disconnect', {}); await changed();
    }}><Field label="I confirm this feed must stop future imports" name="consent" type="checkbox" /></Form></Details>
  </div>;
}

/** Native feed connections and estimated costs live together in Settings. */
export function PlaidFeeds({ state }: { state: D }) {
  const [data, setData] = useState<D>(), [settings, setSettings] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const owner = !!state.actor.roles.owner, company = owner || state.actor.roles.admin || state.actor.roles.finance;
  const load = useCallback(async () => {
    const [connections, configuration] = await Promise.all([call('plaid/connections'), owner ? call('plaid/settings') : Promise.resolve(undefined)]);
    setData(connections); setSettings(configuration); setError('');
  }, [owner]);
  useEffect(() => { load().catch(reason => setError(reason.message)); }, [load]);
  const costs = data?.costs;
  const capped = costs && costs.monthlyCapMinor != null && costs.accountMonthlyMinor != null && costs.monthToDateMinor + costs.accountMonthlyMinor > costs.monthlyCapMinor;
  return <Section title="Plaid transaction feeds" label="Plaid transaction feeds">
    <p>Connect company accounts or your own personal card through Plaid sandbox. Enter bank details only in Plaid Link. Personal connections are visible only to their owner.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {!data && !error && <p>Loading Plaid feeds…</p>}
    {costs && <Costs costs={costs} />}
    {settings && <Credentials data={settings} changed={async () => { await load(); setNotice('Plaid sandbox settings updated.'); }} />}
    {data && <>
      {data.connections.length ? data.connections.map((connection: D) => <Connection key={connection.id} connection={connection} state={state} cards={data.cards} changed={load} />) : <Empty title="No Plaid feeds connected" />}
      {!costs?.configured ? <p>Ask the owner to configure Plaid sandbox credentials and USD estimates.</p> : capped ? <p className="notice">The monthly estimate cap pauses new connections. You can still enter manual claims.</p> : <Details label="Connect a transaction feed"><Form label="Open Plaid Link" onSubmit={async (values, form) => {
        if (!values.consent) throw new Error('Authorize sharing accounts and the estimated costs first.');
        setNotice('');
        try {
          const result = await connect(values.scope);
          form.reset(); await load();
          setNotice(`Plaid feed connected: ${result.accounts.length} accounts · ${money(result.estimatedUsdMinor)} estimated USD this month.`);
        } catch (reason) { await load().catch(() => undefined); throw reason; }
      }}>
        <Field label="Feed scope" name="scope" options={[...(company ? [{ value: 'company', label: 'Company accounts' }] : []), ...(state.actor.roles.employee ? [{ value: 'personal', label: 'My personal card' }] : [])]} />
        <p className="field-wide">Estimate: {money(costs.accountMonthlyMinor)} USD per selected account each month. Selecting several accounts increases the estimate. The cap is {costs.monthlyCapMinor == null ? 'unlimited' : `${money(costs.monthlyCapMinor)} USD`}; {money(costs.monthToDateMinor)} USD is already estimated this month. A sign-in from the last 10 minutes is required.</p>
        <Field label="I authorize sharing selected accounts with Plaid sandbox, importing transactions and these estimated costs" name="consent" type="checkbox" />
      </Form></Details>}
    </>}
  </Section>;
}
