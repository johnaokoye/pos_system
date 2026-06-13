const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT * FROM security_groups ORDER BY name', args: [] });
    for (const g of groups) {
      g.permissions = JSON.parse(g.permissions || '{}');
      const { rows: [countRow] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employees WHERE security_group_id = ? AND active = 1', args: [g.id] });
      g.member_count = Number(countRow.c);
    }
    res.json(groups);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [group] } = await db.execute({ sql: 'SELECT * FROM security_groups WHERE id = ?', args: [req.params.id] });
    if (!group) return res.status(404).json({ error: 'Not found' });
    group.permissions = JSON.parse(group.permissions || '{}');
    const { rows: members } = await db.execute({ sql: 'SELECT id, employee_number, first_name, last_name, username, role FROM employees WHERE security_group_id = ? AND active = 1', args: [req.params.id] });
    group.members = members;
    res.json(group);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await db.execute({ sql: 'INSERT INTO security_groups (name, description, permissions) VALUES (?,?,?)', args: [name, description||null, JSON.stringify(permissions || {})] });
    const { rows: [group] } = await db.execute({ sql: 'SELECT * FROM security_groups WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    group.permissions = JSON.parse(group.permissions);
    res.status(201).json(group);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, description, permissions } = req.body;
  try {
    await db.execute({ sql: 'UPDATE security_groups SET name=?,description=?,permissions=? WHERE id=?', args: [name, description||null, JSON.stringify(permissions || {}), req.params.id] });
    const { rows: [group] } = await db.execute({ sql: 'SELECT * FROM security_groups WHERE id = ?', args: [req.params.id] });
    group.permissions = JSON.parse(group.permissions);
    res.json(group);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employees WHERE security_group_id = ? AND active = 1', args: [req.params.id] });
    if (Number(count.c) > 0) return res.status(400).json({ error: 'Cannot delete group with assigned employees. Reassign them first.' });
    await db.execute({ sql: 'DELETE FROM security_groups WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Assign employee to this security group
router.post('/:id/assign', async (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  try {
    await db.execute({ sql: 'UPDATE employees SET security_group_id = ? WHERE id = ?', args: [req.params.id, employee_id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remove employee from security group
router.delete('/:id/assign/:empId', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE employees SET security_group_id = NULL WHERE id = ? AND security_group_id = ?', args: [req.params.empId, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
