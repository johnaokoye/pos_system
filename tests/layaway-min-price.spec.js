import { test, expect } from './fixtures.js';

// Settings → Layaway: a minimum item price, and "every item at or above it is
// eligible"; Settings → Minimum Purchase for a Discount (manual line/ticket
// discounts only).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const apiErr = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => null, e => e.message), [method, url, data]);
const phone = () => `8${String(Math.random()).slice(2, 11)}`;

async function withSettings(page, values, fn) {
  const before = await api(page, 'GET', '/settings');
  const restore = Object.fromEntries(Object.keys(values).map(k => [k, before[k] ?? '0']));
  await api(page, 'PUT', '/settings', values);
  await page.evaluate(async () => { App.settings = await App.api('GET', '/settings'); });
  try { await fn(); } finally {
    await api(page, 'PUT', '/settings', restore);
    await page.evaluate(async () => { App.settings = await App.api('GET', '/settings'); });
  }
}

test('layaway minimum price: cheaper items are refused even if ticked, and with auto every item above it is eligible', async ({ page }) => {
  const s = `${Date.now()}`;
  const home = await page.evaluate(() => App._homeBranch());
  const branch = home || (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const cheapTicked = await api(page, 'POST', '/products', { sku: `LMC-${s}`, name: `Lay Cheap ${s}`, price: 500, tax_rate: 0, branch_id: branch.id, stock_qty: 3, is_layaway_eligible: 1 });
  const dearUnticked = await api(page, 'POST', '/products', { sku: `LMD-${s}`, name: `Lay Dear ${s}`, price: 20000, tax_rate: 0, branch_id: branch.id, stock_qty: 3 });
  const dearTicked = await api(page, 'POST', '/products', { sku: `LMT-${s}`, name: `Lay Ticked ${s}`, price: 15000, tax_rate: 0, branch_id: branch.id, stock_qty: 3, is_layaway_eligible: 1 });
  const customer = await api(page, 'POST', '/customers', { address: '1 Test Road', phone: phone(), first_name: 'Lay', last_name: `Min ${s}`, customer_type: 'cash', force: true });
  const plan = items => ({ customer_id: customer.id, branch_id: branch.id, items, payment_method: 'cash', amount_tendered: 100000, payment_frequency: 'monthly' });
  const eligibleIds = async () => (await api(page, 'GET', `/products?is_layaway_eligible=1&active=1&branch_id=${branch.id}&search=${s}`)).map(p => p.id).sort();

  await withSettings(page, { layaway_min_price: '10000', layaway_auto_eligible: '0' }, async () => {
    expect(await eligibleIds()).toEqual([dearTicked.id]);
    expect(await apiErr(page, 'POST', '/layaway/plans', plan([{ product_id: cheapTicked.id, quantity: 1 }]))).toMatch(/below the layaway minimum/);
    expect(await apiErr(page, 'POST', '/layaway/plans', plan([{ product_id: dearUnticked.id, quantity: 1 }]))).toMatch(/not eligible/);
  });

  await withSettings(page, { layaway_min_price: '10000', layaway_auto_eligible: '1' }, async () => {
    expect(await eligibleIds()).toEqual([dearUnticked.id, dearTicked.id].sort());
    const made = await api(page, 'POST', '/layaway/plans', plan([{ product_id: dearUnticked.id, quantity: 1 }]));
    expect(made.plan_number).toMatch(/^LAY-/);
    expect(await apiErr(page, 'POST', '/layaway/plans', plan([{ product_id: cheapTicked.id, quantity: 1 }]))).toMatch(/below the layaway minimum/);

    // The settings screen shows both fields.
    await page.evaluate(() => App.showSection('settings'));
    await expect(page.locator('#s-layaway-min-price')).toHaveValue('10000');
    await expect(page.locator('#s-layaway-auto')).toBeChecked();
  });
});

test('minimum purchase for a discount: a small ticket can\'t take a manual discount, a big one can, promotions untouched', async ({ page }) => {
  const s = `${Date.now()}`;
  const home = await page.evaluate(() => App._homeBranch());
  const branch = home || (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const item = await api(page, 'POST', '/products', { sku: `DMP-${s}`, name: `Disc Min ${s}`, price: 1000, tax_rate: 0, branch_id: branch.id, stock_qty: 50 });
  const sell = (qty, extra) => ({ branch_id: branch.id, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, items: [{ product_id: item.id, quantity: qty, unit_price: 1000, ...(extra.line || {}) }], ...(extra.ticket || {}) });

  await withSettings(page, { discount_min_purchase: '5000', max_discount_pct: '0' }, async () => {
    expect(await apiErr(page, 'POST', '/transactions', sell(2, { ticket: { discount_amount: 100 } }))).toMatch(/at least 5000\.00/);
    expect(await apiErr(page, 'POST', '/transactions', sell(2, { line: { discount_percent: 10 } }))).toMatch(/at least 5000\.00/);
    // At the minimum (before discounts) it goes through.
    const ok = await api(page, 'POST', '/transactions', sell(5, { line: { discount_percent: 10 } }));
    expect(ok.status).toBe('completed');
    // A promotion's discount isn't a manual one.
    const promo = await api(page, 'POST', '/transactions', sell(1, { ticket: { discount_amount: 100, promotion_name: 'Test Promo' } }));
    expect(promo.status).toBe('completed');

    // POS: the Ticket Discount is refused on a small ticket.
    await page.evaluate(() => App.showSection('pos'));
    await page.evaluate(p => { App.clearCart(); App.addToCart(p); }, await api(page, 'GET', `/products/${item.id}?branch_id=${branch.id}`));
    await page.evaluate(() => App.showTicketDiscountModal());
    await page.fill('#discount-input', '50');
    await page.click('#discount-row button:has-text("Apply")');
    await expect(page.locator('body')).toContainText('A discount needs a purchase of at least');
    expect(await page.evaluate(() => App.cartDiscount)).toBeFalsy();
  });
});
