import { canonicalJson, sha256, type SourceRecord, type TargetRow } from '../../modules/import-kit/src/d1/index';
import { configurationSource } from './configuration';
import { categories } from '../items';
import { parseRule } from '../policy';
import { policyOn } from '../policy';
import { localDay } from '../delegation';
import { configurationSql } from '../policy-configuration';
import { requireThat, type Data } from '../types';
import { refuseConcurConfigurationData } from './concur-custody';

const sql = (sql: string, ...params: unknown[]) => ({ sql, params });
const latest = '(SELECT COALESCE(MAX(version),0) FROM c_policies)';
export const policyKind = 'concur-policy';
export const policyCount = "(SELECT COUNT(*) FROM c_concur_policy_imports)";

/** The translated envelope has only company-wide POLICY-001 rules. Unsupported source scopes/rules block adoption. */
export async function concurConfiguration(db: D1Database, raw: unknown, crosswalk: unknown, timezone: string, namespace: 'concur' | 'expensify' = 'concur') {
  const input = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Data;
  refuseConcurConfigurationData(input);
  requireThat(input && Array.isArray(input.policies ?? []) && (input.policies ?? []).length <= 20, 'Choose a Concur configuration with at most 20 policies');
  const base = await configurationSource(db, namespace, raw, crosswalk), errors = base.summary.errors;
  const policies = (input.policies ?? []) as Data[], known = await categories(db), current = await policyOn(db, localDay(timezone));
  for (const c of input.categories ?? []) if (!known.some(n => n.id === base.summary.crosswalk[c.key])) known.push({ id: base.summary.crosswalk[c.key], name: c.name, account_code: c.accountCode, tax_code: c.taxCode, limit_minor: null, active: 1, receipt_always: 0, per_person_limit_minor: null, required_fields: [] });
  const imported: Data[] = [];
  for (const policy of policies) {
    requireThat(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policy.key ?? '') && typeof policy.name === 'string' && policy.name.trim() && Array.isArray(policy.rules), 'Each Concur policy needs an opaque UUID key, name and rules');
    const extra = Object.keys(policy).filter(k => !['key', 'name', 'rules'].includes(k)); if (extra.length) errors.push(`Policy ${policy.name}: unsupported ${extra.join(', ')}`);
    for (const sourceRule of policy.rules) {
      const r = { ...sourceRule }, allowed = ['kind', 'hard', ...(['daily-limit','trip-limit','monthly-limit','per-expense-limit','attendee-limit'].includes(r.kind) ? ['category','limit'] : r.kind === 'required-field' ? ['category','field'] : ['blocked-category','approval-required'].includes(r.kind) ? ['category'] : r.kind === 'blocked-merchant' ? ['merchant'] : r.kind === 'deadline' ? ['days'] : r.kind === 'receipt-threshold' ? ['limit'] : [])];
      const unknown = Object.keys(r).filter(k => !allowed.includes(k)); if (unknown.length) { errors.push(`Policy ${policy.name}: unsupported rule fields ${unknown.join(', ')}`); continue; }
      if (r.category) r.category = base.summary.crosswalk[r.category] ?? r.category;
      try { imported.push(parseRule(r, known)); } catch (e) { errors.push(`Policy ${policy.name}: ${(e as Error).message}`); }
    }
  }
  const rules = [...new Map([...(current?.rules ?? []), ...imported].map(r => [canonicalJson(r), r])).values()];
  if (rules.length > 50 || rules.filter(r => r.kind === 'deadline').length > 1) errors.push('The merged Concur policy must have at most 50 rules and one deadline');
  if (new Set(policies.map(p => p.key)).size !== policies.length) errors.push('Each Concur policy needs a distinct opaque UUID key');
  base.source.artifacts[0].name = `${namespace}-configuration.json`;
  for (const r of base.source.records) r.location.artifact = `${namespace}-configuration.json`;
  base.summary.warnings = base.summary.warnings.filter(w => !/policies kept/.test(w));
  const policyValue = { rules, beforeRules: current?.rules ?? [], names: policies.map(p => p.name), effectiveFrom: localDay(timezone) };
  if (policies.length) {
    const payload = { policies }, record: SourceRecord = { namespace, kind: policyKind, sourceId: policies[0].key, payload, payloadHash: sha256(canonicalJson(payload)), artifactHash: base.source.artifacts[0].sha256, location: { artifact: `${namespace}-configuration.json` } };
    base.source.records.push(record);
  }
  const map = base.mapping.map;
  base.mapping = { version: sha256(canonicalJson({ kit: 'concur-configuration-v1', native: base.mapping.version, policyValue })), map: r => errors.length ? { effects: [], rejection: 'Resolve the Concur configuration errors before importing' } : r.kind === policyKind ? { effects: [{ targetKind: policyKind, targetId: `${namespace}:policy:${r.sourceId}`, value: policyValue }] } : map(r) };
  base.source.diagnostics = errors.map(message => ({ severity: 'error', code: 'CONCUR_CONFIGURATION', message }));
  return { ...base, summary: { ...base.summary, policies: policies.length, policyRules: imported.length } };
}

export async function readConcurPolicy(db: any, destination: string, id: string): Promise<TargetRow | undefined> {
  const row = await db.prepare(`SELECT *,policy_version=${latest} unchanged FROM c_concur_policy_imports WHERE id=?`).bind(id).first();
  if (!row) return undefined;
  return { destination, targetKind: policyKind, targetId: id, revision: row.revision, value: { ...JSON.parse(row.value), ...row.unchanged ? {} : { edited: true } } };
}
export function matchConcurPolicy(row: TargetRow | null | undefined, id: string) {
  if (!row) return sql('NOT EXISTS(SELECT 1 FROM c_concur_policy_imports WHERE id=?)', id);
  const { edited, ...value } = row.value as Data;
  return sql(`EXISTS(SELECT 1 FROM c_concur_policy_imports WHERE id=? AND revision=? AND value=? AND (policy_version=${latest})=?)`, id, row.revision, JSON.stringify(value), edited ? 0 : 1);
}
const append = (rules: unknown, day: string) => [
  sql(`INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) VALUES(${latest}+1,?,?,'role:owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, day, JSON.stringify(rules)),
  sql(`INSERT INTO c_policy_configurations(version,configuration) SELECT ${latest},${configurationSql} FROM c_business b WHERE b.id=1`),
];
const audit = (id: string, action: string) => sql("INSERT INTO c_events(id,seq,at,actor_email,action,claim_id,batch_id,detail) VALUES(lower(hex(randomblob(16))),(SELECT COALESCE(MAX(seq),0)+1 FROM c_events),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'role:owner',?,NULL,NULL,json_object('importPolicy',?,'policyVersion',(SELECT MAX(version) FROM c_policies)))", action, id);
export function writeConcurPolicy(row: TargetRow) {
  const v = row.value as Data;
  return [sql(`WITH actual AS (SELECT COALESCE((SELECT rules FROM c_policies WHERE effective_from<=? ORDER BY version DESC LIMIT 1),'[]') AS rules), expected AS (SELECT ? AS rules)
      INSERT INTO c_guard SELECT CASE WHEN
      NOT EXISTS(SELECT fullkey,type,atom FROM json_tree((SELECT rules FROM actual)) EXCEPT SELECT fullkey,type,atom FROM json_tree((SELECT rules FROM expected)))
      AND NOT EXISTS(SELECT fullkey,type,atom FROM json_tree((SELECT rules FROM expected)) EXCEPT SELECT fullkey,type,atom FROM json_tree((SELECT rules FROM actual)))
      THEN 1 ELSE 0 END`, v.effectiveFrom, JSON.stringify(v.beforeRules)),
    ...append(v.rules, v.effectiveFrom), sql(`INSERT INTO c_concur_policy_imports(id,revision,value,policy_version) VALUES(?,?,?,${latest}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value,policy_version=excluded.policy_version`, row.targetId, row.revision, JSON.stringify(v)), audit(row.targetId, 'import-policy-adopted'),sql('DELETE FROM c_guard')];
}
export function removeConcurPolicy(id: string, timezone: string) {
  const day = localDay(timezone);
  return [sql(`INSERT INTO c_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM c_concur_policy_imports WHERE id=? AND policy_version=${latest}) THEN 1 ELSE 0 END`, id),
    sql(`INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) SELECT ${latest}+1,?,json_extract(value,'$.beforeRules'),'role:owner',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM c_concur_policy_imports WHERE id=?`, day, id),
    sql(`INSERT INTO c_policy_configurations(version,configuration) SELECT ${latest},${configurationSql} FROM c_business b WHERE b.id=1`), audit(id, 'import-policy-undone'), sql('DELETE FROM c_concur_policy_imports WHERE id=?', id),sql('DELETE FROM c_guard')];
}
