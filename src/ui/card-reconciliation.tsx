import { useCallback, useEffect, useState } from 'react';
import { apiHref, call, day, money, moment, type D } from './api';
import { Badge, Empty, Field, Form, Section } from './parts';
import { StatementPeriod } from './statement-period';

/** The retained statement files and their permanent card-liability close. The API checks every action again. */
export function CardReconciliation({ state }: { state: D }) {
  const [data, setData] = useState<D>(), [periods, setPeriods] = useState<D[]>([]), [selected, setSelected] = useState<string>('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const reload = useCallback(async () => {
    const [files, reconciled] = await Promise.all([call('statements'), call('statements/reconciliations')]);
    setData(files); setPeriods(reconciled.statements); setError('');
  }, []);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  const canClose = state.actor.roles.owner || state.actor.roles.finance, currency = state.business.currency;
  const period = periods.find(p => p.id === selected);
  return <Section title="Card statements" label="Card statement reconciliation">
    <p className="muted">Reconcile an imported statement file against company-card charges. Finance resolves the differences and closes the period into Coaster’s card liability ledger. Closing is permanent.</p>
    {error && <p role="alert">{error} <button className="button small" onClick={() => reload().catch(e => setError(e.message))}>Try again</button></p>}
    <p role="status" aria-live="polite">{notice}</p>
    {!data && !error && <p className="muted">Loading card statements…</p>}
    {data && <>
      {periods.length ? <ul className="ruled-list">{periods.map(p => <li key={p.id} className="job"><span><strong>{p.card.issuer} ····{p.card.last4}</strong> · {day(p.period.end)}<br />{money(p.statementMinor, currency)} statement balance · <Badge status={p.status === 'closed' ? 'approved' : 'draft'} words={p.status === 'closed' ? 'Closed' : `${p.unresolved} unresolved`} /></span><button className="button small" onClick={() => { setSelected(p.id); setNotice(''); }}>Open period ending {p.period.end} ····{p.card.last4}</button></li>)}</ul> : <Empty title="No statement periods opened" />}
      {period && <StatementPeriod key={period.id} period={period} state={state} canClose={canClose} onChanged={async message => { await reload(); setNotice(message); }} />}
      {data.files.length ? <details className="disclosure"><summary>Imported statement files</summary><div className="disclosure-body"><ul className="ruled-list">{data.files.map((f: D) => <li key={f.id}><span><a href={apiHref(`statements/${f.id}/file`)}>{f.name}</a> · {f.issuer}<br />{f.label} · imported {moment(f.imported_at)}{f.period_end && ` · period ending ${day(f.period_end)}`}{f.undone_at && ' · undone'}</span></li>)}</ul></div></details> : <Empty title="No statement files imported">Import a documented CSV, OFX or QFX statement file before opening its period.</Empty>}
      {canClose && data.files.some((f: D) => !f.undone_at) && <details className="disclosure"><summary>Open a statement period</summary><div className="disclosure-body"><Form label="Open statement period" onSubmit={async v => {
        const opened = await call(`statements/${v.file}/reconcile`, v); await reload(); setSelected(opened.id); setNotice('Statement period opened. Review every difference before closing.');
      }}>
        <Field label="Statement file" name="file" options={data.files.filter((f: D) => !f.undone_at).map((f: D) => ({ value: f.id, label: `${f.name} · ${f.issuer}` }))} />
        <Field label="Card last four" name="last4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} hint="The card must already be assigned to an employee." />
        <Field label="Opening balance" name="openingBalance" required={false} inputMode="decimal" hint="Balance owed, or negative for a credit. Required for the first period; later periods use the previous close." />
        <Field label="Statement balance" name="statementBalance" required={false} inputMode="decimal" hint="For CSV only. OFX and QFX use the closing balance in the retained statement file." />
      </Form></div></details>}
    </>}
  </Section>;
}
