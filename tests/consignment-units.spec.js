import { test, expect } from './fixtures.js';
import { approveConsOrder } from './consignment-order-approval.js';

// Consignment agreements and orders carry a unit of measure: the agreed cost
// is entered per the agreement line's unit (e.g. a case of 12) and kept per
// stock unit; an order line is in a unit (the agreement's by default) and is
// received in it, while stock goes on hand in stock units.
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

test('agreement cost per case, order in cases or singles, received in the order unit', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const approver = `cu${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Unit', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const caseUnit = await api(page, 'POST', '/units', { name: `Case${s}`, abbreviation: 'cs' });
  const item = await api(page, 'POST', '/products', { name: `Flatware ${s}`, sku: `FW${s}`, price: 1500, cost: 800, tax_rate: 0, stock_qty: 0, active: 1, units: [{ unit_id: caseUnit.id, factor: 12, price: 16000 }] });
  const sup = await api(page, 'POST', '/suppliers', { name: `Units Supplier ${s}` });

  // Through the form: the item, Case of 12, 9,950 per case.
  await page.evaluate(() => App.showConsAgreementForm());
  await page.locator('#ca-supplier').evaluate((el, id) => { el.value = String(id); el.dispatchEvent(new Event('change')); }, sup.id);
  await page.fill('#ca-ownership', "Supplier's until sold");
  await page.locator('.ca-prod').first().evaluate((el, id) => { el.value = String(id); el.dispatchEvent(new Event('change')); }, item.id);
  await expect(page.locator('.ca-unit').first().locator('option')).toHaveCount(2);
  await page.locator('.ca-unit').first().selectOption(String(caseUnit.id));
  await page.locator('.ca-cost').first().fill('9950');
  await page.getByRole('button', { name: 'Submit to Finance' }).click();
  await expect.poll(async () => (await api(page, 'GET', `/consignment/agreements?supplier_id=${sup.id}`)).length).toBe(1);
  const agr = (await api(page, 'GET', `/consignment/agreements?supplier_id=${sup.id}`))[0];
  let full = await api(page, 'GET', `/consignment/agreements/${agr.id}`);
  expect(full.items[0]).toMatchObject({ uom_id: caseUnit.id, units_per: 12, unit_label: `Case${s} of 12`, current_unit_cost: 9950 });
  expect(full.items[0].current_cost).toBeCloseTo(9950 / 12, 4);

  await login(page, approver);
  await api(page, 'POST', `/consignment/agreements/${agr.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');

  // Ordered in cases by default (2 cases = 24 singles); singles when chosen.
  const o = await approveConsOrder(page, await api(page, 'POST', '/consignment/orders', { agreement_id: agr.id, branch_id: main.id, items: [{ product_id: item.id, quantity: 2 }] }));
  expect(o.items[0]).toMatchObject({ purchase_unit: `Case${s}`, units_per: 12, order_qty: 2, quantity_ordered: 24, ordered_units: 2, left_units: 2 });
  const o2 = await approveConsOrder(page, await api(page, 'POST', '/consignment/orders', { agreement_id: agr.id, branch_id: main.id, items: [{ product_id: item.id, quantity: 5, uom_id: null }] }));
  expect(o2.items[0]).toMatchObject({ units_per: 1, quantity_ordered: 5 });

  // Received in cases: 1 case = 12 on hand.
  const before = (await api(page, 'GET', `/products/${item.id}`)).stock_qty;
  const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN${s}`, items: [{ order_item_id: o.items[0].id, unit_quantity: 1 }] });
  expect(g.items[0]).toMatchObject({ quantity: 12, unit_quantity: 1, unit_label: `Case${s} of 12` });
  await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});
  expect((await api(page, 'GET', `/products/${item.id}`)).stock_qty).toBe(before + 12);
  expect((await api(page, 'GET', `/consignment/orders/${o.id}`)).items[0]).toMatchObject({ received_units: 1, left_units: 1 });

  // A new cost is entered per case too.
  full = await api(page, 'POST', `/consignment/agreements/${agr.id}/costs`, { product_id: item.id, cost: 12000, effective_from: '2999-01-01' });
  expect(full.items[0].costs[0]).toMatchObject({ unit_cost: 12000 });
  expect(full.items[0].costs[0].cost).toBeCloseTo(1000, 4);

  // The screens show the unit.
  await page.evaluate(id => App.viewConsOrder(id), o.id);
  await expect(page.locator('.modal')).toContainText(`Case${s} of 12`);
});
