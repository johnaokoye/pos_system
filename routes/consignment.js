const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { syncBinQty } = require('../lib/binSync');
const { resolveApprovalSignature } = require('../lib/signatures');
const { storeToday } = require('../lib/storeTime');
const { goLive, addLot, startTracking, lotsOnHand, round3, consignmentEnabled } = require('../lib/stockLots');

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
// The agreed cost in effect on `day` for an item on an agreement (A8).
async function costOn(executor, agreementId, productId, day) {
  const { rows: [r] } = await executor.execute({
    sql: `SELECT c.cost, c.effective_from FROM consignment_agreement_costs c JOIN consignment_agreement_items i ON i.id = c.agreement_item_id
          WHERE i.agreement_id = ? AND i.product_id = ? AND c.effective_from <= ? ORDER BY c.effective_from DESC, c.id DESC LIMIT 1`,
    args: [agreementId, productId, day],
  });
  return r ? { cost: Number(r.cost), effective_from: r.effective_from } : null;
}

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
    const { rows: [p] } = await db.execute({ sql: 'SELECT id, name, is_rental, is_service, is_non_inventory FROM products WHERE id = ?', args: [it.product_id] });
    if (!p) throw err(400, 'Item not found');
    if (p.is_rental || p.is_service || p.is_non_inventory) throw err(400, `${p.name} isn't a stocked retail item`);
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

module.exports = router;
module.exports.costOn = costOn;
