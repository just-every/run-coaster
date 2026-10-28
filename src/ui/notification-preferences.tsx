import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { call, moment } from './api';
import { Choice, Details, Empty, Field, Section } from './parts';

type Frequency = 'immediate' | 'digest';
type Preferences = { timezone: string; quietFrom: number; quietUntil: number; submission: Frequency; decision: Frequency; return: Frequency; reminder: Frequency; enabled: boolean };
type Delivery = { id: string; kind: string; status: string; attemptedAt: string; providerStatus: string | null; eventCount: number };
type Settings = { preferences: Preferences; deliveries: Delivery[] };
const kinds = [['submission', 'Claim submissions'], ['decision', 'Claim decisions'], ['return', 'Returned claims'], ['reminder', 'Reminders']] as const;
const frequency = [{ value: 'immediate', label: 'As it happens' }, { value: 'digest', label: 'Daily digest' }];
const hours = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` }));
const words: Record<string, string> = { submission: 'Claim submissions', decision: 'Claim decisions', return: 'Returned claims', reminder: 'Reminders', digest: 'Daily digest', immediate: 'Immediate email', accepted: 'Accepted', attempting: 'Attempt recorded', unconfigured: 'Mail not configured', sent: 'Sent', failed: 'Failed', suppressed: 'Not sent', pending: 'Pending' };
const payload = ({ enabled: _enabled, ...values }: Preferences) => values;

/** Personal email choices are isolated from the business policy and the acting-for session. */
export function NotificationPreferences() {
  const [data, setData] = useState<Settings>(), [preferences, setPreferences] = useState<Preferences>();
  const [status, setStatus] = useState(''), [error, setError] = useState('');
  const current = useRef<Preferences | undefined>(undefined), queue = useRef(Promise.resolve()), sequence = useRef(0);
  const lastQueued = useRef('');
  async function load() {
    try {
      const result: Settings = await call('settings/notifications');
      setData(result); setPreferences(result.preferences); current.current = result.preferences;
      lastQueued.current = JSON.stringify(payload(result.preferences)); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  function save() {
    if (!current.current) return;
    const values = payload(current.current), serialized = JSON.stringify(values);
    if (serialized === lastQueued.current) return;
    lastQueued.current = serialized;
    const request = ++sequence.current;
    setStatus('Saving…'); setError('');
    // Serialize changes so a slower earlier request cannot overwrite the latest choice.
    queue.current = queue.current.then(async () => {
      try {
        const result: Settings = await call('settings/notifications', values);
        setData(result);
        if (request === sequence.current) setStatus('Saved');
      } catch (e) {
        if (request === sequence.current) { lastQueued.current = ''; setStatus(''); setError((e as Error).message); }
      }
    });
  }
  function change(key: keyof Preferences, value: string | number, immediately = true) {
    if (!current.current) return;
    const next = { ...current.current, [key]: value };
    current.current = next; setPreferences(next);
    if (immediately) save();
  }
  return <Section title="Notifications" label="Notifications">
    <p>Email updates for your own account. Changes save automatically.</p>
    {!data && !error && <p role="status">Loading your preferences…</p>}
    {preferences && <>
      <p className="muted">Daily digests arrive at 09:00 in your time zone. Updates due during quiet hours wait until quiet hours end, including a digest due during that time. Matching start and end hours means no quiet hours.</p>
      {!data?.preferences.enabled && <p>Email notifications are off until you change a preference.</p>}
      <div className="record-form">
        <Field label="Your notification time zone" name="notificationTimezone" value={preferences.timezone} onChange={(e: ChangeEvent<HTMLInputElement>) => change('timezone', e.target.value, false)} onBlur={save} hint="An IANA time zone, such as Australia/Brisbane" />
        <Choice label="Your quiet hours start" name="notificationQuietFrom" value={String(preferences.quietFrom)} onChange={(e: ChangeEvent<HTMLSelectElement>) => change('quietFrom', Number(e.target.value))}>{hours.map(hour => <option key={hour.value} value={hour.value}>{hour.label}</option>)}</Choice>
        <Choice label="Your quiet hours end" name="notificationQuietUntil" value={String(preferences.quietUntil)} onChange={(e: ChangeEvent<HTMLSelectElement>) => change('quietUntil', Number(e.target.value))}>{hours.map(hour => <option key={hour.value} value={hour.value}>{hour.label}</option>)}</Choice>
        {kinds.map(([key, label]) => <Choice key={key} label={label} name={`notification-${key}`} value={preferences[key]} onChange={(e: ChangeEvent<HTMLSelectElement>) => change(key, e.target.value)}>{frequency.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Choice>)}
      </div>
      <p className="notice" role="status" aria-live="polite">{status}</p>
      <Details label="Email delivery history">
        {data?.deliveries.length ? <ul className="ruled-list">{data.deliveries.map(delivery => <li key={delivery.id}>
          <p>{words[delivery.kind] ?? delivery.kind} · {words[delivery.status] ?? delivery.status}</p>
          <p className="muted">{moment(delivery.attemptedAt)} · {delivery.eventCount} {delivery.eventCount === 1 ? 'update' : 'updates'}{delivery.providerStatus ? ` · ${delivery.providerStatus}` : ''}</p>
        </li>)}</ul> : <Empty title="No email deliveries yet" />}
      </Details>
    </>}
    {error && <><p className="form-error" role="alert">{error}</p><button className="button" onClick={() => preferences ? save() : void load()}>{preferences ? 'Retry saving preferences' : 'Retry loading preferences'}</button></>}
  </Section>;
}
