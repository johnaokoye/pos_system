import { test, expect } from './fixtures.js';

const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
let n = 0;

const taxedProduct = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0 && p.tax_rate > 0)));

// A credit customer, not marked Tax Exempt and with no exemption number.
async function customer(page) {
  const stamp = `${Date.now()}${++n}`;
  return api(page, 'POST', '/customers', { first_name: 'Exempt', last_name: `T${stamp}`, phone: stamp.slice(-10), customer_type: 'credit', credit_limit: 100000, credit_terms_days: 30, force: true });
}

// Signs in as a new member of the seeded Cashier group, with a drawer open.
async function signInAsCashierWithDrawer(page) {
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Cashier');
  const drawer = await api(page, 'POST', '/drawers', { name: `Exempt drawer ${Date.now()}${++n}`, branch_id: 1 });
  const username = `cashier${Date.now()}${++n}`;
  await api(page, 'POST', '/employees', { first_name: 'Test', last_name: 'Cashier', username, pin: username.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
  const session = await page.evaluate(id => App.api('POST', '/drawers/sessions', { drawer_id: id, branch_id: 1, employee_id: App.currentUser.id, opening_float: 0 }), drawer.id);
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(s => { App.currentDrawerSession = s; App._salespersonReminder = async () => true; }, session);
  return session;
}

const drawerLine = async (page, id) => (await api(page, 'GET', `/drawers/sessions/${id}`)).report.tenders.find(t => t.key === 'tax_exempt_tender');
const addToTicket = (page, product) => page.evaluate(id => App.addToCart(id), product.id);

test.describe('Tax Exempt tender', () => {
  test('any cashier takes it on a new sale: the full total is paid and the GCT stays on the receipt', async ({ page }) => {
    const product = await taxedProduct(page);
    const session = await signInAsCashierWithDrawer(page);
    await addToTicket(page, product);
    const totals = await page.evaluate(() => App.getCartTotals());
    expect(totals.tax).toBeGreaterThan(0);

    await page.evaluate(() => App.showPOSPaymentModal());
    await page.click('#pay-tax-exempt');
    await expect(page.locator('#etm-gct')).toContainText('Includes GCT');
    await page.fill('#etm-ref', 'JDF-77');
    await page.click('#etm-confirm');
    await expect(page.locator('.receipt-row', { hasText: 'TAX EXEMPT TENDER' })).toBeVisible();
    await expect(page.locator('.receipt-row', { hasText: 'Exemption Ref #' })).toContainText('JDF-77');

    const sale = (await api(page, 'GET', `/transactions?limit=20`));
    const tx = (Array.isArray(sale) ? sale : sale.transactions).find(t => t.payment_method === 'tax_exempt_tender' && t.drawer_session_id === session.id);
    const full = await api(page, 'GET', `/transactions/${tx.id}`);
    expect(full.total).toBeCloseTo(totals.total, 2);
    expect(full.tax_amount).toBeCloseTo(totals.tax, 2);
    expect(full.tax_exempt).toBeFalsy();
    expect(full.approval_code).toBe('JDF-77');
    expect(full.payments[0]).toMatchObject({ payment_method: 'tax_exempt_tender' });

    // Money received: its own line on the drawer, expected in full.
    const line = await drawerLine(page, session.id);
    expect(line.uncounted).toBe(false);
    expect(line.sales).toBeCloseTo(totals.total, 2);
    expect(line.expected).toBeCloseTo(totals.total, 2);
  });

  test('it needs no reference and can be one leg of a split', async ({ page }) => {
    const product = await taxedProduct(page);
    const session = await signInAsCashierWithDrawer(page);
    await addToTicket(page, product);
    const { total } = await page.evaluate(() => App.getCartTotals());

    await page.evaluate(() => { App.processPayment('split'); });
    const rows = page.locator('#stm-rows .stm-row');
    await rows.nth(0).locator('.stm-method').selectOption('tax_exempt_tender');
    await expect(rows.nth(0).locator('.stm-ref')).toBeVisible();
    await rows.nth(0).locator('.stm-amount').fill('1.00');
    await rows.nth(1).locator('.stm-method').selectOption('cash');
    await rows.nth(1).locator('.stm-amount').fill((total - 1).toFixed(2));
    await page.click('#stm-confirm');
    await expect(page.locator('.receipt-row', { hasText: 'TAX EXEMPT TENDER' })).toBeVisible();
    expect((await drawerLine(page, session.id)).sales).toBeCloseTo(1, 2);
  });

  test('Receive Payment takes it as money, for a customer who isn\'t marked', async ({ page }) => {
    const c = await customer(page);
    const product = await taxedProduct(page);
    const sale = await api(page, 'POST', '/transactions', { customer_id: c.id, items: [{ product_id: product.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'credit', amount_tendered: 0 });
    const session = await signInAsCashierWithDrawer(page);

    await page.evaluate(() => App.showReceivePaymentModal());
    await page.evaluate(id => App._rpLoad(id), c.id);
    await page.selectOption('#rp-method', 'tax_exempt_tender');
    await page.locator('input[name="rp-mode"][value="invoices"]').check();
    await page.selectOption('#rp-method', 'tax_exempt_tender');
    await page.locator('.rp-pick').first().check();
    await expect(page.locator('#rp-amount')).toHaveValue(Number(sale.total).toFixed(2));
    await page.click('#rp-submit');
    await expect(page.locator('#rp-submit')).toHaveCount(0);

    const after = await api(page, 'GET', `/customer-payments/${c.id}`);
    expect(after.invoices).toHaveLength(0);
    expect((await drawerLine(page, session.id)).sales).toBeCloseTo(sale.total, 2);
  });

  test('GCT can no longer be cleared off an invoice without money', async ({ page }) => {
    const c = await customer(page);
    const product = await taxedProduct(page);
    const sale = await api(page, 'POST', '/transactions', { customer_id: c.id, items: [{ product_id: product.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'credit', amount_tendered: 0 });
    const session = await signInAsCashierWithDrawer(page);

    const refused = await page.evaluate(([cid, txId, amount, s]) => App.api('POST', '/customer-payments', { customer_id: cid, amount, payment_method: 'tax_exempt', payment_mode: 'invoices', drawer_session_id: s, allocations: [{ transaction_id: txId, amount }] }).then(() => 'accepted', e => e.message), [c.id, sale.id, sale.tax_amount, session.id]);
    expect(refused).toBe('Choose how the customer paid');
    await page.evaluate(() => App.showReceivePaymentModal());
    await page.evaluate(id => App._rpLoad(id), c.id);
    await expect(page.locator('#rp-method option[value="tax_exempt"]')).toHaveCount(0);
  });

  test('a drawer reconciles the Tax Exempt line', async ({ page }) => {
    // Admin: the test server grants it Close & Reconcile; the seeded Cashier group doesn't have it.
    const product = await taxedProduct(page);
    const drawer = await api(page, 'POST', '/drawers', { name: `Exempt drawer ${Date.now()}${++n}`, branch_id: 1 });
    const session = await page.evaluate(id => App.api('POST', '/drawers/sessions', { drawer_id: id, branch_id: 1, employee_id: App.currentUser.id, opening_float: 0 }), drawer.id);
    await page.evaluate(([s, pid]) => App.api('POST', '/transactions', { items: [{ product_id: pid, quantity: 1 }], branch_id: 1, employee_id: App.currentUser.id, drawer_session_id: s, payment_method: 'tax_exempt_tender' }), [session.id, product.id]);
    const { expected } = await drawerLine(page, session.id);
    expect(expected).toBeGreaterThan(0);
    await api(page, 'POST', `/drawers/sessions/${session.id}/reconcile`, { float_returned: 0, tax_exempt_tender_counted: expected });
    const line = await drawerLine(page, session.id);
    expect(line.counted).toBeCloseTo(expected, 2);
    expect(line.variance).toBe(0);
  });

  test('a layaway takes it, and it counts on the drawer', async ({ page }) => {
    const c = await customer(page);
    const product = await taxedProduct(page);
    await api(page, 'PUT', `/products/${product.id}`, { ...(await api(page, 'GET', `/products/${product.id}`)), is_layaway_eligible: 1 });
    const drawer = await api(page, 'POST', '/drawers', { name: `Exempt drawer ${Date.now()}${++n}`, branch_id: 1 });
    const session = await page.evaluate(id => App.api('POST', '/drawers/sessions', { drawer_id: id, branch_id: 1, employee_id: App.currentUser.id, opening_float: 0 }), drawer.id);
    await page.evaluate(([cid, s, pid]) => App.api('POST', '/layaway/plans', { customer_id: cid, branch_id: 1, employee_id: App.currentUser.id, items: [{ product_id: pid, quantity: 1 }], payment_method: 'tax_exempt_tender', drawer_session_id: s, payment_frequency: 'monthly' }), [c.id, session.id, product.id]);
    expect((await drawerLine(page, session.id)).sales).toBeGreaterThan(0);
  });
});
