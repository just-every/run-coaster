import { loadPlans } from '../../modules/import-kit/src/d1/plans';
import { canonicalJson } from '../../modules/import-kit/src/d1/index';
import { need } from '../session';
import { requireThat, type Actor, type Data } from '../types';

/** A read-only inventory of every Expensify source record in each retained import.
 * Open history is expressly not a native claim or an authorization to pay. */
export async function cutoverReport(db: D1Database, actor: Actor) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person', 'Only the owner reads cutover reports', 403);
  const [jobs, history] = await db.batch([
    db.prepare("SELECT * FROM ik_jobs WHERE destination='main' AND namespace='expensify' ORDER BY rowid DESC"),
    db.prepare("SELECT kind,id,value FROM c_history WHERE destination='main' AND json_extract(value,'$.source')='expensify' ORDER BY kind,id"),
  ]);
  const plans = await loadPlans(jobs.results, db as any);
  const retained = new Map((history.results as Data[]).map(r => [`${r.kind}:${r.id}`, JSON.parse(r.value)]));
  const imports = (jobs.results as Data[]).map(job => {
    const plan = plans.get(job.id)!;
    const records = plan.entries.map((entry, ordinal) => {
      if (entry.erased) return { ordinal, kind: entry.source.kind, disposition: 'erased', amountMinor: null };
      const effect = entry.effects[0], value = (effect?.value ?? {}) as Data;
      const present = effect && retained.get(`${effect.targetKind}:${effect.targetId}`);
      const moved = !['undone', 'rolled_back'].includes(job.state) && present && canonicalJson(present) === canonicalJson(value);
      const sourceStatus = value.status ?? value.mappedStatus;
      const open = ['open', 'submitted', 'approved'].includes(sourceStatus);
      return { ordinal, kind: entry.source.kind, sourceId: entry.source.sourceId, artifact: entry.source.location.artifact,
        row: entry.source.location.row, report: value.report ?? value.reportId, employee: value.employee,
        label: value.name ?? value.merchant, sourceStatus, currency: value.currency,
        amountMinor: entry.source.kind === 'expense' ? value.amountMinor : value.totalMinor,
        disposition: moved ? open ? 'open-history' : 'history-only' : 'left-behind',
        reason: moved ? open ? 'Open in Expensify; retained as history, not carried into a payable claim' : 'Retained as read-only history'
          : ['undone', 'rolled_back'].includes(job.state) ? 'Import undone' : 'Not present as this imported record; inspect or resume the import' };
    });
    const count = (disposition: string) => records.filter(r => r.disposition === disposition).length;
    return { id: job.id, state: job.state, records, counts: { source: records.length, historyOnly: count('history-only'), openHistory: count('open-history'), leftBehind: count('left-behind'), erased: count('erased') },
      expenseTotalMinor: records.filter(r => r.kind === 'expense').reduce((sum, r) => sum + (r.amountMinor ?? 0), 0),
      openReports: records.filter(r => r.kind === 'report' && r.disposition === 'open-history').length };
  });
  return { imports, feedReconciled: false, openItemsCarried: false };
}
