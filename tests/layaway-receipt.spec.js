import { test, expect } from './fixtures.js';

// A layaway deposit or payment is posted as one money line ("Layaway Deposit
// — 1 item(s)"); its receipt lists the items on the plan and the balance
// after that payment.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('a layaway deposit and payment receipt show the items on layaway and the balance', async ({ page }) => {
  const s = `${Date.now()}`;
  const home = await page.evaluate(() => App._homeBranch());
  const branch = home || (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const item = await api(page, 'POST', '/products', { sku: `LAYR-${s}`, name: `Layaway Sofa ${s}`, price: 1000, tax_rate: 0, branch_id: branch.id, stock_qty: 3, is_layaway_eligible: 1 });
  const customer = await api(page, 'POST', '/customers', { first_name: 'Lay', last_name: `Away ${s}`, customer_type: 'cash', force: true });
  const plan = await api(page, 'POST', '/layaway/plans', { customer_id: customer.id, branch_id: branch.id, items: [{ product_id: item.id, quantity: 2 }], payment_method: 'cash', amount_tendered: 500, payment_frequency: 'monthly' });

  const deposit = await api(page, 'GET', `/transactions/${plan.deposit_transaction_id}`);
  expect(deposit.layaway.plan_number).toBe(plan.plan_number);
  expect(deposit.layaway.kind).toBe('deposit');
  expect(deposit.layaway.items[0].product_name).toContain(`Layaway Sofa ${s}`);
  expect(deposit.layaway.items[0].quantity).toBe(2);
  expect(deposit.layaway.paid_to_date).toBe(500);
  expect(deposit.layaway.balance).toBe(plan.total - 500);

  const paid = await api(page, 'PATCH', `/layaway/plans/${plan.id}/payments`, { amount: 300, payment_method: 'cash' });
  const payTx = await api(page, 'GET', `/transactions/${paid.payments.find(p => !p.is_deposit).transaction_id}`);
  expect(payTx.layaway.kind).toBe('payment');
  expect(payTx.layaway.paid_to_date).toBe(800);
  // A reprint of the deposit still shows the balance as it was then.
  expect((await api(page, 'GET', `/transactions/${plan.deposit_transaction_id}`)).layaway.paid_to_date).toBe(500);

  // The plan's payment history opens the receipt with the items on it.
  await page.evaluate(() => App.showSection('layaway'));
  await page.evaluate(id => App.viewLayawayPlan(id), plan.id);
  await page.locator('.modal-body button:has-text("Receipt")').first().click();
  const receipt = page.locator('.receipt');
  await expect(receipt).toContainText(`ITEMS ON LAYAWAY ${plan.plan_number}`);
  await expect(receipt).toContainText(`Layaway Sofa ${s}`);
  await expect(receipt).toContainText('Balance Remaining');
});
