import type { D1Sql } from '../../modules/import-kit/src/d1/index';
import { replaceDiscardIdentity } from '../receipts/reasons.mjs';

/** Runtime retry and approval custody must follow native person erasure too. */
export async function eraseAgentCustody(db: D1Database, identity: {
  address: string; name: string; operator: { id: string; display_name: string } | null;
  subject: string; label: string; members: { email: string; name: string }[];
}): Promise<D1Sql[]> {
  const { address, name, operator, subject, label, members } = identity;
  const sql = (text: string, ...params: unknown[]): D1Sql => ({ sql: text, params });
  const statements: D1Sql[] = [
    // A deleted principal never gets a reusable execution or captured private request.
    sql('DELETE FROM agent_door_calls WHERE agent IN (SELECT id FROM c_agent_keys WHERE member_email=?) OR agent IN (SELECT id FROM agent_door_agents WHERE sponsor=?)', address, operator?.id ?? ''),
    sql("DELETE FROM agent_door_approvals WHERE json_extract(saved,'$.principal.person.id')=?", operator?.id ?? ''),
    sql("DELETE FROM agent_door_reviews WHERE json_extract(saved,'$.principal.person.id')=?", operator?.id ?? ''),
    sql('UPDATE agent_door_agents SET revoked=1,sponsor_name=? WHERE sponsor=?', label, operator?.id ?? ''),
  ];
  const text = (value: string) => {
    let result = replaceDiscardIdentity(value, members, address, name, subject, label);
    if (operator?.display_name && operator.display_name !== name) result = replaceDiscardIdentity(result, members, address, operator.display_name, subject, label);
    return result;
  };
  // Other sponsors can have approved context snapshots naming the departed person.
  // Redact string values while keeping JSON keys and the audit structure intact.
  const redact = (value: unknown, field = ''): unknown => typeof value === 'string'
    ? ['name', 'sponsor_name', 'label'].includes(field) ? text(value) : replaceDiscardIdentity(value, members, address, address, subject, label)
    : Array.isArray(value) ? value.map(item => redact(item, field))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)])) : value;
  const columns: [string, string, string[]][] = [
    ['agent_door_calls', 'rowid', ['outcome']], ['agent_door_approvals', 'id', ['saved', 'approvals', 'result']],
    ['agent_door_reviews', 'id', ['saved']], ['agent_door_audit', 'id', ['row', 'evidence']], ['agent_door_events', 'id', ['event']],
  ];
  for (const [table, key, fields] of columns) {
    const rows = (await db.prepare(`SELECT ${key} AS record,${fields.join(',')} FROM ${table}`).all<Record<string, unknown>>()).results;
    for (const row of rows) for (const field of fields) if (typeof row[field] === 'string') {
      const original = row[field] as string, replacement = JSON.stringify(redact(JSON.parse(original)));
      if (replacement !== original) statements.push(sql(`UPDATE ${table} SET ${field}=? WHERE ${key}=? AND ${field}=?`, replacement, row.record, original));
    }
  }
  for (const row of (await db.prepare('SELECT id,name,sponsor_name FROM agent_door_agents').all<{ id: string; name: string; sponsor_name: string }>()).results) {
    statements.push(sql('UPDATE agent_door_agents SET name=?,sponsor_name=? WHERE id=?', text(row.name), text(row.sponsor_name), row.id));
  }
  return statements;
}
