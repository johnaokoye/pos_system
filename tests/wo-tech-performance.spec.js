import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// Work Orders → Technician Performance: tasks per technician over a period,
// on time when the clocked time is within the allotted time, and monthly
// incentive targets (own target, else the default) needing wo_incentives.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
// Clock times are made up here: the test DB is a throwaway rebuilt every run.
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

test('technician task performance, on-time badges and incentive targets', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const groups = await api(page, 'GET', '/security-groups');
  const admin = groups.find(g => g.name === 'Administrator');
  const mkTech = n => api(page, 'POST', '/employees', { first_name: n, last_name: `Tech${s}`, username: `${n.toLowerCase()}${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const ana = await mkTech('Ana'), ben = await mkTech('Ben');

  const fee = await api(page, 'POST', '/products', { name: `Assess P ${s}`, sku: `AP${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { address: '1 Test Road', first_name: 'Perf', last_name: `Owner${s}`, phone: `873${s.slice(-7)}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Pressure washer', item_label: 'Washer', assessment_fee_product_id: fee.id });
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  await db.execute({ sql: "UPDATE work_orders SET status = 'in_progress' WHERE id = ?", args: [wo.id] });

  // Ana: one on time (20 of 30 min), one late (50 of 30), one open. Ben: one with no time set.
  const task = (desc, tech, mins) => api(page, 'POST', `/work-orders/${wo.id}/tasks`, { description: `${desc} ${s}`, allotted_minutes: mins, technician_id: tech.id });
  const t1 = await task('Replace pump seal', ana, 30), t2 = await task('Rebuild unloader', ana, 30), t3 = await task('Test run', ana, 15), t4 = await task('Clean nozzle', ben, 0);
  const clock = (t, mins) => db.execute({ sql: `INSERT INTO work_order_task_time_entries (task_id, technician_id, started_at, ended_at) VALUES (?, ?, datetime('now', ?), datetime('now'))`, args: [t.id, t.technician_id, `-${mins} minutes`] });
  await clock(t1, 20); await clock(t2, 50); await clock(t4, 5);
  for (const t of [t1, t2, t4]) await api(page, 'PATCH', `/work-orders/tasks/${t.id}`, { status: 'complete' });
  expect((await db.execute({ sql: 'SELECT completed_at FROM work_order_tasks WHERE id = ?', args: [t1.id] })).rows[0].completed_at).toBeTruthy();

  const month = await page.evaluate(() => App._storeDay(new Date()).slice(0, 7));
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const perf = await api(page, 'GET', `/work-orders/task-performance?start=${month}-01&end=${end}`);
  expect(perf.period).toBe(month);
  const a = perf.technicians.find(x => x.technician_id === ana.id), b = perf.technicians.find(x => x.technician_id === ben.id);
  expect([a.completed, a.on_time, a.late, a.incomplete, a.on_time_pct]).toEqual([2, 1, 1, 1, 50]);
  expect(a.minutes_worked).toBe(70);
  expect([b.completed, b.no_allotment, b.on_time_pct]).toEqual([1, 1, null]);
  const byId = id => perf.tasks.find(x => x.id === id);
  expect(byId(t1.id).timing).toBe('on_time');
  expect(byId(t2.id).timing).toBe('late');
  expect(byId(t2.id).variance_minutes).toBe(20);
  expect(byId(t3.id).status).toBe('pending');
  expect(a.target).toBeNull();

  // Reopening a task clears its completion.
  await api(page, 'PATCH', `/work-orders/tasks/${t4.id}`, { status: 'in_progress' });
  expect((await db.execute({ sql: 'SELECT completed_at FROM work_order_tasks WHERE id = ?', args: [t4.id] })).rows[0].completed_at).toBeNull();
  await api(page, 'PATCH', `/work-orders/tasks/${t4.id}`, { status: 'complete' });

  // Targets: a default and Ana's own; only wo_incentives may set them.
  expect(await attempt(page, 'POST', '/work-orders/incentive-targets', { period: month })).toContain('Set a tasks-completed target');
  expect(await attempt(page, 'POST', '/work-orders/incentive-targets', { period: month, target_on_time_pct: 120 })).toContain('between 0 and 100');
  const def = await api(page, 'POST', '/work-orders/incentive-targets', { period: month, target_completed: 1, reward_amount: 5000 });
  expect(await attempt(page, 'POST', '/work-orders/incentive-targets', { period: month, target_completed: 3 })).toContain('already a default target');
  const own = await api(page, 'POST', '/work-orders/incentive-targets', { period: month, employee_id: ana.id, target_completed: 2, target_on_time_pct: 80, reward_amount: 10000, reward_note: 'With wages' });
  let p2 = await api(page, 'GET', `/work-orders/task-performance?start=${month}-01&end=${end}`);
  let a2 = p2.technicians.find(x => x.technician_id === ana.id), b2 = p2.technicians.find(x => x.technician_id === ben.id);
  expect(a2.target.id).toBe(own.id);
  expect(a2.target.met).toBe(false); // 50% on time < 80%
  expect(b2.target.id).toBe(def.id);
  expect(b2.target.met).toBe(true);
  await api(page, 'PUT', `/work-orders/incentive-targets/${own.id}`, { target_completed: 2, target_on_time_pct: 50, reward_amount: 10000 });
  p2 = await api(page, 'GET', `/work-orders/task-performance?start=${month}-01&end=${end}`);
  expect(p2.technicians.find(x => x.technician_id === ana.id).target.met).toBe(true);
  // A range that isn't a whole month shows no targets.
  expect((await api(page, 'GET', `/work-orders/task-performance?start=${month}-01&end=${month}-01`)).period).toBeNull();

  // The screen.
  await page.evaluate(() => App.showSection('work-orders'));
  await page.getByRole('button', { name: 'Technician Performance' }).click();
  await page.selectOption('#wop-preset', 'custom');
  await page.fill('#wop-start', `${month}-01`);
  await page.fill('#wop-end', end);
  await page.locator('#wop-end').dispatchEvent('change');
  const anaRow = page.locator(`#wop-tech-table tr[data-tech="${ana.id}"]`);
  await expect(anaRow).toContainText('Target met');
  await expect(anaRow).toContainText('Reward $10,000.00');
  await page.selectOption('#wop-show', 'late');
  await expect(page.locator('#wop-task-table')).toContainText(`Rebuild unloader ${s}`);
  await expect(page.locator('#wop-task-table')).not.toContainText(`Replace pump seal ${s}`);
  await page.selectOption('#wop-show', 'all');
  await expect(page.locator('#wop-task-table tr', { hasText: `Replace pump seal ${s}` })).toContainText('On time');
  await page.getByRole('button', { name: '🎯 Incentive Targets' }).click();
  await expect(page.locator('.modal')).toContainText('Default (all technicians)');
  await expect(page.locator(`.modal tr[data-target="${own.id}"]`)).toContainText(`Ana Tech${s}`);

  // Without wo_incentives: can view, can't set.
  const viewer = await api(page, 'POST', '/security-groups', { name: `WO viewer ${s}`, description: 'x', permissions: { work_orders: false, wo_technician: true, wo_incentives: false } });
  await api(page, 'POST', '/employees', { first_name: 'View', last_name: `Only${s}`, username: `view${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: viewer.id, active: 1 });
  await page.goto('about:blank'); await page.context().clearCookies(); await page.goto('/');
  await page.fill('#login-user', `view${s}`); await page.fill('#login-pass', 'pw-123456'); await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser);
  expect((await api(page, 'GET', `/work-orders/task-performance?start=${month}-01&end=${end}`)).technicians.length).toBeGreaterThan(0);
  expect(await attempt(page, 'DELETE', `/work-orders/incentive-targets/${def.id}`)).toMatch(/permission/i);
});
