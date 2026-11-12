import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// Consignment Phase 3: a month-end reconciliation per agreement — stock
// movements, expected vs counted, in transit at the cut-off — with POS
// sales, discrepancies and approved billable quantities kept apart; Finance
// approves chargeable shortages and the month, which locks it; a later
// return lands in the next month (A3); an Administrator reopens it only with
// Finance's documented approval.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// The test server's database (tests/support/start-server.js) — used only to
// move this test's records into last month, which no API can do.
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

async function login(page, username, password = 'pw-123456') {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}
const lineOf = (r, type, branchId, productId) => r.lines.find(l => l.line_type === type && (type === 'in_transit' || l.branch_id === branchId) && l.product_id === productId);

test('month-end reconciliation: figures, counts, approval and lock, a later return, reopening', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
  const groups = await api(page, 'GET', '/security-groups');
  const second = `rc${s}`, pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Rec', last_name: 'Approver', username: second, pin: String(Number(pin) + 7).slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  await api(page, 'POST', '/employees', { first_name: 'Ret', last_name: 'Mgr', username: `rm${s}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Manager').id, active: 1 });

  // 10 received from a supplier who agreed Total Tools bears shortages (not damage).
  const item = await api(page, 'POST', '/products', { name: `Recon Item ${s}`, sku: `RI${s}`, price: 250, cost: 60, tax_rate: 0, stock_qty: 0, active: 1 });
  const sup = await api(page, 'POST', '/suppliers', { name: `Recon Supplier ${s}` });
  const agr = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2025-01-01', ownership_terms: "Supplier's until sold", shortage_responsibility: 'total_tools', damage_responsibility: 'supplier', items: [{ product_id: item.id, cost: 100 }], submit: true });
  await login(page, second);
  await api(page, 'POST', `/consignment/agreements/${agr.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const o = await api(page, 'POST', '/consignment/orders', { agreement_id: agr.id, branch_id: main.id, items: [{ product_id: item.id, quantity: 10 }] });
  const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN${s}`, items: [{ order_item_id: o.items[0].id, quantity: 10 }] });
  await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});

  // The month: sold 3, 1 returned, 1 adjusted out, 2 moved to the other branch, 1 more sent and still on the road.
  const sale = await api(page, 'POST', '/transactions', { items: [{ product_id: item.id, quantity: 3 }], branch_id: main.id, employee_id: 1, payment_method: 'cash', amount_tendered: 5000 });
  const saleItem = (await api(page, 'GET', `/transactions/${sale.id}`)).items[0].id;
  await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: saleItem, quantity: 1 }], resolution: 'refund', refund_method: 'card', notes: 'Unwanted', override_pin: pin });
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: -1, reason: 'Missing', branch_id: main.id });
  await api(page, 'POST', '/transfers/quick', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: item.id, quantity: 2 }] });
  const tr = await api(page, 'POST', '/transfers', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: item.id, quantity: 1 }] });
  await api(page, 'PATCH', `/transfers/${tr.id}/send`, {});
  await api(page, 'PATCH', `/transfers/${tr.id}/dispatch`, { driver_name: 'Driver' });

  const thisMonth = await page.evaluate(() => App._storeDay(new Date()).slice(0, 7));
  const cur = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: thisMonth });
  let m = lineOf(cur, 'stock', main.id, item.id);
  expect(m).toMatchObject({ opening: 0, receipts: 10, sales: -3, returns: 1, adjustments: -1, transfers_out: -3, expected_closing: 4, pos_sales_qty: 3, pos_sales_value: 300, returns_qty: 1, returns_value: 100, shortage_qty: 1, billable_qty: 2, billable_value: 200 });
  expect(lineOf(cur, 'stock', other.id, item.id)).toMatchObject({ transfers_in: 2, expected_closing: 2 });
  expect(lineOf(cur, 'in_transit', null, item.id)).toMatchObject({ in_transit: 1 });
  // This month hasn't ended: can't be approved yet.
  expect(await attempt(page, 'POST', `/consignment/reconciliations/${cur.id}/approve`, { signature: SIG })).toContain("hasn't ended");

  // Move all of that into last month, then reconcile last month.
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  const [y, mo] = thisMonth.split('-').map(Number);
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const lots = `SELECT id FROM stock_lots WHERE agreement_id = ${agr.id}`;
  await db.execute(`UPDATE stock_lot_moves SET created_at = '${prev}-15 15:00:00' WHERE lot_id IN (${lots})`);
  await db.execute(`UPDATE sale_lot_allocations SET qualified_on = '${prev}-15' WHERE agreement_id = ${agr.id}`);
  await db.execute(`UPDATE stock_lot_returns SET created_at = '${prev}-15 15:00:00' WHERE allocation_id IN (SELECT id FROM sale_lot_allocations WHERE agreement_id = ${agr.id})`);
  db.close();
  const last = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: prev });
  m = lineOf(last, 'stock', main.id, item.id);
  expect(m).toMatchObject({ expected_closing: 4, pos_sales_qty: 3, billable_qty: 2 });

  // Counts: one short at the main branch. Approval needs every line counted.
  expect(await attempt(page, 'POST', `/consignment/reconciliations/${last.id}/approve`, { signature: SIG })).toContain('physical count');
  const otherLineId = lineOf(last, 'stock', other.id, item.id).id;
  let r = await api(page, 'PATCH', `/consignment/reconciliations/${last.id}/lines/${m.id}`, { physical_count: 3 });
  // Lines keep their ids when the figures are recomputed (the screen saves by id).
  expect(lineOf(r, 'stock', main.id, item.id).id).toBe(m.id);
  expect(lineOf(r, 'stock', other.id, item.id).id).toBe(otherLineId);
  m = lineOf(r, 'stock', main.id, item.id);
  expect(m).toMatchObject({ discrepancy: -1, shortage_qty: 2 });
  r = await api(page, 'PATCH', `/consignment/reconciliations/${last.id}/lines/${lineOf(r, 'stock', other.id, item.id).id}`, { physical_count: 2 });
  // Finance approves the 2 short as chargeable (Total Tools bears shortages here); damage it can't.
  r = await api(page, 'PATCH', `/consignment/reconciliations/${last.id}/lines/${lineOf(r, 'stock', main.id, item.id).id}`, { approved_shortage_qty: 2 });
  expect(lineOf(r, 'stock', main.id, item.id)).toMatchObject({ approved_shortage_qty: 2, billable_qty: 4, billable_value: 400 });
  expect(await attempt(page, 'PATCH', `/consignment/reconciliations/${last.id}/lines/${lineOf(r, 'stock', main.id, item.id).id}`, { approved_damage_qty: 1 })).toContain('supplier bears damage');
  expect(r.totals).toMatchObject({ pos_sales_qty: 3, returns_qty: 1, billable_qty: 4, billable_value: 400 });

  // The screen shows the three sets of figures apart.
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(id => App.viewConsRecon(id), last.id);
  for (const t of ['POS-RECORDED SALES', 'COUNT DISCREPANCIES', 'APPROVED BILLABLE', 'IN TRANSIT AT CUT-OFF']) await expect(page.locator('.modal')).toContainText(t);
  await page.evaluate(() => App.closeModal());

  // Approved: locked.
  r = await api(page, 'POST', `/consignment/reconciliations/${last.id}/approve`, { signature: SIG });
  expect(r.status).toBe('approved');
  expect(await attempt(page, 'PATCH', `/consignment/reconciliations/${last.id}/lines/${lineOf(r, 'stock', main.id, item.id).id}`, { physical_count: 4 })).toContain('locked');
  expect(await attempt(page, 'POST', `/consignment/reconciliations/${last.id}/refresh`, {})).toContain('locked');

  // A return now of last month's sale: last month stays as it was; this month carries the credit (A3).
  await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: saleItem, quantity: 1 }], resolution: 'refund', refund_method: 'card', notes: 'Late return', override_pin: pin });
  expect((await api(page, 'GET', `/consignment/reconciliations/${last.id}`)).totals.billable_value).toBe(400);
  r = await api(page, 'POST', `/consignment/reconciliations/${cur.id}/refresh`, {});
  m = lineOf(r, 'stock', main.id, item.id);
  expect(m).toMatchObject({ opening: 4, pos_sales_qty: 0, prior_returns_qty: 1, prior_returns_value: 100, billable_qty: -1, billable_value: -100 });

  // Reopening: an Administrator, with the reason, the Finance approver and the reference.
  expect(await attempt(page, 'POST', `/consignment/reconciliations/${last.id}/reopen`, { reason: 'Count error' })).toContain('Finance approver');
  r = await api(page, 'POST', `/consignment/reconciliations/${last.id}/reopen`, { reason: 'Count error at main', finance_approver: 'Head of Finance', approval_reference: 'Email 2026-11-30' });
  expect(r.status).toBe('draft');
  expect(r.log.map(x => x.action)).toEqual(['prepared', 'line_updated', 'line_updated', 'line_updated', 'approved', 'reopened']);
  expect(r.log.at(-1)).toMatchObject({ reason: 'Count error at main', finance_approver: 'Head of Finance', approval_reference: 'Email 2026-11-30' });
});
