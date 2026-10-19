import type { Business } from './settings';
import type { Category } from './items';
import { localDay } from './delegation';
import type { Rule } from './policy';
import type { Sql } from './session';
import { requireThat } from './types';

export type Configuration = Pick<Business, 'receipt_threshold_minor' | 'preapproval_threshold_minor'> & { categories: Category[] };

/** Captured inside the same transaction as the version, after any owner settings write. */
export const configurationSql = `json_object('receipt_threshold_minor',b.receipt_threshold_minor,'preapproval_threshold_minor',b.preapproval_threshold_minor,'categories',json(COALESCE((SELECT json_group_array(json_object('id',id,'name',name,'active',active,'limit_minor',limit_minor,'per_person_limit_minor',per_person_limit_minor,'receipt_always',receipt_always,'required_fields',json(required_fields))) FROM c_categories),'[]')))`;
export const captureConfiguration = (db: D1Database, version: number | null = null) => db.prepare(`INSERT INTO c_policy_configurations(version,configuration) SELECT ${version === null ? '(SELECT MAX(version) FROM c_policies)' : '?'},${configurationSql} FROM c_business b WHERE b.id=1`).bind(...(version === null ? [] : [version]));

/** Owner-controlled policy settings changes are immediately effective versions, keeping the active finance rules. */
export function ownerPolicyVersion(db: D1Database, actor: string, timezone: string, at: string) {
  const day = localDay(timezone);
  return [
    db.prepare("INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) SELECT COALESCE(MAX(version),0)+1,?,COALESCE((SELECT rules FROM c_policies WHERE effective_from<=? ORDER BY version DESC LIMIT 1),'[]'),?,? FROM c_policies").bind(day, day, actor, at),
    captureConfiguration(db),
  ];
}

/** Resolve the policy version once; every threshold and field check uses its captured configuration. */
export async function policyConfiguration(db: D1Database, business: Business, known: Category[], version?: number) {
  const row = await db.prepare(`SELECT p.version,p.rules,c.configuration FROM c_policies p JOIN c_policy_configurations c ON c.version=p.version WHERE ${version === undefined ? 'p.effective_from<=?' : 'p.version=?'} ORDER BY p.version DESC LIMIT 1`).bind(version ?? localDay(business.timezone)).first<{ version: number; configuration: string; rules: string }>();
  requireThat(row, 'The active policy configuration is missing; ask the owner to save the business settings', 409);
  const configuration: Configuration = JSON.parse(row.configuration);
  const values = new Map(configuration.categories.map(c => [c.id, c]));
  return { business: { ...business, receipt_threshold_minor: configuration.receipt_threshold_minor, preapproval_threshold_minor: configuration.preapproval_threshold_minor }, categories: known.map(c => ({ ...c, ...(values.get(c.id) ?? { limit_minor: null, per_person_limit_minor: null, receipt_always: 0, required_fields: [] }) })) as Category[], version: row.version, rules: JSON.parse(row.rules) as Rule[] };
}

/** An effective version cannot change between checking a submission and committing it. */
export const policyStill = (version: number | undefined, timezone: string): Sql => ({ sql: 'COALESCE((SELECT version FROM c_policies WHERE effective_from<=? ORDER BY version DESC LIMIT 1),0)=?', params: [localDay(timezone), version ?? 0] });
