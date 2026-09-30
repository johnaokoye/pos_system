const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

// Every editable column the supplier form sends, shared by POST / and PUT /:id
// so the insert/update column lists can't drift apart.
const FIELDS = ['name','name_type','salutation','first_name','last_name','contact_name','phone','email','fax','website',
  'contact2_name','phone2','email2','fax2','website2','report_email',
  'address','address2','address3','city','state','zip','country','comment1','comment2','comment3',
  'category','payment_terms','ship_via','sync_ap','ap_vendor_number','account_number','voucher_default','notes'];
const DEFAULTS = { payment_terms: 'Net 30', name_type: 'Business', report_email: 'email1' };
const uniqueMsg = e => /UNIQUE/i.test(e.message) ? 'That vendor number is already in use' : e.message;
const fieldArgs = body => FIELDS.map(f => {
  if (f === 'sync_ap') return body.sync_ap === undefined || body.sync_ap === null || body.sync_ap === '' ? 1 : (body.sync_ap ? 1 : 0);
  return body[f] || DEFAULTS[f] || null;
});

// requireAuth only — used as a dropdown lookup in Inventory/PO forms, not
// just the Suppliers management screen.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { search, active } = req.query;
    let sql = 'SELECT * FROM suppliers WHERE 1=1';
    const params = [];
    if (search) {
      sql += ' AND (name LIKE ? OR contact_name LIKE ? OR supplier_number LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (active !== undefined) {
      sql += ' AND active = ?';
      params.push(active === 'false' ? 0 : 1);
    } else {
      sql += ' AND active = 1';
    }
    sql += ' ORDER BY name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV import ────────────────────────────────────────────
// Registered before GET /:id so "export" isn't swallowed as a supplier id.
// Rows arrive already remapped to our column names by the frontend's
// column-matching step (_supplierImportFields), one column per FIELDS entry.
const CSV_COLUMNS = ['supplier_number', ...FIELDS, 'is_local'];

function escapeCsv(v) {
  if (v == null) return '';
  const str = String(v);
  return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
}

const csvBool = v => ['1', 'true', 'yes', 'y'].includes(String(v ?? '').trim().toLowerCase());
const clean = v => { const t = String(v ?? '').trim(); return t || null; };

// Normalizes the handful of fields with a fixed set of values; everything
// else is stored as text.
function importRowBody(r) {
  const body = Object.fromEntries(FIELDS.map(f => [f, clean(r[f])]));
  body.name_type = /^p/i.test(body.name_type || '') ? 'Person' : 'Business';
  body.report_email = /2/.test(body.report_email || '') ? 'email2' : 'email1';
  body.sync_ap = body.sync_ap === null ? undefined : csvBool(body.sync_ap);
  return body;
}

router.get('/export/template', requirePermission('suppliers_add'), (req, res) => {
  const example = {
    supplier_number: 'V0002', name: 'Impact Trading', name_type: 'Business', salutation: 'Ms.', first_name: 'Jane', last_name: 'Brown',
    contact_name: 'Jane Brown', phone: '876-555-0100', email: 'orders@impact.example', fax: '876-555-0101', website: 'impact.example',
    contact2_name: 'Mark Lee', phone2: '876-555-0102', email2: 'mark@impact.example', report_email: 'email1',
    address: '1 Villa Road', city: 'Mandeville', state: 'Manchester', country: 'Jamaica', comment1: 'Delivers Tuesdays',
    category: 'General', payment_terms: 'Net 30', ship_via: 'Truck', sync_ap: '1', ap_vendor_number: 'V0002',
    account_number: 'ACCT-1234', voucher_default: 'Fully vouchered', is_local: '1',
  };
  const csv = [CSV_COLUMNS.join(','), CSV_COLUMNS.map(c => escapeCsv(example[c])).join(',')].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="supplier_import_template.csv"');
  res.send(csv);
});

// GET the next free SUP- number, for the supplier form's Auto-assign button.
router.get('/next-number', requirePermission('suppliers'), async (req, res) => {
  try { res.json({ supplier_number: await nextNumber(db, 'suppliers', 'supplier_number', 'SUP-', 4) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST import suppliers from CSV rows (already remapped to our field names
// by the frontend's column-matching step). A row whose supplier number
// already exists, or whose name matches an active supplier, is a likely
// duplicate: skipped by default, or created anyway with `duplicate_mode:
// 'force'` (a clashing supplier number is then replaced with a new SUP-
// number, since supplier_number is UNIQUE). A blank supplier number also
// gets a new SUP- number. `batch_id` (from POST /supplier-imports) logs each
// row's outcome so the import can be reviewed and reversed afterward.
router.post('/import', requirePermission('suppliers_add'), async (req, res) => {
  try {
    const { rows, duplicate_mode, batch_id } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
    const force = duplicate_mode === 'force';

    let created = 0, skipped = 0;
    const errors = [];
    const duplicates = [];
    const logItem = async (rowLabel, action, { supplier_id, supplier_number, duplicate_of_supplier_id, error_message } = {}) => {
      if (!batch_id) return;
      await db.execute({
        sql: 'INSERT INTO supplier_import_batch_items (batch_id, supplier_id, supplier_number, row_label, action, duplicate_of_supplier_id, error_message) VALUES (?,?,?,?,?,?,?)',
        args: [batch_id, supplier_id || null, supplier_number || null, rowLabel, action, duplicate_of_supplier_id || null, error_message || null],
      });
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 2;
      const name = clean(r.name);
      let supplier_number = clean(r.supplier_number);
      const rowLabel = name || supplier_number || `row ${rowNum}`;
      if (!name) {
        const msg = `Row ${rowNum}: vendor name is required`;
        errors.push(msg);
        await logItem(rowLabel, 'error', { error_message: msg });
        continue;
      }
      try {
        const { rows: matches } = await db.execute({
          sql: 'SELECT id, supplier_number, name FROM suppliers WHERE (? IS NOT NULL AND supplier_number = ?) OR (active = 1 AND LOWER(name) = LOWER(?))',
          args: [supplier_number, supplier_number, name],
        });
        if (matches.length && !force) {
          skipped++;
          duplicates.push({ row: rowLabel, matches: matches.map(m => ({ id: m.id, supplier_number: m.supplier_number, name: m.name })) });
          await logItem(rowLabel, 'skipped_duplicate', { supplier_number, duplicate_of_supplier_id: matches[0].id });
          continue;
        }
        if (!supplier_number || matches.some(m => m.supplier_number === supplier_number)) {
          supplier_number = await nextNumber(db, 'suppliers', 'supplier_number', 'SUP-', 4);
        }
        const body = importRowBody(r);
        const result = await db.execute({
          sql: `INSERT INTO suppliers (supplier_number,${FIELDS.join(',')},is_local) VALUES (?,${FIELDS.map(() => '?').join(',')},?)`,
          args: [supplier_number, ...fieldArgs(body), csvBool(r.is_local) ? 1 : 0],
        });
        created++;
        await logItem(rowLabel, 'created', { supplier_id: Number(result.lastInsertRowid), supplier_number });
      } catch (e) {
        errors.push(`Row ${rowNum} (${rowLabel}): ${e.message}`);
        await logItem(rowLabel, 'error', { supplier_number, error_message: e.message });
      }
    }
    res.json({ created, skipped, errors, duplicates, total: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('suppliers'), async (req, res) => {
  try {
    const { rows: [supplier] } = await db.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [req.params.id] });
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    const { rows: recent_orders } = await db.execute({ sql: `SELECT po.*, b.name as branch_name FROM purchase_orders po LEFT JOIN branches b ON po.branch_id = b.id WHERE po.supplier_id = ? ORDER BY po.created_at DESC LIMIT 10`, args: [req.params.id] });
    supplier.recent_orders = recent_orders;
    res.json(supplier);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('suppliers'), async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  try {
    // The form lets a vendor number be typed in (or left blank / Auto-assign
    // for the next SUP- number); a clash is caught by the UNIQUE constraint.
    const supplier_number = String(req.body.supplier_number || '').trim() || await nextNumber(db, 'suppliers', 'supplier_number', 'SUP-', 4);
    const result = await db.execute({ sql: `INSERT INTO suppliers (supplier_number,${FIELDS.join(',')},is_local) VALUES (?,${FIELDS.map(() => '?').join(',')},?)`, args: [supplier_number, ...fieldArgs(req.body), req.body.is_local?1:0] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) {
    res.status(400).json({ error: uniqueMsg(e) });
  }
});

router.put('/:id', requirePermission('suppliers'), async (req, res) => {
  const { active, is_local } = req.body;
  try {
    await db.execute({ sql: `UPDATE suppliers SET supplier_number=COALESCE(?, supplier_number),${FIELDS.map(f => `${f}=?`).join(',')},active=?,is_local=? WHERE id=?`, args: [String(req.body.supplier_number || '').trim() || null, ...fieldArgs(req.body), active??1, is_local?1:0, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) {
    res.status(400).json({ error: uniqueMsg(e) });
  }
});

router.delete('/:id', requirePermission('suppliers'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE suppliers SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
