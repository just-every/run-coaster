import { useEffect, useState } from 'react';
import { call, day, money, type D } from './api';
import { PolicyChangePreview } from './policy-change-preview';
import { Details, Empty, Field, Form, Section } from './parts';

/** An internal deterministic assistant replays recorded category limits; its time saving is an explicit estimate. */
export function PolicyAdvice({ state, onChanged, onNotice }: { state: D; onChanged: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [replay, setReplay] = useState<D>(), [error, setError] = useState(''), [adopting, setAdopting] = useState(false);
  const currency = state.business.currency;
  useEffect(() => setReplay(undefined), [state]);
  const adopt = async (suggestion: D) => {
    setAdopting(true); setError('');
    try {
      const result = await call('policy/advice/adopt', { category: suggestion.category, proposalToken: suggestion.proposalToken, minutesPerException: suggestion.minutesPerException });
      setReplay(undefined); await onChanged(); onNotice(`Policy version ${result.policyVersion} adopted, effective ${day(result.effectiveFrom)}. Earlier decisions are unchanged.`);
    } catch (e) { setError((e as Error).message); }
    finally { setAdopting(false); }
  };
  return <Section title="Policy replay assistant">
    <p className="muted">Find rules repeatedly overridden and preview policy changes. This deterministic assistant uses recorded claims inside Coaster; it sends no data to a model. Review the affected expenses before the owner adopts a suggestion.</p>
    <Form label="Replay policy history" onSubmit={async v => { setReplay(await call('policy/advice', { minutesPerException: Number(v.minutes) })); setError(''); }}>
      <Field label="Estimated minutes per exception" name="minutes" type="number" min="0.01" max="1440" step="0.01" hint="Your estimate of review effort for one exception; savings use this input, not measured working time." />
    </Form>
    {replay && <>
      <p className="muted">Policy version {replay.policyVersion} · expense dates {day(replay.window.from)} through {day(replay.window.to)}. Replays each claim’s latest submitted revision; drafts, rejected claims and imported history do not supply approval evidence.</p>
      {!replay.suggestions.length ? <Empty title="No recurring approved limit exceptions">A suggestion needs at least three expenses with an acknowledged category-limit exception and an approval.</Empty> : <ul className="ruled-list">{replay.suggestions.map((s: D) => <li key={s.category}>
        <h3>{s.categoryName}: {money(s.currentLimitMinor, currency)} → {money(s.proposedLimitMinor, currency)} per expense</h3>
        <p>{s.approvedExceptions} acknowledged, approved expenses support this suggestion. Category-limit exceptions: {s.before} before, {s.after} after.</p>
        <p>Estimated review hours saved: {s.estimatedHoursSaved.toFixed(2)} · {s.minutesPerException} estimated minutes per avoided exception. Other policy rules still apply.</p>
        <Details label={`Affected claims (${s.affected.length})`}>
          <ul className="ruled-list">{s.affected.map((c: D) => <li key={c.id}>
            <a href={`#/claims/${c.id}`}>{c.number} · {c.title}</a> · revision {c.revision} · {c.before} → {c.after} category-limit exceptions
            <ul className="ruled-list">{c.expenses.map((i: D) => <li key={i.id}>{day(i.spentOn)} · {i.merchant} · {money(i.amountMinor, currency)} · {i.before} → {i.after}{i.approvedException ? ' · acknowledged and approved' : ''}</li>)}</ul>
          </li>)}</ul>
        </Details>
        {state.actor.roles.owner ? <button className="button" disabled={adopting} onClick={() => adopt(s)}>{adopting ? 'Adopting…' : `Adopt ${money(s.proposedLimitMinor, currency)} limit`}</button> : <p className="muted">The owner must review and adopt changes to category limits.</p>}
      </li>)}</ul>}
    </>}
    <PolicyChangePreview state={state} replay={replay} onChanged={onChanged} onNotice={onNotice} />
    {error && <p className="form-error" role="alert">{error}</p>}
  </Section>;
}
