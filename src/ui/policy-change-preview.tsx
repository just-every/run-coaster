import { useEffect, useState, type ChangeEvent } from 'react';
import { call, day, money, type D } from './api';
import { Details, Empty, Field, Form } from './parts';
import { CATEGORY_KINDS, KINDS, LIMITS, ruleInput, ruleWords } from './policy';

function Effects({ preview: p, currency }: { preview: D; currency: string }) {
  return <>
    <p>Configurable policy exceptions: {p.before} before, {p.after} after. Estimated review hours saved: {p.estimatedHoursSaved.toFixed(2)} (negative means added effort).</p>
    <p className="muted">{p.population}</p>
    <p>Recorded approval time on affected claims: {p.approval.observedHoursOnAffectedClaims.toFixed(2)} hours. Estimated change in review effort: {p.approval.estimatedReviewHoursDelta.toFixed(2)} hours. Decision dates are not predicted.</p>
    <p>Counterfactual reimbursement eligibility: {money(p.reimbursement.eligibleBeforeMinor, currency)} → {money(p.reimbursement.eligibleAfterMinor, currency)}. Affected approved or batched spend awaiting payment: {money(p.reimbursement.awaitingReimbursementMinor, currency)}; already recorded paid: {money(p.reimbursement.recordedReimbursedMinor, currency)}. No payment or past decision changes.</p>
    <Details label={`Affected claims (${p.affected.length})`}><ul className="ruled-list">{p.affected.map((c: D) => <li key={c.id}>
      <a href={`#/claims/${c.id}`}>{c.number} · {c.title}</a> · revision {c.revision} · {c.before} → {c.after} exceptions{c.blockedAfter && ' · would need correction or an approved request'}
      <ul className="ruled-list">{c.expenses.map((i: D) => <li key={i.id}>{day(i.spentOn)} · {i.merchant} · {money(i.amountMinor, currency)}<p>Before: {i.before.map((e: D) => e.message).join('; ') || 'No configurable exception'}</p><p>After: {i.after.map((e: D) => e.message).join('; ') || 'No configurable exception'}</p></li>)}</ul>
    </li>)}</ul></Details>
  </>;
}

export function PolicyChangePreview({ state, replay, onChanged, onNotice }: { state: D; replay?: D; onChanged: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [rules, setRules] = useState<D[]>([]), [preview, setPreview] = useState<D>(), [kind, setKind] = useState('per-expense-limit'), [error, setError] = useState('');
  useEffect(() => { call('policy').then(r => { const today = new Intl.DateTimeFormat('en-CA', { timeZone: state.business.timezone }).format(new Date()); setRules((r.versions.find((v: D) => v.effective_from <= today)?.rules ?? []).map(ruleInput)); setPreview(undefined); }, e => setError(e.message)); }, [state]);
  const update = (next: D[]) => { setRules(next); setPreview(undefined); };
  const adopt = async () => { if (!preview) return; try { const r = await call('policy/advice/adopt', { proposedRules: preview.rules, proposalToken: preview.proposalToken, minutesPerException: preview.minutesPerException }); setPreview(undefined); await onChanged(); onNotice(`Policy version ${r.policyVersion} adopted, effective ${day(r.effectiveFrom)}. Earlier records are unchanged.`); } catch (e) { setError((e as Error).message); } };
  return <div className="sub-form">
    <h3>Compare a policy change</h3>
    <p className="muted">Prepare a different set of finance rules, including stricter limits. Owner settings keep applying. The owner reviews and adopts the exact preview.</p>
    {!!replay?.ruleSuggestions?.length && <><h4>Recurring approved exceptions</h4><ul className="ruled-list">{replay.ruleSuggestions.map((s: D) => <li key={s.ruleIndex}>
      {KINDS.find(k => k.value === s.kind)?.label}: {s.approvedExceptions} acknowledged approved expenses. <button className="button small" onClick={() => { setRules(s.rules); setPreview(s); }}>Preview removing this soft rule</button>
    </li>)}</ul></>}
    {rules.length ? <ul className="ruled-list">{rules.map((r, i) => <li key={i} className="job"><span>{ruleWords({ ...r, ...(r.limit ? { limit_minor: Math.round(Number(r.limit) * 100) } : {}) }, state.categories, state.business.currency)}</span><button className="button small" onClick={() => update(rules.filter((_, j) => i !== j))}>Remove from proposal</button></li>)}</ul> : <Empty title="No additional rules in this proposal" />}
    <Form label="Add to proposal" onSubmit={async v => { update([...rules, { kind, category: v.category, limit: v.limit, days: v.days, field: v.field, merchant: v.merchant, hard: v.hard === true }]); }}>
      <Field label="Proposed rule" name="kind" options={KINDS} defaultValue={kind} onChange={(e: ChangeEvent<HTMLSelectElement>) => setKind(e.target.value)} />
      {CATEGORY_KINDS.includes(kind) && <Field label="Proposed category" name="category" options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />}
      {LIMITS[kind] && <Field label="Proposed limit" name="limit" inputMode="decimal" />}
      {kind === 'deadline' && <Field label="Proposed days" name="days" type="number" min={1} max={3650} />}
      {kind === 'required-field' && <Field label="Proposed field" name="field" maxLength={60} />}
      {kind === 'blocked-merchant' && <Field label="Proposed merchant" name="merchant" maxLength={200} />}
      <Field label="Proposed hard rule" name="hard" type="checkbox" />
    </Form>
    <Form label="Preview proposed rules" onSubmit={async v => { setPreview(await call('policy/advice', { proposedRules: rules, minutesPerException: Number(v.minutes) }).then(r => r.preview)); setError(''); }}>
      <Field label="Estimated review minutes per exception" name="minutes" type="number" min="0.01" max="1440" step="0.01" />
    </Form>
    {preview && <><Effects preview={preview} currency={state.business.currency} />{state.actor.roles.owner ? <button className="button" onClick={adopt}>Adopt previewed rules</button> : <p className="muted">Prepared for the owner to review and adopt.</p>}</>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
