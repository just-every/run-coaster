import { all, commit, type Sql } from './session';
import { needRow, rowAuthority } from './permissions';
import { ruleEvent, event } from './events';
import { auditSample } from './audit-queue';
import { requireBusiness } from './settings';
import type { ClaimItem, PolicyException } from './exceptions';
import { decimal, now, optionalAmount, requireThat, uid, type Actor, type Data } from './types';

export type ApprovalRule = { version: number; enabled: number; limit_minor: number | null; set_by: string; set_at: string };

export const currentRule = (db: D1Database) => db.prepare('SELECT * FROM c_approval_rules ORDER BY version DESC LIMIT 1').first<ApprovalRule>();
/** How a rule approval is recorded wherever an approver's name would be. */
export const ruleLabel = (version: number) => `rule v${version}`;

/** The owner or an admin (ADMIN-001's business settings and approval workflows row) turns the rule on with the amount every
 * expense must be under, or off; each save is the next version. */
export async function saveApprovalRule(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'settings');
  requireThat(actor.kind === 'person', 'Only a person changes the approval rule', 403);
  await requireBusiness(db);
  const enabled = b.enabled === true || b.enabled === 'true' || b.enabled === 'on';
  const limit = optionalAmount(b.limit, 'Every expense under');
  requireThat(!enabled || (limit !== null && limit > 0), 'Set the amount every expense must be under to approve by rule');
  const version = ((await currentRule(db))?.version ?? 0) + 1;
  await commit(db, all(rowAuthority(actor, 'settings'), { sql: 'NOT EXISTS(SELECT 1 FROM c_approval_rules WHERE version>=?)', params: [version] }), [
    db.prepare('INSERT INTO c_approval_rules(version,enabled,limit_minor,set_by,set_at) VALUES(?,?,?,?,?)').bind(version, enabled ? 1 : 0, enabled ? limit : null, actor.delegate?.email ?? actor.email, now()),
    event(db, actor, 'approval-rule-set', {}, { version, enabled, limitMinor: enabled ? limit : null }),
  ]);
  return currentRule(db);
}

/** A claim approves itself under the rule only when every expense is a receipt expense with its receipt attached and
 * strictly under the rule's amount, and the submitted revision raises no policy exception at all. */
export function approvesByRule(rule: ApprovalRule | null, items: ClaimItem[], exceptions: PolicyException[]): rule is ApprovalRule {
  return !!rule?.enabled && rule.limit_minor !== null && !exceptions.length && items.every(i => i.kind === 'receipt' && !!i.receipt_id && i.amount_minor < rule.limit_minor!);
}

/** The submission write stands only while the rule it was judged under is still the current version. */
export const ruleStill = (rule: ApprovalRule): Sql => ({ sql: 'NOT EXISTS(SELECT 1 FROM c_approval_rules WHERE version>?)', params: [rule.version] });

/** Approves the revision just submitted, recorded as "rule vN" with its reason, sampled like any approval (POLICY-003). */
export function ruleApproval(db: D1Database, claimId: string, revision: number, rule: ApprovalRule, currency: string) {
  const by = ruleLabel(rule.version), reason = `Every expense under ${currency} ${decimal(rule.limit_minor!)} with its receipt and no policy exception`;
  return [
    db.prepare("INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of) VALUES(?,?,?,'approved',?,?,?,'[]',NULL)").bind(uid(), claimId, revision, reason, by, now()),
    auditSample(db, claimId, revision),
    ruleEvent(db, by, 'claim-approved', { claim: claimId }, { revision, rule: rule.version, limitMinor: rule.limit_minor, reason }),
  ];
}
