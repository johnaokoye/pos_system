const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { syncBinQty } = require('../lib/binSync');
const { resolveApprovalSignature } = require('../lib/signatures');
const { storeToday } = require('../lib/storeTime');
const { goLive, addLot, startTracking, lotsOnHand, round3, consignmentEnabled, costOn } = require('../lib/stockLots');
const settlement = require('../lib/consignmentSettlement');

// Consignment — supplier-owned stock (mounted at /api/consignment).
//   Agreement (CAG-): Purchasing drafts it (consignment_agreements) and
//   submits; Finance (consignment_finance) sets the revenue and output GCT
//   treatment (decision F3) and approves it — never their own.
//   Order (CON-) against an approved agreement, received in part or whole by
//   Consignment GRNs (CGRN-): Warehouse enters the delivery note and
//   quantities (consignment_receive); approval (consignment_grn_approve)
//   puts the stock on hand at the order's branch as supplier-owned lots.
// Nothing here posts to the ledger: the supplier owns the stock until it's
// sold (F5), so it's left out of Total Tools' inventory value.

const canView = requireAnyPermission('consignment', 'consignment_finance');
const err = (status, message) => Object.assign(new Error(message), { status });
const send = (res, e) => res.status(e.status || 500).json({ error: e.message });
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const RESPONSIBLE = ['supplier', 'total_tools'];
const TRIGGERS = ['sale'];
const FREQUENCIES = ['monthly'];
const TREATMENTS = ['principal', 'agent'];

// ── Tracking ────────────────────────────────────────────────
router.get('/status', canView, async (req, res) => {
  try { res.json({ go_live: await goLive(db), enabled: consignmentEnabled() }); } catch (e) { send(res, e); }
});

// Starts tracking stock receipts: everything on hand becomes one opening
// owned receipt dated now (decision A1 follow-up). Administrator only.
router.post('/go-live', requirePermission('settings'), async (req, res) => {
  if (String(req.body.confirm || '') !== 'START') return res.status(400).json({ error: 'Type START to confirm' });
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const out = await startTracking(tx, req.employee?.id || null);
    await tx.commit();
    committed = true;
    res.json(out);
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

// ── Agreements ──────────────────────────────────────────────
const AGREEMENT_SELECT = `SELECT a.*, s.name AS supplier_name, s.supplier_number,
  ce.first_name || ' ' || ce.last_name AS created_by_name, ae.first_name || ' ' || ae.last_name AS approved_by_name,
  fe.first_name || ' ' || fe.last_name AS finance_set_by_name, re.first_name || ' ' || re.last_name AS rejected_by_name,
  (SELECT COUNT(*) FROM consignment_agreement_items i WHERE i.agreement_id = a.id AND i.active = 1) AS item_count
  FROM consignment_agreements a JOIN suppliers s ON s.id = a.supplier_id
  LEFT JOIN employees ce ON ce.id = a.created_by LEFT JOIN employees ae ON ae.id = a.approved_by
  LEFT JOIN employees fe ON fe.id = a.finance_set_by LEFT JOIN employees re ON re.id = a.rejected_by`;

async function loadAgreement(id) {
  const { rows: [a] } = await db.execute({ sql: `${AGREEMENT_SELECT} WHERE a.id = ?`, args: [id] });
  if (!a) return null;
  const today = storeToday();
  const { rows: items } = await db.execute({
    sql: `SELECT i.id, i.product_id, i.active, p.name AS product_name, p.sku FROM consignment_agreement_items i JOIN products p ON p.id = i.product_id
          WHERE i.agreement_id = ? ORDER BY p.name`,
    args: [a.id],
  });
  for (const it of items) {
    const { rows: costs } = await db.execute({
      sql: `SELECT c.id, c.cost, c.effective_from, c.created_at, e.first_name || ' ' || e.last_name AS created_by_name FROM consignment_agreement_costs c
            LEFT JOIN employees e ON e.id = c.created_by WHERE c.agreement_item_id = ? ORDER BY c.effective_from DESC, c.id DESC`,
      args: [it.id],
    });
    it.costs = costs;
    const now = costs.find(c => c.effective_from <= today);
    it.current_cost = now ? Number(now.cost) : null;
  }
  a.items = items;
  return a;
}

router.get('/agreements', canView, async (req, res) => {
  try {
    const { status, supplier_id } = req.query;
    let sql = `${AGREEMENT_SELECT} WHERE 1=1`;
    const args = [];
    if (status) { sql += ' AND a.status = ?'; args.push(status); }
    if (supplier_id) { sql += ' AND a.supplier_id = ?'; args.push(supplier_id); }
    sql += ' ORDER BY a.id DESC LIMIT 500';
    res.json((await db.execute({ sql, args })).rows);
  } catch (e) { send(res, e); }
});

router.get('/agreements/:id', canView, async (req, res) => {
  try {
    const a = await loadAgreement(req.params.id);
    if (!a) return res.status(404).json({ error: 'Agreement not found' });
    res.json(a);
  } catch (e) { send(res, e); }
});

// Body: supplier_id, start_date, end_date, ownership_terms, billable_rule,
// shortage_responsibility, damage_responsibility, allow_work_orders,
// allow_shop_use, payment_terms, notes, items: [{ product_id, cost, effective_from? }].
async function validateAgreement(b) {
  if (!b.supplier_id) throw err(400, 'Choose the supplier');
  const { rows: [sup] } = await db.execute({ sql: 'SELECT id FROM suppliers WHERE id = ?', args: [b.supplier_id] });
  if (!sup) throw err(400, 'Supplier not found');
  if (!isDay(b.start_date)) throw err(400, 'Enter the date the agreement starts');
  if (b.end_date && !isDay(b.end_date)) throw err(400, 'The end date is not a valid date');
  if (b.end_date && b.end_date < b.start_date) throw err(400, 'The end date is before the start date');
  if (!String(b.ownership_terms || '').trim()) throw err(400, 'Enter the ownership terms — when the stock stops being the supplier\'s');
  for (const k of ['shortage_responsibility', 'damage_responsibility']) if (b[k] && !RESPONSIBLE.includes(b[k])) throw err(400, 'Responsibility is the supplier or Total Tools');
  if (b.billing_trigger && !TRIGGERS.includes(b.billing_trigger)) throw err(400, 'Billing trigger must be a completed sale');
  if (b.settlement_frequency && !FREQUENCIES.includes(b.settlement_frequency)) throw err(400, 'Settlement is monthly for now');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw err(400, 'Add at least one item with its agreed cost');
  const seen = new Set();
  for (const it of items) {
    if (!it.product_id) throw err(400, 'Each line needs an item');
    if (seen.has(Number(it.product_id))) throw err(400, 'An item is on the agreement twice');
    seen.add(Number(it.product_id));
    const { rows: [p] } = await db.execute({ sql: 'SELECT id, name, is_rental, is_service, is_non_inventory, (SELECT COUNT(*) FROM product_variations v WHERE v.product_id = products.id AND v.active = 1) AS variations FROM products WHERE id = ?', args: [it.product_id] });
    if (!p) throw err(400, 'Item not found');
    if (p.is_rental || p.is_service || p.is_non_inventory) throw err(400, `${p.name} isn't a stocked retail item`);
    if (Number(p.variations) > 0) throw err(400, `${p.name} has variations — consignment is tracked per item, so it can't go on an agreement`);
    if (!(Number(it.cost) >= 0) || it.cost === '' || it.cost == null) throw err(400, `Enter the agreed cost for ${p.name}`);
  }
  return items;
}

async function writeItems(tx, agreementId, items, startDate, employeeId) {
  await tx.execute({ sql: 'DELETE FROM consignment_agreement_costs WHERE agreement_item_id IN (SELECT id FROM consignment_agreement_items WHERE agreement_id = ?)', args: [agreementId] });
  await tx.execute({ sql: 'DELETE FROM consignment_agreement_items WHERE agreement_id = ?', args: [agreementId] });
  for (const it of items) {
    const r = await tx.execute({ sql: 'INSERT INTO consignment_agreement_items (agreement_id, product_id) VALUES (?,?)', args: [agreementId, it.product_id] });
    await tx.execute({ sql: 'INSERT INTO consignment_agreement_costs (agreement_item_id, cost, effective_from, created_by) VALUES (?,?,?,?)',
      args: [Number(r.lastInsertRowid), Number(it.cost), isDay(it.effective_from) ? it.effective_from : startDate, employeeId] });
  }
}

const AGREEMENT_FIELDS = b => [b.supplier_id, b.start_date, b.end_date || null, String(b.ownership_terms).trim(), b.billing_trigger || 'sale',
  String(b.billable_rule || '').trim() || 'Qualifying sales less eligible returns, plus approved shortages or damage Total Tools is responsible for',
  b.shortage_responsibility || 'supplier', b.damage_responsibility || 'supplier', b.allow_work_orders ? 1 : 0, b.allow_shop_use ? 1 : 0,
  b.settlement_frequency || 'monthly', String(b.payment_terms || '').trim() || null, String(b.notes || '').trim() || null];

router.post('/agreements', requirePermission('consignment_agreements'), async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const items = await validateAgreement(req.body);
    const number = await nextNumber(tx, 'consignment_agreements', 'agreement_number', 'CAG-', 6);
    const r = await tx.execute({
      sql: `INSERT INTO consignment_agreements (agreement_number, supplier_id, start_date, end_date, ownership_terms, billing_trigger, billable_rule,
              shortage_responsibility, damage_responsibility, allow_work_orders, allow_shop_use, settlement_frequency, payment_terms, notes, created_by, status, submitted_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [number, ...AGREEMENT_FIELDS(req.body), req.employee?.id || null, req.body.submit ? 'submitted' : 'draft', req.body.submit ? new Date().toISOString() : null],
    });
    const id = Number(r.lastInsertRowid);
    await writeItems(tx, id, items, req.body.start_date, req.employee?.id || null);
    await tx.commit();
    committed = true;
    res.status(201).json(await loadAgreement(id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

// Edited only as a draft or after rejection (back to draft, or submitted again).
router.put('/agreements/:id', requirePermission('consignment_agreements'), async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const { rows: [a] } = await tx.execute({ sql: 'SELECT * FROM consignment_agreements WHERE id = ?', args: [req.params.id] });
    if (!a) throw err(404, 'Agreement not found');
    if (!['draft', 'rejected'].includes(a.status)) throw err(400, `${a.agreement_number} is ${a.status} — only a draft or rejected agreement can be edited`);
    const items = await validateAgreement(req.body);
    await tx.execute({
      sql: `UPDATE consignment_agreements SET supplier_id=?, start_date=?, end_date=?, ownership_terms=?, billing_trigger=?, billable_rule=?, shortage_responsibility=?,
              damage_responsibility=?, allow_work_orders=?, allow_shop_use=?, settlement_frequency=?, payment_terms=?, notes=?, status=?, submitted_at=?,
              rejected_by=NULL, rejected_at=NULL WHERE id=?`,
      args: [...AGREEMENT_FIELDS(req.body), req.body.submit ? 'submitted' : 'draft', req.body.submit ? new Date().toISOString() : null, a.id],
    });
    await writeItems(tx, a.id, items, req.body.start_date, req.employee?.id || null);
    await tx.commit();
    committed = true;
    res.json(await loadAgreement(a.id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

router.post('/agreements/:id/submit', requirePermission('consignment_agreements'), async (req, res) => {
  try {
    const r = await db.execute({ sql: "UPDATE consignment_agreements SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft', 'rejected')", args: [req.params.id] });
    if (!r.rowsAffected) return res.status(400).json({ error: 'Only a draft or rejected agreement can be submitted' });
    res.json(await loadAgreement(req.params.id));
  } catch (e) { send(res, e); }
});

// Finance's part (F3): revenue treatment — principal (gross sales revenue,
// excluding GCT) or agent (commission / fee) — and the output GCT treatment.
router.post('/agreements/:id/finance', requirePermission('consignment_finance'), async (req, res) => {
  try {
    const treatment = String(req.body.revenue_treatment || '');
    if (!TREATMENTS.includes(treatment)) return res.status(400).json({ error: 'Choose the revenue treatment: principal or agent' });
    const gct = String(req.body.output_gct_treatment || '').trim();
    if (!gct) return res.status(400).json({ error: 'Enter the output GCT treatment for this arrangement' });
    const r = await db.execute({
      sql: `UPDATE consignment_agreements SET revenue_treatment = ?, output_gct_treatment = ?, finance_notes = ?, finance_set_by = ?, finance_set_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('draft', 'submitted')`,
      args: [treatment, gct, String(req.body.finance_notes || '').trim() || null, req.employee?.id || null, req.params.id],
    });
    if (!r.rowsAffected) return res.status(400).json({ error: 'The treatment is set before the agreement is approved' });
    res.json(await loadAgreement(req.params.id));
  } catch (e) { send(res, e); }
});

router.post('/agreements/:id/approve', requirePermission('consignment_finance'), async (req, res) => {
  try {
    const a = await loadAgreement(req.params.id);
    if (!a) return res.status(404).json({ error: 'Agreement not found' });
    if (a.status !== 'submitted') return res.status(400).json({ error: `${a.agreement_number} isn't waiting for approval` });
    if (Number(a.created_by) === Number(req.employee?.id)) return res.status(403).json({ error: 'You drafted this agreement, so someone else has to approve it' });
    if (!a.revenue_treatment || !a.output_gct_treatment) return res.status(400).json({ error: 'Set the revenue and output GCT treatment first (Finance)' });
    let sig;
    try { sig = await resolveApprovalSignature(db, req.employee?.id, req.body.signature); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
    await db.execute({ sql: "UPDATE consignment_agreements SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ? WHERE id = ? AND status = 'submitted'", args: [req.employee?.id || null, sig, a.id] });
    res.json(await loadAgreement(a.id));
  } catch (e) { send(res, e); }
});

router.post('/agreements/:id/reject', requirePermission('consignment_finance'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give the reason' });
    const r = await db.execute({ sql: "UPDATE consignment_agreements SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ? AND status = 'submitted'", args: [req.employee?.id || null, reason, req.params.id] });
    if (!r.rowsAffected) return res.status(400).json({ error: "This agreement isn't waiting for approval" });
    res.json(await loadAgreement(req.params.id));
  } catch (e) { send(res, e); }
});

// A new agreed cost from a date (A8): sales qualifying on or after it are
// owed at the new cost; earlier ones keep theirs.
router.post('/agreements/:id/costs', requirePermission('consignment_agreements'), async (req, res) => {
  try {
    const { product_id, effective_from } = req.body;
    const cost = Number(req.body.cost);
    if (!(cost >= 0) || req.body.cost === '' || req.body.cost == null) return res.status(400).json({ error: 'Enter the agreed cost' });
    if (!isDay(effective_from)) return res.status(400).json({ error: 'Enter the date the cost takes effect' });
    const { rows: [it] } = await db.execute({ sql: 'SELECT i.id FROM consignment_agreement_items i JOIN consignment_agreements a ON a.id = i.agreement_id WHERE i.agreement_id = ? AND i.product_id = ? AND a.status != \'ended\'', args: [req.params.id, product_id] });
    if (!it) return res.status(400).json({ error: "That item isn't on this agreement" });
    await db.execute({ sql: 'INSERT INTO consignment_agreement_costs (agreement_item_id, cost, effective_from, created_by) VALUES (?,?,?,?)', args: [it.id, cost, effective_from, req.employee?.id || null] });
    res.json(await loadAgreement(req.params.id));
  } catch (e) { send(res, e); }
});

router.post('/agreements/:id/end', requirePermission('consignment_agreements'), async (req, res) => {
  try {
    const r = await db.execute({ sql: "UPDATE consignment_agreements SET status = 'ended', ended_by = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'approved'", args: [req.employee?.id || null, req.params.id] });
    if (!r.rowsAffected) return res.status(400).json({ error: 'Only an approved agreement can be ended' });
    res.json(await loadAgreement(req.params.id));
  } catch (e) { send(res, e); }
});

// ── Orders ──────────────────────────────────────────────────
const ORDER_SELECT = `SELECT o.*, a.agreement_number, s.name AS supplier_name, b.name AS branch_name, e.first_name || ' ' || e.last_name AS created_by_name
  FROM consignment_orders o JOIN consignment_agreements a ON a.id = o.agreement_id JOIN suppliers s ON s.id = o.supplier_id
  JOIN branches b ON b.id = o.branch_id LEFT JOIN employees e ON e.id = o.created_by`;

async function loadOrder(executor, id) {
  const { rows: [o] } = await executor.execute({ sql: `${ORDER_SELECT} WHERE o.id = ?`, args: [id] });
  if (!o) return null;
  const { rows: items } = await executor.execute({
    sql: `SELECT oi.*, p.name AS product_name, p.sku,
            (SELECT COALESCE(SUM(gi.quantity), 0) FROM consignment_grn_items gi JOIN consignment_grns g ON g.id = gi.grn_id WHERE gi.order_item_id = oi.id AND g.status = 'pending') AS quantity_pending
          FROM consignment_order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`,
    args: [o.id],
  });
  o.items = items.map(i => ({ ...i, quantity_left: round3(i.quantity_ordered - i.quantity_received - i.quantity_pending) }));
  const { rows: grns } = await executor.execute({ sql: 'SELECT id, grn_number, delivery_note_number, status, received_at, approved_at FROM consignment_grns WHERE order_id = ? ORDER BY id', args: [o.id] });
  o.grns = grns;
  return o;
}

router.get('/orders', canView, async (req, res) => {
  try {
    const { status, agreement_id } = req.query;
    let sql = `${ORDER_SELECT} WHERE 1=1`;
    const args = [];
    if (status) { sql += ' AND o.status = ?'; args.push(status); }
    if (agreement_id) { sql += ' AND o.agreement_id = ?'; args.push(agreement_id); }
    sql += ' ORDER BY o.id DESC LIMIT 500';
    res.json((await db.execute({ sql, args })).rows);
  } catch (e) { send(res, e); }
});

router.get('/orders/:id', canView, async (req, res) => {
  try {
    const o = await loadOrder(db, req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json(o);
  } catch (e) { send(res, e); }
});

// { agreement_id, branch_id, expected_date, notes, items: [{ product_id, quantity }] }
router.post('/orders', requirePermission('consignment_agreements'), async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const { agreement_id, branch_id } = req.body;
    const { rows: [a] } = await tx.execute({ sql: 'SELECT * FROM consignment_agreements WHERE id = ?', args: [agreement_id || 0] });
    if (!a) throw err(400, 'Choose the agreement');
    if (a.status !== 'approved') throw err(400, `${a.agreement_number} isn't approved — stock can only be ordered on an approved agreement`);
    const { rows: [b] } = await tx.execute({ sql: 'SELECT id FROM branches WHERE id = ? AND COALESCE(active, 1) = 1', args: [branch_id || 0] });
    if (!b) throw err(400, 'Choose the branch receiving the stock');
    const items = (Array.isArray(req.body.items) ? req.body.items : []).map(i => ({ product_id: Number(i.product_id), quantity: round3(i.quantity) })).filter(i => i.quantity > 0);
    if (!items.length) throw err(400, 'Add at least one item and quantity');
    for (const i of items) {
      const { rows: [on] } = await tx.execute({ sql: 'SELECT id FROM consignment_agreement_items WHERE agreement_id = ? AND product_id = ? AND active = 1', args: [a.id, i.product_id] });
      if (!on) throw err(400, `An item isn't on ${a.agreement_number}`);
    }
    const number = await nextNumber(tx, 'consignment_orders', 'order_number', 'CON-', 6);
    const r = await tx.execute({
      sql: 'INSERT INTO consignment_orders (order_number, agreement_id, supplier_id, branch_id, expected_date, notes, created_by) VALUES (?,?,?,?,?,?,?)',
      args: [number, a.id, a.supplier_id, b.id, isDay(req.body.expected_date) ? req.body.expected_date : null, String(req.body.notes || '').trim() || null, req.employee?.id || null],
    });
    const id = Number(r.lastInsertRowid);
    for (const i of items) await tx.execute({ sql: 'INSERT INTO consignment_order_items (order_id, product_id, quantity_ordered) VALUES (?,?,?)', args: [id, i.product_id, i.quantity] });
    await tx.commit();
    committed = true;
    res.status(201).json(await loadOrder(db, id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

router.post('/orders/:id/cancel', requirePermission('consignment_agreements'), async (req, res) => {
  try {
    const o = await loadOrder(db, req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.grns.some(g => g.status === 'pending')) return res.status(400).json({ error: 'A GRN on this order is waiting for approval — approve or reject it first' });
    if (!['open', 'partial'].includes(o.status)) return res.status(400).json({ error: `${o.order_number} is ${o.status}` });
    // Partly received: the rest is cancelled; what came in stays.
    await db.execute({ sql: "UPDATE consignment_orders SET status = ?, cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", args: [o.status === 'partial' ? 'received' : 'cancelled', req.employee?.id || null, o.id] });
    res.json(await loadOrder(db, o.id));
  } catch (e) { send(res, e); }
});

// ── Consignment GRNs ────────────────────────────────────────
const GRN_SELECT = `SELECT g.*, o.order_number, a.agreement_number, s.name AS supplier_name, b.name AS branch_name,
  re.first_name || ' ' || re.last_name AS received_by_name, ap.first_name || ' ' || ap.last_name AS approved_by_name, rj.first_name || ' ' || rj.last_name AS rejected_by_name
  FROM consignment_grns g JOIN consignment_orders o ON o.id = g.order_id JOIN consignment_agreements a ON a.id = g.agreement_id
  JOIN suppliers s ON s.id = g.supplier_id JOIN branches b ON b.id = g.branch_id
  LEFT JOIN employees re ON re.id = g.received_by LEFT JOIN employees ap ON ap.id = g.approved_by LEFT JOIN employees rj ON rj.id = g.rejected_by`;

async function loadGrn(executor, id) {
  const { rows: [g] } = await executor.execute({ sql: `${GRN_SELECT} WHERE g.id = ?`, args: [id] });
  if (!g) return null;
  const { rows: items } = await executor.execute({ sql: 'SELECT gi.*, p.name AS product_name, p.sku FROM consignment_grn_items gi JOIN products p ON p.id = gi.product_id WHERE gi.grn_id = ? ORDER BY gi.id', args: [g.id] });
  g.items = items;
  return g;
}

router.get('/grns', canView, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `${GRN_SELECT} WHERE 1=1`;
    const args = [];
    if (status) { sql += ' AND g.status = ?'; args.push(status); }
    sql += ' ORDER BY g.id DESC LIMIT 500';
    res.json((await db.execute({ sql, args })).rows);
  } catch (e) { send(res, e); }
});

router.get('/grns/:id', canView, async (req, res) => {
  try {
    const g = await loadGrn(db, req.params.id);
    if (!g) return res.status(404).json({ error: 'GRN not found' });
    res.json(g);
  } catch (e) { send(res, e); }
});

// Warehouse enters what came in against the supplier's delivery note:
// { delivery_note_number, notes, items: [{ order_item_id, quantity }] } — no
// more than is left on each line (counting GRNs still pending). Nothing moves
// until it's approved.
router.post('/orders/:id/grns', requirePermission('consignment_receive'), async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const o = await loadOrder(tx, req.params.id);
    if (!o) throw err(404, 'Order not found');
    if (!['open', 'partial'].includes(o.status)) throw err(400, `${o.order_number} is ${o.status} — nothing more can be received on it`);
    const note = String(req.body.delivery_note_number || '').trim();
    if (!note) throw err(400, "Enter the supplier's delivery note number");
    const lines = (Array.isArray(req.body.items) ? req.body.items : []).map(i => ({ order_item_id: Number(i.order_item_id), quantity: round3(i.quantity) })).filter(i => i.quantity > 0);
    if (!lines.length) throw err(400, 'Enter the quantity received for at least one item');
    for (const l of lines) {
      const it = o.items.find(i => Number(i.id) === l.order_item_id);
      if (!it) throw err(400, "A line isn't on this order");
      if (l.quantity - it.quantity_left > 0.0005) throw err(400, `Only ${it.quantity_left} of ${it.product_name} is left to receive on ${o.order_number}`);
      l.product_id = it.product_id;
    }
    const number = await nextNumber(tx, 'consignment_grns', 'grn_number', 'CGRN-', 6);
    const r = await tx.execute({
      sql: 'INSERT INTO consignment_grns (grn_number, order_id, agreement_id, supplier_id, branch_id, delivery_note_number, notes, received_by) VALUES (?,?,?,?,?,?,?,?)',
      args: [number, o.id, o.agreement_id, o.supplier_id, o.branch_id, note, String(req.body.notes || '').trim() || null, req.employee?.id || null],
    });
    const id = Number(r.lastInsertRowid);
    for (const l of lines) await tx.execute({ sql: 'INSERT INTO consignment_grn_items (grn_id, order_item_id, product_id, quantity) VALUES (?,?,?,?)', args: [id, l.order_item_id, l.product_id, l.quantity] });
    await tx.commit();
    committed = true;
    res.status(201).json(await loadGrn(db, id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

// Approving puts the stock on hand: branch and overall stock, bins, a stock
// movement, and one supplier-owned lot per line (dated now, agreed cost in
// effect today for reference — what's owed is the cost on the day each unit
// is sold, A8). Needs tracking to have started, so lots have something to
// sit beside.
router.post('/grns/:id/approve', requirePermission('consignment_grn_approve'), async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    if (!(await goLive(tx))) throw err(400, 'Consignment tracking hasn\'t started yet — an Administrator starts it in Consignment → Stock');
    const g = await loadGrn(tx, req.params.id);
    if (!g) throw err(404, 'GRN not found');
    if (g.status !== 'pending') throw err(400, `${g.grn_number} is ${g.status}`);
    const claim = await tx.execute({ sql: "UPDATE consignment_grns SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", args: [req.employee?.id || null, g.id] });
    if (!claim.rowsAffected) throw err(400, `${g.grn_number} has already been dealt with`);
    const today = storeToday();
    for (const l of g.items) {
      const qty = round3(l.quantity);
      await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, l.product_id] });
      await tx.execute({
        sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP)
              ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`,
        args: [l.product_id, g.branch_id, qty, l.product_id, qty],
      });
      await syncBinQty(tx, l.product_id, g.branch_id, qty);
      await tx.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',
        args: [l.product_id, g.branch_id, qty, 'consignment_received', g.grn_number, `Consignment from ${g.supplier_name} (${g.agreement_number}), delivery note ${g.delivery_note_number}`] });
      const c = await costOn(tx, g.agreement_id, l.product_id, today);
      await addLot(tx, { product_id: l.product_id, branch_id: g.branch_id, owner: 'consignment', supplier_id: g.supplier_id, agreement_id: g.agreement_id,
        source_type: 'consignment_grn', source_id: g.id, source_number: g.grn_number, qty, unit_cost: c ? c.cost : null, employee_id: req.employee?.id || null });
      await tx.execute({ sql: 'UPDATE consignment_order_items SET quantity_received = quantity_received + ? WHERE id = ?', args: [qty, l.order_item_id] });
    }
    const o = await loadOrder(tx, g.order_id);
    const done = o.items.every(i => i.quantity_received >= i.quantity_ordered - 0.0005);
    await tx.execute({ sql: "UPDATE consignment_orders SET status = ? WHERE id = ? AND status IN ('open', 'partial')", args: [done ? 'received' : 'partial', o.id] });
    await tx.commit();
    committed = true;
    res.json(await loadGrn(db, g.id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

router.post('/grns/:id/reject', requirePermission('consignment_grn_approve'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give the reason' });
    const r = await db.execute({ sql: "UPDATE consignment_grns SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ? AND status = 'pending'", args: [req.employee?.id || null, reason, req.params.id] });
    if (!r.rowsAffected) return res.status(400).json({ error: "This GRN isn't waiting for approval" });
    res.json(await loadGrn(db, req.params.id));
  } catch (e) { send(res, e); }
});

// ── Stock ───────────────────────────────────────────────────
// Consignment stock report (F5): supplier-owned quantities on hand by
// supplier, agreement, branch and item, at the agreed cost in effect today —
// kept apart from Total Tools' inventory value.
router.get('/stock', canView, async (req, res) => {
  try {
    const { supplier_id, agreement_id, branch_id } = req.query;
    const where = ["l.owner = 'consignment'", 'l.qty_on_hand > 0'];
    const args = [];
    if (supplier_id) { where.push('l.supplier_id = ?'); args.push(supplier_id); }
    if (agreement_id) { where.push('l.agreement_id = ?'); args.push(agreement_id); }
    if (branch_id) { where.push('l.branch_id = ?'); args.push(branch_id); }
    const { rows } = await db.execute({
      sql: `SELECT l.supplier_id, s.name AS supplier_name, l.agreement_id, a.agreement_number, l.branch_id, b.name AS branch_name, l.product_id, p.name AS product_name, p.sku,
              SUM(l.qty_on_hand) AS qty_on_hand, SUM(l.qty_reserved) AS qty_reserved, MIN(l.received_at) AS oldest_receipt
            FROM stock_lots l JOIN suppliers s ON s.id = l.supplier_id JOIN consignment_agreements a ON a.id = l.agreement_id
            JOIN branches b ON b.id = l.branch_id JOIN products p ON p.id = l.product_id
            WHERE ${where.join(' AND ')} GROUP BY l.supplier_id, l.agreement_id, l.branch_id, l.product_id ORDER BY s.name, a.agreement_number, b.name, p.name`,
      args,
    });
    const today = storeToday();
    for (const r of rows) {
      const c = await costOn(db, r.agreement_id, r.product_id, today);
      r.agreed_cost = c ? c.cost : null;
      r.value = c ? Math.round(c.cost * Number(r.qty_on_hand) * 100) / 100 : null;
    }
    res.json({ go_live: await goLive(db), rows, total_value: Math.round(rows.reduce((t, r) => t + (r.value || 0), 0) * 100) / 100 });
  } catch (e) { send(res, e); }
});

// Who owns what's on hand for an item (every branch, or one), receipt by receipt.
router.get('/lots', requireAnyPermission('consignment', 'consignment_finance', 'inventory'), async (req, res) => {
  try {
    res.json(await lotsOnHand(db, { product_id: req.query.product_id || null, branch_id: req.query.branch_id || null }));
  } catch (e) { send(res, e); }
});

// Which stock receipts a sale drew from — owner, supplier, agreement, cost —
// and what's been returned of each.
router.get('/allocations', requireAnyPermission('consignment', 'consignment_finance', 'transactions'), async (req, res) => {
  try {
    if (req.query.plan_id) {
      const { rows } = await db.execute({
        sql: `SELECT la.*, s.name AS supplier_name, a.agreement_number FROM layaway_lot_allocations la LEFT JOIN suppliers s ON s.id = la.supplier_id
              LEFT JOIN consignment_agreements a ON a.id = la.agreement_id WHERE la.plan_id = ? ORDER BY la.id`,
        args: [req.query.plan_id],
      });
      return res.json(rows);
    }
    if (!req.query.transaction_id) return res.status(400).json({ error: 'Give the transaction' });
    const { rows } = await db.execute({
      sql: `SELECT sa.*, s.name AS supplier_name, a.agreement_number, l.source_number AS lot_source_number, ti.product_name
            FROM sale_lot_allocations sa LEFT JOIN suppliers s ON s.id = sa.supplier_id LEFT JOIN consignment_agreements a ON a.id = sa.agreement_id
            LEFT JOIN stock_lots l ON l.id = sa.lot_id JOIN transaction_items ti ON ti.id = sa.transaction_item_id
            WHERE sa.transaction_id = ? ORDER BY sa.id`,
      args: [req.query.transaction_id],
    });
    res.json(rows);
  } catch (e) { send(res, e); }
});

// Safety check: every item and branch whose stock receipts don't add up to
// its branch stock figure (should be none).
router.get('/lot-check', canView, async (req, res) => {
  try {
    if (!(await goLive(db))) return res.json({ go_live: null, mismatches: [] });
    const { rows } = await db.execute({
      sql: `SELECT x.product_id, x.branch_id, p.name AS product_name, b.name AS branch_name, x.branch_qty, x.lots_qty FROM (
              SELECT k.product_id, k.branch_id, COALESCE(bi.stock_qty, 0) AS branch_qty,
                COALESCE((SELECT SUM(l.qty_on_hand) FROM stock_lots l WHERE l.product_id = k.product_id AND l.branch_id = k.branch_id), 0) AS lots_qty
              FROM (SELECT product_id, branch_id FROM stock_lots
                    UNION SELECT bi2.product_id, bi2.branch_id FROM branch_inventory bi2 JOIN products p2 ON p2.id = bi2.product_id
                      WHERE bi2.stock_qty <> 0 AND COALESCE(p2.is_rental, 0) = 0 AND COALESCE(p2.is_service, 0) = 0 AND COALESCE(p2.is_non_inventory, 0) = 0
                        AND NOT EXISTS (SELECT 1 FROM product_variations v WHERE v.product_id = p2.id AND v.active = 1)) k
              LEFT JOIN branch_inventory bi ON bi.product_id = k.product_id AND bi.branch_id = k.branch_id
            ) x JOIN products p ON p.id = x.product_id JOIN branches b ON b.id = x.branch_id
            WHERE ABS(x.branch_qty - x.lots_qty) > 0.0005 AND x.branch_qty >= 0 ORDER BY p.name`,
      args: [],
    });
    res.json({ go_live: await goLive(db), mismatches: rows });
  } catch (e) { send(res, e); }
});

// ── Month-end reconciliation (lib/consignmentRecon.js) ─────
// Prepared (and its physical counts entered) by Receiving / Warehouse or
// Finance; chargeable shortages and damage approved, and the whole approved
// and locked, by Finance (A9). A locked month is a snapshot: a later return
// lands in the next open month (A3). Reopening: an Administrator, recording
// the reason, the Finance approver and the approval reference.
const { writeLines, periodBounds } = require('../lib/consignmentRecon');
const canPrepare = requireAnyPermission('consignment_receive', 'consignment_finance');

async function loadRecon(id) {
  const { rows: [r] } = await db.execute({
    sql: `SELECT r.*, a.agreement_number, a.shortage_responsibility, a.damage_responsibility, s.name AS supplier_name,
            pe.first_name || ' ' || pe.last_name AS prepared_by_name, ae.first_name || ' ' || ae.last_name AS approved_by_name
          FROM consignment_reconciliations r JOIN consignment_agreements a ON a.id = r.agreement_id JOIN suppliers s ON s.id = a.supplier_id
          LEFT JOIN employees pe ON pe.id = r.prepared_by LEFT JOIN employees ae ON ae.id = r.approved_by WHERE r.id = ?`,
    args: [id],
  });
  if (!r) return null;
  r.totals = r.totals_json ? JSON.parse(r.totals_json) : {};
  const { rows: lines } = await db.execute({
    sql: `SELECT l.*, p.name AS product_name, p.sku, b.name AS branch_name FROM consignment_reconciliation_lines l JOIN products p ON p.id = l.product_id
          LEFT JOIN branches b ON b.id = l.branch_id WHERE l.recon_id = ? ORDER BY l.line_type DESC, p.name, b.name`,
    args: [r.id],
  });
  r.lines = lines;
  const { rows: log } = await db.execute({ sql: `SELECT g.*, e.first_name || ' ' || e.last_name AS employee_name FROM consignment_reconciliation_log g LEFT JOIN employees e ON e.id = g.employee_id WHERE g.recon_id = ? ORDER BY g.id`, args: [r.id] });
  r.log = log;
  r.period_ended = periodBounds(r.period).last < storeToday();
  const { rows: sts } = await db.execute({ sql: "SELECT id, settlement_number, status, total FROM consignment_settlements WHERE recon_id = ? ORDER BY id DESC", args: [r.id] });
  r.settlement = sts.find(x => x.status !== 'cancelled') || null;
  return r;
}
const reconLog = (ex, reconId, action, employeeId, extra = {}) => ex.execute({
  sql: 'INSERT INTO consignment_reconciliation_log (recon_id, action, reason, finance_approver, approval_reference, details, employee_id) VALUES (?,?,?,?,?,?,?)',
  args: [reconId, action, extra.reason || null, extra.finance_approver || null, extra.approval_reference || null, extra.details ? JSON.stringify(extra.details) : null, employeeId || null],
});

router.get('/reconciliations', canView, async (req, res) => {
  try {
    const args = [];
    let sql = `SELECT r.id, r.recon_number, r.period, r.status, r.approved_at, r.totals_json, a.agreement_number, s.name AS supplier_name
               FROM consignment_reconciliations r JOIN consignment_agreements a ON a.id = r.agreement_id JOIN suppliers s ON s.id = a.supplier_id WHERE 1=1`;
    if (req.query.agreement_id) { sql += ' AND r.agreement_id = ?'; args.push(req.query.agreement_id); }
    sql += ' ORDER BY r.period DESC, r.id DESC LIMIT 500';
    const { rows } = await db.execute({ sql, args });
    res.json(rows.map(r => ({ ...r, totals: r.totals_json ? JSON.parse(r.totals_json) : {}, totals_json: undefined })));
  } catch (e) { send(res, e); }
});

router.get('/reconciliations/:id', canView, async (req, res) => {
  try {
    const r = await loadRecon(req.params.id);
    if (!r) return res.status(404).json({ error: 'Reconciliation not found' });
    res.json(r);
  } catch (e) { send(res, e); }
});

// { agreement_id, period: 'YYYY-MM' } — one per agreement per month.
router.post('/reconciliations', canPrepare, async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    periodBounds(req.body.period);
    const { rows: [a] } = await tx.execute({ sql: 'SELECT * FROM consignment_agreements WHERE id = ?', args: [req.body.agreement_id || 0] });
    if (!a) throw err(400, 'Choose the agreement');
    if (!['approved', 'ended'].includes(a.status)) throw err(400, `${a.agreement_number} isn't approved`);
    const { rows: [dup] } = await tx.execute({ sql: 'SELECT recon_number FROM consignment_reconciliations WHERE agreement_id = ? AND period = ?', args: [a.id, req.body.period] });
    if (dup) throw err(400, `${dup.recon_number} already covers ${a.agreement_number} for ${req.body.period}`);
    const number = await nextNumber(tx, 'consignment_reconciliations', 'recon_number', 'CREC-', 6);
    const r = await tx.execute({ sql: 'INSERT INTO consignment_reconciliations (recon_number, agreement_id, period, prepared_by) VALUES (?,?,?,?)', args: [number, a.id, req.body.period, req.employee?.id || null] });
    const recon = { id: Number(r.lastInsertRowid), period: req.body.period };
    await writeLines(tx, recon, a);
    await reconLog(tx, recon.id, 'prepared', req.employee?.id);
    await tx.commit();
    committed = true;
    res.status(201).json(await loadRecon(recon.id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

async function draftRecon(ex, id) {
  const { rows: [r] } = await ex.execute({ sql: 'SELECT * FROM consignment_reconciliations WHERE id = ?', args: [id] });
  if (!r) throw err(404, 'Reconciliation not found');
  if (r.status !== 'draft') throw err(400, `${r.recon_number} is approved and locked — an Administrator can reopen it on Finance's documented approval`);
  const { rows: [a] } = await ex.execute({ sql: 'SELECT * FROM consignment_agreements WHERE id = ?', args: [r.agreement_id] });
  return { r, a };
}

// Recomputes a draft from the records, keeping the counts and approvals entered.
router.post('/reconciliations/:id/refresh', canPrepare, async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const { r, a } = await draftRecon(tx, req.params.id);
    await writeLines(tx, r, a);
    await tx.commit();
    committed = true;
    res.json(await loadRecon(r.id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

// A line's physical count (preparers), or its approved chargeable shortage /
// damage (Finance — only where the agreement makes Total Tools responsible).
router.patch('/reconciliations/:id/lines/:lineId', canPrepare, async (req, res) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const { r, a } = await draftRecon(tx, req.params.id);
    const { rows: [l] } = await tx.execute({ sql: 'SELECT * FROM consignment_reconciliation_lines WHERE id = ? AND recon_id = ?', args: [req.params.lineId, r.id] });
    if (!l) throw err(404, 'Line not found');
    const sets = [];
    const args = [];
    const details = {};
    if (req.body.physical_count !== undefined) {
      if (l.line_type !== 'stock') throw err(400, 'Stock in transit is not counted');
      const v = req.body.physical_count === null || req.body.physical_count === '' ? null : Number(req.body.physical_count);
      if (v != null && !(v >= 0)) throw err(400, 'Enter the count (0 or more)');
      sets.push('physical_count = ?'); args.push(v); details.physical_count = v;
    }
    for (const [field, resp, label] of [['approved_shortage_qty', 'shortage_responsibility', 'shortages'], ['approved_damage_qty', 'damage_responsibility', 'damage']]) {
      if (req.body[field] === undefined) continue;
      if (!can(req.employee?.permissions, 'consignment_finance')) throw err(403, 'Approving chargeable shortages or damage is for Finance');
      const v = Number(req.body[field]) || 0;
      if (v < 0) throw err(400, 'Enter 0 or more');
      if (v > 0 && a[resp] !== 'total_tools') throw err(400, `Under ${a.agreement_number} the supplier bears ${label}, so none can be charged to Total Tools`);
      sets.push(`${field} = ?`); args.push(v); details[field] = v;
    }
    if (!sets.length) throw err(400, 'Nothing to change');
    await tx.execute({ sql: `UPDATE consignment_reconciliation_lines SET ${sets.join(', ')} WHERE id = ?`, args: [...args, l.id] });
    await reconLog(tx, r.id, 'line_updated', req.employee?.id, { details: { line_id: l.id, ...details } });
    await writeLines(tx, r, a); // recompute discrepancy, caps and billable figures
    await tx.commit();
    committed = true;
    res.json(await loadRecon(r.id));
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    send(res, e);
  }
});

// Finance approves the month — after it has ended and every line is
// counted — and it locks. Recomputed one last time first.
router.post('/reconciliations/:id/approve', requirePermission('consignment_finance'), async (req, res) => {
  try {
    const cur = await loadRecon(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Reconciliation not found' });
    if (cur.status !== 'draft') return res.status(400).json({ error: `${cur.recon_number} is already approved` });
    if (!cur.period_ended) return res.status(400).json({ error: `${cur.period} hasn't ended yet — approve it after the month-end cut-off` });
    if (cur.lines.some(l => l.line_type === 'stock' && l.physical_count == null)) return res.status(400).json({ error: 'Enter the physical count for every line first' });
    let sig;
    try { sig = await resolveApprovalSignature(db, req.employee?.id, req.body.signature); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const { r, a } = await draftRecon(tx, cur.id);
      await writeLines(tx, r, a);
      await tx.execute({ sql: "UPDATE consignment_reconciliations SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ? WHERE id = ? AND status = 'draft'", args: [req.employee?.id || null, sig, r.id] });
      const logged = await reconLog(tx, r.id, 'approved', req.employee?.id);
      // The month's settlement statement, and its month-end entries for Books.
      await settlement.createSettlement(tx, r.id, req.employee?.id);
      await settlement.queueReconPostings(tx, r.id, Number(logged.lastInsertRowid));
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      throw e;
    }
    res.json(await loadRecon(cur.id));
  } catch (e) { send(res, e); }
});

// Reopening a locked month: an Administrator acting on Finance's documented
// approval — reason, Finance approver and approval reference all required.
router.post('/reconciliations/:id/reopen', requirePermission('settings'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const approver = String(req.body.finance_approver || '').trim();
    const reference = String(req.body.approval_reference || '').trim();
    if (!reason || !approver || !reference) return res.status(400).json({ error: "Give the reason, the Finance approver and the approval reference (e.g. the email or memo)" });
    const r = await loadRecon(req.params.id);
    if (!r) return res.status(404).json({ error: 'Reconciliation not found' });
    if (r.status !== 'approved') return res.status(400).json({ error: `${r.recon_number} isn't locked` });
    const tx = await db.transaction('write');
    let committed = false;
    try {
      // Refused while its settlement is on a live A/P bill; otherwise the
      // settlement is cancelled and its month-end entries reversed.
      await settlement.cancelForReopen(tx, r.id, `Month reopened: ${reason}`, req.employee?.id);
      await settlement.reverseReconPostings(tx, r.id);
      await tx.execute({ sql: "UPDATE consignment_reconciliations SET status = 'draft', approved_by = NULL, approved_at = NULL, approval_signature = NULL WHERE id = ?", args: [r.id] });
      await reconLog(tx, r.id, 'reopened', req.employee?.id, { reason, finance_approver: approver, approval_reference: reference });
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback().catch(() => {});
      throw e;
    }
    res.json(await loadRecon(r.id));
  } catch (e) { send(res, e); }
});

// ── Settlements, invoice matching (Phase 4) ─────────────────
// lib/consignmentSettlement.js. Made when Finance approves a month; A/P
// enters the supplier's invoice against it (payables_bills), Finance resolves
// any differences (consignment_finance), A/P accepts it into an A/P bill.
const canSeeSettlements = requireAnyPermission('consignment', 'consignment_finance', 'payables');
const inTx = async (res, work, status = 200) => {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const out = await work(tx);
    await tx.commit();
    committed = true;
    return out;
  } catch (e) {
    if (!committed) await tx.rollback().catch(() => {});
    throw e;
  }
};

router.get('/settlements', canSeeSettlements, async (req, res) => {
  try {
    const args = [];
    let sql = `SELECT s.id, s.settlement_number, s.period, s.status, s.subtotal, s.expected_tax, s.total, s.created_at, a.agreement_number, sp.name AS supplier_name, r.recon_number, b.bill_number,
                 (SELECT i.supplier_invoice_number FROM consignment_invoices i WHERE i.settlement_id = s.id AND i.status != 'rejected' ORDER BY i.id DESC LIMIT 1) AS invoice_number
               FROM consignment_settlements s JOIN consignment_agreements a ON a.id = s.agreement_id JOIN suppliers sp ON sp.id = s.supplier_id
               JOIN consignment_reconciliations r ON r.id = s.recon_id LEFT JOIN ap_bills b ON b.id = s.bill_id WHERE 1=1`;
    if (req.query.status) { sql += ' AND s.status = ?'; args.push(req.query.status); }
    if (req.query.supplier_id) { sql += ' AND s.supplier_id = ?'; args.push(req.query.supplier_id); }
    sql += ' ORDER BY s.period DESC, s.id DESC LIMIT 500';
    res.json((await db.execute({ sql, args })).rows);
  } catch (e) { send(res, e); }
});

router.get('/settlements/:id', canSeeSettlements, async (req, res) => {
  try {
    const s = await settlement.loadSettlement(db, req.params.id);
    if (!s) return res.status(404).json({ error: 'Settlement not found' });
    res.json(s);
  } catch (e) { send(res, e); }
});

// A month approved before settlements existed (or one with nothing owed then
// corrected) gets its statement made here.
router.post('/reconciliations/:id/settlement', requirePermission('consignment_finance'), async (req, res) => {
  try {
    const id = await inTx(res, async tx => {
      const { rows: [r] } = await tx.execute({ sql: 'SELECT * FROM consignment_reconciliations WHERE id = ?', args: [req.params.id] });
      if (!r) throw err(404, 'Reconciliation not found');
      if (r.status !== 'approved') throw err(400, `${r.recon_number} has to be approved first`);
      const { rows: [live] } = await tx.execute({ sql: "SELECT settlement_number FROM consignment_settlements WHERE recon_id = ? AND status != 'cancelled'", args: [r.id] });
      if (live) throw err(400, `${live.settlement_number} already covers ${r.recon_number}`);
      const made = await settlement.createSettlement(tx, r.id, req.employee?.id);
      if (!made) throw err(400, `Nothing is owed to or by the supplier for ${r.period}`);
      return made;
    });
    res.status(201).json(await settlement.loadSettlement(db, id));
  } catch (e) { send(res, e); }
});

router.post('/settlements/:id/invoice', requirePermission('payables_bills'), async (req, res) => {
  try {
    await inTx(res, tx => settlement.enterInvoice(tx, req.params.id, req.body || {}, req.employee?.id));
    res.status(201).json(await settlement.loadSettlement(db, req.params.id));
  } catch (e) { send(res, e); }
});

router.post('/settlements/:id/invoice/lines/:lineId/resolve', requirePermission('consignment_finance'), async (req, res) => {
  try {
    await inTx(res, tx => settlement.resolveLine(tx, req.params.id, req.params.lineId, req.body || {}, req.employee?.id));
    res.json(await settlement.loadSettlement(db, req.params.id));
  } catch (e) { send(res, e); }
});

router.post('/settlements/:id/invoice/accept', requirePermission('payables_bills'), async (req, res) => {
  try {
    await inTx(res, tx => settlement.acceptInvoice(tx, req.params.id, req.employee?.id));
    res.json(await settlement.loadSettlement(db, req.params.id));
  } catch (e) { send(res, e); }
});

router.post('/settlements/:id/invoice/reject', requireAnyPermission('payables_bills', 'consignment_finance'), async (req, res) => {
  try {
    await inTx(res, tx => settlement.rejectInvoice(tx, req.params.id, req.body?.reason, req.employee?.id));
    res.json(await settlement.loadSettlement(db, req.params.id));
  } catch (e) { send(res, e); }
});

// Printable settlement statement.
router.get('/settlements/:id/statement', canSeeSettlements, async (req, res) => {
  try {
    const s = await settlement.loadSettlement(db, req.params.id);
    if (!s) return res.status(404).json({ error: 'Settlement not found' });
    const { rows: [co] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_name'", args: [] });
    const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const money = n => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const q = n => String(Math.round((Number(n) || 0) * 1000) / 1000);
    const td = (v, right = true) => `<td style="padding:4px 6px;border-bottom:1px solid #ddd;${right ? 'text-align:right' : ''}">${v}</td>`;
    const th = (v, right = true) => `<th style="padding:4px 6px;border-bottom:2px solid #333;${right ? 'text-align:right' : 'text-align:left'}">${v}</th>`;
    res.set('X-Pos-Document', 'consignment-settlement');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.settlement_number)}</title></head>
      <body style="font-family:Arial,sans-serif;font-size:12px;color:#111;margin:24px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div><div style="font-size:18px;font-weight:700">${esc(co?.value || 'Total Tools')}</div><div style="font-size:16px;margin-top:6px">Consignment Settlement Statement</div></div>
          <div style="text-align:right"><div style="font-size:16px;font-weight:700">${esc(s.settlement_number)}</div><div>Period: ${esc(s.period)}</div><div>Reconciliation ${esc(s.recon_number)}</div></div>
        </div>
        <div style="margin:14px 0">Supplier: <strong>${esc(s.supplier_name)}</strong>${s.supplier_number ? ` (${esc(s.supplier_number)})` : ''} · Agreement ${esc(s.agreement_number)}</div>
        <table style="width:100%;border-collapse:collapse"><thead><tr>${th('Item', false)}${th('Sold')}${th('Layaways paid')}${th('Work orders')}${th('Returned')}${th('Shop use')}${th('Chargeable short/damage')}${th('Billable qty')}${th('Unit cost')}${th('Amount')}${th('GCT')}</tr></thead>
          <tbody>${s.lines.map(l => `<tr>${td(esc(l.product_name) + (l.corrected_at ? ` <em style="color:#666">(corrected: ${esc(l.correction_reason)})</em>` : ''), false)}${td(q(l.sales_qty))}${td(q(l.layaway_qty))}${td(q(l.work_order_qty))}${td(q(-(l.returns_qty + l.prior_returns_qty)))}${td(q(l.shop_use_qty))}${td(q(l.chargeable_qty))}${td(q(l.billable_qty))}${td(l.unit_cost == null ? '' : money(l.unit_cost))}${td(money(l.billable_value))}${td(money(l.expected_tax))}</tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="9" style="padding:6px;text-align:right">Subtotal</td>${td(money(s.subtotal))}${td(money(s.expected_tax))}</tr>
            <tr><td colspan="9" style="padding:6px;text-align:right;font-weight:700">Total owed</td><td colspan="2" style="padding:6px;text-align:right;font-weight:700">${money(s.total)}</td></tr></tfoot></table>
        ${s.adjustments.length ? `<div style="margin-top:16px;font-weight:700">Adjustments — returns this month of earlier months' sales</div>
          <table style="width:100%;border-collapse:collapse;margin-top:4px"><thead><tr>${th('Return', false)}${th('Original sale', false)}${th('Sale month', false)}${th('Item', false)}${th('Qty')}${th('Credit')}</tr></thead>
          <tbody>${s.adjustments.map(a => `<tr>${td(esc(a.return_number || a.kind), false)}${td(esc(a.sale_number), false)}${td(esc(String(a.sale_qualified_on || '').slice(0, 7)), false)}${td(esc(a.product_name), false)}${td(q(a.qty))}${td(money(-a.value))}</tr>`).join('')}</tbody></table>` : ''}
        <div style="margin-top:16px;color:#555">Sales and returns are at the agreed cost saved on each sale; shop use and chargeable shortages/damage at the agreed cost on the last day of the month. Expected GCT is a guide — input GCT is taken from the supplier's tax invoice.</div>
      </body></html>`);
  } catch (e) { send(res, e); }
});

// ── Accounting feed for RetailPOS Books (F1, F4) ────────────
// API key scopes consignment:read (feed) / consignment:write (ack).
router.get('/postings-feed', requirePermission('consignment_finance'), async (req, res) => {
  try {
    await inTx(res, tx => settlement.queueAccruals(tx));
    const { rows } = await db.execute({
      sql: `SELECT p.id, p.source_key AS external_id, p.source_type, p.posting_date AS date, p.debit_role, p.credit_role, p.inventory_account_code, p.amount, p.reference, p.memo, p.status,
              a.agreement_number, s.name AS supplier_name, a.revenue_treatment
            FROM consignment_postings p LEFT JOIN consignment_agreements a ON a.id = p.agreement_id LEFT JOIN suppliers s ON s.id = p.supplier_id
            WHERE p.status IN ('pending', 'failed', 'waiting') ORDER BY p.posting_date, p.id LIMIT 1000`,
      args: [],
    });
    res.json(rows);
  } catch (e) { send(res, e); }
});

// { id, status: 'posted' | 'failed' | 'waiting', external_ref, error }
// 'waiting' = Books hasn't got the consignment accounts set yet (F4).
router.post('/postings-ack', requirePermission('consignment_finance'), async (req, res) => {
  try {
    const { id, status } = req.body || {};
    const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM consignment_postings WHERE id = ?', args: [id || 0] });
    if (!p) return res.status(404).json({ error: 'Posting not found' });
    if (status === 'posted') {
      const ref = String(req.body.external_ref || '').trim();
      if (!ref) return res.status(400).json({ error: 'external_ref is required' });
      if (p.status === 'posted' && p.external_ref && p.external_ref !== ref) return res.status(409).json({ error: `Already posted as ${p.external_ref}` });
      await db.execute({ sql: "UPDATE consignment_postings SET status = 'posted', external_ref = ?, posted_at = COALESCE(posted_at, CURRENT_TIMESTAMP), last_error = NULL WHERE id = ?", args: [ref, p.id] });
    } else if (status === 'failed' || status === 'waiting') {
      if (p.status === 'posted') return res.status(409).json({ error: `Already posted as ${p.external_ref}` });
      await db.execute({ sql: 'UPDATE consignment_postings SET status = ?, last_error = ?, attempts = attempts + 1 WHERE id = ?', args: [status, String(req.body.error || '').slice(0, 500) || null, p.id] });
    } else return res.status(400).json({ error: 'status must be posted, failed or waiting' });
    res.json({ success: true });
  } catch (e) { send(res, e); }
});

// The entries and how they went, for the Consignment screen.
router.get('/postings', canView, async (req, res) => {
  try {
    await inTx(res, tx => settlement.queueAccruals(tx));
    const args = [];
    let sql = `SELECT p.*, a.agreement_number, s.name AS supplier_name FROM consignment_postings p LEFT JOIN consignment_agreements a ON a.id = p.agreement_id
               LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE 1=1`;
    if (req.query.status) { sql += ' AND p.status = ?'; args.push(req.query.status); }
    sql += ' ORDER BY p.id DESC LIMIT 500';
    const { rows } = await db.execute({ sql, args });
    const { rows: counts } = await db.execute({ sql: 'SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM consignment_postings GROUP BY status', args: [] });
    res.json({ postings: rows, counts });
  } catch (e) { send(res, e); }
});

module.exports = router;
module.exports.costOn = costOn;
