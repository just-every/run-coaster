import { useEffect, useState } from 'react';
import { call, type D } from './api';
import { Details, Field, Form, Section } from './parts';

const feedRoot = ['feeds', 'program'].join('/');
const columns = [['postedDate', 'Posted date column'], ['transactionId', 'Transaction ID column'], ['description', 'Merchant column'], ['amount', 'Amount column'], ['card', 'Card last four column'], ['sequence', 'Issuer sequence column'], ['transactionDate', 'Purchase date column'], ['currency', 'Currency column'], ['status', 'Status column'], ['type', 'Transaction type column'], ['mcc', 'Merchant category code column']];

/** Explicit connection of a read-only issuer delivery channel. Credentials are never returned to the browser. */
export function ProgramFeed({ state }: { state: D }) {
  const [data, setData] = useState<D>(), [error, setError] = useState('');
  async function load() { try { setData(await call(feedRoot)); setError(''); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { load(); }, []);
  return <Section title="Scheduled card program feed" label="Scheduled card program feed">
    <p>Connect an issuer’s SFTP directory of CSV deliveries with an explicit column mapping. Coaster reads files on the hourly schedule, keeps masked originals and imports each delivery once. Assign each card to its employee before the feed arrives. This connection does not issue cards or post a ledger entry.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {data?.feeds.map((feed: D) => <div className="sub-form" key={feed.id}>
      <h3>{feed.issuer}</h3><p>{feed.liability === 'individual' ? 'Employee pays issuer · approved business charges are reimbursable' : 'Company pays issuer · charges are not reimbursable'}</p><p>{feed.enabled ? 'Connected' : 'Disconnected'} · every {feed.intervalMinutes} minutes{Boolean(feed.enabled && feed.nextRunAt) && ` · next ${new Date(feed.nextRunAt).toISOString()}`}{Boolean(feed.lastSuccessAt) && ` · last received ${feed.lastSuccessAt}`}</p>
      {feed.error && <p role="alert">{feed.error}</p>}
      {feed.enabled && <Form label={`Disconnect ${feed.issuer}`} onSubmit={async values => { await call([feedRoot, feed.id, 'disconnect'].join('/'), { version: feed.version, consent: values.consent }); await load(); }}><Field label="I confirm this feed must stop future connections and imports" name="consent" type="checkbox" /></Form>}
      <Details label={`Deliveries from ${feed.issuer}`}><ul>{data.deliveries.filter((d: D) => d.feed_id === feed.id).map((delivery: D) => <li key={delivery.id}>{delivery.name} · sequence {delivery.issuer_sequence} · {delivery.charges} charges · {delivery.received_at}</li>)}</ul></Details>
    </div>)}
    <Details label="Connect an SFTP program feed"><Form label="Connect program feed" onSubmit={async (values, form) => {
      const key = values.privateKeyFile as File;
      if (!key?.size) throw new Error('Choose the private key authorized by your issuer');
      const mapping: D = { dateFormat: values.dateFormat, sign: values.sign };
      for (const [column] of columns) if (values[column]) mapping[column] = values[column];
      await call(feedRoot, { consent: values.consent, host: values.host, port: Number(values.port), username: values.username, privateKey: await key.text(), hostKeyFingerprint: values.hostKeyFingerprint, directory: values.directory, issuer: values.issuer, liability: values.liability, category: values.category, intervalMinutes: Number(values.intervalMinutes), mapping });
      form.reset(); await load();
    }}>
      <Field label="Issuer name" name="issuer" />
      <Field label="Card liability" name="liability" defaultValue="company" options={[{value: 'company', label: 'Company pays issuer'}, {value: 'individual', label: 'Employee pays issuer'}]} />
      <Field label="SFTP host IPv4 address" name="host" hint="Use the address supplied by your issuer; public IPv4 is required for hosted installations" />
      <Field label="SFTP port" name="port" type="number" defaultValue="22" min="1" max="65535" />
      <Field label="SFTP username" name="username" autoComplete="off" />
      <Field label="Pinned host key fingerprint" name="hostKeyFingerprint" placeholder="SHA256:…" hint="Confirm this independently with your issuer before connecting" />
      <label className="field field-wide"><span className="field-label">Issuer-authorized private key file</span><input name="privateKeyFile" type="file" required /></label>
      <Field label="Delivery directory" name="directory" defaultValue="/" />
      <Field label="Default expense category" name="category" options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />
      <Field label="Read every (minutes)" name="intervalMinutes" type="number" min="60" max="1440" step="60" defaultValue="60" />
      <Field label="CSV date format" name="dateFormat" defaultValue="YYYY-MM-DD" options={[{ value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' }, { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' }, { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' }]} />
      <Field label="CSV amount convention" name="sign" defaultValue="purchases-positive" options={[{ value: 'purchases-positive', label: 'Purchases positive' }, { value: 'purchases-negative', label: 'Purchases negative' }]} />
      {columns.map(([name, label], index) => <Field key={name} name={name} label={label} required={index < 6} />)}
      <p className="field-wide">The private key is sealed in this installation and excluded from archives. Coaster checks the pinned host key before authentication and only lists and reads this directory. It never writes to or deletes issuer files.</p>
      <Field label="I authorize scheduled read-only connections and imports from this issuer directory" name="consent" type="checkbox" />
    </Form></Details>
  </Section>;
}
