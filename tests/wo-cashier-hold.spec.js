import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// A signed-off work order isn't put on the POS Hold Recall by itself: staff
// place it on hold for the cashier when the customer comes in to collect,
// and can take it off again. Final payment needs it on hold.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

test('work order goes on the cashier hold only when placed there by hand', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const fee = await api(page, 'POST', '/products', { name: `Assess H ${s}`, sku: `AH${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Hold', last_name: `Me${s}`, phone: `871${s.slice(-7)}` });
  const mkWo = desc => api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: `${desc} ${s}`, item_label: 'Item', assessment_fee_product_id: fee.id });
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  const held = async () => (await api(page, 'GET', `/work-orders?view=awaiting_payment&customer_id=${cust.id}`)).map(w => w.id);

  // Notified, awaiting pickup: not on the cashier's list, and can't be paid yet.
  const notified = await mkWo('Notified grinder');
  await db.execute({ sql: "UPDATE work_orders SET status = 'awaiting_pickup', completed_at = CURRENT_TIMESTAMP, notified_at = CURRENT_TIMESTAMP, notification_method = 'phone', estimate_labor = 500 WHERE id = ?", args: [notified.id] });
  expect(await held()).not.toContain(notified.id);
  expect(await attempt(page, 'PATCH', `/work-orders/${notified.id}/final-payment`, { payment_method: 'cash' })).toContain('Place this work order on hold');

  // Customer comes in: placed on hold from the work order screen.
  await page.evaluate(() => App.showSection('work-orders'));
  let w = await api(page, 'PATCH', `/work-orders/${notified.id}/cashier-hold`, {});
  expect(w.cashier_hold_at).toBeTruthy();
  expect(w.cashier_hold_by_name).toBeTruthy();
  expect(await held()).toContain(notified.id);
  expect(await attempt(page, 'PATCH', `/work-orders/${notified.id}/cashier-hold`, {})).toContain('already on hold');

  // Customer leaves: taken off, then back on and paid.
  w = await api(page, 'DELETE', `/work-orders/${notified.id}/cashier-hold`);
  expect(w.cashier_hold_at).toBeNull();
  expect(await held()).not.toContain(notified.id);
  await api(page, 'PATCH', `/work-orders/${notified.id}/cashier-hold`, {});
  w = await api(page, 'PATCH', `/work-orders/${notified.id}/final-payment`, { payment_method: 'cash' });
  w = await api(page, 'GET', `/work-orders/${notified.id}`);
  expect(w.status).toBe('picked_up');
  expect(w.status_log.some(l => /placed on hold for the cashier/.test(l.comment || ''))).toBe(true);
  expect(w.status_log.some(l => /Taken off the cashier's hold/.test(l.comment || ''))).toBe(true);

  // A signed-off job not yet notified: the customer walked in — placing it on hold moves it to awaiting pickup.
  const walkIn = await mkWo('Walk-in drill');
  await db.execute({ sql: "UPDATE work_orders SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?", args: [walkIn.id] });
  expect(await held()).not.toContain(walkIn.id);
  w = await api(page, 'PATCH', `/work-orders/${walkIn.id}/cashier-hold`, {});
  expect([w.status, w.notification_method]).toEqual(['awaiting_pickup', 'in_person']);
  expect(await held()).toContain(walkIn.id);

  // Only finished work.
  const early = await mkWo('Not done');
  expect(await attempt(page, 'PATCH', `/work-orders/${early.id}/cashier-hold`, {})).toContain('only a signed-off job');
  expect(await attempt(page, 'DELETE', `/work-orders/${early.id}/cashier-hold`)).toContain('not on hold');

  // The work order view offers the button, then the badge.
  await page.evaluate(() => App.closeModal && App.closeModal());
  const fresh = await mkWo('Button saw');
  await db.execute({ sql: "UPDATE work_orders SET status = 'awaiting_pickup', completed_at = CURRENT_TIMESTAMP WHERE id = ?", args: [fresh.id] });
  page.once('dialog', d => d.accept());
  await page.evaluate(id => App.woPlaceCashierHold(id), fresh.id);
  expect(await held()).toContain(fresh.id);
});
