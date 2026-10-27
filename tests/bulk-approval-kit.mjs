import { agency } from './harness.mjs';

export const entry = (claim, extra = {}) => ({ id: claim.id, revision: claim.revision, version: claim.version, reviewed: true, acknowledge: true, ...extra });

export async function bulkClaims(h) {
  const team = await agency(h);
  const create = async (title, cookie = team.sam, amount = '140.00') => {
    let c = await h.post('claims', { title }, cookie);
    c = await h.post(`claims/${c.id}/items`, { version: c.version, kind: 'receipt', date: '2026-05-04', merchant: title, amount, explanation: `Client visit for ${title}; original receipt lost`, allocations: [{ category: team.c.meals }] }, cookie);
    return h.post(`claims/${c.id}/submit`, { version: c.version }, cookie);
  };
  const claims = [];
  for (const title of ['Client visit one', 'Client visit two', 'Client visit three']) claims.push(await create(title));
  return { team, claims, create };
}
