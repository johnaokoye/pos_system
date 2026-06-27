const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { runCreditCheck } = require('./customers');

// AR summary - all credit-enabled customers with balances
router.get('/', async (req, res) => {
  try {
    const { rows: customers } = await db.execute({ sql: `SELECT c.id, c.customer_number, c.first_name, c.last_name, c.email, c.phone, c.credit_limit, c.account_balance, c.credit_enabled, COUNT(DISTINCT t.id) as credit_invoices, COALESCE(SUM(CASE WHEN t.status = 'completed' AND t.payment_method = 'credit' THEN t.total ELSE 0 END), 0) as total_invoiced, COALESCE((SELECT SUM(p.amount) FROM account_payments p WHERE p.customer_id = c.id), 0) as total_paid FROM customers c LEFT JOIN transactions t ON c.id = t.customer_id AND t.payment_method = 'credit' AND t.status = 'completed' WHERE c.credit_enabled = 1 AND c.active = 1 GROUP BY c.id ORDER BY c.account_balance DESC, c.last_name`, args: [] });
    res.json(customers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR aging report
router.get('/aging', async (req, res) => {
  try {
    const { rows: aging } = await db.execute({ sql: `
      SELECT c.id, c.customer_number, c.first_name || ' ' || c.last_name as customer_name,
        c.email, c.phone, c.account_balance,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) <= 30
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as current_30,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) BETWEEN 31 AND 60
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as days_31_60,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) BETWEEN 61 AND 90
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as days_61_90,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(t.created_at) AS INTEGER) > 90
          THEN MAX(0, t.total - COALESCE(alloc.total_allocated, 0)) ELSE 0 END), 0) as over_90
      FROM customers c
      LEFT JOIN transactions t ON c.id = t.customer_id AND t.payment_method = 'credit' AND t.status = 'completed'
      LEFT JOIN (SELECT transaction_id, SUM(amount) as total_allocated FROM payment_allocations GROUP BY transaction_id) alloc
        ON t.id = alloc.transaction_id
      WHERE c.credit_enabled = 1 AND c.active = 1
      GROUP BY c.id
      ORDER BY c.account_balance DESC`, args: [] });
    res.json(aging);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR summary stats
router.get('/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await db.execute({ sql: `SELECT COUNT(DISTINCT c.id) as credit_customers, COALESCE(SUM(c.account_balance), 0) as total_outstanding, COALESCE(SUM(CASE WHEN c.account_balance > c.credit_limit AND c.credit_limit > 0 THEN 1 ELSE 0 END), 0) as over_limit_count, COALESCE((SELECT SUM(amount) FROM account_payments WHERE date(created_at) = date('now')), 0) as payments_today FROM customers c WHERE c.credit_enabled = 1 AND c.active = 1`, args: [] });
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer account detail
router.get('/customer/:id', async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const { rows: invoices } = await db.execute({ sql: `SELECT t.id, t.transaction_number, t.total, t.status, t.created_at, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM transactions t LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN branches b ON t.branch_id = b.id WHERE t.customer_id = ? AND t.payment_method = 'credit' ORDER BY t.created_at DESC`, args: [req.params.id] });
    const { rows: payments } = await db.execute({ sql: `SELECT p.*, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM account_payments p LEFT JOIN employees e ON p.employee_id = e.id LEFT JOIN branches b ON p.branch_id = b.id WHERE p.customer_id = ? ORDER BY p.created_at DESC`, args: [req.params.id] });
    res.json({ customer, invoices, payments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enable/disable credit for a customer and set credit limit
router.patch('/customer/:id', async (req, res) => {
  try {
    const { credit_enabled, credit_limit } = req.body;
    const updates = [];
    const params = [];
    if (credit_enabled !== undefined) { updates.push('credit_enabled = ?'); params.push(credit_enabled ? 1 : 0); }
    if (credit_limit !== undefined) { updates.push('credit_limit = ?'); params.push(parseFloat(credit_limit)); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await db.execute({ sql: `UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, args: params });
    const { rows: [row] } = await db.execute({ sql: 'SELECT id, customer_number, first_name, last_name, credit_limit, account_balance, credit_enabled FROM customers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Outstanding invoices for a customer (with per-invoice balance_due)
router.get('/invoices/:customer_id', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT t.id, t.transaction_number, t.total, t.created_at,
              COALESCE(SUM(pa.amount), 0) as paid_amount,
              t.total - COALESCE(SUM(pa.amount), 0) as balance_due
            FROM transactions t
            LEFT JOIN payment_allocations pa ON t.id = pa.transaction_id
            WHERE t.customer_id = ? AND t.payment_method = 'credit' AND t.status = 'completed'
            GROUP BY t.id
            HAVING t.total - COALESCE(SUM(pa.amount), 0) > 0.001
            ORDER BY t.created_at ASC`,
      args: [req.params.customer_id]
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Allocations for a specific payment
router.get('/payments/:id/allocations', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT pa.*, t.transaction_number, t.total as invoice_total, t.created_at as invoice_date
            FROM payment_allocations pa
            LEFT JOIN transactions t ON pa.transaction_id = t.id
            WHERE pa.payment_id = ?
            ORDER BY t.created_at ASC`,
      args: [req.params.id]
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Record a payment from a customer
router.post('/payments', async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, amount, payment_method, notes, allocations } = req.body;
    if (!customer_id || !amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'customer_id and positive amount required' });

    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customer_id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM account_payments', args: [] });
    const payment_number = `PMT-${String(Number(count.c) + 1).padStart(6, '0')}`;
    const amt = parseFloat(parseFloat(amount).toFixed(2));

    // Build allocations: use provided or auto-FIFO oldest-first
    let finalAllocations = [];
    if (allocations && Array.isArray(allocations) && allocations.length > 0) {
      finalAllocations = allocations.filter(a => parseFloat(a.amount) > 0).map(a => ({ transaction_id: parseInt(a.transaction_id), amount: parseFloat(parseFloat(a.amount).toFixed(2)) }));
    } else {
      const { rows: invoices } = await db.execute({
        sql: `SELECT t.id, t.total, COALESCE(SUM(pa.amount), 0) as paid_amount
              FROM transactions t
              LEFT JOIN payment_allocations pa ON t.id = pa.transaction_id
              WHERE t.customer_id = ? AND t.payment_method = 'credit' AND t.status = 'completed'
              GROUP BY t.id
              HAVING t.total - COALESCE(SUM(pa.amount), 0) > 0.001
              ORDER BY t.created_at ASC`,
        args: [customer_id]
      });
      let remaining = amt;
      for (const inv of invoices) {
        if (remaining <= 0.001) break;
        const balance = parseFloat((inv.total - inv.paid_amount).toFixed(2));
        const apply = parseFloat(Math.min(remaining, balance).toFixed(2));
        finalAllocations.push({ transaction_id: inv.id, amount: apply });
        remaining = parseFloat((remaining - apply).toFixed(2));
      }
    }

    const payTx = await db.transaction('write');
    try {
      const result = await payTx.execute({ sql: 'INSERT INTO account_payments (payment_number,customer_id,employee_id,branch_id,amount,payment_method,notes) VALUES (?,?,?,?,?,?,?)', args: [payment_number, customer_id, employee_id||null, branch_id||null, amt, payment_method||'cash', notes||null] });
      const payId = Number(result.lastInsertRowid);
      for (const alloc of finalAllocations) {
        await payTx.execute({ sql: 'INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES (?,?,?)', args: [payId, alloc.transaction_id, alloc.amount] });
      }
      await payTx.execute({ sql: 'UPDATE customers SET account_balance = MAX(0, account_balance - ?) WHERE id = ?', args: [amt, customer_id] });
      await payTx.commit();

      const { rows: [payRow] } = await db.execute({ sql: `SELECT p.*, c.first_name || ' ' || c.last_name as customer_name FROM account_payments p LEFT JOIN customers c ON p.customer_id = c.id WHERE p.id = ?`, args: [payId] });
      await runCreditCheck(customer_id);
      res.status(201).json(payRow);
    } catch(e) {
      await payTx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List payments
router.get('/payments', async (req, res) => {
  try {
    const { customer_id, start, end, limit = 200, sort = 'desc' } = req.query;
    let sql = `SELECT p.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name FROM account_payments p LEFT JOIN customers c ON p.customer_id = c.id LEFT JOIN employees e ON p.employee_id = e.id LEFT JOIN branches b ON p.branch_id = b.id WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ' AND p.customer_id = ?'; params.push(customer_id); }
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    sql += ` ORDER BY p.created_at ${sort === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`;
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
