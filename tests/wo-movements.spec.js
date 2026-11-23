import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// A work order item's trip: store → Warehouse → service center, and back once
// the job is finished. Each arrival is a checkpoint with photos and every
// accessory marked OK / damaged / missing. Assessment waits for the Service Center.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Receive through the multipart endpoint from the page; returns the response body or the error text
const receive = (page, id, { itemPhotos = 1, accessories = [], accPhotos = {}, at } = {}) => page.evaluate(async ([id, itemPhotos, accessories, accPhotos, at, png]) => {
  const blob = () => new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' });
  const fd = new FormData();
  for (let i = 0; i < itemPhotos; i++) fd.append('item_photos', blob(), `item${i}.png`);
  for (const [accId, n] of Object.entries(accPhotos)) for (let i = 0; i < n; i++) fd.append(`acc_photo_${accId}`, blob(), `acc${i}.png`);
  fd.append('accessories', JSON.stringify(accessories));
  if (at) fd.append('at', at);
  const r = await fetch(`/api/work-orders/${id}/movements/receive`, { method: 'POST', body: fd });
  const body = await r.json();
  return r.ok ? body : body.error;
}, [id, itemPhotos, accessories, accPhotos, at, PNG]);

test('item trip with Warehouse checkpoint, assessment gate and return', async ({ page }) => {
  const s = `${Date.now()}`;
  const branches = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const store = branches.find(b => !b.is_warehouse);
  const fee = await api(page, 'POST', '/products', { name: `Assess M ${s}`, sku: `AM${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Trip', last_name: `Owner${s}`, phone: `873${s.slice(-7)}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: store.id, description: `Laptop no power ${s}`, item_label: 'Laptop',
    assessment_fee_product_id: fee.id, accessories: [{ name: 'Charger', description: 'Black 65W' }, { name: 'Bag', description: 'Grey sleeve' }] });
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  let w = await api(page, 'GET', `/work-orders/${wo.id}`);
  const [charger, bag] = w.accessories;
  expect(w.movement).toMatchObject({ location: 'store', next: { kind: 'send', from: 'store', to: 'warehouse' }, assessment_blocked: true });

  // Paid, but not assessable until the Warehouse has it.
  await api(page, 'PATCH', `/work-orders/${wo.id}/assessment-paid`, { payment_method: 'cash', employee_id: 1, branch_id: store.id });
  expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/estimate`, { estimate_labor: 100 })).toContain('not been received at the Service Center');

  // Can't receive before it's sent; a send needs who's carrying it.
  expect(await receive(page, wo.id)).toContain('has to be sent first');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/movements/send`, {})).toContain('driver');
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/movements/send`, { to: 'service_center', carried_by: 'Dan' })).toContain('goes to the Warehouse');
  w = await api(page, 'POST', `/work-orders/${wo.id}/movements/send`, { to: 'warehouse', carried_by: 'Dan the driver' });
  expect(w.movement.in_transit).toMatchObject({ from: 'store', to: 'warehouse' });
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/movements/send`, { carried_by: 'x' })).toContain('receive it there first');

  // Checkpoint validation: photo of the item, every accessory checked, a note when not OK.
  expect(await receive(page, wo.id, { itemPhotos: 0 })).toContain('at least one photo');
  expect(await receive(page, wo.id, { accessories: [{ accessory_id: charger.id, condition: 'ok' }] })).toContain('A2');
  expect(await receive(page, wo.id, { accessories: [{ accessory_id: charger.id, condition: 'ok' }, { accessory_id: bag.id, condition: 'damaged' }] })).toContain('add a note');

  // Received at the Warehouse through the screen.
  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(() => App.filterWorkOrders('movements'));
  await page.selectOption('#wo-move-at', 'warehouse');
  const row = page.locator('#wo-content tr', { hasText: `Laptop` }).filter({ hasText: wo.wo_number });
  await expect(row).toContainText('On the way to Warehouse');
  await row.getByRole('button', { name: /Receive at Warehouse/ }).click();
  await expect(page.locator('.modal')).toContainText('Accessories — check each one');
  const file = { name: 'arrived.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') };
  await page.setInputFiles('#wo-rcv-item-photos', file);
  await page.selectOption(`#wo-rcv-cond-${charger.id}`, 'ok');
  await page.selectOption(`#wo-rcv-cond-${bag.id}`, 'damaged');
  await page.fill(`#wo-rcv-note-${bag.id}`, 'Zip torn');
  await page.setInputFiles(`#wo-rcv-photo-${bag.id}`, file);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('.modal')).toHaveCount(0);

  w = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(w.movement).toMatchObject({ location: 'warehouse', warehouse_received: true, service_center_received: false, assessment_blocked: true, next: { kind: 'send', to: 'service_center' } });
  const rcv = w.movements.find(m => m.kind === 'receive');
  expect(rcv.photos.length).toBe(1);
  expect(rcv.accessories.map(c => [c.line_no, c.condition, c.note])).toEqual([[1, 'ok', null], [2, 'damaged', 'Zip torn']]);
  expect(rcv.accessories[1].photos.length).toBe(1);
  expect(w.photos.length).toBe(0); // checkpoint photos aren't intake photos
  expect(w.status_log.some(l => /Item received at Warehouse — 1 photo\(s\), 1\/2 accessories OK; A2 Bag damaged: Zip torn/.test(l.comment || ''))).toBe(true);
  expect(await attempt(page, 'DELETE', `/work-orders/${wo.id}/photos/${rcv.photos[0].id}`)).toContain('Checkpoint photos stay');

  // Still not assessable at the Warehouse; up to the service center, then it can be.
  expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/estimate`, { estimate_labor: 100 })).toContain('not been received at the Service Center');
  await api(page, 'POST', `/work-orders/${wo.id}/movements/send`, { carried_by: 'Van 2' });
  const ok2 = [{ accessory_id: charger.id, condition: 'ok' }, { accessory_id: bag.id, condition: 'damaged', note: 'Zip torn, as at Warehouse' }];
  w = await receive(page, wo.id, { accessories: ok2, at: 'service_center' });
  expect(w.movement).toMatchObject({ location: 'service_center', service_center_received: true, assessment_blocked: false, next: null });
  await api(page, 'PATCH', `/work-orders/${wo.id}/estimate`, { estimate_labor: 100, deposit_amount: 0 });

  // Finished: back down to the Warehouse, then the store.
  await db.execute({ sql: "UPDATE work_orders SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?", args: [wo.id] });
  w = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(w.movement.next).toMatchObject({ kind: 'send', from: 'service_center', to: 'warehouse' });
  // Pickup needs the item back at the store.
  expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/cashier-hold`, {})).toContain('is at the Service Center, not back at');
  await api(page, 'POST', `/work-orders/${wo.id}/movements/send`, { carried_by: 'Van 2' });
  await receive(page, wo.id, { accessories: ok2 });
  w = await api(page, 'POST', `/work-orders/${wo.id}/movements/send`, { carried_by: 'Dan' });
  expect(w.movement.in_transit).toMatchObject({ from: 'warehouse', to: 'store' });
  expect((await api(page, 'GET', '/work-orders?view=movements&at=store')).map(r => r.id)).toContain(wo.id);
  expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/cashier-hold`, {})).toContain('on its way to the');
  // Placed on hold some other way (e.g. before this rule) — final payment still refused
  await db.execute({ sql: "UPDATE work_orders SET status = 'awaiting_pickup', cashier_hold_at = CURRENT_TIMESTAMP WHERE id = ?", args: [wo.id] });
  expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/final-payment`, { payment_method: 'cash' })).toContain('not back at');
  await db.execute({ sql: 'UPDATE work_orders SET cashier_hold_at = NULL WHERE id = ?', args: [wo.id] });
  w = await receive(page, wo.id, { accessories: ok2 });
  expect(w.movement).toMatchObject({ location: 'store', at_home: true, next: null });
  expect(w.movements.length).toBe(8);
  expect((await api(page, 'GET', '/work-orders?view=movements')).map(r => r.id)).not.toContain(wo.id);
  await api(page, 'PATCH', `/work-orders/${wo.id}/cashier-hold`, {});
  await api(page, 'PATCH', `/work-orders/${wo.id}/final-payment`, { payment_method: 'cash', accessories_returned: [charger.id], accessories_note: 'Bag kept by customer earlier' });
  expect((await api(page, 'GET', `/work-orders/${wo.id}`)).status).toBe('picked_up');

  // Not worth fixing at the Warehouse: can't be handed back until it's at the store.
  const nwf = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: store.id, description: `Dead radio ${s}`, item_label: 'Radio', assessment_fee_product_id: fee.id });
  await api(page, 'POST', `/work-orders/${nwf.id}/movements/send`, { carried_by: 'Dan' });
  await receive(page, nwf.id);
  await db.execute({ sql: "UPDATE work_orders SET status = 'not_worth_fixing' WHERE id = ?", args: [nwf.id] });
  expect(await attempt(page, 'PATCH', `/work-orders/${nwf.id}/return-to-customer`, {})).toContain('is at the Warehouse, not back at');
  await page.evaluate(id => App.viewWorkOrder(id), nwf.id);
  await expect(page.locator('.modal')).toContainText('Return to Customer — item not back yet');
  await page.evaluate(() => App.closeModal());
  await api(page, 'POST', `/work-orders/${nwf.id}/movements/send`, { carried_by: 'Dan' });
  await receive(page, nwf.id);
  expect(await attempt(page, 'PATCH', `/work-orders/${nwf.id}/return-to-customer`, {})).toBe('accepted');
});

test('a work order taken in at the Warehouse starts there; older work orders are not held back', async ({ page }) => {
  const s = `${Date.now()}`;
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  const wh = await api(page, 'POST', '/branches', { name: `Move WH ${s}`, is_warehouse: 1 });
  await db.execute({ sql: 'UPDATE branches SET is_warehouse = 1 WHERE id = ?', args: [wh.id] });
  const fee = await api(page, 'POST', '/products', { name: `Assess W ${s}`, sku: `AW${s}`, price: 500, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Ware', last_name: `House${s}`, phone: `874${s.slice(-7)}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: wh.id, description: 'Drill', item_label: 'Drill', assessment_fee_product_id: fee.id });
  let w = await api(page, 'GET', `/work-orders/${wo.id}`);
  expect(w.movement).toMatchObject({ home: 'warehouse', location: 'warehouse', warehouse_received: true, assessment_blocked: true, next: { kind: 'send', to: 'service_center' } });

  // Finished at the service center: comes back to the Warehouse and stops there.
  await api(page, 'POST', `/work-orders/${wo.id}/movements/send`, { carried_by: 'Van' });
  await receive(page, wo.id);
  await db.execute({ sql: "UPDATE work_orders SET status = 'awaiting_pickup' WHERE id = ?", args: [wo.id] });
  await api(page, 'POST', `/work-orders/${wo.id}/movements/send`, { carried_by: 'Van' });
  w = await receive(page, wo.id);
  expect(w.movement).toMatchObject({ location: 'warehouse', at_home: true, next: null });

  // A work order opened before tracking isn't blocked from assessment.
  const old = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: (await api(page, 'GET', '/branches')).find(b => !b.is_warehouse && b.active !== 0).id, description: 'Old', item_label: 'Old', assessment_fee_product_id: fee.id });
  await db.execute({ sql: "UPDATE work_orders SET movement_tracked = 0, status = 'assessed' WHERE id = ?", args: [old.id] });
  expect((await api(page, 'GET', `/work-orders/${old.id}`)).movement.assessment_blocked).toBe(false);
  expect(await attempt(page, 'PATCH', `/work-orders/${old.id}/estimate`, { estimate_labor: 50, deposit_amount: 0 })).toBe('accepted');
});
