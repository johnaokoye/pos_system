import { test, expect } from './fixtures.js';

// Accounts Receivable branch filter: by the customer's home branch
// (customers.home_branch_id) or by the branch an invoice was raised at.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('A/R filters by home branch or by invoice branch, and home branches can be set in bulk', async ({ page }) => {
  const stamp = Date.now();
  let branches = (await api(page, 'GET', '/branches')).filter(b => b.active);
  if (branches.length < 2) {
    await api(page, 'POST', '/branches', { name: `AR Branch ${stamp}`, active: 1 });
    branches = (await api(page, 'GET', '/branches')).filter(b => b.active);
  }
  const [b1, b2] = branches;
  const service = await api(page, 'POST', '/products', { sku: `ARB-${stamp}`, name: `AR Branch Service ${stamp}`, is_service: 1, price: 100, tax_rate: 0 });
  const customer = (last, home) => api(page, 'POST', '/customers', {
    first_name: 'Branch', last_name: `${last} ${stamp}`, phone: `87${String(stamp).slice(-6)}${last === 'A' ? 1 : 2}`, customer_type: 'credit',
    credit_limit: 100000, credit_terms_days: 30, force: true, home_branch_id: home,
  });
  const a = await customer('A', b1.id);
  const b = await customer('B', null);
  expect(a.home_branch_id).toBe(b1.id);
  const sell = (c, branch) => api(page, 'POST', '/transactions', { customer_id: c.id, items: [{ product_id: service.id, quantity: 1 }], branch_id: branch, employee_id: 1, payment_method: 'credit', amount_tendered: 0 });
  await sell(a, b1.id);
  await sell(a, b2.id);
  await sell(b, b2.id);

  const ids = rows => rows.map(r => r.id).filter(id => id === a.id || id === b.id).sort();
  const get = (url, by, branch) => api(page, 'GET', `${url}?branch_by=${by}&branch_id=${branch}`);

  // Home branch: A is at b1 (whole account), B has none.
  expect(ids(await get('/accounts', 'home', b1.id))).toEqual([a.id]);
  expect(ids(await get('/accounts', 'home', 'none'))).toEqual([b.id]);
  const homeRow = (await get('/accounts', 'home', b1.id)).find(r => r.id === a.id);
  expect(homeRow).toMatchObject({ home_branch_name: b1.name, account_balance: 200 });

  // Invoice branch: b2 has one invoice each from A and B, b1 only A's.
  expect(ids(await get('/accounts', 'invoice', b2.id))).toEqual([a.id, b.id].sort());
  expect((await get('/accounts', 'invoice', b2.id)).find(r => r.id === a.id).branch_balance).toBe(100);
  expect(ids(await get('/accounts', 'invoice', b1.id))).toEqual([a.id]);
  const aging = (await get('/accounts/aging', 'invoice', b1.id)).find(r => r.id === a.id);
  expect(aging.current_30).toBe(100);

  // A customer's home branch survives an edit that doesn't send it.
  const full = await api(page, 'GET', `/customers/${a.id}`);
  const { home_branch_id, ...withoutIt } = full;
  await api(page, 'PUT', `/customers/${a.id}`, { ...withoutIt, notes: 'edited' });
  expect((await api(page, 'GET', `/customers/${a.id}`)).home_branch_id).toBe(b1.id);

  // Bulk: fill B's blank home branch from invoices (b2), then set it by hand.
  await api(page, 'POST', '/accounts/home-branch/fill', {});
  expect((await api(page, 'GET', `/customers/${b.id}`)).home_branch_id).toBe(b2.id);
  expect((await api(page, 'PATCH', '/accounts/home-branch', { ids: [b.id], branch_id: b1.id })).updated).toBe(1);
  expect(ids(await get('/accounts', 'home', b1.id))).toEqual([a.id, b.id].sort());

  // The screen: pick the branch and the Owed Here column appears.
  await page.evaluate(() => { try { localStorage.removeItem('ar-branch'); } catch (e) {} App._arBr = null; App.showSection('accounts'); });
  await page.selectOption('#ar-branch-by', 'invoice');
  await page.selectOption('#ar-branch', String(b2.id));
  await expect(page.locator('#ar-acct-head')).toContainText('Owed Here');
  await expect(page.locator('#ar-acct-body')).toContainText(`B ${stamp}`);
});
