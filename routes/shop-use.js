const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../database');
const { can, requireAnyPermission, requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { uploadSignature } = require('../lib/signatures');
const { resolvePurchaseUnit, lineName, parseQty } = require('../lib/units');
const { renderDocumentPdf } = require('../lib/documentPdf');
const {
  CATEGORIES, CATEGORY_KEYS, categoryLabel, DEFAULT_INVENTORY_ACCOUNT,
  round2, round4, empName, seesAll, audit, onHand, refreshFulfillment,
  routeRequest, approvalAuthority, accountMapping, queuePosting, moveStock, stockUnits,
} = require('../lib/shopUse');

// Shop Use — stock taken for company use, mounted at /api/shop-use. See
// lib/shopUse.js for the flow. Roles (lib/permissions.js):
//   shop_use_request  raise, edit, submit and cancel your own requests
//   shop_use_approve  approve / reject / return within your authority (standalone, never your own)
//   shop_use_issue    issue approved requests, receive returns, keep the tool register
//   shop_use_finance  account mapping, postings, reversals, reconciliation
//   shop_use_routing  approval rules and limits
//   shop_use_reports  dashboards and reports
// Requesters see only their own requests; everyone else in the module sees all.

const inModule = requireAnyPermission('shop_use', 'shop_use_approve');
const perms = req => req.employee?.permissions || {};
const isApiKey = req => !!req.apiKey;
const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });

// Runs fn(tx) in one write transaction. Never rolls back after a commit —
// that throws and takes the process down (see the rollback-after-commit note
// in routes/purchase-requests.js).
async function inTransaction(fn) {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const out = await fn(tx);
    await tx.commit();
    committed = true;
    return out;
  } catch (e) {
    if (!committed) await tx.rollback();
    throw e;
  }
}

class UserError extends Error { constructor(msg, status = 400, extra) { super(msg); this.status = status; this.extra = extra; } }
const sendError = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });

const REQ_SELECT = `SELECT r.*, b.name AS branch_name, sb.name AS source_branch_name,
    e.first_name || ' ' || e.last_name AS requested_by_name,
    d.first_name || ' ' || d.last_name AS decided_by_name,
    (SELECT COUNT(*) FROM shop_use_request_lines l WHERE l.request_id = r.id) AS line_count,
    (SELECT COALESCE(SUM(MAX(0, l.qty_approved - l.qty_issued - l.qty_cancelled)), 0) FROM shop_use_request_lines l WHERE l.request_id = r.id AND l.qty_approved IS NOT NULL) AS qty_outstanding,
    (SELECT COALESCE(SUM(MAX(0, l.qty_approved - l.qty_issued - l.qty_cancelled) * l.unit_cost), 0) FROM shop_use_request_lines l WHERE l.request_id = r.id AND l.qty_approved IS NOT NULL) AS value_outstanding,
    (SELECT COALESCE(SUM(i.total_cost), 0) FROM shop_use_issues i WHERE i.request_id = r.id) -
      (SELECT COALESCE(SUM(x.total_cost), 0) FROM shop_use_returns x WHERE x.request_id = r.id) AS net_cost,
    (SELECT CASE WHEN COUNT(*) = 0 THEN NULL WHEN SUM(p.status = 'failed') > 0 THEN 'failed' WHEN SUM(p.status = 'pending') > 0 THEN 'pending' ELSE 'posted' END
       FROM shop_use_postings p WHERE p.request_id = r.id) AS posting_status,
    (SELECT CASE WHEN COUNT(*) = 0 THEN NULL WHEN SUM(p.recon_status = 'unreconciled') > 0 THEN 'unreconciled' ELSE 'reconciled' END
       FROM shop_use_postings p WHERE p.request_id = r.id) AS recon_status
  FROM shop_use_requests r
  LEFT JOIN branches b ON b.id = r.branch_id
  LEFT JOIN branches sb ON sb.id = r.source_branch_id
  LEFT JOIN employees e ON e.id = r.requested_by
  LEFT JOIN employees d ON d.id = r.decided_by`;

function parseApprovers(r) {
  try { return JSON.parse(r.routed_approvers || '[]'); } catch { return []; }
}

async function approvalHours() {
  const { rows: [s] } = await db.execute("SELECT value FROM settings WHERE key = 'shop_use_approval_hours'");
  return Number(s?.value) > 0 ? Number(s.value) : 24;
}

async function loadRequest(id, executor = db) {
  const { rows: [r] } = await executor.execute({ sql: `${REQ_SELECT} WHERE r.id = ?`, args: [id] });
  if (!r) return null;
  r.category_label = categoryLabel(r.category);
  r.routed_approvers = parseApprovers(r);
  const { rows: lines } = await executor.execute({
    sql: `SELECT l.*, p.name AS product_name, p.cost AS current_cost, u.allow_decimal, t.tool_number, t.status AS tool_status
          FROM shop_use_request_lines l
          LEFT JOIN products p ON p.id = l.product_id
          LEFT JOIN units_of_measure u ON u.id = l.uom_id
          LEFT JOIN shop_use_tools t ON t.id = l.tool_id
          WHERE l.request_id = ? ORDER BY l.id`,
    args: [id],
  });
  for (const l of lines) {
    l.allow_decimal = l.allow_decimal ? 1 : 0;
    const per = Number(l.units_per) || 1;
    const remaining = Math.max(0, round4((l.qty_approved ?? l.qty_requested) - l.qty_issued - l.qty_cancelled));
    l.outstanding = l.qty_approved == null ? null : remaining;
    if (l.product_id) {
      l.on_hand_units = await onHand(executor, l.product_id, r.source_branch_id);
      l.available = round4(l.on_hand_units / per);
      l.shortage = round4(Math.max(0, remaining * per - l.on_hand_units) / per);
    } else {
      l.on_hand_units = null;
      l.available = l.tool_status === 'available' ? 1 : 0;
      l.shortage = remaining > 0 && l.tool_status !== 'available' ? remaining : 0;
    }
    l.line_total = round2(l.qty_requested * l.unit_cost);
  }
  r.lines = lines;
  r.total_approved = round2(lines.reduce((s, l) => s + (l.qty_approved ?? 0) * l.unit_cost, 0));
  const { rows: approvals } = await executor.execute({
    sql: `SELECT a.*, e.first_name || ' ' || e.last_name AS employee_name FROM shop_use_approvals a
          LEFT JOIN employees e ON e.id = a.employee_id WHERE a.request_id = ? ORDER BY a.id`,
    args: [id],
  });
  r.approvals = approvals;
  const { rows: issues } = await executor.execute({
    sql: `SELECT i.*, e.first_name || ' ' || e.last_name AS issued_by_name, sb.name AS source_branch_name,
            p.id AS posting_id, p.status AS posting_status, p.last_error AS posting_error, p.recon_status
          FROM shop_use_issues i LEFT JOIN employees e ON e.id = i.issued_by LEFT JOIN branches sb ON sb.id = i.source_branch_id
          LEFT JOIN shop_use_postings p ON p.source_type = 'issue' AND p.source_id = i.id
          WHERE i.request_id = ? ORDER BY i.id`,
    args: [id],
  });
  for (const i of issues) {
    const { rows: il } = await executor.execute({
      sql: `SELECT il.*, l.description, l.sku, l.unit_name, l.units_per FROM shop_use_issue_lines il
            JOIN shop_use_request_lines l ON l.id = il.request_line_id WHERE il.issue_id = ? ORDER BY il.id`,
      args: [i.id],
    });
    for (const x of il) {
      const { rows: tools } = await executor.execute({ sql: 'SELECT id, tool_number, serial_number, status FROM shop_use_tools WHERE issue_line_id = ? ORDER BY id', args: [x.id] });
      x.tools = tools;
    }
    i.lines = il;
  }
  r.issues = issues;
  const { rows: returns } = await executor.execute({
    sql: `SELECT x.*, i.issue_number, e.first_name || ' ' || e.last_name AS received_by_name,
            p.id AS posting_id, p.status AS posting_status, p.last_error AS posting_error, p.recon_status
          FROM shop_use_returns x JOIN shop_use_issues i ON i.id = x.issue_id LEFT JOIN employees e ON e.id = x.received_by
          LEFT JOIN shop_use_postings p ON p.source_type = 'return' AND p.source_id = x.id
          WHERE x.request_id = ? ORDER BY x.id`,
    args: [id],
  });
  for (const x of returns) {
    const { rows: rl } = await executor.execute({
      sql: `SELECT rl.*, l.description, l.unit_name FROM shop_use_return_lines rl
            JOIN shop_use_issue_lines il ON il.id = rl.issue_line_id JOIN shop_use_request_lines l ON l.id = il.request_line_id
            WHERE rl.return_id = ? ORDER BY rl.id`,
      args: [x.id],
    });
    x.lines = rl;
  }
  r.returns = returns;
  const { rows: postings } = await executor.execute({ sql: 'SELECT * FROM shop_use_postings WHERE request_id = ? ORDER BY id', args: [id] });
  r.postings = postings;
  const { rows: attachments } = await executor.execute({
    sql: `SELECT a.*, e.first_name || ' ' || e.last_name AS uploaded_by_name FROM shop_use_attachments a
          LEFT JOIN employees e ON e.id = a.uploaded_by WHERE a.request_id = ? ORDER BY a.id`,
    args: [id],
  });
  r.attachments = attachments;
  const { rows: prs } = await executor.execute({ sql: 'SELECT id, pr_number, status, created_at FROM purchase_requests WHERE shop_use_request_id = ? ORDER BY id', args: [id] });
  r.purchase_requests = prs;
  const { rows: trail } = await executor.execute({ sql: 'SELECT * FROM shop_use_audit WHERE request_id = ? ORDER BY id', args: [id] });
  r.audit = trail;
  return r;
}

// Can this employee see the request at all?
function canSee(req, r) {
  return isApiKey(req) || seesAll(perms(req)) || Number(r.requested_by) === Number(req.employee?.id);
}

// ── Lookups ────────────────────────────────────────────────────────────────

router.get('/meta', inModule, async (req, res) => {
  try {
    const [{ rows: branches }, { rows: departments }, { rows: employees }] = await Promise.all([
      db.execute('SELECT id, name, is_warehouse FROM branches WHERE active = 1 ORDER BY name'),
      db.execute('SELECT name FROM pr_departments ORDER BY name COLLATE NOCASE'),
      db.execute("SELECT id, first_name || ' ' || last_name AS name FROM employees WHERE active = 1 ORDER BY first_name, last_name"),
    ]);
    const { rows: settings } = await db.execute("SELECT key, value FROM settings WHERE key IN ('shop_use_approval_hours', 'shop_use_inventory_account')");
    const s = Object.fromEntries(settings.map(r => [r.key, r.value]));
    res.json({
      categories: CATEGORIES, branches, departments: departments.map(d => d.name), employees,
      settings: { approval_hours: Number(s.shop_use_approval_hours) || 24, inventory_account: s.shop_use_inventory_account || DEFAULT_INVENTORY_ACCOUNT },
    });
  } catch (e) { sendError(res, e); }
});

// Departments share the purchase-request pick-list.
router.post('/departments', requirePermission('shop_use_request'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return fail(res, 400, 'Department name is required');
    if (name.length > 100) return fail(res, 400, 'Department name is too long');
    await db.execute({ sql: 'INSERT OR IGNORE INTO pr_departments (name, created_by) VALUES (?, ?)', args: [name, req.employee?.id || null] });
    const { rows: [d] } = await db.execute({ sql: 'SELECT name FROM pr_departments WHERE name = ?', args: [name] });
    res.json(d || { name });
  } catch (e) { sendError(res, e); }
});

// Item search for the request form: stocked items only (no services or
// rental items), with on-hand at the supplying location, inventory cost and
// alternate units.
router.get('/items', inModule, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const branchId = req.query.branch_id || null;
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    const { rows } = await db.execute({
      sql: `SELECT p.id, p.sku, p.barcode, p.name, p.cost, p.base_unit_id, um.name AS base_unit_name, um.allow_decimal AS base_allow_decimal,
              ${branchId ? '(SELECT stock_qty FROM branch_inventory bi WHERE bi.product_id = p.id AND bi.branch_id = ?)' : 'p.stock_qty'} AS on_hand
            FROM products p LEFT JOIN units_of_measure um ON um.id = p.base_unit_id
            WHERE COALESCE(p.active, 1) = 1 AND COALESCE(p.is_service, 0) = 0 AND COALESCE(p.is_rental, 0) = 0
              AND (p.sku LIKE ? OR p.name LIKE ? OR p.barcode = ?)
            ORDER BY CASE WHEN p.sku = ? OR p.barcode = ? THEN 0 ELSE 1 END, p.name LIMIT 30`,
      args: [...(branchId ? [branchId] : []), like, like, q, q, q],
    });
    for (const p of rows) {
      p.on_hand = Number(p.on_hand) || 0;
      const { rows: units } = await db.execute({
        sql: `SELECT pu.unit_id, pu.factor, u.name, u.allow_decimal FROM product_units pu JOIN units_of_measure u ON u.id = pu.unit_id
              WHERE pu.product_id = ? ORDER BY pu.factor`,
        args: [p.id],
      });
      p.units = units;
    }
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

// ── Request lines ──────────────────────────────────────────────────────────
// Normalizes the form's lines: { id?, product_id | tool_id, uom_id, quantity,
// equipment_ref, notes }. Inventory lines are costed at inventory cost
// (products.cost per stock unit × the unit's size) — never the selling price.
async function normalizeLines(rawLines, existing = []) {
  const byId = new Map(existing.map(l => [Number(l.id), l]));
  const out = [];
  const seen = new Set();
  for (const raw of rawLines || []) {
    const prev = raw.id ? byId.get(Number(raw.id)) : null;
    if (raw.id && !prev) throw new UserError('A line on this request no longer exists — reload and try again');
    if (raw.tool_id) {
      const { rows: [t] } = await db.execute({ sql: 'SELECT * FROM shop_use_tools WHERE id = ?', args: [raw.tool_id] });
      if (!t) throw new UserError('Tool not found');
      const key = `t${t.id}`;
      if (seen.has(key)) throw new UserError(`${t.tool_number} is listed twice`);
      seen.add(key);
      if (t.status !== 'available' && !(prev && Number(prev.tool_id) === Number(t.id))) {
        throw new UserError(`${t.tool_number} ${t.description} isn't available to borrow (${t.status})`);
      }
      out.push({ id: prev?.id || null, product_id: null, tool_id: t.id, sku: t.tool_number, description: `${t.description}${t.serial_number ? ` (S/N ${t.serial_number})` : ''} — borrowed from tool register`,
        uom_id: null, unit_name: null, units_per: 1, qty_requested: 1, unit_cost: 0,
        equipment_ref: String(raw.equipment_ref || '').trim() || null, notes: String(raw.notes || '').trim() || null, prev });
      continue;
    }
    if (!raw.product_id) throw new UserError('Pick an item for every line');
    const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [raw.product_id] });
    if (!p) throw new UserError('Item not found');
    if (p.is_service || p.is_rental) throw new UserError(`${p.name} isn't a stocked item — only inventory can be taken for Shop Use`);
    let unit;
    try { unit = await resolvePurchaseUnit(db, p, raw.uom_id || null); }
    catch (e) { throw new UserError(e.message); }
    const qty = parseQty(raw.quantity, unit.allow_decimal);
    if (!(qty > 0)) throw new UserError(`Enter a ${unit.allow_decimal ? '' : 'whole '}quantity for ${p.name}`);
    const key = `p${p.id}:${unit.uom_id || ''}`;
    if (seen.has(key)) throw new UserError(`${p.name} is listed twice — combine the quantities on one line`);
    seen.add(key);
    // A line that has already had stock issued keeps its item, unit and cost.
    if (prev && Number(prev.qty_issued) > 0) {
      if (Number(prev.product_id) !== Number(p.id) || String(prev.uom_id || '') !== String(unit.uom_id || '')) {
        throw new UserError(`${prev.description} has already been issued — its item and unit can't change`);
      }
      if (qty < Number(prev.qty_issued) + Number(prev.qty_cancelled)) {
        throw new UserError(`${prev.description}: ${prev.qty_issued} already issued${Number(prev.qty_cancelled) ? ` and ${prev.qty_cancelled} cancelled` : ''} — the quantity can't go below that`);
      }
    }
    out.push({
      id: prev?.id || null, product_id: p.id, tool_id: null, sku: p.sku, description: lineName(p.name, unit),
      uom_id: unit.uom_id ?? null, unit_name: unit.purchase_unit || null, units_per: unit.units_per,
      qty_requested: qty,
      unit_cost: prev && Number(prev.qty_issued) > 0 ? Number(prev.unit_cost) : round4((Number(p.cost) || 0) * unit.units_per),
      equipment_ref: String(raw.equipment_ref || '').trim() || null, notes: String(raw.notes || '').trim() || null, prev,
    });
  }
  if (!out.length) throw new UserError('Add at least one item');
  for (const l of existing) {
    if (!out.some(o => Number(o.id) === Number(l.id)) && Number(l.qty_issued) > 0) {
      throw new UserError(`${l.description} has already been issued and can't be removed — cancel its outstanding quantity instead`);
    }
  }
  return out;
}

async function headerFrom(body) {
  const category = String(body.category || '');
  if (!CATEGORY_KEYS.includes(category)) throw new UserError('Choose the Shop Use category');
  const branch_id = Number(body.branch_id) || null;
  const source_branch_id = Number(body.source_branch_id) || null;
  const department = String(body.department || '').trim() || null;
  if (!branch_id) throw new UserError('Choose the branch the items are for');
  if (!department) throw new UserError('Choose the department the items are for');
  if (!source_branch_id) throw new UserError('Choose the stock location supplying the items');
  for (const bid of [branch_id, source_branch_id]) {
    const { rows: [b] } = await db.execute({ sql: 'SELECT id FROM branches WHERE id = ?', args: [bid] });
    if (!b) throw new UserError('Branch not found');
  }
  const reason = String(body.reason || '').trim();
  if (!reason) throw new UserError('Give the reason the items are needed');
  return {
    category, branch_id, source_branch_id, department, reason,
    equipment_ref: String(body.equipment_ref || '').trim() || null,
    project_ref: String(body.project_ref || '').trim() || null,
    notes: String(body.notes || '').trim() || null,
  };
}

async function writeLines(tx, requestId, lines, existing = []) {
  const keep = new Set(lines.filter(l => l.id).map(l => Number(l.id)));
  for (const l of existing) {
    if (!keep.has(Number(l.id))) await tx.execute({ sql: 'DELETE FROM shop_use_request_lines WHERE id = ?', args: [l.id] });
  }
  for (const l of lines) {
    if (l.id) {
      await tx.execute({
        sql: `UPDATE shop_use_request_lines SET product_id = ?, tool_id = ?, sku = ?, description = ?, uom_id = ?, unit_name = ?, units_per = ?,
                qty_requested = ?, unit_cost = ?, equipment_ref = ?, notes = ? WHERE id = ?`,
        args: [l.product_id, l.tool_id, l.sku, l.description, l.uom_id, l.unit_name, l.units_per, l.qty_requested, l.unit_cost, l.equipment_ref, l.notes, l.id],
      });
    } else {
      await tx.execute({
        sql: `INSERT INTO shop_use_request_lines (request_id, product_id, tool_id, sku, description, uom_id, unit_name, units_per, qty_requested, unit_cost, equipment_ref, notes)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [requestId, l.product_id, l.tool_id, l.sku, l.description, l.uom_id, l.unit_name, l.units_per, l.qty_requested, l.unit_cost, l.equipment_ref, l.notes],
      });
    }
  }
}

const linesTotal = lines => round2(lines.reduce((s, l) => s + l.qty_requested * l.unit_cost, 0));

// Routes a request for approval and records it (action: submitted /
// resubmitted / amended). Throws a UserError when no one can approve it.
async function sendForApproval(tx, requestId, employee, action, comments = null) {
  const { rows: [r] } = await tx.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [requestId] });
  const route = await routeRequest(tx, r);
  if (route.error) throw new UserError(route.error);
  await tx.execute({
    sql: `UPDATE shop_use_requests SET approval_status = 'pending_approval', routed_rule_id = ?, routed_approvers = ?, submitted_at = CURRENT_TIMESTAMP,
            decided_by = NULL, decided_at = NULL, decision_comment = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [route.rule?.id || null, JSON.stringify(route.approvers), requestId],
  });
  await tx.execute({
    sql: 'INSERT INTO shop_use_approvals (request_id, version, action, employee_id, comments, rule_id, amount) VALUES (?,?,?,?,?,?,?)',
    args: [requestId, r.version, action, employee?.id || null, comments, route.rule?.id || null, r.total_estimated],
  });
  await audit(tx, { requestId, entity: 'request', entityId: requestId, action, employee,
    details: { version: r.version, total: r.total_estimated, rule: route.rule?.name || 'Any Shop Use approver', approvers: route.approvers.map(a => a.name) } });
  return route;
}

// ── Requests ───────────────────────────────────────────────────────────────

router.get('/requests', inModule, async (req, res) => {
  try {
    const q = req.query;
    let sql = `${REQ_SELECT} WHERE 1=1`;
    const args = [];
    if (!seesAll(perms(req)) || q.mine === '1') { sql += ' AND r.requested_by = ?'; args.push(req.employee?.id || 0); }
    for (const [param, col] of [['approval_status', 'r.approval_status'], ['fulfillment_status', 'r.fulfillment_status'], ['branch_id', 'r.branch_id'],
      ['category', 'r.category'], ['requested_by', 'r.requested_by'], ['decided_by', 'r.decided_by'], ['source_branch_id', 'r.source_branch_id']]) {
      if (q[param]) {
        const vals = String(q[param]).split(',').filter(Boolean);
        sql += ` AND ${col} IN (${vals.map(() => '?').join(',')})`;
        args.push(...vals);
      }
    }
    if (q.department) { sql += ' AND LOWER(r.department) = LOWER(?)'; args.push(q.department); }
    if (q.from) { sql += ' AND date(r.created_at) >= ?'; args.push(q.from); }
    if (q.to) { sql += ' AND date(r.created_at) <= ?'; args.push(q.to); }
    if (q.q && String(q.q).trim()) {
      const like = `%${String(q.q).trim()}%`;
      sql += ` AND (r.request_number LIKE ? OR r.reason LIKE ? OR r.equipment_ref LIKE ? OR r.project_ref LIKE ? OR (e.first_name || ' ' || e.last_name) LIKE ?
        OR EXISTS (SELECT 1 FROM shop_use_request_lines l WHERE l.request_id = r.id AND (l.description LIKE ? OR l.sku LIKE ?)))`;
      args.push(like, like, like, like, like, like, like);
    }
    sql += ' ORDER BY r.id DESC LIMIT ?';
    args.push(Math.min(Number(q.limit) || 300, 1000));
    let { rows } = await db.execute({ sql, args });
    if (q.posting_status) rows = rows.filter(r => r.posting_status === q.posting_status);
    if (q.recon_status) rows = rows.filter(r => r.recon_status === q.recon_status);
    const hours = await approvalHours();
    const me = Number(req.employee?.id);
    for (const r of rows) {
      r.category_label = categoryLabel(r.category);
      r.routed_approvers = parseApprovers(r);
      r.awaiting_me = r.approval_status === 'pending_approval' && r.routed_approvers.some(a => Number(a.id) === me);
      r.overdue = r.approval_status === 'pending_approval' && r.submitted_at && (Date.now() - new Date(r.submitted_at.replace(' ', 'T') + 'Z')) > hours * 3600e3;
    }
    if (q.awaiting_me === '1') rows = rows.filter(r => r.awaiting_me);
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

router.get('/requests/:id', inModule, async (req, res) => {
  try {
    const r = await loadRequest(req.params.id);
    if (!r || !canSee(req, r)) return fail(res, 404, 'Shop Use request not found');
    const me = Number(req.employee?.id);
    r.awaiting_me = r.approval_status === 'pending_approval' && r.routed_approvers.some(a => Number(a.id) === me);
    if (r.approval_status === 'pending_approval' && req.employee) {
      const auth = await approvalAuthority(db, req.employee, r);
      r.can_decide = auth.ok;
      r.decide_block = auth.ok ? null : auth.error;
    }
    res.json(r);
  } catch (e) { sendError(res, e); }
});

router.post('/requests', requirePermission('shop_use_request'), async (req, res) => {
  try {
    const header = await headerFrom(req.body);
    const lines = await normalizeLines(req.body.lines);
    const total = linesTotal(lines);
    const id = await inTransaction(async tx => {
      const number = await nextNumber(tx, 'shop_use_requests', 'request_number', 'SU-', 6);
      const r = await tx.execute({
        sql: `INSERT INTO shop_use_requests (request_number, requested_by, branch_id, department, source_branch_id, category, reason, equipment_ref, project_ref, notes, total_estimated)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [number, req.employee?.id || null, header.branch_id, header.department, header.source_branch_id, header.category, header.reason,
          header.equipment_ref, header.project_ref, header.notes, total],
      });
      const id = Number(r.lastInsertRowid);
      await writeLines(tx, id, lines);
      await audit(tx, { requestId: id, entity: 'request', entityId: id, action: 'created', employee: req.employee,
        details: { ...header, total, lines: lines.map(l => ({ item: l.description, qty: l.qty_requested })) } });
      if (req.body.submit) await sendForApproval(tx, id, req.employee, 'submitted');
      return id;
    });
    res.status(201).json(await loadRequest(id));
  } catch (e) { sendError(res, e); }
});

// Edit. A draft or returned request is just saved. A pending one, or an
// approved one not yet fully issued, goes back for (re)approval when anything
// that was approved changes — items, quantities, supplying location, benefiting
// branch/department or category; notes and references alone don't.
router.put('/requests/:id', requirePermission('shop_use_request'), async (req, res) => {
  try {
    const { rows: [cur] } = await db.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [req.params.id] });
    if (!cur) return fail(res, 404, 'Shop Use request not found');
    if (Number(cur.requested_by) !== Number(req.employee?.id)) return fail(res, 403, 'Only the requester can change this request');
    if (cur.approval_status === 'rejected') return fail(res, 400, 'A rejected request can\'t be changed — raise a new one');
    if (['issued', 'cancelled'].includes(cur.fulfillment_status)) return fail(res, 400, `This request is ${cur.fulfillment_status === 'issued' ? 'fully issued' : 'cancelled'} and can't be changed`);
    const header = await headerFrom(req.body);
    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM shop_use_request_lines WHERE request_id = ?', args: [cur.id] });
    const lines = await normalizeLines(req.body.lines, existing);
    const anyIssued = existing.some(l => Number(l.qty_issued) > 0);
    if (anyIssued) {
      for (const [k, label] of [['source_branch_id', 'supplying location'], ['branch_id', 'benefiting branch'], ['department', 'department'], ['category', 'category']]) {
        if (String(cur[k] ?? '') !== String(header[k] ?? '')) return fail(res, 400, `Items have already been issued on this request — its ${label} can't change`);
      }
    }
    const changes = {};
    for (const k of ['category', 'branch_id', 'department', 'source_branch_id', 'reason', 'equipment_ref', 'project_ref', 'notes']) {
      if (String(cur[k] ?? '') !== String(header[k] ?? '')) changes[k] = { from: cur[k], to: header[k] };
    }
    const lineChanges = [];
    for (const l of lines) {
      if (!l.prev) lineChanges.push({ added: l.description, qty: l.qty_requested });
      else if (Number(l.prev.qty_requested) !== l.qty_requested || String(l.prev.uom_id || '') !== String(l.uom_id || '') || Number(l.prev.product_id || 0) !== Number(l.product_id || 0) || Number(l.prev.tool_id || 0) !== Number(l.tool_id || 0)) {
        lineChanges.push({ changed: l.description, from: l.prev.qty_requested, to: l.qty_requested });
      }
    }
    for (const l of existing) if (!lines.some(n => Number(n.id) === Number(l.id))) lineChanges.push({ removed: l.description });
    const material = lineChanges.length || ['category', 'branch_id', 'department', 'source_branch_id'].some(k => k in changes);
    const total = linesTotal(lines);
    await inTransaction(async tx => {
      const needsApproval = material && ['pending_approval', 'approved'].includes(cur.approval_status);
      await tx.execute({
        sql: `UPDATE shop_use_requests SET category = ?, branch_id = ?, department = ?, source_branch_id = ?, reason = ?, equipment_ref = ?, project_ref = ?, notes = ?,
                total_estimated = ?, version = version + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [header.category, header.branch_id, header.department, header.source_branch_id, header.reason, header.equipment_ref, header.project_ref, header.notes,
          total, needsApproval ? 1 : 0, cur.id],
      });
      await writeLines(tx, cur.id, lines, existing);
      if (needsApproval) {
        // What was approved no longer stands — nothing more can be issued
        // until the amended request is approved.
        await tx.execute({ sql: 'UPDATE shop_use_request_lines SET qty_approved = NULL, approve_reason = NULL WHERE request_id = ?', args: [cur.id] });
      }
      if (Object.keys(changes).length || lineChanges.length) {
        await audit(tx, { requestId: cur.id, entity: 'request', entityId: cur.id, action: 'edited', employee: req.employee,
          details: { changes, lines: lineChanges, total_from: cur.total_estimated, total_to: total } });
      }
      if (needsApproval) await sendForApproval(tx, cur.id, req.employee, cur.approval_status === 'approved' ? 'amended' : 'resubmitted', String(req.body.amend_reason || '').trim() || null);
      else if (req.body.submit && ['draft', 'returned'].includes(cur.approval_status)) await sendForApproval(tx, cur.id, req.employee, cur.approval_status === 'returned' ? 'resubmitted' : 'submitted');
      await refreshFulfillment(tx, cur.id);
    });
    res.json(await loadRequest(cur.id));
  } catch (e) { sendError(res, e); }
});

router.post('/requests/:id/submit', requirePermission('shop_use_request'), async (req, res) => {
  try {
    const { rows: [cur] } = await db.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [req.params.id] });
    if (!cur) return fail(res, 404, 'Shop Use request not found');
    if (Number(cur.requested_by) !== Number(req.employee?.id)) return fail(res, 403, 'Only the requester can submit this request');
    if (!['draft', 'returned'].includes(cur.approval_status)) return fail(res, 400, 'Only a draft or returned request can be submitted');
    if (cur.fulfillment_status === 'cancelled') return fail(res, 400, 'This request is cancelled');
    await inTransaction(tx => sendForApproval(tx, cur.id, req.employee, cur.approval_status === 'returned' ? 'resubmitted' : 'submitted'));
    res.json(await loadRequest(cur.id));
  } catch (e) { sendError(res, e); }
});

// Approve, with each line's approved quantity (≤ requested; a lower one
// needs a reason).
router.post('/requests/:id/approve', async (req, res) => {
  try {
    if (!req.employee) return fail(res, 401, 'Authentication required');
    if (!perms(req).shop_use_approve) return fail(res, 403, 'You do not have permission to approve Shop Use requests');
    const r = await loadRequest(req.params.id);
    if (!r) return fail(res, 404, 'Shop Use request not found');
    if (r.approval_status !== 'pending_approval') return fail(res, 400, 'This request isn\'t waiting for approval');
    const auth = await approvalAuthority(db, req.employee, r);
    if (!auth.ok) return fail(res, 403, auth.error);
    const given = new Map((req.body.lines || []).map(l => [Number(l.id), l]));
    const decisions = [];
    for (const l of r.lines) {
      const g = given.get(Number(l.id));
      const qty = g && g.qty_approved !== undefined && g.qty_approved !== '' ? Number(g.qty_approved) : Number(l.qty_requested);
      if (!Number.isFinite(qty) || qty < 0) return fail(res, 400, `Enter the quantity approved for ${l.description}`);
      if (!l.allow_decimal && !Number.isInteger(qty) && l.product_id) return fail(res, 400, `${l.description} is approved in whole units`);
      if (qty > Number(l.qty_requested)) return fail(res, 400, `${l.description}: more than the ${l.qty_requested} requested can't be approved`);
      const floor = Number(l.qty_issued) + Number(l.qty_cancelled);
      if (qty < floor) return fail(res, 400, `${l.description}: ${l.qty_issued} already issued${Number(l.qty_cancelled) ? ` and ${l.qty_cancelled} cancelled` : ''} — approve at least ${floor}`);
      const reason = String(g?.reason || '').trim();
      if (qty < Number(l.qty_requested) && !reason) return fail(res, 400, `Give a reason for approving less ${l.description} than requested`);
      decisions.push({ id: l.id, description: l.description, requested: l.qty_requested, approved: qty, reason: reason || null });
    }
    if (!decisions.some(d => d.approved > 0)) return fail(res, 400, 'Nothing is approved — reject the request instead');
    const reduced = decisions.some(d => d.approved < d.requested);
    const comment = String(req.body.comment || '').trim() || null;
    await inTransaction(async tx => {
      for (const d of decisions) {
        await tx.execute({ sql: 'UPDATE shop_use_request_lines SET qty_approved = ?, approve_reason = ? WHERE id = ?', args: [d.approved, d.reason, d.id] });
      }
      await tx.execute({
        sql: `UPDATE shop_use_requests SET approval_status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [req.employee.id, comment, r.id],
      });
      await tx.execute({
        sql: 'INSERT INTO shop_use_approvals (request_id, version, action, employee_id, comments, rule_id, amount) VALUES (?,?,?,?,?,?,?)',
        args: [r.id, r.version, reduced ? 'approved_reduced' : 'approved', req.employee.id, comment, auth.rule?.id || null,
          round2(decisions.reduce((s, d) => s + d.approved * (r.lines.find(l => l.id === d.id).unit_cost), 0))],
      });
      await audit(tx, { requestId: r.id, entity: 'request', entityId: r.id, action: reduced ? 'approved_reduced' : 'approved', employee: req.employee,
        details: { version: r.version, comment, lines: decisions } });
      await refreshFulfillment(tx, r.id);
    });
    res.json(await loadRequest(r.id));
  } catch (e) { sendError(res, e); }
});

// Reject or return for correction — both need a reason.
for (const [route, status, action] of [['reject', 'rejected', 'rejected'], ['return', 'returned', 'returned']]) {
  router.post(`/requests/:id/${route}`, async (req, res) => {
    try {
      if (!req.employee) return fail(res, 401, 'Authentication required');
      if (!perms(req).shop_use_approve) return fail(res, 403, 'You do not have permission to approve Shop Use requests');
      const r = await loadRequest(req.params.id);
      if (!r) return fail(res, 404, 'Shop Use request not found');
      if (r.approval_status !== 'pending_approval') return fail(res, 400, 'This request isn\'t waiting for approval');
      const auth = await approvalAuthority(db, req.employee, r);
      if (!auth.ok) return fail(res, 403, auth.error);
      const reason = String(req.body.reason || '').trim();
      if (!reason) return fail(res, 400, route === 'reject' ? 'Give the reason for rejecting it' : 'Say what needs correcting');
      await inTransaction(async tx => {
        await tx.execute({
          sql: 'UPDATE shop_use_requests SET approval_status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          args: [status, req.employee.id, reason, r.id],
        });
        await tx.execute({
          sql: 'INSERT INTO shop_use_approvals (request_id, version, action, employee_id, comments, rule_id, amount) VALUES (?,?,?,?,?,?,?)',
          args: [r.id, r.version, action, req.employee.id, reason, auth.rule?.id || null, r.total_estimated],
        });
        await audit(tx, { requestId: r.id, entity: 'request', entityId: r.id, action, employee: req.employee, details: { version: r.version, reason } });
      });
      res.json(await loadRequest(r.id));
    } catch (e) { sendError(res, e); }
  });
}

// Cancel what hasn't been issued — the whole request, or chosen quantities on
// chosen lines ({ lines: [{ id, qty }] }). A reason is always recorded.
// The requester, the issuing team or an approver with authority may cancel.
router.post('/requests/:id/cancel', inModule, async (req, res) => {
  try {
    const r = await loadRequest(req.params.id);
    if (!r || !canSee(req, r)) return fail(res, 404, 'Shop Use request not found');
    const p = perms(req);
    const own = Number(r.requested_by) === Number(req.employee?.id) && can(p, 'shop_use_request');
    const approver = !own && p.shop_use_approve && (await approvalAuthority(db, req.employee, r)).ok;
    if (!own && !can(p, 'shop_use_issue') && !approver) return fail(res, 403, 'You can\'t cancel this request');
    if (r.fulfillment_status === 'cancelled') return fail(res, 400, 'This request is already cancelled');
    if (r.approval_status === 'rejected') return fail(res, 400, 'A rejected request needs no cancelling');
    const reason = String(req.body.reason || '').trim();
    if (!reason) return fail(res, 400, 'Give the reason for cancelling');
    const partial = Array.isArray(req.body.lines) && req.body.lines.length;
    const cuts = [];
    for (const l of r.lines) {
      const open = Math.max(0, round4((l.qty_approved ?? l.qty_requested) - l.qty_issued - l.qty_cancelled));
      if (!partial) { if (open > 0) cuts.push({ line: l, qty: open }); continue; }
      const want = req.body.lines.find(x => Number(x.id) === Number(l.id));
      if (!want) continue;
      const qty = Number(want.qty);
      if (!(qty > 0)) continue;
      if (qty > open) return fail(res, 400, `${l.description}: only ${open} is outstanding`);
      cuts.push({ line: l, qty });
    }
    if (partial && !cuts.length) return fail(res, 400, 'Enter a quantity to cancel');
    const nothingIssued = !r.lines.some(l => Number(l.qty_issued) > 0);
    await inTransaction(async tx => {
      for (const c of cuts) {
        await tx.execute({
          sql: "UPDATE shop_use_request_lines SET qty_cancelled = qty_cancelled + ?, cancel_reason = TRIM(COALESCE(cancel_reason || '; ', '') || ?) WHERE id = ?",
          args: [c.qty, reason, c.line.id],
        });
      }
      if (!partial && nothingIssued) {
        await tx.execute({
          sql: `UPDATE shop_use_requests SET fulfillment_status = 'cancelled', cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          args: [req.employee?.id || null, reason, r.id],
        });
      } else {
        await refreshFulfillment(tx, r.id);
      }
      await tx.execute({
        sql: 'INSERT INTO shop_use_approvals (request_id, version, action, employee_id, comments) VALUES (?,?,?,?,?)',
        args: [r.id, r.version, partial ? 'cancelled_quantity' : 'cancelled', req.employee?.id || null, reason],
      });
      await audit(tx, { requestId: r.id, entity: 'request', entityId: r.id, action: partial ? 'cancelled_quantity' : 'cancelled', employee: req.employee,
        details: { reason, lines: cuts.map(c => ({ item: c.line.description, qty: c.qty })) } });
    });
    res.json(await loadRequest(r.id));
  } catch (e) { sendError(res, e); }
});

// Raises a draft purchase request for the stock the supplying location is
// short of, linked back to this request. It then follows the normal
// purchase-request approval process.
router.post('/requests/:id/purchase-request', inModule, async (req, res) => {
  try {
    if (!can(perms(req), 'pr_create')) return fail(res, 403, 'You need permission to create purchase requests');
    const r = await loadRequest(req.params.id);
    if (!r || !canSee(req, r)) return fail(res, 404, 'Shop Use request not found');
    const short = r.lines.filter(l => l.product_id && l.shortage > 0);
    if (!short.length) return fail(res, 400, 'The supplying location has enough stock for everything outstanding');
    const prId = await inTransaction(async tx => {
      const prNumber = await nextNumber(tx, 'purchase_requests', 'pr_number', 'PR-', 6);
      const ins = await tx.execute({
        sql: `INSERT INTO purchase_requests (pr_number, branch_id, employee_id, department, internal_notes, request_type, shop_use_request_id)
              VALUES (?,?,?,?,?, 'sale_items', ?)`,
        args: [prNumber, r.source_branch_id, req.employee?.id || null, r.department,
          `Stock shortage for Shop Use ${r.request_number} (${categoryLabel(r.category)}): ${r.reason || ''}`.trim(), r.id],
      });
      const prId = Number(ins.lastInsertRowid);
      for (const l of short) {
        const qty = l.allow_decimal ? l.shortage : Math.ceil(l.shortage);
        await tx.execute({
          sql: `INSERT INTO purchase_request_items (pr_id, product_id, product_name, sku, quantity, unit_cost, item_type, total, uom_id, purchase_unit, units_per)
                VALUES (?,?,?,?,?,?, 'sale', ?, ?, ?, ?)`,
          args: [prId, l.product_id, l.description, l.sku, qty, l.unit_cost, round2(qty * l.unit_cost), l.uom_id, l.unit_name, l.units_per],
        });
      }
      await audit(tx, { requestId: r.id, entity: 'purchase_request', entityId: prId, action: 'purchase_request_raised', employee: req.employee,
        details: { pr_number: prNumber, lines: short.map(l => ({ item: l.description, qty: l.shortage })) } });
      return { id: prId, pr_number: prNumber };
    });
    res.status(201).json(prId);
  } catch (e) { sendError(res, e); }
});

// ── Issue ──────────────────────────────────────────────────────────────────

// Approved requests with something still to issue, oldest approval first.
router.get('/issue-queue', requirePermission('shop_use_issue'), async (req, res) => {
  try {
    const { rows } = await db.execute(`${REQ_SELECT} WHERE r.approval_status = 'approved' AND r.fulfillment_status IN ('not_issued', 'partial') ORDER BY r.decided_at, r.id`);
    for (const r of rows) r.category_label = categoryLabel(r.category);
    res.json(rows.filter(r => Number(r.qty_outstanding) > 0));
  } catch (e) { sendError(res, e); }
});

// Confirm an issue: { issue_key, lines: [{ line_id, qty, condition?, tools?: [{ serial_number, location }] }],
// recipient_employee_id | recipient_name, acknowledged, signature?, comments }.
// Stock leaves the supplying location at inventory cost and the accounting
// entry is queued in the same transaction. The same issue_key twice returns
// the first issue instead of issuing again.
router.post('/requests/:id/issues', requirePermission('shop_use_issue'), async (req, res) => {
  try {
    const key = String(req.body.issue_key || '').trim();
    if (!key) return fail(res, 400, 'Missing issue reference — reload and try again');
    const { rows: [dup] } = await db.execute({ sql: 'SELECT id FROM shop_use_issues WHERE issue_key = ?', args: [key] });
    if (dup) return res.json({ duplicate: true, issue_id: dup.id, request: await loadRequest(req.params.id) });
    const recipientId = Number(req.body.recipient_employee_id) || null;
    let recipientName = String(req.body.recipient_name || '').trim();
    if (recipientId) {
      const { rows: [e] } = await db.execute({ sql: 'SELECT first_name, last_name FROM employees WHERE id = ?', args: [recipientId] });
      if (!e) return fail(res, 400, 'Recipient not found');
      recipientName = empName(e);
    }
    if (!recipientName) return fail(res, 400, 'Who is receiving the items?');
    if (!req.body.acknowledged) return fail(res, 400, 'The recipient must acknowledge receiving the items');
    const comments = String(req.body.comments || '').trim() || null;
    const signature = req.body.signature ? await uploadSignature(req.body.signature, `shop-use-${req.params.id}`, 'shop-use-signatures') : null;

    const result = await inTransaction(async tx => {
      const { rows: [r] } = await tx.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [req.params.id] });
      if (!r) throw new UserError('Shop Use request not found', 404);
      if (r.approval_status !== 'approved') throw new UserError(r.approval_status === 'pending_approval' ? 'This request is waiting for (re)approval — nothing can be issued until it is approved' : 'Only an approved request can be issued');
      if (r.fulfillment_status === 'cancelled') throw new UserError('This request is cancelled');
      const { rows: lines } = await tx.execute({
        sql: `SELECT l.*, u.allow_decimal FROM shop_use_request_lines l LEFT JOIN units_of_measure u ON u.id = l.uom_id WHERE l.request_id = ?`,
        args: [r.id],
      });
      const byId = new Map(lines.map(l => [Number(l.id), l]));
      const picks = [];
      for (const raw of req.body.lines || []) {
        const l = byId.get(Number(raw.line_id));
        if (!l) throw new UserError('A line on this request no longer exists — reload and try again');
        const qty = round4(Number(raw.qty));
        if (!qty) continue;
        if (!(qty > 0)) throw new UserError(`Enter the quantity issued for ${l.description}`);
        if (l.product_id && !l.allow_decimal && !Number.isInteger(qty)) throw new UserError(`${l.description} is issued in whole units`);
        const remaining = round4((Number(l.qty_approved) || 0) - Number(l.qty_issued) - Number(l.qty_cancelled));
        if (qty > remaining) throw new UserError(`${l.description}: only ${Math.max(0, remaining)} approved quantity is left to issue`);
        picks.push({ l, qty, raw });
      }
      if (!picks.length) throw new UserError('Enter the quantity being issued');
      const leftAfter = lines.some(l => {
        const pick = picks.find(p => p.l.id === l.id);
        return round4((Number(l.qty_approved) || 0) - Number(l.qty_issued) - Number(l.qty_cancelled) - (pick ? pick.qty : 0)) > 0;
      });
      if (leftAfter && !comments) throw new UserError('This is a partial issue — add a comment explaining what is still to come');
      // Stock and tool availability, checked inside the transaction.
      const short = [];
      for (const p of picks) {
        if (p.l.product_id) {
          p.units = stockUnits(p.qty, p.l.units_per);
          const have = await onHand(tx, p.l.product_id, r.source_branch_id);
          if (p.units > have) short.push(`${p.l.description}: ${p.qty} wanted, ${round4(have / (Number(p.l.units_per) || 1))} on hand`);
        } else {
          if (p.qty !== 1) throw new UserError(`${p.l.description}: a tool is lent one at a time`);
          const { rows: [t] } = await tx.execute({ sql: 'SELECT status FROM shop_use_tools WHERE id = ?', args: [p.l.tool_id] });
          if (t?.status !== 'available') short.push(`${p.l.description}: not available (${t?.status || 'missing'})`);
        }
      }
      if (short.length) throw new UserError(`Not enough stock at the supplying location — ${short.join('; ')}`, 400, { shortages: short });

      const issueNumber = await nextNumber(tx, 'shop_use_issues', 'issue_number', 'SUI-', 6);
      const ins = await tx.execute({
        sql: `INSERT INTO shop_use_issues (issue_number, issue_key, request_id, request_version, source_branch_id, issued_by, recipient_employee_id, recipient_name, acknowledged, recipient_signature, comments)
              VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
        args: [issueNumber, key, r.id, r.version, r.source_branch_id, req.employee?.id || null, recipientId, recipientName, signature, comments],
      });
      const issueId = Number(ins.lastInsertRowid);
      let total = 0, inventoryLines = 0;
      for (const p of picks) {
        let unitCost = 0, lineCost = 0;
        if (p.l.product_id) {
          const { rows: [prod] } = await tx.execute({ sql: 'SELECT cost FROM products WHERE id = ?', args: [p.l.product_id] });
          unitCost = round4(prod?.cost);
          lineCost = round2(p.units * unitCost);
          inventoryLines++;
          await moveStock(tx, { productId: p.l.product_id, branchId: r.source_branch_id, units: -p.units, reference: issueNumber,
            reason: `Shop Use ${r.request_number} — ${categoryLabel(r.category)}` });
        }
        total += lineCost;
        const il = await tx.execute({
          sql: 'INSERT INTO shop_use_issue_lines (issue_id, request_line_id, product_id, tool_id, quantity, stock_units, unit_cost, line_cost, condition) VALUES (?,?,?,?,?,?,?,?,?)',
          args: [issueId, p.l.id, p.l.product_id, p.l.tool_id, p.qty, p.units || 0, unitCost, lineCost, String(p.raw.condition || '').trim() || null],
        });
        const issueLineId = Number(il.lastInsertRowid);
        await tx.execute({ sql: 'UPDATE shop_use_request_lines SET qty_issued = qty_issued + ? WHERE id = ?', args: [p.qty, p.l.id] });
        if (p.l.tool_id) {
          // Borrowed from the tool register — custody only, no stock or cost.
          await tx.execute({
            sql: `UPDATE shop_use_tools SET status = 'assigned', custodian_employee_id = ?, custodian_name = ?, branch_id = ?, department = ?, location = COALESCE(?, location),
                    condition = COALESCE(?, condition), issued_at = CURRENT_TIMESTAMP, request_id = ?, issue_id = ? WHERE id = ?`,
            args: [recipientId, recipientName, r.branch_id, r.department, String(p.raw.location || '').trim() || null, String(p.raw.condition || '').trim() || null, r.id, issueId, p.l.tool_id],
          });
          await tx.execute({
            sql: `INSERT INTO shop_use_tool_events (tool_id, event, custodian_employee_id, custodian_name, branch_id, department, location, condition, notes, request_id, issue_id, employee_id)
                  VALUES (?, 'borrowed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [p.l.tool_id, recipientId, recipientName, r.branch_id, r.department, String(p.raw.location || '').trim() || null, String(p.raw.condition || '').trim() || null,
              `${issueNumber} for ${r.request_number}`, r.id, issueId, req.employee?.id || null],
          });
        } else if (r.category === 'tools') {
          // Reusable tools taken out of saleable stock for good: one register
          // entry per unit, in the recipient's custody.
          const count = Math.max(1, Math.round(p.units));
          const tools = Array.isArray(p.raw.tools) ? p.raw.tools : [];
          for (let n = 0; n < count; n++) {
            const t = tools[n] || {};
            const toolNumber = await nextNumber(tx, 'shop_use_tools', 'tool_number', 'TL-', 6);
            const ti = await tx.execute({
              sql: `INSERT INTO shop_use_tools (tool_number, description, serial_number, product_id, source, status, custodian_employee_id, custodian_name, branch_id, department, location, condition, issued_at, request_id, issue_id, issue_line_id, unit_cost)
                    VALUES (?,?,?,?, 'inventory', 'assigned', ?,?,?,?,?,?, CURRENT_TIMESTAMP, ?,?,?,?)`,
              args: [toolNumber, p.l.description, String(t.serial_number || '').trim() || null, p.l.product_id, recipientId, recipientName, r.branch_id, r.department,
                String(t.location || p.raw.location || '').trim() || null, String(t.condition || p.raw.condition || '').trim() || 'New', r.id, issueId, issueLineId,
                round2(unitCost * (Number(p.l.units_per) || 1))],
            });
            await tx.execute({
              sql: `INSERT INTO shop_use_tool_events (tool_id, event, custodian_employee_id, custodian_name, branch_id, department, location, condition, notes, request_id, issue_id, employee_id)
                    VALUES (?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              args: [Number(ti.lastInsertRowid), recipientId, recipientName, r.branch_id, r.department, String(t.location || p.raw.location || '').trim() || null,
                String(t.condition || p.raw.condition || '').trim() || 'New', `Taken out of inventory on ${issueNumber} (${r.request_number})`, r.id, issueId, req.employee?.id || null],
            });
          }
        }
      }
      total = round2(total);
      await tx.execute({ sql: 'UPDATE shop_use_issues SET total_cost = ? WHERE id = ?', args: [total, issueId] });
      if (inventoryLines) {
        const d = require('../lib/storeTime').storeToday();
        await queuePosting(tx, { sourceType: 'issue', sourceId: issueId, reference: issueNumber, request: r, amount: total, date: d,
          memo: `Shop Use ${issueNumber} (${r.request_number}) — ${categoryLabel(r.category)}` });
      }
      const status = await refreshFulfillment(tx, r.id);
      await audit(tx, { requestId: r.id, entity: 'issue', entityId: issueId, action: 'issued', employee: req.employee,
        details: { issue_number: issueNumber, recipient: recipientName, total_cost: total, fulfillment: status, comments,
          lines: picks.map(p => ({ item: p.l.description, qty: p.qty })) } });
      return { issueId, issueNumber };
    }).catch(async e => {
      // Two Confirm clicks racing: the second hits the unique issue_key.
      if (/UNIQUE constraint failed: shop_use_issues.issue_key/.test(e.message)) {
        const { rows: [d] } = await db.execute({ sql: 'SELECT id, issue_number FROM shop_use_issues WHERE issue_key = ?', args: [key] });
        if (d) return { issueId: d.id, issueNumber: d.issue_number, duplicate: true };
      }
      throw e;
    });
    res.status(result.duplicate ? 200 : 201).json({ ...result, issue_id: result.issueId, request: await loadRequest(req.params.id) });
  } catch (e) { sendError(res, e); }
});

async function loadIssue(id) {
  const { rows: [i] } = await db.execute({
    sql: `SELECT i.*, r.request_number, r.category, r.reason, r.department, r.equipment_ref, r.project_ref, r.requested_by,
            b.name AS branch_name, sb.name AS source_branch_name, sb.address AS source_branch_address, sb.phone AS source_branch_phone,
            e.first_name || ' ' || e.last_name AS issued_by_name, rq.first_name || ' ' || rq.last_name AS requested_by_name,
            ap.first_name || ' ' || ap.last_name AS approved_by_name, r.decided_at AS approved_at
          FROM shop_use_issues i JOIN shop_use_requests r ON r.id = i.request_id
          LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN branches sb ON sb.id = i.source_branch_id
          LEFT JOIN employees e ON e.id = i.issued_by LEFT JOIN employees rq ON rq.id = r.requested_by LEFT JOIN employees ap ON ap.id = r.decided_by
          WHERE i.id = ?`,
    args: [id],
  });
  if (!i) return null;
  i.category_label = categoryLabel(i.category);
  const { rows: lines } = await db.execute({
    sql: `SELECT il.*, l.description, l.sku, l.unit_name, l.units_per, l.qty_approved, l.qty_issued AS line_qty_issued, l.qty_cancelled,
            l.equipment_ref AS line_equipment_ref, u.allow_decimal
          FROM shop_use_issue_lines il JOIN shop_use_request_lines l ON l.id = il.request_line_id
          LEFT JOIN units_of_measure u ON u.id = l.uom_id WHERE il.issue_id = ? ORDER BY il.id`,
    args: [id],
  });
  for (const l of lines) {
    l.outstanding = Math.max(0, round4((Number(l.qty_approved) || 0) - l.line_qty_issued - l.qty_cancelled));
    l.returnable = round4(l.quantity - l.qty_returned);
    const { rows: tools } = await db.execute({ sql: 'SELECT id, tool_number, serial_number, status FROM shop_use_tools WHERE issue_line_id = ? ORDER BY id', args: [l.id] });
    l.tools = tools;
  }
  i.lines = lines;
  const { rows: [p] } = await db.execute({ sql: "SELECT * FROM shop_use_postings WHERE source_type = 'issue' AND source_id = ?", args: [id] });
  i.posting = p || null;
  return i;
}

router.get('/issues/:id', inModule, async (req, res) => {
  try {
    const i = await loadIssue(req.params.id);
    if (!i || !canSee(req, i)) return fail(res, 404, 'Issue not found');
    res.json(i);
  } catch (e) { sendError(res, e); }
});

async function storeInfo() {
  const { rows } = await db.execute("SELECT key, value FROM settings WHERE key IN ('store_name', 'store_address', 'store_phone', 'company_logo_url')");
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
const pdfDateTime = d => d ? require('../lib/storeTime').fmtDateTime(d, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const money = n => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Issue slip as a PDF download.
router.get('/issues/:id/slip.pdf', inModule, async (req, res) => {
  try {
    const i = await loadIssue(req.params.id);
    if (!i || !canSee(req, i)) return fail(res, 404, 'Issue not found');
    const s = await storeInfo();
    const pdf = await renderDocumentPdf({
      store: { name: s.store_name || 'My Store', branch: i.source_branch_name || '', address: i.source_branch_address || s.store_address || '', phone: i.source_branch_phone || s.store_phone || '', logo: s.company_logo_url || null },
      title: 'SHOP USE ISSUE SLIP', number: i.issue_number,
      meta: [['Issued', pdfDateTime(i.issued_at)], ['Request', i.request_number], ['From', i.source_branch_name]],
      party: { label: 'Issued To', boldFirst: true, lines: [i.recipient_name, `${i.branch_name || ''} — ${i.department || ''}`] },
      info: [['Category', i.category_label], ['Reason', i.reason], ['Equipment / project', [i.equipment_ref, i.project_ref].filter(Boolean).join(' / ')],
        ['Requested by', i.requested_by_name], ['Approved by', i.approved_by_name ? `${i.approved_by_name} (${pdfDateTime(i.approved_at)})` : ''], ['Issued by', i.issued_by_name],
        ['Comments', i.comments]],
      tables: [{
        columns: [{ label: 'Code', width: 1.3 }, { label: 'Item', width: 3.6 }, { label: 'Unit', width: 1 }, { label: 'Qty Issued', width: 1, align: 'right' },
          { label: 'Still Outstanding', width: 1.2, align: 'right' }, { label: 'Cost', width: 1.3, align: 'right' }],
        mainCol: 1,
        rows: i.lines.map(l => ({
          cells: [l.sku || '', l.description, l.unit_name || 'Each', l.quantity, l.outstanding, money(l.line_cost)],
          sub: [l.tools.length ? `Tools: ${l.tools.map(t => t.tool_number + (t.serial_number ? ` S/N ${t.serial_number}` : '')).join(', ')}` : '', l.condition ? `Condition: ${l.condition}` : ''].filter(Boolean).join(' · ') || undefined,
        })),
      }],
      totals: [{ label: 'Total at inventory cost', value: money(i.total_cost), style: 'grand' }],
      notes: ['Valued at inventory cost. Company use only — not a sale.'],
      signatures: [{ label: 'Received by', name: i.recipient_name, signedAt: pdfDateTime(i.issued_at), image: i.recipient_signature }, { label: 'Issued by', name: i.issued_by_name }],
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${i.issue_number}.pdf"`);
    res.send(pdf);
  } catch (e) { sendError(res, e); }
});

// ── Returns and reversals ──────────────────────────────────────────────────
// { return_key, kind: 'return' | 'reversal', reason, lines: [{ issue_line_id, qty, condition: 'good'|'damaged', notes, tool_ids? }] }
// A return takes unused items back: good ones go back into saleable stock
// and their cost is reversed at the original issue cost; damaged ones are
// recorded but not restocked (they go through the damaged-stock procedure).
// A reversal (Finance) corrects a wrong issue: the stock goes back, the cost
// is reversed and the quantity is outstanding on the request again.
router.post('/issues/:id/returns', inModule, async (req, res) => {
  try {
    const kind = req.body.kind === 'reversal' ? 'reversal' : 'return';
    const p = perms(req);
    if (kind === 'reversal' ? !can(p, 'shop_use_finance') : !can(p, 'shop_use_issue')) {
      return fail(res, 403, kind === 'reversal' ? 'Reversals need Shop Use Finance permission' : 'Returns need Shop Use Issue permission');
    }
    const key = String(req.body.return_key || '').trim();
    if (!key) return fail(res, 400, 'Missing return reference — reload and try again');
    const { rows: [dup] } = await db.execute({ sql: 'SELECT id FROM shop_use_returns WHERE return_key = ?', args: [key] });
    if (dup) return res.json({ duplicate: true, return_id: dup.id });
    const reason = String(req.body.reason || '').trim() || null;
    if (kind === 'reversal' && !reason) return fail(res, 400, 'Give the reason for reversing this issue');
    const result = await inTransaction(async tx => {
      const { rows: [issue] } = await tx.execute({ sql: 'SELECT * FROM shop_use_issues WHERE id = ?', args: [req.params.id] });
      if (!issue) throw new UserError('Issue not found', 404);
      const { rows: [r] } = await tx.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [issue.request_id] });
      const { rows: ilines } = await tx.execute({
        sql: `SELECT il.*, l.description, l.units_per, u.allow_decimal FROM shop_use_issue_lines il JOIN shop_use_request_lines l ON l.id = il.request_line_id
              LEFT JOIN units_of_measure u ON u.id = l.uom_id WHERE il.issue_id = ?`,
        args: [issue.id],
      });
      const byId = new Map(ilines.map(l => [Number(l.id), l]));
      const picks = [];
      for (const raw of req.body.lines || []) {
        const l = byId.get(Number(raw.issue_line_id));
        if (!l) throw new UserError('That line isn\'t on this issue');
        const qty = round4(Number(raw.qty));
        if (!qty) continue;
        if (!(qty > 0)) throw new UserError(`Enter the quantity for ${l.description}`);
        if (l.tool_id) throw new UserError(`${l.description} was borrowed from the tool register — return it from the Tool Register tab`);
        if (l.product_id && !l.allow_decimal && !Number.isInteger(qty)) throw new UserError(`${l.description} is returned in whole units`);
        const left = round4(l.quantity - l.qty_returned);
        if (qty > left) throw new UserError(`${l.description}: only ${left} issued and not yet returned`);
        const condition = kind === 'reversal' ? 'good' : (raw.condition === 'damaged' ? 'damaged' : 'good');
        let toolIds = [];
        const { rows: lineTools } = await tx.execute({ sql: "SELECT id, tool_number, status FROM shop_use_tools WHERE issue_line_id = ? AND status NOT IN ('returned_to_stock', 'disposed')", args: [l.id] });
        if (lineTools.length) {
          toolIds = (raw.tool_ids || []).map(Number);
          if (toolIds.length !== qty || !toolIds.every(id => lineTools.some(t => Number(t.id) === id))) {
            throw new UserError(`${l.description}: pick the ${qty} tool${qty === 1 ? '' : 's'} coming back (from the tool register numbers)`);
          }
        }
        picks.push({ l, qty, condition, notes: String(raw.notes || '').trim() || null, toolIds });
      }
      if (!picks.length) throw new UserError('Enter the quantity coming back');
      const number = await nextNumber(tx, 'shop_use_returns', 'return_number', 'SUR-', 6);
      const ins = await tx.execute({
        sql: 'INSERT INTO shop_use_returns (return_number, return_key, kind, issue_id, request_id, received_by, reason) VALUES (?,?,?,?,?,?,?)',
        args: [number, key, kind, issue.id, r.id, req.employee?.id || null, reason],
      });
      const returnId = Number(ins.lastInsertRowid);
      let total = 0;
      for (const pk of picks) {
        const units = stockUnits(pk.qty, pk.l.units_per);
        const restock = pk.condition === 'good';
        const lineCost = restock ? round2(units * Number(pk.l.unit_cost)) : 0;
        total += lineCost;
        if (restock) {
          await moveStock(tx, { productId: pk.l.product_id, branchId: issue.source_branch_id, units, reference: number,
            reason: `Shop Use ${kind} of ${issue.issue_number} (${r.request_number})` });
        }
        await tx.execute({
          sql: 'INSERT INTO shop_use_return_lines (return_id, issue_line_id, quantity, stock_units, condition, restocked, line_cost, notes) VALUES (?,?,?,?,?,?,?,?)',
          args: [returnId, pk.l.id, pk.qty, units, pk.condition, restock ? 1 : 0, lineCost, pk.notes],
        });
        await tx.execute({ sql: 'UPDATE shop_use_issue_lines SET qty_returned = qty_returned + ? WHERE id = ?', args: [pk.qty, pk.l.id] });
        if (kind === 'reversal') {
          await tx.execute({ sql: 'UPDATE shop_use_request_lines SET qty_issued = qty_issued - ? WHERE id = ?', args: [pk.qty, pk.l.request_line_id] });
        }
        for (const toolId of pk.toolIds) {
          const status = restock ? 'returned_to_stock' : 'returned_damaged';
          await tx.execute({ sql: 'UPDATE shop_use_tools SET status = ?, custodian_employee_id = NULL, custodian_name = NULL WHERE id = ?', args: [status, toolId] });
          await tx.execute({
            sql: 'INSERT INTO shop_use_tool_events (tool_id, event, condition, notes, request_id, issue_id, employee_id) VALUES (?,?,?,?,?,?,?)',
            args: [toolId, restock ? 'returned_to_stock' : 'returned_damaged', pk.condition, `${number}${pk.notes ? ` — ${pk.notes}` : ''}`, r.id, issue.id, req.employee?.id || null],
          });
        }
      }
      total = round2(total);
      await tx.execute({ sql: 'UPDATE shop_use_returns SET total_cost = ? WHERE id = ?', args: [total, returnId] });
      if (total > 0) {
        const d = require('../lib/storeTime').storeToday();
        await queuePosting(tx, { sourceType: 'return', sourceId: returnId, reference: number, request: r, amount: total, date: d,
          memo: `Shop Use ${kind} ${number} of ${issue.issue_number} (${r.request_number})` });
      }
      if (kind === 'reversal') {
        // An issue reversed in full on a request otherwise done reopens it.
        await tx.execute({ sql: "UPDATE shop_use_requests SET fulfillment_status = 'not_issued' WHERE id = ? AND fulfillment_status = 'cancelled'", args: [r.id] });
      }
      await refreshFulfillment(tx, r.id);
      await audit(tx, { requestId: r.id, entity: 'return', entityId: returnId, action: kind === 'reversal' ? 'reversed' : 'returned', employee: req.employee,
        details: { return_number: number, issue_number: issue.issue_number, reason, total_cost: total,
          lines: picks.map(pk => ({ item: pk.l.description, qty: pk.qty, condition: pk.condition, tools: pk.toolIds })) } });
      return { returnId, returnNumber: number };
    });
    res.status(201).json({ return_id: result.returnId, return_number: result.returnNumber, request: await loadRequest((await loadIssue(req.params.id)).request_id) });
  } catch (e) { sendError(res, e); }
});

// ── Tool register ──────────────────────────────────────────────────────────

const TOOL_SELECT = `SELECT t.*, b.name AS branch_name, r.request_number, i.issue_number
  FROM shop_use_tools t LEFT JOIN branches b ON b.id = t.branch_id
  LEFT JOIN shop_use_requests r ON r.id = t.request_id LEFT JOIN shop_use_issues i ON i.id = t.issue_id`;

router.get('/tools', inModule, async (req, res) => {
  try {
    let sql = `${TOOL_SELECT} WHERE 1=1`;
    const args = [];
    if (req.query.status) { sql += ' AND t.status = ?'; args.push(req.query.status); }
    if (req.query.source) { sql += ' AND t.source = ?'; args.push(req.query.source); }
    if (req.query.branch_id) { sql += ' AND t.branch_id = ?'; args.push(req.query.branch_id); }
    if (req.query.q && String(req.query.q).trim()) {
      const like = `%${String(req.query.q).trim()}%`;
      sql += ' AND (t.tool_number LIKE ? OR t.description LIKE ? OR t.serial_number LIKE ? OR t.custodian_name LIKE ? OR t.location LIKE ?)';
      args.push(like, like, like, like, like);
    }
    sql += ' ORDER BY t.id DESC LIMIT 1000';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

router.get('/tools/:id', inModule, async (req, res) => {
  try {
    const { rows: [t] } = await db.execute({ sql: `${TOOL_SELECT} WHERE t.id = ?`, args: [req.params.id] });
    if (!t) return fail(res, 404, 'Tool not found');
    const { rows: events } = await db.execute({
      sql: `SELECT ev.*, b.name AS branch_name, e.first_name || ' ' || e.last_name AS employee_name FROM shop_use_tool_events ev
            LEFT JOIN branches b ON b.id = ev.branch_id LEFT JOIN employees e ON e.id = ev.employee_id WHERE ev.tool_id = ? ORDER BY ev.id`,
      args: [t.id],
    });
    t.events = events;
    res.json(t);
  } catch (e) { sendError(res, e); }
});

// An existing company tool entered on the register (not from inventory).
router.post('/tools', requirePermission('shop_use_issue'), async (req, res) => {
  try {
    const description = String(req.body.description || '').trim();
    if (!description) return fail(res, 400, 'Describe the tool');
    const id = await inTransaction(async tx => {
      const number = await nextNumber(tx, 'shop_use_tools', 'tool_number', 'TL-', 6);
      const r = await tx.execute({
        sql: `INSERT INTO shop_use_tools (tool_number, description, serial_number, source, status, branch_id, department, location, condition)
              VALUES (?,?,?, 'register', 'available', ?,?,?,?)`,
        args: [number, description, String(req.body.serial_number || '').trim() || null, Number(req.body.branch_id) || null,
          String(req.body.department || '').trim() || null, String(req.body.location || '').trim() || null, String(req.body.condition || '').trim() || null],
      });
      const id = Number(r.lastInsertRowid);
      await tx.execute({
        sql: "INSERT INTO shop_use_tool_events (tool_id, event, branch_id, department, location, condition, notes, employee_id) VALUES (?, 'registered', ?,?,?,?,?,?)",
        args: [id, Number(req.body.branch_id) || null, String(req.body.department || '').trim() || null, String(req.body.location || '').trim() || null,
          String(req.body.condition || '').trim() || null, String(req.body.notes || '').trim() || null, req.employee?.id || null],
      });
      await audit(tx, { entity: 'tool', entityId: id, action: 'tool_registered', employee: req.employee, details: { tool_number: number, description } });
      return id;
    });
    res.status(201).json({ id });
  } catch (e) { sendError(res, e); }
});

// Custody changes: transfer (new custodian / branch / department / location),
// return (back to the store, available to lend again) or dispose.
router.post('/tools/:id/:action(transfer|return|dispose)', requirePermission('shop_use_issue'), async (req, res) => {
  try {
    const action = req.params.action;
    const { rows: [t] } = await db.execute({ sql: 'SELECT * FROM shop_use_tools WHERE id = ?', args: [req.params.id] });
    if (!t) return fail(res, 404, 'Tool not found');
    if (['disposed', 'returned_to_stock'].includes(t.status)) return fail(res, 400, `This tool is ${t.status === 'disposed' ? 'disposed of' : 'back in saleable stock'}`);
    const notes = String(req.body.notes || '').trim() || null;
    const condition = String(req.body.condition || '').trim() || null;
    const location = String(req.body.location || '').trim() || null;
    if (action === 'dispose' && !notes) return fail(res, 400, 'Give the reason for disposal');
    if (action === 'return' && t.status !== 'assigned') return fail(res, 400, 'This tool isn\'t out with anyone');
    let custodianId = null, custodianName = null, branchId = t.branch_id, department = t.department;
    if (action === 'transfer') {
      custodianId = Number(req.body.custodian_employee_id) || null;
      custodianName = String(req.body.custodian_name || '').trim();
      if (custodianId) {
        const { rows: [e] } = await db.execute({ sql: 'SELECT first_name, last_name FROM employees WHERE id = ?', args: [custodianId] });
        if (!e) return fail(res, 400, 'Custodian not found');
        custodianName = empName(e);
      }
      if (!custodianName) return fail(res, 400, 'Who is the new custodian?');
      branchId = Number(req.body.branch_id) || t.branch_id;
      department = String(req.body.department || '').trim() || t.department;
    }
    await inTransaction(async tx => {
      if (action === 'transfer') {
        await tx.execute({
          sql: `UPDATE shop_use_tools SET status = 'assigned', custodian_employee_id = ?, custodian_name = ?, branch_id = ?, department = ?, location = COALESCE(?, location),
                  condition = COALESCE(?, condition), issued_at = COALESCE(issued_at, CURRENT_TIMESTAMP) WHERE id = ?`,
          args: [custodianId, custodianName, branchId, department, location, condition, t.id],
        });
      } else if (action === 'return') {
        await tx.execute({
          sql: "UPDATE shop_use_tools SET status = 'available', custodian_employee_id = NULL, custodian_name = NULL, location = COALESCE(?, location), condition = COALESCE(?, condition) WHERE id = ?",
          args: [location, condition, t.id],
        });
      } else {
        await tx.execute({ sql: "UPDATE shop_use_tools SET status = 'disposed', custodian_employee_id = NULL, custodian_name = NULL, condition = COALESCE(?, condition) WHERE id = ?", args: [condition, t.id] });
      }
      await tx.execute({
        sql: `INSERT INTO shop_use_tool_events (tool_id, event, custodian_employee_id, custodian_name, branch_id, department, location, condition, notes, employee_id)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [t.id, action === 'transfer' ? 'transferred' : action === 'return' ? 'returned' : 'disposed', custodianId, custodianName, branchId, department, location, condition, notes, req.employee?.id || null],
      });
      await audit(tx, { requestId: t.request_id, entity: 'tool', entityId: t.id, action: `tool_${action}`, employee: req.employee,
        details: { tool_number: t.tool_number, from: t.custodian_name, to: custodianName, notes, condition } });
    });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── Settings: approval routing and account mapping ─────────────────────────

router.get('/rules', inModule, async (req, res) => {
  try {
    const { rows } = await db.execute(`SELECT r.*, b.name AS branch_name FROM shop_use_approval_rules r LEFT JOIN branches b ON b.id = r.branch_id
      ORDER BY r.active DESC, CASE WHEN r.max_amount IS NULL THEN 1 ELSE 0 END, r.max_amount, r.id`);
    for (const r of rows) {
      const { rows: a } = await db.execute({
        sql: `SELECT e.id, e.first_name || ' ' || e.last_name AS name FROM shop_use_rule_approvers ra JOIN employees e ON e.id = ra.employee_id WHERE ra.rule_id = ? ORDER BY e.first_name`,
        args: [r.id],
      });
      r.approvers = a;
      r.category_label = r.category ? categoryLabel(r.category) : null;
    }
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

async function saveRule(req, res, id) {
  const name = String(req.body.name || '').trim();
  if (!name) return fail(res, 400, 'Name the rule');
  const category = req.body.category ? String(req.body.category) : null;
  if (category && !CATEGORY_KEYS.includes(category)) return fail(res, 400, 'Unknown category');
  const max = req.body.max_amount === '' || req.body.max_amount == null ? null : Number(req.body.max_amount);
  if (max != null && !(max >= 0)) return fail(res, 400, 'The approval limit must be 0 or more (blank for no limit)');
  const approvers = [...new Set((req.body.approver_ids || []).map(Number).filter(Boolean))];
  if (!approvers.length) return fail(res, 400, 'Choose at least one approver');
  const row = [name, Number(req.body.branch_id) || null, String(req.body.department || '').trim() || null, category, max, req.body.active === false || req.body.active === 0 ? 0 : 1];
  const ruleId = await inTransaction(async tx => {
    let ruleId = id;
    if (id) {
      await tx.execute({ sql: 'UPDATE shop_use_approval_rules SET name = ?, branch_id = ?, department = ?, category = ?, max_amount = ?, active = ? WHERE id = ?', args: [...row, id] });
      await tx.execute({ sql: 'DELETE FROM shop_use_rule_approvers WHERE rule_id = ?', args: [id] });
    } else {
      const r = await tx.execute({ sql: 'INSERT INTO shop_use_approval_rules (name, branch_id, department, category, max_amount, active) VALUES (?,?,?,?,?,?)', args: row });
      ruleId = Number(r.lastInsertRowid);
    }
    for (const a of approvers) await tx.execute({ sql: 'INSERT INTO shop_use_rule_approvers (rule_id, employee_id) VALUES (?, ?)', args: [ruleId, a] });
    await audit(tx, { entity: 'rule', entityId: ruleId, action: id ? 'rule_updated' : 'rule_created', employee: req.employee,
      details: { name, branch_id: row[1], department: row[2], category, max_amount: max, active: row[5], approvers } });
    return ruleId;
  });
  res.json({ id: ruleId });
}
router.post('/rules', requirePermission('shop_use_routing'), (req, res) => saveRule(req, res, null).catch(e => sendError(res, e)));
router.put('/rules/:id', requirePermission('shop_use_routing'), (req, res) => saveRule(req, res, Number(req.params.id)).catch(e => sendError(res, e)));
router.delete('/rules/:id', requirePermission('shop_use_routing'), async (req, res) => {
  try {
    await inTransaction(async tx => {
      await tx.execute({ sql: 'DELETE FROM shop_use_rule_approvers WHERE rule_id = ?', args: [req.params.id] });
      await tx.execute({ sql: 'DELETE FROM shop_use_approval_rules WHERE id = ?', args: [req.params.id] });
      await audit(tx, { entity: 'rule', entityId: Number(req.params.id), action: 'rule_deleted', employee: req.employee });
    });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

router.get('/accounts', inModule, async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM shop_use_accounts');
    const { rows: [inv] } = await db.execute("SELECT value FROM settings WHERE key = 'shop_use_inventory_account'");
    res.json({
      inventory_account: inv?.value || DEFAULT_INVENTORY_ACCOUNT,
      categories: CATEGORIES.map(c => ({ ...c, ...(rows.find(r => r.category === c.key) || { treatment: c.treatment }) , label: c.label })),
    });
  } catch (e) { sendError(res, e); }
});

// Finance's mapping: { inventory_account, categories: [{ key, treatment, debit_account_code, debit_account_name, credit_account_code? }] }.
// Changes apply to postings queued from now on; anything already queued keeps its accounts.
router.put('/accounts', requirePermission('shop_use_finance'), async (req, res) => {
  try {
    const inv = String(req.body.inventory_account || '').trim();
    if (!inv) return fail(res, 400, 'Enter the inventory account code');
    await inTransaction(async tx => {
      await tx.execute({ sql: "INSERT INTO settings (key, value) VALUES ('shop_use_inventory_account', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [inv] });
      for (const c of req.body.categories || []) {
        if (!CATEGORY_KEYS.includes(c.key)) continue;
        const treatment = c.treatment === 'asset' ? 'asset' : 'expense';
        await tx.execute({
          sql: `INSERT INTO shop_use_accounts (category, treatment, debit_account_code, debit_account_name, credit_account_code, credit_account_name, updated_by, updated_at)
                VALUES (?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
                ON CONFLICT(category) DO UPDATE SET treatment = excluded.treatment, debit_account_code = excluded.debit_account_code, debit_account_name = excluded.debit_account_name,
                  credit_account_code = excluded.credit_account_code, credit_account_name = excluded.credit_account_name, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
          args: [c.key, treatment, String(c.debit_account_code || '').trim() || null, String(c.debit_account_name || '').trim() || null,
            String(c.credit_account_code || '').trim() || null, String(c.credit_account_name || '').trim() || null, req.employee?.id || null],
        });
      }
      await audit(tx, { entity: 'accounts', action: 'accounts_updated', employee: req.employee, details: req.body });
    });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

router.put('/settings', requirePermission('shop_use_routing'), async (req, res) => {
  try {
    const hours = Number(req.body.approval_hours);
    if (!(hours > 0)) return fail(res, 400, 'Enter how many hours an approval may wait before it shows as overdue');
    await db.execute({ sql: "INSERT INTO settings (key, value) VALUES ('shop_use_approval_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [String(hours)] });
    await audit(db, { entity: 'settings', action: 'settings_updated', employee: req.employee, details: { approval_hours: hours } });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── Postings (accounting interface) ────────────────────────────────────────

const POSTING_SELECT = `SELECT p.*, r.request_number, r.requested_by, b.name AS branch_name,
    rb.first_name || ' ' || rb.last_name AS reconciled_by_name
  FROM shop_use_postings p JOIN shop_use_requests r ON r.id = p.request_id
  LEFT JOIN branches b ON b.id = p.branch_id LEFT JOIN employees rb ON rb.id = p.reconciled_by`;

router.get('/postings', requireAnyPermission('shop_use_finance', 'shop_use_reports'), async (req, res) => {
  try {
    let sql = `${POSTING_SELECT} WHERE 1=1`;
    const args = [];
    if (req.query.status) { sql += ' AND p.status = ?'; args.push(req.query.status); }
    sql += ' ORDER BY p.id DESC LIMIT 1000';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

// RetailPOS Books pulls entries waiting to be posted (API key scope
// shop_use:read). Each is posted once — Books keys it by `shopuse:<id>` and
// acknowledges with POST /postings-ack.
router.get('/postings-feed', requireAnyPermission('shop_use_finance'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const { rows } = await db.execute({
      sql: `${POSTING_SELECT} WHERE p.status = 'pending' ORDER BY p.id LIMIT ?`,
      args: [limit],
    });
    res.json(rows.map(p => ({
      id: p.id, external_id: `shopuse:${p.id}`, reference: p.reference, source_type: p.source_type, request_number: p.request_number,
      date: p.posting_date, amount: p.amount, debit_account_code: p.debit_account_code, credit_account_code: p.credit_account_code,
      branch: p.branch_name, department: p.department, category: p.category, category_label: categoryLabel(p.category), memo: p.memo,
    })));
  } catch (e) { sendError(res, e); }
});

// Books' delivery receipt: { id, status: 'posted', external_ref, amount } or
// { id, status: 'failed', error } (API key scope shop_use:write). A second
// "posted" for an entry already posted under a different journal is refused
// as a duplicate.
router.post('/postings-ack', requireAnyPermission('shop_use_finance'), async (req, res) => {
  try {
    const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM shop_use_postings WHERE id = ?', args: [Number(req.body.id) || 0] });
    if (!p) return fail(res, 404, 'Posting not found');
    const status = req.body.status;
    const who = req.apiKey ? { id: null, first_name: 'RetailPOS', last_name: 'Books' } : req.employee;
    if (status === 'posted') {
      const ref = String(req.body.external_ref || '').trim();
      if (!ref) return fail(res, 400, 'external_ref is required');
      if (p.status === 'posted') {
        if (p.external_ref && p.external_ref !== ref) return fail(res, 409, `Already posted as ${p.external_ref} — duplicate entry ${ref} refused`, { external_ref: p.external_ref });
        return res.json({ success: true, already: true });
      }
      if (p.status === 'not_required') return fail(res, 400, 'This entry has no value and needs no posting');
      const amount = req.body.amount == null ? p.amount : round2(req.body.amount);
      await db.execute({
        sql: "UPDATE shop_use_postings SET status = 'posted', external_ref = ?, posted_amount = ?, posted_at = CURRENT_TIMESTAMP, attempts = attempts + 1, last_error = NULL WHERE id = ?",
        args: [ref, amount, p.id],
      });
      await audit(db, { requestId: p.request_id, entity: 'posting', entityId: p.id, action: 'posted', employee: who, details: { reference: p.reference, external_ref: ref, amount } });
      return res.json({ success: true });
    }
    if (status === 'failed') {
      if (p.status === 'posted') return fail(res, 409, 'Already posted');
      const error = String(req.body.error || 'Posting failed').slice(0, 1000);
      await db.execute({ sql: "UPDATE shop_use_postings SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?", args: [error, p.id] });
      await audit(db, { requestId: p.request_id, entity: 'posting', entityId: p.id, action: 'posting_failed', employee: who, details: { reference: p.reference, error } });
      return res.json({ success: true });
    }
    fail(res, 400, "status must be 'posted' or 'failed'");
  } catch (e) { sendError(res, e); }
});

// Finance puts a failed entry back in the queue (picking up an account
// mapping added since).
router.post('/postings/:id/retry', requirePermission('shop_use_finance'), async (req, res) => {
  try {
    const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM shop_use_postings WHERE id = ?', args: [req.params.id] });
    if (!p) return fail(res, 404, 'Posting not found');
    if (p.status !== 'failed') return fail(res, 400, 'Only a failed posting can be retried');
    const map = await accountMapping(db, p.category);
    const isReturn = p.source_type === 'return';
    const debit = p.debit_account_code || (isReturn ? map.credit : map.debit);
    const credit = p.credit_account_code || (isReturn ? map.debit : map.credit);
    if (!debit || !credit) return fail(res, 400, `No account is mapped for ${categoryLabel(p.category)} yet — set it in Shop Use → Settings first`);
    await db.execute({ sql: "UPDATE shop_use_postings SET status = 'pending', last_error = NULL, debit_account_code = ?, credit_account_code = ? WHERE id = ?", args: [debit, credit, p.id] });
    await audit(db, { requestId: p.request_id, entity: 'posting', entityId: p.id, action: 'posting_retried', employee: req.employee, details: { reference: p.reference, previous_error: p.last_error } });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── Reconciliation ─────────────────────────────────────────────────────────
// Each posting (one per issue or return) is checked:
//   authorized  the issue was against an approval, by someone other than the requester, within the approved quantity
//   stock       the logged stock movements match the quantities issued/restocked
//   value       document cost = queued amount = amount Books posted
//   allocation  branch, department, category and both accounts are set and match the request
//   returns     returns on the issue are all recorded against it (and valued at the issue cost)
async function reconChecks(p) {
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok: !!ok, detail: detail || null });
  const { rows: [r] } = await db.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [p.request_id] });
  const map = await accountMapping(db, p.category);
  if (p.source_type === 'issue') {
    const { rows: [i] } = await db.execute({ sql: 'SELECT * FROM shop_use_issues WHERE id = ?', args: [p.source_id] });
    const { rows: lines } = await db.execute({
      sql: 'SELECT il.*, l.qty_approved, l.qty_issued AS line_issued, l.qty_cancelled, l.description FROM shop_use_issue_lines il JOIN shop_use_request_lines l ON l.id = il.request_line_id WHERE il.issue_id = ?',
      args: [p.source_id],
    });
    const { rows: [appr] } = await db.execute({
      sql: "SELECT * FROM shop_use_approvals WHERE request_id = ? AND version = ? AND action IN ('approved', 'approved_reduced') ORDER BY id DESC LIMIT 1",
      args: [p.request_id, i.request_version],
    });
    const overLines = lines.filter(l => l.qty_approved != null && round4(l.line_issued + l.qty_cancelled) > round4(l.qty_approved));
    add('authorized', 'Authorized', appr && Number(appr.employee_id) !== Number(r.requested_by) && !overLines.length,
      !appr ? `No approval recorded for version ${i.request_version}` : Number(appr.employee_id) === Number(r.requested_by) ? 'Approved by the requester' : overLines.length ? `More issued than approved: ${overLines.map(l => l.description).join(', ')}` : null);
    const { rows: [mv] } = await db.execute({ sql: "SELECT COALESCE(SUM(quantity_change), 0) AS q, COUNT(*) AS n FROM stock_movements WHERE reference = ? AND type = 'shop_use'", args: [i.issue_number] });
    const expectUnits = round4(lines.reduce((s, l) => s + Number(l.stock_units), 0));
    add('stock', 'Stock movement', round4(-mv.q) === expectUnits, round4(-mv.q) === expectUnits ? null : `Issued ${expectUnits} stock units, movements show ${round4(-mv.q)}`);
    const docCost = round2(lines.reduce((s, l) => s + Number(l.line_cost), 0));
    const valueOk = docCost === round2(i.total_cost) && docCost === round2(p.amount) && p.status === 'posted' && round2(p.posted_amount) === round2(p.amount);
    add('value', 'Value posted', valueOk, valueOk ? null : p.status !== 'posted' ? `Not posted (${p.status}${p.last_error ? `: ${p.last_error}` : ''})`
      : `Issue ${money(i.total_cost)}, lines ${money(docCost)}, queued ${money(p.amount)}, posted ${money(p.posted_amount)}`);
    const { rows: [ret] } = await db.execute({
      sql: `SELECT COALESCE(SUM(rl.quantity), 0) AS q, COUNT(DISTINCT x.id) AS n,
              SUM(CASE WHEN x.total_cost > 0 AND NOT EXISTS (SELECT 1 FROM shop_use_postings pp WHERE pp.source_type = 'return' AND pp.source_id = x.id) THEN 1 ELSE 0 END) AS unposted
            FROM shop_use_returns x JOIN shop_use_return_lines rl ON rl.return_id = x.id WHERE x.issue_id = ?`,
      args: [i.id],
    });
    const returned = round4(lines.reduce((s, l) => s + Number(l.qty_returned), 0));
    add('returns', 'Returns recorded', round4(ret.q) === returned && !Number(ret.unposted), round4(ret.q) !== returned ? `Issue shows ${returned} returned, return documents ${round4(ret.q)}` : Number(ret.unposted) ? 'A return has no accounting entry' : (Number(ret.n) ? `${ret.n} return(s) on this issue` : null));
  } else {
    const { rows: [x] } = await db.execute({ sql: 'SELECT x.*, i.issue_number FROM shop_use_returns x JOIN shop_use_issues i ON i.id = x.issue_id WHERE x.id = ?', args: [p.source_id] });
    const { rows: lines } = await db.execute({
      sql: 'SELECT rl.*, il.unit_cost AS issue_unit_cost, il.quantity AS issued, il.qty_returned FROM shop_use_return_lines rl JOIN shop_use_issue_lines il ON il.id = rl.issue_line_id WHERE rl.return_id = ?',
      args: [p.source_id],
    });
    add('authorized', 'Authorized', x.received_by && (x.kind !== 'reversal' || x.reason), !x.received_by ? 'No one recorded as receiving it' : x.kind === 'reversal' && !x.reason ? 'Reversal has no reason' : null);
    const { rows: [mv] } = await db.execute({ sql: "SELECT COALESCE(SUM(quantity_change), 0) AS q FROM stock_movements WHERE reference = ? AND type = 'shop_use'", args: [x.return_number] });
    const restocked = round4(lines.filter(l => l.restocked).reduce((s, l) => s + Number(l.stock_units), 0));
    add('stock', 'Stock movement', round4(mv.q) === restocked, round4(mv.q) === restocked ? null : `Restocked ${restocked} stock units, movements show ${round4(mv.q)}`);
    const atIssueCost = round2(lines.filter(l => l.restocked).reduce((s, l) => s + round2(Number(l.stock_units) * Number(l.issue_unit_cost)), 0));
    const valueOk = atIssueCost === round2(x.total_cost) && atIssueCost === round2(p.amount) && p.status === 'posted' && round2(p.posted_amount) === round2(p.amount);
    add('value', 'Value posted', valueOk, valueOk ? null : p.status !== 'posted' ? `Not posted (${p.status}${p.last_error ? `: ${p.last_error}` : ''})`
      : `At issue cost ${money(atIssueCost)}, return ${money(x.total_cost)}, queued ${money(p.amount)}, posted ${money(p.posted_amount)}`);
    const over = lines.filter(l => Number(l.qty_returned) > Number(l.issued));
    add('returns', 'Linked to issue', !over.length, over.length ? 'More returned than issued' : `Against ${x.issue_number}`);
  }
  const allocProblems = [];
  if (Number(p.branch_id || 0) !== Number(r.branch_id || 0)) allocProblems.push('branch differs from the request');
  if (String(p.department || '').toLowerCase() !== String(r.department || '').toLowerCase()) allocProblems.push('department differs from the request');
  if (p.category !== r.category) allocProblems.push('category differs from the request');
  if (!p.debit_account_code || !p.credit_account_code) allocProblems.push('an account is missing');
  const expectDebit = p.source_type === 'return' ? map.credit : map.debit;
  const note = !allocProblems.length && expectDebit && p.debit_account_code !== expectDebit ? `Posted to ${p.debit_account_code}; the current mapping is ${expectDebit}` : null;
  add('allocation', 'Branch, department & accounts', !allocProblems.length, allocProblems.length ? allocProblems.join('; ') : note);
  return checks;
}

router.get('/reconciliation', requirePermission('shop_use_finance'), async (req, res) => {
  try {
    let sql = `${POSTING_SELECT} WHERE p.status != 'not_required'`;
    const args = [];
    const q = req.query;
    if (q.recon_status) { sql += ' AND p.recon_status = ?'; args.push(q.recon_status); }
    if (q.status) { sql += ' AND p.status = ?'; args.push(q.status); }
    if (q.branch_id) { sql += ' AND p.branch_id = ?'; args.push(q.branch_id); }
    if (q.category) { sql += ' AND p.category = ?'; args.push(q.category); }
    if (q.department) { sql += ' AND LOWER(p.department) = LOWER(?)'; args.push(q.department); }
    if (q.from) { sql += ' AND p.posting_date >= ?'; args.push(q.from); }
    if (q.to) { sql += ' AND p.posting_date <= ?'; args.push(q.to); }
    sql += ' ORDER BY p.posting_date, p.id LIMIT 1000';
    const { rows } = await db.execute({ sql, args });
    for (const p of rows) {
      p.checks = await reconChecks(p);
      p.differences = p.checks.filter(c => !c.ok).length;
      p.category_label = categoryLabel(p.category);
    }
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

// Mark reconciled — only once every check passes, so a difference stays
// visible until it's investigated and resolved.
router.post('/postings/:id/reconcile', requirePermission('shop_use_finance'), async (req, res) => {
  try {
    const { rows: [p] } = await db.execute({ sql: `${POSTING_SELECT} WHERE p.id = ?`, args: [req.params.id] });
    if (!p) return fail(res, 404, 'Posting not found');
    if (p.recon_status === 'reconciled') return fail(res, 400, 'Already reconciled');
    const checks = await reconChecks(p);
    const bad = checks.filter(c => !c.ok);
    if (bad.length) return fail(res, 400, `Resolve the differences first: ${bad.map(c => `${c.label} — ${c.detail}`).join('; ')}`, { checks });
    const comment = String(req.body.comment || '').trim() || null;
    await db.execute({ sql: "UPDATE shop_use_postings SET recon_status = 'reconciled', reconciled_by = ?, reconciled_at = CURRENT_TIMESTAMP, recon_comment = COALESCE(?, recon_comment) WHERE id = ?", args: [req.employee?.id || null, comment, p.id] });
    await audit(db, { requestId: p.request_id, entity: 'posting', entityId: p.id, action: 'reconciled', employee: req.employee, details: { reference: p.reference, comment } });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// Investigation notes on a difference (the item stays unreconciled).
router.post('/postings/:id/note', requirePermission('shop_use_finance'), async (req, res) => {
  try {
    const comment = String(req.body.comment || '').trim();
    if (!comment) return fail(res, 400, 'Write the note');
    const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM shop_use_postings WHERE id = ?', args: [req.params.id] });
    if (!p) return fail(res, 404, 'Posting not found');
    const who = [req.employee?.first_name, req.employee?.last_name].filter(Boolean).join(' ');
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await db.execute({ sql: "UPDATE shop_use_postings SET recon_comment = TRIM(COALESCE(recon_comment || char(10), '') || ?) WHERE id = ?", args: [`${stamp} ${who}: ${comment}`, p.id] });
    await audit(db, { requestId: p.request_id, entity: 'posting', entityId: p.id, action: 'recon_note', employee: req.employee, details: { reference: p.reference, comment } });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

router.post('/postings/:id/unreconcile', requirePermission('shop_use_finance'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return fail(res, 400, 'Give the reason for reopening it');
    const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM shop_use_postings WHERE id = ?', args: [req.params.id] });
    if (!p) return fail(res, 404, 'Posting not found');
    if (p.recon_status !== 'reconciled') return fail(res, 400, 'It isn\'t reconciled');
    await db.execute({ sql: "UPDATE shop_use_postings SET recon_status = 'unreconciled', reconciled_by = NULL, reconciled_at = NULL WHERE id = ?", args: [p.id] });
    await audit(db, { requestId: p.request_id, entity: 'posting', entityId: p.id, action: 'unreconciled', employee: req.employee, details: { reference: p.reference, reason } });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── Dashboard and notifications ────────────────────────────────────────────

router.get('/dashboard', inModule, async (req, res) => {
  try {
    const hours = await approvalHours();
    const all = seesAll(perms(req));
    const scope = all ? '' : ` AND r.requested_by = ${Number(req.employee?.id) || 0}`;
    const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
    const pending = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_estimated), 0) AS v,
        SUM(CASE WHEN submitted_at <= datetime('now', ?) THEN 1 ELSE 0 END) AS overdue
      FROM shop_use_requests r WHERE approval_status = 'pending_approval'${scope}`, [`-${hours} hours`]);
    const awaitingIssue = await one(`SELECT COUNT(*) AS n FROM shop_use_requests r WHERE approval_status = 'approved' AND fulfillment_status = 'not_issued'${scope}`);
    const partial = await one(`SELECT COUNT(*) AS n FROM shop_use_requests r WHERE approval_status = 'approved' AND fulfillment_status = 'partial'${scope}`);
    const outstanding = await one(`SELECT COUNT(*) AS lines, COALESCE(SUM(MAX(0, l.qty_approved - l.qty_issued - l.qty_cancelled) * l.unit_cost), 0) AS v
      FROM shop_use_request_lines l JOIN shop_use_requests r ON r.id = l.request_id
      WHERE r.approval_status = 'approved' AND r.fulfillment_status IN ('not_issued', 'partial') AND l.qty_approved - l.qty_issued - l.qty_cancelled > 0${scope}`);
    const postings = await one(`SELECT SUM(p.status = 'failed') AS failed, SUM(p.status = 'pending') AS pending,
        SUM(p.recon_status = 'unreconciled' AND p.status != 'not_required') AS unreconciled
      FROM shop_use_postings p JOIN shop_use_requests r ON r.id = p.request_id WHERE 1=1${scope}`);
    const month = await one(`SELECT COALESCE(SUM(CASE WHEN p.source_type = 'issue' THEN p.amount ELSE -p.amount END), 0) AS v
      FROM shop_use_postings p JOIN shop_use_requests r ON r.id = p.request_id WHERE p.posting_date >= date('now', 'localtime', 'start of month')${scope}`);
    const tools = await one("SELECT COUNT(*) AS n FROM shop_use_tools WHERE status = 'assigned'");
    const list = async (where, args = []) => {
      const { rows } = await db.execute({ sql: `${REQ_SELECT} WHERE ${where}${scope} ORDER BY r.id LIMIT 25`, args });
      rows.forEach(r => { r.category_label = categoryLabel(r.category); });
      return rows;
    };
    const me = Number(req.employee?.id);
    const pendingRows = await list("r.approval_status = 'pending_approval'");
    const { rows: failedPostings } = await db.execute(`${POSTING_SELECT} WHERE p.status = 'failed' ORDER BY p.id LIMIT 25`);
    res.json({
      approval_hours: hours,
      counts: {
        pending_approval: Number(pending.n) || 0, pending_value: round2(pending.v), overdue_approvals: Number(pending.overdue) || 0,
        awaiting_my_approval: pendingRows.filter(r => parseApprovers(r).some(a => Number(a.id) === me)).length,
        approved_awaiting_issue: Number(awaitingIssue.n) || 0, partially_issued: Number(partial.n) || 0,
        outstanding_lines: Number(outstanding.lines) || 0, outstanding_value: round2(outstanding.v),
        posting_failed: Number(postings.failed) || 0, posting_pending: Number(postings.pending) || 0, unreconciled: Number(postings.unreconciled) || 0,
        month_cost: round2(month.v), tools_assigned: Number(tools.n) || 0,
      },
      overdue: pendingRows.filter(r => r.submitted_at && (Date.now() - new Date(r.submitted_at.replace(' ', 'T') + 'Z')) > hours * 3600e3),
      awaiting_issue: await list("r.approval_status = 'approved' AND r.fulfillment_status IN ('not_issued', 'partial')"),
      failed_postings: all ? failedPostings : [],
    });
  } catch (e) { sendError(res, e); }
});

// Polled by the app for notifications: requests waiting on me to approve,
// and decisions on my own requests.
router.get('/inbox', inModule, async (req, res) => {
  try {
    const me = Number(req.employee?.id) || 0;
    const { rows: pending } = await db.execute(`SELECT r.id, r.request_number, r.version, r.total_estimated, r.category, r.reason, r.routed_approvers, r.submitted_at,
        e.first_name || ' ' || e.last_name AS requested_by_name, b.name AS branch_name, r.department
      FROM shop_use_requests r LEFT JOIN employees e ON e.id = r.requested_by LEFT JOIN branches b ON b.id = r.branch_id
      WHERE r.approval_status = 'pending_approval'`);
    const approvals = req.employee?.permissions?.shop_use_approve
      ? pending.filter(r => parseApprovers(r).some(a => Number(a.id) === me)).map(({ routed_approvers, ...r }) => ({ ...r, category_label: categoryLabel(r.category) }))
      : [];
    const { rows: decisions } = await db.execute({
      sql: `SELECT r.id, r.request_number, r.version, r.approval_status, r.decided_at, r.decision_comment, d.first_name || ' ' || d.last_name AS decided_by_name
            FROM shop_use_requests r LEFT JOIN employees d ON d.id = r.decided_by
            WHERE r.requested_by = ? AND r.approval_status IN ('approved', 'rejected', 'returned') AND r.decided_at >= datetime('now', '-14 days')`,
      args: [me],
    });
    res.json({ approvals, decisions });
  } catch (e) { sendError(res, e); }
});

// ── Attachments ────────────────────────────────────────────────────────────

const localUploadDir = path.join(__dirname, '../uploads/shop-use-attachments');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.post('/requests/:id/attachments', requirePermission('shop_use_request'), (req, res, next) => {
  upload.single('file')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const { rows: [r] } = await db.execute({ sql: 'SELECT * FROM shop_use_requests WHERE id = ?', args: [req.params.id] });
    if (!r || !canSee(req, r)) return fail(res, 404, 'Shop Use request not found');
    if (!req.file) return fail(res, 400, 'No file uploaded or file type not allowed');
    const cloud = await cloudUpload(req.file.buffer, { folder: 'pos-system/shop-use-attachments', public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, resource_type: 'auto' });
    let stored;
    if (cloud) stored = cloud.secure_url;
    else {
      fs.mkdirSync(localUploadDir, { recursive: true });
      stored = `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(path.join(localUploadDir, stored), req.file.buffer);
    }
    const ins = await db.execute({
      sql: 'INSERT INTO shop_use_attachments (request_id, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?)',
      args: [r.id, req.file.originalname, stored, req.file.mimetype, req.file.size, req.employee?.id || null],
    });
    await audit(db, { requestId: r.id, entity: 'attachment', entityId: Number(ins.lastInsertRowid), action: 'attachment_added', employee: req.employee, details: { file: req.file.originalname } });
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  } catch (e) { sendError(res, e); }
});

router.get('/requests/:id/attachments/:aid/download', inModule, async (req, res) => {
  try {
    const { rows: [a] } = await db.execute({ sql: 'SELECT a.*, r.requested_by FROM shop_use_attachments a JOIN shop_use_requests r ON r.id = a.request_id WHERE a.id = ? AND a.request_id = ?', args: [req.params.aid, req.params.id] });
    if (!a || !canSee(req, a)) return fail(res, 404, 'Not found');
    if (a.stored_name.startsWith('https://')) return res.redirect(a.stored_name.replace('/upload/', '/upload/fl_attachment/'));
    const file = path.join(localUploadDir, a.stored_name);
    if (!fs.existsSync(file)) return fail(res, 404, 'File missing on server');
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.attachment(a.original_name);
    res.sendFile(file);
  } catch (e) { sendError(res, e); }
});

// Removable only while the request is still being prepared, so what the
// approver saw stays on the record.
router.delete('/requests/:id/attachments/:aid', requirePermission('shop_use_request'), async (req, res) => {
  try {
    const { rows: [a] } = await db.execute({ sql: 'SELECT a.*, r.approval_status, r.requested_by FROM shop_use_attachments a JOIN shop_use_requests r ON r.id = a.request_id WHERE a.id = ? AND a.request_id = ?', args: [req.params.aid, req.params.id] });
    if (!a) return fail(res, 404, 'Not found');
    if (Number(a.requested_by) !== Number(req.employee?.id)) return fail(res, 403, 'Only the requester can remove documents');
    if (!['draft', 'returned'].includes(a.approval_status)) return fail(res, 400, 'Documents stay on the record once a request is submitted');
    if (a.stored_name.startsWith('https://')) {
      const type = (a.stored_name.match(/\/(image|raw|video)\/upload\//) || [])[1] || 'raw';
      await cloudDestroy(a.stored_name, type);
    } else {
      try { fs.unlinkSync(path.join(localUploadDir, a.stored_name)); } catch {}
    }
    await db.execute({ sql: 'DELETE FROM shop_use_attachments WHERE id = ?', args: [a.id] });
    await audit(db, { requestId: a.request_id, entity: 'attachment', entityId: a.id, action: 'attachment_removed', employee: req.employee, details: { file: a.original_name } });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── Reports ────────────────────────────────────────────────────────────────
// GET /reports/:type — { title, columns: [{ key, label, align, money }], rows, totals }
// or, with ?format=pdf, the same as a PDF. Filters: from, to, branch_id,
// department, category, product_id, requested_by, approved_by,
// approval_status, fulfillment_status, posting_status, recon_status.

const REPORTS = {
  detail: 'Shop Use Transactions (Detail)',
  monthly: 'Monthly Shop Use Cost by Branch & Department',
  usage: 'Usage by Item & Category',
  'awaiting-issue': 'Approved Requests Awaiting Issue',
  outstanding: 'Partially Issued Requests & Outstanding Quantities',
  postings: 'Failed or Pending Postings',
  unreconciled: 'Unreconciled Transactions',
  returns: 'Returns & Reversals',
  tools: 'Reusable Tools & Custodians',
};

// WHERE fragment on request r (and the document date expression `dateCol`).
function reportFilter(q, dateCol) {
  const parts = [];
  const args = [];
  const eq = (col, v) => { if (v) { parts.push(`${col} = ?`); args.push(v); } };
  if (q.from && dateCol) { parts.push(`date(${dateCol}) >= ?`); args.push(q.from); }
  if (q.to && dateCol) { parts.push(`date(${dateCol}) <= ?`); args.push(q.to); }
  eq('r.branch_id', q.branch_id);
  eq('r.category', q.category);
  eq('r.requested_by', q.requested_by);
  eq('r.decided_by', q.approved_by);
  eq('r.approval_status', q.approval_status);
  eq('r.fulfillment_status', q.fulfillment_status);
  if (q.department) { parts.push('LOWER(r.department) = LOWER(?)'); args.push(q.department); }
  return { where: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
}

const R_JOINS = `JOIN shop_use_requests r ON r.id = i.request_id
  LEFT JOIN branches b ON b.id = r.branch_id
  LEFT JOIN employees rq ON rq.id = r.requested_by LEFT JOIN employees ap ON ap.id = r.decided_by`;

async function buildReport(type, q) {
  const col = (key, label, opts = {}) => ({ key, label, ...opts });
  const productFilter = q.product_id ? ' AND l.product_id = ?' : '';
  const productArgs = q.product_id ? [q.product_id] : [];
  const postingFilter = rows => rows.filter(r => (!q.posting_status || r.posting_status === q.posting_status) && (!q.recon_status || r.recon_status === q.recon_status));

  if (type === 'detail' || type === 'returns') {
    const out = [];
    if (type === 'detail') {
      const { rows } = await db.execute({
        sql: `SELECT i.issued_at AS date, 'Issue' AS kind, i.issue_number AS doc, r.request_number, b.name AS branch, r.department, r.category,
                l.sku, l.description, l.unit_name, il.quantity, il.unit_cost * l.units_per AS unit_cost, il.line_cost AS value,
                rq.first_name || ' ' || rq.last_name AS requester, ap.first_name || ' ' || ap.last_name AS approver,
                p.status AS posting_status, p.recon_status
              FROM shop_use_issue_lines il JOIN shop_use_issues i ON i.id = il.issue_id JOIN shop_use_request_lines l ON l.id = il.request_line_id ${R_JOINS}
              LEFT JOIN shop_use_postings p ON p.source_type = 'issue' AND p.source_id = i.id
              WHERE 1=1${reportFilter(q, 'i.issued_at').where}${productFilter}`,
        args: [...reportFilter(q, 'i.issued_at').args, ...productArgs],
      });
      out.push(...rows);
    }
    const { rows: rets } = await db.execute({
      sql: `SELECT x.received_at AS date, CASE WHEN x.kind = 'reversal' THEN 'Reversal' ELSE 'Return' END AS kind, x.return_number AS doc, i.issue_number, r.request_number,
              b.name AS branch, r.department, r.category, l.sku, l.description, l.unit_name, -rl.quantity AS quantity, il.unit_cost * l.units_per AS unit_cost, -rl.line_cost AS value,
              rl.condition, CASE WHEN rl.restocked THEN 'Yes' ELSE 'No' END AS restocked, x.reason, e.first_name || ' ' || e.last_name AS received_by,
              rq.first_name || ' ' || rq.last_name AS requester, ap.first_name || ' ' || ap.last_name AS approver, p.status AS posting_status, p.recon_status
            FROM shop_use_return_lines rl JOIN shop_use_returns x ON x.id = rl.return_id JOIN shop_use_issues i ON i.id = x.issue_id
            JOIN shop_use_issue_lines il ON il.id = rl.issue_line_id JOIN shop_use_request_lines l ON l.id = il.request_line_id ${R_JOINS}
            LEFT JOIN employees e ON e.id = x.received_by
            LEFT JOIN shop_use_postings p ON p.source_type = 'return' AND p.source_id = x.id
            WHERE 1=1${reportFilter(q, 'x.received_at').where}${productFilter}`,
      args: [...reportFilter(q, 'x.received_at').args, ...productArgs],
    });
    out.push(...rets);
    const rows = postingFilter(out).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    rows.forEach(r => { r.category = categoryLabel(r.category); r.date = String(r.date).slice(0, 16); });
    if (type === 'returns') {
      rows.forEach(r => { r.quantity = -r.quantity; r.value = -r.value; });
      return {
        columns: [col('date', 'Date'), col('kind', 'Type'), col('doc', 'Return #'), col('issue_number', 'Issue #'), col('request_number', 'Request #'), col('branch', 'Branch'),
          col('department', 'Department'), col('description', 'Item'), col('quantity', 'Qty', { align: 'right', sum: true }), col('condition', 'Condition'), col('restocked', 'Restocked'),
          col('value', 'Cost Reversed', { align: 'right', money: true, sum: true }), col('received_by', 'Received By'), col('reason', 'Reason'), col('posting_status', 'Posting')],
        rows,
      };
    }
    return {
      columns: [col('date', 'Date'), col('kind', 'Type'), col('doc', 'Document'), col('request_number', 'Request #'), col('branch', 'Branch'), col('department', 'Department'),
        col('category', 'Category'), col('sku', 'Code'), col('description', 'Item'), col('quantity', 'Qty', { align: 'right', sum: true }), col('unit_cost', 'Unit Cost', { align: 'right', money: true }),
        col('value', 'Value', { align: 'right', money: true, sum: true }), col('requester', 'Requester'), col('approver', 'Approver'), col('posting_status', 'Posting'), col('recon_status', 'Reconciliation')],
      rows,
    };
  }

  if (type === 'monthly') {
    const fi = reportFilter(q, 'p.posting_date');
    const { rows } = await db.execute({
      sql: `SELECT strftime('%Y-%m', p.posting_date) AS month, b.name AS branch, p.department,
              SUM(CASE WHEN p.source_type = 'issue' THEN p.amount ELSE 0 END) AS issued,
              SUM(CASE WHEN p.source_type = 'return' THEN p.amount ELSE 0 END) AS returned
            FROM shop_use_postings p JOIN shop_use_requests r ON r.id = p.request_id LEFT JOIN branches b ON b.id = p.branch_id
            WHERE p.status != 'not_required'${fi.where}
            GROUP BY month, p.branch_id, LOWER(p.department) ORDER BY month, branch, p.department`,
      args: fi.args,
    });
    rows.forEach(r => { r.issued = round2(r.issued); r.returned = round2(r.returned); r.net = round2(r.issued - r.returned); });
    return {
      columns: [col('month', 'Month'), col('branch', 'Branch'), col('department', 'Department'), col('issued', 'Issued', { align: 'right', money: true, sum: true }),
        col('returned', 'Returned / Reversed', { align: 'right', money: true, sum: true }), col('net', 'Net Cost', { align: 'right', money: true, sum: true })],
      rows,
    };
  }

  if (type === 'usage') {
    const fi = reportFilter(q, 'i.issued_at');
    const { rows } = await db.execute({
      sql: `SELECT l.product_id, l.sku, COALESCE(pr.name, l.description) AS item, r.category,
              SUM(il.stock_units) AS issued_units, SUM(il.line_cost) AS issued_cost,
              COALESCE(SUM((SELECT SUM(rl.stock_units) FROM shop_use_return_lines rl WHERE rl.issue_line_id = il.id AND rl.restocked = 1)), 0) AS returned_units,
              COALESCE(SUM((SELECT SUM(rl.line_cost) FROM shop_use_return_lines rl WHERE rl.issue_line_id = il.id)), 0) AS returned_cost
            FROM shop_use_issue_lines il JOIN shop_use_issues i ON i.id = il.issue_id JOIN shop_use_request_lines l ON l.id = il.request_line_id
            JOIN shop_use_requests r ON r.id = i.request_id LEFT JOIN products pr ON pr.id = l.product_id
            WHERE l.product_id IS NOT NULL${fi.where}${productFilter}
            GROUP BY l.product_id, r.category ORDER BY r.category, item`,
      args: [...fi.args, ...productArgs],
    });
    rows.forEach(r => {
      r.category = categoryLabel(r.category);
      r.net_units = round4(r.issued_units - r.returned_units);
      r.net_cost = round2(r.issued_cost - r.returned_cost);
      r.issued_cost = round2(r.issued_cost);
    });
    return {
      columns: [col('category', 'Category'), col('sku', 'Code'), col('item', 'Item'), col('issued_units', 'Units Issued', { align: 'right', sum: true }),
        col('returned_units', 'Units Returned', { align: 'right', sum: true }), col('net_units', 'Net Units', { align: 'right', sum: true }),
        col('issued_cost', 'Issued Cost', { align: 'right', money: true, sum: true }), col('net_cost', 'Net Cost', { align: 'right', money: true, sum: true })],
      rows,
    };
  }

  if (type === 'awaiting-issue' || type === 'outstanding') {
    const fi = reportFilter(q, 'r.decided_at');
    const statuses = type === 'awaiting-issue' ? "('not_issued', 'partial')" : "('partial')";
    if (type === 'awaiting-issue') {
      const { rows } = await db.execute({
        sql: `${REQ_SELECT} WHERE r.approval_status = 'approved' AND r.fulfillment_status IN ${statuses}${fi.where}${q.product_id ? ' AND EXISTS (SELECT 1 FROM shop_use_request_lines l WHERE l.request_id = r.id AND l.product_id = ?)' : ''} ORDER BY r.decided_at`,
        args: [...fi.args, ...productArgs],
      });
      const out = postingFilter(rows).filter(r => Number(r.qty_outstanding) > 0).map(r => ({
        request_number: r.request_number, approved: String(r.decided_at || '').slice(0, 16), age_days: r.decided_at ? Math.floor((Date.now() - new Date(r.decided_at.replace(' ', 'T') + 'Z')) / 864e5) : '',
        branch: r.branch_name, department: r.department, category: categoryLabel(r.category), source: r.source_branch_name, requester: r.requested_by_name, approver: r.decided_by_name,
        status: r.fulfillment_status === 'partial' ? 'Partially issued' : 'Not issued', value_outstanding: round2(r.value_outstanding),
      }));
      return {
        columns: [col('request_number', 'Request #'), col('approved', 'Approved'), col('age_days', 'Days Waiting', { align: 'right' }), col('branch', 'Branch'), col('department', 'Department'),
          col('category', 'Category'), col('source', 'Supplying Location'), col('requester', 'Requester'), col('approver', 'Approver'), col('status', 'Status'),
          col('value_outstanding', 'Value Outstanding', { align: 'right', money: true, sum: true })],
        rows: out,
      };
    }
    const { rows } = await db.execute({
      sql: `SELECT r.request_number, r.decided_at, b.name AS branch, r.department, r.category, l.sku, l.description, l.unit_name,
              l.qty_approved, l.qty_issued, l.qty_cancelled, l.qty_approved - l.qty_issued - l.qty_cancelled AS outstanding,
              (l.qty_approved - l.qty_issued - l.qty_cancelled) * l.unit_cost AS value, rq.first_name || ' ' || rq.last_name AS requester
            FROM shop_use_request_lines l JOIN shop_use_requests r ON r.id = l.request_id LEFT JOIN branches b ON b.id = r.branch_id
            LEFT JOIN employees rq ON rq.id = r.requested_by
            WHERE r.approval_status = 'approved' AND r.fulfillment_status IN ('not_issued', 'partial') AND l.qty_approved - l.qty_issued - l.qty_cancelled > 0
              AND r.fulfillment_status = 'partial'${fi.where}${productFilter} ORDER BY r.id, l.id`,
      args: [...fi.args, ...productArgs],
    });
    rows.forEach(r => { r.category = categoryLabel(r.category); r.value = round2(r.value); r.outstanding = round4(r.outstanding); });
    return {
      columns: [col('request_number', 'Request #'), col('branch', 'Branch'), col('department', 'Department'), col('category', 'Category'), col('sku', 'Code'), col('description', 'Item'),
        col('qty_approved', 'Approved', { align: 'right' }), col('qty_issued', 'Issued', { align: 'right' }), col('qty_cancelled', 'Cancelled', { align: 'right' }),
        col('outstanding', 'Outstanding', { align: 'right', sum: true }), col('value', 'Est. Value', { align: 'right', money: true, sum: true }), col('requester', 'Requester')],
      rows,
    };
  }

  if (type === 'postings' || type === 'unreconciled') {
    const fi = reportFilter(q, 'p.posting_date');
    const where = type === 'postings' ? "p.status IN ('failed', 'pending')" : "p.recon_status = 'unreconciled' AND p.status != 'not_required'";
    const { rows } = await db.execute({
      sql: `SELECT p.*, r.request_number, b.name AS branch FROM shop_use_postings p JOIN shop_use_requests r ON r.id = p.request_id LEFT JOIN branches b ON b.id = p.branch_id
            WHERE ${where}${fi.where} ORDER BY p.posting_date, p.id`,
      args: fi.args,
    });
    const out = [];
    for (const p of rows) {
      const row = {
        date: p.posting_date, reference: p.reference, type: p.source_type === 'issue' ? 'Issue' : 'Return', request_number: p.request_number, branch: p.branch,
        department: p.department, category: categoryLabel(p.category), debit: p.debit_account_code, credit: p.credit_account_code, amount: p.amount,
        status: p.status, attempts: p.attempts, error: p.last_error, posted_amount: p.posted_amount, external_ref: p.external_ref,
      };
      if (type === 'unreconciled') {
        const checks = await reconChecks(p);
        row.differences = checks.filter(c => !c.ok).map(c => `${c.label}: ${c.detail}`).join('; ') || 'None — ready to reconcile';
        row.notes = p.recon_comment;
      }
      out.push(row);
    }
    if (type === 'postings') {
      return {
        columns: [col('date', 'Date'), col('reference', 'Reference'), col('type', 'Type'), col('request_number', 'Request #'), col('branch', 'Branch'), col('department', 'Department'),
          col('debit', 'Debit'), col('credit', 'Credit'), col('amount', 'Amount', { align: 'right', money: true, sum: true }), col('status', 'Status'), col('attempts', 'Attempts', { align: 'right' }), col('error', 'Error')],
        rows: out,
      };
    }
    return {
      columns: [col('date', 'Date'), col('reference', 'Reference'), col('type', 'Type'), col('request_number', 'Request #'), col('branch', 'Branch'), col('department', 'Department'),
        col('amount', 'Amount', { align: 'right', money: true, sum: true }), col('status', 'Posting'), col('posted_amount', 'Posted', { align: 'right', money: true }),
        col('differences', 'Differences'), col('notes', 'Investigation Notes')],
      rows: out,
    };
  }

  if (type === 'tools') {
    let sql = `${TOOL_SELECT} WHERE 1=1`;
    const args = [];
    if (q.branch_id) { sql += ' AND t.branch_id = ?'; args.push(q.branch_id); }
    if (q.department) { sql += ' AND LOWER(t.department) = LOWER(?)'; args.push(q.department); }
    if (q.tool_status) { sql += ' AND t.status = ?'; args.push(q.tool_status); }
    if (q.from) { sql += ' AND date(t.issued_at) >= ?'; args.push(q.from); }
    if (q.to) { sql += ' AND date(t.issued_at) <= ?'; args.push(q.to); }
    sql += ' ORDER BY t.tool_number';
    const { rows } = await db.execute({ sql, args });
    return {
      columns: [col('tool_number', 'Tool #'), col('description', 'Description'), col('serial_number', 'Serial #'), col('type', 'Type'), col('status', 'Status'),
        col('custodian_name', 'Custodian'), col('branch_name', 'Branch'), col('department', 'Department'), col('location', 'Location'), col('issued', 'Issued'),
        col('condition', 'Condition'), col('unit_cost', 'Cost', { align: 'right', money: true, sum: true })],
      rows: rows.map(t => ({ ...t, type: t.source === 'inventory' ? 'Taken from inventory' : 'Company tool register', issued: String(t.issued_at || '').slice(0, 10) })),
    };
  }
  throw new UserError('Unknown report', 404);
}

router.get('/reports/:type', requireAnyPermission('shop_use_reports', 'shop_use_finance'), async (req, res) => {
  try {
    const title = REPORTS[req.params.type];
    if (!title) return fail(res, 404, 'Unknown report');
    const report = await buildReport(req.params.type, req.query);
    report.title = title;
    report.totals = {};
    for (const c of report.columns) if (c.sum) report.totals[c.key] = (c.money ? round2 : round4)(report.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0));
    if (req.query.format !== 'pdf') return res.json(report);
    const s = await storeInfo();
    const filters = [];
    if (req.query.from || req.query.to) filters.push(['Period', `${req.query.from || '…'} to ${req.query.to || '…'}`]);
    if (req.query.branch_id) {
      const { rows: [b] } = await db.execute({ sql: 'SELECT name FROM branches WHERE id = ?', args: [req.query.branch_id] });
      filters.push(['Branch', b?.name || req.query.branch_id]);
    }
    if (req.query.department) filters.push(['Department', req.query.department]);
    if (req.query.category) filters.push(['Category', categoryLabel(req.query.category)]);
    const fmtCell = (c, v) => v == null || v === '' ? '' : c.money ? money(v) : String(v);
    const pdf = await renderDocumentPdf({
      store: { name: s.store_name || 'My Store', address: s.store_address || '', phone: s.store_phone || '', logo: s.company_logo_url || null },
      title: title.toUpperCase(), number: '',
      meta: [['Printed', pdfDateTime(new Date().toISOString())], ...filters],
      tables: [{ columns: report.columns.map(c => ({ label: c.label, width: c.money ? 1.2 : /description|item|differences|error|reason/i.test(c.key) ? 2.2 : 1, align: c.align })),
        rows: report.rows.length ? report.rows.map(r => ({ cells: report.columns.map(c => fmtCell(c, r[c.key])) })) : [{ cells: ['No records match these filters', ...report.columns.slice(1).map(() => '')] }] }],
      totals: report.columns.filter(c => c.sum).map(c => ({ label: `Total ${c.label}`, value: fmtCell(c, report.totals[c.key]) })).concat([{ label: 'Rows', value: String(report.rows.length) }]),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="shop-use-${req.params.type}.pdf"`);
    res.send(pdf);
  } catch (e) { sendError(res, e); }
});

// Full audit trail across Shop Use (configuration changes included).
router.get('/audit', requireAnyPermission('shop_use_finance', 'shop_use_reports'), async (req, res) => {
  try {
    let sql = 'SELECT a.*, r.request_number FROM shop_use_audit a LEFT JOIN shop_use_requests r ON r.id = a.request_id WHERE 1=1';
    const args = [];
    if (req.query.from) { sql += ' AND date(a.created_at) >= ?'; args.push(req.query.from); }
    if (req.query.to) { sql += ' AND date(a.created_at) <= ?'; args.push(req.query.to); }
    if (req.query.entity) { sql += ' AND a.entity = ?'; args.push(req.query.entity); }
    sql += ' ORDER BY a.id DESC LIMIT 2000';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

module.exports = router;
