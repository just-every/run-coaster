import { useEffect, useState } from 'react';
import { call, day, money, today, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const KINDS = [{ value: 'daily-limit', label: 'Daily limit for a category' }, { value: 'blocked-merchant', label: 'Blocked merchant' }, { value: 'deadline', label: 'Submission deadline' }];

/** Versioned policy rules (POLICY-001): finance publishes each change as the next version, in effect from its day;
 * every exception a rule raises names its version, and claims already submitted keep theirs. */
export function PolicyRules({ state, onNotice }: { state: D; onNotice: (words: string) => void }) {
  const [versions, setVersions] = useState<D[]>(), currency = state.business.currency;
  useEffect(() => { call('policy').then(r => setVersions(r.versions), () => setVersions(undefined)); }, []);
  if (!versions) return null;
  const now = today(), current = versions.find(v => v.effective_from <= now), rules: D[] = current?.rules ?? [];
  const name = (id: string) => state.categories.find((c: D) => c.id === id)?.name ?? 'A retired category';
  const words = (r: D) => `${r.kind === 'daily-limit' ? `${name(r.category)}: at most ${money(r.limit_minor, currency)} a day` : r.kind === 'blocked-merchant' ? `${r.merchant} is blocked` : `Submit within ${r.days} days of spending`} · ${r.hard ? 'hard (cannot submit)' : 'soft (explain and acknowledge)'}`;
  const toInput = (r: D) => r.kind === 'daily-limit' ? { kind: r.kind, category: r.category, limit: (r.limit_minor / 100).toFixed(2), hard: r.hard } : r.kind === 'deadline' ? { kind: r.kind, days: r.days, hard: r.hard } : { kind: r.kind, merchant: r.merchant, hard: r.hard };
  const publish = async (next: D[], effectiveFrom: string | undefined, notice: string) => { const r = await call('policy', { effectiveFrom, rules: next }); setVersions(r.versions); onNotice(notice); };
  return <Section title="Expense policy">
    <p className="muted">{current ? `Version ${current.version}, in effect since ${day(current.effective_from)}.` : 'No policy published yet.'} Each change publishes the next version from the day you choose; exceptions name the version that raised them, and claims already submitted keep theirs.</p>
    {rules.length ? <ul className="ruled-list">{rules.map((r, i) => <li key={i} className="job"><span>{words(r)}</span><button className="button small" onClick={() => publish(rules.filter((_, j) => j !== i).map(toInput), undefined, 'Rule removed in a new version.')}>Remove</button></li>)}</ul> : <Empty title="No rules in effect" />}
    <Form label="Publish with this rule" onSubmit={(v, form) => publish([...rules.map(toInput), { kind: v.kind, category: v.category, limit: v.limit, merchant: v.merchant, days: v.days, hard: v.hard }], v.effectiveFrom || undefined, 'Policy version published.').then(() => form.reset())}>
      <Field label="Rule" name="kind" options={KINDS} defaultValue="daily-limit" />
      <Field label="Category for the daily limit" name="category" required={false} options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />
      <Field label="Daily limit" name="limit" required={false} inputMode="decimal" />
      <Field label="Merchant to block" name="merchant" required={false} />
      <Field label="Days to submit within" name="days" required={false} inputMode="numeric" />
      <Field label="Takes effect" name="effectiveFrom" type="date" required={false} hint="Leave empty for today, in the business time zone" />
      <Field label="Hard rule (the claim cannot be submitted)" name="hard" type="checkbox" />
    </Form>
    {versions.length > 1 && <div className="sub-form"><h3>Versions</h3><ul className="ruled-list">{versions.map(v => <li key={v.version}>Version {v.version} · from {day(v.effective_from)} · {v.rules.length} {v.rules.length === 1 ? 'rule' : 'rules'} · published by {v.published_by}</li>)}</ul></div>}
  </Section>;
}
