// ADMIN-002 regeneration entry point; other clauses are unchanged.
if (process.argv.length === 3) process.argv.push('ADMIN-002');
await import('./contract-docs.mjs');
