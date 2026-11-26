import { test, expect } from './fixtures.js';

// FleetHub (lib/fleethub.js) against the mock in tests/support/mock-fleethub.js:
// a fleet-tracked rental can't go out until the units picked pass FleetHub's
// checkout (pre-rental checklist done); each unit comes back on its own at
// check-in / return with its readings, and then needs a new checklist.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const MOCK = `http://localhost:${process.env.FLEETHUB_TEST_PORT}`;
const mock = async (path, body) => (await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const unit = async n => (await mock('/__mock/state')).units.find(u => u.unitNumber === n);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SIG = 'data:image/png;base64,' + PNG.toString('base64');

const addPhoto = (page, id, stage) => page.evaluate(async ([id, stage]) => {
  const fd = new FormData(); fd.append('stage', stage);
  fd.append('photo', new Blob([new Uint8Array(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==').split('').map(c => c.charCodeAt(0)))], { type: 'image/png' }), 'p.png');
  const r = await fetch(`/api/rentals/agreements/${id}/photos`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error((await r.json()).error);
}, [id, stage]);

test.beforeEach(() => mock('/__mock/down', { down: false }));

async function drawSig(page, id) {
  await page.locator(`#${id}`).scrollIntoViewIfNeeded();
  const box = await page.locator(`#${id}`).boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 });
  await page.mouse.up();
}

async function setup(page, s, qty = 2) {
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const admins = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const guard = await api(page, 'POST', '/employees', { first_name: 'Fleet', last_name: `Guard ${s}`, username: `fg${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admins.id, active: 1, is_security: 1, default_branch_id: branch.id });
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Fleet', last_name: `Renter ${s}`, phone: `874${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' }] });
  const customer = (await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Renter ${s}`)}`))[0];
  const sku = `FLT-${s}`;
  const item = await api(page, 'POST', '/products', { sku, name: `Scissor Lift ${s}`, is_rental: 1, rental_classification: 'equipment', rental_rate: 100, branch_id: branch.id, stock_qty: 4 });
  const u = n => `L${s.slice(-5)}-${n}`;
  await mock('/__mock/units', { units: [{ unitNumber: u(1), sku }, { unitNumber: u(2), sku }, { unitNumber: u(3), sku }, { unitNumber: u(4), sku, status: 'needs_service' }] });
  const due = await page.evaluate(() => App._storeDay(new Date(Date.now() + 3 * 86400000)));
  const agreement = async (extra = {}, q = qty) => {
    const a = await api(page, 'POST', '/rentals/agreements', { customer_id: customer.id, branch_id: branch.id, due_date: due, items: [{ product_id: item.id, quantity: q }], ...extra });
    await api(page, 'PATCH', `/rentals/agreements/${a.id}/checkout`, { payment_method: 'cash', amount_tendered: 1000000 });
    return api(page, 'GET', `/rentals/agreements/${a.id}`);
  };
  return { branch, guard, customer, item, sku, u, agreement };
}

test('counter issue is gated by FleetHub; units come back one at a time with readings', async ({ page }) => {
  const s = `${Date.now()}`;
  const { guard, u, agreement } = await setup(page, s);
  const a = await agreement();
  const line = a.items[0];
  await addPhoto(page, a.id, 'issue');
  const issueBody = extra => ({ security_employee_id: guard.id, customer_signature: SIG, security_signature: SIG, ...extra });

  // Units must be picked, and only ready ones.
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/issue`, issueBody())).toMatch(/Pick 2 units/);
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/issue`, issueBody({ fleet_units: { [line.id]: [u(1), u(4)] } }))).toMatch(/isn't ready to rent.*checklist/);
  // FleetHub down: nothing goes out.
  await mock('/__mock/down', { down: true });
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/issue`, issueBody({ fleet_units: { [line.id]: [u(1), u(2)] } }))).toMatch(/FleetHub/);
  await mock('/__mock/down', { down: false });
  expect((await api(page, 'GET', `/rentals/agreements/${a.id}`)).status).toBe('awaiting_issue');

  // Issue screen: one dropdown per unit, the unchecked one can't be picked.
  await page.evaluate(id => App.showIssueRentalModal(id), a.id);
  await expect(page.locator('#ri-fleet-units select.fleet-pick')).toHaveCount(2);
  await expect(page.locator(`#ri-fleet-units select.fleet-pick >> nth=0 >> option[value="${u(4)}"]`)).toBeDisabled();
  await page.locator('#ri-security-employee').selectOption(String(guard.id));
  await drawSig(page, 'ri-guard-sig');
  await drawSig(page, 'ri-customer-sig');
  await page.click('button:has-text("Issue Rental")');
  await expect(page.locator('.alert-error', { hasText: 'Pick a fleet unit' }).last()).toBeVisible();
  await page.locator('#ri-fleet-units select.fleet-pick').nth(0).selectOption(u(1));
  await page.locator('#ri-fleet-units select.fleet-pick').nth(1).selectOption(u(2));
  await page.click('button:has-text("Issue Rental")');
  await expect.poll(async () => (await api(page, 'GET', `/rentals/agreements/${a.id}`)).status).toBe('active');
  expect((await unit(u(1))).status).toBe('rented');
  expect((await unit(u(2))).status).toBe('rented');
  let full = await api(page, 'GET', `/rentals/agreements/${a.id}`);
  expect(full.fleet_units.map(f => [f.unit_number, f.status])).toEqual([[u(1), 'issued'], [u(2), 'issued']]);

  // Part return: the unit(s) ticked must match the quantity, and be out on the line.
  await addPhoto(page, a.id, 'return');
  const ret = (units, qty = 1) => ({ items: [{ item_id: line.id, quantity_returned: qty, fleet_units: units }], return_security_employee_id: guard.id, security_signature: SIG });
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/return`, ret([]))).toMatch(/Tick the 1 unit/);
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/return`, ret([{ unit_number: u(3) }]))).toMatch(/isn't out on/);
  await api(page, 'PATCH', `/rentals/agreements/${a.id}/return`, ret([{ unit_number: u(2), odometer: 1234, meter_hours: 56.5 }]));
  // Only that one is back in FleetHub (with its readings); the other is still out.
  expect(await unit(u(2))).toMatchObject({ status: 'needs_service', odometer: 1234, meterHours: 56.5 });
  expect((await unit(u(1))).status).toBe('rented');
  full = await api(page, 'GET', `/rentals/agreements/${a.id}`);
  expect(full.fleet_units.find(f => f.unit_number === u(2))).toMatchObject({ status: 'returned', sync_pending: 0, odometer: 1234 });

  // A returned unit needs a new checklist before it can go out again.
  const b = await agreement({}, 1);
  await addPhoto(page, b.id, 'issue');
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${b.id}/issue`, issueBody({ fleet_units: { [b.items[0].id]: [u(2)] } }))).toMatch(/isn't ready to rent/);
  await mock(`/__mock/units/${u(2)}/checklist`, {});
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${b.id}/issue`, issueBody({ fleet_units: { [b.items[0].id]: [u(2)] } }))).toBe('accepted');

  // Return screen: a tick box per unit still out; FleetHub down doesn't stop the return.
  await mock('/__mock/down', { down: true });
  await addPhoto(page, a.id, 'return');
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.showRentalReturnModal(id), a.id);
  await expect(page.locator(`#rr-fleet-${line.id} input.fleet-ret`)).toHaveCount(1);
  await expect(page.locator(`#rr-fleet-${line.id} input.fleet-ret`)).toBeChecked();
  await page.locator(`#rr-fleet-${line.id} .fleet-odo`).fill('2000');
  await page.locator('#rr-security-employee').selectOption(String(guard.id));
  await drawSig(page, 'rr-guard-sig');
  await page.click('button:has-text("Confirm Return")');
  await expect.poll(async () => (await api(page, 'GET', `/rentals/agreements/${a.id}`)).status).toBe('returned');
  full = await api(page, 'GET', `/rentals/agreements/${a.id}`);
  expect(full.fleet_units.find(f => f.unit_number === u(1))).toMatchObject({ status: 'returned', sync_pending: 1, odometer: 2000 });
  expect((await unit(u(1))).status).toBe('rented');
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.viewRentalAgreement(id), a.id);
  await expect(page.locator('.modal')).toContainText('Fleet Units (FleetHub)');
  await expect(page.locator('.modal')).toContainText('not yet in FleetHub');
  await mock('/__mock/down', { down: false });
});

test('delivery: security picks the units at sign-off; check-in ticks them back; cancel releases them', async ({ page }) => {
  const s = `${Date.now()}`;
  const { u, agreement } = await setup(page, s, 1);
  const a = await agreement({ delivery_required: true, delivery_cost: 10, delivery_address: '1 Fleet Road' });
  const c = await agreement({ delivery_required: true, delivery_cost: 10, delivery_address: '2 Fleet Road' });

  // Sign in as the guard.
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', `fg${s}`);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser);

  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/security-signoff`, { security_signature: SIG })).toMatch(/Pick 1 unit/);
  await page.evaluate(() => App.renderGuardDashboard());
  await page.waitForFunction(() => (App._guardDashCache || []).length > 0);
  await page.evaluate(id => App.showSecuritySignoffModal(id), a.id);
  await expect(page.locator('#ss-fleet-units select.fleet-pick')).toHaveCount(1);
  await page.locator('#ss-fleet-units select.fleet-pick').selectOption(u(1));
  await drawSig(page, 'ss-guard-sig');
  await page.click('.modal button:has-text("Sign Off")');
  await expect.poll(async () => (await unit(u(1))).status).toBe('rented');

  // A second delivery signed off with another unit, then cancelled before a
  // driver took it: the unit never left, so it's simply available again.
  await api(page, 'PATCH', `/rentals/agreements/${c.id}/security-signoff`, { security_signature: SIG, fleet_units: { [c.items[0].id]: [u(3)] } });
  expect((await unit(u(3))).status).toBe('rented');
  await api(page, 'PATCH', `/rentals/agreements/${c.id}/cancel`, { reason: 'Customer called off' });
  expect((await unit(u(3))).status).toBe('available');

  // The desk issues the delivery: the unit picked at sign-off goes out, nothing more to pick.
  await addPhoto(page, a.id, 'issue');
  await api(page, 'PATCH', `/rentals/agreements/${a.id}/issue`, { customer_signature: SIG });
  let full = await api(page, 'GET', `/rentals/agreements/${a.id}`);
  expect(full.status).toBe('active');
  expect(full.fleet_units.map(f => [f.unit_number, f.status])).toEqual([[u(1), 'issued']]);

  // Check-in at the gate ticks the unit with its engine hours; the return uses it.
  await addPhoto(page, a.id, 'return');
  const line = full.items[0].id;
  expect(await attempt(page, 'PATCH', `/rentals/agreements/${a.id}/return-checkin`, { items: [{ item_id: line, quantity: 1 }], security_signature: SIG })).toMatch(/Tick the 1 unit/);
  await page.evaluate(() => App.renderGuardDashboard());
  await page.waitForFunction(id => (App._guardDashCache || []).some(x => x.id === id && x.status === 'active'), a.id);
  await page.evaluate(id => App.showGuardCheckInModal(id), a.id);
  await expect(page.locator(`#gc-fleet-${line} input.fleet-ret`)).toBeChecked();
  await page.locator(`#gc-fleet-${line} .fleet-hrs`).fill('812.5');
  await drawSig(page, 'gc-guard-sig');
  await page.click('.modal button:has-text("Check In")');
  await expect.poll(async () => JSON.parse((await api(page, 'GET', `/rentals/agreements/${a.id}`)).return_checkin_items || '[]')[0]?.units)
    .toEqual([{ unit_number: u(1), odometer: null, meter_hours: 812.5 }]);
  expect((await unit(u(1))).status).toBe('rented'); // not back until the return is processed
  await api(page, 'PATCH', `/rentals/agreements/${a.id}/return`, { items: [{ item_id: line, quantity_returned: 1 }] });
  expect(await unit(u(1))).toMatchObject({ status: 'needs_service', meterHours: 812.5 });
});

test('replacing a fleet unit returns the old one and checks out the new one', async ({ page }) => {
  const s = `${Date.now()}`;
  const { guard, u, agreement } = await setup(page, s, 1);
  const a = await agreement();
  const line = a.items[0].id;
  await addPhoto(page, a.id, 'issue');
  await api(page, 'PATCH', `/rentals/agreements/${a.id}/issue`, { security_employee_id: guard.id, customer_signature: SIG, security_signature: SIG, fleet_units: { [line]: [u(1)] } });
  await api(page, 'POST', `/rentals/agreements/${a.id}/pause`, { reason: 'replacement', notes: 'Hydraulics leaking', override_pin: s.slice(-6), employee_id: guard.id });

  await page.evaluate(id => App.showReplaceRentalItemModal(id), a.id);
  await expect(page.locator('#rpl-fleet-back input.fleet-ret')).toBeChecked();
  await expect(page.locator('#rpl-fleet-new select.fleet-pick')).toHaveCount(1);
  await page.fill('#rpl-notes', 'Hydraulics leaking');
  await page.locator('#rpl-fleet-back .fleet-odo').fill('3100');
  await page.click('#rpl-submit');
  await expect(page.locator('.alert-error', { hasText: 'Pick a fleet unit' }).last()).toBeVisible();
  await page.locator('#rpl-fleet-new select.fleet-pick').selectOption(u(2));
  await page.click('#rpl-submit');
  await expect.poll(async () => (await unit(u(2))).status).toBe('rented');
  expect(await unit(u(1))).toMatchObject({ status: 'needs_service', odometer: 3100 });
  const full = await api(page, 'GET', `/rentals/agreements/${a.id}`);
  expect(full.fleet_units.map(f => [f.unit_number, f.status, f.item_id])).toEqual([[u(1), 'returned', line], [u(2), 'issued', line]]);
});

test('booking screens show how many fleet units are ready now, without blocking', async ({ page }) => {
  const s = `${Date.now()}`;
  const { branch, customer, sku, u } = await setup(page, s, 1);
  const r = await api(page, 'GET', `/rentals/fleet-readiness?skus=${sku},NOT-TRACKED-${s}`);
  expect(r.enabled).toBe(true);
  expect(Object.keys(r.items)).toEqual([sku]);
  expect(r.items[sku]).toMatchObject({ total: 4, ready: 3 });
  expect(r.items[sku].not_ready).toEqual([{ unitNumber: u(4), name: u(4), reasons: ['Pre-rental checklist not completed since last return'] }]);

  // New Rental's item picker and the chosen line both say so.
  await page.evaluate(() => App.showRentalCheckoutModal());
  await page.evaluate(id => { const el = document.getElementById('rc-branch'); el.value = String(id); if (el.tagName === 'SELECT') App._refreshRentalCheckoutBranch(); }, branch.id);
  await page.waitForFunction(() => (App._rentalProducts || []).length > 0);
  const idx = await page.evaluate(() => document.querySelector('[id^="rl-prod-btn-"]').id.replace('rl-prod-btn-', ''));
  await page.evaluate(i => App._openRentalItemPicker(i), idx);
  await page.fill('#rl-picker-search', sku);
  await expect(page.locator('#rl-picker-list .fleet-ready.warn')).toContainText('Ready now: 3 of 4');
  await page.locator('#rl-picker-list .nav-item').first().click();
  await expect(page.locator(`#rl-rate-${idx} .fleet-ready.warn`)).toContainText(u(4));
  // Not enforced at booking: the hold goes through.
  const due = await page.evaluate(() => App._storeDay(new Date(Date.now() + 2 * 86400000)));
  await mock('/__mock/units', { units: [{ unitNumber: u(1), sku, status: 'needs_service' }, { unitNumber: u(2), sku, status: 'needs_service' }, { unitNumber: u(3), sku, status: 'needs_service' }] });
  const items = [{ product_id: (await page.evaluate(i => document.getElementById(`rl-prod-${i}`).value, idx)), quantity: 1 }];
  expect(await attempt(page, 'POST', '/rentals/agreements', { customer_id: customer.id, branch_id: branch.id, due_date: due, items })).toBe('accepted');
});
