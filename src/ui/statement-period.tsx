import { useState } from 'react';
import { amountText, call, day, money, moment, type D } from './api';
import { Field, Form } from './parts';

const names: Record<string, string> = { 'missing-charge': 'Missing charge', credit: 'Refund or credit', unclassified: 'Unclassified line', footing: 'Statement does not balance' };
export function StatementPeriod({ period: p, state, canClose, onChanged }: { period: D; state: D; canClose: boolean; onChanged: (message: string) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false), currency = state.business.currency;
  const totals: [string, number][] = [['Opening balance', p.openingMinor], ['Purchases on statement', p.purchasesMinor], ['Charges held in Coaster', p.heldMinor], ['Explained purchases', p.explainedMinor], ['Refunds and credits', p.creditsMinor], ['Acknowledged credits', p.creditsAccountedMinor], ['Payments', p.paymentsMinor], ['Fees', p.feesMinor], ['Interest', p.interestMinor], ['Coaster accounted balance', p.coasterMinor], ['Statement closing balance', p.statementMinor], ['Difference', p.differenceMinor]];
  return <section aria-label={`Statement period ${p.period.end} ····${p.card.last4}`} className="sub-form">
    <h3>{p.card.issuer} ····{p.card.last4} · period ending {day(p.period.end)}</h3>
    <ul className="ruled-list">{totals.map(([name, value]) => <li key={name} className="job"><span>{name}</span><strong>{money(value, currency)}</strong></li>)}</ul>
    <h3>Differences</h3>
    {!p.differences.length && <p>No differences found.</p>}
    <ul className="ruled-list">{p.differences.map((d: D) => <li key={`${d.kind}-${d.line}`}><div>
      <strong>{names[d.kind]} · {d.descriptor}</strong><p>{day(d.postedOn)} · {money(d.amountMinor, currency)}</p>
      {d.resolution ? <p>Resolved: {d.resolution.resolution === 'add' ? 'Added as a card expense' : d.resolution.resolution === 'explain' ? 'Explained in writing' : 'Credit acknowledged'}{d.resolution.note && ` · ${d.resolution.note}`} · {moment(d.resolution.resolved_at)}</p>
        : !d.resolvable ? <p role="status">Correct the statement file or its opening balance before closing. This difference cannot be explained away.</p>
        : canClose && p.status === 'open' ? <DifferenceForm difference={d} period={p} categories={state.categories} onChanged={onChanged} /> : <p>Awaiting finance resolution.</p>}
    </div></li>)}</ul>
    {p.status === 'closed' ? <>
      <p role="status">Closed {moment(p.closedAt)}. The card liability account {p.ledger.matches ? 'matches' : 'does not match'} the statement balance: {money(p.ledger.cardAccountMinor, currency)}. This period cannot be reopened.</p>
      <details className="disclosure"><summary>Card liability ledger entries</summary><div className="disclosure-body"><ol className="ruled-list">{p.ledger.entries.map((e: D) => <li key={e.seq}><span>{e.kind} · {day(e.posted_on)} · {money(e.amount_minor, currency)}<br />Debit: {e.debit_account}<br />Credit: {e.credit_account}<br />{e.memo}</span></li>)}</ol></div></details>
    </> : canClose && <>
      <details className="disclosure"><summary>Correct opening balance</summary><div className="disclosure-body"><Form key={p.openingMinor} label="Save opening balance" onSubmit={async v => { await call(`statements/${p.file}/reconcile`, { ...v, last4: p.card.last4, statementBalance: amountText(p.statementMinor) }); await onChanged('Opening balance saved.'); }}>
        <Field label="Corrected opening balance" name="openingBalance" inputMode="decimal" defaultValue={amountText(p.openingMinor)} hint="A later period must still open from its previous closed statement. The correction is recorded in history." />
      </Form></div></details>
      {p.unresolved || p.differenceMinor !== 0 ? <p>Resolve all {p.unresolved} differences and reach a zero balance difference before closing.</p> : <Form label="Close statement period" onSubmit={async () => {
        if (!confirm) throw new Error('Confirm the permanent close first.');
        await call(`statements/reconciliations/${p.id}/close`, {}); await onChanged('Statement period closed. The card liability account matches the statement balance.'); setConfirm(false);
      }}><Field label="I have reviewed the differences and confirm this permanent close" name="confirm" type="checkbox" checked={confirm} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.checked)} /><p className="muted field-wide">The ledger entries are written once. The period and its statement import cannot be undone after closing.</p></Form>}
    </>}
  </section>;
}

function DifferenceForm({ difference: d, period, categories, onChanged }: { difference: D; period: D; categories: D[]; onChanged: (message: string) => Promise<void> }) {
  const [resolution, setResolution] = useState(d.kind === 'credit' ? 'credit' : 'explain');
  return <Form label={d.kind === 'credit' ? 'Acknowledge credit' : 'Resolve missing charge'} onSubmit={async v => {
    await call(`statements/reconciliations/${period.id}/resolve`, { ...v, line: d.line, resolution }); await onChanged('Statement difference resolved.');
  }}>
    {d.kind !== 'credit' && <Field label="Resolve missing charge by" name="resolution" value={resolution} options={[{ value: 'explain', label: 'Explain in writing' }, { value: 'add', label: 'Add a card expense' }]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setResolution(e.target.value)} />}
    {resolution === 'add' && <Field label="Expense category" name="category" options={categories.filter(c => c.active).map(c => ({ value: c.id, label: c.name }))} />}
    <Field label={d.kind === 'credit' ? 'What this credit is for' : 'Resolution note'} name="note" type="textarea" required={resolution !== 'add'} maxLength={500} />
  </Form>;
}
