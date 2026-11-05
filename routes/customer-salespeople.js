// Customers → Assign Salespeople: see lib/customerSalespeople.js.
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { csvEscape } = require('../lib/productIssues');
const { customerFilterWhere, buildPlan, planSummary, applyPlan, undoBatch } = require('../lib/customerSalespeople');

router.use(requirePermission('sales_manager'));

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

router.post('/preview', async (req, res) => {
  try { res.json(planSummary(await buildPlan(req.body))); } catch (e) { fail(res, e); }
});

router.post('/apply', async (req, res) => {
  try {
    const { batch_id, changes } = await applyPlan(req.body, req.employee?.id);
    res.status(201).json({ batch_id, changes });
  } catch (e) { fail(res, e); }
});

router.get('/batches', async (req, res) => {
  try {
    const { rows } = await db.execute(`SELECT b.*, e.first_name || ' ' || e.last_name AS employee_name, u.first_name || ' ' || u.last_name AS undone_by_name
      FROM customer_salesperson_batches b LEFT JOIN employees e ON e.id = b.employee_id LEFT JOIN employees u ON u.id = b.undone_by
      ORDER BY b.id DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT ch.customer_id, c.customer_number, c.first_name || ' ' || c.last_name AS customer_name,
        o.first_name || ' ' || o.last_name AS old_name, n.first_name || ' ' || n.last_name AS new_name
      FROM customer_salesperson_changes ch JOIN customers c ON c.id = ch.customer_id
      LEFT JOIN employees o ON o.id = ch.old_salesperson_id LEFT JOIN employees n ON n.id = ch.new_salesperson_id
      WHERE ch.batch_id = ? ORDER BY ch.id LIMIT 500`, args: [req.params.id] });
    res.json(rows);
  } catch (e) { fail(res, e); }
});

router.post('/batches/:id/undo', async (req, res) => {
  try { res.json(await undoBatch(Number(req.params.id), req.employee?.id)); } catch (e) { fail(res, e); }
});

// A sheet to edit and upload again, for the customers matching the filters.
router.get('/export', async (req, res) => {
  try {
    const { where, args } = customerFilterWhere(req.query);
    const { rows } = await db.execute({ sql: `SELECT c.customer_number, c.first_name || ' ' || c.last_name AS name, c.phone, e.first_name || ' ' || e.last_name AS salesperson
      FROM (SELECT * FROM customers WHERE ${where}) c LEFT JOIN employees e ON e.id = c.salesperson_id ORDER BY c.last_name, c.first_name, c.id`, args });
    const csv = [['Customer Number', 'Customer Name', 'Phone', 'Salesperson'], ...rows.map(r => [r.customer_number, r.name, r.phone, r.salesperson])]
      .map(row => row.map(csvEscape).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="customer-salespeople.csv"');
    res.send(csv);
  } catch (e) { fail(res, e); }
});

module.exports = router;
