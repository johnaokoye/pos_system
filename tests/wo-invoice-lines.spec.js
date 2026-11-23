import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// The Service and Repair Tax Invoice: services (assessment fee, labour,
// consumables) then parts with each part's total and a parts total, GCT per
// line, the assessment fee taken off as a non-refundable deposit. Plus
// documents (the signed contract) attached to the work order.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

test('work order invoice lines, GCT, non-refundable assessment deposit, and a signed contract attached', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const fee = await api(page, 'POST', '/products', { name: `Assess L ${s}`, sku: `AL${s}`, price: 1000, cost: 0, tax_rate: 15, is_service: 1, active: 1 });
  const part = await api(page, 'POST', '/products', { name: `Carbon brush ${s}`, sku: `CB${s}`, price: 400, cost: 100, tax_rate: 15, stock_qty: 0, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Line', last_name: `Owner${s}`, phone: `872${s.slice(-7)}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Grinder sparks', item_label: 'Grinder', assessment_fee_product_id: fee.id });
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  await api(page, 'PATCH', `/work-orders/${wo.id}/assessment-paid`, { payment_method: 'cash', employee_id: 1, branch_id: main.id });
  await api(page, 'PATCH', `/work-orders/${wo.id}/estimate`, { estimate_labor: 6000, estimate_consumables: 850, deposit_amount: 0 });
  await db.execute({ sql: 'UPDATE work_orders SET estimate_tax_rate = 15 WHERE id = ?', args: [wo.id] });
  await api(page, 'PATCH', `/work-orders/${wo.id}/parts`, { items: [{ product_id: part.id, quantity: 2 }] });

  const html = await page.evaluate(id => fetch(`/api/email/work-order-preview/${id}`).then(r => r.text()), wo.id);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  expect(text).toMatch(/Labour 1 \$6,000\.00 \$900\.00 \$6,000\.00/);
  expect(text).toMatch(/Consumables 1 \$850\.00 \$127\.50 \$850\.00/);
  expect(text).not.toContain('labor + consumables');
  // Services first, parts at the bottom with each part's total and a parts total.
  expect(text.indexOf('Labour')).toBeLessThan(text.indexOf(`Carbon brush ${s}`));
  expect(text).toMatch(new RegExp(`Carbon brush ${s} .*2 \\$400\\.00 \\$120\\.00 \\$800\\.00`));
  expect(text).toMatch(/Parts Total \$120\.00 \$800\.00/);
  expect(text).toMatch(/Assessment Fee \(non-refundable deposit\)/);
  // GCT: 15% of 1,000 + 6,000 + 850 + 800 = 1,297.50; total 9,947.50; less the 1,150 assessment deposit.
  expect(text).toMatch(/GCT \$1,297\.50/);
  expect(text).toMatch(/Total \$9,947\.50/);
  expect(text).toMatch(/Less Non-Refundable Deposit Paid \(assessment fee\) -\$1,150\.00/);
  expect(text).toMatch(/BALANCE DUE \$8,797\.50/);

  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(id => App.viewWorkOrder(id), wo.id);
  await expect(page.locator('.modal')).toContainText('Consumables');
  await expect(page.locator('.modal')).not.toContainText('labor + consumables');

  // Attach the signed contract.
  await expect(page.locator('.modal')).toContainText('No signed contract');
  await page.selectOption('#wo-doc-type', 'signed_contract');
  await page.fill('#wo-doc-notes', 'Signed at intake');
  await page.setInputFiles('#wo-doc-file', { name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 signed contract') });
  await expect(page.locator('.modal')).toContainText('Signed contract on file');
  const docs = await api(page, 'GET', `/work-orders/${wo.id}/attachments`);
  expect(docs.length).toBe(1);
  expect(docs[0].document_type).toBe('signed_contract');
  const dl = await page.evaluate(([w, d]) => fetch(`/api/work-orders/${w}/attachments/${d}/download`).then(async r => [r.status, await r.text()]), [wo.id, docs[0].id]);
  expect(dl).toEqual([200, '%PDF-1.4 signed contract']);
  // Not served as a static file.
  expect(await page.evaluate(n => fetch(`/uploads/wo-attachments/${n}`).then(r => r.status), docs[0].stored_name)).toBe(404);
  // Wrong file type refused.
  const bad = await page.evaluate(async id => { const fd = new FormData(); fd.append('file', new Blob(['x'], { type: 'application/x-msdownload' }), 'a.exe'); const r = await fetch(`/api/work-orders/${id}/attachments`, { method: 'POST', body: fd }); return r.status; }, wo.id);
  expect(bad).toBe(400);
  page.once('dialog', d => d.accept());
  await page.locator(`.wo-doc-row[data-doc-id="${docs[0].id}"]`).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.modal')).toContainText('No signed contract');
  const log = (await api(page, 'GET', `/work-orders/${wo.id}`)).status_log.map(l => l.comment || '').join('|');
  expect(log).toContain('Signed contract attached: contract.pdf');
  expect(log).toContain('Signed contract removed: contract.pdf');
});
