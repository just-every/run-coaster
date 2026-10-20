/** Pass-through D1 network-edge barrier; results still come from real SQLite. */
export function databaseAtEdge(env: any): D1Database {
  if (!env.DB_GATE) return env.DB;
  const statement = (prepared: any, sql: string): any => new Proxy(prepared, {
    get(target, key) {
      if (key === 'bind') return (...args: any[]) => statement(target.bind(...args), sql);
      if (key === 'all') return async (...args: any[]) => {
        const result = await target.all(...args);
        if (sql.startsWith('SELECT receipt_id,sequence,reason FROM c_capture_lifecycle WHERE'))
          await env.DB_GATE.fetch('https://d1-edge.test/after-reason-read');
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
