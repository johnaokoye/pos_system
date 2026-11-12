import { test, expect } from './fixtures.js';
import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';

// Consignment Phase 4: approving a month makes the settlement statement; A/P
// enters the supplier's invoice against it and every difference goes to
// Finance (correct the settlement, or approve it to Consignment Variance —
// never automatically); input GCT needs a valid tax invoice (F6); accepting
// raises the A/P bill, paid through a payment request; supplier credit notes
// reduce a bill or stay on account; the obligation is accrued per sale for
// RetailPOS Books (F1) and the month can't be reopened while it's billed.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const testDb = () => createClient({ url: `file:${path.join(os.tmpdir(), 'pos-playwright', 'test.db')}` });

async function login(page, username, password = 'pw-123456') {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('settlement → invoice matching with Finance → A/P bill → payment request; credit notes; Books accruals', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
  const groups = await api(page, 'GET', '/security-groups');
  const fin = `st${s}`, pin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Settle', last_name: 'Finance', username: fin, pin: String(Number(pin) + 3).slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  await api(page, 'POST', '/employees', { first_name: 'Ret', last_name: 'Mgr', username: `sm${s}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Manager').id, active: 1 });

  // Two items from one supplier; Total Tools bears shortages.
  const mk = (n, cost) => api(page, 'POST', '/products', { name: `Settle ${n} ${s}`, sku: `${n.toUpperCase()}${s}`, price: 300, cost, tax_rate: 15, stock_qty: 0, active: 1 });
  const a = await mk('Saw', 90), b = await mk('Bit', 40);
  const sup = await api(page, 'POST', '/suppliers', { name: `Settle Supplier ${s}`, payment_terms: 'Net 30' });
  const agr = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2025-01-01', ownership_terms: "Supplier's until sold", shortage_responsibility: 'total_tools', items: [{ product_id: a.id, cost: 100 }, { product_id: b.id, cost: 50 }], submit: true });
  await login(page, fin);
  await api(page, 'POST', `/consignment/agreements/${agr.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const o = await api(page, 'POST', '/consignment/orders', { agreement_id: agr.id, branch_id: main.id, items: [{ product_id: a.id, quantity: 10 }, { product_id: b.id, quantity: 5 }] });
  const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN${s}`, items: o.items.map(i => ({ order_item_id: i.id, quantity: i.quantity_ordered ?? i.quantity })) });
  await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});

  // Sold 4 saws (1 returned) and 2 bits.
  const sale = await api(page, 'POST', '/transactions', { items: [{ product_id: a.id, quantity: 4 }, { product_id: b.id, quantity: 2 }], branch_id: main.id, employee_id: 1, payment_method: 'cash', amount_tendered: 5000 });
  const saleItems = (await api(page, 'GET', `/transactions/${sale.id}`)).items;
  await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: saleItems.find(i => i.product_id === a.id).id, quantity: 1 }], resolution: 'refund', refund_method: 'card', notes: 'Unwanted', override_pin: pin });

  // The supplier's cost is accrued per sale for Books (F1), the return reverses it.
  let postings = (await api(page, 'GET', '/consignment/postings')).postings.filter(p => p.agreement_id === agr.id);
  expect(postings.filter(p => p.source_type === 'sale').map(p => [p.debit_role, p.credit_role, p.amount]).sort()).toEqual([['cost_of_sales', 'obligation', 100], ['cost_of_sales', 'obligation', 400]]);
  expect(postings.find(p => p.source_type === 'return')).toMatchObject({ debit_role: 'obligation', credit_role: 'cost_of_sales', amount: 100 });

  // Into last month; count (one saw short — chargeable, Finance approves it) and approve.
  const thisMonth = await page.evaluate(() => App._storeDay(new Date()).slice(0, 7));
  const [y, mo] = thisMonth.split('-').map(Number);
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const db = testDb();
  await db.execute('PRAGMA busy_timeout = 10000');
  const lots = `SELECT id FROM stock_lots WHERE agreement_id = ${agr.id}`;
  await db.execute(`UPDATE stock_lot_moves SET created_at = '${prev}-15 15:00:00' WHERE lot_id IN (${lots})`);
  await db.execute(`UPDATE sale_lot_allocations SET qualified_on = '${prev}-15' WHERE agreement_id = ${agr.id}`);
  await db.execute(`UPDATE stock_lot_returns SET created_at = '${prev}-15 15:00:00' WHERE allocation_id IN (SELECT id FROM sale_lot_allocations WHERE agreement_id = ${agr.id})`);
  db.close();
  let rec = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: prev });
  const lineOf = (r, pid) => r.lines.find(l => l.line_type === 'stock' && l.product_id === pid);
  rec = await api(page, 'PATCH', `/consignment/reconciliations/${rec.id}/lines/${lineOf(rec, a.id).id}`, { physical_count: 6 });
  rec = await api(page, 'PATCH', `/consignment/reconciliations/${rec.id}/lines/${lineOf(rec, b.id).id}`, { physical_count: 3 });
  rec = await api(page, 'PATCH', `/consignment/reconciliations/${rec.id}/lines/${lineOf(rec, a.id).id}`, { approved_shortage_qty: 1 });
  rec = await api(page, 'POST', `/consignment/reconciliations/${rec.id}/approve`, { signature: SIG });
  expect(rec.settlement).toBeTruthy();

  // The settlement: saws 4 sold − 1 returned + 1 chargeable = 4 × 100; bits 2 × 50; GCT 15% expected.
  let st = await api(page, 'GET', `/consignment/settlements/${rec.settlement.id}`);
  expect(st).toMatchObject({ status: 'open', subtotal: 500, expected_tax: 75, total: 575, supplier_id: sup.id, period: prev });
  expect(st.lines.find(l => l.product_id === a.id)).toMatchObject({ sales_qty: 4, returns_qty: 1, chargeable_qty: 1, chargeable_value: 100, billable_qty: 4, billable_value: 400, expected_tax: 60 });
  postings = (await api(page, 'GET', '/consignment/postings')).postings.filter(p => p.agreement_id === agr.id);
  expect(postings.find(p => p.source_type === 'recon_chargeable')).toMatchObject({ debit_role: 'chargeable', credit_role: 'obligation', amount: 100 });

  // A/P enters the invoice: saws at 110 (cost difference), only 1 bit (quantity difference); no tax invoice ticked.
  st = await api(page, 'POST', `/consignment/settlements/${st.id}/invoice`, { supplier_invoice_number: `SI-${s}`, invoice_date: `${prev}-28`,
    lines: [{ product_id: a.id, qty: 4, unit_cost: 110, tax_amount: 66 }, { product_id: b.id, qty: 1, unit_cost: 50, tax_amount: 7.5 }] });
  expect(st.status).toBe('in_review');
  const saw = st.invoice.lines.find(l => l.product_id === a.id), bit = st.invoice.lines.find(l => l.product_id === b.id);
  expect(saw).toMatchObject({ flagged: 1, qty_diff: 0, cost_diff: 10, value_diff: 40, tax_diff: 6 });
  expect(bit).toMatchObject({ flagged: 1, qty_diff: -1, value_diff: -50 });
  expect(await attempt(page, 'POST', `/consignment/settlements/${st.id}/invoice/accept`, {})).toContain('Finance');

  // Finance: the price is approved to variance; the bit count was wrong in the settlement.
  await login(page, fin);
  expect(await attempt(page, 'POST', `/consignment/settlements/${st.id}/invoice/lines/${saw.id}/resolve`, { resolution: 'variance' })).toContain('reason');
  await api(page, 'POST', `/consignment/settlements/${st.id}/invoice/lines/${saw.id}/resolve`, { resolution: 'variance', reason: 'Agreed price rise not yet on the agreement' });
  st = await api(page, 'POST', `/consignment/settlements/${st.id}/invoice/lines/${bit.id}/resolve`, { resolution: 'corrected', reason: 'One bit was a demo unit, not billable' });
  expect(st).toMatchObject({ status: 'matched', subtotal: 450, expected_tax: 67.5 });
  expect(st.invoice).toMatchObject({ status: 'matched', variance_amount: 40, subtotal: 490, tax_amount: 73.5, total: 563.5 });
  expect(st.lines.find(l => l.product_id === b.id)).toMatchObject({ billable_qty: 1, billable_value: 50, original_qty: 2, original_value: 100 });

  // GCT can't be taken without a valid tax invoice (F6): rejected, entered again properly.
  await login(page, 'admin', '123456');
  expect(await attempt(page, 'POST', `/consignment/settlements/${st.id}/invoice/accept`, {})).toContain('tax invoice');
  await api(page, 'POST', `/consignment/settlements/${st.id}/invoice/reject`, { reason: 'No TRN on it — supplier resending' });
  st = await api(page, 'POST', `/consignment/settlements/${st.id}/invoice`, { supplier_invoice_number: `SI-${s}`, invoice_date: `${prev}-28`, supplier_trn: '000-111-222', tax_invoice: true,
    lines: [{ product_id: a.id, qty: 4, unit_cost: 110, tax_amount: 66 }, { product_id: b.id, qty: 1, unit_cost: 50, tax_amount: 7.5 }] });
  expect(st.status).toBe('in_review'); // the saw price still differs from the settlement
  await login(page, fin);
  await api(page, 'POST', `/consignment/settlements/${st.id}/invoice/lines/${st.invoice.lines.find(l => l.product_id === a.id).id}/resolve`, { resolution: 'variance', reason: 'Agreed price rise' });
  await login(page, 'admin', '123456');
  st = await api(page, 'POST', `/consignment/settlements/${st.id}/invoice/accept`, {});
  expect(st.status).toBe('billed');
  let bill = await api(page, 'GET', `/payables/bills/${st.bill_id}`);
  expect(bill).toMatchObject({ source: 'consignment_settlement', amount: 563.5, tax_amount: 73.5, obligation_amount: 450, variance_amount: 40, vendor_invoice_number: `SI-${s}`, supplier_id: sup.id });
  expect(await attempt(page, 'PUT', `/payables/bills/${bill.id}`, { ...bill, amount: 600 })).toContain('matched consignment settlement');

  // The month can't be reopened while it's on a live bill.
  expect(await attempt(page, 'POST', `/consignment/reconciliations/${rec.id}/reopen`, { reason: 'x', finance_approver: 'y', approval_reference: 'z' })).toContain('void that bill');

  // Supplier credit notes: 13.50 against the bill, 20 left on account.
  const cn1 = await api(page, 'POST', '/payables/credit-notes', { supplier_id: sup.id, reference: `CN1-${s}`, credit_date: `${prev}-29`, amount: 13.5, tax_amount: 1.76, credit_account: 'consignment', consignment_settlement_id: st.id, notes: 'Short-dated stock allowance', allocations: [{ bill_id: bill.id, amount: 13.5 }] });
  expect(cn1).toMatchObject({ method: 'credit_note', posting_mode: 'credit_note', unapplied: 0 });
  const cn2 = await api(page, 'POST', '/payables/credit-notes', { supplier_id: sup.id, reference: `CN2-${s}`, credit_date: `${prev}-29`, amount: 20, tax_amount: 0, notes: 'Rebate' });
  expect(cn2.unapplied).toBe(20);
  expect(await attempt(page, 'POST', '/payables/credit-notes', { supplier_id: sup.id, reference: `CN2-${s}`, credit_date: `${prev}-29`, amount: 5, notes: 'Again' })).toContain('already entered');
  bill = await api(page, 'GET', `/payables/bills/${bill.id}`);
  expect(bill.balance).toBe(550);
  const feed = await api(page, 'GET', '/payables/payments-feed');
  expect(feed.find(p => p.id === cn1.id)).toMatchObject({ posting_mode: 'credit_note', credit_account: 'consignment', tax_amount: 1.76, settlement_number: st.settlement_number });

  // Paid through a payment request, approved by someone else.
  const req = await api(page, 'POST', '/payables/payment-requests', { supplier_id: sup.id, request_type: 'invoice', required_date: `${thisMonth}-28`, submit: true, lines: [{ bill_id: bill.id, amount: 550 }] });
  await login(page, fin);
  await api(page, 'POST', `/payables/payment-requests/${req.id}/approve`, { scheduled_date: `${thisMonth}-28`, signature: SIG });
  await login(page, 'admin', '123456');
  await api(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: `${thisMonth}-01`, method: 'cash' });
  expect((await api(page, 'GET', `/payables/bills/${bill.id}`)).balance).toBe(0);

  // The screen.
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(id => App.viewConsSettlement(id), st.id);
  for (const t of ['Approved to Consignment Variance', 'Corrected by Settle Finance', bill.bill_number, `CN1-${s}`]) await expect(page.locator('.modal')).toContainText(t);
  await page.evaluate(() => App.closeModal());

  // Books acknowledges entries: posted once (a second, different ref is refused); 'waiting' until its accounts are set.
  const key = (await api(page, 'POST', '/api-keys', { name: `Books cons ${s}`, scopes: ['consignment:read', 'consignment:write'] })).key;
  const feedRes = await page.request.get('/api/consignment/postings-feed', { headers: { 'X-API-Key': key } });
  expect(feedRes.ok()).toBeTruthy();
  const mine = (await feedRes.json()).filter(p => p.agreement_number === agr.agreement_number);
  expect(mine.length).toBe(4);
  const ack = data => page.request.post('/api/consignment/postings-ack', { headers: { 'X-API-Key': key }, data });
  expect((await ack({ id: mine[0].id, status: 'waiting', error: 'Set the consignment accounts in Settings' })).ok()).toBeTruthy();
  expect((await ack({ id: mine[0].id, status: 'posted', external_ref: 'JE-1' })).ok()).toBeTruthy();
  expect((await ack({ id: mine[0].id, status: 'posted', external_ref: 'JE-2' })).status()).toBe(409);
  expect((await page.request.get('/api/consignment/postings', { headers: { 'X-API-Key': key } })).status()).toBe(403);
});
