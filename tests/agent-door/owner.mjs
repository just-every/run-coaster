import assert from 'node:assert/strict';
import { api } from './http.mjs';
export default async function ({ request, origin, email, token, reviewers }) {
  const response = await request(new URL('/auth/bootstrap', origin).href, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, displayName: 'Avery Finance', returnTo: '/' }) });
  assert.equal(response.status, 303);
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const owner = api(request, origin, cookie), employeeEmail = 'synthetic-coaster-employee@example.com';
  await owner('/api/coaster/settings/business', { name: 'Synthetic Coaster', currency: 'USD', timezone: 'America/Chicago', perDiem: '50.00' });
  await owner('/api/coaster/settings/members', { email, name: 'Avery Finance', employee: true, manager: true, finance: true });
  await owner('/api/coaster/settings/members', { email: employeeEmail, name: 'Riley Employee', employee: true, approver: email });
  const category = await (await owner('/api/coaster/settings/categories', { name: 'Office supplies', accountCode: '6100', taxCode: 'NONE' })).json();
  await owner('/api/coaster/settings/members/invite', { email: employeeEmail });
  const employee = await reviewers.initialize('employee', { cookie });
  const person = api(request, origin, employee.cookie);
  let claim = await (await person('/api/coaster/claims', { title: 'Synthetic approved office expense' })).json();
  claim = await (await person(`/api/coaster/claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: '2026-10-29', merchant: 'Synthetic Office', amount: '1.00', allocations: [{ category: category.id }] })).json();
  claim = await (await person(`/api/coaster/claims/${claim.id}/submit`, { version: claim.version })).json();
  await owner(`/api/coaster/claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved' });
  for (const label of ['inactive', 'excluded']) {
    const address = `synthetic-coaster-${label}@example.com`;
    await owner('/api/coaster/settings/members', { email: address, name: `Synthetic ${label}`, employee: true });
    await owner('/api/coaster/settings/members/invite', { email: address });
    await reviewers.initialize(label, { cookie });
  }
  return response;
}
