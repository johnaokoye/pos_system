import { test, expect } from './fixtures.js';

// Supplier-owned stock already on hand when consignment tracking starts: listed
// on the Start screen it becomes the supplier's, and only the rest becomes the
// Total Tools-owned opening receipt. Stock found later is moved over by an
// Administrator with a reason. Stock figures never change.
// Runs first of the consignment specs (alphabetical, one worker), so tracking
// hasn't started yet; on its own after them it checks only the later path.
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
const lots = async (page, productId, branchId) => (await api(page, 'GET', `/consignment/lots?product_id=${productId}&branch_id=${branchId}`)).map(l => [l.owner, l.qty_on_hand]).sort();

test('supplier-owned stock on hand at go-live, and found after it', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const fin = `op${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Open', last_name: 'Finance', username: fin, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const item = await api(page, 'POST', '/products', { name: `Left On Consignment ${s}`, sku: `LOC${s}`, price: 200, cost: 70, tax_rate: 0, stock_qty: 0, active: 1 });
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 10, reason: 'on the shelf', branch_id: main.id });
  const sup = await api(page, 'POST', '/suppliers', { name: `Opening Supplier ${s}` });
  const agr = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2025-01-01', ownership_terms: "Supplier's until sold", items: [{ product_id: item.id, cost: 90 }], submit: true });
  const draft = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2025-01-01', ownership_terms: 'x', items: [{ product_id: item.id, cost: 90 }] });
  await login(page, fin);
  await api(page, 'POST', `/consignment/agreements/${agr.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');

  if (!(await api(page, 'GET', '/consignment/status')).go_live) {
    // The Start screen lists it as a candidate, with what the branch holds.
    const cands = (await api(page, 'GET', '/consignment/opening-candidates')).rows;
    expect(cands.find(c => c.product_id === item.id && c.branch_id === main.id)).toMatchObject({ agreement_id: agr.id, available: 10 });
    const line = { agreement_id: agr.id, product_id: item.id, branch_id: main.id };
    expect(await attempt(page, 'POST', '/consignment/go-live', { confirm: 'START', opening: [{ ...line, qty: 11 }] })).toContain('has 10');
    expect(await attempt(page, 'POST', '/consignment/go-live', { confirm: 'START', opening: [{ ...line, agreement_id: draft.id, qty: 1 }] })).toContain("isn't approved");
    expect((await api(page, 'GET', '/consignment/status')).go_live).toBeFalsy(); // refused attempts start nothing
    const out = await api(page, 'POST', '/consignment/go-live', { confirm: 'START', opening: [{ ...line, qty: 4 }] });
    expect(out.supplier_owned).toBe(1);
    expect(await lots(page, item.id, main.id)).toEqual([['consignment', 4], ['owned', 6]]);

    // Sold oldest first: the opening receipts share a date, so Total Tools' sells first, then the supplier's.
    const sale = await api(page, 'POST', '/transactions', { items: [{ product_id: item.id, quantity: 7 }], branch_id: main.id, employee_id: 1, payment_method: 'cash', amount_tendered: 5000 });
    const alloc = await api(page, 'GET', `/consignment/allocations?transaction_id=${sale.id}`);
    expect(alloc.map(a => [a.owner, a.qty, a.owner === 'consignment' ? a.unit_cost : null]).sort()).toEqual([['consignment', 1, 90], ['owned', 6, null]]);
    expect(await lots(page, item.id, main.id)).toEqual([['consignment', 3]]);
  }

  // Found later: 2 more of the 3 owned units just received are the supplier's.
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 3, reason: 'found in back store', branch_id: main.id });
  const before = await lots(page, item.id, main.id);
  const ownedBefore = before.filter(([o]) => o === 'owned').reduce((t, [, q]) => t + q, 0);
  const consBefore = before.filter(([o]) => o === 'consignment').reduce((t, [, q]) => t + q, 0);
  const line = { agreement_id: agr.id, product_id: item.id, branch_id: main.id };
  expect(await attempt(page, 'POST', '/consignment/opening-stock', { ...line, qty: 2 })).toContain('reason');
  expect(await attempt(page, 'POST', '/consignment/opening-stock', { ...line, qty: ownedBefore + 1, note: 'too many' })).toContain(`has ${ownedBefore}`);
  await api(page, 'POST', '/consignment/opening-stock', { ...line, qty: 2, note: 'Delivery note shows these were left on consignment' });
  const after = await lots(page, item.id, main.id);
  expect(after.filter(([o]) => o === 'owned').reduce((t, [, q]) => t + q, 0)).toBe(ownedBefore - 2);
  expect(after.filter(([o]) => o === 'consignment').reduce((t, [, q]) => t + q, 0)).toBe(consBefore + 2);
  const prod = (await api(page, 'GET', `/products?branch_id=${main.id}`)).find(p => p.id === item.id);
  expect(prod.stock_qty).toBe(ownedBefore + consBefore); // the stock figure didn't move
  const log = (await api(page, 'GET', '/consignment/opening-stock')).filter(o => o.product_id === item.id);
  expect(log.find(o => o.mode === 'after_go_live')).toMatchObject({ qty: 2, note: 'Delivery note shows these were left on consignment' });

  // The month's reconciliation counts them as the supplier's receipts.
  const month = await page.evaluate(() => App._storeDay(new Date()).slice(0, 7));
  const rec = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: month });
  const l = rec.lines.find(x => x.line_type === 'stock' && x.product_id === item.id);
  expect(l.receipts).toBe(log.reduce((t, o) => t + o.qty, 0));

  // The screen.
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(() => App.renderConsignment('stock'));
  await page.getByRole('button', { name: 'Supplier stock found on hand' }).click();
  await expect(page.locator('.modal')).toContainText('Delivery note shows these were left on consignment');
  await page.evaluate(() => App.closeModal());
  await page.getByRole('button', { name: '+ Record supplier-owned stock' }).click();
  await expect(page.locator('.modal')).toContainText(`Left On Consignment ${s}`);
  await page.evaluate(() => App.closeModal());

  const check = await api(page, 'GET', '/consignment/lot-check');
  expect(check.mismatches.filter(m => m.product_id === item.id)).toEqual([]);
});
