import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// Work order follow-up calls: logged with method, outcome, notes, promised
// pickup and next call date. Reaching the customer on a finished job is the
// ready-for-pickup notice. Follow-Ups Due lists jobs to call: finished and
// not told, a follow-up date that has come, or an overdue pickup with no call
// in 7 days.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

test('follow-up calls: logged, count as the pickup notice, and drive Follow-Ups Due', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const fee = await api(page, 'POST', '/products', { name: `Assess F ${s}`, sku: `AF${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Call', last_name: `Me${s}`, phone: `870${s.slice(-7)}` });
  const mkWo = desc => api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: `${desc} ${s}`, item_label: 'Item', assessment_fee_product_id: fee.id });
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  const today = await page.evaluate(() => App._storeDay(new Date()));
  const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const dueIds = async () => (await api(page, 'GET', '/work-orders?view=follow_ups')).map(w => w.id);

  // A finished job not yet told needs a call.
  const ready = await mkWo('Finished drill');
  await db.execute({ sql: "UPDATE work_orders SET status = 'complete', completed_at = CURRENT_TIMESTAMP, pickup_due_date = ? WHERE id = ?", args: [addDays(today, 30), ready.id] });
  expect(await dueIds()).toContain(ready.id);
  expect((await api(page, 'GET', `/work-orders/${ready.id}`)).follow_up_reason).toBe('ready_to_notify');

  // Validation
  expect(await attempt(page, 'POST', `/work-orders/${ready.id}/calls`, { method: 'phone' })).toContain('outcome');
  expect(await attempt(page, 'POST', `/work-orders/${ready.id}/calls`, { outcome: 'other' })).toContain('Add a note');
  expect(await attempt(page, 'POST', `/work-orders/${ready.id}/calls`, { outcome: 'will_collect' })).toContain('When did the customer');
  expect(await attempt(page, 'POST', `/work-orders/${ready.id}/calls`, { outcome: 'no_answer', next_follow_up: addDays(today, -1) })).toContain("can't be in the past");

  // No answer: logged, still not told, still due.
  await api(page, 'POST', `/work-orders/${ready.id}/calls`, { method: 'phone', outcome: 'no_answer', next_follow_up: addDays(today, 1) });
  let w = await api(page, 'GET', `/work-orders/${ready.id}`);
  expect(w.status).toBe('complete');
  expect(w.calls.length).toBe(1);
  expect(await dueIds()).toContain(ready.id);

  // Reached, through the screen (from Notify Customer's Log a Call): counts as the notice.
  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(id => App.showWONotifyModal(id), ready.id);
  await page.getByRole('button', { name: '☎ Log a Call' }).click();
  await expect(page.locator('.modal')).toContainText('ready-for-pickup notice');
  await page.selectOption('#woc-method', 'whatsapp');
  await page.selectOption('#woc-outcome', 'will_collect');
  await page.fill('#woc-promised', addDays(today, 2));
  await page.fill('#woc-notes', 'Coming Thursday after work');
  await page.getByRole('button', { name: 'Save Call' }).click();
  await expect(page.locator('.modal .wo-call-row').first()).toContainText('Customer will collect');
  await expect(page.locator('.modal .wo-call-row').first()).toContainText('Pickup notice');
  w = await api(page, 'GET', `/work-orders/${ready.id}`);
  expect([w.status, w.notification_method]).toEqual(['awaiting_pickup', 'whatsapp']);
  expect(w.notified_at).toBeTruthy();
  expect(w.calls[0].counted_as_notification).toBe(1);
  expect(w.calls[0].next_follow_up).toBe(addDays(today, 3)); // the day after the promised pickup
  expect(w.status_log.some(l => l.status === 'awaiting_pickup' && /Customer notified — WhatsApp follow-up: Customer will collect/.test(l.comment || ''))).toBe(true);
  expect(await dueIds()).not.toContain(ready.id);

  // A follow-up date that has come makes it due again.
  await api(page, 'POST', `/work-orders/${ready.id}/calls`, { outcome: 'voicemail', next_follow_up: today });
  w = await api(page, 'GET', `/work-orders/${ready.id}`);
  expect([w.follow_up_due, w.follow_up_reason]).toEqual([true, 'scheduled']);
  expect(w.status).toBe('awaiting_pickup');
  expect(w.calls.filter(c => c.counted_as_notification).length).toBe(1);

  // An overdue pickup with no call in 7 days is due; a fresh call with no next date clears it.
  const late = await mkWo('Uncollected saw');
  await db.execute({ sql: "UPDATE work_orders SET status = 'awaiting_pickup', pickup_due_date = ? WHERE id = ?", args: [addDays(today, -5), late.id] });
  await db.execute({ sql: "INSERT INTO work_order_calls (work_order_id, employee_id, called_at, method, outcome) VALUES (?, 1, datetime('now', '-10 days'), 'phone', 'reached')", args: [late.id] });
  expect((await api(page, 'GET', `/work-orders/${late.id}`)).follow_up_reason).toBe('pickup_overdue');
  await page.evaluate(() => { App.closeModal(); return App.filterWorkOrders('follow_ups'); });
  const lateRow = page.locator('#wo-content tr', { hasText: `Uncollected saw ${s}` });
  await expect(lateRow).toContainText('Pickup overdue');
  await lateRow.getByRole('button', { name: '☎ Log Call' }).click();
  await page.selectOption('#woc-outcome', 'reached');
  await page.fill('#woc-notes', 'Says next week');
  await page.getByRole('button', { name: 'Save Call' }).click();
  await expect(page.locator('.modal .wo-call-row').first()).toContainText('Says next week');
  expect(await dueIds()).not.toContain(late.id);

  // Closed jobs take no calls.
  await db.execute({ sql: "UPDATE work_orders SET status = 'picked_up' WHERE id = ?", args: [late.id] });
  expect(await attempt(page, 'POST', `/work-orders/${late.id}/calls`, { outcome: 'reached' })).toContain('no follow-up needed');
});
