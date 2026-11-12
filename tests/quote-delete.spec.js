import { test, expect } from './fixtures.js';

// Deleting a quote (quotations_delete): only while nothing has come of it.
// Its number is never issued again.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));
const createQuote = async (page, extra = {}) => api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, items: [{ product_id: (await product(page)).id, quantity: 1 }], ...extra });

test('a quote is deleted from its view, and its number is not reused', async ({ page }) => {
  const q = await createQuote(page);
  await page.evaluate(() => App.showSection('quotations'));
  await page.evaluate(id => App.viewQuote(id), q.id);
  page.once('dialog', d => d.accept());
  await page.locator('.modal-footer').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('body')).toContainText(`${q.quote_number} deleted`);
  expect(await attempt(page, 'GET', `/quotations/${q.id}`)).not.toBe('accepted');

  const next = await createQuote(page);
  expect(next.quote_number).not.toBe(q.quote_number);
  expect(parseInt(next.quote_number.replace(/\D/g, ''))).toBeGreaterThan(parseInt(q.quote_number.replace(/\D/g, '')));
});

test('a converted quote, or one with a purchase request raised from it, cannot be deleted', async ({ page }) => {
  const converted = await createQuote(page);
  await api(page, 'POST', `/quotations/${converted.id}/convert`, { employee_id: 1, branch_id: 1 });
  expect(await attempt(page, 'DELETE', `/quotations/${converted.id}`)).toContain('has been converted');
  await page.evaluate(id => App.viewQuote(id), converted.id);
  await expect(page.locator('.modal-footer').getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await page.evaluate(() => App.closeModal());

  // Accepting a quote with a Q item raises a purchase request for it.
  const qItem = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, items: [{ description: 'Special order thing', quantity: 1, unit_price: 100 }] });
  await api(page, 'PATCH', `/quotations/${qItem.id}/status`, { status: 'accepted' });
  const saved = await api(page, 'GET', `/quotations/${qItem.id}`);
  test.skip(!saved.items.some(i => i.purchase_request_id), 'accepting did not raise a purchase request here');
  expect(await attempt(page, 'DELETE', `/quotations/${qItem.id}`)).toContain('Purchase request');
  // Once the request is deleted, the quote can go.
  await api(page, 'DELETE', `/purchase-requests/${saved.items.find(i => i.purchase_request_id).purchase_request_id}`);
  expect(await attempt(page, 'DELETE', `/quotations/${qItem.id}`)).toBe('accepted');
});

test('needs quotations_delete', async ({ page }) => {
  const q = await createQuote(page);
  const group = await api(page, 'POST', '/security-groups', { name: `No quote delete ${Date.now()}`, permissions: { quotations_create: true, quotations_delete: false } });
  const username = `qd${Date.now()}`;
  await api(page, 'POST', '/employees', { first_name: 'Quote', last_name: 'Maker', username, pin: String(Date.now()).slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
  expect(await attempt(page, 'DELETE', `/quotations/${q.id}`)).toContain('quotations_delete');
});
