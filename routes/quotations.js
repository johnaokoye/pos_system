const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { createTransfer } = require('../lib/transfers');
const { feeFor, buildRentalLines, revalidateQuoteLines, insertPendingAgreement } = require('../lib/rentals');

router.use(requirePermission('quotations'));

router.get('/', async (req, res) => {
  try {
    const { status, customer_id, quote_number, quote_type, start, end, limit = 100 } = req.query;
    let sql = `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, t.transaction_number as converted_tx_number, ra.agreement_number as converted_agreement_number, ra.status as converted_agreement_status FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id LEFT JOIN rental_agreements ra ON q.converted_to_agreement_id = ra.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND q.status = ?'; params.push(status); }
    if (quote_type) { sql += ' AND q.quote_type = ?'; params.push(quote_type); }
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

// Attaches each item's branch-sourcing breakdown (`item.sources`) — how much of
// the requested quantity comes from the quote's own branch (no row for that
// portion), a different branch (with the transfer that's moving it, once
// accept-time processing has run), or has no stock anywhere and is on order
// via the quote's Purchase Request. Only items with an actual split have rows.
async function attachQuoteItemSources(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const { rows: sources } = await db.execute({
    sql: `SELECT qis.*, b.name as branch_name, bt.transfer_number, bt.status as transfer_status,
            pr.id as purchase_request_id, pr.pr_number as purchase_request_number
          FROM quotation_item_sources qis
          LEFT JOIN branches b ON qis.branch_id = b.id
          LEFT JOIN branch_transfers bt ON qis.transfer_id = bt.id
          LEFT JOIN purchase_request_items pri ON qis.purchase_request_item_id = pri.id
          LEFT JOIN purchase_requests pr ON pri.pr_id = pr.id
          WHERE qis.quotation_item_id IN (${placeholders})`,
    args: ids,
  });
  const byItem = {};
  for (const s of sources) { (byItem[s.quotation_item_id] = byItem[s.quotation_item_id] || []).push(s); }
  for (const item of items) { item.sources = byItem[item.id] || []; }
  return items;
}

router.get('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.email as customer_email, c.phone as customer_phone, e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name, t.transaction_number as converted_tx_number, ra.agreement_number as converted_agreement_number, ra.status as converted_agreement_status FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id LEFT JOIN rental_agreements ra ON q.converted_to_agreement_id = ra.id WHERE q.id = ?`, args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [req.params.id] });
    quote.items = await attachQuoteItemSources(items);
    res.json(quote);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Items either reference a real product (`product_id`) or are temporary,
// off-catalog lines (`description` + `unit_price`, no `product_id`) used to
// quote something not yet in inventory ("Q" items). Shared by create and edit.
// Temp items are taxed at the store's default rate (no product to read a
// rate from). `purchase_request_id` is carried through unchanged when an
// existing Q item is re-saved, so editing a quote doesn't spawn duplicate PRs.
//
// A real-product item may also carry `sources`: [{branch_id, quantity}], used
// when the quote's branch can't cover the full quantity and the user split
// sourcing across other branches (branch_id null = "no branch has enough,
// purchase it"). Only set when a split was actually needed — omitted entirely
// for the common case where the quote's own branch has enough stock.
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
    let sources = null;
    if (product && Array.isArray(item.sources) && item.sources.length) {
      const sourcesSum = item.sources.reduce((s, src) => s + (parseInt(src.quantity) || 0), 0);
      if (sourcesSum !== qty) throw new Error(`Branch sourcing for ${product.name} (${sourcesSum}) doesn't match quantity (${qty})`);
      sources = item.sources.map(src => ({ branch_id: src.branch_id || null, quantity: parseInt(src.quantity) || 0 })).filter(src => src.quantity > 0);
    }
    processedItems.push({
      product_id: product ? product.id : null,
      product_name: product ? product.name : String(item.description).trim(),
      sku: product ? product.sku : null,
      is_temp_item: product ? 0 : 1,
      purchase_request_id: product ? null : (item.purchase_request_id || null),
      sources,
      qty, unit_price, lineTotal, lineTax, lineDisc,
    });
  }
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax_amount: parseFloat(tax_amount.toFixed(2)),
    processedItems,
  };
}

// Rental-quote counterpart to processQuoteItems above. `items` here are raw
// picks ({product_id, quantity, condition_out, accessory_ids}), validated
// and accessory-expanded by lib/rentals.js's buildRentalLines (shared with
// the direct rental-hold flow in routes/rentals.js POST /agreements) — same
// availability rules, same mandatory/optional accessory handling. No
// `sources`/branch-split concept exists for rentals: a rental quote only
// ever checks stock at its own single branch, same as a direct rental hold.
//
// The per-line total here is a NON-BINDING ESTIMATE only, computed via
// feeFor() over [now, due_date] — the real charge is always recomputed
// fresh at actual rental checkout finalize time (PATCH
// /rentals/agreements/:id/checkout), from live product rates over the
// actual [checkout-instant, due_date] window, exactly like a direct rental
// hold already works. Because rental billing is nonlinear (month/week/day/
// hour blocks), `unit_price` (the product's daily rate) deliberately does
// NOT satisfy `unit_price * quantity === total` here, unlike every retail
// quotation_items row — it's informational only.
async function processRentalQuoteItems(items, branch_id, due_date) {
  if (!branch_id) throw new Error('A branch/location is required for a rental quote');
  if (!due_date) throw new Error('Due date is required for a rental quote');

  const lines = await buildRentalLines(db, { branch_id, items });
  const now = new Date();
  const due = new Date(`${due_date}T23:59:59.000Z`);

  let subtotal = 0, tax_amount = 0;
  const processedItems = lines.map(line => {
    const p = line.product;
    const estFee = line.isMandatory ? 0 : feeFor(p, line.quantity, now, due);
    const lineTax = parseFloat((estFee * (p.tax_rate || 0) / 100).toFixed(2));
    subtotal += estFee;
    tax_amount += lineTax;
    return {
      product_id: p.id, product_name: p.name, sku: p.sku,
      quantity: line.quantity, unit_price: p.rental_rate || 0,
      lineTotal: estFee, lineTax, is_mandatory: line.isMandatory ? 1 : 0,
      condition_out: line.condition_out, parentIndex: line.parentIndex,
    };
  });
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax_amount: parseFloat(tax_amount.toFixed(2)),
    processedItems,
  };
}

// Finds the quote's existing auto-created Purchase Request (from an earlier
// accept — e.g. the quote was reverted to draft, edited, then re-accepted) or
// creates a new one. One PR per quote, shared by both custom "Q" items and
// real-product shortfalls that no branch could cover.
async function ensureQuotePR(quote) {
  const { rows: [existingLink] } = await db.execute({ sql: 'SELECT purchase_request_id FROM quotation_items WHERE quote_id = ? AND purchase_request_id IS NOT NULL LIMIT 1', args: [quote.id] });
  if (existingLink) return existingLink.purchase_request_id;
  const { rows: [existingSourceLink] } = await db.execute({
    sql: `SELECT pri.pr_id FROM quotation_item_sources qis
          JOIN quotation_items qi ON qis.quotation_item_id = qi.id
          JOIN purchase_request_items pri ON qis.purchase_request_item_id = pri.id
          WHERE qi.quote_id = ? LIMIT 1`,
    args: [quote.id],
  });
  if (existingSourceLink) return existingSourceLink.pr_id;

  const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
  const result = await db.execute({
    sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, notes, required_date, request_type) VALUES (?,?,?,?,?,?)',
    args: [pr_number, quote.branch_id || null, quote.employee_id || null, `Auto-created from accepted quotation ${quote.quote_number} — customer PO received`, quote.valid_until || null, 'sale_items']
  });
  return Number(result.lastInsertRowid);
}

// Flags every not-yet-flagged item on an accepted quote for Purchasing, in a
// single Purchase Request per quote (not one per item). Two sources feed the
// same PR: custom "Q" items (no product_id — not yet in the catalog at all),
// and real-product line items where a branch split left a remainder no
// branch could cover (quotation_item_sources.branch_id IS NULL). Only runs
// once the customer has accepted the quote — never at create/edit time,
// since items are still in flux until then.
async function flagItemsForPurchasing(quote) {
  try {
    const { rows: unflaggedQItems } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ? AND is_temp_item = 1 AND purchase_request_id IS NULL', args: [quote.id] });
    const { rows: shortfalls } = await db.execute({
      sql: `SELECT qis.id as source_id, qi.id as item_id, qi.product_id, qi.product_name, qi.unit_price, qis.quantity
            FROM quotation_item_sources qis JOIN quotation_items qi ON qis.quotation_item_id = qi.id
            WHERE qi.quote_id = ? AND qis.branch_id IS NULL AND qis.purchase_request_item_id IS NULL`,
      args: [quote.id],
    });
    if (!unflaggedQItems.length && !shortfalls.length) return;

    const prId = await ensureQuotePR(quote);

    for (const item of unflaggedQItems) {
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

    for (const s of shortfalls) {
      const unitCost = s.unit_price;
      const total = parseFloat((unitCost * s.quantity).toFixed(2));
      const result = await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, quantity, unit_cost, item_type, notes, total, quotation_item_id) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [prId, s.product_id, s.product_name, s.quantity, unitCost, 'sale', `No branch had enough stock — quoted at ${s.unit_price}/unit on ${quote.quote_number}`, total, s.item_id]
      });
      await db.execute({ sql: 'UPDATE quotation_item_sources SET purchase_request_item_id = ? WHERE id = ?', args: [Number(result.lastInsertRowid), s.source_id] });
    }
  } catch(e) { /* non-fatal: the status change itself already succeeded */ }
}

// Auto-creates a branch transfer for each distinct non-home branch a quote's
// items were sourced from (one transfer per branch per quote, mirroring the
// "one PR per quote" grouping used for shortfalls), referencing the quote.
// If stock at a source branch has changed since the quote was drafted and the
// transfer can no longer be created, that group's sourcing is rerouted to the
// "purchase" bucket (branch_id = NULL) so flagItemsForPurchasing sweeps it
// into the PR instead — Accept never hard-fails because of a stale quote.
async function processQuoteTransfers(quote) {
  try {
    if (!quote.branch_id) return;
    const { rows: pending } = await db.execute({
      sql: `SELECT qis.id as source_id, qis.branch_id, qis.quantity, qi.product_id
            FROM quotation_item_sources qis JOIN quotation_items qi ON qis.quotation_item_id = qi.id
            WHERE qi.quote_id = ? AND qis.branch_id IS NOT NULL AND qis.branch_id != ? AND qis.transfer_id IS NULL`,
      args: [quote.id, quote.branch_id],
    });
    if (!pending.length) return;

    const byBranch = {};
    for (const row of pending) { (byBranch[row.branch_id] = byBranch[row.branch_id] || []).push(row); }

    for (const [branchId, rows] of Object.entries(byBranch)) {
      const tx = await db.transaction('write');
      let committed = false;
      try {
        const transfer_number = await nextNumber(tx, 'branch_transfers', 'transfer_number', 'TRF-', 6);
        const items = rows.map(r => ({ product_id: r.product_id, quantity: r.quantity }));
        const transferId = await createTransfer(tx, {
          transfer_number, from_branch_id: Number(branchId), to_branch_id: quote.branch_id,
          employee_id: quote.employee_id, items, notes: `Auto-created from accepted quotation ${quote.quote_number}`,
          quote_id: quote.id,
        });
        for (const r of rows) {
          await tx.execute({ sql: 'UPDATE quotation_item_sources SET transfer_id = ? WHERE id = ?', args: [transferId, r.source_id] });
        }
        await tx.commit();
        committed = true;
      } catch(e) {
        // Only fall back to purchasing if the transfer itself never committed —
        // rolling back an already-committed tx throws, and would otherwise
        // wrongly reroute a successfully-transferred item into the PR bucket.
        if (committed) throw e;
        await tx.rollback();
        // Source branch can no longer cover it — fall back to purchasing.
        for (const r of rows) {
          await db.execute({ sql: 'UPDATE quotation_item_sources SET branch_id = NULL WHERE id = ?', args: [r.source_id] });
        }
      }
    }
  } catch(e) { /* non-fatal: the status change itself already succeeded */ }
}

async function processQuoteAcceptance(quote) {
  await processQuoteTransfers(quote);
  await flagItemsForPurchasing(quote);
}

router.post('/', async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until, quote_type, due_date } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });
    const isRental = quote_type === 'rental';

    const quote_number = await nextNumber(db, 'quotations', 'quote_number', 'QT-', 6);

    let subtotal, tax_amount, processedItems;
    try {
      ({ subtotal, tax_amount, processedItems } = isRental
        ? await processRentalQuoteItems(items, branch_id, due_date)
        : await processQuoteItems(items));
    } catch(e) { return res.status(400).json({ error: e.message }); }
    const disc = parseFloat(discount_amount || 0);
    const total = parseFloat((subtotal + tax_amount - disc).toFixed(2));

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: 'INSERT INTO quotations (quote_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,notes,valid_until,quote_type,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [quote_number, customer_id||null, employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, valid_until||null, isRental ? 'rental' : 'retail', isRental ? due_date : null] });
      const quoteId = Number(result.lastInsertRowid);
      if (isRental) {
        // No sources/branch-split concept for rentals — a rental quote only
        // ever checks stock at its own branch (see processRentalQuoteItems).
        // parent_item_id needs real row ids, which only exist post-insert —
        // set it in a second pass, same as lib/rentals.js's insertPendingAgreement.
        for (const item of processedItems) {
          const { product_id, product_name, sku, quantity, unit_price, lineTotal, lineTax, is_mandatory, condition_out } = item;
          const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,is_mandatory,condition_out) VALUES (?,?,?,?,?,?,0,?,?,0,?,?)', args: [quoteId, product_id, product_name, sku, quantity, unit_price, lineTax, lineTotal, is_mandatory, condition_out] });
          item.id = Number(itemResult.lastInsertRowid);
        }
        for (const item of processedItems) {
          if (item.parentIndex != null) {
            await tx.execute({ sql: 'UPDATE quotation_items SET parent_item_id = ? WHERE id = ?', args: [processedItems[item.parentIndex].id, item.id] });
          }
        }
      } else {
        for (const item of processedItems) {
          const { product_id, product_name, sku, is_temp_item, purchase_request_id, sources, qty, unit_price, lineTotal, lineTax, lineDisc } = item;
          const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,purchase_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [quoteId, product_id, product_name, sku, qty, unit_price, lineDisc, lineTax, lineTotal, is_temp_item, purchase_request_id] });
          item.id = Number(itemResult.lastInsertRowid);
          if (sources) {
            for (const src of sources) {
              await tx.execute({ sql: 'INSERT INTO quotation_item_sources (quotation_item_id, branch_id, quantity) VALUES (?,?,?)', args: [item.id, src.branch_id, src.quantity] });
            }
          }
        }
      }
      await tx.commit();
      committed = true;
      const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quoteId] });
      const { rows: quoteItems } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [quoteId] });
      quote.items = isRental ? quoteItems : await attachQuoteItemSources(quoteItems);
      res.status(201).json(quote);
    } catch(e) {
      // Once committed, the quote is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit a quotation (details + items) before it's converted to an invoice.
router.put('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    if (quote.status === 'converted') return res.status(400).json({ error: 'Cannot edit a quotation already converted to an invoice' });

    const { customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until, due_date } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });
    const isRental = quote.quote_type === 'rental'; // quote_type is fixed at creation — never taken from req.body here

    let subtotal, tax_amount, processedItems;
    try {
      ({ subtotal, tax_amount, processedItems } = isRental
        ? await processRentalQuoteItems(items, branch_id, due_date || quote.due_date)
        : await processQuoteItems(items));
    } catch(e) { return res.status(400).json({ error: e.message }); }
    const disc = parseFloat(discount_amount || 0);
    const total = parseFloat((subtotal + tax_amount - disc).toFixed(2));

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: 'UPDATE quotations SET customer_id=?, employee_id=?, branch_id=?, subtotal=?, tax_amount=?, discount_amount=?, total=?, notes=?, valid_until=?, due_date=? WHERE id=?', args: [customer_id||null, employee_id||quote.employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, valid_until||null, isRental ? (due_date || quote.due_date) : null, quote.id] });
      await tx.execute({ sql: 'DELETE FROM quotation_items WHERE quote_id = ?', args: [quote.id] });
      if (isRental) {
        for (const item of processedItems) {
          const { product_id, product_name, sku, quantity, unit_price, lineTotal, lineTax, is_mandatory, condition_out } = item;
          const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,is_mandatory,condition_out) VALUES (?,?,?,?,?,?,0,?,?,0,?,?)', args: [quote.id, product_id, product_name, sku, quantity, unit_price, lineTax, lineTotal, is_mandatory, condition_out] });
          item.id = Number(itemResult.lastInsertRowid);
        }
        for (const item of processedItems) {
          if (item.parentIndex != null) {
            await tx.execute({ sql: 'UPDATE quotation_items SET parent_item_id = ? WHERE id = ?', args: [processedItems[item.parentIndex].id, item.id] });
          }
        }
      } else {
        for (const item of processedItems) {
          const { product_id, product_name, sku, is_temp_item, purchase_request_id, sources, qty, unit_price, lineTotal, lineTax, lineDisc } = item;
          const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,purchase_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [quote.id, product_id, product_name, sku, qty, unit_price, lineDisc, lineTax, lineTotal, is_temp_item, purchase_request_id] });
          item.id = Number(itemResult.lastInsertRowid);
          if (sources) {
            for (const src of sources) {
              await tx.execute({ sql: 'INSERT INTO quotation_item_sources (quotation_item_id, branch_id, quantity) VALUES (?,?,?)', args: [item.id, src.branch_id, src.quantity] });
            }
          }
        }
      }
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quote.id] });
      // Quote was already accepted before this edit — any newly-added Q items
      // and shortfall sources still need to reach Purchasing/Transfers, so
      // reprocess now. NOTE: known limitation — since quotation_items (and by
      // cascade quotation_item_sources) are deleted and re-inserted on every
      // edit, sources that were already turned into a transfer/PR before this
      // edit lose that link and get reprocessed, which can create duplicates.
      // Not fixed in v1; see plan notes. Rentals have no PR/transfer concept
      // at all, so this reprocessing is retail-only.
      if (quote.status === 'accepted' && !isRental) await processQuoteAcceptance(updated);
      const { rows: quoteItems } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [quote.id] });
      updated.items = isRental ? quoteItems : await attachQuoteItemSources(quoteItems);
      res.json(updated);
    } catch(e) {
      // Once committed, the edit is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
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
    // into one PR for the whole quote rather than one per item. Rentals have
    // no Q-item/branch-transfer concept, so this is retail-only.
    if (status === 'accepted' && q.quote_type !== 'rental') await processQuoteAcceptance(row);
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Convert quotation to invoice — places it on hold for a cashier to pick up
// and actually collect payment on at the POS, rather than completing the
// sale here. Mirrors the shape of POST /transactions/hold (routes/transactions.js):
// status/payment_method='hold', no stock/loyalty/commission side effects —
// those only happen once a cashier finalizes the real checkout. The cashier
// recalls it via the normal Recall Held Order flow, which (via the existing
// `quote_id` passed through checkout) flips this quotation to 'converted'
// and repoints converted_to_tx at the real completed transaction.
router.post('/:id/convert', async (req, res) => {
  try {
    const { employee_id, branch_id } = req.body;
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Quotation not found' });
    if (quote.status === 'converted') return res.status(400).json({ error: 'Already converted to invoice' });
    if (quote.status === 'declined') return res.status(400).json({ error: 'Cannot convert declined quotation' });
    if (quote.status === 'cancelled') return res.status(400).json({ error: 'Cannot convert cancelled quotation' });

    // ORDER BY id so parent lines precede their accessory children — required
    // for revalidateQuoteLines' parent_item_id -> lines-index remap below.
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ? ORDER BY id', args: [quote.id] });
    if (!items.length) return res.status(400).json({ error: 'No items in quotation' });

    if (quote.quote_type === 'rental') {
      const targetBranchId = branch_id || quote.branch_id;
      if (!targetBranchId) return res.status(400).json({ error: 'A branch/location is required to convert this rental quote' });
      if (!quote.due_date) return res.status(400).json({ error: 'This rental quote has no due date set' });
      if (!quote.customer_id) return res.status(400).json({ error: 'A customer is required to convert this rental quote' });

      // Stock may have shifted since the quote was drafted — re-check now.
      // Unlike retail, rentals have no PR/purchase fallback for an
      // uncoverable shortfall, so a stock conflict here is a hard failure.
      let lines;
      try {
        lines = await revalidateQuoteLines(db, { branch_id: targetBranchId, quotationItems: items });
      } catch(e) { return res.status(400).json({ error: e.message }); }

      const agreement_number = await nextNumber(db, 'rental_agreements', 'agreement_number', 'RA-', 6);
      const tx = await db.transaction('write');
      let committed = false;
      try {
        const agreementId = await insertPendingAgreement(tx, {
          agreement_number, customer_id: quote.customer_id, employee_id: employee_id || quote.employee_id || null,
          branch_id: targetBranchId, due_date: quote.due_date,
          notes: `Converted from quotation ${quote.quote_number}`, lines,
        });
        await tx.execute({ sql: 'UPDATE quotations SET status = ?, converted_to_agreement_id = ? WHERE id = ?', args: ['converted', agreementId, quote.id] });
        await tx.commit();
        committed = true;

        const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [agreementId] });
        const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [agreementId] });
        agreement.items = agItems;
        return res.status(201).json(agreement);
      } catch(e) {
        // Once committed, the pending agreement is saved — rolling back a
        // closed transaction throws and would crash the process (unhandled
        // rejection), so only roll back if the commit itself never happened.
        if (!committed) await tx.rollback();
        return res.status(committed ? 500 : 400).json({ error: e.message });
      }
    }

    const hold_number = 'HOLD-' + Date.now();

    const convTx = await db.transaction('write');
    let committed = false;
    try {
      const result = await convTx.execute({ sql: 'INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,status,amount_tendered,change_amount,notes) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?)', args: [hold_number, quote.customer_id, employee_id||quote.employee_id||1, branch_id||quote.branch_id||null, quote.subtotal, quote.tax_amount, quote.discount_amount, quote.total, 'hold', 'hold', `Converted from quotation ${quote.quote_number}`] });
      const txId = Number(result.lastInsertRowid);

      for (const item of items) {
        await convTx.execute({ sql: 'INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total) VALUES (?,?,?,?,?,?,?,?,?)', args: [txId, item.product_id, item.product_name, item.sku || '', item.quantity, item.unit_price, item.discount_amount, item.tax_amount, item.total] });
      }

      await convTx.execute({ sql: 'UPDATE quotations SET status = ?, converted_to_tx = ? WHERE id = ?', args: ['converted', txId, quote.id] });
      await convTx.commit();
      committed = true;

      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.id = ?`, args: [txId] });
      const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = txItems;

      // Converting straight to an invoice (skipping an explicit "Accept") is
      // still the customer saying yes — make sure any Q items/shortfalls get flagged.
      await processQuoteAcceptance(quote);
      res.status(201).json(savedTx);
    } catch(e) {
      // Once committed, the hold is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await convTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
