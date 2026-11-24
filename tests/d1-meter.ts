/** Rows the database reported reading for every statement of the latest scheduled run, so a test can hold its cost to a ceiling. */
let latest = { rows: 0, statements: 0, unmetered: 0 };
export const lastScheduledReads = () => latest;

/** Pass-through binding that adds up each statement's `meta.rows_read`; results still come from real SQLite. */
export function meteredDatabase(db: D1Database): D1Database {
  const run = { rows: 0, statements: 0, unmetered: 0 };
  latest = run;
  const record = (meta: { rows_read?: number } | undefined) => {
    run.statements++;
    if (typeof meta?.rows_read === 'number') run.rows += meta.rows_read; else run.unmetered++;
  };
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement => new Proxy(prepared, {
    get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args));
      if (key === 'all' || key === 'run') return async () => { const result = await (target as any)[key](); record(result.meta); return result; };
      if (key === 'first') return async (column?: string) => {
        const result = await target.all<Record<string, unknown>>(); record(result.meta);
        const row = result.results[0] ?? null;
        return row && column !== undefined ? row[column] : row;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (key === 'batch') return async (prepared: D1PreparedStatement[]) => {
        const results = await target.batch(prepared);
        for (const result of results) record(result.meta);
        return results;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
