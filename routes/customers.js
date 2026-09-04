const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Proof of address is often a bank statement or utility bill PDF, not just a
// photo — same size limit as the ID scan above, but images or PDF.
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
});

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

// Discount card fields (name/percent/active) come from a LEFT JOIN so the
// POS can decide whether to auto-apply it (discount_card_type_active must
// also be true — deactivating a type retires it for every customer holding
// it without editing each customer record).
// Cash-back fields (points_threshold/reward_amount/redemption gates) join in
// the same way, so POS can compute eligibility client-side without a second
// round trip — see availableCashBack() in public/index.html.
// Customer category fields join the same way too — a category's
// discount_percent auto-applies at checkout exactly like a discount card
// (see setCartCustomer() in public/index.html), just without a card number,
// and only when no discount card is present (a card is a more deliberate,
// specific assignment and wins if both exist on the same customer).
const CUSTOMER_WITH_CARD_SELECT = `SELECT c.*, dct.name as discount_card_type_name, dct.discount_percent as discount_card_percent, dct.active as discount_card_type_active,
  cbct.name as cash_back_card_type_name, cbct.points_threshold as cash_back_points_threshold, cbct.reward_amount as cash_back_reward_amount,
  cbct.min_redeem_amount as cash_back_min_redeem_amount, cbct.min_redeem_days as cash_back_min_redeem_days, cbct.active as cash_back_card_type_active,
  cc.name as customer_category_name, cc.discount_percent as customer_category_discount_percent, cc.active as customer_category_active
  FROM customers c LEFT JOIN discount_card_types dct ON c.discount_card_type_id = dct.id
  LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id = cbct.id
  LEFT JOIN customer_categories cc ON c.customer_category_id = cc.id WHERE c.id = ?`;

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    await runCreditCheck(req.params.id);
    const { rows: [updated] } = await db.execute({ sql: CUSTOMER_WITH_CARD_SELECT, args: [req.params.id] });
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

// Validates a customer's discount card fields before insert/update: the card
// type (if given) must exist, and the card number (if given) can't already
// belong to another customer — one active card per customer, enforced here
// since SQLite's ALTER TABLE ADD COLUMN can't add a UNIQUE constraint after
// the fact. Returns an error string, or null if everything checks out.
async function validateDiscountCard(discount_card_type_id, discount_card_number, excludeCustomerId) {
  if (!discount_card_type_id) return null;
  const { rows: [type] } = await db.execute({ sql: 'SELECT id FROM discount_card_types WHERE id = ?', args: [discount_card_type_id] });
  if (!type) return 'Selected discount card type does not exist';
  if (discount_card_number) {
    const { rows: [dupe] } = await db.execute({
      sql: `SELECT id FROM customers WHERE discount_card_number = ? ${excludeCustomerId ? 'AND id != ?' : ''}`,
      args: excludeCustomerId ? [discount_card_number, excludeCustomerId] : [discount_card_number],
    });
    if (dupe) return `Card number ${discount_card_number} is already assigned to another customer`;
  }
  return null;
}

// Same shape/reasoning as validateDiscountCard() above.
async function validateCashBackCard(cash_back_card_type_id, cash_back_card_number, excludeCustomerId) {
  if (!cash_back_card_type_id) return null;
  const { rows: [type] } = await db.execute({ sql: 'SELECT id FROM cash_back_card_types WHERE id = ?', args: [cash_back_card_type_id] });
  if (!type) return 'Selected cash back card type does not exist';
  if (cash_back_card_number) {
    const { rows: [dupe] } = await db.execute({
      sql: `SELECT id FROM customers WHERE cash_back_card_number = ? ${excludeCustomerId ? 'AND id != ?' : ''}`,
      args: excludeCustomerId ? [cash_back_card_number, excludeCustomerId] : [cash_back_card_number],
    });
    if (dupe) return `Card number ${cash_back_card_number} is already assigned to another customer`;
  }
  return null;
}

router.post('/', requirePermission('customers'), async (req, res) => {
  const {
    first_name, last_name, email, phone, address, city, state, zip, notes, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number,
    is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type,
    rental_reference_name, rental_reference_phone, rental_reference_relationship, rental_reference_address,
    rental_reference2_name, rental_reference2_phone, rental_reference2_relationship,
    rental_reference3_name, rental_reference3_phone, rental_reference3_relationship,
    discount_card_type_id, discount_card_number,
    cash_back_card_type_id, cash_back_card_number,
    customer_category_id,
  } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
  try {
    // Guard against creating a duplicate customer record: match on email,
    // phone, or full name against active customers. `force` skips this once
    // the caller has already confirmed they want a separate record anyway.
    if (!req.body.force) {
      const { rows: matches } = await db.execute({
        sql: `SELECT * FROM customers WHERE active = 1 AND (
          (email IS NOT NULL AND email != '' AND LOWER(email) = LOWER(?))
          OR (phone IS NOT NULL AND phone != '' AND phone = ?)
          OR (LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?)))`,
        args: [email || '', phone || '', first_name, last_name],
      });
      if (matches.length) return res.status(409).json({ error: 'Possible duplicate customer', matches });
    }
    const cardError = await validateDiscountCard(discount_card_type_id, discount_card_number, null);
    if (cardError) return res.status(400).json({ error: cardError });
    const cashBackCardError = await validateCashBackCard(cash_back_card_type_id, cash_back_card_number, null);
    if (cashBackCardError) return res.status(400).json({ error: cashBackCardError });
    const customer_number = await nextNumber(db, 'customers', 'customer_number', 'CUST-', 4);
    const type = customer_type || 'cash';
    const creditEnabled = type === 'credit' ? 1 : 0;
    const terms = parseInt(credit_terms_days) || 30;
    const limit = parseFloat(credit_limit) || 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const isRentalCust = is_rental_customer ? 1 : 0;
    const result = await db.execute({ sql: `INSERT INTO customers
      (customer_number,first_name,last_name,email,phone,address,city,state,zip,notes,customer_type,credit_terms_days,credit_limit,credit_enabled,tax_exempt,tax_exemption_number,
       is_rental_customer,rental_id_type,rental_id_number,rental_address_proof_type,
       rental_reference_name,rental_reference_phone,rental_reference_relationship,rental_reference_address,
       rental_reference2_name,rental_reference2_phone,rental_reference2_relationship,
       rental_reference3_name,rental_reference3_phone,rental_reference3_relationship,
       discount_card_type_id,discount_card_number,cash_back_card_type_id,cash_back_card_number,customer_category_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [customer_number, first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null,
        isRentalCust, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null,
        isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null, isRentalCust ? (rental_reference_address||null) : null,
        isRentalCust ? (rental_reference2_name||null) : null, isRentalCust ? (rental_reference2_phone||null) : null, isRentalCust ? (rental_reference2_relationship||null) : null,
        isRentalCust ? (rental_reference3_name||null) : null, isRentalCust ? (rental_reference3_phone||null) : null, isRentalCust ? (rental_reference3_relationship||null) : null,
        discount_card_type_id || null, discount_card_type_id ? (discount_card_number || null) : null,
        cash_back_card_type_id || null, cash_back_card_type_id ? (cash_back_card_number || null) : null,
        customer_category_id || null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('customers'), async (req, res) => {
  const {
    first_name, last_name, email, phone, address, city, state, zip, notes, active, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number,
    is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type,
    rental_reference_name, rental_reference_phone, rental_reference_relationship, rental_reference_address,
    rental_reference2_name, rental_reference2_phone, rental_reference2_relationship,
    rental_reference3_name, rental_reference3_phone, rental_reference3_relationship,
    discount_card_type_id, discount_card_number,
    cash_back_card_type_id, cash_back_card_number,
    customer_category_id,
  } = req.body;
  try {
    const cardError = await validateDiscountCard(discount_card_type_id, discount_card_number, req.params.id);
    if (cardError) return res.status(400).json({ error: cardError });
    const cashBackCardError = await validateCashBackCard(cash_back_card_type_id, cash_back_card_number, req.params.id);
    if (cashBackCardError) return res.status(400).json({ error: cashBackCardError });
    const type = customer_type || 'cash';
    const creditEnabled = type === 'credit' ? 1 : 0;
    const terms = parseInt(credit_terms_days) || 30;
    const limit = parseFloat(credit_limit) || 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const isRentalCust = is_rental_customer ? 1 : 0;
    await db.execute({ sql: `UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,notes=?,active=?,customer_type=?,credit_terms_days=?,credit_limit=?,credit_enabled=?,tax_exempt=?,tax_exemption_number=?,
      is_rental_customer=?,rental_id_type=?,rental_id_number=?,rental_address_proof_type=?,
      rental_reference_name=?,rental_reference_phone=?,rental_reference_relationship=?,rental_reference_address=?,
      rental_reference2_name=?,rental_reference2_phone=?,rental_reference2_relationship=?,
      rental_reference3_name=?,rental_reference3_phone=?,rental_reference3_relationship=?,
      discount_card_type_id=?,discount_card_number=?,cash_back_card_type_id=?,cash_back_card_number=?,customer_category_id=? WHERE id=?`,
      args: [first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, active??1, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null,
        isRentalCust, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null,
        isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null, isRentalCust ? (rental_reference_address||null) : null,
        isRentalCust ? (rental_reference2_name||null) : null, isRentalCust ? (rental_reference2_phone||null) : null, isRentalCust ? (rental_reference2_relationship||null) : null,
        isRentalCust ? (rental_reference3_name||null) : null, isRentalCust ? (rental_reference3_phone||null) : null, isRentalCust ? (rental_reference3_relationship||null) : null,
        discount_card_type_id || null, discount_card_type_id ? (discount_card_number || null) : null,
        cash_back_card_type_id || null, cash_back_card_type_id ? (cash_back_card_number || null) : null,
        customer_category_id || null, req.params.id] });
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

// POST upload rental customer's ID scan — same Cloudinary-or-local fallback
// pattern as product images (see routes/products.js POST /:id/image).
router.post('/:id/id-scan', requirePermission('customers'), upload.single('id_scan'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_id_scan_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_id_scan_path) {
      if (existing.rental_id_scan_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_id_scan_path);
      } else {
        const old = path.join(__dirname, '..', existing.rental_id_scan_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-ids',
      public_id: `customer-${req.params.id}`,
      overwrite: true,
      resource_type: 'image',
    });

    let scanPath;
    if (result) {
      scanPath = result.secure_url;
    } else {
      // Cloudinary not configured — save locally
      const dir = path.join(__dirname, '../uploads/customer-ids');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      scanPath = `/uploads/customer-ids/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_id_scan_path = ? WHERE id = ?', args: [scanPath, req.params.id] });
    res.json({ rental_id_scan_path: scanPath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE rental customer's ID scan
router.delete('/:id/id-scan', requirePermission('customers'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_id_scan_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_id_scan_path) {
      if (customer.rental_id_scan_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_id_scan_path);
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_id_scan_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_id_scan_path = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload a photo ID for reference 1 (the "main" reference — the one
// with an address on file) — same Cloudinary-or-local pattern and image-only
// restriction as the customer's own ID scan above.
router.post('/:id/reference-id', requirePermission('customers'), upload.single('reference_id'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_reference_id_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_reference_id_path) {
      if (existing.rental_reference_id_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_reference_id_path);
      } else {
        const old = path.join(__dirname, '..', existing.rental_reference_id_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-reference-ids',
      public_id: `customer-${req.params.id}`,
      overwrite: true,
      resource_type: 'image',
    });

    let scanPath;
    if (result) {
      scanPath = result.secure_url;
    } else {
      const dir = path.join(__dirname, '../uploads/customer-reference-ids');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      scanPath = `/uploads/customer-reference-ids/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_reference_id_path = ? WHERE id = ?', args: [scanPath, req.params.id] });
    res.json({ rental_reference_id_path: scanPath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE reference 1's photo ID
router.delete('/:id/reference-id', requirePermission('customers'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_reference_id_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_reference_id_path) {
      if (customer.rental_reference_id_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_reference_id_path);
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_reference_id_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_reference_id_path = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload rental customer's proof-of-address document — same
// Cloudinary-or-local fallback pattern as the ID scan above, but accepts a
// PDF too (bank statements/utility bills are usually PDFs, not photos), so
// resource_type is 'auto' at upload time and destroy needs the stored mime
// to know whether Cloudinary filed it as 'image' or 'raw'.
router.post('/:id/address-proof', requirePermission('customers'), uploadDoc.single('address_proof'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded, or file type not allowed (images and PDF only)' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_address_proof_path, rental_address_proof_mime FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_address_proof_path) {
      if (existing.rental_address_proof_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_address_proof_path, /^image\//.test(existing.rental_address_proof_mime || '') ? 'image' : 'raw');
      } else {
        const old = path.join(__dirname, '..', existing.rental_address_proof_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-address-proofs',
      public_id: `customer-${req.params.id}-${Date.now()}`,
      resource_type: 'auto',
    });

    let docPath;
    if (result) {
      docPath = result.secure_url;
    } else {
      const dir = path.join(__dirname, '../uploads/customer-address-proofs');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      docPath = `/uploads/customer-address-proofs/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_address_proof_path = ?, rental_address_proof_mime = ? WHERE id = ?', args: [docPath, req.file.mimetype, req.params.id] });
    res.json({ rental_address_proof_path: docPath, rental_address_proof_mime: req.file.mimetype });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE rental customer's proof-of-address document
router.delete('/:id/address-proof', requirePermission('customers'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_address_proof_path, rental_address_proof_mime FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_address_proof_path) {
      if (customer.rental_address_proof_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_address_proof_path, /^image\//.test(customer.rental_address_proof_mime || '') ? 'image' : 'raw');
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_address_proof_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_address_proof_path = NULL, rental_address_proof_mime = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.runCreditCheck = runCreditCheck;
