import { test, expect } from './fixtures.js';

// Refund Instead: a paid sale's return settled by credit note, when the
// customer wanted their money back. The unused credit note is removed, the
// balance restored, and the return becomes a refund on the drawer the cash
// came out of — so that drawer isn't short.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

async function createManager(page) {
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const s = stamp();
  const username = `cnr${s}`, pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Credit', last_name: 'Refunder', username, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  return { username, pin };
}
async function signInAsManager(page) {
  const { username, pin } = await createManager(page);
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
  return pin;
}

const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));

async function sale(page, customerId, method, sessionId) {
  const p = await product(page);
  const tx = await api(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, customer_id: customerId, payment_method: method,
    amount_tendered: method === 'credit' ? undefined : 100000, drawer_session_id: sessionId || null });
  return api(page, 'GET', `/transactions/${tx.id}`);
}
const creditNoteReturn = (page, tx, pin) => api(page, 'POST', `/transactions/${tx.id}/return`,
  { items: [{ transaction_item_id: tx.items[0].id, quantity: 1 }], resolution: 'credit_note', notes: 'Faulty', override_pin: pin });
const balance = async (page, id) => Number((await api(page, 'GET', `/customers/${id}`)).account_balance) || 0;

test('a paid sale\'s credit note can be refunded instead, onto the drawer the cash came from', async ({ page }) => {
  const pin = await signInAsManager(page);
  const s = stamp();
  const customer = await api(page, 'POST', '/customers', { first_name: 'Credit', last_name: `Cust${s}`, phone: `876${s.slice(-7)}`, customer_type: 'credit', credit_enabled: 1, credit_limit: 1000000, credit_terms_days: 30 });
  const drawer = await api(page, 'POST', '/drawers', { name: `CN drawer ${s}`, branch_id: 1 });
  const session = await api(page, 'POST', '/drawers/sessions', { drawer_id: drawer.id, branch_id: 1, employee_id: (await page.evaluate(() => App.currentUser.id)), opening_float: 0 });

  // Paid in cash, returned as a credit note.
  const paid = await sale(page, customer.id, 'cash', session.id);
  const before = await balance(page, customer.id);
  const ret = await creditNoteReturn(page, paid, pin);
  expect(await balance(page, customer.id)).toBeCloseTo(before - ret.total, 2);
  const cn = (await api(page, 'GET', `/customers/${customer.id}/credits`)).notes.find(x => x.return_id === ret.id);
  expect(cn).toBeTruthy();

  const info = await api(page, 'GET', `/transactions/returns/${ret.id}/credit-note-refund`);
  expect(info).toMatchObject({ allowed: true, credit_note: { payment_number: cn.payment_number } });
  expect(info.drawers.map(d => d.id)).toContain(session.id);

  // Reason and manager PIN are required.
  expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/credit-note-refund`, { refund_method: 'cash', drawer_session_id: session.id, override_pin: pin })).toContain('reason');
  expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/credit-note-refund`, { refund_method: 'cash', drawer_session_id: session.id, reason: 'x' })).toContain('PIN');

  // Through the screen: Returns view → Refund Instead.
  await page.evaluate(() => App.showSection('transactions'));
  await page.selectOption('#tx-view', 'returns');
  await page.evaluate(() => App._txViewChanged());
  const row = page.locator('tr', { hasText: ret.return_number });
  await row.getByRole('button', { name: 'Refund Instead' }).click();
  await expect(page.locator('#cnr-overlay')).toContainText(cn.payment_number);
  await page.selectOption('#cnr-drawer', String(session.id));
  await page.fill('#cnr-reason', 'Customer wanted cash back');
  await page.fill('#cnr-pin', pin);
  await page.click('#cnr-confirm');
  await expect(page.locator('#cnr-overlay')).toHaveCount(0);
  await expect(page.locator('.modal')).toContainText('Credit note refunded instead');

  // Credit note gone, balance back, return now a cash refund on that drawer.
  expect(await balance(page, customer.id)).toBeCloseTo(before, 2);
  expect((await api(page, 'GET', `/customers/${customer.id}/credits`)).notes.find(x => x.return_id === ret.id)).toBeUndefined();
  const after = await api(page, 'GET', `/transactions/returns/${ret.id}`);
  expect(after).toMatchObject({ resolution: 'refund', refund_method: 'cash', drawer_session_id: session.id, cn_refunded_number: cn.payment_number });
  const report = (await api(page, 'GET', `/drawers/sessions/${session.id}`)).report;
  expect(report.cash_refunds).toBeCloseTo(ret.total, 2);
  expect(report.tenders.find(t => t.key === 'cash').expected).toBeCloseTo(paid.total - ret.total, 2);
  // Books' feed carries it once.
  const feed = (await api(page, 'GET', '/transactions/credit-note-refunds')).filter(r => r.return_id === ret.id);
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({ payment_number: cn.payment_number, refund_method: 'cash' });
  // Can't be done twice.
  expect(await attempt(page, 'POST', `/transactions/returns/${ret.id}/credit-note-refund`, { refund_method: 'cash', drawer_session_id: session.id, reason: 'again', override_pin: pin })).toContain("wasn't settled by credit note");
});

test('refused for a sale charged to the account, and for a credit note already used', async ({ page }) => {
  // Stays signed in as admin (it can apply credit notes); the manager's PIN authorizes.
  const { pin } = await createManager(page);
  const s = stamp();
  const customer = await api(page, 'POST', '/customers', { first_name: 'Credit', last_name: `Acct${s}`, phone: `876${s.slice(-7)}`, customer_type: 'credit', credit_enabled: 1, credit_limit: 1000000, credit_terms_days: 30 });

  const onAccount = await sale(page, customer.id, 'credit');
  const ret1 = await creditNoteReturn(page, onAccount, pin);
  const info = await api(page, 'GET', `/transactions/returns/${ret1.id}/credit-note-refund`);
  expect(info.allowed).toBe(false);
  expect(info.error).toContain("charged to the customer's account");
  expect(await attempt(page, 'POST', `/transactions/returns/${ret1.id}/credit-note-refund`, { refund_method: 'card', reason: 'x', override_pin: pin })).toContain("charged to the customer's account");

  // Paid sale whose credit note was then applied to an invoice.
  const paid = await sale(page, customer.id, 'credit_card');
  const ret2 = await creditNoteReturn(page, paid, pin);
  const cn = (await api(page, 'GET', `/customers/${customer.id}/credits`)).notes.find(x => x.return_id === ret2.id);
  const open = await sale(page, customer.id, 'credit');
  await api(page, 'POST', `/customer-payments/${cn.id}/apply`, { allocations: [{ transaction_id: open.id, amount: 1 }] });
  expect(await attempt(page, 'POST', `/transactions/returns/${ret2.id}/credit-note-refund`, { refund_method: 'card', reason: 'x', override_pin: pin })).toContain('already been used');
});
