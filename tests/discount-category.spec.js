import { test, expect } from './fixtures.js';
import { request } from '@playwright/test';

// Only people with customers_discount_category put a customer in, or take
// them out of, a customer category that gives a discount.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('discounted customer categories need Assign Discount Categories', async ({ page }) => {
  const stamp = Date.now();
  const disc = await api(page, 'POST', '/customer-categories', { name: `Contractor ${stamp}`, discount_percent: 10 });
  const plain = await api(page, 'POST', '/customer-categories', { name: `Walk-in ${stamp}`, discount_percent: 0 });
  const g = await api(page, 'POST', '/security-groups', { name: `Clerk ${stamp}`, permissions: { customers: true } });
  expect((await api(page, 'GET', '/security-groups')).find(x => x.name === 'Administrator').permissions.customers_discount_category).toBe(true);
  const u = `clerk${stamp}`;
  await api(page, 'POST', '/employees', { first_name: 'Clerk', last_name: `${stamp}`, username: u, pin: `${stamp}`.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: g.id, default_branch_id: 1, active: 1 });
  const ctx = await request.newContext({ baseURL: process.env.POS_TEST_URL });
  try {
    expect((await ctx.post('/api/employees/login', { data: { username: u, password: 'pw-123456' } })).ok()).toBeTruthy();
    const body = (n, cat) => ({ address: '1 Test Road', first_name: 'Cat', last_name: `${n} ${stamp}`, phone: `85${String(stamp).slice(-7)}${n}`, customer_type: 'cash', force: true, customer_category_id: cat });

    // Full Customers access still can't assign the discounted one…
    const refused = await ctx.post('/api/customers', { data: body(1, disc.id) });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('discount_category');
    // …but a category with no discount is fine.
    const c = await (await ctx.post('/api/customers', { data: body(2, plain.id) })).json();
    expect(c.customer_category_id).toBe(plain.id);

    // The admin moves them to the discounted category.
    const full = await api(page, 'GET', `/customers/${c.id}`);
    await api(page, 'PUT', `/customers/${c.id}`, { ...full, customer_category_id: disc.id });
    const now = await api(page, 'GET', `/customers/${c.id}`);
    expect(now.customer_category_id).toBe(disc.id);

    // The clerk can still edit the customer, keeping the category…
    expect((await ctx.put(`/api/customers/${c.id}`, { data: { ...now, notes: 'edited' } })).ok()).toBeTruthy();
    // …but not take it off or swap it.
    expect((await ctx.put(`/api/customers/${c.id}`, { data: { ...now, customer_category_id: null } })).status()).toBe(403);
    expect((await ctx.put(`/api/customers/${c.id}`, { data: { ...now, customer_category_id: plain.id } })).status()).toBe(403);
    expect((await api(page, 'GET', `/customers/${c.id}`)).customer_category_id).toBe(disc.id);

    // An import without the permission brings the row in with no category.
    const imp = await (await ctx.post('/api/customers/import', { data: { rows: [{ first_name: 'Imp', last_name: `Cat ${stamp}`, phone: `84${String(stamp).slice(-8)}`, customer_type: 'cash', customer_category_name: `Contractor ${stamp}` }] } })).json();
    expect(imp).toMatchObject({ created: 1, discount_category_dropped: 1 });
  } finally { await ctx.dispose(); }

  // On the form, someone without it sees the discounted category greyed out.
  await page.evaluate(() => { App.currentUser.permissions = { customers: true }; });
  await page.evaluate(() => App.showCustomerForm());
  await expect(page.locator(`#cf-category option[value="${disc.id}"]`)).toBeDisabled();
  await expect(page.locator(`#cf-category option[value="${plain.id}"]`)).toBeEnabled();
});
