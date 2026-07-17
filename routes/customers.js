const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

// Check if a credit customer has exceeded their payment terms and block/unblock accordingly
async function runCreditCheck(customerId) {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customerId] });
    if (!customer || customer.customer_type !== 'credit') return;

    if (customer.account_balance <= 0) {
      await db.execute({ sql: 'UPDATE customers SET account_blocked = 0 WHERE id = ?', args: [customerId] });
      return;
    }

    const { rows: [oldest] } = await db.execute({ sql: `SELECT MIN(created_at) as oldest_date FROM transactions WHERE customer_id = ? AND payment_method = 'credit' AND status = 'completed'`, args: [customerId] });

    if (!oldest || !oldest.oldest_date) return;

    const daysSince = Math.floor((Date.now() - new Date(oldest.oldest_date).getTime()) / 86400000);
    const exceeded = daysSince > (customer.credit_terms_days || 30);
    await db.execute({ sql: 'UPDATE customers SET account_blocked = ? WHERE id = ?', args: [exceeded ? 1 : 0, customerId] });
  } catch(e) {}
}

// Same logic as runCreditCheck above, but for a whole batch of customers in
// a bounded number of queries (1 SELECT + up to 2 UPDATEs) instead of one
// runCreditCheck() call per customer — GET / below runs this on every
// request (it's used broadly: POS customer picker, CRM, accounts, not just
// the Customers screen), so a per-customer loop here would get slower with
// every credit customer added. Only ever called with ids that already
// passed the `account_balance > 0` filter, so (unlike runCreditCheck) there's
// no "already at zero balance, unblock" branch to replicate.
async function runCreditCheckBatch(customerIds) {
  if (!customerIds.length) return;
  try {
    const placeholders = customerIds.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `SELECT c.id, c.credit_terms_days,
              (SELECT MIN(created_at) FROM transactions WHERE customer_id = c.id AND payment_method = 'credit' AND status = 'completed') as oldest_date
            FROM customers c WHERE c.id IN (${placeholders})`,
      args: customerIds,
    });
    const exceededIds = [], okIds = [];
    for (const r of rows) {
      if (!r.oldest_date) continue;
      const daysSince = Math.floor((Date.now() - new Date(r.oldest_date).getTime()) / 86400000);
      (daysSince > (r.credit_terms_days || 30) ? exceededIds : okIds).push(r.id);
    }
    if (exceededIds.length) await db.execute({ sql: `UPDATE customers SET account_blocked = 1 WHERE id IN (${exceededIds.map(() => '?').join(',')})`, args: exceededIds });
    if (okIds.length) await db.execute({ sql: `UPDATE customers SET account_blocked = 0 WHERE id IN (${okIds.map(() => '?').join(',')})`, args: okIds });
  } catch(e) {}
}

// requireAuth only — used broadly (POS customer picker, CRM, accounts),
// not just the Customers management screen itself.
router.get('/', requireAuth, async (req, res) => {
  try {
    // Auto-block any overdue credit customers before returning list
    const { rows: overdue } = await db.execute({ sql: "SELECT id FROM customers WHERE customer_type = 'credit' AND active = 1 AND account_balance > 0", args: [] });
    await runCreditCheckBatch(overdue.map(c => c.id));

    const { search, active } = req.query;
    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (search) {
      sql += ` AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR customer_number LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (active !== undefined) { sql += ' AND active = ?'; params.push(active); }
    sql += ' ORDER BY last_name, first_name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    await runCreditCheck(req.params.id);
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    const { rows: transactions } = await db.execute({ sql: 'SELECT * FROM transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', args: [req.params.id] });
    res.json({ ...updated, recent_transactions: transactions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let sql = 'SELECT * FROM transactions WHERE customer_id = ?';
    const args = [req.params.id];
    if (start) { sql += ' AND date(created_at) >= ?'; args.push(start); }
    if (end) { sql += ' AND date(created_at) <= ?'; args.push(end); }
    sql += ' ORDER BY created_at DESC';
    const { rows: transactions } = await db.execute({ sql, args });
    res.json(transactions);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('customers'), async (req, res) => {
  const { first_name, last_name, email, phone, address, city, state, zip, notes, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
  try {
    const customer_number = await nextNumber(db, 'customers', 'customer_number', 'CUST-', 4);
    const type = customer_type || 'cash';
    const creditEnabled = type === 'credit' ? 1 : 0;
    const terms = parseInt(credit_terms_days) || 30;
    const limit = parseFloat(credit_limit) || 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const result = await db.execute({ sql: `INSERT INTO customers (customer_number,first_name,last_name,email,phone,address,city,state,zip,notes,customer_type,credit_terms_days,credit_limit,credit_enabled,tax_exempt,tax_exemption_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [customer_number, first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('customers'), async (req, res) => {
  const { first_name, last_name, email, phone, address, city, state, zip, notes, active, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number } = req.body;
  try {
    const type = customer_type || 'cash';
    const creditEnabled = type === 'credit' ? 1 : 0;
    const terms = parseInt(credit_terms_days) || 30;
    const limit = parseFloat(credit_limit) || 0;
    const taxExempt = tax_exempt ? 1 : 0;
    await db.execute({ sql: `UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,notes=?,active=?,customer_type=?,credit_terms_days=?,credit_limit=?,credit_enabled=?,tax_exempt=?,tax_exemption_number=? WHERE id=?`, args: [first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, active??1, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null, req.params.id] });
    if (type === 'cash') {
      await db.execute({ sql: 'UPDATE customers SET account_blocked = 0 WHERE id = ?', args: [req.params.id] });
    } else {
      await runCreditCheck(req.params.id);
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('customers'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE customers SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.runCreditCheck = runCreditCheck;
