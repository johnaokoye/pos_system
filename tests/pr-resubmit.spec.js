import { test, expect } from './fixtures.js';

// Edit & Resubmit on a rejected purchase request: back to draft under the same
// number for the person who raised it, then submitted and approved again.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);

async function signIn(page, username) {
  await page.waitForLoadState('networkidle');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', username === 'admin' ? '123456' : 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('only the requester can Edit & Resubmit a rejected request; it goes round again under the same number', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.is_service && p.cost > 0)));
  // Someone else with full Purchase Requests access.
  const group = await api(page, 'POST', '/security-groups', { name: `PR other ${stamp}`, description: '', permissions: { purchase_requests: true } });
  const other = `pro${stamp}`;
  await api(page, 'POST', '/employees', { first_name: 'Other', last_name: 'Requester', username: other, pin: stamp.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });

  const sup = await api(page, 'POST', '/suppliers', { name: `Resubmit Supplier ${stamp}` });
  // Admin raises it (recorded as the requester), submits, and it's rejected.
  const pr = await api(page, 'POST', '/purchase-requests', { request_type: 'sale_items', branch_id: 1, supplier_id: sup.id, items: [{ product_id: product.id, quantity: 2, unit_cost: product.cost }] });
  expect(pr.employee_id).toBe(await page.evaluate(() => App.currentUser.id));
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'rejected', rejection_reason: 'Wrong quantity' });
  // The old back door is closed.
  expect(await refused(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'draft' })).toContain('Edit & Resubmit');

  // Someone else neither sees the button nor can do it.
  await signIn(page, other);
  await page.evaluate(id => App.viewPR(id), pr.id);
  await expect(page.locator('.modal')).toContainText('Wrong quantity');
  await expect(page.locator('.modal').getByRole('button', { name: 'Edit & Resubmit' })).toHaveCount(0);
  expect(await refused(page, 'PATCH', `/purchase-requests/${pr.id}/reopen`, {})).toContain('Only the person who raised');

  // The requester does: it opens as a draft form with the reason on top.
  await signIn(page, 'admin');
  await page.evaluate(id => App.viewPR(id), pr.id);
  await page.locator('.modal').getByRole('button', { name: 'Edit & Resubmit' }).click();
  await expect(page.locator('.modal')).toContainText('Rejected earlier: Wrong quantity');
  const again = await api(page, 'GET', `/purchase-requests/${pr.id}`);
  expect(again).toMatchObject({ status: 'draft', pr_number: pr.pr_number, rejection_reason: 'Wrong quantity' });

  // Fixed, resubmitted and approved: the old reason clears.
  await api(page, 'PUT', `/purchase-requests/${pr.id}`, { request_type: 'sale_items', branch_id: 1, supplier_id: sup.id, items: [{ product_id: product.id, quantity: 5, unit_cost: product.cost }] });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' });
  const approved = await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'approved', signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
  expect(approved).toMatchObject({ status: 'approved', rejection_reason: null });
});

test('a request needs a supplier to be submitted, approved or converted', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.is_service && p.cost > 0)));
  const items = [{ product_id: product.id, quantity: 1, unit_cost: product.cost }];
  // A draft can be saved without one…
  const pr = await api(page, 'POST', '/purchase-requests', { request_type: 'sale_items', branch_id: 1, items });
  expect(pr).toMatchObject({ status: 'draft', supplier_id: null });
  // …but not submitted.
  expect(await refused(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' })).toContain('Choose a supplier');
  // The form stops it too, before saving anything.
  await page.evaluate(id => App.showPRForm(id), pr.id);
  await page.locator('.modal').getByRole('button', { name: 'Submit Request' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  expect((await api(page, 'GET', `/purchase-requests/${pr.id}`)).status).toBe('draft');
  await page.evaluate(() => App.closeModal());

  // Nor approved (covers requests submitted before the rule).
  expect(await refused(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'approved', signature: SIG })).toContain('no supplier');

  // With a supplier it goes through and converts.
  const sup = await api(page, 'POST', '/suppliers', { name: `Required Supplier ${stamp}` });
  await api(page, 'PUT', `/purchase-requests/${pr.id}`, { request_type: 'sale_items', branch_id: 1, supplier_id: sup.id, items });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'approved', signature: SIG });
  const po = await api(page, 'POST', `/purchase-requests/${pr.id}/convert`, {});
  const poFull = await api(page, 'GET', `/purchase-orders/${po.id || po.po_id}`);
  expect(poFull.supplier_id).toBe(sup.id);
});
