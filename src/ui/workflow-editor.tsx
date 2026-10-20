import { useEffect, useState, type ChangeEvent } from 'react';
import { call, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

type Condition = { kind: 'always' | 'amount' | 'category' | 'project' | 'exception' | 'spend-request'; value: string };
type Reviewer = { kind: 'manager' | 'named' | 'finance'; email?: string };
type Rule = { label: string; condition: Condition; stages: Reviewer[][] };
type SelectChange = ChangeEvent<HTMLSelectElement>;
type InputChange = ChangeEvent<HTMLInputElement>;

const CONDITIONS = [
  { value: 'always', label: 'Every submission' },
  { value: 'amount', label: 'Amount strictly above' },
  { value: 'category', label: 'Includes category' },
  { value: 'project', label: 'Includes project' },
  { value: 'exception', label: 'Has a policy exception' },
  { value: 'spend-request', label: 'Spend request or linked expense' },
];
const REVIEWERS = [
  { value: 'manager', label: 'Employee’s approving manager' },
  { value: 'named', label: 'Named manager' },
  { value: 'finance', label: 'Named finance reviewer' },
];

function move<T>(items: T[], index: number, direction: number): T[] {
  const next = [...items], target = index + direction;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function ReviewerEditor({ reviewer, members, label, onChange, onRemove, disabled }: {
  reviewer: Reviewer; members: D[]; label: string; onChange: (reviewer: Reviewer) => void; onRemove: () => void; disabled: boolean;
}) {
  const people = members.filter(m => reviewer.kind === 'finance' ? m.is_finance : m.is_manager);
  const options = people.map(m => ({ value: m.email, label: `${m.name} (${m.email})` }));
  const unavailable = reviewer.email && !people.some(m => m.email === reviewer.email);
  return <div className="record-form field-wide">
    <Field label={`${label} type`} name={`${label}-kind`} options={REVIEWERS} value={reviewer.kind} onChange={(e: SelectChange) => onChange({ kind: e.target.value as Reviewer['kind'], ...(e.target.value === 'manager' ? {} : { email: '' }) })} />
    {reviewer.kind !== 'manager' && <Field label={`${label} person`} name={`${label}-email`} options={[...options, ...(unavailable ? [{ value: reviewer.email!, label: `${reviewer.email} (unavailable; choose an active reviewer)` }] : [])]} value={reviewer.email ?? ''} onChange={(e: SelectChange) => onChange({ ...reviewer, email: e.target.value })} />}
    <div className="form-end"><button type="button" className="button small" disabled={disabled} onClick={onRemove}>Remove {label.toLowerCase()}</button></div>
  </div>;
}

/** Owner-authored stages extend the manager or imported chain on new submissions. */
export function WorkflowEditor({ state, reload }: { state: D; reload: () => Promise<unknown> }) {
  const configuration = state.approvalWorkflow;
  const [rules, setRules] = useState<Rule[]>(() => configuration?.rules ?? []);
  const [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { setRules(configuration?.rules ?? []); }, [configuration]);
  const members: D[] = state.members.filter((m: D) => m.active);
  const categories = state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }));
  const changeRule = (index: number, next: Rule) => { setNotice(''); setRules(current => current.map((rule, i) => i === index ? next : rule)); };
  if (!state.actor.roles.owner) return null;

  return <Section title="Approval workflows">
    <p className="muted">Rules are matched when a claim or spend request is submitted. Matching rules add their stages in the order below, after the employee’s manager or imported approval chain. Stages run in sequence; every parallel reviewer in a stage must approve before the next stage opens. Existing submissions keep their recorded workflow.</p>
    <Form label="Save approval workflow" onSubmit={async () => {
      setSaving(true); setNotice('');
      try {
        for (const rule of rules) for (const stage of rule.stages) for (const reviewer of stage) {
          if (reviewer.kind !== 'manager' && !members.some(m => m.email === reviewer.email && (reviewer.kind === 'finance' ? m.is_finance : m.is_manager))) throw new Error('Choose an active person with the required role for every named reviewer.');
        }
        await call('settings/approval-workflow', { version: configuration?.version ?? 0, rules });
        await reload();
        setNotice('Approval workflow saved. New submissions use these rules.');
      } finally { setSaving(false); }
    }}>
      <fieldset className="field-wide" disabled={saving}><legend>Ordered rules</legend>
        {!rules.length && <Empty title="No additional approval stages">The employee’s manager or imported chain still applies.</Empty>}
        {rules.map((rule, index) => <fieldset className="sub-form" key={index}>
          <legend>Rule {index + 1}</legend>
          <div className="record-form">
            <Field label="Rule label" name={`rule-${index}-label`} value={rule.label} onChange={(e: InputChange) => changeRule(index, { ...rule, label: e.target.value })} />
            <Field label="Condition" name={`rule-${index}-condition`} options={CONDITIONS} value={rule.condition.kind} onChange={(e: SelectChange) => changeRule(index, { ...rule, condition: { kind: e.target.value as Condition['kind'], value: '' } })} />
            {rule.condition.kind === 'amount' && <Field label={`Amount (${state.business.currency})`} name={`rule-${index}-amount`} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={rule.condition.value} hint="Enter major currency units, such as 1000.00. An amount equal to this does not match; it must be strictly above." onChange={(e: InputChange) => changeRule(index, { ...rule, condition: { ...rule.condition, value: e.target.value } })} />}
            {rule.condition.kind === 'category' && <Field label="Category" name={`rule-${index}-category`} options={categories} value={rule.condition.value} onChange={(e: SelectChange) => changeRule(index, { ...rule, condition: { ...rule.condition, value: e.target.value } })} />}
            {rule.condition.kind === 'project' && <Field label="Project" name={`rule-${index}-project`} value={rule.condition.value} onChange={(e: InputChange) => changeRule(index, { ...rule, condition: { ...rule.condition, value: e.target.value } })} />}
            <div className="form-end">
              <button type="button" className="button small" disabled={index === 0} onClick={() => setRules(move(rules, index, -1))} aria-label={`Move rule ${index + 1} up`}>Move up</button>
              <button type="button" className="button small" disabled={index === rules.length - 1} onClick={() => setRules(move(rules, index, 1))} aria-label={`Move rule ${index + 1} down`}>Move down</button>
              <button type="button" className="button small" onClick={() => setRules(rules.filter((_, i) => i !== index))}>Remove rule {index + 1}</button>
            </div>
            {rule.stages.map((stage, stageIndex) => <fieldset className="field-wide" key={stageIndex}>
              <legend>Stage {stageIndex + 1} · all reviewers must approve</legend>
              {stage.map((reviewer, reviewerIndex) => <ReviewerEditor key={reviewerIndex} reviewer={reviewer} members={members} label={`Reviewer ${reviewerIndex + 1}`} disabled={stage.length === 1} onChange={next => changeRule(index, { ...rule, stages: rule.stages.map((s, i) => i === stageIndex ? s.map((r, j) => j === reviewerIndex ? next : r) : s) })} onRemove={() => changeRule(index, { ...rule, stages: rule.stages.map((s, i) => i === stageIndex ? s.filter((_, j) => j !== reviewerIndex) : s) })} />)}
              <div className="form-end">
                <button type="button" className="button small" onClick={() => changeRule(index, { ...rule, stages: rule.stages.map((s, i) => i === stageIndex ? [...s, { kind: 'manager' }] : s) })}>Add parallel reviewer</button>
                <button type="button" className="button small" disabled={stageIndex === 0} onClick={() => changeRule(index, { ...rule, stages: move(rule.stages, stageIndex, -1) })} aria-label={`Move stage ${stageIndex + 1} earlier`}>Earlier</button>
                <button type="button" className="button small" disabled={stageIndex === rule.stages.length - 1} onClick={() => changeRule(index, { ...rule, stages: move(rule.stages, stageIndex, 1) })} aria-label={`Move stage ${stageIndex + 1} later`}>Later</button>
                <button type="button" className="button small" disabled={rule.stages.length === 1} onClick={() => changeRule(index, { ...rule, stages: rule.stages.filter((_, i) => i !== stageIndex) })}>Remove stage {stageIndex + 1}</button>
              </div>
            </fieldset>)}
            <div className="form-end"><button type="button" className="button small" onClick={() => changeRule(index, { ...rule, stages: [...rule.stages, [{ kind: 'manager' }]] })}>Add sequential stage</button></div>
          </div>
        </fieldset>)}
        <div className="sub-form"><button type="button" className="button" onClick={() => { setNotice(''); setRules([...rules, { label: '', condition: { kind: 'always', value: '' }, stages: [[{ kind: 'manager' }]] }]); }}>Add rule</button></div>
      </fieldset>
      {notice && <p className="notice field-wide" role="status">{notice}</p>}
    </Form>
  </Section>;
}
