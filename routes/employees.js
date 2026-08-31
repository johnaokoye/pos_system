const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { createSession, destroySession, setSessionCookie, clearSessionCookie, readCookie } = require('../lib/sessionAuth');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

// True once a password has been migrated to a bcrypt hash (bcryptjs always
// produces $2a$/$2b$-prefixed output). Plaintext legacy passwords never
// start with '$2', which is what makes the lazy migration below safe.
function isBcryptHash(value) {
  return typeof value === 'string' && value.startsWith('$2');
}

// requireAuth only, not requirePermission('employees') — this list is used
// as a general employee-picker lookup across ~13 unrelated features (CRM,
// commissions, security groups, etc.), not just the Employees management
// screen itself. Restricting it to the `employees` permission would break
// every one of those pickers for roles that don't manage employees.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: employees } = await db.execute({ sql: `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.username, e.role, e.active, e.created_at, e.security_group_id, e.default_branch_id, e.must_change_password, e.is_driver, e.is_operator, e.is_security, e.is_salesperson, sg.name as security_group_name, b.name as default_branch_name
      FROM employees e
      LEFT JOIN security_groups sg ON e.security_group_id = sg.id
      LEFT JOIN branches b ON e.default_branch_id = b.id
      ORDER BY e.first_name`, args: [] });
    // One batched query for every employee's branches instead of one query
    // per employee — this list is a lookup used across ~13 unrelated
    // features (see comment above), so it's hit constantly.
    if (employees.length) {
      const placeholders = employees.map(() => '?').join(',');
      const { rows: allBranches } = await db.execute({
        sql: `SELECT eb.employee_id, b.id, b.branch_code, b.name, eb.is_default FROM branches b JOIN employee_branches eb ON b.id = eb.branch_id WHERE eb.employee_id IN (${placeholders})`,
        args: employees.map(e => e.id),
      });
      const byEmployee = {};
      for (const row of allBranches) { (byEmployee[row.employee_id] = byEmployee[row.employee_id] || []).push(row); }
      for (const emp of employees) emp.branches = byEmployee[emp.id] || [];

      const { rows: allSkills } = await db.execute({
        sql: `SELECT es.employee_id, ts.id, ts.name FROM technician_skills ts JOIN employee_skills es ON ts.id = es.skill_id WHERE es.employee_id IN (${placeholders})`,
        args: employees.map(e => e.id),
      });
      const skillsByEmployee = {};
      for (const row of allSkills) { (skillsByEmployee[row.employee_id] = skillsByEmployee[row.employee_id] || []).push(row); }
      for (const emp of employees) emp.skills = skillsByEmployee[emp.id] || [];
    }
    res.json(employees);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Matches the "+ Add Employee" button's actual frontend gate — it's shown
// to anyone with the `employees` module permission, not a finer sub-key
// (the tree defines employees_add/_edit/_delete but the UI never checks
// them individually), so enforcing a sub-key here would 403 users the UI
// itself let through.
router.post('/', requirePermission('employees'), async (req, res) => {
  const { first_name, last_name, username, pin, password, must_change_password, security_group_id, default_branch_id, is_driver, is_operator, is_security, is_salesperson, skill_ids } = req.body;
  if (!first_name || !last_name || !username || !pin) return res.status(400).json({ error: 'Required fields missing' });
  try {
    const employee_number = await nextNumber(db, 'employees', 'employee_number', 'EMP-', 4);
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const result = await db.execute({ sql: 'INSERT INTO employees (employee_number,first_name,last_name,username,pin,password,must_change_password,security_group_id,default_branch_id,is_driver,is_operator,is_security,is_salesperson) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [employee_number, first_name, last_name, username, pin, passwordHash, must_change_password ? 1 : 0, security_group_id || null, default_branch_id || null, is_driver ? 1 : 0, is_operator ? 1 : 0, is_security ? 1 : 0, is_salesperson ? 1 : 0] });
    const newId = Number(result.lastInsertRowid);
    if (default_branch_id) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [newId, default_branch_id] });
    }
    if (Array.isArray(skill_ids)) {
      for (const skillId of skill_ids) {
        await db.execute({ sql: 'INSERT OR IGNORE INTO employee_skills (employee_id, skill_id) VALUES (?,?)', args: [newId, skillId] });
      }
    }
    const { rows: [emp] } = await db.execute({ sql: `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.username,e.role,e.active,e.security_group_id,e.default_branch_id,e.is_driver,e.is_operator,e.is_security,e.is_salesperson,sg.name as security_group_name,b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id LEFT JOIN branches b ON e.default_branch_id=b.id WHERE e.id=?`, args: [newId] });
    res.status(201).json(emp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Requires a valid session — closes the previous gap where this endpoint
// accepted completely unauthenticated password resets for any employee id.
// The frontend's change-password modal only collects a new password (no old
// password field), so this doesn't re-verify the old one; a self-only /
// employees_edit-gated restriction is folded into the broader per-route
// permission rollout for this file rather than added ad hoc here.
router.put('/:id/change-password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.execute({ sql: 'UPDATE employees SET password=?,must_change_password=0 WHERE id=?', args: [hash, req.params.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Same reasoning as POST / above — matches the "Edit" button's actual gate.
router.put('/:id', requirePermission('employees'), async (req, res) => {
  const { first_name, last_name, username, pin, password, must_change_password, active, security_group_id, default_branch_id, is_driver, is_operator, is_security, is_salesperson, skill_ids } = req.body;
  try {
    // The edit form omits `password` entirely when left blank ("leave blank
    // to keep") — preserve the existing (already-hashed) value in that case
    // instead of overwriting it with NULL, and hash a newly-provided one.
    let passwordToStore;
    if (password) {
      passwordToStore = await bcrypt.hash(password, 10);
    } else {
      const { rows: [existing] } = await db.execute({ sql: 'SELECT password FROM employees WHERE id = ?', args: [req.params.id] });
      passwordToStore = existing ? existing.password : null;
    }
    if (pin) {
      await db.execute({ sql: 'UPDATE employees SET first_name=?,last_name=?,username=?,pin=?,password=?,must_change_password=?,active=?,security_group_id=?,default_branch_id=?,is_driver=?,is_operator=?,is_security=?,is_salesperson=? WHERE id=?', args: [first_name, last_name, username, pin, passwordToStore, must_change_password?1:0, active??1, security_group_id||null, default_branch_id||null, is_driver?1:0, is_operator?1:0, is_security?1:0, is_salesperson?1:0, req.params.id] });
    } else {
      await db.execute({ sql: 'UPDATE employees SET first_name=?,last_name=?,username=?,password=?,must_change_password=?,active=?,security_group_id=?,default_branch_id=?,is_driver=?,is_operator=?,is_security=?,is_salesperson=? WHERE id=?', args: [first_name, last_name, username, passwordToStore, must_change_password?1:0, active??1, security_group_id||null, default_branch_id||null, is_driver?1:0, is_operator?1:0, is_security?1:0, is_salesperson?1:0, req.params.id] });
    }
    if (default_branch_id) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [req.params.id, default_branch_id] });
      await db.execute({ sql: 'UPDATE employee_branches SET is_default = CASE WHEN branch_id = ? THEN 1 ELSE 0 END WHERE employee_id = ?', args: [default_branch_id, req.params.id] });
    }
    if (Array.isArray(skill_ids)) {
      await db.execute({ sql: 'DELETE FROM employee_skills WHERE employee_id = ?', args: [req.params.id] });
      for (const skillId of skill_ids) {
        await db.execute({ sql: 'INSERT OR IGNORE INTO employee_skills (employee_id, skill_id) VALUES (?,?)', args: [req.params.id, skillId] });
      }
    }
    const { rows: [emp] } = await db.execute({ sql: `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.username,e.role,e.active,e.security_group_id,e.default_branch_id,e.is_driver,e.is_operator,e.is_security,e.is_salesperson,sg.name as security_group_name,b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id LEFT JOIN branches b ON e.default_branch_id=b.id WHERE e.id=?`, args: [req.params.id] });
    res.json(emp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// requireAuth only — this is an elevated-reauth helper used from many
// different features to validate a *different* employee's PIN (e.g. a
// manager override), not gated by any single permission of its own.
router.post('/validate-pin', requireAuth, async (req, res) => {
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
    res.json({ authorized: true, id: authorizer.id, name: `${authorizer.first_name} ${authorizer.last_name}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { username, pin, password } = req.body;
    let emp = null;
    if (password) {
      const { rows: [row] } = await db.execute({ sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.password, e.role, e.must_change_password, e.security_group_id, e.default_branch_id, e.is_driver, e.is_operator, e.is_security, e.is_salesperson, sg.name as security_group_name, sg.permissions, b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id LEFT JOIN branches b ON e.default_branch_id = b.id WHERE e.username=? AND e.active=1`, args: [username] });
      if (row) {
        // Lazy bcrypt migration: legacy plaintext passwords are compared
        // directly once, then immediately rehashed on success so every
        // subsequent login uses bcrypt.compare — no forced mass reset.
        const stored = row.password;
        let ok = false;
        if (isBcryptHash(stored)) {
          ok = await bcrypt.compare(password, stored);
        } else {
          ok = stored != null && password === stored;
          if (ok) {
            const newHash = await bcrypt.hash(password, 10);
            await db.execute({ sql: 'UPDATE employees SET password = ? WHERE id = ?', args: [newHash, row.id] });
          }
        }
        if (ok) { delete row.password; emp = row; }
      }
    } else if (pin) {
      const { rows: [row] } = await db.execute({ sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.role, e.must_change_password, e.security_group_id, e.default_branch_id, e.is_driver, e.is_operator, e.is_security, e.is_salesperson, sg.name as security_group_name, sg.permissions, b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id LEFT JOIN branches b ON e.default_branch_id = b.id WHERE e.username=? AND e.pin=? AND e.active=1`, args: [username, pin] });
      emp = row || null;
    }
    if (!emp) return res.status(401).json({ error: 'Invalid credentials' });
    if (emp.permissions) emp.permissions = JSON.parse(emp.permissions);
    if (emp.permissions && emp.permissions.multi_branch_access) {
      // multi_branch_access on the security group is the whole gate — every
      // active branch is available, not just whatever happens to be in
      // employee_branches (that join table has no UI to manage beyond
      // "Default Branch," so it was never a reliable per-employee allowlist).
      // The employee's own default_branch_id still drives which one is
      // pre-selected in every branch picker that reads is_default.
      const { rows: branches } = await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, b.currency, CASE WHEN b.id = ? THEN 1 ELSE 0 END as is_default FROM branches b WHERE b.active = 1 ORDER BY b.name`, args: [emp.default_branch_id || null] });
      emp.branches = branches;
    } else {
      emp.branches = emp.default_branch_id
        ? (await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, b.currency, 1 as is_default FROM branches b WHERE b.id = ?`, args: [emp.default_branch_id] })).rows
        : [];
    }
    const token = await createSession(emp.id);
    setSessionCookie(req, res, token);
    res.json(emp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    await destroySession(readCookie(req));
    clearSessionCookie(res);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
