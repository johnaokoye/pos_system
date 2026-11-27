import { test, expect } from './fixtures.js';

// A promotion's discount comes off only the lines it covers — an item on the
// same ticket outside the promotion keeps its full price (it used to take a
// share of the discount, spread over every line by amount).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('a promotion discounts only its own items on a mixed ticket — cart, hold and sale', async ({ page }) => {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(() => document.getElementById('pos-drawer-overlay')?.remove());
  const [a, b, c] = await page.evaluate(() => App.allProducts.filter(p => !p.is_rental && !p.has_variations && p.stock_qty > 20 && p.price > 5 && p.product_type !== 'service' && !App._unitChoices(p).some(u => !u.isBase)).slice(0, 3).map(p => ({ id: p.id, price: p.price, tax_rate: p.tax_rate || 0 })));
  const code = `PL${Date.now()}`;
  const { id: promoId } = await api(page, 'POST', '/promotions', { name: `Pair ${code}`, type: 'bundle', bundle_pricing: 'percent', value: 20, active: true, bundle_items: [{ product_id: a.id, quantity: 1 }, { product_id: b.id, quantity: 1 }] });
  await api(page, 'POST', `/promotions/${promoId}/codes`, { code });
  try {
    const add = id => page.evaluate(id => App.addToCart(id, App._unitChoices(App.allProducts.find(x => x.id === id))[0]), id);
    await add(a.id); await add(b.id); await add(c.id);
    await page.evaluate(() => App._closeBundleUpsell?.());
    await page.evaluate(() => App.showTicketDiscountModal());
    await page.fill('#promo-code-input', code);
    await page.evaluate(() => App.applyPromoCode());
    await expect.poll(() => page.evaluate(() => App.appliedPromoCode?.code)).toBe(code);
    await page.evaluate(() => App.closeModal());

    // Cart: the third item takes none of the 20% bundle discount.
    const expected = Math.round((a.price + b.price) * 20) / 100;
    const totals = await page.evaluate(() => App.getCartTotals());
    expect(totals.discount).toBeCloseTo(expected, 2);
    expect(totals.lineShares[2]).toBe(0);
    expect(totals.lineShares[0] + totals.lineShares[1]).toBeCloseTo(expected, 2);
    expect(totals.lineTaxes[2]).toBeCloseTo(c.price * c.tax_rate / 100, 2);
    expect(await page.evaluate(() => App._promoLineFlags())).toEqual([true, true, false]);

    // Hold keeps each line's share; recall puts the same split back.
    await page.evaluate(() => App.holdOrder());
    await expect.poll(() => page.evaluate(() => App.cart.length)).toBe(0);
    const held = (await api(page, 'GET', '/transactions?status=hold&limit=500')).sort((x, y) => y.id - x.id)[0];
    const heldRow = await api(page, 'GET', `/transactions/${held.id}`);
    const heldC = heldRow.items.find(i => i.product_id === c.id);
    expect(heldC.ticket_discount).toBe(0);
    expect(heldC.tax_amount).toBeCloseTo(c.price * c.tax_rate / 100, 2);
    await api(page, 'DELETE', `/transactions/${held.id}/hold`).catch(() => {});

    // Sale: checkout splits it the same way from items[].promo_line.
    const items = [a, b, c].map((p, i) => ({ product_id: p.id, quantity: 1, promo_line: i < 2 }));
    const sale = await api(page, 'POST', '/transactions', { employee_id: 1, branch_id: 1, items, discount_amount: expected, promotion_code: code, promotion_name: `Pair ${code}`, payment_method: 'cash', amount_tendered: 1e7 });
    const row = await api(page, 'GET', `/transactions/${sale.id}`);
    const line = id => row.items.find(i => i.product_id === id);
    expect(line(c.id).ticket_discount).toBe(0);
    expect(line(c.id).tax_amount).toBeCloseTo(c.price * c.tax_rate / 100, 2);
    expect(line(a.id).ticket_discount + line(b.id).ticket_discount).toBeCloseTo(expected, 2);

    // No flags (a manual Ticket Discount, an older till) still spreads over every line.
    const manual = await api(page, 'POST', '/transactions', { employee_id: 1, branch_id: 1, items: items.map(({ promo_line, ...i }) => i), discount_amount: 1, payment_method: 'cash', amount_tendered: 1e7 });
    expect((await api(page, 'GET', `/transactions/${manual.id}`)).items.find(i => i.product_id === c.id).ticket_discount).toBeGreaterThan(0);
  } finally {
    await api(page, 'DELETE', `/promotions/${promoId}`);
  }
});
