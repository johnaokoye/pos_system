import { test, expect } from './fixtures.js';

// Transactions screen: each sale's discount (amount, % and kind), who
// approved it, and a filter for discounted / manager-approved sales.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

async function withLimit(page, pct, fn) {
  const settings = await api(page, 'GET', '/settings');
  const prev = (Array.isArray(settings) ? settings.find(s => s.key === 'max_discount_pct')?.value : settings.max_discount_pct) ?? '0';
  await api(page, 'PUT', '/settings', { max_discount_pct: String(pct) });
  await page.evaluate(async () => { App.settings = await App.api('GET', '/settings'); });
  try { await fn(); } finally {
    await api(page, 'PUT', '/settings', { max_discount_pct: String(prev) });
    await page.evaluate(async () => { App.settings = await App.api('GET', '/settings'); });
  }
}

const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 20 && p.price >= 10 && p.product_type !== 'service' && !p.promotion_id && !p.on_promotion)));

test.describe('Transactions — discounts', () => {
  test('shows each sale\'s discount, % and approver, and filters discounted sales', async ({ page }) => {
    const settings = await api(page, 'GET', '/settings');
    const prevMax = (Array.isArray(settings) ? settings.find(s => s.key === 'max_discount_pct')?.value : settings.max_discount_pct) ?? '0';
    await api(page, 'PUT', '/settings', { max_discount_pct: '10' });
    try {
      const last = `Disc${stamp()}`;
      const cust = await api(page, 'POST', '/customers', { first_name: 'Tx', last_name: last });
      const p = await product(page);
      const sell = extra => api(page, 'POST', '/transactions', { customer_id: cust.id, branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, ...extra });

      // 20% off one line — past the 10% limit, so a manager (admin) approves it.
      const approved = await sell({ items: [{ product_id: p.id, quantity: 2, discount_percent: 20, discount_override_employee_id: 1 }] });
      // A 5% ticket discount, within the limit.
      const ticketAmt = Math.round(p.price * 5) / 100;
      const ticket = await sell({ items: [{ product_id: p.id, quantity: 1 }], discount_amount: ticketAmt });
      // A 30% ticket discount needs a manager override, like a line discount.
      const bigAmt = Math.round(p.price * 30) / 100;
      expect(await attempt(page, 'POST', '/transactions', { customer_id: cust.id, branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, items: [{ product_id: p.id, quantity: 1 }], discount_amount: bigAmt }))
        .toContain('exceeds the store limit of 10% — manager override required');
      const bigTicket = await sell({ items: [{ product_id: p.id, quantity: 1 }], discount_amount: bigAmt, discount_override_employee_id: 1 });
      // A promotion's discount is set up by the store — no override.
      const promo = await sell({ items: [{ product_id: p.id, quantity: 1 }], discount_amount: bigAmt, promotion_name: 'Test Promo' });
      const plain = await sell({ items: [{ product_id: p.id, quantity: 1 }] });

      const admin = (await api(page, 'GET', '/employees')).find(e => e.id === 1);
      const adminName = `${admin.first_name} ${admin.last_name}`;

      const list = await api(page, 'GET', `/transactions?customer_name=${last}`);
      const row = id => list.find(t => t.id === id);
      expect(row(approved.id).total_discount).toBeCloseTo(p.price * 2 * 0.2, 2);
      expect(row(approved.id).discount_pct).toBe(20);
      expect(row(approved.id).discount_approved_by).toBe(adminName);
      expect(row(ticket.id).total_discount).toBe(ticketAmt);
      expect(row(ticket.id).discount_pct).toBe(5);
      expect(row(approved.id).max_line_discount_pct).toBe(20);
      expect(row(bigTicket.id).ticket_discount_pct).toBe(30);
      expect(row(ticket.id).discount_approved_by).toBeNull();
      expect(row(bigTicket.id).discount_approved_by).toBe(adminName);
      expect(row(promo.id).discount_approved_by).toBeNull();
      expect(row(plain.id).total_discount).toBe(0);

      const ids = async q => (await api(page, 'GET', `/transactions?customer_name=${last}${q}`)).map(t => t.id).sort();
      expect(await ids('&discounted=1')).toEqual([approved.id, ticket.id, bigTicket.id, promo.id].sort());
      expect(await ids('&discounted=approved')).toEqual([approved.id, bigTicket.id].sort());

      // A held ticket keeps the approval (Hold Recall restores it).
      const hold = await api(page, 'POST', '/transactions/hold', { customer_id: cust.id, employee_id: 1, branch_id: 1, items: [{ product_id: p.id, product_name: p.name, quantity: 1, unit_price: p.price, tax_rate: p.tax_rate || 0 }], discount_amount: bigAmt, discount_source: 'manual', discount_override_employee_id: 1 });
      const held = await api(page, 'GET', `/transactions/${hold.id}`);
      expect(held.discount_override_name).toBe(adminName);
      await api(page, 'DELETE', `/transactions/${hold.id}/hold`);

      // On screen: filter to discounted, see the columns.
      await page.evaluate(async () => { App.settings = await App.api('GET', '/settings'); App.showSection('transactions'); });
      await page.waitForSelector('#tx-discounted');
      await page.fill('#tx-customer', last);
      await page.selectOption('#tx-discounted', '1');
      await page.click('button:has-text("Search")');
      const rows = page.locator('#tx-table tbody tr');
      await expect(rows).toHaveCount(4);
      const approvedRow = rows.filter({ hasText: approved.transaction_number });
      await expect(approvedRow).toContainText('20% · Line');
      await expect(approvedRow).toContainText(adminName);
      // Past the 10% limit: flagged red (approved or not).
      await expect(approvedRow.locator('.tx-disc-over')).toContainText('over 10% limit');
      const bigRow = rows.filter({ hasText: bigTicket.transaction_number });
      await expect(bigRow.locator('.tx-disc-over')).toContainText('30% · Ticket');
      await expect(bigRow).toContainText(adminName);
      const ticketRow = rows.filter({ hasText: ticket.transaction_number });
      await expect(ticketRow).toContainText('5% · Ticket');
      await expect(ticketRow).toContainText('Within limit');
      await expect(ticketRow.locator('.tx-disc-over')).toHaveCount(0);

      // The sale's View box shows the line discount and approver.
      await approvedRow.locator('button', { hasText: 'View' }).click();
      await expect(page.locator('.modal')).toContainText(`(20%) · over 10% limit · approved by ${adminName}`);
    } finally {
      await api(page, 'PUT', '/settings', { max_discount_pct: String(prevMax) });
    }
  });

  test('POS asks for a manager PIN for a ticket discount past the limit', async ({ page }) => {
    // The seeded Manager group can override (a new database gets the key).
    const s = stamp(), pin = s.slice(-6);
    const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
    await api(page, 'POST', '/employees', { first_name: 'Disc', last_name: `Mgr${s}`, username: `dm${s}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
    const p = await product(page);
    await withLimit(page, 10, async () => {
      await page.evaluate(() => App.showSection('pos'));
      await page.waitForFunction(() => App.allProducts);
      await page.evaluate(() => document.getElementById('pos-drawer-overlay')?.remove());
      await page.evaluate(id => App.addToCart(id, null, 1), p.id);
      await page.evaluate(() => App.showTicketDiscountModal());

      // Within the limit: no prompt.
      await page.selectOption('#discount-type', 'percent');
      await page.fill('#discount-input', '5');
      await page.evaluate(() => App.applyDiscount());
      expect(await page.evaluate(() => App.cartDiscount)).toBeCloseTo(p.price * 0.05, 2);
      await expect(page.locator('#tdo-pin')).toHaveCount(0);

      // 30%: a manager PIN is asked for; cancelling keeps the 5%.
      await page.fill('#discount-input', '30');
      await page.evaluate(() => { App.applyDiscount(); });
      await expect(page.locator('#tdo-msg')).toContainText('exceeds the 10% store limit');
      await page.click('#tdo-cancel');
      expect(await page.evaluate(() => App._manualTicketDiscountPct)).toBe(5);

      // A wrong PIN is refused; the manager's PIN applies it.
      await page.evaluate(() => { App.applyDiscount(); });
      await page.fill('#tdo-pin', '000000x');
      await page.click('#tdo-ok');
      await expect(page.locator('#tdo-pin')).toHaveValue('');
      await page.fill('#tdo-pin', pin);
      await page.click('#tdo-ok');
      await expect(page.locator('#tdo-pin')).toHaveCount(0);
      expect(await page.evaluate(() => App._manualTicketDiscountPct)).toBe(30);
      await expect(page.locator('#discount-display')).toContainText(`approved by Disc Mgr${s}`);

      // Held and recalled, the approval comes back; the sale records it.
      await expect(page.locator('.modal-title', { hasText: 'Ticket Discount' })).toBeVisible();
      await page.evaluate(() => App.closeModal());
      expect(await page.evaluate(() => App._ticketDiscountSource().discount_override_employee_id)).toBeTruthy();
      await page.evaluate(() => { App._salespersonReminderDone = true; App.processPayment('cash'); });
      await page.fill('#ctm-tendered', '100000');
      await page.click('#ctm-confirm');
      await expect(page.locator('.modal-title', { hasText: 'Receipt' })).toBeVisible();
      const sale = (await api(page, 'GET', '/transactions?limit=5')).find(t => t.discount_approved_by === `Disc Mgr${s}`);
      expect(sale).toBeTruthy();
      expect(sale.ticket_discount_pct).toBe(30);
    });
  });

  test('only Override Discount Limit itself authorizes an override — not POS access', async ({ page }) => {
    const perms = g => typeof g.permissions === 'string' ? JSON.parse(g.permissions) : g.permissions;
    const groups = await api(page, 'GET', '/security-groups');
    for (const name of ['Administrator', 'Manager']) expect(perms(groups.find(g => g.name === name)).pos_discount_override).toBe(true);
    expect(perms(groups.find(g => g.name === 'Cashier')).pos_discount_override).toBe(false);

    // A group with POS but no pos_discount_override key at all.
    const s = stamp();
    const group = await api(page, 'POST', '/security-groups', { name: `POS Only ${s}`, permissions: { pos: true } });
    const cashier = await api(page, 'POST', '/employees', { first_name: 'Pos', last_name: `Only${s}`, username: `po${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
    const p = await product(page);
    await withLimit(page, 10, async () => {
      const sale = extra => attempt(page, 'POST', '/transactions', { branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, ...extra });
      expect(await sale({ items: [{ product_id: p.id, quantity: 1, discount_percent: 20, discount_override_employee_id: cashier.id }] }))
        .toContain("doesn't have override privileges");
      expect(await sale({ items: [{ product_id: p.id, quantity: 1 }], discount_amount: Math.round(p.price * 30) / 100, discount_override_employee_id: cashier.id }))
        .toContain("doesn't have override privileges");
      // Their PIN isn't accepted at the till either.
      expect(await attempt(page, 'POST', '/employees/validate-pin', { pin: s.slice(-6), permission: 'pos_discount_override' })).toContain('Invalid PIN or insufficient privilege');
      // A Manager still can.
      const mgrGroup = groups.find(g => g.name === 'Manager');
      const mgr = await api(page, 'POST', '/employees', { first_name: 'Real', last_name: `Mgr${s}`, username: `rm${s}`, pin: `9${s.slice(-5)}`, password: 'pw-123456', must_change_password: 0, security_group_id: mgrGroup.id, active: 1 });
      expect(await sale({ items: [{ product_id: p.id, quantity: 1, discount_percent: 20, discount_override_employee_id: mgr.id }] })).toBe('accepted');
    });
  });
});
