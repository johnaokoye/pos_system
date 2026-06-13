const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT c.*, COUNT(p.id) as product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.active = 1 GROUP BY c.id ORDER BY c.name', args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: [name, description || null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM categories WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { name, description } = req.body;
  try {
    await db.execute({ sql: 'UPDATE categories SET name=?, description=? WHERE id=?', args: [name, description || null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM categories WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { rows: [inUse] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM products WHERE category_id = ?', args: [req.params.id] });
    if (Number(inUse.c) > 0) return res.status(400).json({ error: 'Category in use by products' });
    await db.execute({ sql: 'DELETE FROM categories WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
