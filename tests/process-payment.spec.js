import { test, expect } from './fixtures.js';

// Process Payment on an approved payment request: the bank account it was
// paid from (RetailPOS Books' list), the actual date, bank reference, all or
// part of what's left applied to the invoices, proof of payment, then the
// payment advice. A COD / advance payment with no invoice yet stays on the
// vendor's account until it's applied.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

async function login(page, username) {
  // Off the app first: an in-flight request (the payables poll) would
  // otherwise come back after the clear and renew the session cookie.
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', username === 'admin' ? '123456' : 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

// Signed in as admin: a second Administrator to approve (no one approves
// their own request), a vendor, and a bank account sent the way Books sends it.
async function setup(page) {
  const s = stamp();
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const approver = `appr${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Ap', last_name: 'Prover', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const supplier = await api(page, 'POST', '/suppliers', { name: `Pay Vendor ${s}`, email: `ap${s}@vendor.test`, sync_ap: 1 });
  const base = await page.evaluate(() => App._baseCurrency());
  const key = (await api(page, 'POST', '/api-keys', { name: `Books ${s}`, scopes: ['payables:read', 'payables:write'] })).key;
  const booksId = Number(s.slice(-7));
  const put = await page.request.put('/api/payables/bank-accounts', { headers: { 'X-API-Key': key }, data: [{ id: booksId, name: `Operating ${s}`, bank_name: 'NCB', last4: '4321', currency: base, gl_code: '1010', active: true }] });
  expect(put.ok()).toBeTruthy();
  const bank = (await api(page, 'GET', '/payables/payment-requests/bank-accounts')).find(b => b.books_id === booksId);
  expect(bank).toMatchObject({ currency: base, bank_name: 'NCB', last4: '4321' });
  return { s, approver, supplier, bank, key, booksId };
}

async function approve(page, approver, id) {
  await login(page, approver);
  await api(page, 'POST', `/payables/payment-requests/${id}/approve`, { scheduled_date: '2026-12-01', signature: SIG });
  await login(page, 'admin');
}

test('an invoice request is paid in part from a bank account, then in full, and the advice is ready', async ({ page }) => {
  const { s, approver, supplier, bank, key } = await setup(page);
  const bill1 = await api(page, 'POST', '/payables/bills', { supplier_id: supplier.id, vendor_invoice_number: `INV-A-${s}`, bill_date: '2026-11-01', amount: 1000, tax_amount: 0 });
  const bill2 = await api(page, 'POST', '/payables/bills', { supplier_id: supplier.id, vendor_invoice_number: `INV-B-${s}`, bill_date: '2026-11-02', amount: 500, tax_amount: 0 });
  const req = await api(page, 'POST', '/payables/payment-requests', { supplier_id: supplier.id, request_type: 'invoice', required_date: '2026-11-30', submit: true,
    lines: [{ bill_id: bill1.id, amount: 1000 }, { bill_id: bill2.id, amount: 500 }] });
  await approve(page, approver, req.id);

  // A bank account and a reference are required.
  expect(await attempt(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-20', method: 'bank_transfer', reference: 'X' })).toContain('bank account');
  expect(await attempt(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-20', method: 'cheque', bank_account_id: bank.id })).toContain('cheque number');

  // Through the screen: pay only the first invoice.
  await page.evaluate(() => App.showSection('payables'));
  await page.evaluate(id => App.viewPaymentRequest(id), req.id);
  await page.locator('.modal-footer').getByRole('button', { name: 'Process Payment' }).click();
  await page.selectOption('#prp-bank', String(bank.id));
  await page.fill('#prp-date', '2026-11-20');
  await page.selectOption('#prp-method', 'bank_transfer');
  await page.fill('#prp-ref', `TRX-${s}`);
  await page.locator(`.prp-alloc[data-line]`).nth(1).fill('0');
  await page.setInputFiles('#prp-files', { name: 'proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%proof\n') });
  await page.getByRole('button', { name: 'Review Payment' }).click();
  const review = page.locator('#prp-review');
  await expect(review).toContainText(bank.name);
  await expect(review).toContainText(`TRX-${s}`);
  await expect(review).toContainText(bill1.bill_number);
  await expect(review).toContainText('part payment');
  await page.getByRole('button', { name: 'Post Payment' }).click();
  await expect(page.locator('.modal-title')).toContainText('Payment APP-');
  await expect(page.locator('.modal')).toContainText('proof.pdf');

  let r = await api(page, 'GET', `/payables/payment-requests/${req.id}`);
  expect(r).toMatchObject({ status: 'approved', paid_amount: 1000, remaining: 500, paid_in_full: false });
  const first = await api(page, 'GET', `/payables/payments/${r.payments[0].id}`);
  expect(first).toMatchObject({ amount: 1000, bank_account_id: bank.id, books_bank_account_id: bank.books_id, posting_mode: 'payment', reference: `TRX-${s}`, payment_date: '2026-11-20' });
  expect(first.allocations.map(a => a.bill_id)).toEqual([bill1.id]);
  expect(first.attachments).toHaveLength(1);

  // More than is left is refused; the rest pays it off and it turns Paid.
  expect(await attempt(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-21', method: 'cheque', reference: '000123', bank_account_id: bank.id, amount: 600 })).toContain('500.00 is left');
  await api(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-21', method: 'cheque', reference: '000123', bank_account_id: bank.id });
  r = await api(page, 'GET', `/payables/payment-requests/${req.id}`);
  expect(r).toMatchObject({ status: 'paid', paid_amount: 1500, remaining: 0, paid_in_full: true });
  expect(await attempt(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-22', method: 'cheque', reference: '000124', bank_account_id: bank.id })).toContain('already been paid in full');

  // The advice: invoice numbers, amounts, date, reference; as a PDF too.
  const html = await page.evaluate(id => fetch(`/api/email/payment-advice-preview/${id}`).then(x => x.text()), first.id);
  for (const t of ['PAYMENT ADVICE', supplier.name, `INV-A-${s}`, `TRX-${s}`, '1,000.00']) expect(html).toContain(t);
  expect(html).not.toContain(`INV-B-${s}`);
  const pdf = await page.request.get(`/api/email/payment-advice-pdf/${first.id}`);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Books' feed carries both payments with their bank account, once each.
  const feed = await (await page.request.get('/api/payables/payments-feed', { headers: { 'X-API-Key': key } })).json();
  const mine = feed.filter(p => p.request_number === req.request_number);
  expect(mine).toHaveLength(2);
  expect(mine.every(p => p.books_bank_account_id === bank.books_id && p.status === 'posted')).toBeTruthy();

  // Voiding the cheque puts its 500 back to pay.
  const second = r.payments.find(p => p.reference === '000123');
  await api(page, 'POST', `/payables/payments/${second.id}/void`, { reason: 'Cheque spoiled' });
  r = await api(page, 'GET', `/payables/payment-requests/${req.id}`);
  expect(r).toMatchObject({ status: 'approved', remaining: 500 });
  // ...and it can be paid again (which also leaves nothing in anyone's A/P inbox).
  await api(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-22', method: 'cheque', reference: '000125', bank_account_id: bank.id });
  expect((await api(page, 'GET', `/payables/payment-requests/${req.id}`)).status).toBe('paid');
});

test('a COD payment on a PO waits on the vendor account and is applied when the invoice comes in, with no second bank posting', async ({ page }) => {
  const { s, approver, supplier, bank, key } = await setup(page);
  const product = (await api(page, 'GET', '/products')).find(p => !p.is_rental && !p.has_variations && p.price > 0);
  const po = await api(page, 'POST', '/purchase-orders', { supplier_id: supplier.id, branch_id: 1, items: [{ product_id: product.id, quantity: 2, unit_cost: 400 }] });
  await api(page, 'PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' });
  await login(page, approver);
  await api(page, 'PATCH', `/purchase-orders/${po.id}/approve`, { signature: SIG });
  await login(page, 'admin');
  const total = (await api(page, 'GET', `/purchase-orders/${po.id}`)).total;
  const req = await api(page, 'POST', `/payables/payment-requests/from-po/${po.id}`, { amount: total, required_date: '2026-11-30' });
  await approve(page, approver, req.id);

  const paid = await api(page, 'POST', `/payables/payment-requests/${req.id}/pay`, { payment_date: '2026-11-20', method: 'bank_transfer', reference: `COD-${s}`, bank_account_id: bank.id });
  expect(paid.status).toBe('paid');
  let pay = await api(page, 'GET', `/payables/payments/${paid.new_payment_id}`);
  expect(pay).toMatchObject({ po_number: po.po_number, unapplied: total, allocations: [] });
  expect((await api(page, 'GET', `/payables/vendors/${supplier.id}/statement`)).available_to_apply).toBe(total);
  // The advice names the PO while no invoice is in.
  const adviceBefore = await page.evaluate(id => fetch(`/api/email/payment-advice-preview/${id}`).then(x => x.text()), pay.id);
  expect(adviceBefore).toContain(`purchase order ${po.po_number}`);

  // The invoice is entered by hand (not linked to the PO) for less than was paid.
  const bill = await api(page, 'POST', '/payables/bills', { supplier_id: supplier.id, vendor_invoice_number: `COD-INV-${s}`, bill_date: '2026-11-25', amount: total - 100, tax_amount: 0 });
  pay = await api(page, 'GET', `/payables/payments/${pay.id}`);
  expect(pay.open_bills.map(b => b.id)).toContain(bill.id);

  // Applied from the payment, through the screen.
  await page.evaluate(id => App.viewApPayment(id), pay.id);
  await page.locator(`.pay-apply[data-bill="${bill.id}"]`).fill(String(total - 100));
  await page.getByRole('button', { name: 'Apply to Bills' }).click();
  await expect(page.locator('.modal')).toContainText(bill.bill_number);
  pay = await api(page, 'GET', `/payables/payments/${pay.id}`);
  expect(pay.unapplied).toBe(100);
  expect((await api(page, 'GET', `/payables/bills/${bill.id}`)).balance).toBe(0);
  expect((await api(page, 'GET', `/payables/vendors/${supplier.id}/statement`)).available_to_apply).toBe(100);
  expect(await attempt(page, 'POST', `/payables/payments/${pay.id}/apply`, { allocations: [{ bill_id: bill.id, amount: 1 }] })).toContain('owed on bill');

  // Still one payment in Books' feed — applying it adds no bank posting.
  const feed = await (await page.request.get('/api/payables/payments-feed', { headers: { 'X-API-Key': key } })).json();
  expect(feed.filter(p => p.po_number === po.po_number)).toHaveLength(1);
  // The bill's payment detail tells Books it's a whole-payment posting.
  const billDetail = await api(page, 'GET', `/payables/bills/${bill.id}`);
  expect(billDetail.payments[0]).toMatchObject({ posting_mode: 'payment', books_bank_account_id: bank.books_id });
});
