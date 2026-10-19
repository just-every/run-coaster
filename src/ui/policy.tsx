import { useEffect, useState, type ChangeEvent } from 'react';
import { call, day, money, type D } from './api';
import { Details, Empty, Field, Form, Section } from './parts';

const KINDS = [
  { value: 'per-expense-limit', label: 'Per-expense limit for a category' },
  { value: 'attendee-limit', label: 'Per-attendee limit for a category' },
  { value: 'daily-limit', label: 'Daily limit for a category' },
  { value: 'trip-limit', label: 'Trip limit for a category' },
  { value: 'monthly-limit', label: 'Monthly limit for a category' },
  { value: 'receipt-threshold', label: 'Receipt threshold' },
  { value: 'required-field', label: 'Required field for a category' },
  { value: 'blocked-category', label: 'Blocked category' },
  { value: 'blocked-merchant', label: 'Blocked merchant' },
  { value: 'weekend', label: 'Weekend spending' },
  { value: 'holiday', label: 'Holiday spending' },
  { value: 'approval-required', label: 'Approved spend request required' },
  { value: 'deadline', label: 'Submission deadline' },
];
const LIMITS: Record<string, string> = {
  'per-expense-limit': 'Per-expense limit', 'attendee-limit': 'Per-attendee limit',
  'daily-limit': 'Daily limit', 'trip-limit': 'Trip limit', 'monthly-limit': 'Monthly limit',
  'receipt-threshold': 'Receipt threshold',
};
const CATEGORY_KINDS = [...Object.keys(LIMITS).filter(kind => kind !== 'receipt-threshold'), 'blocked-category', 'approval-required', 'required-field'];
const LIMIT_HINTS: Record<string, string> = {
  'per-expense-limit': 'Adds a category limit per expense. Owner settings still apply; this rule cannot relax them.',
  'attendee-limit': 'Adds a category limit per attendee. Owner per-person limits still apply; this rule cannot relax them.',
  'daily-limit': 'Counts this employee’s category spending across claims that are not rejected, by expense date.',
  'trip-limit': 'Counts this employee’s category spending linked to the same approved spend request across claims that are not rejected.',
  'monthly-limit': 'Counts this employee’s category spending across claims that are not rejected, by calendar month.',
  'receipt-threshold': 'Requires a receipt above this amount across all categories. Owner receipt settings still apply; this rule cannot relax them.',
};

function ruleInput(r: D): D {
  const base = { kind: r.kind, hard: r.hard };
  if (LIMITS[r.kind]) return { ...base, ...(r.kind === 'receipt-threshold' ? {} : { category: r.category }), limit: (r.limit_minor / 100).toFixed(2) };
  if (r.kind === 'required-field') return { ...base, category: r.category, field: r.field };
  if (CATEGORY_KINDS.includes(r.kind)) return { ...base, category: r.category };
  if (r.kind === 'blocked-merchant') return { ...base, merchant: r.merchant };
  if (r.kind === 'deadline') return { ...base, days: r.days };
  return base;
}

function ruleWords(r: D, categories: D[], currency: string): string {
  const category = categories.find(c => c.id === r.category)?.name ?? 'A retired category';
  const period: Record<string, string> = { 'daily-limit': 'a day', 'trip-limit': 'per trip (approved spend request)', 'monthly-limit': 'a calendar month' };
  let description: string;
  if (r.kind === 'per-expense-limit') description = `${category}: at most ${money(r.limit_minor, currency)} per expense`;
  else if (r.kind === 'attendee-limit') description = `${category}: at most ${money(r.limit_minor, currency)} per attendee`;
  else if (r.kind === 'receipt-threshold') description = `Receipt required above ${money(r.limit_minor, currency)} in any category`;
  else if (r.kind === 'required-field') description = `${category}: ${r.field} is required`;
  else if (LIMITS[r.kind]) description = `${category}: at most ${money(r.limit_minor, currency)} ${period[r.kind]} per employee`;
  else if (r.kind === 'blocked-category') description = `${category} spending is blocked`;
  else if (r.kind === 'blocked-merchant') description = `${r.merchant} is blocked`;
  else if (r.kind === 'weekend') description = 'Saturday and Sunday spending is restricted';
  else if (r.kind === 'holiday') description = 'Spending on observed US federal holidays is restricted';
  else if (r.kind === 'approval-required') description = `${category}: link an approved spend request`;
  else if (r.kind === 'deadline') description = `Submit within ${r.days} days of spending`;
  else description = r.kind;
  return `${description} · ${r.hard ? 'hard (cannot submit)' : r.kind === 'approval-required' ? 'soft (explain; manager must record an override)' : 'soft (explain and acknowledge)'}`;
}

function ConfigurationSummary({ configuration, currency }: { configuration: D; currency: string }) {
  return <div>
    <p className="muted">Receipt threshold: {money(configuration.receipt_threshold_minor, currency)} · Preapproval threshold: {configuration.preapproval_threshold_minor == null ? 'off' : money(configuration.preapproval_threshold_minor, currency)}. {configuration.legacy_capture ? 'Owner settings captured during upgrade; earlier decisions keep their recorded exceptions.' : 'Owner settings captured with this version.'}</p>
    <ul className="ruled-list">{configuration.categories.map((c: D) => <li key={c.id}>
      {c.name}{!c.active && ' (retired)'} · expense limit: {c.limit_minor === null ? 'none' : money(c.limit_minor, currency)} · per-person limit: {c.per_person_limit_minor === null ? 'none' : money(c.per_person_limit_minor, currency)} · receipt: {c.receipt_always ? 'always required' : 'above threshold'} · required fields: {c.required_fields.length ? c.required_fields.join(', ') : 'none'}
    </li>)}</ul>
  </div>;
}

/** Each publication preserves both the rule set and its owner-controlled configuration. */
export function PolicyRules({ state, onNotice, onChanged }: { state: D; onNotice: (words: string) => void; onChanged: () => Promise<unknown> }) {
  const [versions, setVersions] = useState<D[]>(), [kind, setKind] = useState('daily-limit'), currency = state.business.currency;
  useEffect(() => { call('policy').then(r => setVersions(r.versions), () => setVersions(undefined)); }, [state]);
  if (!versions) return null;
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: state.business.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), current = versions.find(v => v.effective_from <= now), rules: D[] = current?.rules ?? [];
  const publish = async (next: D[], effectiveFrom: string | undefined, notice: string) => { const r = await call('policy', { effectiveFrom, rules: next }); setVersions(r.versions); await onChanged(); onNotice(notice); };
  return <Section title="Expense policy">
    <p className="muted">{current ? `Version ${current.version}, in effect since ${day(current.effective_from)}.` : 'No policy published yet.'} Each change publishes the next version from the day you choose; exceptions name the version that raised them, and claims already submitted keep theirs.</p>
    {rules.length ? <ul className="ruled-list">{rules.map((r, i) => <li key={i} className="job"><span>{ruleWords(r, current?.configuration?.categories ?? state.categories, currency)}</span><button className="button small" onClick={() => publish(rules.filter((_, j) => j !== i).map(ruleInput), undefined, 'Rule removed in a new version.')}>Remove</button></li>)}</ul> : <Empty title="No rules in effect" />}
    <Form label="Publish with this rule" onSubmit={(v, form) => publish([...rules.map(ruleInput), { kind, category: v.category, limit: v.limit, merchant: v.merchant, days: v.days, field: v.field, hard: v.hard }], v.effectiveFrom || undefined, 'Policy version published.').then(() => { form.reset(); setKind('daily-limit'); })}>
      <Field label="Rule" name="kind" options={KINDS} defaultValue="daily-limit" onChange={(e: ChangeEvent<HTMLSelectElement>) => setKind(e.target.value)} />
      {CATEGORY_KINDS.includes(kind) && <Field key={kind + '-category'} label="Category" name="category" options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />}
      {LIMITS[kind] && <Field key={kind + '-limit'} label={LIMITS[kind]} name="limit" inputMode="decimal" hint={LIMIT_HINTS[kind]} />}
      {kind === 'required-field' && <Field label="Required field name" name="field" maxLength={60} hint="Adds a required field for this category. Owner required fields still apply; this rule cannot relax them." />}
      {kind === 'blocked-merchant' && <Field label="Merchant to block" name="merchant" maxLength={200} hint="Matches the merchant name ignoring case and spacing." />}
      {kind === 'deadline' && <Field label="Days to submit within" name="days" type="number" min={1} max={3650} step={1} inputMode="numeric" hint="An expense exactly this many calendar days old is still in time." />}
      {kind === 'weekend' && <p className="muted">Applies to expenses dated Saturday or Sunday.</p>}
      {kind === 'holiday' && <p className="muted">Applies to expenses dated on an observed US federal holiday.</p>}
      {kind === 'approval-required' && <p className="muted">Expenses in this category need a linked approved spend request. A soft exception requires an explanation and the manager’s recorded override reason.</p>}
      <Field label="Takes effect" name="effectiveFrom" type="date" required={false} min={now} hint="Leave empty for today, in the business time zone" />
      <Field label="Hard rule (the claim cannot be submitted)" name="hard" type="checkbox" />
    </Form>
    {!!versions.length && <div className="sub-form"><h3>Versions</h3><ul className="ruled-list">{versions.map(v => <li key={v.version}>
      <Details label={`Version ${v.version} · from ${day(v.effective_from)}${v.effective_from > now ? ' (scheduled)' : current?.version === v.version ? ' (in effect)' : ''} · ${v.rules.length} ${v.rules.length === 1 ? 'rule' : 'rules'} · published by ${v.published_by}`}>
        {v.rules.length ? <ul className="ruled-list">{v.rules.map((r: D, i: number) => <li key={i}>{ruleWords(r, v.configuration?.categories ?? state.categories, currency)}</li>)}</ul> : <p className="muted">No additional rules.</p>}
        {v.configuration && <ConfigurationSummary configuration={v.configuration} currency={currency} />}
      </Details>
    </li>)}</ul></div>}
  </Section>;
}
