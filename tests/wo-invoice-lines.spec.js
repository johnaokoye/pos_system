import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// The Service and Repair Tax Invoice (and the work order screens) show
// labour and consumables as their own lines, not one "estimate" figure.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

test('labour and consumables are separate lines on the work order invoice', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const fee = await api(page, 'POST', '/products', { name: `Assess L ${s}`, sku: `AL${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Line', last_name: `Owner${s}`, phone: `872${s.slice(-7)}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Grinder sparks', item_label: 'Grinder', assessment_fee_product_id: fee.id });
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  await db.execute({ sql: "UPDATE work_orders SET status = 'assessed' WHERE id = ?", args: [wo.id] });
  await api(page, 'PATCH', `/work-orders/${wo.id}/estimate`, { estimate_labor: 6000, estimate_consumables: 850, deposit_amount: 0 });

  const html = await page.evaluate(id => fetch(`/api/email/work-order-preview/${id}`).then(r => r.text()), wo.id);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  expect(text).toMatch(/Labour \$6,000\.00/);
  expect(text).toMatch(/Consumables \$850\.00/);
  expect(text).not.toContain('labor + consumables');

  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(id => App.viewWorkOrder(id), wo.id);
  await expect(page.locator('.modal')).toContainText('Consumables');
  await expect(page.locator('.modal')).not.toContainText('labor + consumables');
});
