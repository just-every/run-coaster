import { event, ruleEvent } from './events';
import { claimState, claimTotal, insertClaim } from './claims';
import { moveItems } from './holds';
import { privateMatchLine } from './receipts/card-matching';
import { queueMoves } from './delegation';
import { now, uid, type Actor, type Data } from './types';
import type { Sql } from './session';

/** What a departing person still holds that someone else must carry: approvals waiting on them (claims, spend requests,
 * workflow tasks, cash advances, by the role each needs) and unsubmitted card charges on their draft or returned reports. */
export async function openWork(db: D1Database, address: string) {
  const n = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number }>())!.n;
  const manager = await n("SELECT (SELECT COUNT(*) FROM c_workflow_tasks t WHERE t.email=? AND t.status='waiting' AND t.role='manager') + (SELECT COUNT(*) FROM c_claims WHERE approver_email=? AND status='submitted' AND NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c_claims.id AND t.revision=c_claims.revision)) + (SELECT COUNT(*) FROM c_requests WHERE approver_email=? AND status='submitted' AND workflow IS NULL) + (SELECT COUNT(*) FROM c_advances WHERE approver_email=? AND status='submitted') AS n", address, address, address, address);
  const finance = await n("SELECT COUNT(*) AS n FROM c_workflow_tasks WHERE email=? AND status='waiting' AND role='finance'", address);
  const cards = await n("SELECT COUNT(*) AS n FROM c_card_charges ch JOIN c_items i ON i.id=ch.item_id JOIN c_claims c ON c.id=i.claim_id WHERE ch.liability='company' AND ch.employee_email=? AND c.employee_email=? AND c.status IN ('draft','returned')", address, address);
  return { manager, finance, cards };
}

/** Individual charges stay with the original cardholder; deactivation grants no successor classification rights.
 * Everything a deactivation hands to the named successor in the same transaction as the deactivation itself: waiting
 * approvals (the roles each task needs), the person's reports and any department they head, and each unsubmitted card
 * charge. A private inbox original attached to a charge is detached first, on the departing person's own lifecycle, and
 * stays in their inbox: the successor never sees it. */
export async function handOver(db: D1Database, actor: Actor, from: string, to: string) {
  const by = actor.delegate?.email ?? actor.email, at = now(), guards: Sql[] = [{ sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1)', params: [to] }];
  const statements: D1PreparedStatement[] = [...await queueMoves(db, actor, from, to)];
  statements.push(
    db.prepare("UPDATE c_advances SET approver_email=?,on_behalf_of=NULL,version=version+1,updated_at=? WHERE approver_email=? AND status='submitted' AND employee_email<>?").bind(to, at, from, to),
    db.prepare("UPDATE c_members SET approver_email=?,updated_at=? WHERE approver_email=? AND email<>?").bind(to, at, from, to),
    db.prepare('UPDATE c_departments SET head_email=?,updated_at=? WHERE head_email=?').bind(to, at, from),
  );
  const rows = (await db.prepare(`SELECT i.id,i.claim_id,i.receipt_id,i.card_charge_id,c.version,c.title,c.auto_key,a.capture_receipt_id,
      (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle l WHERE l.receipt_id=a.capture_receipt_id) AS sequence
    FROM c_items i JOIN c_claims c ON c.id=i.claim_id AND c.employee_email=? AND c.status IN ('draft','returned') JOIN c_card_charges ch ON ch.id=i.card_charge_id AND ch.employee_email=? AND ch.liability='company'
    LEFT JOIN c_receipts a ON a.id=i.receipt_id ORDER BY c.number,i.position`).bind(from, from).all<Data>()).results;
  const targets = new Map<string, { id: string; position: number; fresh: boolean; version: number | null }>(), sources = new Map<string, number>(), totals = new Set<string>();
  for (const row of rows) {
    sources.set(row.claim_id, row.version);
    let target = targets.get(row.claim_id);
    if (!target) {
      const open = row.auto_key ? await db.prepare("SELECT c.id,c.version,(SELECT COALESCE(MAX(position),-1)+1 FROM c_items i WHERE i.claim_id=c.id) AS next FROM c_claims c WHERE c.employee_email=? AND c.auto_key=? AND c.status='draft' AND (SELECT COUNT(*) FROM c_items i WHERE i.claim_id=c.id)<100 ORDER BY c.number LIMIT 1").bind(to, row.auto_key).first<{ id: string; version: number; next: number }>() : null;
      target = open ? { id: open.id, position: open.next, fresh: false, version: open.version } : { id: uid(), position: 0, fresh: true, version: null };
      targets.set(row.claim_id, target);
      if (target.fresh) statements.push(insertClaim(db, target.id, to, row.title, (await db.prepare('SELECT currency FROM c_business WHERE id=1').first<{ currency: string }>())!.currency, null), ...(row.auto_key ? [db.prepare('UPDATE c_claims SET auto_key=? WHERE id=?').bind(row.auto_key, target.id)] : []));
      else guards.push(claimState(target.id, target.version!, ['draft']));
    }
    if (row.capture_receipt_id) {
      const rid = row.capture_receipt_id as string, seq = row.sequence as number;
      statements.push(
        db.prepare('UPDATE c_items SET receipt_id=NULL,receipt_resolution=NULL WHERE id=? AND claim_id=?').bind(row.id, row.claim_id),
        db.prepare("INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,claim_id,item_id,at,actor_email,on_behalf_of,channel) VALUES(?,?,'detached','',?,?,?,?,NULL,'app')").bind(rid, seq + 1, row.claim_id, row.id, at, by),
        db.prepare('INSERT OR IGNORE INTO c_card_match_rejections(receipt_id,charge_id,transaction_key,sequence) SELECT ?,id,transaction_key,? FROM c_card_charges WHERE id=?').bind(rid, seq + 1, row.card_charge_id),
        privateMatchLine(db, rid, seq + 2, 'match-withdrawn', by, null),
        ruleEvent(db, by, 'card-charge-unmatched', { claim: row.claim_id }, { charge: row.card_charge_id, reason: 'cardholder deactivated' }),
      );
    }
    const item = { id: row.id, receipt_id: row.capture_receipt_id ? null : row.receipt_id };
    statements.push(
      db.prepare('INSERT INTO c_card_handoffs(charge_id,from_email,to_email,from_claim,to_claim,detached_original,at,by_email) VALUES(?,?,?,?,?,?,?,?)').bind(row.card_charge_id, from, to, row.claim_id, target.id, row.capture_receipt_id ?? null, at, by),
      ...moveItems(db, [item], row.claim_id, target.id),
      db.prepare('UPDATE c_items SET position=? WHERE id=?').bind(target.position, row.id),
      db.prepare("UPDATE c_auto_coding_contexts SET employee_email=? WHERE target_kind='item' AND target_id=?").bind(to,row.id),
      db.prepare('UPDATE c_card_charges SET employee_email=?,claim_id=? WHERE id=?').bind(to, target.id, row.card_charge_id),
      event(db, actor, 'card-charge-handed-off', { claim: target.id }, { charge: row.card_charge_id, from, to, fromClaim: row.claim_id, detachedOriginal: !!row.capture_receipt_id }),
    );
    target.position++;
    totals.add(row.claim_id); totals.add(target.id);
  }
  for (const [claim, version] of sources) guards.push(claimState(claim, version, ['draft', 'returned']));
  statements.push(...[...totals].map(id => claimTotal(db, id)));
  return { statements, guards, charges: rows.length };
}
