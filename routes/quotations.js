const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { calcCommission } = require('./commissions');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

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

const QUOTE_ITEMS_SELECT = `SELECT qi.*, pr.pr_number as purchase_request_number, pr.status as purchase_request_status
  FROM quotation_items qi LEFT JOIN purchase_requests pr ON qi.purchase_request_id = pr.id WHERE qi.quote_id = ?`;

router.get('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.email as customer_email, c.phone as customer_phone, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, t.transaction_number as converted_tx_number FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id WHERE q.id = ?`, args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [req.params.id] });
    quote.items = items;
    res.json(quote);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Items either reference a real product (`product_id`) or are temporary,
// off-catalog lines (`description` + `unit_price`, no `product_id`) used to
// quote something not yet in inventory ("Q" items). Shared by create and edit.
// Temp items are taxed at the store's default rate (no product to read a
// rate from). `purchase_request_id` is carried through unchanged when an
// existing Q item is re-saved, so editing a quote doesn't spawn duplicate PRs.
async function processQuoteItems(items) {
  const { rows: [taxSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='tax_rate'", args: [] });
  const defaultTaxRate = parseFloat(taxSetting?.value) || 0;

  let subtotal = 0, tax_amount = 0;
  const processedItems = [];
  for (const item of items) {
    let product = null;
    if (item.product_id) {
      const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!p) throw new Error(`Product ${item.product_id} not found`);
      product = p;
    } else if (!item.description || !String(item.description).trim()) {
      throw new Error('Item must have a product_id or a description');
    }
    const qty = parseInt(item.quantity || 1);
    const unit_price = parseFloat(item.unit_price ?? (product ? product.price : 0));
    const lineTotal = parseFloat((unit_price * qty).toFixed(2));
    const lineTax = parseFloat((lineTotal * (product ? product.tax_rate : defaultTaxRate) / 100).toFixed(2));
    const lineDisc = parseFloat(item.discount || 0);
    subtotal += lineTotal;
    tax_amount += lineTax;
    processedItems.push({
      product_id: product ? product.id : null,
      product_name: product ? product.name : String(item.description).trim(),
      sku: product ? product.sku : null,
      is_temp_item: product ? 0 : 1,
      purchase_request_id: product ? null : (item.purchase_request_id || null),
      qty, unit_price, lineTotal, lineTax, lineDisc,
    });
  }
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax_amount: parseFloat(tax_amount.toFixed(2)),
    processedItems,
  };
}

// Flags every not-yet-flagged "Q" item on an accepted quote for Purchasing,
// in a single Purchase Request per quote (not one per item). Only runs once
// the customer has accepted the quote (their PO in hand) — never at
// create/edit time, since items are still in flux until then. If the quote
// already has a PR from an earlier accept (e.g. it was reverted to draft,
// edited with new Q items, then re-accepted), new items are appended to that
// same PR rather than spawning a second one.
async function flagQItemsForPurchasing(quote) {
  try {
    const { rows: unflagged } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ? AND is_temp_item = 1 AND purchase_request_id IS NULL', args: [quote.id] });
    if (!unflagged.length) return;

    const { rows: [existingLink] } = await db.execute({ sql: 'SELECT purchase_request_id FROM quotation_items WHERE quote_id = ? AND purchase_request_id IS NOT NULL LIMIT 1', args: [quote.id] });
    let prId = existingLink ? existingLink.purchase_request_id : null;

    if (!prId) {
      const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
      const result = await db.execute({
        sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, notes, required_date, request_type) VALUES (?,?,?,?,?,?)',
        args: [pr_number, quote.branch_id || null, quote.employee_id || null, `Auto-created from accepted quotation ${quote.quote_number} — customer PO received for its "Q" custom items`, quote.valid_until || null, 'sale_items']
      });
      prId = Number(result.lastInsertRowid);
    }

    for (const item of unflagged) {
      // Bring the quoted price forward as the starting est. cost — Purchasing
      // can adjust it once they've actually sourced the item.
      const unitCost = item.unit_price;
      const total = parseFloat((unitCost * item.quantity).toFixed(2));
      await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_name, quantity, unit_cost, item_type, notes, total, quotation_item_id) VALUES (?,?,?,?,?,?,?,?)',
        args: [prId, item.product_name, item.quantity, unitCost, 'sale', `Quoted at ${item.unit_price}/unit on ${quote.quote_number}`, total, item.id]
      });
      await db.execute({ sql: 'UPDATE quotation_items SET purchase_request_id = ? WHERE id = ?', args: [prId, item.id] });
    }
  } catch(e) { /* non-fatal: the status change itself already succeeded */ }
}

router.post('/', async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });

    const quote_number = await nextNumber(db, 'quotations', 'quote_number', 'QT-', 6);

    let subtotal, tax_amount, processedItems;
    try {
      ({ subtotal, tax_amount, processedItems } = await processQuoteItems(items));
    } catch(e) { return res.status(400).json({ error: e.message }); }
    const disc = parseFloat(discount_amount || 0);
    const total = parseFloat((subtotal + tax_amount - disc).toFixed(2));

    const tx = await db.transaction('write');
    try {
      const result = await tx.execute({ sql: 'INSERT INTO quotations (quote_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,notes,valid_until) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [quote_number, customer_id||null, employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, valid_until||null] });
      const quoteId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        const { product_id, product_name, sku, is_temp_item, purchase_request_id, qty, unit_price, lineTotal, lineTax, lineDisc } = item;
        const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,purchase_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [quoteId, product_id, product_name, sku, qty, unit_price, lineDisc, lineTax, lineTotal, is_temp_item, purchase_request_id] });
        item.id = Number(itemResult.lastInsertRowid);
      }
      await tx.commit();
      const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quoteId] });
      const { rows: quoteItems } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [quoteId] });
      quote.items = quoteItems;
      res.status(201).json(quote);
    } catch(e) {
      await tx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit a quotation (details + items) before it's converted to an invoice.
router.put('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    if (quote.status === 'converted') return res.status(400).json({ error: 'Cannot edit a quotation already converted to an invoice' });

    const { customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });

    let subtotal, tax_amount, processedItems;
    try {
      ({ subtotal, tax_amount, processedItems } = await processQuoteItems(items));
    } catch(e) { return res.status(400).json({ error: e.message }); }
    const disc = parseFloat(discount_amount || 0);
    const total = parseFloat((subtotal + tax_amount - disc).toFixed(2));

    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE quotations SET customer_id=?, employee_id=?, branch_id=?, subtotal=?, tax_amount=?, discount_amount=?, total=?, notes=?, valid_until=? WHERE id=?', args: [customer_id||null, employee_id||quote.employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, valid_until||null, quote.id] });
      await tx.execute({ sql: 'DELETE FROM quotation_items WHERE quote_id = ?', args: [quote.id] });
      for (const item of processedItems) {
        const { product_id, product_name, sku, is_temp_item, purchase_request_id, qty, unit_price, lineTotal, lineTax, lineDisc } = item;
        const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,purchase_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [quote.id, product_id, product_name, sku, qty, unit_price, lineDisc, lineTax, lineTotal, is_temp_item, purchase_request_id] });
        item.id = Number(itemResult.lastInsertRowid);
      }
      await tx.commit();
      const { rows: [updated] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quote.id] });
      // Quote was already accepted before this edit — any newly-added Q items
      // still need to reach Purchasing, so flag them now (existing ones were
      // already flagged and keep their purchase_request_id from processQuoteItems).
      if (quote.status === 'accepted') await flagQItemsForPurchasing(updated);
      const { rows: quoteItems } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [quote.id] });
      updated.items = quoteItems;
      res.json(updated);
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
    // Customer has accepted the quote (their PO is in hand) — this is the
    // point custom "Q" items actually get submitted to Purchasing, grouped
    // into one PR for the whole quote rather than one per item.
    if (status === 'accepted') await flagQItemsForPurchasing(row);
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
      const transaction_number = await nextNumber(convTx, 'transactions', 'transaction_number', 'TXN-', 6);

      const result = await convTx.execute({ sql: 'INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,amount_tendered,change_amount,is_credit,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [transaction_number, quote.customer_id, employee_id||quote.employee_id||1, branch_id||quote.branch_id||null, quote.subtotal, quote.tax_amount, quote.discount_amount, quote.total, method, tendered, change > 0 ? change : 0, isCredit ? 1 : 0, `Converted from quotation ${quote.quote_number}`] });
      const txId = Number(result.lastInsertRowid);

      for (const item of items) {
        await convTx.execute({ sql: 'INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total) VALUES (?,?,?,?,?,?,?,?,?)', args: [txId, item.product_id, item.product_name, item.sku || '', item.quantity, item.unit_price, item.discount_amount, item.tax_amount, item.total] });
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
      // Converting straight to an invoice (skipping an explicit "Accept") is
      // still the customer saying yes — make sure any Q items get flagged.
      await flagQItemsForPurchasing(quote);
      res.status(201).json(savedTx);
    } catch(e) {
      await convTx.rollback();
      res.status(400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
