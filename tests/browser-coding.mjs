import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api, PEOPLE, session } from './browser-journey.mjs'

/** Native tags, dependent expense choices, project spend and budgets, through their built screens. */
export async function codingScreens(browser, root, origin, evidence) {
  for (const width of [1440, 390]) {
    const owner = await session(browser, root, origin, 'owner', width), employee = await session(browser, root, origin, 'employee', width)
    try {
      const department = `Department ${width}`, project = `Project ${width}`, task = `Task ${width}`, sales = `Sales ${width}`, marketing = `Marketing ${width}`, salesProject = `Harbour fitout ${width}`, marketingProject = `Launch ${width}`;
      const category = await api(owner.context, origin, 'settings/categories', { name: `Travel ${width}`, accountCode: '6200', taxCode: 'GST' })
      const csv = 'dimension,parentDimension,kind,required,value,parentValue,owner\n' + [
        [department, '', 'department', 'false', sales, '', ''], [department, '', 'department', 'false', marketing, '', ''],
        [project, department, 'project', 'false', salesProject, sales, PEOPLE.manager], [project, department, 'project', 'false', marketingProject, marketing, PEOPLE.manager],
        [task, project, 'tag', 'false', `Site visit ${width}`, salesProject, ''],
        [`Chart accounts ${width}`, '', 'account', 'false', `Travel expense ${width}`, '', ''],
      ].map(r => r.join(',')).join('\n')
      await owner.page.goto(origin + '/app#/settings')
      const quickbooks = owner.page.getByRole('region', { name: 'QuickBooks accounting choices', exact: true })
      await quickbooks.getByText('No QuickBooks company connected. Native accounting tags can be configured separately below.', { exact: true }).waitFor()
      await quickbooks.scrollIntoViewIfNeeded(); await shot(owner.page, evidence, 'quickbooks-disconnected', width)
      const settings = owner.page.getByRole('region', { name: 'Accounting dimensions', exact: true })
      await settings.getByLabel('Coding CSV', { exact: true }).setInputFiles({ name: 'synthetic-coaster-700.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      await settings.getByRole('button', { name: 'Import coding CSV', exact: true }).click()
      await settings.getByText('Catalog imported.', { exact: true }).waitFor()
      await settings.getByLabel('Configure category', { exact: true }).selectOption(category.id)
      await settings.getByLabel(`Require ${project} for this category`, { exact: true }).check()
      await settings.getByRole('button', { name: 'Save category dimensions', exact: true }).click()
      await settings.getByText('Category dimensions saved.', { exact: true }).waitFor()
      await settings.getByLabel('Manage level', { exact: true }).selectOption({ label: project })
      await settings.getByText(salesProject, { exact: false }).first().waitFor()
      await settings.scrollIntoViewIfNeeded(); await shot(owner.page, evidence, 'coding-settings', width)
      const catalog = await api(owner.context, origin, 'coding'), dimension = name => catalog.dimensions.find(d => d.name === name).id, value = name => catalog.values.find(v => v.name === name).id
      const categories = owner.page.locator('section').filter({ has: owner.page.getByRole('heading', { name: 'Expense categories', exact: true }) }).last()
      await categories.getByRole('row').filter({ has: owner.page.getByRole('cell', { name: `Travel ${width}`, exact: true }) }).getByRole('button', { name: 'Change', exact: true }).click()
      await categories.getByLabel('Mapped chart account', { exact: true }).selectOption(value(`Travel expense ${width}`))
      await categories.getByLabel('Mapped chart account', { exact: true }).scrollIntoViewIfNeeded(); await shot(owner.page, evidence, 'coding-category-account', width)
      await categories.getByRole('button', { name: 'Save category', exact: true }).click()
      assert.equal((await api(owner.context, origin, 'state')).categories.find(c => c.id === category.id).ledger_account.id, value(`Travel expense ${width}`))
      const workflow = owner.page.locator('section').filter({ has: owner.page.getByRole('heading', { name: 'Approval workflows', exact: true }) }).last()
      await workflow.getByRole('button', { name: 'Add rule', exact: true }).click()
      await workflow.getByLabel('Rule label', { exact: true }).last().fill(`Project review ${width}`)
      await workflow.getByLabel('Condition', { exact: true }).last().selectOption('project')
      await workflow.getByLabel('Project', { exact: true }).last().fill(salesProject)
      await workflow.getByLabel('Reviewer 1 type', { exact: true }).last().selectOption('projectOwner')
      await workflow.getByLabel('Reviewer 1 type', { exact: true }).last().scrollIntoViewIfNeeded(); await shot(owner.page, evidence, 'coding-project-workflow', width)
      await workflow.getByRole('button', { name: 'Save approval workflow', exact: true }).click()
      await workflow.getByText('Approval workflow saved. New submissions use these rules.', { exact: true }).waitFor()
      const claim = await api(employee.context, origin, 'claims', { title: `Sales site visit ${width}` })
      await employee.page.goto(origin + `/app#/claims/${claim.id}`)
      await employee.page.reload()
      await employee.page.getByRole('button', { name: 'Add expense', exact: true }).click()
      const form = employee.page.locator('form.item-form')
      await form.getByLabel('Merchant', { exact: true }).fill(`Harbour taxi ${width}`)
      await form.getByLabel('Amount', { exact: true }).fill('45.00')
      await form.getByLabel('Category', { exact: true }).selectOption(category.id)
      await form.getByLabel(department, { exact: true }).selectOption(value(sales))
      const projectChoice = form.getByLabel(project, { exact: true })
      assert.equal(await projectChoice.locator('option').filter({ hasText: marketingProject }).count(), 0, 'Sales never offers a Marketing project')
      assert.ok(await projectChoice.locator('option').filter({ hasText: salesProject }).count())
      await form.getByRole('button', { name: 'Add expense', exact: true }).click()
      assert.equal(await projectChoice.evaluate(e => e.validity.valueMissing), true, 'Travel refuses its missing required project')
      assert.equal((await api(employee.context, origin, `claims/${claim.id}`)).items.length, 0)
      await projectChoice.selectOption(value(salesProject))
      await form.getByLabel(task, { exact: true }).selectOption(value(`Site visit ${width}`))
      await form.getByLabel('Explanation for your approver', { exact: true }).fill('Site visit for the Sales project; taxi receipt was not provided.')
      await projectChoice.scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'coding-expense', width)
      await form.getByRole('button', { name: 'Add expense', exact: true }).click()
      await form.waitFor({ state: 'detached' })
      await employee.page.getByRole('button', { name: 'Submit for approval', exact: true }).click()
      await employee.page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()
      const saved = await api(employee.context, origin, `claims/${claim.id}`)
      assert.equal(saved.revisions.at(-1).snapshot.items[0].project, salesProject)
      await owner.page.reload()
      const budgets = owner.page.locator('section').filter({ has: owner.page.getByRole('heading', { name: 'Budgets', exact: true }) }).last()
      await budgets.getByLabel('Budget name', { exact: true }).fill(`Sales project budget ${width}`)
      await budgets.getByLabel('Covers', { exact: true }).selectOption('project')
      await budgets.getByLabel('Project or tag', { exact: true }).selectOption(value(salesProject))
      await budgets.getByLabel('Amount', { exact: true }).fill('500.00')
      await budgets.getByLabel('Project or tag', { exact: true }).scrollIntoViewIfNeeded(); await shot(owner.page, evidence, 'coding-project-budget-form', width)
      await budgets.getByRole('button', { name: 'Save budget', exact: true }).click()
      await budgets.getByText('Budget saved.', { exact: true }).waitFor()
      const spend = owner.page.locator('section').filter({ has: owner.page.getByRole('heading', { name: 'Spend', exact: true }) }).last()
      await spend.getByLabel('Group by', { exact: true }).selectOption('project')
      const date = new Date().toISOString().slice(0, 10)
      await spend.getByLabel('Spent from', { exact: true }).fill(date)
      await spend.getByLabel('Spent until', { exact: true }).fill(date)
      await spend.getByRole('button', { name: 'Show spend', exact: true }).click()
      await spend.getByRole('button', { name: salesProject, exact: true }).waitFor()
      await spend.scrollIntoViewIfNeeded(); await shot(owner.page, evidence, 'coding-project-spend', width)
      await owner.page.getByText(`Sales project budget ${width}`, { exact: false }).first().scrollIntoViewIfNeeded()
      await shot(owner.page, evidence, 'coding-project-budget', width)
      assert.equal((await api(owner.context, origin, 'budgets')).find(b => b.name === `Sales project budget ${width}`).actualMinor, 4500)
    } finally { await employee.context.close(); await owner.context.close() }
  }
}

async function shot(page, evidence, name, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits ${width}px`)
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`) })
}
