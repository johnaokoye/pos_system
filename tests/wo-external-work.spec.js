import { test, expect } from './fixtures.js';

// Work orders: work done by an outside technician / company is recorded on
// the job with its cost to us. Internal only — the customer's bill is still
// the estimate + parts.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

test('record external technician work and cost on a work order', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const fee = await api(page, 'POST', '/products', { name: `Assessment X ${s}`, sku: `AX${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Ext', last_name: `Owner${s}`, phone: `875${s.slice(-7)}` });
  const sup = await api(page, 'POST', '/suppliers', { name: `Motor Rewinds ${s}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Generator not starting', item_label: 'Generator', assessment_fee_product_id: fee.id });

  // Validation
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { description: 'x', cost: 5 })).toContain('company or the technician');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', cost: 5 })).toContain('Describe the work');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', description: 'x', cost: -1 })).toContain('0 or more');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', description: 'x', cost: 1, sent_date: '2026-11-10', returned_date: '2026-11-01' })).toContain('before the sent date');

  // A supplier on file fills in the company name.
  const a = await api(page, 'POST', `/work-orders/${wo.id}/external-work`, { supplier_id: sup.id, technician_name: 'Delroy Brown', phone: '876-555-0101', description: 'Rewound the stator', cost: 18500, reference: 'INV-778', sent_date: '2026-11-02', returned_date: '2026-11-09' });
  expect(a.company_name).toBe(`Motor Rewinds ${s}`);
  expect(a.supplier_name).toBe(`Motor Rewinds ${s}`);
  await api(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Freelance Sparky', description: 'Rewired the panel', cost: '4000.255' });

  let full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_work.length).toBe(2);
  expect(full.external_cost_total).toBe(22500.26);
  expect(full.status_log.some(l => /External work added: Motor Rewinds/.test(l.comment || ''))).toBe(true);

  // Edit keeps the record and logs a cost change.
  await api(page, 'PUT', `/work-orders/${wo.id}/external-work/${a.id}`, { ...a, cost: 19000 });
  full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_work.find(x => x.id === a.id).cost).toBe(19000);
  expect(full.external_work.find(x => x.id === a.id).updated_at).toBeTruthy();
  expect(full.status_log.some(l => /cost changed.*18500\.00 → 19000\.00/.test(l.comment || ''))).toBe(true);
  // Another work order's id can't reach it.
  expect(await attempt(page, 'DELETE', `/work-orders/${wo.id + 99999}/external-work/${a.id}`)).toContain('Not found');

  // Through the screen: listed with the total, and added from the form.
  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(id => App.viewWorkOrder(id), wo.id);
  await expect(page.locator('.modal')).toContainText('External Work');
  await expect(page.locator('.modal')).toContainText('Rewound the stator');
  await page.getByRole('button', { name: '+ Add External Work' }).click();
  await page.fill('#wo-ext-company', 'Cool Air Ltd');
  await page.fill('#wo-ext-desc', 'Regassed the AC');
  await page.fill('#wo-ext-cost', '2500');
  await page.locator('#wo-ext-form').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.modal')).toContainText('Regassed the AC');
  full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_cost_total).toBe(25500.26);

  // Remove
  page.once('dialog', d => d.accept());
  await page.locator('.wo-ext-row', { hasText: 'Regassed the AC' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.wo-ext-row', { hasText: 'Regassed the AC' })).toHaveCount(0);
  full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_work.length).toBe(2);
  expect(full.status_log.some(l => /External work removed: Cool Air Ltd/.test(l.comment || ''))).toBe(true);
});
