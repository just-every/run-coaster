import assert from 'node:assert/strict';
import { sponsors } from './state.mjs';
import { api } from './http.mjs';
export default async function ({ phase, request, origin, cookie }) {
  if (phase !== 'negative') return {};
  const owner = api(request, origin, cookie);
  const operators = await (await owner('/auth/operators')).json();
  const inactive = operators.find(p => p.email === sponsors.inactive.email);
  assert.ok(inactive, 'The inactive probe needs its real bound operator');
  await owner('/auth/operator/status', { operatorId: inactive.id, status: 'inactive' });
  await owner('/api/coaster/settings/members', { email: sponsors.excluded.email, name: 'Synthetic excluded', employee: true, active: false });
  return { sponsors };
}
