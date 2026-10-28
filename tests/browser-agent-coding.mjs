import assert from 'node:assert/strict';
import { api, PEOPLE } from './browser-journey.mjs';

/** The existing preparation surface, with explicit employee confirmation of the exact before and after coding. */
export async function codingScreens({ owner, employee, origin, width, tag, shot }) {
  const call = (path, body) => api(owner.context, origin, path, body);
  const state = await call('state'), category = name => state.categories.find(c => c.name === name).id;
  const merchant = `Reviewed card purchase ${width} ${tag}`;
  await call(['statements', 'cards'].join('/'), { issuer: `synthetic-coaster-${width}`, last4: '1111', employee: PEOPLE.employee });
  const input = { format: 'csv', name: `synthetic-coaster-${width}.csv`, issuer: `synthetic-coaster-${width}`, category: category('Office supplies'), content: `Date,Merchant,Amount,Id\n2026-10-15,${merchant},12.34,synthetic-coaster-${width}`, mapping: { dateFormat: 'YYYY-MM-DD', sign: 'purchases-positive', postedDate: 'Date', description: 'Merchant', amount: 'Amount', transactionId: 'Id', wholeFileLast4: '1111' } };
  const preview = await call(['statements', 'preview'].join('/'), input);
  await call(['statements', 'commit'].join('/'), { ...input, fingerprint: preview.fingerprint });
  const charge = (await call('statements')).charges.find(c => c.descriptor === merchant);
  let catalog = await call('coding');
  catalog = await call(['coding', 'dimensions'].join('/'), { version: catalog.version, name: `Client class ${width}`, kind: 'class' });
  const dimension = catalog.saved;
  catalog = await call(['coding', 'values'].join('/'), { version: catalog.version, dimension, name: `Client work ${width}` });
  const choice = catalog.saved;
  const automatic = ['coding', 'automatic'].join('/');
  await call(`${automatic}/rules`, { version: (await call(`${automatic}/rules`)).version, scope: 'finance', merchant, coding: { category: category('Travel'), dimensions: { [dimension]: choice } } });
  const page = employee.page;
  await page.goto(origin + '/app#/claims'); await page.reload();
  const controls = page.locator('details').filter({ has: page.getByText('Prepare a trip or expense review', { exact: true }) });
  await controls.locator('summary').click();
  await controls.getByLabel('Claim to review', { exact: true }).selectOption(charge.claim_id);
  await controls.getByRole('button', { name: 'Prepare expense review', exact: true }).click();
  const strip = page.getByRole('region', { name: 'Prepared for you' });
  await strip.getByRole('button', { name: 'Review coding changes', exact: true }).click();
  const confirmation = strip.getByRole('group', { name: 'Confirm coding changes' });
  await confirmation.getByText('Category: Office supplies → Travel', { exact: true }).waitFor();
  await confirmation.getByText(`Client class ${width}: Not set → Client work ${width}`, { exact: true }).waitFor();
  if (width === 1440) {
    assert.equal(await confirmation.getByRole('button', { name: 'Apply reviewed coding', exact: true }).isEnabled(), false);
    const before = await api(employee.context, origin, `claims/${charge.claim_id}`);
    assert.equal(before.items[0].allocations[0].category_id, category('Office supplies'));
    assert.deepEqual(before.items[0].coding, {});
  }
  await shot(page, 'coding-confirmation', width);
  await confirmation.getByRole('button', { name: 'Cancel coding changes', exact: true }).click();
  await strip.getByRole('button', { name: 'Review coding changes', exact: true }).click();
  await confirmation.getByRole('checkbox', { name: 'I confirm these exact coding changes' }).check();
  await confirmation.getByRole('button', { name: 'Apply reviewed coding', exact: true }).click();
  await page.getByRole('heading', { name: /Expenses/ }).waitFor();
  await page.getByRole('region', { name: 'Expenses', exact: true }).getByText('Travel', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'History', exact: true }).getByText(/confirmed reviewed coding.*Expense preparation agent/).waitFor();
  await shot(page, 'coding-applied-draft', width);
  if (width === 1440) {
    const after = await api(employee.context, origin, `claims/${charge.claim_id}`);
    assert.equal(after.items[0].allocations[0].category_id, category('Travel'));
    assert.equal(after.items[0].coding[dimension], choice);
    assert.equal(after.items[0].amount_minor, 1234);
    assert.equal(after.claim.status, 'draft'); assert.equal(after.claim.total_minor, 0);
  }
}
