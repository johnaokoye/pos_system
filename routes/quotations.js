const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { calcCommission } = require('./commissions');
const { requirePermission } = require('../lib/permissions');

router.use(requirePermission('quotations'));

router.get('/', async (req, res) => {
  try {
    const { status, customer_id, quote_number, start, end, limit = 100 } = req.query;
    let sql = `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, t.transaction_number as converted_tx_number FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND q.status = ?'; params.push(status); }
    if (customer_id) { sql += ' AND q.customer_id = ?'; params.push(customer_id); }
    if (quote_number) { sql += ' AND q.quote_number LIKE ?'; params.push(`%${quote_number}%`); }
    if (start) { sql += ' AND date(q.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(q.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY q.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.email as customer_email, c.phone as customer_phone, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, t.transaction_number as converted_tx_number FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id WHERE q.id = ?`, args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ?', args: [req.params.id] });
    quote.items = items;
    res.json(quote);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });

    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM quotations', args: [] });
    const quote_number = `QT-${String(Number(count.c) + 1).padStart(6, '0')}`;

    let subtotal = 0, tax_amount = 0;
    const processedItems = [];
    for (const item of items) {
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });
      const qty = parseInt(item.quantity || 1);
      const unit_price = parseFloat(item.unit_price || product.price);
      const lineTotal = parseFloat((unit_price * qty).toFixed(2));
      const lineTax = parseFloat((lineTotal * product.tax_rate / 100).toFixed(2));
      const lineDisc = parseFloat(item.discount || 0);
      subtotal += lineTotal;
      tax_amount += lineTax;
      processedItems.push({ product, qty, unit_price, lineTotal, lineTax, lineDisc });
    }
    subtotal = parseFloat(subtotal.toFixed(2));
    tax_amount = parseFloat(tax_amount.toFixed(2));
    const disc = parseFloat(discount_amount || 0);
    const total = parseFloat((subtotal + tax_amount - disc).toFixed(2));

    const tx = await db.transaction('write');
    try {
      const result = await tx.execute({ sql: 'INSERT INTO quotations (quote_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,notes,valid_until) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [quote_number, customer_id||null, employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, valid_until||null] });
      const quoteId = Number(result.lastInsertRowid);
      for (const { product, qty, unit_price, lineTotal, lineTax, lineDisc } of processedItems) {
        await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total) VALUES (?,?,?,?,?,?,?,?,?)', args: [quoteId, product.id, product.name, product.sku, qty, unit_price, lineDisc, lineTax, lineTotal] });
      }
      await tx.commit();
      const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quoteId] });
      const { rows: quoteItems } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ?', args: [quoteId] });
      quote.items = quoteItems;
      res.status(201).json(quote);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update quotation status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['draft', 'sent', 'accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [q] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!q) return res.status(404).json({ error: 'Not found' });
    if (q.status === 'converted') return res.status(400).json({ error: 'Cannot change status of converted quotation' });
    await db.execute({ sql: 'UPDATE quotations SET status = ? WHERE id = ?', args: [status, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Convert quotation to invoice (transaction)
router.post('/:id/convert', async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, branch_id } = req.body;
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Quotation not found' });
    if (quote.status === 'converted') return res.status(400).json({ error: 'Already converted to invoice' });
    if (quote.status === 'declined') return res.status(400).json({ error: 'Cannot convert declined quotation' });
    if (quote.status === 'cancelled') return res.status(400).json({ error: 'Cannot convert cancelled quotation' });

    const { rows: items } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ?', args: [quote.id] });
    if (!items.length) return res.status(400).json({ error: 'No items in quotation' });

    const method = payment_method || 'cash';
    const isCredit = method === 'credit';
    const tendered = parseFloat(amount_tendered || (isCredit ? 0 : quote.total));
    const change = isCredit ? 0 : parseFloat((tendered - quote.total).toFixed(2));

    const convTx = await db.transaction('write');
    try {
      const { rows: [txCount] } = await convTx.execute({ sql: 'SELECT COUNT(*) as c FROM transactions', args: [] });
      const transaction_number = `TXN-${String(Number(txCount.c) + 1).padStart(6, '0')}`;

      const result = await convTx.execute({ sql: 'INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,amount_tendered,change_amount,is_credit,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [transaction_number, quote.customer_id, employee_id||quote.employee_id||1, branch_id||quote.branch_id||null, quote.subtotal, quote.tax_amount, quote.discount_amount, quote.total, method, tendered, change > 0 ? change : 0, isCredit ? 1 : 0, `Converted from quotation ${quote.quote_number}`] });
      const txId = Number(result.lastInsertRowid);

      for (const item of items) {
        await convTx.execute({ sql: 'INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total) VALUES (?,?,?,?,?,?,?,?,?)', args: [txId, item.product_id, item.product_name, item.sku, item.quantity, item.unit_price, item.discount_amount, item.tax_amount, item.total] });
        if (item.product_id) {
          await convTx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [item.quantity, item.product_id] });
        }
      }

      if (quote.customer_id) {
        const loyaltyPts = Math.floor(quote.total * 0.5);
        await convTx.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, quote.total, quote.customer_id] });
        if (isCredit) {
          await convTx.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [quote.total, quote.customer_id] });
        }
      }

      await convTx.execute({ sql: 'UPDATE quotations SET status = ?, converted_to_tx = ? WHERE id = ?', args: ['converted', txId, quote.id] });
      await convTx.commit();

      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.id = ?`, args: [txId] });
      const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = txItems;

      // Auto-calculate commission on quote conversion
      try {
        const empId = employee_id || quote.employee_id;
        await calcCommission(empId, quote.total, 'quotation', quote.id, quote.quote_number);
      } catch(e) {}
      res.status(201).json(savedTx);
    } catch(e) {
      await convTx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
