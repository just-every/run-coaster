import { applyD1ImportBatches, createD1ImportJob, planD1Import, readD1ImportJob, readD1ImportOriginals, readD1ImportUndoReport, resumeD1Import, undoD1Import, type D1ImportContext } from '../../modules/import-kit/src/d1/index';
import { authority, need } from '../session';
import { requireBusiness } from '../settings';
import { requireThat, type Actor, type Data } from '../types';
import { expensifySource, NAMESPACE } from './expensify';
import { historyTargets } from './target';

/** Jobs belong to the owner role, so a restored installation's owner can still resume or undo them. */
const PRINCIPAL = 'role:owner';

function context(db: D1Database, actor: Actor, mappingVersion: string): D1ImportContext {
  const guard = authority(actor, 'owner');
  return { destination: 'main', namespace: NAMESPACE, mappingVersion, reversalPolicy: 'preserve-conflicts', storage: { database: db as any, targets: historyTargets }, authorization: { principalId: PRINCIPAL, predicate: () => guard }, batchSize: 50, maxBatches: 4 } as D1ImportContext;
}

/** Preview writes nothing; commit applies only the exact previewed bytes and mapping; undo reverses the job. */
export async function importAction(db: D1Database, actor: Actor, op: string, b: Data) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person', 'Only the owner imports', 403);
  if (op === 'preview' || op === 'commit') {
    const business = await requireBusiness(db);
    const { source, mapping, summary } = expensifySource(b.csv, b.filename, b.mapping, business.currency);
    const ctx = context(db, actor, mapping.version), plan = await planD1Import(source, mapping, ctx);
    const review = { fingerprint: plan.fingerprint, mappingVersion: mapping.version, counts: plan.counts, summary };
    if (op === 'preview') return review;
    requireThat(!summary.errors.length && plan.counts.rejected === 0, 'Resolve the file errors before importing', 409);
    requireThat(b.fingerprint === plan.fingerprint, 'The file or mapping changed since the preview; preview again', 409);
    // An undone import of the same file stays on record under its key; importing it again is a new operation.
    const undone = await db.prepare("SELECT COUNT(*) AS n FROM ik_jobs WHERE destination='main' AND namespace=? AND fingerprint=? AND state='undone'").bind(NAMESPACE, plan.fingerprint).first<{ n: number }>();
    const job = await createD1ImportJob(plan, { ...ctx, reviewedFingerprint: b.fingerprint, operationKey: undone?.n ? `${plan.fingerprint}:${undone.n}` : plan.fingerprint });
    return { ...review, job: await applyD1ImportBatches(job.id, ctx) };
  }
  requireThat(typeof b.id === 'string' && typeof b.mappingVersion === 'string', 'Import job and mapping version are required');
  const ctx = context(db, actor, b.mappingVersion);
  if (op === 'resume') return { job: await resumeD1Import(b.id, ctx) };
  if (op === 'undo') return { job: await undoD1Import(b.id, ctx) };
  if (op === 'status') return { job: await readD1ImportJob(b.id, ctx), originals: await readD1ImportOriginals(b.id, ctx), undo: await readD1ImportUndoReport(b.id, ctx) };
  requireThat(false, 'Unknown import action', 404);
}

export async function importJobs(db: D1Database) {
  return (await db.prepare("SELECT id,mapping_version AS mappingVersion,fingerprint,state,checkpoint,total FROM ik_jobs WHERE destination='main' AND namespace=? ORDER BY rowid DESC").bind(NAMESPACE).all()).results;
}

export async function importedHistory(db: D1Database) {
  return (await db.prepare("SELECT kind,id,value FROM c_history WHERE destination='main' ORDER BY kind DESC, id").all<{ kind: string; id: string; value: string }>()).results.map(r => ({ kind: r.kind, id: r.id, ...JSON.parse(r.value) }));
}
