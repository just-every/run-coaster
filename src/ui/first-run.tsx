import type { D } from './api';
import { Icon } from './icons';
import { PageHead } from './parts';
import { Work } from './shell';

/** The minimum journey's first steps, each linking to the real step that completes it. */
export function FirstRun({ state }: { state: D }) {
  if (!state.actor.roles.owner) return <Work><PageHead title="Coaster is not set up yet" line="The owner is still setting up the business. Claims open here once they finish." /></Work>;
  const steps = [
    { done: !!state.business, text: 'Name the business, its currency, timezone and mileage rate', href: '#/settings' },
    { done: state.categories.length > 0, text: 'Add the expense categories with their account and tax codes', href: '#/settings' },
    { done: state.members.some((m: D) => m.is_manager), text: 'Add people, their roles and each employee’s approving manager', href: '#/settings' },
  ];
  const left = steps.filter(s => !s.done).length;
  return <Work>
    <PageHead title="Set up Coaster" line={`Three steps before the first claim, ${left} still to do. Each opens the setting that completes it.`} />
    <section className="panel section first-run" aria-label="Setup steps">
      <ol className="checklist">{steps.map(s => <li key={s.text} className={s.done ? 'done' : undefined}><span className="check-mark" aria-hidden="true">{s.done && <Icon name="check" />}</span><a href={s.href}>{s.text}</a>{s.done ? <span className="muted">Done</span> : null}</li>)}</ol>
    </section>
  </Work>;
}
