import { test, expect } from './fixtures.js';

// Rental check-out and check-in photos: issue and return are refused until a
// photo of the item has been taken for that step; the step keeps them on the
// record; the return screen shows the issue photos to compare.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const photo = name => ({ name, mimeType: 'image/png', buffer: PNG });

async function drawSig(page, id) {
  await page.locator(`#${id}`).scrollIntoViewIfNeeded();
  const box = await page.locator(`#${id}`).boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 });
  await page.mouse.up();
}

test('issue and return need photos of the item, kept on the agreement', async ({ page }) => {
  const s = `${Date.now()}`;
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const guard = await api(page, 'POST', '/employees', { first_name: 'Gate', last_name: `Guard ${s}`, username: `gg${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager').id, active: 1, is_security: 1 });
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Photo', last_name: `Renter ${s}`, phone: `876${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' }] });
  const customer = (await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Renter ${s}`)}`))[0];
  const item = await api(page, 'POST', '/products', { sku: `RPH-${s}`, name: `Photo Mixer ${s}`, is_rental: 1, rental_rate: 50, branch_id: branch.id, stock_qty: 2 });
  const due = await page.evaluate(() => App._storeDay(new Date(Date.now() + 3 * 86400000)));
  const ag = await api(page, 'POST', '/rentals/agreements', { customer_id: customer.id, branch_id: branch.id, due_date: due, items: [{ product_id: item.id, quantity: 1 }] });
  await api(page, 'PATCH', `/rentals/agreements/${ag.id}/checkout`, { payment_method: 'cash', amount_tendered: 100000 });

  // Refused without a photo.
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${ag.id}/issue`, { security_employee_id: guard.id, customer_signature: 'data:image/png;base64,' + PNG.toString('base64'), security_signature: 'data:image/png;base64,' + PNG.toString('base64') }))
    .toMatch(/photo of the item\(s\) at issue/);
  // Return photos can't be taken before it's out.
  expect(await page.evaluate(async id => {
    const fd = new FormData(); fd.append('stage', 'return'); fd.append('photo', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'x.png');
    return (await fetch(`/api/rentals/agreements/${id}/photos`, { method: 'POST', body: fd })).status;
  }, ag.id)).toBe(400);

  // Issue screen: the button asks for a photo, then takes one.
  await page.evaluate(id => App.showIssueRentalModal(id), ag.id);
  await page.locator('#ri-security-employee').selectOption(String(guard.id));
  await drawSig(page, 'ri-guard-sig');
  await drawSig(page, 'ri-customer-sig');
  await page.click('button:has-text("Issue Rental")');
  await expect(page.locator('.alert-error', { hasText: 'photo of the item(s) at issue' }).last()).toBeVisible();
  await page.locator('#rph-issue').locator('..').locator('input[capture]').setInputFiles(photo('out1.png'));
  await page.locator('#rph-issue').locator('..').locator('input[multiple]').setInputFiles([photo('out2.png'), photo('out3.png')]);
  await expect(page.locator('#rph-issue img')).toHaveCount(3);
  await page.locator('#rph-issue button[title="Remove photo"]').first().click();
  await expect(page.locator('#rph-issue img')).toHaveCount(2);
  await drawSig(page, 'ri-customer-sig');
  await page.click('button:has-text("Issue Rental")');
  await expect.poll(async () => (await api(page, 'GET', `/rentals/agreements/${ag.id}`)).status).toBe('active');

  let full = await api(page, 'GET', `/rentals/agreements/${ag.id}`);
  expect(full.photos.map(p => [p.stage, !!p.used_at])).toEqual([['issue', true], ['issue', true]]);
  // Kept: can't be removed once issued, and the file is only for signed-in sessions.
  expect(await attempt(page, 'DELETE', `/rentals/agreements/${ag.id}/photos/${full.photos[0].id}`)).toMatch(/stays on the record/);
  expect((await page.request.get(full.photos[0].url)).status()).toBe(200);
  expect((await page.context().browser().newContext().then(c => c.request.get(new URL(full.photos[0].url, page.url()).href))).status()).toBe(401);

  // Return screen: issue photos shown to compare; refused until a return photo is taken.
  await page.evaluate(id => App.showRentalReturnModal(id), ag.id);
  await expect(page.locator('#rph-return-compare img')).toHaveCount(2);
  await page.locator('#rr-security-employee').selectOption(String(guard.id));
  await drawSig(page, 'rr-guard-sig');
  await page.click('button:has-text("Confirm Return")');
  await expect(page.locator('.alert-error', { hasText: 'photo of the item(s) at return' }).last()).toBeVisible();
  await page.locator('#rph-return').locator('..').locator('input[capture]').setInputFiles(photo('back.png'));
  await expect(page.locator('#rph-return img')).toHaveCount(1);
  await drawSig(page, 'rr-guard-sig');
  await page.click('button:has-text("Confirm Return")');
  await expect.poll(async () => (await api(page, 'GET', `/rentals/agreements/${ag.id}`)).status).toBe('returned');

  full = await api(page, 'GET', `/rentals/agreements/${ag.id}`);
  expect(full.photos.map(p => [p.stage, !!p.used_at])).toEqual([['issue', true], ['issue', true], ['return', true]]);
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.viewRentalAgreement(id), ag.id);
  await expect(page.locator('.modal')).toContainText('Photos at Issue');
  await expect(page.locator('.modal')).toContainText('Photos at Return');
});

test('security hands over a counter rental with photos and signatures, and sees no amounts', async ({ page }) => {
  const s = `${Date.now()}`;
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const group = await api(page, 'POST', '/security-groups', { name: `Guards ${s}`, permissions: { rentals_security_signoff: true } });
  const guard = await api(page, 'POST', '/employees', { first_name: 'Only', last_name: `Guard ${s}`, username: `og${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1, is_security: 1, default_branch_id: branch.id });
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Counter', last_name: `Collect ${s}`, phone: `875${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' }] });
  const customer = (await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Collect ${s}`)}`))[0];
  const item = await api(page, 'POST', '/products', { sku: `RGH-${s}`, name: `Guard Saw ${s}`, is_rental: 1, rental_rate: 40, branch_id: branch.id, stock_qty: 2 });
  const due = await page.evaluate(() => App._storeDay(new Date(Date.now() + 2 * 86400000)));
  const mk = async extra => {
    const a = await api(page, 'POST', '/rentals/agreements', { customer_id: customer.id, branch_id: branch.id, due_date: due, items: [{ product_id: item.id, quantity: 1 }], ...extra });
    await api(page, 'PATCH', `/rentals/agreements/${a.id}/checkout`, { payment_method: 'cash', amount_tendered: 100000 });
    return a;
  };
  const counter = await mk({});
  const delivery = await mk({ delivery_required: true, delivery_cost: 10, delivery_address: '1 Test Road' });

  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', `og${s}`);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && App.section === 'guard-dashboard');

  // No financial routes, and the guard's own list carries no amounts.
  expect(await attempt(page, 'GET', '/rentals/agreements?view=active')).toMatch(/permission|denied|not allowed/i);
  expect(await attempt(page, 'GET', `/rentals/agreements/${counter.id}`)).toMatch(/permission|denied|not allowed/i);
  const queue = await api(page, 'GET', '/rentals/agreements/guard-queue');
  const row = queue.find(a => a.id === counter.id);
  expect(row).toBeTruthy();
  expect(Object.keys(row).filter(k => /total|deposit|fee|cost|price|amount|rate|balance/.test(k))).toEqual([]);
  await expect(page.locator('#content')).not.toContainText('$');
  await expect(page.locator('#content')).not.toContainText('View');
  expect(await page.evaluate(() => App._canManageRentals())).toBe(false);

  // A delivery is the driver's to hand over.
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${delivery.id}/issue`, { customer_name: 'x', customer_signature: 'x', security_signature: 'x' })).toMatch(/driver/);

  // Counter collection: Hand Over.
  const card = page.locator('#content > .card').first();
  await card.locator(`div:has-text("${counter.agreement_number}") >> button:has-text("Hand Over")`).first().click();
  await expect(page.locator('.modal')).not.toContainText('$');
  await page.locator('#rph-issue').locator('..').locator('input[capture]').setInputFiles(photo('gate.png'));
  await expect(page.locator('#rph-issue img')).toHaveCount(1);
  await drawSig(page, 'gi-guard-sig');
  await page.fill('#gi-customer-name', 'Pat Collector');
  await drawSig(page, 'gi-customer-sig');
  await page.click('button:has-text("Hand Over & Start Rental")');
  await expect(page.locator('.alert-success', { hasText: 'Handed over' }).last()).toBeVisible();

  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', '123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
  const issued = await api(page, 'GET', `/rentals/agreements/${counter.id}`);
  expect(issued).toMatchObject({ status: 'active', issue_security_employee_id: guard.id, issued_by: guard.id, issue_customer_name: 'Pat Collector' });
  expect(issued.photos.map(p => [p.stage, !!p.used_at, p.uploaded_by])).toEqual([['issue', true, guard.id]]);
});
