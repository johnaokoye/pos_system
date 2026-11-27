import { test, expect } from './fixtures.js';

// Substitutes on a consignment delivery (like PO receiving): another item sent
// in place of part of an order line becomes its own order line; rejecting the
// GRN puts it back; one not on the agreement joins it at the original's agreed
// cost when the GRN is approved, and comes in as the supplier's stock.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
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

test('consignment GRN substitutes: own order line, folded back on reject, added to the agreement on approval', async ({ page }) => {
  const s = `${Date.now()}`;
  const groups = await api(page, 'GET', '/security-groups');
  const finance = `csub${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Csub', last_name: 'Finance', username: finance, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });

  const sup = await api(page, 'POST', '/suppliers', { name: `Sub Supplier ${s}` });
  const mk = (n, code) => api(page, 'POST', '/products', { name: `${n} Paint ${s}`, sku: `${code}${s}`, price: 200, cost: 80, tax_rate: 0, stock_qty: 0, active: 1 });
  const white = await mk('White', 'SW');
  const cream = await mk('Cream', 'SC');   // on the agreement
  const grey = await mk('Grey', 'SG');     // not on it
  const a = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2026-01-01', ownership_terms: "Supplier's until sold", items: [{ product_id: white.id, cost: 100 }, { product_id: cream.id, cost: 90 }], submit: true });
  await login(page, finance);
  await api(page, 'POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');

  const order = await api(page, 'POST', '/consignment/orders', { agreement_id: a.id, branch_id: 1, items: [{ product_id: white.id, quantity: 10 }] });
  const line = order.items[0].id;
  const grn = (items, substitutes, dn) => api(page, 'POST', `/consignment/orders/${order.id}/grns`, { delivery_note_number: dn, items, substitutes });

  // Received + substitutes can't be more than is left.
  expect(await attempt(page, 'POST', `/consignment/orders/${order.id}/grns`, { delivery_note_number: 'X', items: [{ order_item_id: line, unit_quantity: 9 }], substitutes: [{ order_item_id: line, product_id: cream.id, unit_quantity: 2 }] })).toMatch(/Only 10/);
  expect(await attempt(page, 'POST', `/consignment/orders/${order.id}/grns`, { delivery_note_number: 'X', items: [], substitutes: [{ order_item_id: line, product_id: white.id, unit_quantity: 1 }] })).toMatch(/the item ordered/);

  // 4 white + 2 cream instead: the cream becomes its own line, taken off the white.
  const g1 = await grn([{ order_item_id: line, unit_quantity: 4 }], [{ order_item_id: line, product_id: cream.id, unit_quantity: 2 }], `DN1-${s}`);
  let o = await api(page, 'GET', `/consignment/orders/${order.id}`);
  expect(o.items.map(i => [i.product_id, i.quantity_ordered, i.substituted_units, i.substitute_for_name || null])).toEqual([[white.id, 8, 2, null], [cream.id, 2, 0, white.name]]);
  expect(g1.items.find(i => i.product_id === cream.id)).toMatchObject({ substitute_for_name: white.name, new_to_agreement: 0 });

  // Rejected: the cream goes back onto the white line.
  await api(page, 'POST', `/consignment/grns/${g1.id}/reject`, { reason: 'wrong delivery note' });
  o = await api(page, 'GET', `/consignment/orders/${order.id}`);
  expect(o.items.map(i => [i.product_id, i.quantity_ordered, i.substituted_units])).toEqual([[white.id, 10, 0]]);

  // Through the screen: 3 white + 2 grey (not on the agreement) instead.
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(id => App.viewConsOrder(id), order.id);
  await page.locator(`.cg-qty[data-line="${line}"]`).fill('4');
  await page.click('button:has-text("+ Substitute")'); // moves one off the line, as on PO receiving
  await expect(page.locator(`.cg-qty[data-line="${line}"]`)).toHaveValue('3');
  await page.locator('.cg-sub input[type="search"]').fill(`SG${s}`);
  await expect(page.locator('.cg-sub')).toContainText(grey.name);
  await page.locator('.cg-sub-qty').fill('2');
  await page.fill('#cg-note', `DN2-${s}`);
  await page.getByRole('button', { name: 'Enter GRN' }).click();
  await expect(page.locator('.modal-title')).toContainText('Consignment GRN CGRN-');
  await expect(page.locator('.modal table')).toContainText(`sent instead of ${white.name}`);
  await expect(page.locator('.modal table')).toContainText(`Not on ${a.agreement_number}`);
  await page.getByRole('button', { name: 'Approve GRN' }).click();
  await expect(page.locator('.modal')).toContainText(`Added to ${a.agreement_number} by this GRN`);

  // Grey is now on the agreement at white's agreed cost, and is the supplier's stock.
  const ag = await api(page, 'GET', `/consignment/agreements/${a.id}`);
  expect(ag.items.find(i => i.product_id === grey.id)).toMatchObject({ current_cost: 100 });
  const stock = await api(page, 'GET', `/products?search=${s}&branch_id=1`);
  const by = id => stock.find(p => p.id === id);
  expect([by(white.id).consignment_qty, by(grey.id).consignment_qty, by(grey.id).stock_qty]).toEqual([3, 2, 2]);
  o = await api(page, 'GET', `/consignment/orders/${order.id}`);
  expect(o.items.map(i => [i.product_id, i.quantity_ordered, i.quantity_received])).toEqual([[white.id, 8, 3], [grey.id, 2, 2]]);
  expect(o.status).toBe('partial');

  // The order goes to the supplier: print copy, PDF and email.
  const doc = await page.evaluate(async id => { const r = await fetch(`/api/email/consignment-order-preview/${id}`); return { tag: r.headers.get('x-pos-document'), html: await r.text() }; }, order.id);
  expect(doc.tag).toBe('consignment-order');
  for (const t of ['CONSIGNMENT ORDER', order.order_number, a.agreement_number, `Sent instead of ${white.name}`, 'Still to come', `SW${s}`, 'not a purchase order']) expect(doc.html).toContain(t);
  expect(doc.html).toContain('1,000.00'); // 10 ordered: 8 white + 2 grey at 100
  const pdf = await page.evaluate(async id => { const r = await fetch(`/api/email/consignment-order-pdf/${id}`); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]; }, order.id);
  expect(pdf[0]).toBe(200); expect(pdf[1]).toBe('application/pdf'); expect(pdf[2]).toBeGreaterThan(1000);
  expect(await attempt(page, 'POST', `/email/send-consignment-order/${order.id}`, { to: 'not-an-email' })).toMatch(/valid email/);
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.viewConsOrder(id), order.id);
  await expect(page.locator('#con-pdf')).toHaveAttribute('href', `/api/email/consignment-order-pdf/${order.id}`);
  await page.click('#con-email');
  await expect(page.locator('#coe-subject')).toHaveValue(new RegExp(order.order_number));
});
