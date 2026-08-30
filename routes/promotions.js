const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { promoTimingStatus, computeEligibleAmount } = require('../lib/promotions');

// List all promotions with code count
router.get('/', requirePermission('promotions'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `
      SELECT p.*,
        (SELECT COUNT(*) FROM promotion_codes WHERE promotion_id = p.id) as code_count,
        (SELECT COUNT(*) FROM promotion_items WHERE promotion_id = p.id) as item_count,
        (SELECT COUNT(*) FROM promotion_brands WHERE promotion_id = p.id AND excluded = 0) as brand_count,
        (SELECT COUNT(*) FROM promotion_brands WHERE promotion_id = p.id AND excluded = 1) as excluded_brand_count
      FROM promotions p ORDER BY p.created_at DESC
    `, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All product/category assignments across active promotions (for exclusivity display)
router.get('/product-assignments', requirePermission('promotions'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT pi.item_id, pi.item_type, pi.promotion_id, p.name as promotion_name
            FROM promotion_items pi
            JOIN promotions p ON pi.promotion_id = p.id
            WHERE p.active = 1`,
      args: []
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All brand inclusions across active promotions (for exclusivity display) —
// exclusions aren't listed here since multiple promotions can each exclude
// the same brand without conflict.
router.get('/brand-assignments', requirePermission('promotions'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT pb.brand, pb.promotion_id, p.name as promotion_name
            FROM promotion_brands pb
            JOIN promotions p ON pb.promotion_id = p.id
            WHERE p.active = 1 AND pb.excluded = 0`,
      args: []
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Distinct brands in the catalog, for the promotion form's brand pickers
router.get('/brands', requirePermission('promotions'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND TRIM(brand) != '' ORDER BY brand COLLATE NOCASE`, args: [] });
    res.json(rows.map(r => r.brand));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single promotion with items, brands, and codes
router.get('/:id', requirePermission('promotions'), async (req, res) => {
  try {
    const { rows: [promo] } = await db.execute({ sql: 'SELECT * FROM promotions WHERE id = ?', args: [req.params.id] });
    if (!promo) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM promotion_items WHERE promotion_id = ?', args: [req.params.id] });
    const { rows: brands } = await db.execute({ sql: 'SELECT * FROM promotion_brands WHERE promotion_id = ?', args: [req.params.id] });
    const { rows: codes } = await db.execute({ sql: 'SELECT * FROM promotion_codes WHERE promotion_id = ? ORDER BY created_at DESC', args: [req.params.id] });
    promo.items = items;
    promo.brands = brands;
    promo.codes = codes;
    res.json(promo);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const RECURRENCE_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

// Create promotion
router.post('/', requirePermission('promotions'), async (req, res) => {
  try {
    const { name, description, type, value, min_purchase, applies_to, start_date, end_date, start_time, end_time, is_recurring, recurrence_type, recurrence_days, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (!['percentage', 'fixed'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const recurType = recurrence_type && RECURRENCE_TYPES.includes(recurrence_type) ? recurrence_type : (is_recurring ? 'daily' : 'none');
    const result = await db.execute({ sql: `
      INSERT INTO promotions (name, description, type, value, min_purchase, applies_to, start_date, end_date, start_time, end_time, is_recurring, recurrence_type, recurrence_days, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, args: [name, description || null, type, value || 0, min_purchase || 0, applies_to || 'all', start_date || null, end_date || null, start_time || null, end_time || null, recurType !== 'none' ? 1 : 0, recurType, recurType === 'weekly' && Array.isArray(recurrence_days) ? JSON.stringify(recurrence_days) : null, active !== false ? 1 : 0] });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Update promotion
router.put('/:id', requirePermission('promotions'), async (req, res) => {
  try {
    const { name, description, type, value, min_purchase, applies_to, start_date, end_date, start_time, end_time, is_recurring, recurrence_type, recurrence_days, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const recurType = recurrence_type && RECURRENCE_TYPES.includes(recurrence_type) ? recurrence_type : (is_recurring ? 'daily' : 'none');
    await db.execute({ sql: `
      UPDATE promotions SET name=?, description=?, type=?, value=?, min_purchase=?, applies_to=?, start_date=?, end_date=?, start_time=?, end_time=?, is_recurring=?, recurrence_type=?, recurrence_days=?, active=?
      WHERE id=?
    `, args: [name, description || null, type, value || 0, min_purchase || 0, applies_to || 'all', start_date || null, end_date || null, start_time || null, end_time || null, recurType !== 'none' ? 1 : 0, recurType, recurType === 'weekly' && Array.isArray(recurrence_days) ? JSON.stringify(recurrence_days) : null, active ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Delete promotion
router.delete('/:id', requirePermission('promotions'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotions WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add item/category to promotion (enforces exclusivity across active promotions)
router.post('/:id/items', requirePermission('promotions'), async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    if (!['product', 'category'].includes(item_type)) return res.status(400).json({ error: 'item_type must be product or category' });
    const { rows: conflicts } = await db.execute({
      sql: `SELECT p.name FROM promotion_items pi
            JOIN promotions p ON pi.promotion_id = p.id
            WHERE pi.item_type = ? AND pi.item_id = ? AND pi.promotion_id != ? AND p.active = 1`,
      args: [item_type, item_id, req.params.id]
    });
    if (conflicts.length) return res.status(400).json({ error: `Already assigned to active promotion "${conflicts[0].name}"` });
    await db.execute({ sql: 'INSERT OR IGNORE INTO promotion_items (promotion_id, item_type, item_id) VALUES (?, ?, ?)', args: [req.params.id, item_type, item_id] });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Remove item from promotion
router.delete('/:id/items/:itemId', requirePermission('promotions'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotion_items WHERE promotion_id = ? AND id = ?', args: [req.params.id, req.params.itemId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add a brand to a promotion — either as part of its inclusion set
// (excluded=false, only meaningful when applies_to='brands', same exclusivity
// rule as product/category assignment) or to carve it OUT of an otherwise-
// qualifying promotion (excluded=true, no exclusivity check — several
// promotions can each exclude the same brand).
router.post('/:id/brands', requirePermission('promotions'), async (req, res) => {
  try {
    const { brand, excluded } = req.body;
    if (!brand || !brand.trim()) return res.status(400).json({ error: 'Brand is required' });
    const isExcluded = !!excluded;
    if (!isExcluded) {
      const { rows: conflicts } = await db.execute({
        sql: `SELECT p.name FROM promotion_brands pb
              JOIN promotions p ON pb.promotion_id = p.id
              WHERE pb.brand = ? COLLATE NOCASE AND pb.excluded = 0 AND pb.promotion_id != ? AND p.active = 1`,
        args: [brand.trim(), req.params.id]
      });
      if (conflicts.length) return res.status(400).json({ error: `Already assigned to active promotion "${conflicts[0].name}"` });
    }
    await db.execute({ sql: 'INSERT OR REPLACE INTO promotion_brands (promotion_id, brand, excluded) VALUES (?, ?, ?)', args: [req.params.id, brand.trim(), isExcluded ? 1 : 0] });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Remove a brand from a promotion
router.delete('/:id/brands/:brandId', requirePermission('promotions'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotion_brands WHERE promotion_id = ? AND id = ?', args: [req.params.id, req.params.brandId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create promotion code
router.post('/:id/codes', requirePermission('promotions'), async (req, res) => {
  try {
    const { code, usage_limit } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    try {
      const result = await db.execute({ sql: `
        INSERT INTO promotion_codes (promotion_id, code, usage_limit)
        VALUES (?, ?, ?)
      `, args: [req.params.id, code.trim().toUpperCase(), usage_limit || null] });
      res.json({ id: Number(result.lastInsertRowid) });
    } catch (e) {
      res.status(400).json({ error: 'Code already exists' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update promotion code
router.put('/:id/codes/:codeId', requirePermission('promotions'), async (req, res) => {
  try {
    const { usage_limit, active } = req.body;
    await db.execute({ sql: 'UPDATE promotion_codes SET usage_limit=?, active=? WHERE id=? AND promotion_id=?', args: [usage_limit || null, active ? 1 : 0, req.params.codeId, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete promotion code
router.delete('/:id/codes/:codeId', requirePermission('promotions'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotion_codes WHERE id = ? AND promotion_id = ?', args: [req.params.codeId, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Auto-apply: return ALL active promotions that require no code and match cart, sorted by discount desc
// The next three are called from the POS cart during checkout (applying a
// promo code to an in-progress sale), not the promotions management screen —
// gated by `pos`, matching where they're actually invoked from.
router.post('/auto-apply', requirePermission('pos'), async (req, res) => {
  try {
    const { cart_items = [], subtotal = 0 } = req.body;
    const { rows: allPromos } = await db.execute({
      sql: `SELECT p.* FROM promotions p
            WHERE p.active = 1
              AND (SELECT COUNT(*) FROM promotion_codes WHERE promotion_id = p.id) = 0`,
      args: []
    });
    const promos = allPromos.filter(p => promoTimingStatus(p).active);

    // One batched lookup for every scoped promo's items/brands instead of
    // one query per promo — this runs on the POS checkout/cart hot path.
    const scopedPromoIds = promos.filter(p => ['specific', 'categories', 'items', 'brands'].includes(p.applies_to)).map(p => p.id);
    let itemsByPromo = {};
    if (scopedPromoIds.length) {
      const placeholders = scopedPromoIds.map(() => '?').join(',');
      const { rows: allItems } = await db.execute({ sql: `SELECT * FROM promotion_items WHERE promotion_id IN (${placeholders})`, args: scopedPromoIds });
      for (const item of allItems) { (itemsByPromo[item.promotion_id] = itemsByPromo[item.promotion_id] || []).push(item); }
    }
    const allPromoIds = promos.map(p => p.id);
    let brandsByPromo = {};
    if (allPromoIds.length) {
      const placeholders = allPromoIds.map(() => '?').join(',');
      const { rows: allBrands } = await db.execute({ sql: `SELECT * FROM promotion_brands WHERE promotion_id IN (${placeholders})`, args: allPromoIds });
      for (const b of allBrands) { (brandsByPromo[b.promotion_id] = brandsByPromo[b.promotion_id] || []).push(b); }
    }
    const cartProductIds = [...new Set(cart_items.map(ci => ci.product_id).filter(Boolean))];
    let brandByProduct = {};
    if (cartProductIds.length) {
      const placeholders = cartProductIds.map(() => '?').join(',');
      const { rows: prodRows } = await db.execute({ sql: `SELECT id, brand FROM products WHERE id IN (${placeholders})`, args: cartProductIds });
      for (const pr of prodRows) brandByProduct[pr.id] = pr.brand;
    }

    const results = [];

    for (const promo of promos) {
      if (promo.min_purchase > 0 && subtotal < promo.min_purchase) continue;
      const eligibleAmount = computeEligibleAmount(promo, cart_items, subtotal, { items: itemsByPromo[promo.id] || [], brands: brandsByPromo[promo.id] || [], brandByProduct });
      if (eligibleAmount === 0) continue;
      const discount = promo.type === 'percentage'
        ? parseFloat((eligibleAmount * promo.value / 100).toFixed(2))
        : parseFloat(Math.min(promo.value, eligibleAmount).toFixed(2));
      results.push({ ...promo, discount_amount: discount });
    }

    results.sort((a, b) => b.discount_amount - a.discount_amount);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Validate and apply a promo code (used by POS)
router.post('/validate-code', requirePermission('pos'), async (req, res) => {
  try {
    const { code, subtotal, cart_items } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    const { rows: [pc] } = await db.execute({ sql: `
      SELECT pc.*, p.name as promo_name, p.type, p.value, p.min_purchase, p.applies_to,
             p.start_date, p.end_date, p.start_time, p.end_time, p.is_recurring, p.recurrence_type, p.recurrence_days, p.active as promo_active
      FROM promotion_codes pc
      JOIN promotions p ON p.id = pc.promotion_id
      WHERE pc.code = ? COLLATE NOCASE
    `, args: [code.trim()] });

    if (!pc) return res.status(404).json({ error: 'Invalid promotion code' });
    if (!pc.active || !pc.promo_active) return res.status(400).json({ error: 'This promotion code is inactive' });

    const timing = promoTimingStatus(pc);
    if (!timing.active) {
      const messages = {
        not_started: 'Promotion has not started yet',
        expired: 'Promotion has expired',
        not_recurrence_day: 'This promotion doesn\'t run today',
        outside_daily_window: `This promotion only runs from ${pc.start_time || '12:00 AM'} to ${pc.end_time || '11:59 PM'}`,
      };
      return res.status(400).json({ error: messages[timing.reason] || 'Promotion is not currently active' });
    }
    if (pc.usage_limit !== null && pc.times_used >= pc.usage_limit) return res.status(400).json({ error: 'This code has reached its usage limit' });
    if (pc.min_purchase > 0 && subtotal < pc.min_purchase) {
      return res.status(400).json({ error: `Minimum purchase of ${pc.min_purchase} required` });
    }

    // Calculate eligible amount
    let eligibleAmount = subtotal;
    if (cart_items && cart_items.length) {
      const [{ rows: items }, { rows: brands }] = await Promise.all([
        db.execute({ sql: `SELECT * FROM promotion_items WHERE promotion_id = ?`, args: [pc.promotion_id] }),
        db.execute({ sql: `SELECT * FROM promotion_brands WHERE promotion_id = ?`, args: [pc.promotion_id] }),
      ]);
      const cartProductIds = [...new Set(cart_items.map(ci => ci.product_id).filter(Boolean))];
      let brandByProduct = {};
      if (cartProductIds.length) {
        const placeholders = cartProductIds.map(() => '?').join(',');
        const { rows: prodRows } = await db.execute({ sql: `SELECT id, brand FROM products WHERE id IN (${placeholders})`, args: cartProductIds });
        for (const pr of prodRows) brandByProduct[pr.id] = pr.brand;
      }
      eligibleAmount = computeEligibleAmount(pc, cart_items, subtotal, { items, brands, brandByProduct });
      if (eligibleAmount === 0 && (['specific', 'categories', 'items', 'brands'].includes(pc.applies_to) || brands.some(b => b.excluded))) {
        return res.status(400).json({ error: 'No items in cart qualify for this promotion' });
      }
    }

    const discount = pc.type === 'percentage'
      ? parseFloat((eligibleAmount * pc.value / 100).toFixed(2))
      : parseFloat(Math.min(pc.value, eligibleAmount).toFixed(2));

    res.json({
      code_id: pc.id,
      promotion_id: pc.promotion_id,
      promo_name: pc.promo_name,
      type: pc.type,
      value: pc.value,
      discount_amount: discount,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Record usage of a promo code
router.post('/use-code', requirePermission('pos'), async (req, res) => {
  try {
    const { code_id } = req.body;
    await db.execute({ sql: 'UPDATE promotion_codes SET times_used = times_used + 1 WHERE id = ?', args: [code_id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
