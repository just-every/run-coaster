import { useEffect, useState } from 'react';
import { call, type D } from './api';
import { Field, Form, Section } from './parts';

/** Finance confirms a count, never a list of another employee's private originals. */
export function CaptureWindow() {
  const [settings, setSettings] = useState<D>(), [preview, setPreview] = useState<D>(), [error, setError] = useState('');
  const reload = () => call('settings/cash-draft-window').then(setSettings);
  useEffect(() => { reload().catch(e => setError(e.message)); }, []);
  return <Section title="Cash receipt draft window">
    <p className="muted">Off by default. After 1–90 elapsed days, an unmatched original can open a private draft claim with no amount. The employee must enter its details. Originals remain in their inbox; automatic attachment is not available. Nothing is submitted automatically. Up to 25 drafts open per hourly run.</p>
    {error && <p role="alert">{error}</p>}
    {settings && <><p role="status">Current window: {settings.days === null ? 'Off' : `${settings.days} days`}</p>
      <Form key={settings.version} label="Review cash draft window" onSubmit={async v => { setPreview(undefined); setPreview(await call('settings/cash-draft-window/preview', { days: v.days === '' ? null : Number(v.days) })); }}>
        <Field label="Cash draft window (days)" name="days" type="number" min={1} max={90} required={false} defaultValue={settings.days ?? ''} hint="Leave blank to turn off. Review the existing older-receipt count before confirming." />
      </Form>
      {preview && <div role="region" aria-label="Confirm cash draft window"><p>{preview.count} existing older unattached receipts will become eligible. Receipts are checked again before each draft opens.</p>
        <Form label={preview.days === null ? 'Confirm window off' : 'Confirm cash draft window'} onSubmit={async () => { await call('settings/cash-draft-window', preview); setPreview(undefined); await reload(); }}><p>{preview.days === null ? 'Turn the window off.' : `Use ${preview.days} days. Drafts need details and cannot pay or submit themselves.`}</p></Form>
      </div>}
    </>}
  </Section>;
}
