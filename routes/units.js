const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requireAnyPermission } = require('../lib/permissions');

// Units of measure (lib/units.js). Listing is open to any signed-in user —
// the product form, POS and quotes all need the names; managing the list
// needs inventory_units (or settings), like categories and brands.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT u.*,
      (SELECT COUNT(*) FROM product_units pu WHERE pu.unit_id = u.id) + (SELECT COUNT(*) FROM products p WHERE p.base_unit_id = u.id) as product_count
      FROM units_of_measure u ORDER BY u.active DESC, u.name`, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const fields = body => ({
  name: String(body.name || '').trim(),
  abbreviation: String(body.abbreviation || '').trim() || null,
  allow_decimal: body.allow_decimal ? 1 : 0,
  active: body.active === undefined ? 1 : (body.active ? 1 : 0),
});

router.post('/', requireAnyPermission('settings', 'inventory_units'), async (req, res) => {
  const f = fields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await db.execute({ sql: 'INSERT INTO units_of_measure (name, abbreviation, allow_decimal, active) VALUES (?,?,?,?)', args: [f.name, f.abbreviation, f.allow_decimal, f.active] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM units_of_measure WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'A unit with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Renaming is safe — past lines keep the name they were sold under.
router.put('/:id', requireAnyPermission('settings', 'inventory_units'), async (req, res) => {
  const f = fields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rowsAffected } = await db.execute({ sql: 'UPDATE units_of_measure SET name=?, abbreviation=?, allow_decimal=?, active=? WHERE id=?', args: [f.name, f.abbreviation, f.allow_decimal, f.active, req.params.id] });
    if (!rowsAffected) return res.status(404).json({ error: 'Unit not found' });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM units_of_measure WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'A unit with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Only an unused unit can be deleted; one in use can be made inactive instead.
router.delete('/:id', requireAnyPermission('settings', 'inventory_units'), async (req, res) => {
  try {
    const { rows: [{ c }] } = await db.execute({ sql: 'SELECT (SELECT COUNT(*) FROM product_units WHERE unit_id = ?) + (SELECT COUNT(*) FROM products WHERE base_unit_id = ?) as c', args: [req.params.id, req.params.id] });
    if (Number(c) > 0) return res.status(400).json({ error: 'This unit is used by products — make it inactive instead' });
    await db.execute({ sql: 'DELETE FROM units_of_measure WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
