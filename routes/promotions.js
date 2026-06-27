const express = require('express');
const router = express.Router();
const { db } = require('../database');

// List all promotions with code count
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `
      SELECT p.*,
        (SELECT COUNT(*) FROM promotion_codes WHERE promotion_id = p.id) as code_count,
        (SELECT COUNT(*) FROM promotion_items WHERE promotion_id = p.id) as item_count
      FROM promotions p ORDER BY p.created_at DESC
    `, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single promotion with items and codes
router.get('/:id', async (req, res) => {
  try {
    const { rows: [promo] } = await db.execute({ sql: 'SELECT * FROM promotions WHERE id = ?', args: [req.params.id] });
    if (!promo) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM promotion_items WHERE promotion_id = ?', args: [req.params.id] });
    const { rows: codes } = await db.execute({ sql: 'SELECT * FROM promotion_codes WHERE promotion_id = ? ORDER BY created_at DESC', args: [req.params.id] });
    promo.items = items;
    promo.codes = codes;
    res.json(promo);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create promotion
router.post('/', async (req, res) => {
  try {
    const { name, description, type, value, min_purchase, applies_to, start_date, end_date, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (!['percentage', 'fixed'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const result = await db.execute({ sql: `
      INSERT INTO promotions (name, description, type, value, min_purchase, applies_to, start_date, end_date, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, args: [name, description || null, type, value || 0, min_purchase || 0, applies_to || 'all', start_date || null, end_date || null, active !== false ? 1 : 0] });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Update promotion
router.put('/:id', async (req, res) => {
  try {
    const { name, description, type, value, min_purchase, applies_to, start_date, end_date, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    await db.execute({ sql: `
      UPDATE promotions SET name=?, description=?, type=?, value=?, min_purchase=?, applies_to=?, start_date=?, end_date=?, active=?
      WHERE id=?
    `, args: [name, description || null, type, value || 0, min_purchase || 0, applies_to || 'all', start_date || null, end_date || null, active ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Delete promotion
router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotions WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add item/category to promotion
router.post('/:id/items', async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    if (!['product', 'category'].includes(item_type)) return res.status(400).json({ error: 'item_type must be product or category' });
    await db.execute({ sql: 'INSERT OR IGNORE INTO promotion_items (promotion_id, item_type, item_id) VALUES (?, ?, ?)', args: [req.params.id, item_type, item_id] });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Remove item from promotion
router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotion_items WHERE promotion_id = ? AND id = ?', args: [req.params.id, req.params.itemId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create promotion code
router.post('/:id/codes', async (req, res) => {
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
router.put('/:id/codes/:codeId', async (req, res) => {
  try {
    const { usage_limit, active } = req.body;
    await db.execute({ sql: 'UPDATE promotion_codes SET usage_limit=?, active=? WHERE id=? AND promotion_id=?', args: [usage_limit || null, active ? 1 : 0, req.params.codeId, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete promotion code
router.delete('/:id/codes/:codeId', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM promotion_codes WHERE id = ? AND promotion_id = ?', args: [req.params.codeId, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Auto-apply: find the best active promotion that requires no code
router.post('/auto-apply', async (req, res) => {
  try {
    const { cart_items = [], subtotal = 0 } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const { rows: promos } = await db.execute({
      sql: `SELECT p.* FROM promotions p
            WHERE p.active = 1
              AND (p.start_date IS NULL OR p.start_date <= ?)
              AND (p.end_date IS NULL OR p.end_date >= ?)
              AND (SELECT COUNT(*) FROM promotion_codes WHERE promotion_id = p.id) = 0`,
      args: [today, today]
    });

    let bestPromo = null;
    let bestDiscount = 0;

    for (const promo of promos) {
      if (promo.min_purchase > 0 && subtotal < promo.min_purchase) continue;
      let eligibleAmount = subtotal;
      if (promo.applies_to === 'specific') {
        const { rows: items } = await db.execute({ sql: 'SELECT * FROM promotion_items WHERE promotion_id = ?', args: [promo.id] });
        const productIds = new Set(items.filter(i => i.item_type === 'product').map(i => i.item_id));
        const categoryIds = new Set(items.filter(i => i.item_type === 'category').map(i => i.item_id));
        eligibleAmount = cart_items.reduce((sum, ci) => {
          if (productIds.has(ci.product_id) || categoryIds.has(ci.category_id)) return sum + ci.price * ci.quantity;
          return sum;
        }, 0);
        if (eligibleAmount === 0) continue;
      }
      const discount = promo.type === 'percentage'
        ? parseFloat((eligibleAmount * promo.value / 100).toFixed(2))
        : parseFloat(Math.min(promo.value, eligibleAmount).toFixed(2));
      if (discount > bestDiscount) { bestDiscount = discount; bestPromo = { ...promo, discount_amount: discount }; }
    }
    res.json(bestPromo || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Validate and apply a promo code (used by POS)
router.post('/validate-code', async (req, res) => {
  try {
    const { code, subtotal, cart_items } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    const { rows: [pc] } = await db.execute({ sql: `
      SELECT pc.*, p.name as promo_name, p.type, p.value, p.min_purchase, p.applies_to,
             p.start_date, p.end_date, p.active as promo_active
      FROM promotion_codes pc
      JOIN promotions p ON p.id = pc.promotion_id
      WHERE pc.code = ? COLLATE NOCASE
    `, args: [code.trim()] });

    if (!pc) return res.status(404).json({ error: 'Invalid promotion code' });
    if (!pc.active || !pc.promo_active) return res.status(400).json({ error: 'This promotion code is inactive' });

    const today = new Date().toISOString().split('T')[0];
    if (pc.start_date && today < pc.start_date) return res.status(400).json({ error: 'Promotion has not started yet' });
    if (pc.end_date && today > pc.end_date) return res.status(400).json({ error: 'Promotion has expired' });
    if (pc.usage_limit !== null && pc.times_used >= pc.usage_limit) return res.status(400).json({ error: 'This code has reached its usage limit' });
    if (pc.min_purchase > 0 && subtotal < pc.min_purchase) {
      return res.status(400).json({ error: `Minimum purchase of ${pc.min_purchase} required` });
    }

    // Calculate eligible amount
    let eligibleAmount = subtotal;
    if (pc.applies_to === 'specific' && cart_items && cart_items.length) {
      const { rows: items } = await db.execute({ sql: `SELECT * FROM promotion_items WHERE promotion_id = ?`, args: [pc.promotion_id] });
      const productIds = items.filter(i => i.item_type === 'product').map(i => i.item_id);
      const categoryIds = items.filter(i => i.item_type === 'category').map(i => i.item_id);
      eligibleAmount = cart_items.reduce((sum, ci) => {
        if (productIds.includes(ci.product_id) || categoryIds.includes(ci.category_id)) {
          return sum + ci.price * ci.quantity;
        }
        return sum;
      }, 0);
      if (eligibleAmount === 0) return res.status(400).json({ error: 'No items in cart qualify for this promotion' });
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
router.post('/use-code', async (req, res) => {
  try {
    const { code_id } = req.body;
    await db.execute({ sql: 'UPDATE promotion_codes SET times_used = times_used + 1 WHERE id = ?', args: [code_id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
