import { test, expect } from './fixtures.js';

// An exchange's replacement ticket put on hold carries its return credit:
// Hold Recall shows that one held ticket (EXCHANGE, the return, Convert),
// not the exchange card as well, and recalling it brings the credit back.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test('a held exchange ticket keeps its credit and replaces the exchange card', async ({ page }) => {
  const s = stamp();
  const customer = await api(page, 'POST', '/customers', { first_name: 'Hold', last_name: `Exch${s}`, phone: s.slice(-10), force: true });
  const p = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0 && p.tax_rate > 0)));
  const sale = await api(page, 'POST', '/transactions', { customer_id: customer.id, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000 });
  const full = await api(page, 'GET', `/transactions/${sale.id}`);
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Hx', last_name: 'Mgr', username: `hx${s}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  const ret = await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: full.items[0].id, quantity: 1 }], resolution: 'replacement', notes: 'Wrong one', employee_id: 1, override_pin: pin });

  // The till opens on the credit; ring up the replacement and hold it.
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts && App.posBranch);
  await page.evaluate(r => App.recallExchange(r.id), ret);
  await page.waitForFunction(() => App._returnCredit);
  await page.evaluate(id => App.addToCart(id, App._unitChoices(App.allProducts.find(x => x.id === id))[0]), p.id);
  await page.waitForFunction(() => App.cart.length === 1);
  await page.evaluate(() => App.holdOrder());
  await page.waitForFunction(() => App.cart.length === 0);

  const hold = (await api(page, 'GET', `/transactions?status=hold&customer_id=${customer.id}`))[0];
  expect(hold.source_return_id).toBe(ret.id);
  expect(hold.source_return_number).toBe(ret.return_number);
  expect(hold.discount_source).toBeNull();
  // Credit comes off after tax: the held total is the ticket with tax less the credit.
  expect(hold.total).toBeCloseTo(Math.max(0, hold.subtotal + hold.tax_amount - hold.discount_amount), 2);
  // The exchange isn't listed separately, and hasn't been spent.
  expect((await api(page, 'GET', '/transactions/pending-exchanges')).map(r => r.id)).not.toContain(ret.id);
  expect((await api(page, 'GET', '/transactions/pending-exchanges?include_held=1')).map(r => r.id)).toContain(ret.id);

  // Hold Recall: one card, marked Exchange with the return and Convert.
  await page.evaluate(() => App.recallOrder());
  const cards = page.locator('.modal-body div[onclick]', { hasText: ret.return_number });
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('EXCHANGE');
  await expect(cards).toContainText(hold.transaction_number);
  await expect(cards.locator('button:has-text("Convert")')).toBeVisible();

  // Recalling it brings the credit back as the return credit, not a discount.
  await cards.click();
  await page.waitForFunction(() => App.cart.length === 1 && App._recalledHoldId);
  expect(await page.evaluate(() => App._returnCredit)).toMatchObject({ id: ret.id, return_number: ret.return_number, amount: ret.total });
  expect(await page.evaluate(() => App._manualTicketDiscount)).toBe(false);

  // Paid: the hold goes, the credit is spent on the sale.
  const done = await page.evaluate(([cid, rid, hid, pid]) => App.api('POST', '/transactions', { customer_id: cid, items: [{ product_id: pid, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, source_return_id: rid, discount_amount: App.cartDiscount, hold_id: hid }), [customer.id, ret.id, hold.id, p.id]);
  expect(done.source_return_id).toBe(ret.id);
  expect((await api(page, 'GET', '/transactions/pending-exchanges?include_held=1')).map(r => r.id)).not.toContain(ret.id);

  // The Transactions list says how the original sale was returned.
  await page.evaluate(() => App.clearCart());
  const listed = (await api(page, 'GET', `/transactions?customer_id=${customer.id}`)).find(t => t.id === sale.id);
  expect(listed.return_types).toBe('exchange');
  expect(await page.evaluate(t => App._returnTypesLabel(t), 'refund:cash,credit_note')).toBe('Cash Refund + Credit Note');
});

test('converting an exchange that is on hold takes the credit off the held ticket', async ({ page }) => {
  const s = stamp();
  const customer = await api(page, 'POST', '/customers', { first_name: 'Hold', last_name: `Conv${s}`, phone: s.slice(-10), force: true });
  const p = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));
  const sale = await api(page, 'POST', '/transactions', { customer_id: customer.id, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000 });
  const full = await api(page, 'GET', `/transactions/${sale.id}`);
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Hc', last_name: 'Mgr', username: `hc${s}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  const ret = await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: full.items[0].id, quantity: 1 }], resolution: 'replacement', notes: 'Wrong one', employee_id: 1, override_pin: pin });
  const hold = await api(page, 'POST', '/transactions/hold', { customer_id: customer.id, branch_id: 1, employee_id: 1, source_return_id: ret.id, discount_amount: ret.total, items: [{ product_id: p.id, product_name: p.name, quantity: 1, unit_price: p.price, tax_rate: p.tax_rate }] });

  const done = await api(page, 'POST', `/transactions/returns/${ret.id}/convert`, { to: 'credit_note', reason: 'Wants credit', override_pin: pin });
  expect(done.held_tickets).toEqual([hold.transaction_number]);
  const after = await api(page, 'GET', `/transactions/${hold.id}`);
  expect(after.status).toBe('hold');
  expect(after.source_return_id).toBeNull();
  expect(after.discount_amount).toBe(0);
  expect(after.total).toBeCloseTo(after.subtotal + after.tax_amount, 2);
});
