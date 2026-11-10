import { test, expect } from './fixtures.js';

// A refund records how it was paid and the drawer it came out of
// (returns.refund_method / drawer_session_id), and the drawer report takes it
// off that tender's expected — so a till that paid a cash refund isn't short.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

// Signs in as a new Manager (refunds, and their own PIN authorizes returns),
// with no drawer open yet.
async function signInAsManager(page) {
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const s = stamp();
  const username = `rfd${s}`, pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Refund', last_name: 'Manager', username, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
  return pin;
}

const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));

async function sale(page, method, sessionId) {
  const p = await product(page);
  const tx = await api(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: method,
    amount_tendered: 100000, drawer_session_id: sessionId || null });
  return api(page, 'GET', `/transactions/${tx.id}`);
}
const returnBody = (tx, pin, extra) => ({ items: [{ transaction_item_id: tx.items[0].id, quantity: 1 }], resolution: 'refund', notes: 'Changed mind', override_pin: pin, ...extra });

test('refunds come off the drawer they were paid from, by tender', async ({ page }) => {
  const pin = await signInAsManager(page);
  const drawer = await api(page, 'POST', '/drawers', { name: `Refund drawer ${stamp()}`, branch_id: 1 });
  const session = await api(page, 'POST', '/drawers/sessions', { drawer_id: drawer.id, branch_id: 1, employee_id: (await page.evaluate(() => App.currentUser.id)), opening_float: 0 });

  const cashSale = await sale(page, 'cash', session.id);
  const cardSale = await sale(page, 'credit_card', session.id);

  // Cash refund from this drawer — found from the manager's own open drawer.
  const cashRet = await api(page, 'POST', `/transactions/${cashSale.id}/return`, returnBody(cashSale, pin, { refund_method: 'cash' }));
  expect(cashRet).toMatchObject({ refund_method: 'cash', drawer_session_id: session.id });
  // Card refund goes on the drawer's card line.
  const cardRet = await api(page, 'POST', `/transactions/${cardSale.id}/return`, returnBody(cardSale, pin, { refund_method: 'card' }));
  expect(cardRet).toMatchObject({ refund_method: 'card', drawer_session_id: session.id });

  const report = (await api(page, 'GET', `/drawers/sessions/${session.id}`)).report;
  const cash = report.tenders.find(t => t.key === 'cash'), card = report.tenders.find(t => t.key === 'card');
  expect(cash.refunds).toBe(cashRet.total);
  expect(cash.expected).toBeCloseTo(cashSale.total - cashRet.total, 2);
  expect(card.refunds).toBe(cardRet.total);
  expect(card.expected).toBeCloseTo(cardSale.total - cardRet.total, 2);
  expect(report.cash_refunds).toBe(cashRet.total);
  expect(report.refunds.map(r => r.return_number).sort()).toEqual([cashRet.return_number, cardRet.return_number].sort());
  // The screen shows it.
  await page.evaluate(id => App.viewDrawerReport(id), session.id);
  await expect(page.locator('h3', { hasText: 'Refunds Paid' })).toBeVisible();
  await expect(page.locator('body')).toContainText(cashRet.return_number);
  await page.evaluate(() => App.closeModal());

  // More cash than the drawer holds is refused.
  const bigSale = await sale(page, 'cash', null);
  expect(await attempt(page, 'POST', `/transactions/${bigSale.id}/return`, returnBody(bigSale, pin, { refund_method: 'cash' }))).toContain('cash is in this drawer');

  // With the drawer closed: cash refunds are refused, card ones are fine with no drawer.
  await api(page, 'PATCH', `/drawers/sessions/${session.id}/close`, {});
  const later = await sale(page, 'cash', null);
  expect(await attempt(page, 'POST', `/transactions/${later.id}/return`, returnBody(later, pin, { refund_method: 'cash' }))).toContain('comes out of a cash drawer');
  expect(await attempt(page, 'POST', `/transactions/${later.id}/return`, returnBody(later, pin, {}))).toContain('Choose how the refund is paid');
  const noDrawer = await api(page, 'POST', `/transactions/${later.id}/return`, returnBody(later, pin, { refund_method: 'card' }));
  expect(noDrawer).toMatchObject({ refund_method: 'card', drawer_session_id: null });
});

test('the return dialog asks how the refund is paid, defaulting to how the sale was paid', async ({ page }) => {
  await signInAsManager(page);
  const cardSale = await sale(page, 'credit_card', null);
  await page.evaluate(id => App.processReturn(id), cardSale.id);
  const select = page.locator('#ret-refund-method');
  await page.locator('input[name="ret-resolution"][value="refund"]').check();
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('card');
  await page.locator('input[name="ret-resolution"][value="replacement"]').check();
  await expect(select).toBeHidden();
});
