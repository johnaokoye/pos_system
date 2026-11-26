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
  const cust = await api(page, 'POST', '/customers', { address: '1 Test Road', first_name: 'Ext', last_name: `Owner${s}`, phone: `875${s.slice(-7)}` });
  const sup = await api(page, 'POST', '/suppliers', { name: `Motor Rewinds ${s}`, payment_terms: 'Net 30' });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Generator not starting', item_label: 'Generator', assessment_fee_product_id: fee.id });

  // Validation
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { description: 'x', cost: 5 })).toContain('company or the technician');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', cost: 5 })).toContain('Describe the work');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', description: 'x', cost: -1 })).toContain('0 or more');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', description: 'x', cost: 1, sent_date: '2026-11-10', returned_date: '2026-11-01' })).toContain('before the sent date');

  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Bob', description: 'x', labour_hours: 2 })).toContain('both the hours and the hourly rate');

  // Hourly labour + other charges + GCT; a supplier on file fills in the company and gets an A/P bill.
  const a = await api(page, 'POST', `/work-orders/${wo.id}/external-work`, { supplier_id: sup.id, technician_name: 'Delroy Brown', phone: '876-555-0101', description: 'Rewound the stator',
    labour_hours: 3.5, hourly_rate: 4000, other_cost: 2500, tax_amount: 2475, reference: `INV-${s}`, sent_date: '2026-11-02', returned_date: '2026-11-09' });
  expect(a.company_name).toBe(`Motor Rewinds ${s}`);
  expect(a.cost).toBe(18975);
  expect(a.ap_bill_number).toMatch(/^AP-/);
  let bill = await api(page, 'GET', `/payables/bills/${a.ap_bill_id}`);
  expect(bill.supplier_id).toBe(sup.id);
  expect(bill.amount).toBe(18975);
  expect(bill.tax_amount).toBe(2475);
  expect(bill.vendor_invoice_number).toBe(`INV-${s}`);
  expect(bill.bill_date).toBe('2026-11-09');
  expect(bill.due_date).toBe('2026-12-09');
  expect(bill.source).toBe('work_order');
  // The same supplier invoice can't be billed twice.
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/external-work`, { supplier_id: sup.id, description: 'again', other_cost: 10, reference: `inv-${s}` })).toContain('already entered in A/P');
  // No supplier on file: recorded, no bill. Old-style `cost` still works.
  const free = await api(page, 'POST', `/work-orders/${wo.id}/external-work`, { technician_name: 'Freelance Sparky', description: 'Rewired the panel', cost: '4000.255' });
  expect(free.ap_bill_id).toBeNull();
  expect(free.other_cost).toBe(4000.26);

  let full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_work.length).toBe(2);
  expect(full.external_cost_total).toBe(22975.26);
  expect(full.status_log.some(l => /External work added: Motor Rewinds.*A\/P bill AP-/.test(l.comment || ''))).toBe(true);

  // Edit: the bill follows the cost and logs it.
  await api(page, 'PUT', `/work-orders/${wo.id}/external-work/${a.id}`, { ...a, labour_hours: 4 });
  full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_work.find(x => x.id === a.id).cost).toBe(20975);
  expect(full.external_work.find(x => x.id === a.id).updated_at).toBeTruthy();
  expect((await api(page, 'GET', `/payables/bills/${a.ap_bill_id}`)).amount).toBe(20975);
  expect(full.status_log.some(l => /cost changed.*18975\.00 → 20975\.00, A\/P bill .* updated/.test(l.comment || ''))).toBe(true);
  // Another work order's id can't reach it.
  expect(await attempt(page, 'DELETE', `/work-orders/${wo.id + 99999}/external-work/${a.id}`)).toContain('Not found');

  // Once the bill is on a payment request, its cost is fixed here.
  const prq = await api(page, 'POST', '/payables/payment-requests', { supplier_id: sup.id, request_type: 'invoice', lines: [{ bill_id: a.ap_bill_id, amount: 20975 }], required_date: '2026-12-01', submit: true });
  expect(await attempt(page, 'PUT', `/work-orders/${wo.id}/external-work/${a.id}`, { ...a, labour_hours: 5 })).toContain('is on payment request');
  expect(await attempt(page, 'DELETE', `/work-orders/${wo.id}/external-work/${a.id}`)).toContain('is on payment request');
  // …but notes can still change.
  await api(page, 'PUT', `/work-orders/${wo.id}/external-work/${a.id}`, { ...a, labour_hours: 4, notes: 'Warranty 90 days' });
  await api(page, 'POST', `/payables/payment-requests/${prq.id}/cancel`, { reason: 'test' });

  // Unticking the bill voids it; ticking again raises a new one; removing voids that.
  const off = await api(page, 'PUT', `/work-orders/${wo.id}/external-work/${a.id}`, { ...a, labour_hours: 4, create_bill: false });
  expect(off.ap_bill_id).toBeNull();
  expect((await api(page, 'GET', `/payables/bills/${a.ap_bill_id}`)).status).toBe('void');
  const on = await api(page, 'PUT', `/work-orders/${wo.id}/external-work/${a.id}`, { ...a, labour_hours: 4, create_bill: true });
  expect(on.ap_bill_id).not.toBe(a.ap_bill_id);
  expect((await api(page, 'GET', `/payables/bills/${on.ap_bill_id}`)).amount).toBe(20975);

  // Through the screen: listed with the total, and added from the form.
  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(id => App.viewWorkOrder(id), wo.id);
  await expect(page.locator('.modal')).toContainText('External Work');
  await expect(page.locator('.modal')).toContainText('Rewound the stator');
  await page.getByRole('button', { name: '+ Add External Work' }).click();
  await page.fill('#wo-ext-company', 'Cool Air Ltd');
  await expect(page.locator('#wo-ext-bill-wrap')).toBeHidden();
  await page.fill('#wo-ext-desc', 'Regassed the AC');
  await page.fill('#wo-ext-hours', '2');
  await page.fill('#wo-ext-rate', '1250');
  await expect(page.locator('#wo-ext-total')).toContainText('2,500.00');
  await page.locator('#wo-ext-form').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.modal')).toContainText('Regassed the AC');
  full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_cost_total).toBe(27475.26);

  // Remove
  await expect(page.locator('.wo-ext-row', { hasText: 'Rewound the stator' })).toContainText('Labour 4 h');
  await expect(page.locator('.wo-ext-row', { hasText: 'Rewound the stator' })).toContainText(on.ap_bill_number);
  page.once('dialog', d => d.accept());
  await page.locator('.wo-ext-row', { hasText: 'Regassed the AC' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.wo-ext-row', { hasText: 'Regassed the AC' })).toHaveCount(0);
  full = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(full.external_work.length).toBe(2);
  expect(full.status_log.some(l => /External work removed: Cool Air Ltd/.test(l.comment || ''))).toBe(true);
});

test('removing external work voids its A/P bill', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const fee = await api(page, 'POST', '/products', { name: `Assessment Y ${s}`, sku: `AY${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { address: '1 Test Road', first_name: 'Ext', last_name: `Two${s}`, phone: `874${s.slice(-7)}` });
  const sup = await api(page, 'POST', '/suppliers', { name: `Panel Beaters ${s}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Dented casing', item_label: 'Mixer', assessment_fee_product_id: fee.id });
  const x = await api(page, 'POST', `/work-orders/${wo.id}/external-work`, { supplier_id: sup.id, description: 'Beat out the dent', labour_hours: 1, hourly_rate: 3000 });
  expect(x.ap_bill_id).toBeTruthy();
  await api(page, 'DELETE', `/work-orders/${wo.id}/external-work/${x.id}`);
  expect((await api(page, 'GET', `/payables/bills/${x.ap_bill_id}`)).status).toBe('void');
  // Ticked off at entry: no bill.
  const y = await api(page, 'POST', `/work-orders/${wo.id}/external-work`, { supplier_id: sup.id, description: 'Quote only', other_cost: 500, create_bill: false });
  expect(y.ap_bill_id).toBeNull();
});
