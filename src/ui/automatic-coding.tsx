import { useEffect, useState } from 'react';
import { call, type D } from './api';
import { CodingFields } from './coding';
import { Empty, Field, Form, Section } from './parts';

const boundary = 'coding/automatic';
const sources: Record<string,string> = { 'merchant-rule': 'Finance merchant rule', 'personal-rule': 'Personal merchant rule', 'learned-person': 'Your previous coding', 'learned-department': 'Department coding history', 'learned-company': 'Company coding history', 'merchant-category': 'Merchant category', 'receipt-entry': 'Coding entered on your receipt', receipt: 'Receipt reading' };
export const codingSource = (source: string) => sources[source] ?? source;

/** Merchant rules use the existing settings controls and current native authority. */
export function AutomaticCoding({ state }: { state: D }) {
  const finance = !!(state.actor.roles.owner || state.actor.roles.admin || state.actor.roles.finance);
  const allowed = finance || !!(state.actor.roles.employee || state.actor.roles.cardAdmin || state.actor.roles.manager);
  const [data, setData] = useState<D>(), [rates, setRates] = useState<D>(), [editing, setEditing] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function load() {
    const next = await call(`${boundary}/rules`);
    setData(next);
    if (finance) setRates(await call(`${boundary}/rates`));
  }
  useEffect(() => { if (allowed) load().catch(e => setError(e.message)); }, [allowed]);
  if (!allowed) return null;
  return <Section title="Automatic coding" label="Automatic coding">
    <p className="muted">Merchant rules fill empty fields. Finance rules take precedence over personal rules and learned coding. Your entered coding stays yours.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {data && <>
      {data.rules.length ? <ul className="ruled-list">{data.rules.map((rule: D) => <li key={rule.id}>
        <strong>{rule.merchant}</strong> · {rule.scope === 'finance' ? 'Finance rule' : 'Personal rule'}{!rule.active && ' · Inactive'}
        <p className="muted">{codingWords(rule.fields, state)}</p>
        {data.flags.filter((f: D) => f.rule_id === rule.id || f.rule === rule.id).map((f: D, i: number) => <p className="form-error" key={i}>{f.reason}</p>)}
        {(finance || rule.scope === 'personal') && <button type="button" className="button small" onClick={() => setEditing(rule)}>Change rule</button>}
      </li>)}</ul> : <Empty title="No merchant rules" />}
      <div className="sub-form"><h3>{editing ? `Change ${editing.merchant}` : 'Add a merchant rule'}</h3>
        <MerchantRuleForm key={editing?.id ?? `new:${data.version}`} state={state} finance={finance} rule={editing} onCancel={() => setEditing(undefined)} onSave={async input => {
          await call(`${boundary}/rules`, { ...input, id: editing?.id, version: data.version });
          setEditing(undefined); await load(); setNotice('Merchant rule saved.');
        }} />
      </div>
      {finance && <div className="sub-form"><h3>Merchant category mappings</h3>
        {data.mccMappings.length ? <ul className="ruled-list">{data.mccMappings.map((r: D) => <li key={r.id}>{r.merchant} · {codingWords(r.fields, state)}{!r.active && ' · Inactive'}<button type="button" className="button small" onClick={async () => { try { await call(`${boundary}/mcc`, { version: data.version, id: r.id, mcc: r.merchant, category: r.fields.category, active: !r.active }); await load(); } catch (e) { setError((e as Error).message); } }}>{r.active ? 'Deactivate mapping' : 'Activate mapping'}</button></li>)}</ul> : <Empty title="No merchant category mappings" />}
        <Form label="Save merchant category mapping" onSubmit={async (v, form) => { await call(`${boundary}/mcc`, { version: data.version, mcc: v.mcc, category: v.category, active: true }); await load(); setNotice('Merchant category mapping saved.'); form.reset(); }}>
          <Field label="Merchant category code" name="mcc" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} hint="Four-digit code supplied by a card program." />
          <Field label="Mapped category" name="category" options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />
        </Form>
      </div>}
      {finance && <div className="sub-form"><h3>Acceptance rates</h3>
        <p className="muted">Accepted and overridden suggestions count as decisions. Pending suggestions have no acceptance rate yet.</p>
        <Rates rates={rates} />
      </div>}
    </>}
  </Section>;
}

function MerchantRuleForm({ state, finance, rule, onSave, onCancel }: { state: D; finance: boolean; rule?: D; onSave: (v: D) => Promise<void>; onCancel: () => void }) {
  const [dimensions, setDimensions] = useState<Record<string,string>>(rule?.fields?.dimensions ?? {});
  return <Form label="Save merchant rule" onSubmit={async v => onSave({ merchant: v.merchant, scope: rule?.scope ?? v.scope ?? 'personal', active: v.active, coding: { category: v.category || undefined, dimensions, project: v.project || undefined, customer: v.customer || undefined, memo: v.memo || undefined } })} secondary={rule && <button type="button" className="button" onClick={onCancel}>Cancel</button>}>
    <Field label="Exact merchant" name="merchant" defaultValue={rule?.merchant} hint="Match the merchant name; letter case and surrounding spaces do not change the match." />
    {finance && !rule && <Field label="Rule scope" name="scope" options={[{ value: 'finance', label: 'Finance · all employees' }, { value: 'personal', label: 'Personal · only me' }]} defaultValue="finance" />}
    <Field label="Suggested category" name="category" required={false} defaultValue={rule?.fields?.category ?? ''} options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />
    <CodingFields catalog={state.coding} value={dimensions} categories={[]} onChange={setDimensions} enforceRequired={false} />
    <Field label="Suggested project" name="project" required={false} defaultValue={rule?.fields?.project} hint="For expenses using a free-text project. Catalog projects use the accounting choices above." />
    <Field label="Suggested customer" name="customer" required={false} defaultValue={rule?.fields?.customer} />
    <Field label="Suggested memo" name="memo" required={false} defaultValue={rule?.fields?.memo} />
    <Field label="Active merchant rule" name="active" type="checkbox" defaultValue={rule ? !!rule.active : true} />
  </Form>;
}

export function codingWords(coding: D, state: D) {
  return [coding.category && state.categories.find((c: D) => c.id === coding.category)?.name,
    ...Object.values(coding.dimensions ?? {}).map(id => state.coding.values.find((v: D) => v.id === id)?.name ?? 'Unavailable accounting choice'), coding.project, coding.customer, coding.memo].filter(Boolean).join(' · ');
}

export function CodingReasons({ evidence, state }: { evidence: D[]; state: D }) {
  const groups = new Map<string,D>();
  for (const entry of evidence) {
    const key = `${entry.source}:${entry.reason}`;
    const label = entry.field.startsWith('dimension:') ? state.coding.dimensions.find((d: D) => d.id === entry.field.slice(10))?.name ?? 'Accounting choice' : entry.field[0].toUpperCase() + entry.field.slice(1);
    if (!groups.has(key)) groups.set(key, { ...entry, labels: [] });
    groups.get(key)!.labels.push(label);
  }
  return <>{[...groups.entries()].map(([key, e]) => <p className="muted" key={key}>{e.labels.join(', ')} · {codingSource(e.source)} · {e.reason}</p>)}</>;
}

function Rates({ rates }: { rates?: D }) {
  if (!rates) return <p className="muted">Loading acceptance rates…</p>;
  const rows = [...rates.rules.map((r: D) => ({ ...r, label: `Rule · ${r.merchant}`, key: `rule:${r.id}` })), ...rates.sources.map((s: D) => ({ ...s, label: codingSource(s.source), key: `source:${s.source}` }))];
  return rows.length ? <ul className="ruled-list">{rows.map((r: D) => <li key={r.key}><strong>{r.label}</strong><p>{r.accepted} accepted · {r.overridden} overridden · {r.pending} pending{r.accepted + r.overridden > 0 ? ` · ${Math.round(r.accepted / (r.accepted + r.overridden) * 100)}% accepted` : ''}</p></li>)}</ul> : <Empty title="No coding decisions yet" />;
}

/** Evidence accompanies an expense; a native person decides through the guarded service. */
export function CodingSuggestions({ claim, item, state, editable, onDone }: { claim: D; item: D; state: D; editable: boolean; onDone: () => Promise<void> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const suggestions = item.codingSuggestions ?? [];
  if (!suggestions.length) return null;
  async function accept(suggestion: D) {
    setBusy(true); setError('');
    try { await call(`${boundary}/suggestions/${suggestion.id}/decision`, { claimVersion: claim.version, action: 'accept' }); await onDone(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="field-wide" aria-label={`Coding suggestions for ${item.merchant}`}>
    <details className="disclosure"><summary>Coding suggestions and decisions</summary><div className="disclosure-body">
      <ul className="ruled-list">{suggestions.map((s: D) => <li key={s.id}>
        <strong>{s.status === 'accept' ? 'Accepted' : s.status === 'override' ? 'Overridden' : 'Suggested coding'}</strong>
        <p>Suggested: {codingWords(s.fields, state)}</p>
        {s.status === 'override' && <p>Saved correction: {codingWords(s.feedback.values, state)}</p>}
        <CodingReasons evidence={s.evidence ?? []} state={state} />
        {editable && s.status === 'pending' && <button type="button" className="button small" disabled={busy} onClick={() => accept(s)}>Accept coding</button>}
      </li>)}</ul>
      {editable && <p className="muted">Use Change on this expense to correct its coding. The correction stays with the suggestion history.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div></details>
  </div>;
}
