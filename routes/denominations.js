const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

// requireAuth only — used during routine drawer reconciliation (note counts)
// by any cashier, not just Settings management.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { currency } = req.query;
    let sql = 'SELECT * FROM currency_denominations WHERE active = 1';
    const params = [];
    if (currency) { sql += ' AND currency = ?'; params.push(currency); }
    sql += ' ORDER BY currency, sort_order, value DESC';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/all', requirePermission('settings'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM currency_denominations ORDER BY currency, sort_order, value DESC', args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('settings'), async (req, res) => {
  try {
    const { currency, value, label, sort_order } = req.body;
    if (!currency || value == null || !label) return res.status(400).json({ error: 'currency, value and label required' });
    const { rows: [existing] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM currency_denominations WHERE currency=? AND value=?', args: [currency, value] });
    if (Number(existing.c) > 0) return res.status(400).json({ error: 'Denomination already exists for this currency' });
    const { rows: [maxRow] } = await db.execute({ sql: 'SELECT COALESCE(MAX(sort_order),0) as m FROM currency_denominations WHERE currency=?', args: [currency] });
    const maxOrder = maxRow.m;
    const result = await db.execute({ sql: 'INSERT INTO currency_denominations (currency, value, label, sort_order) VALUES (?,?,?,?)', args: [currency, value, label, sort_order ?? maxOrder + 1] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM currency_denominations WHERE id=?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermission('settings'), async (req, res) => {
  try {
    const { label, sort_order, active } = req.body;
    await db.execute({ sql: 'UPDATE currency_denominations SET label=?, sort_order=?, active=? WHERE id=?', args: [label, sort_order ?? 0, active ?? 1, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM currency_denominations WHERE id=?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('settings'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE currency_denominations SET active=0 WHERE id=?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
