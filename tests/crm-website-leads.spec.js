import { test, expect } from './fixtures.js';

// Website rental requests in the CRM: the lead is tied to the customer it's
// from (the signed-in customer the website sends, followed through a merge,
// or a single email/phone match), Create Rental Quote fills the quote form
// from the request, saving it links the quote and moves the lead to
// Proposal, and the website reads the customer's requests back.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('a website rental request finds its customer and becomes a filled-in rental quote', async ({ page }) => {
  const s = `${Date.now()}`;
  const home = await page.evaluate(() => App._homeBranch());
  const branch = home || (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const item = await api(page, 'POST', '/products', { sku: `LEADQ-${s}`, name: `Lead Lift ${s}`, is_rental: 1, rental_rate: 90, branch_id: branch.id, stock_qty: 2, online_available: 1 });

  const email = `lead${s}@example.com`;
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [
    { first_name: 'Kept', last_name: `Leader ${s}`, email, phone: `876${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' },
    { first_name: 'Old', last_name: `Leader ${s}`, phone: `877${s.slice(-7)}`, customer_type: 'cash' },
  ] });
  const found = await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Leader ${s}`)}`);
  const kept = found.find(c => c.first_name === 'Kept');
  const old = found.find(c => c.first_name === 'Old');
  await api(page, 'POST', '/customers/merge', { keep_id: kept.id, merge_ids: [old.id] });

  const [d3, d6] = await Promise.all([3, 6].map(n => page.evaluate(k => App._storeDay(new Date(Date.now() + k * 86400000)), n)));
  const request = {
    start_date: d3, end_date: d6, fulfilment: 'delivery', delivery_address: '12 Hope Road', delivery_parish: 'St. Andrew',
    items: [{ product_id: item.id, name: item.name, sku: item.sku, quantity: 2, branch_id: branch.id, branch_name: branch.name, accessory_ids: [], accessory_names: [] }],
  };
  // Signed in on the website as the merged-away record → the kept customer.
  const lead = await api(page, 'POST', '/crm/leads', { first_name: 'Kept', last_name: `Leader ${s}`, email, source: 'website', notes: '[Website Rental Request]', customer_id: old.id, request });
  expect(lead.customer_id).toBe(kept.id);
  expect(lead.request.items[0].product_id).toBe(item.id);
  // A guest with the same email → the same customer.
  expect((await api(page, 'POST', '/crm/leads', { first_name: 'Guest', last_name: 'Asker', email, source: 'website' })).customer_id).toBe(kept.id);
  // Nobody we know → not linked, no suggestions.
  const stranger = await api(page, 'POST', '/crm/leads', { first_name: 'New', last_name: `Person ${s}`, email: `nobody${s}@example.com`, source: 'website' });
  expect(stranger.customer_id).toBeNull();
  expect((await api(page, 'GET', `/crm/leads/${stranger.id}`)).customer_matches).toEqual([]);

  await page.evaluate(() => App.showSection('crm'));
  await page.evaluate(id => App.viewLead(id), lead.id);
  await expect(page.locator('.modal-body')).toContainText('Existing customer');
  await expect(page.locator('.modal-body')).toContainText(kept.customer_number);
  await expect(page.locator('.modal-body')).toContainText(`Lead Lift ${s}`);
  await page.click('button:has-text("Create Rental Quote")');

  // The quote form, filled in from the request.
  await expect(page.locator('#qt-rental-items-section')).toBeVisible();
  await expect(page.locator('#qt-cust')).toHaveValue(String(kept.id));
  await expect(page.locator('#rql-prod-0')).toHaveValue(String(item.id));
  await expect(page.locator('#rql-qty-0')).toHaveValue('2');
  await expect(page.locator('#qt-duedate')).toHaveValue(d6);
  await expect(page.locator('#qt-delivery')).toBeChecked();
  await expect(page.locator('#qt-delivery-address')).toHaveValue('12 Hope Road, St. Andrew');
  await expect(page.locator('#qt-notes')).toHaveValue(new RegExp(lead.lead_number));
  await page.locator('.modal-footer button:has-text("Create Quote")').click();

  // Back on the lead, now with its quote.
  await expect(page.locator('.modal-body')).toContainText('Quotes from this lead');
  const after = await api(page, 'GET', `/crm/leads/${lead.id}`);
  expect(after.status).toBe('proposal');
  expect(after.quotes).toHaveLength(1);
  const quote = await api(page, 'GET', `/quotations/${after.quotes[0].id}`);
  expect(quote.customer_id).toBe(kept.id);
  expect(quote.quote_type).toBe('rental');
  expect(quote.delivery_required).toBeTruthy();

  // What the website's account page reads.
  const requests = await api(page, 'GET', `/customers/${kept.id}/rental-requests`);
  const mine = requests.find(r => r.id === lead.id);
  expect(mine.status).toBe('proposal');
  expect(mine.request.items[0].quantity).toBe(2);
  expect(mine.quotes[0].quote_number).toBe(after.quotes[0].quote_number);
  expect(mine.quotes[0].agreement_number).toBeNull();

  // The quote becomes a rental agreement: the lead is won and the website
  // shows the agreement (its RA number and status) instead of the quote.
  await api(page, 'POST', `/quotations/${quote.id}/convert`, { employee_id: 1, branch_id: branch.id });
  expect((await api(page, 'GET', `/crm/leads/${lead.id}`)).status).toBe('won');
  const converted = (await api(page, 'GET', `/customers/${kept.id}/rental-requests`)).find(r => r.id === lead.id);
  expect(converted.quotes[0].agreement_number).toMatch(/^RA-/);
  expect(converted.quotes[0].agreement_status).toBe('pending');

  // Cancelled before it went out: the quote is open again, the lead back to Proposal.
  await api(page, 'PATCH', `/rentals/agreements/${converted.quotes[0].agreement_id}/cancel`, { reason: 'Customer changed plans', employee_id: 1 });
  expect((await api(page, 'GET', `/crm/leads/${lead.id}`)).status).toBe('proposal');
  const reopened = (await api(page, 'GET', `/customers/${kept.id}/rental-requests`)).find(r => r.id === lead.id);
  expect(reopened.quotes[0].agreement_number).toBeNull();
});

test('a lead whose details match several customers lists them, and Link ties it without closing it', async ({ page }) => {
  const s = `${Date.now()}`;
  const phone = `878${s.slice(-7)}`;
  const a = await api(page, 'POST', '/customers', { first_name: 'Same', last_name: `Phone ${s}`, phone, customer_type: 'cash', force: true });
  const b = await api(page, 'POST', '/customers', { first_name: 'Other', last_name: `Email ${s}`, email: `same${s}@example.com`, customer_type: 'cash', force: true });
  const lead = await api(page, 'POST', '/crm/leads', { first_name: 'Who', last_name: 'Isit', phone, email: `same${s}@example.com`, source: 'website' });
  expect(lead.customer_id).toBeNull();
  const view = await api(page, 'GET', `/crm/leads/${lead.id}`);
  expect(view.customer_matches.map(m => m.id).sort()).toEqual([a.id, b.id].sort());

  await page.evaluate(() => App.showSection('crm'));
  await page.evaluate(id => App.viewLead(id), lead.id);
  await expect(page.locator('.modal-body')).toContainText('Possible existing customer');
  await page.locator('.modal-body div', { hasText: b.customer_number }).locator('button:has-text("Link")').last().click();
  await expect(page.locator('.modal-body')).toContainText('Existing customer');
  const linked = await api(page, 'GET', `/crm/leads/${lead.id}`);
  expect(linked.customer_id).toBe(b.id);
  expect(linked.status).toBe('new');
});
