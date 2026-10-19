import { applyD1ImportBatches, createD1ImportJob, planD1Import, readD1ImportJob, readD1ImportOriginals, readD1ImportUndoReport, resumeD1Import, undoD1Import, type D1ImportContext } from '../../modules/import-kit/src/d1/index';
import { authority, need } from '../session';
import { requireBusiness } from '../settings';
import { requireThat, type Actor, type Data } from '../types';
import { expensifySource, NAMESPACE } from './expensify';
import { HISTORY_SOURCES, cardSource, type CardSource } from './cards';
import { historyTargetsFor } from './target';
import { configurationSource } from './configuration';
import { refuseErasedConcurSource } from './concur-custody';
import { concurSource } from './concur';
import { concurConfiguration } from './concur-policy';
import { categories } from '../items';

/** Jobs belong to the owner role, so a restored installation's owner can still resume or undo them. */
const PRINCIPAL = 'role:owner';

/** Each kit imports under its own namespace: Expensify reports (COA-011), one card tool's charges (MOVE-004) or one
 * Emburse product's expenses (MOVE-003). */
const NAMESPACES = [NAMESPACE, ...Object.keys(HISTORY_SOURCES), 'concur'];
const namespaceOf = (value: unknown) => { const ns = value === undefined || value === null || value === '' ? NAMESPACE : String(value); requireThat(NAMESPACES.includes(ns), 'Import from Expensify, Ramp, Brex, Navan, Certify, Chrome River or Abacus'); return ns; };

function context(db: D1Database, actor: Actor, mappingVersion: string, namespace: string, timezone = 'UTC'): D1ImportContext {
  const guard = authority(actor, 'owner');
  return { destination: 'main', namespace, mappingVersion, reversalPolicy: 'preserve-conflicts', storage: { database: db as any, targets: historyTargetsFor(timezone) }, authorization: { principalId: PRINCIPAL, predicate: () => guard }, batchSize: 50, maxBatches: 4 } as D1ImportContext;
}

/** The context ERASURE-001 erases imported history through: every import shares the destination. */
export const erasureContext = (db: D1Database, actor: Actor) => context(db, actor, 'erasure', NAMESPACE);

/** Preview writes nothing; commit applies only the exact previewed bytes and mapping; undo reverses the job. */
export async function importAction(db: D1Database, actor: Actor, op: string, b: Data) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person', 'Only the owner imports', 403);
  if (op === 'preview' || op === 'commit') {
    const business = await requireBusiness(db), namespace = namespaceOf(b.source);
    if(namespace==='concur' && b.configuration===undefined){const active=new Set((await categories(db)).filter(c=>c.active).map(c=>c.id));requireThat(Object.values(b.mapping?.categories??{}).every(id=>typeof id==='string'&&active.has(id)), 'Map Concur expense types to active categories');}
    const { source, mapping, summary } = namespace==='concur' ? b.configuration!==undefined ? await concurConfiguration(db,b.configuration,b.mapping?.crosswalk,business.timezone) : await concurSource(b.csv,b.filename,b.mapping,b.receipts,business.currency) : b.configuration !== undefined ? (requireThat(namespace in HISTORY_SOURCES && ['certify','chromeriver','abacus'].includes(namespace), 'Configuration move-in is for Emburse'), await configurationSource(db,namespace,b.configuration,b.mapping?.crosswalk)) : namespace === NAMESPACE ? expensifySource(b.csv, b.filename, b.mapping, business.currency) : cardSource(namespace as CardSource, b.csv, b.filename, b.mapping, b.receipts, business.currency);
    if (namespace === 'concur') await refuseErasedConcurSource(db, source);
    const ctx = context(db, actor, mapping.version, namespace, business.timezone), plan = await planD1Import(source, mapping, ctx);
    const review = { fingerprint: plan.fingerprint, mappingVersion: mapping.version, counts: plan.counts, summary };
    if (op === 'preview') return review;
    requireThat(!summary.errors.length && plan.counts.rejected === 0, 'Resolve the file errors before importing', 409);
    requireThat(b.fingerprint === plan.fingerprint, 'The file or mapping changed since the preview; preview again', 409);
    // An undone import of the same file stays on record under its key; importing it again is a new operation.
    const undone = await db.prepare("SELECT COUNT(*) AS n FROM ik_jobs WHERE destination='main' AND namespace=? AND fingerprint=? AND state='undone'").bind(namespace, plan.fingerprint).first<{ n: number }>();
    const job = await createD1ImportJob(plan, { ...ctx, reviewedFingerprint: b.fingerprint, operationKey: undone?.n ? `${plan.fingerprint}:${undone.n}` : plan.fingerprint });
    return { ...review, job: await applyD1ImportBatches(job.id, ctx) };
  }
  requireThat(typeof b.id === 'string' && typeof b.mappingVersion === 'string', 'Import job and mapping version are required');
  const ctx = context(db, actor, b.mappingVersion, namespaceOf(b.source), (await requireBusiness(db)).timezone);
  if (op === 'resume') return { job: await resumeD1Import(b.id, ctx) };
  if (op === 'undo') return { job: await undoD1Import(b.id, ctx) };
  if (op === 'status') return { job: await readD1ImportJob(b.id, ctx), originals: await readD1ImportOriginals(b.id, ctx), undo: await readD1ImportUndoReport(b.id, ctx) };
  requireThat(false, 'Unknown import action', 404);
}

export async function importJobs(db: D1Database) {
  return (await db.prepare(`SELECT id,namespace AS source,mapping_version AS mappingVersion,fingerprint,state,checkpoint,total FROM ik_jobs WHERE destination='main' AND namespace IN (${NAMESPACES.map(() => '?').join(',')}) ORDER BY rowid DESC`).bind(...NAMESPACES).all()).results;
}

export async function importedHistory(db: D1Database) {
  return (await db.prepare("SELECT kind,id,value FROM c_history WHERE destination='main' ORDER BY kind DESC, id").all<{ kind: string; id: string; value: string }>()).results.map(r => ({ kind: r.kind, id: r.id, ...JSON.parse(r.value) }));
}
