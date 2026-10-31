import { useState } from 'react';
import { call, type D } from './api';
import { Field, Form } from './parts';

const causeWords = (e: D) => e.cause === 'recorded-failure'
  ? `Recorded feed error${e.failure ? ` at ${e.failure.at} (history #${e.failure.seq})` : ''}: ${e.error}. Coaster cannot tell whether the issuer delivered these dates.`
  : `Missing delivery: the last successful directory poll (${e.lastPollAt ?? 'none'}) found no validated file for these dates. A missing file does not show that sign-in or authentication failed.`;

/** The feed repair agent's proposal for one program feed, reviewed by the person it was prepared for. */
function Proposal({ proposal, reload }: { proposal: D; reload: () => Promise<void> }) {
  const e = proposal.evidence, [error, setError] = useState('');
  const decline = async () => { try { setError(''); await call(`feeds/repairs/${proposal.id}/decline`, {}); await reload(); } catch (err) { setError((err as Error).message); } };
  return <div role="group" aria-label="Repair proposal">
    <p><strong>{proposal.agent}:</strong> prepared {e.findings.length === 1 ? 'one repair task' : `${e.findings.length} repair tasks`} for your review.</p>
    <ul>{e.findings.map((x: D) => <li key={x.date}>Missed delivery {x.date} · deadline with grace {x.deadline} · health line #{x.health.seq} recorded {x.health.at} · <a href={`${x.report}&format=csv`}>Coverage report for {x.date}</a> · spend unknown until a validated delivery covers this date</li>)}</ul>
    <p>{causeWords(e)}</p>
    <p>Connection settings stay a human action: <a href={e.action.href}>{e.action.label}</a>. Nothing reconnects automatically.</p>
    <Form label="Open repair tasks" onSubmit={async values => { await call(`feeds/repairs/${proposal.id}/confirm`, { consent: values.consent }); await reload(); }} secondary={<button type="button" className="button" onClick={decline}>Decline proposal</button>}>
      <Field label="Open these tasks for me; no connection, credential or schedule changes" name="consent" type="checkbox" />
    </Form>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

/** Agent-prepared repair proposals and person-owned tasks of one program feed. Nothing here reconnects, changes
    credentials or the schedule, or treats a missing file as zero spend. */
export function FeedRepairs({ feed, repairs, me, reload }: { feed: D; repairs: D; me: string; reload: () => Promise<void> }) {
  const [analysis, setAnalysis] = useState<D>();
  const proposal = repairs.proposals.find((p: D) => p.feed === feed.id && p.status === 'proposed'), tasks = repairs.tasks.filter((t: D) => t.feed === feed.id);
  return <div role="group" aria-label={`Repair tasks for ${feed.issuer}`}>
    <h4>Repair tasks</h4>
    {feed.enabled && <Form label="Prepare repair proposal" onSubmit={async () => { setAnalysis((await call(`feeds/program/${feed.id}/repairs`, {})).analysis); await reload(); }}>
      <p className="field-wide">The feed repair agent compares recorded missed dates with validated deliveries and prepares tasks for you to confirm. It never reconnects the feed or treats a missing file as zero spend.</p>
    </Form>}
    {analysis && !proposal && <p role="status">{analysis.coverage === 'unverified' ? analysis.note : analysis.tracked.length ? `No new repair proposal: ${analysis.tracked.map((t: D) => `${t.date} is tracked by task #${t.seq}`).join(', ')}.` : 'No missed delivery date needs a new repair task.'}{analysis.awaiting.length > 0 && ` Awaiting the scheduled health check: ${analysis.awaiting.map((a: D) => a.date).join(', ')}.`}</p>}
    {proposal && <Proposal proposal={proposal} reload={reload} />}
    {tasks.length ? <ul>{tasks.map((task: D) => <li key={task.id}>
      <p>Repair task #{task.seq} · {task.date} · {task.status === 'resolved' ? 'Resolved' : 'Open'} · assigned to {task.assignee} · opened {task.openedAt} from the {task.agent} proposal · deadline {task.deadline} · health line #{task.health} · {task.cause === 'recorded-failure' ? 'recorded feed error' : 'missing delivery'}</p>
      {task.resolution ? <p>Resolved by {task.resolution.by} at {task.resolution.at} with validated delivery {task.resolution.file} (sequence {task.resolution.sequence}, health line #{task.resolution.health}).</p>
        : task.assignee === me && feed.enabled && <Form label={`Resolve task #${task.seq}`} onSubmit={async () => { await call(`feeds/repair-tasks/${task.id}/resolve`, {}); await reload(); }}><p className="field-wide">Resolve only after a validated delivery covers {task.date}; another date, an empty poll or an upload never does.</p></Form>}
    </li>)}</ul> : <p>No repair tasks for this feed.</p>}
  </div>;
}
