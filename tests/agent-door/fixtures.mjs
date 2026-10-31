import assert from 'node:assert/strict';
import { sponsors } from './state.mjs';
import { api } from './http.mjs';
export const hiddenProposals = [];
export default async function ({ phase, request, origin, cookie }) {
  if (phase === 'autonomous') {
    const owner = api(request, origin, cookie);
    const state = await (await owner('/api/coaster/state')).json();
    let draft = await (await owner('/api/coaster/claims', { title: 'synthetic-coaster-3510' })).json();
    draft = await (await owner(`/api/coaster/claims/${draft.id}/items`, { version: draft.version, kind: 'mileage', date: '2026-10-29', merchant: 'synthetic-coaster-3511', distance: '2', allocations: [{ category: state.categories[0].id }] })).json();
    const preparation = await (await owner(`/api/coaster/preparations/expenses/${draft.id}`, {})).json();
    hiddenProposals.push(preparation.id);
  }
  if (phase !== 'negative') return {};
  const owner = api(request, origin, cookie);
  const operators = await (await owner('/auth/operators')).json();
  const inactive = operators.find(p => p.email === sponsors.inactive.email);
  assert.ok(inactive, 'The inactive probe needs its real bound operator');
  await owner('/auth/operator/status', { operatorId: inactive.id, status: 'inactive' });
  await owner('/api/coaster/settings/members', { email: sponsors.excluded.email, name: 'Synthetic excluded', employee: true, active: false });
  return { sponsors };
}
