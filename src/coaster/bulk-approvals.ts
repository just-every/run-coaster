import { decide } from './decisions';
import { Fault, requireThat, uid, type Actor, type Data } from './types';

/** Each claim commits independently through the ordinary guarded decision door. */
export async function bulkApprove(db: D1Database, actor: Actor, body: Data) {
  requireThat(actor.kind === 'person', 'Only a person decides claims', 403);
  requireThat(actor.roles.manager || actor.roles.finance, 'Approver access required', 403);
  const entries = body.claims;
  requireThat(Array.isArray(entries) && entries.length > 0 && entries.length <= 25, 'Select between one and 25 claims');
  requireThat(entries.every(entry => entry && typeof entry.id === 'string' && Number.isInteger(entry.revision) && Number.isInteger(entry.version)), 'Each claim needs its reviewed revision and version');
  requireThat(new Set(entries.map(entry => entry.id)).size === entries.length, 'Select each claim once');
  const bulkId = uid(), results = [];
  for (const entry of entries) {
    try {
      requireThat(entry.reviewed === true, 'Open and review each claim before approving', 409);
      const claim = await decide(db, actor, entry.id, { revision: entry.revision, version: entry.version, decision: 'approved', acknowledge: entry.acknowledge === true, override: entry.override }, { channel: 'bulk', bulkId });
      results.push({ id: entry.id, revision: entry.revision, approved: true, claimStatus: claim.status });
    } catch (error) {
      if (!(error instanceof Fault)) throw error;
      results.push({ id: entry.id, revision: entry.revision, approved: false, status: error.status, error: error.message });
    }
  }
  return { bulkId, results };
}
