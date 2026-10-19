import { useState } from 'react';
import { apiHref, call, today, type D } from './api';
import { Field, Form, Section } from './parts';
import { Icon } from './icons';

const FIELDS: Record<string, string> = {
  accounting: 'batch, claim, employee, date, merchant, description, type, category, account_code, tax_code, cost_center, amount, currency, receipt_sha256, receipt_link, policy_exceptions, explanation, approved_by, approved_at, memo',
  reimbursements: 'batch, employee, name, claims, amount, currency',
};
const query = (template: string) => template ? `?template=${encodeURIComponent(template)}` : '';

/** A reviewed batch's files: accounting and reimbursements as CSV or XLSX through a chosen template, and IIF. */
export function BatchDownloads({ id, templates }: { id: string; templates: D[] }) {
  const [accounting, setAccounting] = useState(''), [people, setPeople] = useState('');
  const pick = (kind: string, value: string, set: (v: string) => void) => templates.some(t => t.kind === kind) && <label className="field"><span className="field-label">{kind === 'accounting' ? 'Accounting columns' : 'Reimbursement columns'}</span>
    <select value={value} onChange={e => set(e.target.value)}><option value="">Every field (default)</option>{templates.filter(t => t.kind === kind).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>;
  const link = (path: string, label: string) => <a className="button" href={apiHref(path)} download><Icon name="download" />{label}</a>;
  return <div className="downloads">
    {link(`batches/${id}/pdf`, 'Download claims PDF with receipts')}
    {pick('accounting', accounting, setAccounting)}
    {link(`batches/${id}/accounting.csv${query(accounting)}`, 'Download accounting CSV')}{link(`batches/${id}/accounting.xlsx${query(accounting)}`, 'Download accounting XLSX')}{link(`batches/${id}/accounting.iif`, 'Download QuickBooks Desktop IIF')}
    {pick('reimbursements', people, setPeople)}
    {link(`batches/${id}/reimbursements.csv${query(people)}`, 'Download reimbursements CSV')}{link(`batches/${id}/reimbursements.xlsx${query(people)}`, 'Download reimbursements XLSX')}
  </div>;
}

/** Period exports across every batch reviewed in a date range, and the column templates finance saves. */
export function Exports({ state, reload }: { state: D; reload: () => Promise<D> }) {
  const [period, setPeriod] = useState({ from: today().slice(0, 8) + '01', to: today(), kind: 'accounting', format: 'csv', template: '' });
  const set = (key: string) => (e: { target: { value: string } }) => setPeriod({ ...period, [key]: e.target.value, ...(key === 'kind' ? { template: '', format: 'csv' } : {}) });
  const templates: D[] = state.exportTemplates;
  const href = apiHref(`exports/${period.kind}.${period.format}?from=${period.from}&to=${period.to}${period.template && period.format !== 'iif' ? `&template=${encodeURIComponent(period.template)}` : ''}`);
  return <Section title="Exports" label="Exports">
    <div className="sub-form record-form">
      <label className="field"><span className="field-label">From</span><input type="date" value={period.from} onChange={set('from')} /></label>
      <label className="field"><span className="field-label">Until</span><input type="date" value={period.to} onChange={set('to')} /></label>
      <label className="field"><span className="field-label">File</span><select value={period.kind} onChange={set('kind')}><option value="accounting">Accounting lines</option><option value="reimbursements">Reimbursements</option></select></label>
      <label className="field"><span className="field-label">Format</span><select value={period.format} onChange={set('format')}><option value="csv">CSV</option><option value="xlsx">XLSX</option>{period.kind === 'accounting' && <option value="iif">QuickBooks Desktop IIF</option>}</select></label>
      {period.format !== 'iif' && <label className="field"><span className="field-label">Columns</span><select value={period.template} onChange={set('template')}><option value="">Every field (default)</option>{templates.filter(t => t.kind === period.kind).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
      <p className="muted field-wide">Every batch reviewed from the first date to the last, inclusive, in the business time zone.</p>
      <div className="form-end"><a className="button primary" href={href} download><Icon name="download" />Download period</a></div>
    </div>
    {templates.length > 0 && <ul className="ruled-list">{templates.map(t => <li key={t.id}>{t.name} · {t.kind} · {t.columns.map((c: D) => c.header).join(', ')}</li>)}</ul>}
    {state.actor.roles.finance && <div className="sub-form"><Form label="Save template" onSubmit={async (v, form) => {
      const columns = String(v.columns).split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [field, ...header] = line.split(':'); return { field: field.trim(), header: header.join(':').trim() }; });
      await call('export-templates', { name: v.name, kind: v.kind, columns }); form.reset(); await reload();
    }}>
      <Field label="Template name" name="name" placeholder="QuickBooks Online import" />
      <Field label="File" name="kind" options={[{ value: 'accounting', label: 'Accounting lines' }, { value: 'reimbursements', label: 'Reimbursements' }]} defaultValue="accounting" />
      <Field label="Columns" name="columns" type="textarea" placeholder={'date: Date\naccount_code: Account\namount: Amount'} hint={`One per line as field: Header. Accounting fields: ${FIELDS.accounting}. Reimbursement fields: ${FIELDS.reimbursements}.`} />
    </Form></div>}
  </Section>;
}
