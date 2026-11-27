import { test, expect } from './fixtures.js';

// Reports → Purchasing → Purchase Orders by Department: POs ordered in a
// range by department (from the purchase request) and branch, with what's
// been received and what's still to come; or what was received in the range.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function login(page, username, password = 'pw-123456') {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('purchase orders by department and branch — ordered and received', async ({ page }) => {
  const s = `${Date.now()}`;
  const dept = `Maint ${s}`;
  const groups = await api(page, 'GET', '/security-groups');
  const approver = `pod${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Pod', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  const sup = await api(page, 'POST', '/suppliers', { name: `Dept Supplier ${s}` });
  const prod = await api(page, 'POST', '/products', { name: `Dept Bolt ${s}`, sku: `DB${s}`, price: 50, cost: 10, tax_rate: 0, stock_qty: 0, active: 1 });

  // A PR from the department, converted to a PO of 10 × 10 (no GCT).
  const pr = await api(page, 'POST', '/purchase-requests', { branch_id: 1, department: dept, supplier_id: sup.id, items: [{ product_id: prod.id, product_name: prod.name, quantity: 10, unit_cost: 10, tax_exempt: 1 }] });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'approved', signature: SIG });
  const conv = await api(page, 'POST', `/purchase-requests/${pr.id}/convert`, { supplier_id: sup.id });
  const poId = conv.id || conv.po_id;
  await api(page, 'PATCH', `/purchase-orders/${poId}/status`, { status: 'sent' });
  await login(page, approver);
  await api(page, 'PATCH', `/purchase-orders/${poId}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const po = await api(page, 'GET', `/purchase-orders/${poId}`);
  await api(page, 'PATCH', `/purchase-orders/${poId}/receive`, { items: [{ item_id: po.items[0].id, quantity_received: 4 }] });

  const q = basis => api(page, 'GET', `/reports/po-by-department?basis=${basis}&department=${encodeURIComponent(dept)}`);
  const ordered = await q('ordered');
  expect(ordered.rows.map(r => [r.po_number, r.department, r.branch_id, r.total, r.received, r.outstanding])).toEqual([[po.po_number, dept, 1, 100, 40, 60]]);
  expect(ordered.by_department).toMatchObject([{ department: dept, count: 1, total: 100, received: 40, outstanding: 60 }]);
  const received = await q('received');
  expect(received.rows.map(r => [r.po_number, r.department, r.total])).toEqual([[po.po_number, dept, 40]]);
  expect(received.summary).toMatchObject({ count: 1, pos: 1, total: 40 });
  // Another branch: nothing.
  expect((await api(page, 'GET', `/reports/po-by-department?department=${encodeURIComponent(dept)}&branch_id=999999`)).rows).toHaveLength(0);
  // Raised directly (no PR) → No department.
  const none = await api(page, 'GET', '/reports/po-by-department?department=none');
  expect(none.rows.every(r => r.department == null)).toBe(true);

  // On screen.
  await page.evaluate(() => App.showSection('reports-purchasing'));
  await page.locator('.card', { hasText: 'Purchase Orders by Department' }).getByRole('button', { name: 'View Report' }).click();
  await expect(page.locator('#pod-dept option', { hasText: dept })).toHaveCount(1);
  await page.locator('#pod-dept').selectOption(dept);
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.locator('#pod-rows')).toContainText(po.po_number);
  await expect(page.locator('#pod-by-dept')).toContainText('$60.00');
  await page.locator('#pod-basis').selectOption('received');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.locator('#pod-rows')).toContainText('$40.00');
});
