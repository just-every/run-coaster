import { useId, useState } from 'react';
import { call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const KINDS = ['account','class','location','department','project','customer','vendor','tag','cost-centre'].map(value => ({ value, label: value === 'cost-centre' ? 'Cost center' : value[0].toUpperCase() + value.slice(1) }));
const option = (v: D) => ({ value: v.id, label: v.name });
const source = (d: D) => d.source === 'native' ? 'Entered in Coaster' : 'QuickBooks';
export function offered(catalog: D, value: D, seen = new Set<string>()): boolean {
  const d = catalog.dimensions.find((d: D) => d.id === value.dimension_id);
  if (!d?.active || !value.active || seen.has(value.id)) return false;
  const parent = catalog.values.find((v: D) => v.id === value.parent_value_id && v.dimension_id === d.parent_id);
  return !d.parent_id || !!parent && offered(catalog,parent,new Set([...seen,value.id]));
}
function orderedDimensions(catalog: D): D[] {
  const result: D[] = [], pending: D[] = catalog.dimensions.filter((d: D) => d.active);
  while (pending.length) {
    const i = pending.findIndex(d => !d.parent_id || result.some(p => p.id === d.parent_id) || !pending.some(p => p.id === d.parent_id));
    if (i < 0) break;
    result.push(...pending.splice(i,1));
  }
  return result;
}
/** Each choice belongs to its selected parent; changing a level clears its dependent selections. */
export function CodingFields({ catalog, value, categories, onChange }: { catalog: D; value: Record<string,string>; categories: string[]; onChange: (next: Record<string,string>) => void }) {
  function select(dimension: string, id: string) {
    const next = { ...value }, cleared = new Set([dimension]);
    delete next[dimension]; if (id) next[dimension] = id;
    for (const d of orderedDimensions(catalog)) if (cleared.has(d.parent_id)) { delete next[d.id]; cleared.add(d.id); }
    onChange(next);
  }
  return <>{orderedDimensions(catalog).map(d => {
    const required = !!d.required || catalog.requirements.some((r: D) => categories.includes(r.category_id) && r.dimension_id === d.id && r.required);
    const choices = catalog.values.filter((v: D) => v.dimension_id === d.id && offered(catalog,v) && (!d.parent_id || v.parent_value_id === value[d.parent_id]));
    const unavailable = value[d.id] && !choices.some((v: D) => v.id === value[d.id]);
    const parent = catalog.dimensions.find((p: D) => p.id === d.parent_id);
    return <Field key={d.id} label={d.name} name={`coding:${d.id}`} required={required} value={value[d.id] ?? ''} options={[...choices.map(option), ...(unavailable ? [{ value: value[d.id], label: 'Unavailable; choose an active value' }] : [])]} onChange={(e: any) => select(d.id,e.target.value)} hint={`${source(d)}${required ? ' · required' : ' · optional'}${parent ? ` · choose ${parent.name} first` : ''}`} />;
  })}</>;
}

/** Owner/admin native catalogs, project ownership and category requirements. Provider facts stay provider-owned. */
export function CodingSettings({ state, reload }: { state: D; reload: () => Promise<unknown> }) {
  const catalog = state.coding, [editing, setEditing] = useState<D>(), [choice, setChoice] = useState<D>(), [dimension, setDimension] = useState(''), [category, setCategory] = useState(''), [notice, setNotice] = useState('');
  if (!state.actor.roles.owner && !state.actor.roles.admin) return null;
  const active = catalog.dimensions.filter((d: D) => d.active), selected = catalog.dimensions.find((d: D) => d.id === dimension);
  async function saved(path: string, input: D, message: string) { await call(path,{ ...input, version: catalog.version }); await reload(); setNotice(message); }
  const parents = selected?.parent_id ? catalog.values.filter((v: D) => v.dimension_id === selected.parent_id && offered(catalog,v)) : [];
  return <Section title="Accounting dimensions" label="Accounting dimensions">
    <p className="muted">Build your own tags, cost centers and projects, or import them from CSV. Each level can be required or optional. Ledger choices name their source; entering a catalog here does not connect a ledger.</p>
    {notice && <p className="notice" role="status">{notice}</p>}
    {catalog.dimensions.length ? <ul className="ruled-list">{catalog.dimensions.map((d: D) => <li key={d.id}>
      <strong>{d.name}</strong> · {source(d)} · {d.kind} · {d.required ? 'Required' : 'Optional'}{!d.active && ' · Archived'}{d.parent_id && ` · under ${catalog.dimensions.find((p: D) => p.id === d.parent_id)?.name}`}
      {d.source === 'native' && <button type="button" className="button small" onClick={() => setEditing(d)}>Edit level</button>}
      <button type="button" className="button small" onClick={() => { setDimension(d.id); setChoice(undefined); }}>Manage choices</button>
    </li>)}</ul> : <Empty title="No accounting dimensions" />}
    <div className="sub-form"><h3>{editing ? `Edit ${editing.name}` : 'Add a level'}</h3>
      <Form key={editing?.id ?? 'new'} label="Save level" onSubmit={async (v,form) => { await saved('coding/dimensions',{ ...v,id: editing?.id,kind: editing?.kind ?? v.kind,parent: editing?.parent_id ?? v.parent },'Accounting level saved.'); setEditing(undefined); form.reset(); }} secondary={editing && <button type="button" className="button" onClick={() => setEditing(undefined)}>Cancel</button>}>
        <Field label="Level name" name="name" defaultValue={editing?.name} />
        {!editing && <><Field label="Type of dimension" name="kind" options={KINDS} defaultValue="tag" /><Field label="Parent level" name="parent" options={active.map(option)} required={false} hint="Leave empty for an independent level" /></>}
        <Field label="Required on every expense" name="required" type="checkbox" defaultValue={!!editing?.required} />
        <Field label="Active" name="active" type="checkbox" defaultValue={editing ? !!editing.active : true} />
      </Form>
    </div>
    <div className="sub-form"><h3>Choices and project owners</h3>
      <Field label="Manage level" name="manageDimension" options={catalog.dimensions.map(option)} required={false} value={dimension} onChange={(e: any) => { setDimension(e.target.value); setChoice(undefined); }} />
      {selected && <>
        <ul className="ruled-list">{catalog.values.filter((v: D) => v.dimension_id === dimension).map((v: D) => <li key={v.id}>{v.name}{v.parent_value_id && ` · ${catalog.values.find((p: D) => p.id === v.parent_value_id)?.name}`}{v.owner_email && ` · owner ${v.owner_email}`}{!v.active && ' · Archived'}{(selected.source === 'native' || selected.kind === 'project') && <button type="button" className="button small" onClick={() => setChoice(v)}>Edit choice</button>}</li>)}</ul>
        {selected.active && (selected.source === 'native' || choice && selected.kind === 'project') && <Form key={`${dimension}:${choice?.id ?? 'new'}`} label={choice ? 'Save choice' : 'Add choice'} onSubmit={async (v,form) => { await saved('coding/values',{ ...v,id: choice?.id,dimension },'Accounting choice saved.'); setChoice(undefined); form.reset(); }} secondary={choice && <button type="button" className="button" onClick={() => setChoice(undefined)}>Cancel</button>}>
          {selected.source === 'native' && <><Field label="Choice name" name="name" defaultValue={choice?.name} />{selected.parent_id && <Field label="Parent choice" name="parent" options={parents.map(option)} defaultValue={choice?.parent_value_id} />}<Field label="Active" name="active" type="checkbox" defaultValue={choice ? !!choice.active : true} /></>}
          {selected.kind === 'project' && <Field label="Project owner" name="owner" required={false} options={state.members.filter((m: D) => m.active && m.is_manager).map((m: D) => ({ value: m.email,label: m.name }))} defaultValue={choice?.owner_email} hint="An active approver; project-owner workflow stages resolve this person at submission" />}
        </Form>}
      </>}
    </div>
    <div className="sub-form"><h3>Import a catalog</h3><Form label="Import coding CSV" onSubmit={async (v,form) => { const file = v.csvFile as File; if (!file?.size) throw new Error('Choose a CSV file.'); await saved('coding/import',{ csv: await file.text() },'Catalog imported.'); form.reset(); }}>
      <Field label="Coding CSV" name="csvFile" type="file" accept=".csv,text/csv" hint="Headers: dimension, parentDimension, kind, required, value, parentValue, owner. Use exact parent names. Existing native choices update by level, parent and name. A failed row imports nothing." />
    </Form></div>
    <div className="sub-form"><h3>Category requirements</h3>
      <Field label="Configure category" name="configureCategory" options={state.categories.filter((c: D) => c.active).map(option)} required={false} value={category} onChange={(e: any) => setCategory(e.target.value)} />
      {category && <Form key={`${category}:${catalog.version}`} label="Save category dimensions" onSubmit={async v => { await saved('coding/requirements',{ category,dimensions: active.filter((d: D) => v[`bound:${d.id}`] || v[`required:${d.id}`]).map((d: D) => ({ dimension: d.id,required: !!v[`required:${d.id}`] })) },'Category dimensions saved.'); }}>
        {active.map((d: D) => { const binding = catalog.requirements.find((r: D) => r.category_id === category && r.dimension_id === d.id); return <fieldset className="field-wide" key={d.id}><legend>{d.name}</legend><Field label={`Bind ${d.name} to this category`} name={`bound:${d.id}`} type="checkbox" defaultValue={!!binding} /><Field label={`Require ${d.name} for this category`} name={`required:${d.id}`} type="checkbox" defaultValue={!!binding?.required} /></fieldset>; })}
      </Form>}
    </div>
  </Section>;
}

/** Category chart-account choices use their provider identity separately from the manual accounting export code. */
export function CategoryAccountField({ catalog, category }: { catalog: D; category: D | null }) {
  const id = useId();
  const choices = catalog.values.filter((v: D) => catalog.dimensions.some((d: D) => d.id === v.dimension_id && d.kind === 'account') && offered(catalog,v));
  const unavailable = category?.ledger_account_id && !choices.some((v: D) => v.id === category.ledger_account_id);
  return <div className="field field-wide"><label className="field-label" htmlFor={id}>Mapped chart account</label>
    <select id={id} name="ledgerAccountId" defaultValue={category?.ledger_account_id ?? ''} aria-describedby={`${id}-hint`}>
      <option value="">No chart-account mapping</option>
      {unavailable && <option value={category.ledger_account_id} disabled>{category.ledger_account?.name ?? 'Saved mapping'} (unavailable)</option>}
      {choices.map((v: D) => { const d = catalog.dimensions.find((d: D) => d.id === v.dimension_id); return <option key={v.id} value={v.id}>{v.name} · {source(d)}{v.source_id ? ` · ${v.source_id}` : ''}</option>; })}
    </select>
  <span className="field-hint" id={`${id}-hint`}>Optional. Keeps the selected chart account and its source separately from the account code. This does not post anything to the ledger.{unavailable ? ' The saved account is unavailable; choose an active account or clear the mapping.' : ''}</span></div>;
}
