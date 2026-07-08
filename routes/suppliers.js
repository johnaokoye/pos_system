const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

// requireAuth only — used as a dropdown lookup in Inventory/PO forms, not
// just the Suppliers management screen.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { search, active } = req.query;
    let sql = 'SELECT * FROM suppliers WHERE 1=1';
    const params = [];
    if (search) {
      sql += ' AND (name LIKE ? OR contact_name LIKE ? OR supplier_number LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (active !== undefined) {
      sql += ' AND active = ?';
      params.push(active === 'false' ? 0 : 1);
    } else {
      sql += ' AND active = 1';
    }
    sql += ' ORDER BY name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('suppliers'), async (req, res) => {
  try {
    const { rows: [supplier] } = await db.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [req.params.id] });
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    const { rows: recent_orders } = await db.execute({ sql: `SELECT po.*, b.name as branch_name FROM purchase_orders po LEFT JOIN branches b ON po.branch_id = b.id WHERE po.supplier_id = ? ORDER BY po.created_at DESC LIMIT 10`, args: [req.params.id] });
    supplier.recent_orders = recent_orders;
    res.json(supplier);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('suppliers'), async (req, res) => {
  const { name, contact_name, email, phone, address, city, state, zip, payment_terms, notes, is_local } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM suppliers', args: [] });
    const supplier_number = `SUP-${String(Number(count.c) + 1).padStart(4, '0')}`;
    const result = await db.execute({ sql: 'INSERT INTO suppliers (supplier_number,name,contact_name,email,phone,address,city,state,zip,payment_terms,notes,is_local) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [supplier_number, name, contact_name||null, email||null, phone||null, address||null, city||null, state||null, zip||null, payment_terms||'Net 30', notes||null, is_local?1:0] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('suppliers'), async (req, res) => {
  const { name, contact_name, email, phone, address, city, state, zip, payment_terms, notes, active, is_local } = req.body;
  try {
    await db.execute({ sql: 'UPDATE suppliers SET name=?,contact_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,payment_terms=?,notes=?,active=?,is_local=? WHERE id=?', args: [name, contact_name||null, email||null, phone||null, address||null, city||null, state||null, zip||null, payment_terms||'Net 30', notes||null, active??1, is_local?1:0, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requirePermission('suppliers'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE suppliers SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
