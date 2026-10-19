import type { D1TargetAdapter, TargetRow } from '../../modules/import-kit/src/d1/index';

import { nativeKind, nativeMatch, nativeRows, nativeCount, readNative, writeNative, removeNative } from './native-targets';
import { importRedaction } from './redaction';
import { importDependencies } from './undo-dependencies';

const sql = (text: string, ...params: unknown[]) => ({ sql: text, params });
const row = (destination: string, r: any): TargetRow => ({ destination, targetKind: r.kind, targetId: r.id, revision: r.revision, value: JSON.parse(r.value) });

/** Imported history lives in c_history only: inert rows that never become claims, decisions or batches. */
export const historyTargetsFor = (timezone = 'UTC'): D1TargetAdapter => ({
  async redaction(db,destination,fields) { return importRedaction(this,db,destination,fields); },
  async read(db, destination, kind, id) {
    if (nativeKind(kind)) return readNative(db, destination, kind, id);
    const r = await db.prepare('SELECT * FROM c_history WHERE destination=? AND kind=? AND id=?').bind(destination, kind, id).first();
    return r ? row(destination, r) : undefined;
  },
  matches(r, d, k, id) {
    if (nativeKind(k)) return nativeMatch(r,k,id);
    return r ? sql('EXISTS(SELECT 1 FROM c_history WHERE destination=? AND kind=? AND id=? AND revision=? AND value=?)', d, k, id, r.revision, JSON.stringify(r.value)) : sql('NOT EXISTS(SELECT 1 FROM c_history WHERE destination=? AND kind=? AND id=?)', d, k, id);
  },
  matchesCount(n, d) { return sql(`(SELECT COUNT(*) FROM c_history WHERE destination=?) + ${nativeCount}=?`, d, n); },
  matchesMany(rows, d) { return [this.matchesCount!(rows.length, d), ...rows.map(r => this.matches(r, d, r.targetKind, r.targetId))]; },
  async preparePreservedUndo(db, destination, effects) {
    const rows = await this.list(db, destination), byKey = new Map(rows.map(r => [r.targetKind + ':' + r.targetId, r]));
    const dependencies = await importDependencies(db, effects, rows);
    return {
      observations: effects.map(e => ({ effectId: e.provenance.id, current: byKey.get(e.expected.targetKind + ':' + e.expected.targetId) ?? null, entity: { table: 'c_history', recordId: e.expected.targetId, field: e.expected.targetKind }, evidence: { reason: 'Complete current imported history row' } })),
      nativeRows: rows, dependencies: dependencies.dependencies, guards: [...this.matchesMany!(rows, destination), ...dependencies.guards],
    };
  },
  write(r) { if (nativeKind(r.targetKind)) return writeNative(r, timezone); return [sql('INSERT INTO c_history(destination,kind,id,revision,value) VALUES(?,?,?,?,?) ON CONFLICT(destination,kind,id) DO UPDATE SET revision=excluded.revision,value=excluded.value', r.destination, r.targetKind, r.targetId, r.revision, JSON.stringify(r.value))]; },
  remove(d, k, id) { if (nativeKind(k)) return removeNative(k,id,timezone); return [sql('DELETE FROM c_history WHERE destination=? AND kind=? AND id=?', d, k, id)]; },
  async list(db, d) { return [...(await db.prepare('SELECT * FROM c_history WHERE destination=? ORDER BY kind,id').bind(d).all()).results.map(r => row(d, r)), ...await nativeRows(db,d)]; },
});
export const historyTargets = historyTargetsFor();
