import type { D } from './api';
import { Icon } from './icons';

/** The minimum journey's first steps, each linking to the real step that completes it. */
export function FirstRun({ state }: { state: D }) {
  if (!state.actor.roles.owner) return <main className="panel section main-wide"><h1>Coaster is not set up yet</h1><p>The owner is still setting up the business. Claims open here once they finish.</p></main>;
  const steps = [
    { done: !!state.business, text: 'Name the business, its currency, timezone and mileage rate', href: '#/settings' },
    { done: state.categories.length > 0, text: 'Add the expense categories with their account and tax codes', href: '#/settings' },
    { done: state.members.some((m: D) => m.is_manager), text: 'Add people, their roles and each employee’s approving manager', href: '#/settings' },
  ];
  return <main className="panel section main-wide first-run">
    <h1>Set up Coaster</h1>
    <p>Three steps before the first claim. Each opens the setting that completes it.</p>
    <ol className="checklist">{steps.map(s => <li key={s.text} className={s.done ? 'done' : undefined}><span className="check-mark" aria-hidden="true">{s.done && <Icon name="check" />}</span><a href={s.href}>{s.text}</a>{s.done ? <span className="muted"> · done</span> : null}</li>)}</ol>
  </main>;
}
