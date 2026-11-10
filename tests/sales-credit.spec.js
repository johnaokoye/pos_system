import { test, expect } from './fixtures.js';
import salesCredit from '../lib/salesCredit.js';

const { sumSalesByPeriod } = salesCredit;
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

// Two salespeople.
async function setup(page) {
  const people = (await api(page, 'GET', '/employees')).filter(e => e.username !== 'admin').slice(0, 2);
  for (const e of people) await api(page, 'PUT', `/employees/${e.id}`, { ...e, is_salesperson: 1, active: 1 });
  await page.reload();
  await page.waitForFunction(() => App.currentUser && App.can('sales_manager'));
  const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));
  return { a: people[0].id, b: people[1].id, product };
}

let n = 0;
async function createCustomer(page, salesperson_id) {
  n += 1;
  const stamp = `${Date.now()}${n}`;
  return api(page, 'POST', '/customers', { first_name: 'Credit', last_name: `Test${stamp}`, phone: stamp.slice(-10), customer_type: 'cash', force: true, ...(salesperson_id ? { salesperson_id } : {}) });
}

async function openPos(page) {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts && App._posSalespeople);
  await page.evaluate(() => { const real = App.api.bind(App); if (!App.__wrapped) { App.__wrapped = true; App.api = async (m, u, d) => { const r = await real(m, u, d); if (m === 'POST' && u === '/transactions') window.__sale = r; return r; }; } });
}

async function pay(page) {
  await page.evaluate(() => { window.__sale = null; App._salespersonReminderDone = true; App.processPayment('cash'); });
  await page.fill('#ctm-tendered', '1000000');
  await page.click('#ctm-confirm');
  await page.waitForFunction(() => window.__sale);
  return page.evaluate(() => window.__sale.id);
}

async function ringUp(page, product, customerId) {
  await openPos(page);
  await page.evaluate(() => App.clearCart());
  if (customerId) {
    await page.evaluate(id => App.setCartCustomer(id), customerId);
    await page.waitForFunction(id => App.cartCustomer?.id === id, customerId);
  }
  await page.fill('#pos-item-input', product.sku);
  await page.press('#pos-item-input', 'Enter');
  await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
}

// A signed-in Cashier: can edit customers, has no sales_manager.
async function loginWithoutSalesManager(page) {
  const groups = await api(page, 'GET', '/security-groups');
  const group = groups.find(g => g.name === 'Cashier');
  const username = `cashier${Date.now()}`;
  await api(page, 'POST', '/employees', { first_name: 'Test', last_name: 'Cashier', username, pin: username.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  const r = await fetch(`${process.env.POS_TEST_URL}/api/employees/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

const creditedTo = async (page, id) => { const t = await api(page, 'GET', `/transactions/${id}`); return t.salesperson_id ?? t.created_by ?? t.employee_id; };

test.describe('Sales credit', () => {
  test('target periods use the store clock', () => {
    const tz = 'America/Jamaica'; // UTC-5
    const now = new Date('2026-11-01T02:00:00Z'); // Saturday Oct 31, 9pm in the store
    const row = (created_at, total) => ({ employee_id: 1, total, created_at: new Date(created_at) });
    const t = sumSalesByPeriod([
      row('2026-11-01T01:30:00Z', 10), // same evening, 8:30pm: this day, week and month, not this hour
      row('2026-10-31T06:00:00Z', 100), // Oct 31, 1am: same day
      row('2026-10-31T04:00:00Z', 1000), // Oct 30, 11pm: same week and month, a day earlier
      row('2026-10-26T06:00:00Z', 5000), // Monday Oct 26, 1am: same week
      row('2026-10-26T04:00:00Z', 20000), // Sunday Oct 25, 11pm: last week, same month
      row('2026-10-01T04:00:00Z', 50000), // Sep 30, 11pm: last month, though UTC says October
    ], now, tz)[1];
    expect(t).toEqual({ hourly_sales: 0, daily_sales: 110, weekly_sales: 6110, monthly_sales: 26110 });

    const nine = sumSalesByPeriod([row('2026-11-01T02:10:00Z', 7)], now, tz)[1];
    expect(nine.hourly_sales).toBe(7);
    expect(nine.monthly_sales).toBe(7); // October in the store, November in UTC
  });

  test('a reassigned quote stays with its original salesperson, by Convert or Quote Recall', async ({ page }) => {
    const { a, b, product } = await setup(page);
    const quote = async () => {
      const q = await api(page, 'POST', '/quotations', { employee_id: a, branch_id: 1, items: [{ product_id: product.id, quantity: 1 }] });
      await api(page, 'PATCH', `/quotations/${q.id}/reassign`, { employee_id: b });
      return q;
    };
    const converted = await quote();
    const held = await api(page, 'POST', `/quotations/${converted.id}/convert`, {});
    await openPos(page);
    await page.evaluate(id => App.loadHeldOrder(id), held.id);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
    expect(await creditedTo(page, await pay(page))).toBe(a);

    const recalled = await quote();
    await openPos(page);
    await page.evaluate(id => App.loadQuoteToCart(id), recalled.id);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
    expect(await creditedTo(page, await pay(page))).toBe(a);
  });

  test('a customer\'s salesperson owns their POS sale, shown locked on the ticket', async ({ page }) => {
    const { a, b, product } = await setup(page);
    const c = await createCustomer(page, a);
    expect(c.salesperson_id).toBe(a);
    await ringUp(page, product, c.id);
    await expect(page.locator('#pos-salesperson')).toBeDisabled();
    await expect(page.locator('#pos-salesperson')).toHaveValue(String(a));
    const id = await pay(page);
    expect(await creditedTo(page, id)).toBe(a);

    // Still reassignable afterwards, and the meter follows.
    const meter = async who => (await api(page, 'GET', '/sales-targets')).find(e => e.id === who).daily_sales;
    const [aBefore, bBefore] = [await meter(a), await meter(b)];
    await api(page, 'PATCH', '/transactions/salesperson', { ids: [id], salesperson_id: b, reason: 'test' });
    expect(await creditedTo(page, id)).toBe(b);
    expect(await meter(a)).toBeLessThan(aBefore);
    expect(await meter(b)).toBeGreaterThan(bBefore);
  });

  test('a customer\'s salesperson beats a ticket another salesperson started', async ({ page }) => {
    const { a, b, product } = await setup(page);
    const c = await createCustomer(page, a);
    const held = await api(page, 'POST', '/transactions/hold', { customer_id: c.id, employee_id: b, created_by: b, branch_id: 1, items: [{ product_id: product.id, product_name: product.name, quantity: 1, unit_price: product.price, tax_rate: product.tax_rate }] });
    expect(held.salesperson_id).toBe(a);
  });

  test('with no customer salesperson, picking is optional and a pick counts', async ({ page }) => {
    const { b, product } = await setup(page);
    const me = await page.evaluate(() => App.currentUser.id);
    await ringUp(page, product);
    await expect(page.locator('#pos-salesperson')).toBeEnabled();
    expect(await creditedTo(page, await pay(page))).toBe(me);

    const c = await createCustomer(page);
    await ringUp(page, product, c.id);
    await page.selectOption('#pos-salesperson', String(b));
    expect(await creditedTo(page, await pay(page))).toBe(b);
  });

  test('the payment reminder: pick, continue without, or go back', async ({ page }) => {
    const { b, product } = await setup(page);
    const me = await page.evaluate(() => App.currentUser.id);
    const reminder = page.locator('.modal-title', { hasText: 'Who made this sale?' });
    const start = () => page.evaluate(() => { window.__sale = null; App.processPayment('cash'); });
    const finish = async () => {
      await page.fill('#ctm-tendered', '1000000');
      await page.click('#ctm-confirm');
      await page.waitForFunction(() => window.__sale);
      return page.evaluate(() => window.__sale.id);
    };

    // Going back keeps the ticket and takes no payment; it asks again next time.
    await ringUp(page, product);
    await start();
    await expect(reminder).toBeVisible();
    await page.click('#spr-back');
    await expect(reminder).toHaveCount(0);
    await expect(page.locator('#ctm-tendered')).toHaveCount(0);
    expect(await page.evaluate(() => App.cart.length)).toBe(1);

    // Picking credits that person. Use stays off until someone is chosen.
    await start();
    await expect(page.locator('#spr-use')).toBeDisabled();
    await page.selectOption('#spr-pick', String(b));
    await page.click('#spr-use');
    expect(await creditedTo(page, await finish())).toBe(b);

    // Continuing without stays with the cashier, and only asks once a ticket.
    await ringUp(page, product);
    await start();
    await page.click('#spr-skip');
    await page.click('#ctm-x');
    await start();
    await expect(page.locator('#ctm-tendered')).toBeVisible();
    await expect(reminder).toHaveCount(0);
    expect(await creditedTo(page, await finish())).toBe(me);

    // The next ticket asks again.
    await ringUp(page, product);
    await start();
    await expect(reminder).toBeVisible();
    await page.click('#spr-back');
  });

  test('no payment reminder when someone already gets the credit', async ({ page }) => {
    const { a, b, product } = await setup(page);
    const noReminder = async () => {
      await page.evaluate(() => { App.processPayment('cash'); });
      await expect(page.locator('#ctm-tendered')).toBeVisible();
      await expect(page.locator('.modal-title', { hasText: 'Who made this sale?' })).toHaveCount(0);
      await page.click('#ctm-x');
    };
    // The customer has a salesperson.
    const owned = await createCustomer(page, a);
    await ringUp(page, product, owned.id);
    await noReminder();
    // A salesperson was picked on the ticket.
    await ringUp(page, product);
    await page.selectOption('#pos-salesperson', String(b));
    await noReminder();
    // A salesperson started it (their quote, put through by the cashier).
    const q = await api(page, 'POST', '/quotations', { employee_id: a, branch_id: 1, items: [{ product_id: product.id, quantity: 1 }] });
    await openPos(page);
    await page.evaluate(id => App.loadQuoteToCart(id), q.id);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
    await noReminder();
    // A salesperson is ringing up.
    await ringUp(page, product);
    await page.evaluate(id => { App.currentUser.id = id; }, a);
    expect(await page.evaluate(() => App._ticketNeedsSalesperson())).toBe(false);
  });

  test('a layaway belongs to the customer\'s salesperson', async ({ page }) => {
    const { a, product } = await setup(page);
    const c = await createCustomer(page, a);
    const full = await api(page, 'GET', `/products/${product.id}`);
    await api(page, 'PUT', `/products/${product.id}`, { ...full, is_layaway_eligible: 1 });
    const plan = await api(page, 'POST', '/layaway/plans', { customer_id: c.id, branch_id: 1, employee_id: 1, items: [{ product_id: product.id, quantity: 1 }], payment_method: 'cash' });
    const sales = await api(page, 'GET', `/transactions?customer_id=${c.id}`);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales[0].salesperson_id).toBe(a);
    expect(plan.id).toBeTruthy();
  });

  test('a salesperson who is no longer active doesn\'t get the sale', async ({ page }) => {
    const { a, b, product } = await setup(page);
    const c = await createCustomer(page, a);
    const person = (await api(page, 'GET', '/employees')).find(e => e.id === a);
    await api(page, 'PUT', `/employees/${a}`, { ...person, active: 0 });
    try {
      const held = await api(page, 'POST', '/transactions/hold', { customer_id: c.id, employee_id: 1, created_by: 1, salesperson_id: b, branch_id: 1, items: [{ product_id: product.id, product_name: product.name, quantity: 1, unit_price: product.price, tax_rate: product.tax_rate }] });
      expect(held.salesperson_id).toBe(b);
    } finally {
      await api(page, 'PUT', `/employees/${a}`, { ...person, active: 1 });
    }
  });

  test('the customer form assigns a salesperson, and only a sales manager can change it', async ({ page }) => {
    const { a, b } = await setup(page);
    const c = await createCustomer(page);
    await page.evaluate(() => App.showSection('customers'));
    await page.evaluate(id => App.showCustomerForm(id), c.id);
    await page.waitForFunction(id => document.querySelector(`#cf-salesperson option[value="${id}"]`), a);
    await page.selectOption('#cf-salesperson', String(a));
    await page.evaluate(id => App.saveCustomer(id), c.id);
    await expect(page.locator('.modal')).toHaveCount(0);
    const saved = await api(page, 'GET', `/customers/${c.id}`);
    expect(saved.salesperson_id).toBe(a);

    expect(await page.evaluate(([id, body]) => App.api('PUT', `/customers/${id}`, body).then(() => 'saved', e => e.message), [c.id, { ...saved, salesperson_id: 999999 }])).toContain('not an active Salesperson');

    // Without sales_manager: refused if it changes, and other edits still save.
    const cookie = await loginWithoutSalesManager(page);
    const put = body => fetch(`${process.env.POS_TEST_URL}/api/customers/${c.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    const refused = await put({ ...saved, salesperson_id: b });
    expect(refused.status).toBe(403);
    const { salesperson_id, ...withoutIt } = saved;
    expect((await put({ ...withoutIt, notes: 'edited' })).status).toBe(200);
    expect(await api(page, 'GET', `/customers/${c.id}`)).toMatchObject({ notes: 'edited', salesperson_id: a });
  });
});

test.describe('Who sees sales targets', () => {
  // Signs in as a new employee in a group with these permissions.
  async function signInAs(page, permissions, is_salesperson) {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const group = await api(page, 'POST', '/security-groups', { name: `Targets ${stamp}`, description: '', permissions });
    const username = `tgt${stamp}`;
    const emp = await api(page, 'POST', '/employees', { first_name: 'Target', last_name: `Viewer ${stamp}`, username, pin: stamp.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1, is_salesperson });
    await page.context().clearCookies();
    await page.goto('/');
    await page.fill('#login-user', username);
    await page.fill('#login-pass', 'pw-123456');
    await page.click('button.login-btn');
    await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
    return emp;
  }

  test('managers see everyone, a salesperson only themselves, anyone else nobody', async ({ page }) => {
    const { a, b } = await setup(page);
    const all = await api(page, 'GET', '/sales-targets');
    expect(all.map(e => e.id)).toEqual(expect.arrayContaining([a, b]));

    // A salesperson with CRM but no reports / sales_manager: just themselves,
    // even when asking for someone else.
    const me = await signInAs(page, { crm: true }, 1);
    expect((await api(page, 'GET', '/sales-targets')).map(e => e.id)).toEqual([me.id]);
    expect((await api(page, 'GET', `/sales-targets?employee_id=${a}`)).map(e => e.id)).toEqual([me.id]);

    // Not a salesperson, same group shape: nobody's.
    await page.context().clearCookies();
    await page.goto('/');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await page.waitForFunction(() => App.currentUser);
    await signInAs(page, { crm: true }, 0);
    expect(await api(page, 'GET', '/sales-targets')).toEqual([]);
  });
});
