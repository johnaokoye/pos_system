import { test, expect } from './fixtures.js';

// A blocked credit customer can still be quoted, but the quote isn't turned
// into an invoice (Convert, or sold at the POS) until the account is cleared
// or accounting (customers_credit_block) releases that quote.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));

test('a blocked credit customer is quoted, converted only once released or cleared', async ({ page }) => {
  const s = String(Date.now());
  const cust = await api(page, 'POST', '/customers', { first_name: 'Blocked', last_name: `Quote${s}`, phone: `876${s.slice(-7)}`, customer_type: 'credit', credit_enabled: 1, credit_limit: 1000000, credit_terms_days: 30 });
  await api(page, 'PATCH', `/customers/${cust.id}/credit-block`, { blocked: true, reason: 'test hold' });
  const p = await product(page);

  // Quoting is fine.
  const q = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, customer_id: cust.id, items: [{ product_id: p.id, quantity: 1 }] });
  const fetched = await api(page, 'GET', `/quotations/${q.id}`);
  expect(fetched.customer_credit_blocked).toBe(1);

  // Converting, or selling it at the POS, is refused.
  expect(await attempt(page, 'POST', `/quotations/${q.id}/convert`, { employee_id: 1, branch_id: 1 })).toContain('credit account is blocked');
  const sale = { items: [{ product_id: p.id, quantity: 1 }], customer_id: cust.id, quote_id: q.id, branch_id: 1, employee_id: 1, payment_method: 'credit' };
  expect(await attempt(page, 'POST', '/transactions', sale)).toContain('credit account is blocked');

  // The quote view says so and offers accounting the release.
  await page.evaluate(() => App.showSection('quotations'));
  await page.evaluate(id => App.viewQuote(id), q.id);
  await expect(page.locator('.modal')).toContainText("can't be converted to an invoice until the account is cleared");
  await page.getByRole('button', { name: 'Release for Invoicing' }).click();
  expect(await attempt(page, 'POST', `/quotations/${q.id}/credit-release`, {})).toContain('reason is required');
  await page.fill('#qcr-reason', 'Payment arrangement agreed');
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.locator('.modal')).toContainText('released for invoicing');

  // Released: it sells on account despite the block; the account stays blocked.
  const done = await api(page, 'POST', '/transactions', sale);
  expect(done.status).toBe('completed');
  expect((await api(page, 'GET', `/customers/${cust.id}`)).account_blocked).toBe(1);
  expect((await api(page, 'GET', `/quotations/${q.id}`)).status).toBe('converted');

  // Another quote for the same customer is still held back…
  const q2 = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, customer_id: cust.id, items: [{ product_id: p.id, quantity: 1 }] });
  expect(await attempt(page, 'POST', `/quotations/${q2.id}/convert`, { employee_id: 1, branch_id: 1 })).toContain('credit account is blocked');
  // …until the account is unblocked.
  await api(page, 'PATCH', `/customers/${cust.id}/credit-block`, { blocked: false, reason: 'cleared' });
  expect(await attempt(page, 'POST', `/quotations/${q2.id}/convert`, { employee_id: 1, branch_id: 1 })).toBe('accepted');
});

test('editing a released quote\'s total cancels the release', async ({ page }) => {
  const s = String(Date.now());
  const cust = await api(page, 'POST', '/customers', { first_name: 'Blocked', last_name: `Edit${s}`, phone: `875${s.slice(-7)}`, customer_type: 'credit', credit_enabled: 1, credit_limit: 1000000, credit_terms_days: 30 });
  await api(page, 'PATCH', `/customers/${cust.id}/credit-block`, { blocked: true, reason: 'test hold' });
  const p = await product(page);
  const q = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, customer_id: cust.id, items: [{ product_id: p.id, quantity: 1 }] });
  await api(page, 'POST', `/quotations/${q.id}/credit-release`, { reason: 'ok for this one' });
  await api(page, 'PUT', `/quotations/${q.id}`, { employee_id: 1, branch_id: 1, customer_id: cust.id, items: [{ product_id: p.id, quantity: 3 }] });
  const after = await api(page, 'GET', `/quotations/${q.id}`);
  expect(after.credit_released_at).toBeNull();
  expect(await attempt(page, 'POST', `/quotations/${q.id}/convert`, { employee_id: 1, branch_id: 1 })).toContain('credit account is blocked');
});
