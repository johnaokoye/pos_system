import { test, expect } from './fixtures.js';

// The return receipt prints Normal (receipt printer) or Letter: a full page
// with the customer's Bill To box, the return / original sale / refund
// method, the items returned with GCT, the total refunded or credited, and
// signature lines.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('refund and credit note returns print letter size', async ({ page }) => {
  const s = `${Date.now()}`;
  const groups = await api(page, 'GET', '/security-groups');
  const pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Letter', last_name: 'Mgr', username: `lm${s}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Manager').id, active: 1 });
  const item = await api(page, 'POST', '/products', { name: `Letter Grinder ${s}`, sku: `LG${s}`, price: 1000, cost: 400, tax_rate: 15, stock_qty: 0, active: 1 });
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 5, reason: 'test', branch_id: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Rhea', last_name: `Return${s}`, phone: `876${s.slice(-7)}`, address: '12 Hope Road', city: 'Kingston' });
  const sale = await api(page, 'POST', '/transactions', { customer_id: cust.id, items: [{ product_id: item.id, quantity: 3 }], branch_id: 1, employee_id: 1, payment_method: 'card' });
  const line = (await api(page, 'GET', `/transactions/${sale.id}`)).items[0];
  const refund = await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: line.id, quantity: 2 }], resolution: 'refund', refund_method: 'card', notes: 'Wrong model bought', override_pin: pin });

  await page.evaluate(id => App.api('GET', `/transactions/returns/${id}`).then(r => App.showReturnReceipt(r)), refund.id);
  await expect(page.locator('.modal').getByRole('button', { name: /Normal/ })).toBeVisible();
  let [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.modal').getByRole('button', { name: /Letter/ }).click()]);
  await popup.waitForLoadState();
  let text = await popup.locator('body').innerText();
  for (const t of ['REFUND RECEIPT', refund.return_number, sale.transaction_number, `Rhea Return${s}`, '12 Hope Road', `Letter Grinder ${s}`, 'TOTAL REFUNDED', 'Card', 'Wrong model bought', 'Manager Signature', 'Customer Signature']) expect(text).toContain(t);
  expect(text).toContain(refund.total.toLocaleString('en-US', { minimumFractionDigits: 2 }));
  await popup.close();
  await page.evaluate(() => App.closeModal());

  // A credit note return shows its CN- number.
  const cn = await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: line.id, quantity: 1 }], resolution: 'credit_note', notes: 'Store credit please', override_pin: pin });
  const full = await api(page, 'GET', `/transactions/returns/${cn.id}`);
  expect(full.credit_note_number).toMatch(/^CN-/);
  await page.evaluate(r => App.showReturnReceipt(r), full);
  [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.modal').getByRole('button', { name: /Letter/ }).click()]);
  await popup.waitForLoadState();
  text = await popup.locator('body').innerText();
  for (const t of ['CREDIT NOTE', full.credit_note_number, 'CREDIT ISSUED']) expect(text).toContain(t);
  await popup.close();
});
