import { test, expect } from './fixtures.js';

// A driver with only Mark Picked Up / Mark Dropped Off: their own list on
// Branch Transfer Dispatch, the two actions, and nothing else of Transfers.
// Dropping off counts nothing in — someone at the branch receives it.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

async function signIn(page, username, password) {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('a transfer driver can only mark picked up and dropped off', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0 && !Number(b.is_warehouse));
  const p = await api(page, 'POST', '/products', { sku: `TDR-${s}`, name: `Driver Box ${s}`, price: 10, cost: 5, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 5, branch_id: main.id, reason: 'test' });
  const tr = await api(page, 'POST', '/transfers', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: p.id, quantity: 3 }] });
  const full = await api(page, 'GET', `/transfers/${tr.id}`);
  await api(page, 'PATCH', `/transfers/${tr.id}/send`, { items: [{ item_id: full.items[0].id, quantity: 3 }] });
  expect((await api(page, 'GET', `/transfers/${tr.id}`)).status).toBe('pending');

  // Saved through the editor: ticking the two boxes leaves Transfers unticked.
  await page.evaluate(() => App.showSecurityGroupForm());
  await page.fill('#sg-name', `Transfer Drivers ${s}`);
  await page.locator('#perm-transfers_pickup').check({ force: true });
  await page.locator('#perm-transfers_dropoff').check({ force: true });
  expect(await page.locator('#perm-transfers').isChecked()).toBe(false);
  await page.click('button:has-text("Save Group")');
  await expect(page.locator('.alert-success', { hasText: 'Security group saved' }).last()).toBeVisible();
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === `Transfer Drivers ${s}`);
  await api(page, 'POST', '/employees', { first_name: 'Van', last_name: `Driver ${s}`, username: `vd${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1, is_driver: 1, default_branch_id: main.id });

  await signIn(page, `vd${s}`, 'pw-123456');
  // Nothing of Transfers beyond the two actions.
  for (const [m, u, d] of [['GET', '/transfers'], ['GET', `/transfers/${tr.id}`], ['PATCH', `/transfers/${tr.id}/cancel`, {}], ['POST', '/transfers', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: p.id, quantity: 1 }] }]]) {
    expect(await attempt(page, m, u, d)).toMatch(/permission/i);
  }
  expect(await page.evaluate(() => [App._canManageTransfers(), App._hubTileAllowed('transfers'), App._hubTileAllowed('transfer-dispatch')])).toEqual([false, false, true]);

  await page.evaluate(() => App.showSection('transfer-dispatch'));
  const row = page.locator('tr', { hasText: tr.transfer_number });
  await expect(row).toContainText(`Driver Box ${s} x3`);
  await expect(row.locator('button', { hasText: 'View' })).toHaveCount(0);

  // Picked up: defaults to the driver signed in.
  await row.locator('button', { hasText: 'Picked Up' }).click();
  await page.click('button:has-text("Mark In-Transit")');
  await expect.poll(async () => (await api(page, 'GET', '/transfers/driver-queue')).find(t => t.id === tr.id)?.status).toBe('in_transit');

  // Dropped off: no quantities, nothing into stock yet.
  await page.locator('tr', { hasText: tr.transfer_number }).locator('button', { hasText: 'Dropped Off' }).click();
  await expect(page.locator('.modal')).not.toContainText('Qty');
  await page.fill('#tdrop-note', 'Left with the counter');
  await page.click('.modal-footer button:has-text("Mark Dropped Off")');
  await expect(page.locator('.alert-success', { hasText: 'Dropped off' }).last()).toBeVisible();
  await expect.poll(async () => (await api(page, 'GET', '/transfers/driver-queue')).some(t => t.id === tr.id)).toBe(false);
  expect(await attempt(page, 'PATCH', `/transfers/${tr.id}/receive`, { items: [{ item_id: full.items[0].id, quantity_received: 3 }], delivered_by_name: 'x' })).toMatch(/permission/i);

  // Someone at the branch counts it in.
  const recvGroup = await (async () => { await signIn(page, 'admin', '123456'); return api(page, 'POST', '/security-groups', { name: `Receivers ${s}`, permissions: { transfers_receive: true } }); })();
  await api(page, 'POST', '/employees', { first_name: 'Branch', last_name: `Receiver ${s}`, username: `br${s}`, pin: String(Number(s.slice(-6)) + 1).slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: recvGroup.id, active: 1, default_branch_id: other.id });
  let t = await api(page, 'GET', `/transfers/${tr.id}`);
  expect(t).toMatchObject({ status: 'in_transit', dropped_off_by_name: `Van Driver ${s}`, dropoff_note: 'Left with the counter' });
  expect(t.items[0].quantity_received || 0).toBe(0);
  await signIn(page, `br${s}`, 'pw-123456');
  await page.evaluate(() => App.showSection('transfers'));
  const listRow = page.locator('tr', { hasText: tr.transfer_number });
  await expect(listRow).toContainText('dropped off');
  await listRow.locator('button', { hasText: 'Receive' }).click();
  await page.fill(`#trecv-${full.items[0].id}`, '2');
  await page.click('button:has-text("Confirm Receipt")');
  await expect(page.locator('.alert-success', { hasText: 'Items received' }).last()).toBeVisible();

  await signIn(page, 'admin', '123456');
  t = await api(page, 'GET', `/transfers/${tr.id}`);
  expect(t.items[0].quantity_received).toBe(2);
  expect(t.driver_display_name).toBe(`Van Driver ${s}`);
  expect(t.receipts[0]).toMatchObject({ delivered_by_display: `Van Driver ${s}`, received_by_name: `Branch Receiver ${s}` });
});
