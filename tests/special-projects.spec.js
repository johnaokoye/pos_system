import { test, expect } from './fixtures.js';

const line = {
  description: 'PROPS METAL 7FT 3" - 13FT, Unbranded, 13 FEET', item_no: 'PROPS713', uom: 'H',
  quantity: 135, rent_period: 25, rent_period_unit: 'Day(s)', unit_price: 30.43, unit_cost: 10,
};

// Runs in the page so it uses the logged-in session.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const createProject = (page, items, extra = {}) => api(page, 'POST', '/quotations', { quote_type: 'special_project', employee_id: 1, branch_id: 1, items, ...extra });
const preview = (page, id) => page.evaluate(i => fetch(`/api/email/quote-preview/${i}`).then(r => r.text()), id);

test.describe('Special Project custom items', () => {
  test('extended price is quantity x rent period x unit price', async ({ page }) => {
    const q = await createProject(page, [line]);
    expect(q.subtotal).toBe(102701.25);
    expect(q.total).toBeCloseTo(q.subtotal + q.tax_amount, 2);
    const saved = await api(page, 'GET', `/quotations/${q.id}`);
    expect(saved.items[0]).toMatchObject({ sku: 'PROPS713', sell_unit: 'H', quantity: 135, rent_period: 25, rent_period_unit: 'Day(s)', total: 102701.25, discount_applied: 0 });
  });

  test('a percent discount comes off the line before tax, and shows on the quotation', async ({ page }) => {
    const plain = await createProject(page, [line]);
    const q = await createProject(page, [{ ...line, discount: 10, discount_type: 'percent' }]);
    expect(q.subtotal).toBe(92431.12);
    expect(q.tax_amount).toBeCloseTo(plain.tax_amount * 0.9, 1);

    const html = await preview(page, q.id);
    for (const text of ['QUOTATION', 'Item No.', 'Item Description', 'Quantity', 'U.O.M', 'Rent Period', 'Unit Price', 'Extended Price',
      'PROPS713', '135.00', '25.00 Day(s)', '$30.43', '$102,701.25', 'Less discount (10%): -$10,270.13', 'Tax', 'TOTAL']) {
      expect(html).toContain(text);
    }
    // Subtotal before discount, then the discount.
    expect(html.indexOf('Subtotal')).toBeLessThan(html.indexOf('-$10,270.13</td>'));
    expect(html).not.toContain('SPECIAL PROJECT');
  });

  test('the quotation prints and emails without a Draft mark before and after approval', async ({ page }) => {
    const q = await createProject(page, [line]);
    const draft = await preview(page, q.id);
    expect(draft).toContain('QUOTATION');
    expect(draft).not.toContain('DRAFT');
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    expect(await preview(page, q.id)).not.toContain('DRAFT');
    await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
    const approved = await preview(page, q.id);
    expect(approved).toContain('QUOTATION');
    expect(approved).not.toContain('DRAFT');

    const retail = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, items: [{ description: 'Thing to order', quantity: 1, unit_price: 100 }] });
    expect(await preview(page, retail.id)).not.toContain('DRAFT');
  });

  test('the screens call it a Quotation', async ({ page }) => {
    const q = await createProject(page, [line]);
    await page.evaluate(() => App.showSection('special-projects'));
    await expect(page.locator('button', { hasText: '+ New Quotation' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Quotation #' })).toBeVisible();
    await page.evaluate(id => App.viewQuote(id), q.id);
    await expect(page.locator('.modal-title').last()).toHaveText(`Quotation: ${q.quote_number}`);
    await expect(page.locator('.modal').last().locator('.badge-pill', { hasText: 'Draft' })).toBeVisible();
  });

  test('a dollar discount, part quantities and a line with no rent period', async ({ page }) => {
    const q = await createProject(page, [{ description: 'Labour', quantity: 2.5, unit_price: 100, discount: 50, discount_type: 'amount' }]);
    expect(q.subtotal).toBe(200);
    const html = await preview(page, q.id);
    expect(html).toContain('2.50');
    expect(html).toContain('$250.00');
    expect(html).toContain('Less discount: -$50.00');
  });

  test('bad values are refused', async ({ page }) => {
    const save = extra => createProject(page, [{ ...line, ...extra }]).then(() => null, e => e.message);
    expect(await save({ discount: 101, discount_type: 'percent' })).toContain('more than 100%');
    expect(await save({ discount: 200000, discount_type: 'amount' })).toContain('more than its extended price');
    expect(await save({ rent_period: -1 })).toContain('rent period');
    expect(await save({ quantity: -1 })).toContain('quantity');
  });

  test('item number and U.O.M are escaped on the printout', async ({ page }) => {
    const q = await createProject(page, [{ ...line, item_no: '<b>x</b>', uom: '<i>y</i>' }]);
    const html = await preview(page, q.id);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<i>y</i>');
  });

  test('other quote types and lines keep their old behaviour', async ({ page }) => {
    const q = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: 1, items: [{ description: 'Thing to order', quantity: 2, unit_price: 100, rent_period: 25, discount: 5, item_no: 'NO' }] });
    expect(q.subtotal).toBe(200);
    const saved = await api(page, 'GET', `/quotations/${q.id}`);
    expect(saved.items[0]).toMatchObject({ rent_period: null, discount_applied: 0, sku: null });
    const html = await preview(page, q.id);
    expect(html).toContain('Price includes $5.00 discount');
    expect(html).not.toContain('Rent Period');

    const qItem = await createProject(page, [{ description: 'Order this', quantity: 2, unit_price: 100, rent_period: 25, discount: 5, is_q_item: true }]);
    expect(qItem.subtotal).toBe(200);
  });

  test('the form shows the extended price live and saves every field, and edits keep them', async ({ page }) => {
    await page.evaluate(() => App.showSection('special-projects'));
    await expect(page.locator('#content h2', { hasText: 'Special Projects' })).toBeVisible();
    await page.evaluate(() => App.showQuoteForm(null, 'special_project'));
    await page.click('#qt-add-custom-item-btn');
    const row = page.locator('[id^="qt-item-"]').last();
    const idx = (await row.getAttribute('id')).replace('qt-item-', '');
    await page.fill(`#qti-itemno-${idx}`, line.item_no);
    await page.fill(`#qti-desc-${idx}`, line.description);
    await page.fill(`#qti-qty-${idx}`, '135');
    await page.fill(`#qti-uom-${idx}`, 'H');
    await page.fill(`#qti-period-${idx}`, '25');
    await page.fill(`#qti-price-${idx}`, '30.43');
    await expect(page.locator(`#qti-ext-${idx}`)).toHaveText('$102,701.25');
    await page.fill(`#qti-disc-${idx}`, '10');
    await page.selectOption(`#qti-disc-type-${idx}`, 'percent');
    await expect(page.locator(`#qti-ext-${idx}`)).toContainText('net $92,431.12');
    await page.evaluate(() => App.saveQuote());
    await expect(page.locator('.modal')).toHaveCount(0);

    // Newest by id: created_at ties when two are made in the same second.
    const list = (await api(page, 'GET', '/quotations?quote_type=special_project&limit=100')).sort((x, y) => y.id - x.id);
    expect(list[0].status).toBe('draft');
    expect(list[0].subtotal).toBe(92431.12);

    // The project view shows the fields and the discount.
    await page.evaluate(id => App.viewQuote(id), list[0].id);
    const modal = page.locator('.modal').last();
    await expect(modal).toContainText('PROPS713');
    await expect(modal).toContainText('25 Day(s)');
    await expect(modal).toContainText('(10%)');
    await expect(modal).toContainText('Subtotal: $102,701.25');
    await expect(modal).toContainText('Discount: -$10,270.13');

    // Re-opening for edit brings everything back, and saving changes nothing.
    await page.evaluate(id => App.showQuoteForm(id), list[0].id);
    const idx2 = (await page.locator('[id^="qt-item-"]').last().getAttribute('id')).replace('qt-item-', '');
    await expect(page.locator(`#qti-itemno-${idx2}`)).toHaveValue('PROPS713');
    await expect(page.locator(`#qti-period-${idx2}`)).toHaveValue('25');
    await expect(page.locator(`#qti-disc-type-${idx2}`)).toHaveValue('percent');
    await expect(page.locator(`#qti-disc-${idx2}`)).toHaveValue('10');
    await page.evaluate(() => App.saveQuote());
    await expect(page.locator('.modal')).toHaveCount(0);
    const again = await api(page, 'GET', `/quotations/${list[0].id}`);
    expect(again.total).toBe(list[0].total);
    expect(again.items[0]).toMatchObject({ discount_percent: 10, rent_period: 25, sku: 'PROPS713' });
  });

  test('converted and rung up at the POS, the sale matches the quotation to the cent', async ({ page }) => {
    const q = await createProject(page, [
      { ...line, discount: 10, discount_type: 'percent' },
      { description: 'Plain labour', quantity: 3, unit_price: 19.99 },
    ], { discount_amount: 1000 });
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
    const held = await api(page, 'POST', `/quotations/${q.id}/convert`, {});
    expect(held.total).toBe(q.total);
    expect(held.items[0]).toMatchObject({ quantity: 1, unit_price: 92431.12 });
    expect(held.items[0].product_name).toContain('PROPS713');
    expect(held.items[0].product_name).toContain('135.00 H x 25.00 Day(s) @ $30.43');
    expect(held.items[1]).toMatchObject({ quantity: 3, unit_price: 19.99, product_name: 'Plain labour' });

    // The cashier recalls the held order and takes payment.
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForFunction(() => App.allProducts);
    await page.evaluate(id => App.loadHeldOrder(id), held.id);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
    expect(await page.evaluate(() => App.getCartTotals().total)).toBe(q.total);
    await page.evaluate(() => { App._salespersonReminderDone = true; App.processPayment('cash'); });
    await page.fill('#ctm-tendered', '200000');
    await page.click('#ctm-confirm');
    const invoice = page.locator('.modal').last();
    await expect(invoice).toContainText('RETAIL TAX INVOICE');
    await expect(invoice).toContainText('135.00 H x 25.00 Day(s) @ $30.43');

    const after = await api(page, 'GET', `/quotations/${q.id}`);
    expect(after.status).toBe('converted');
    const sold = await api(page, 'GET', `/transactions/${after.converted_to_tx}`);
    expect(sold.status).toBe('completed');
    expect(sold.total).toBe(q.total);
    expect(sold.tax_amount).toBe(q.tax_amount);
  });

  test('catalog lines print in the same columns, with their unit and no rent period', async ({ page }) => {
    const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 0 && p.price > 0)));
    const q = await createProject(page, [line, { product_id: product.id, quantity: 2 }]);
    const html = await preview(page, q.id);
    expect(html).toContain(product.sku);
    expect(html).toContain('2.00');
    const unit = parseFloat(product.price) * 2;
    expect(html).toContain(`$${unit.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  });

  test('POS Quote Recall puts the line on the ticket at its exact total', async ({ page }) => {
    const q = await createProject(page, [{ ...line, discount: 10, discount_type: 'percent' }]);
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForFunction(() => App.allProducts);
    await page.evaluate(id => App.loadQuoteToCart(id), q.id);
    const cart = await page.evaluate(() => App.cart.map(i => ({ quantity: i.quantity, price: i.price, name: i.name })));
    expect(cart[0]).toMatchObject({ quantity: 1, price: 92431.12 });
    expect(cart[0].name).toContain('PROPS713');
  });

  test('an unapproved quotation can\'t be sold from POS Quote Recall', async ({ page }) => {
    const q = await createProject(page, [{ description: 'Labour', quantity: 1, unit_price: 100 }]);
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForFunction(() => App.allProducts);
    const check = async expectedShown => {
      const shown = await page.evaluate(async id => App._quoteRecallable(await App.api('GET', `/quotations/${id}`)), q.id);
      expect(shown).toBe(expectedShown);
      await page.evaluate(() => { App.cart = []; });
      await page.evaluate(id => App.loadQuoteToCart(id), q.id);
      expect(await page.evaluate(() => App.cart.length)).toBe(expectedShown ? 1 : 0);
    };
    const sell = () => page.evaluate(id => App.api('POST', '/transactions', { items: [{ product_name: 'Labour', quantity: 1, unit_price: 100, tax_rate: 0 }], quote_id: id, branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 }).then(() => 'sold', e => e.message), q.id);

    await check(false);
    expect(await sell()).toContain("hasn't been approved");
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await check(false);
    expect(await sell()).toContain("hasn't been approved");
    await api(page, 'PATCH', `/quotations/${q.id}/reject`, { reason: 'Too low' });
    await check(false);
    expect(await sell()).toContain("hasn't been approved");
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
    await check(true);
    expect((await api(page, 'GET', `/quotations/${q.id}`)).status).toBe('approved');
  });

  test('a rejected quotation can be edited and resubmitted', async ({ page }) => {
    const q = await createProject(page, [{ description: 'Labour', quantity: 1, unit_price: 100 }]);
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/reject`, { reason: 'Too low' });
    const saved = await api(page, 'PUT', `/quotations/${q.id}`, { branch_id: 1, items: [{ description: 'Labour', quantity: 1, unit_price: 150 }] });
    expect(saved.subtotal).toBe(150);
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    expect((await api(page, 'PATCH', `/quotations/${q.id}/approve`, {})).status).toBe('approved');
  });

  for (const stage of ['pending_approval', 'approved', 'sent', 'accepted']) {
    test(`Edit on a ${stage} quotation returns it to Draft and it must be approved again`, async ({ page }) => {
      const q = await createProject(page, [{ description: 'Labour', quantity: 1, unit_price: 100 }]);
      await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
      if (stage !== 'pending_approval') await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
      if (stage === 'sent' || stage === 'accepted') await api(page, 'PATCH', `/quotations/${q.id}/status`, { status: stage });
      expect((await api(page, 'PUT', `/quotations/${q.id}`, { branch_id: 1, items: [{ description: 'Labour', quantity: 1, unit_price: 1 }] }).catch(e => e.message))).toContain('can only be edited while in Draft');

      await page.evaluate(() => App.showSection('special-projects'));
      await page.evaluate(id => App.viewQuote(id), q.id);
      let message = '';
      page.once('dialog', d => { message = d.message(); d.accept(); });
      await page.locator('.modal-footer button', { hasText: /^Edit$/ }).click();
      await expect(page.locator('.modal-title').last()).toHaveText(`Edit Special Project Quotation: ${q.quote_number}`);
      expect(message).toContain('Continue?');

      const idx = (await page.locator('[id^="qt-item-"]').last().getAttribute('id')).replace('qt-item-', '');
      await page.fill(`#qti-price-${idx}`, '250');
      await page.evaluate(() => App.saveQuote());
      await expect(page.locator('.modal')).toHaveCount(0);

      const after = await api(page, 'GET', `/quotations/${q.id}`);
      expect(after).toMatchObject({ status: 'draft', subtotal: 250, approved_at: null, approved_by: null, approval_signature: null });
      const html = await preview(page, q.id);
      expect(html).not.toContain('DRAFT');
      expect(html).not.toContain('Approved By');
      expect(await page.evaluate(id => App.api('POST', `/quotations/${id}/convert`, {}).then(() => 'converted', e => e.message), q.id)).toContain('must be approved');

      await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
      expect((await api(page, 'PATCH', `/quotations/${q.id}/approve`, {})).status).toBe('approved');
      expect(await preview(page, q.id)).toContain('Approved By');
    });
  }

  test('editing an accepted quotation with a Q item doesn\'t order it twice', async ({ page }) => {
    const q = await createProject(page, [{ description: 'Order this', quantity: 2, unit_price: 100, is_q_item: true }]);
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/status`, { status: 'accepted' });
    const pr = (await api(page, 'GET', `/quotations/${q.id}`)).items[0].purchase_request_id;
    expect(pr).toBeTruthy();

    await api(page, 'PATCH', `/quotations/${q.id}/status`, { status: 'draft' });
    await page.evaluate(id => App.showQuoteForm(id), q.id);
    const idx = (await page.locator('[id^="qt-item-"]').last().getAttribute('id')).replace('qt-item-', '');
    await page.fill(`#qti-price-${idx}`, '120');
    await page.evaluate(() => App.saveQuote());
    await expect(page.locator('.modal')).toHaveCount(0);
    await api(page, 'PATCH', `/quotations/${q.id}/submit-for-approval`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/approve`, {});
    await api(page, 'PATCH', `/quotations/${q.id}/status`, { status: 'accepted' });

    const again = await api(page, 'GET', `/quotations/${q.id}`);
    expect(again.items[0].purchase_request_id).toBe(pr);
    const request = await api(page, 'GET', `/purchase-requests/${pr}`);
    expect(request.items.length).toBe(1);
  });

  test('the margin report counts the rent period in the cost', async ({ page }) => {
    const q = await createProject(page, [line]);
    const today = new Date().toISOString().slice(0, 10);
    const report = await api(page, 'GET', `/reports/special-projects-margin?start=${today}&end=${today}`);
    const p = report.projects.find(x => x.id === q.id);
    expect(p.cost).toBe(33750); // 135 x 25 x 10
    expect(p.revenue).toBe(102701.25);
  });
});
