/** Reads a test can hold at the D1 edge: the start of the statement's SQL, the read method and the barrier path it calls. */
const gates = [
  { sql: 'SELECT receipt_id,sequence,reason FROM c_capture_lifecycle WHERE', method: 'all', path: 'after-reason-read' },
  { sql: 'SELECT COALESCE(SUM(i.amount_minor),0) AS n FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE i.allowance_id=?', method: 'first', path: 'after-allowance-read' },
];

/** Pass-through D1 network-edge barrier; results still come from real SQLite. */
export function databaseAtEdge(env: any): D1Database {
  if (!env.DB_GATE) return env.DB;
  const statement = (prepared: any, sql: string): any => new Proxy(prepared, {
    get(target, key) {
      if (key === 'bind') return (...args: any[]) => statement(target.bind(...args), sql);
      const gate = gates.find(g => g.method === key && sql.startsWith(g.sql));
      if (gate) return async (...args: any[]) => {
        const result = await target[key](...args);
        await env.DB_GATE.fetch(`https://d1-edge.test/${gate.path}`);
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql), sql);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
