const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

// requireAuth only — branches are used as a dropdown/lookup across nearly
// every form in the app (employees, products, POS branch bar, etc.), not
// just the Branches management screen.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: branches } = await db.execute({ sql: 'SELECT * FROM branches ORDER BY name', args: [] });
    for (const b of branches) {
      const { rows: [countRow] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employee_branches WHERE branch_id = ?', args: [b.id] });
      b.employee_count = Number(countRow.c);
    }
    res.json(branches);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('branches'), async (req, res) => {
  try {
    const { rows: [branch] } = await db.execute({ sql: 'SELECT * FROM branches WHERE id = ?', args: [req.params.id] });
    if (!branch) return res.status(404).json({ error: 'Not found' });
    const { rows: employees } = await db.execute({ sql: `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.username, eb.is_default, sg.name as security_group_name FROM employees e JOIN employee_branches eb ON e.id = eb.employee_id LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE eb.branch_id = ? AND e.active = 1`, args: [req.params.id] });
    branch.employees = employees;
    res.json(branch);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('branches'), async (req, res) => {
  const { name, address, city, state, zip, phone, email, manager, currency } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM branches', args: [] });
    const branch_code = `BR-${String(Number(count.c) + 1).padStart(3, '0')}`;
    const result = await db.execute({ sql: 'INSERT INTO branches (branch_code,name,address,city,state,zip,phone,email,manager,currency) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [branch_code, name, address||null, city||null, state||null, zip||null, phone||null, email||null, manager||null, currency||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM branches WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('branches'), async (req, res) => {
  const { name, address, city, state, zip, phone, email, manager, active, currency, is_warehouse } = req.body;
  try {
    await db.execute({ sql: 'UPDATE branches SET name=?,address=?,city=?,state=?,zip=?,phone=?,email=?,manager=?,active=?,currency=?,is_warehouse=? WHERE id=?', args: [name, address||null, city||null, state||null, zip||null, phone||null, email||null, manager||null, active??1, currency||null, is_warehouse?1:0, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM branches WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requirePermission('branches'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE branches SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Assign employee to branch
router.post('/:id/employees', requirePermission('branches'), async (req, res) => {
  const { employee_id, is_default } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  try {
    await db.execute({ sql: 'INSERT OR REPLACE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,?)', args: [employee_id, req.params.id, is_default ? 1 : 0] });
    if (is_default) {
      await db.execute({ sql: 'UPDATE employees SET default_branch_id = ? WHERE id = ?', args: [req.params.id, employee_id] });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Remove employee from branch
router.delete('/:id/employees/:empId', requirePermission('branches'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM employee_branches WHERE branch_id = ? AND employee_id = ?', args: [req.params.id, req.params.empId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all employees not yet assigned to this branch
router.get('/:id/available-employees', requirePermission('branches'), async (req, res) => {
  try {
    const { rows: employees } = await db.execute({ sql: `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.username FROM employees e WHERE e.active = 1 AND e.id NOT IN (SELECT employee_id FROM employee_branches WHERE branch_id = ?) ORDER BY e.first_name`, args: [req.params.id] });
    res.json(employees);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
