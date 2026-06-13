const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  try {
    const { rows: employees } = await db.execute({ sql: `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.username, e.role, e.active, e.created_at, e.security_group_id, e.default_branch_id, e.must_change_password, sg.name as security_group_name, b.name as default_branch_name
      FROM employees e
      LEFT JOIN security_groups sg ON e.security_group_id = sg.id
      LEFT JOIN branches b ON e.default_branch_id = b.id
      ORDER BY e.first_name`, args: [] });
    for (const emp of employees) {
      const { rows: branches } = await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, eb.is_default FROM branches b JOIN employee_branches eb ON b.id = eb.branch_id WHERE eb.employee_id = ?`, args: [emp.id] });
      emp.branches = branches;
    }
    res.json(employees);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { first_name, last_name, username, pin, password, must_change_password, security_group_id, default_branch_id } = req.body;
  if (!first_name || !last_name || !username || !pin) return res.status(400).json({ error: 'Required fields missing' });
  try {
    const { rows: [num] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employees', args: [] });
    const employee_number = `EMP-${String(Number(num.c) + 1).padStart(4, '0')}`;
    const result = await db.execute({ sql: 'INSERT INTO employees (employee_number,first_name,last_name,username,pin,password,must_change_password,security_group_id,default_branch_id) VALUES (?,?,?,?,?,?,?,?,?)', args: [employee_number, first_name, last_name, username, pin, password || null, must_change_password ? 1 : 0, security_group_id || null, default_branch_id || null] });
    const newId = Number(result.lastInsertRowid);
    if (default_branch_id) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [newId, default_branch_id] });
    }
    const { rows: [emp] } = await db.execute({ sql: `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.username,e.role,e.active,e.security_group_id,e.default_branch_id,sg.name as security_group_name,b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id LEFT JOIN branches b ON e.default_branch_id=b.id WHERE e.id=?`, args: [newId] });
    res.status(201).json(emp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id/change-password', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });
  try {
    await db.execute({ sql: 'UPDATE employees SET password=?,must_change_password=0 WHERE id=?', args: [password, req.params.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { first_name, last_name, username, pin, password, must_change_password, active, security_group_id, default_branch_id } = req.body;
  try {
    if (pin) {
      await db.execute({ sql: 'UPDATE employees SET first_name=?,last_name=?,username=?,pin=?,password=?,must_change_password=?,active=?,security_group_id=?,default_branch_id=? WHERE id=?', args: [first_name, last_name, username, pin, password||null, must_change_password?1:0, active??1, security_group_id||null, default_branch_id||null, req.params.id] });
    } else {
      await db.execute({ sql: 'UPDATE employees SET first_name=?,last_name=?,username=?,password=?,must_change_password=?,active=?,security_group_id=?,default_branch_id=? WHERE id=?', args: [first_name, last_name, username, password||null, must_change_password?1:0, active??1, security_group_id||null, default_branch_id||null, req.params.id] });
    }
    if (default_branch_id) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [req.params.id, default_branch_id] });
      await db.execute({ sql: 'UPDATE employee_branches SET is_default = CASE WHEN branch_id = ? THEN 1 ELSE 0 END WHERE employee_id = ?', args: [default_branch_id, req.params.id] });
    }
    const { rows: [emp] } = await db.execute({ sql: `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.username,e.role,e.active,e.security_group_id,e.default_branch_id,sg.name as security_group_name,b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id LEFT JOIN branches b ON e.default_branch_id=b.id WHERE e.id=?`, args: [req.params.id] });
    res.json(emp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/validate-pin', async (req, res) => {
  try {
    const { pin, permission } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN is required' });
    const { rows: employees } = await db.execute({ sql: 'SELECT e.id, e.first_name, e.last_name, e.pin, sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.active = 1', args: [] });
    const authorizer = employees.find(e => {
      if (e.pin !== String(pin)) return false;
      if (!permission) return true;
      try { const p = JSON.parse(e.permissions || '{}'); return p[permission] === true; } catch { return false; }
    });
    if (!authorizer) return res.status(403).json({ error: 'Invalid PIN or insufficient privilege' });
    res.json({ authorized: true, name: `${authorizer.first_name} ${authorizer.last_name}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { username, pin, password } = req.body;
    let emp = null;
    if (password) {
      const { rows: [row] } = await db.execute({ sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.role, e.must_change_password, e.security_group_id, e.default_branch_id, sg.name as security_group_name, sg.permissions, b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id LEFT JOIN branches b ON e.default_branch_id = b.id WHERE e.username=? AND e.password=? AND e.active=1`, args: [username, password] });
      emp = row || null;
    } else if (pin) {
      const { rows: [row] } = await db.execute({ sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.role, e.must_change_password, e.security_group_id, e.default_branch_id, sg.name as security_group_name, sg.permissions, b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id LEFT JOIN branches b ON e.default_branch_id = b.id WHERE e.username=? AND e.pin=? AND e.active=1`, args: [username, pin] });
      emp = row || null;
    }
    if (!emp) return res.status(401).json({ error: 'Invalid credentials' });
    if (emp.permissions) emp.permissions = JSON.parse(emp.permissions);
    if (emp.permissions && emp.permissions.multi_branch_access) {
      const { rows: branches } = await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, b.currency, eb.is_default FROM branches b JOIN employee_branches eb ON b.id = eb.branch_id WHERE eb.employee_id = ?`, args: [emp.id] });
      emp.branches = branches;
    } else {
      emp.branches = emp.default_branch_id
        ? (await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, b.currency, 1 as is_default FROM branches b WHERE b.id = ?`, args: [emp.default_branch_id] })).rows
        : [];
    }
    res.json(emp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
