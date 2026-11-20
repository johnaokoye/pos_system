import { test, expect } from './fixtures.js';
import { request } from '@playwright/test';

// Staff purchases (lib/staffPurchases.js): an employee's staff account gets
// the staff discount, is cash or card only, can't be rung up by the employee, and
// stops at their limit for the period; returns free the limit up again.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

test('staff purchases: 15% off, cash or card, not your own, within the limit', async ({ page }) => {
  const stamp = Date.now();
  const settings = await api(page, 'GET', '/settings');
  const pct = parseFloat(settings.staff_discount_pct);
  expect(pct).toBe(15);

  const p = await api(page, 'POST', '/products', { sku: `STAFF-${stamp}`, name: `Staff Drill ${stamp}`, price: 100, cost: 40, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 20, branch_id: 1, reason: 'test' });
  const groups = await api(page, 'GET', '/security-groups');
  const cashier = groups.find(g => g.name === 'Cashier'), manager = groups.find(g => g.name === 'Manager');
  const pw = 'pw-123456';
  const staffEmp = await api(page, 'POST', '/employees', { first_name: 'Sam', last_name: `Staff${stamp}`, username: `sam${stamp}`, pin: `${stamp}`.slice(-6), password: pw, must_change_password: 0, security_group_id: cashier.id, default_branch_id: 1, active: 1 });
  const mgrEmp = await api(page, 'POST', '/employees', { first_name: 'Max', last_name: `Mgr${stamp}`, username: `max${stamp}`, pin: `${stamp + 1}`.slice(-6), password: pw, must_change_password: 0, security_group_id: manager.id, default_branch_id: 1, active: 1 });

  // Staff account created from the employee; the manager is a named person on the Manager tier.
  const acct = await api(page, 'POST', `/employees/${staffEmp.id}/staff-account`, {});
  expect(acct.customer.customer_number).toMatch(/^CUST-/);
  expect(acct.status.limit).toBe(45000);
  expect(await attempt(page, 'POST', `/employees/${staffEmp.id}/staff-account`, {})).toContain('already has staff account');
  await api(page, 'POST', `/employees/${mgrEmp.id}/staff-account`, {});
  const mgrAcct = await api(page, 'PUT', `/employees/${mgrEmp.id}/staff-purchase`, { tier: 'manager', limit: '' });
  expect(mgrAcct.status.limit).toBe(150000);
  // A personal limit replaces the tier's — 200 here so the test can reach it.
  const small = await api(page, 'PUT', `/employees/${staffEmp.id}/staff-purchase`, { tier: 'staff', limit: 200 });
  expect(small.status.limit).toBe(200);

  const custId = acct.customer.id;
  const cust = await api(page, 'GET', `/customers/${custId}`);
  expect(cust.staff_purchase.remaining).toBe(200);
  const sell = (qty, extra = {}) => api(page, 'POST', '/transactions', { customer_id: custId, items: [{ product_id: p.id, quantity: qty }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 10000, ...extra });

  // The server works out the staff discount itself, whatever the till sent.
  const s1 = await sell(2, { discount_amount: 0 });
  expect(s1.discount_amount).toBe(30);
  expect(s1.total).toBe(170);
  expect(s1.promotion_name).toBe('Staff Discount');

  // Cash or card only (not on account / cheque); no line discounts; no layaway.
  expect(await attempt(page, 'POST', '/transactions', { customer_id: custId, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'check' })).toContain('cash or card');
  expect(await attempt(page, 'POST', '/transactions', { customer_id: custId, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'split', tenders: [{ method: 'cash', amount: 40 }, { method: 'gift_card', amount: 45, approval_code: 'G1' }] })).toContain('cash or card');
  expect(await attempt(page, 'POST', '/transactions', { customer_id: custId, items: [{ product_id: p.id, quantity: 1, discount_percent: 5 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 })).toContain('staff discount only');
  expect(await attempt(page, 'POST', '/layaway/plans', { customer_id: custId, branch_id: 1, employee_id: 1, items: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash', amount_tendered: 50 })).toContain('cash or card');

  // 170 used of 200 — another 85 is over.
  expect(await attempt(page, 'POST', '/transactions', { customer_id: custId, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 })).toContain('over their monthly staff purchase limit of 200.00');

  // A return frees up the limit in the month it's made.
  const group = groups.find(g => g.name === 'Manager');
  const pin = `${stamp + 2}`.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Ret', last_name: `Ok${stamp}`, username: `retok${stamp}`, pin, password: pw, must_change_password: 0, security_group_id: group.id, active: 1 });
  const full = await api(page, 'GET', `/transactions/${s1.id}`);
  await api(page, 'POST', `/transactions/${s1.id}/return`, { items: [{ transaction_item_id: full.items[0].id, quantity: 1 }], resolution: 'credit_note', notes: 'Wrong size', override_pin: pin });
  const after = (await api(page, 'GET', `/customers/${custId}`)).staff_purchase;
  expect(after.used).toBe(85);
  expect(after.remaining).toBe(115);
  // A card payment is fine.
  const s2 = await sell(1, { payment_method: 'credit_card', approval_code: '4321', amount_tendered: undefined });
  expect(s2.total).toBe(85);
  expect(s2.payment_method).toBe('credit_card');

  // The employee can't ring up their own staff purchase.
  const ctx = await request.newContext({ baseURL: process.env.POS_TEST_URL });
  try {
    expect((await ctx.post('/api/employees/login', { data: { username: `sam${stamp}`, password: pw } })).ok()).toBeTruthy();
    const own = await ctx.post('/api/transactions', { data: { customer_id: custId, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: staffEmp.id, payment_method: 'cash', amount_tendered: 1000 } });
    expect(own.status()).toBe(400);
    expect((await own.json()).code).toBe('staff_self_sale');
  } finally { await ctx.dispose(); }

  // The report: this month, per staff account.
  const report = await api(page, 'GET', '/employees/staff-purchases');
  const row = report.accounts.find(a => a.employee_id === staffEmp.id);
  expect(row).toMatchObject({ sales: 2, purchases: 255, returns: 85, used: 170, remaining: 30, discount_given: 45, tier: 'staff', own_limit: true });
  expect(report.accounts.find(a => a.employee_id === mgrEmp.id)).toMatchObject({ tier: 'manager', limit: 150000, used: 0 });

  // An inactive employee's account is closed.
  const emp = (await api(page, 'GET', '/employees')).find(e => e.id === staffEmp.id);
  await api(page, 'PUT', `/employees/${staffEmp.id}`, { ...emp, active: 0 });
  expect(await attempt(page, 'POST', '/transactions', { customer_id: custId, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 })).toContain('no longer an active employee');
});

test('POS shows the staff badge and refuses a cheque for a staff account', async ({ page }) => {
  const stamp = Date.now();
  const cashier = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Cashier');
  const emp = await api(page, 'POST', '/employees', { first_name: 'Pos', last_name: `Staff${stamp}`, username: `pos${stamp}`, pin: `${stamp}`.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: cashier.id, default_branch_id: 1, active: 1 });
  const acct = await api(page, 'POST', `/employees/${emp.id}/staff-account`, {});
  const p = await api(page, 'POST', '/products', { sku: `STAFFPOS-${stamp}`, name: `Staff Saw ${stamp}`, price: 200, cost: 80, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 5, branch_id: 1, reason: 'test' });
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => document.getElementById('cart-customer-name'));
  await page.evaluate(async ([cid]) => { App.setCartCustomer(cid); }, [acct.customer.id]);
  await expect(page.locator('#cart-customer-name')).toContainText('Staff ·');
  await page.evaluate(([pid]) => App.api('GET', `/products/${pid}`).then(prod => { App.cart.push({ product_id: prod.id, name: prod.name, price: prod.price, quantity: 1, tax_rate: 0, units_per: 1 }); App._checkAutoPromos(); }), [p.id]);
  await page.waitForFunction(() => App.cartDiscount === 30);
  await page.evaluate(() => App.processPayment('check'));
  await expect(page.locator('body')).toContainText('Staff purchases are paid at the till by cash or card');
});

test('the staff discount only applies from the minimum purchase (before tax)', async ({ page }) => {
  const stamp = Date.now();
  const cashier = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Cashier');
  const emp = await api(page, 'POST', '/employees', { first_name: 'Min', last_name: `Staff${stamp}`, username: `min${stamp}`, pin: `${stamp}`.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: cashier.id, default_branch_id: 1, active: 1 });
  const acct = await api(page, 'POST', `/employees/${emp.id}/staff-account`, {});
  const p = await api(page, 'POST', '/products', { sku: `STAFFMIN-${stamp}`, name: `Staff Bit ${stamp}`, price: 100, cost: 40, tax_rate: 15 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 10, branch_id: 1, reason: 'test' });
  const prev = (await api(page, 'GET', '/settings')).staff_discount_min ?? '0';
  await api(page, 'PUT', '/settings', { staff_discount_min: '250' });
  try {
    const sell = qty => api(page, 'POST', '/transactions', { customer_id: acct.customer.id, items: [{ product_id: p.id, quantity: qty }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 10000, discount_amount: 999 });
    // 200 before tax (230 with GCT) is under 250: full price, whatever the till sent.
    const small = await sell(2);
    expect(small.discount_amount).toBe(0);
    expect(small.promotion_name).toBeNull();
    expect(small.total).toBe(230);
    // 300 before tax reaches it: 15% off, taxed after the discount.
    const big = await sell(3);
    expect(big.discount_amount).toBe(45);
    expect(big.total).toBe(293.25);
    expect((await api(page, 'GET', `/customers/${acct.customer.id}`)).staff_purchase.discount_min).toBe(250);
  } finally {
    await api(page, 'PUT', '/settings', { staff_discount_min: String(prev) });
  }
});
