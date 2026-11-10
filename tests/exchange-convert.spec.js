import { test, expect } from './fixtures.js';

const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0 && p.tax_rate > 0)));

async function manager(page) {
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = stamp().slice(-6);
  const username = `mgr${stamp()}`;
  await api(page, 'POST', '/employees', { first_name: 'Conv', last_name: 'Manager', username, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  return pin;
}

// A sale, returned as an exchange that's waiting in Hold Recall.
async function waitingExchange(page, { method = 'cash', customerType = 'cash' } = {}) {
  const s = stamp();
  const customer = await api(page, 'POST', '/customers', { first_name: 'Exch', last_name: `C${s}`, phone: s.slice(-10), customer_type: customerType, credit_limit: 100000, credit_terms_days: 30, force: true });
  const p = await product(page);
  const sale = await api(page, 'POST', '/transactions', { customer_id: customer.id, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: method, amount_tendered: method === 'credit' ? 0 : 100000 });
  const full = await api(page, 'GET', `/transactions/${sale.id}`);
  const pin = await manager(page);
  const ret = await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: full.items[0].id, quantity: 1 }], resolution: 'replacement', notes: 'Wrong item', employee_id: 1, override_pin: pin });
  return { customer, sale, ret, pin, product: p };
}

const openConvert = async (page, ret) => {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(() => App.recallOrder());
  await page.locator('div', { hasText: ret.return_number }).locator('button:has-text("Convert")').last().click();
  await expect(page.locator('.modal-title', { hasText: 'Convert Exchange' })).toBeVisible();
};

test.describe('Convert Exchange', () => {
  test('to a refund from Hold Recall: the card goes, the credit can no longer be spent, stock is not moved again', async ({ page }) => {
    const { customer, ret, pin, product: p } = await waitingExchange(page);
    const stockBefore = (await api(page, 'GET', `/products/${p.id}`)).stock_qty;
    await openConvert(page, ret);
    await page.locator('input[name="cx-to"][value="refund"]').check();
    // How it's paid back: card needs no open drawer (a cash refund would).
    await expect(page.locator('#cx-refund-method')).toBeVisible();
    await page.selectOption('#cx-refund-method', 'card');

    // Needs a reason and a real manager's PIN.
    await page.click('#cx-confirm');
    await expect(page.locator('.modal-title', { hasText: 'Convert Exchange' })).toBeVisible();
    await page.fill('#cx-reason', 'Customer wants their money back');
    await page.fill('#cx-pin', '000000');
    await page.click('#cx-confirm');
    await expect(page.locator('#cx-pin')).toHaveValue('');
    expect((await api(page, 'GET', `/transactions/returns/${ret.id}`)).resolution).toBe('replacement');

    await page.fill('#cx-pin', pin);
    await page.click('#cx-confirm');
    await expect(page.locator('.receipt-row', { hasText: 'Converted from exchange' })).toBeVisible();
    await expect(page.locator('.receipt-row', { hasText: 'Conversion reason' })).toContainText('money back');
    await expect(page.locator('.receipt-row', { hasText: 'Resolution' })).toContainText('Refund');

    const after = await api(page, 'GET', `/transactions/returns/${ret.id}`);
    expect(after.resolution).toBe('refund');
    expect(after.refund_method).toBe('card');
    expect(after.total).toBe(ret.total);
    expect((await api(page, 'GET', '/transactions/pending-exchanges')).map(r => r.id)).not.toContain(ret.id);
    expect((await api(page, 'GET', `/products/${p.id}`)).stock_qty).toBe(stockBefore);
    expect((await api(page, 'GET', `/customers/${customer.id}`)).account_balance).toBe(0);

    // Books' feed, and refunds now include it.
    const conv = (await api(page, 'GET', '/transactions/exchange-conversions')).find(c => c.return_id === ret.id);
    expect(conv).toMatchObject({ to_resolution: 'refund', amount: ret.total, return_number: ret.return_number });
    expect((await api(page, 'GET', `/transactions/returns?resolution=refund&number=${ret.return_number}`)).map(r => r.id)).toEqual([ret.id]);

    // Can't be spent or converted again.
    const again = await attempt(page, 'POST', '/transactions', { customer_id: customer.id, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, source_return_id: ret.id, discount_amount: ret.total });
    expect(again).toContain("wasn't processed as an exchange");
    expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/convert`, { to: 'credit_note', reason: 'x', override_pin: pin })).toContain("wasn't processed as an exchange");
  });

  test("to a credit note: it lands on the customer's account and tells Books it came from an exchange", async ({ page }) => {
    const { customer, ret, pin } = await waitingExchange(page);
    expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/convert`, { to: 'credit_note', reason: 'Store credit instead', override_pin: pin })).toBe('accepted');

    expect((await api(page, 'GET', `/customers/${customer.id}`)).account_balance).toBeCloseTo(-ret.total, 2);
    const credits = await api(page, 'GET', `/customers/${customer.id}/credits`);
    expect(credits.notes.some(c => Math.abs(c.amount - ret.total) < 0.005 && Math.abs(c.remaining - ret.total) < 0.005)).toBe(true);

    const row = (await api(page, 'GET', '/accounts/payments-feed?since_id=0&limit=500')).find(p => p.return_id === ret.id);
    expect(row).toMatchObject({ payment_method: 'credit_note', return_number: ret.return_number });
    expect(row.converted_exchange).toBeTruthy();
  });

  test('a sale charged to an account can only become a credit note, which comes off what they owe', async ({ page }) => {
    const { customer, sale, ret, pin } = await waitingExchange(page, { method: 'credit', customerType: 'credit' });
    await openConvert(page, ret);
    await expect(page.locator('input[name="cx-to"][value="refund"]')).toBeDisabled();
    await page.locator('input[name="cx-to"][value="credit_note"]').check();
    expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/convert`, { to: 'refund', reason: 'x', override_pin: pin })).toContain('charged to the customer');

    await page.fill('#cx-reason', 'Goods not replaced');
    await page.fill('#cx-pin', pin);
    await page.click('#cx-confirm');
    await expect(page.locator('.receipt-row', { hasText: 'Resolution' })).toContainText('Credit Note');
    expect((await api(page, 'GET', `/customers/${customer.id}`)).account_balance).toBeCloseTo(sale.total - ret.total, 2);
  });

  test('an exchange whose credit has already been spent is refused', async ({ page }) => {
    const { customer, ret, pin, product: p } = await waitingExchange(page);
    await api(page, 'POST', '/transactions', { customer_id: customer.id, items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, source_return_id: ret.id, discount_amount: ret.total });
    expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/convert`, { to: 'refund', reason: 'x', override_pin: pin })).toContain('already been used');
    expect((await api(page, 'GET', `/transactions/returns/${ret.id}`)).resolution).toBe('replacement');
  });

  test('the button needs returns plus refund or credit note rights, and a cashier PIN does not authorize it', async ({ page }) => {
    const { ret } = await waitingExchange(page);
    await page.evaluate(() => { App._realCan = App.can; App.can = key => !['transactions_refund', 'transactions_credit_note'].includes(key) && App._realCan(key); });
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForFunction(() => App.allProducts);
    await page.evaluate(() => App.recallOrder());
    await expect(page.locator('.modal').getByText(ret.return_number)).toBeVisible();
    await expect(page.locator('.modal button:has-text("Convert")')).toHaveCount(0);
    await page.evaluate(() => { App.can = App._realCan; delete App._realCan; });

    const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Cashier');
    const pin = stamp().slice(-6);
    await api(page, 'POST', '/employees', { first_name: 'Till', last_name: 'Cashier', username: `till${stamp()}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
    expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/convert`, { to: 'refund', reason: 'x', override_pin: pin })).toContain("isn't a manager");
  });
});
