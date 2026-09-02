const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requireAnyPermission } = require('../lib/permissions');

// requireAuth only — brands are used as a filter/dropdown lookup across
// product-related features, not just brand management.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT b.*, COUNT(p.id) as product_count FROM brands b LEFT JOIN products p ON p.brand = b.name AND p.active = 1 GROUP BY b.id ORDER BY b.name', args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Brand management is reachable from Inventory — same permission story as
// categories.js.
router.post('/', requireAnyPermission('settings', 'inventory'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await db.execute({ sql: 'INSERT INTO brands (name, description) VALUES (?, ?)', args: [name.trim(), description || null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM brands WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'A brand with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAnyPermission('settings', 'inventory'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT name FROM brands WHERE id = ?', args: [req.params.id] });
    if (!existing) return res.status(404).json({ error: 'Brand not found' });
    const newName = name.trim();
    await db.execute({ sql: 'UPDATE brands SET name=?, description=? WHERE id=?', args: [newName, description || null, req.params.id] });
    // products.brand is a free-text copy of the name, not a FK — carry a
    // rename through to every product already tagged with the old name so
    // they don't silently fall off the managed list.
    if (newName !== existing.name) {
      await db.execute({ sql: 'UPDATE products SET brand = ? WHERE brand = ?', args: [newName, existing.name] });
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM brands WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'A brand with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAnyPermission('settings', 'inventory'), async (req, res) => {
  try {
    const { rows: [brand] } = await db.execute({ sql: 'SELECT name FROM brands WHERE id = ?', args: [req.params.id] });
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const { rows: [inUse] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM products WHERE brand = ?', args: [brand.name] });
    if (Number(inUse.c) > 0) return res.status(400).json({ error: 'Brand in use by products' });
    await db.execute({ sql: 'DELETE FROM brands WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
