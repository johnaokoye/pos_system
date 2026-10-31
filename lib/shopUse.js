// Shop Use — stock taken from inventory for company use (cleaning,
// maintenance, equipment repairs, internal projects, reusable tools).
// Shared helpers for routes/shop-use.js:
//   request (draft → pending_approval → approved | rejected | returned)
//   → issue (stock out at inventory cost, posting queued for RetailPOS Books)
//   → return / reversal (stock back at the original issue cost)
//   → reconciliation (Finance).
// Nothing here creates a sale, revenue or a customer receivable.

const { can } = require('./permissions');
const { stockUnits } = require('./units');
const { syncBinQty } = require('./binSync');

const CATEGORIES = [
  { key: 'cleaning', label: 'Cleaning & general consumables', treatment: 'expense' },
  { key: 'maintenance', label: 'Building & branch maintenance', treatment: 'expense' },
  { key: 'equipment_repair', label: 'Company equipment repairs', treatment: 'expense' },
  { key: 'internal_project', label: 'Internal projects', treatment: 'expense' },
  { key: 'tools', label: 'Reusable tools & equipment', treatment: 'asset' },
];
const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const categoryLabel = key => CATEGORIES.find(c => c.key === key)?.label || key;

// Account codes used until Finance maps a category (Settings → Shop Use).
// Credit is the inventory account; RetailPOS Books' chart has Inventory at 1300.
const DEFAULT_INVENTORY_ACCOUNT = '1300';

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const round4 = n => Math.round((Number(n) || 0) * 10000) / 10000;
const empName = e => e ? [e.first_name, e.last_name].filter(Boolean).join(' ') : null;

// Can see every request (not just their own): anyone working the queue.
function seesAll(perms) {
  return !!perms && (can(perms, 'shop_use_issue') || can(perms, 'shop_use_finance') || can(perms, 'shop_use_reports')
    || can(perms, 'shop_use_routing') || !!perms.shop_use_approve || !!perms.shop_use);
}

async function audit(executor, { requestId = null, entity, entityId = null, action, details = null, employee = null }) {
  await executor.execute({
    sql: 'INSERT INTO shop_use_audit (request_id, entity, entity_id, action, details, employee_id, employee_name) VALUES (?,?,?,?,?,?,?)',
    args: [requestId, entity, entityId, action, details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)), employee?.id || null, empName(employee)],
  });
}

// Stock units on hand for a product at a branch (the supplying location).
async function onHand(executor, productId, branchId) {
  if (!productId) return 0;
  if (branchId) {
    const { rows: [bi] } = await executor.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [productId, branchId] });
    return Number(bi?.stock_qty) || 0;
  }
  const { rows: [p] } = await executor.execute({ sql: 'SELECT stock_qty FROM products WHERE id = ?', args: [productId] });
  return Number(p?.stock_qty) || 0;
}

// Fulfilment from the lines: every line done (issued + cancelled covers the
// approved quantity) → issued, or cancelled when nothing was issued at all.
// An amended request waiting for reapproval (no approved quantities) that
// already had stock issued stays partially issued.
function fulfillmentOf(lines) {
  const issued = lines.reduce((s, l) => s + (Number(l.qty_issued) || 0), 0);
  const active = lines.filter(l => l.qty_approved != null);
  if (!active.length) return issued > 0 ? 'partial' : 'not_issued';
  const open = active.reduce((s, l) => s + Math.max(0, round4((Number(l.qty_approved) || 0) - (Number(l.qty_issued) || 0) - (Number(l.qty_cancelled) || 0))), 0);
  if (open > 0) return issued > 0 ? 'partial' : 'not_issued';
  return issued > 0 ? 'issued' : 'cancelled';
}

async function refreshFulfillment(executor, requestId) {
  const { rows: lines } = await executor.execute({ sql: 'SELECT qty_approved, qty_issued, qty_cancelled FROM shop_use_request_lines WHERE request_id = ?', args: [requestId] });
  const status = fulfillmentOf(lines);
  await executor.execute({ sql: "UPDATE shop_use_requests SET fulfillment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND fulfillment_status != 'cancelled'", args: [status, requestId] });
  return status;
}

// ── Approval routing ───────────────────────────────────────────────────────
// Rules that match the request (blank branch/department/category = any),
// lowest limit first (no limit last). The request goes to the first rule
// whose limit covers its total and that has an approver other than the
// requester holding shop_use_approve — so one above a manager's authority,
// or raised by the only approver on a rule, moves up to the next rule.
// With no rules set up at all, any shop_use_approve holder may approve.
async function eligibleApprovers(executor, ruleId, excludeEmployeeId) {
  const sql = ruleId
    ? `SELECT e.id, e.first_name, e.last_name, sg.permissions FROM shop_use_rule_approvers ra
         JOIN employees e ON e.id = ra.employee_id LEFT JOIN security_groups sg ON sg.id = e.security_group_id
       WHERE ra.rule_id = ? AND e.active = 1`
    : `SELECT e.id, e.first_name, e.last_name, sg.permissions FROM employees e
         LEFT JOIN security_groups sg ON sg.id = e.security_group_id WHERE e.active = 1`;
  const { rows } = await executor.execute({ sql, args: ruleId ? [ruleId] : [] });
  return rows.filter(r => {
    if (Number(r.id) === Number(excludeEmployeeId)) return false;
    let p = {};
    try { p = JSON.parse(r.permissions || '{}'); } catch {}
    return !!p.shop_use_approve;
  }).map(r => ({ id: Number(r.id), name: empName(r) }));
}

async function matchingRules(executor, req) {
  const { rows } = await executor.execute({
    sql: `SELECT * FROM shop_use_approval_rules WHERE active = 1
            AND (branch_id IS NULL OR branch_id = ?)
            AND (department IS NULL OR department = '' OR LOWER(department) = LOWER(?))
            AND (category IS NULL OR category = '' OR category = ?)
          ORDER BY CASE WHEN max_amount IS NULL THEN 1 ELSE 0 END, max_amount, id`,
    args: [req.branch_id || 0, req.department || '', req.category],
  });
  return rows;
}

async function routeRequest(executor, req) {
  const { rows: [{ n }] } = await executor.execute('SELECT COUNT(*) AS n FROM shop_use_approval_rules WHERE active = 1');
  const total = round2(req.total_estimated);
  if (!Number(n)) {
    const approvers = await eligibleApprovers(executor, null, req.requested_by);
    if (!approvers.length) return { error: 'No one other than you can approve Shop Use requests — ask an administrator to give an approver the Approve Shop Use permission' };
    return { rule: null, approvers };
  }
  const rules = await matchingRules(executor, req);
  if (!rules.length) return { error: 'No approval rule covers this branch, department and category — ask management to add one under Shop Use → Settings' };
  for (const r of rules) {
    if (r.max_amount != null && Number(r.max_amount) < total) continue;
    const approvers = await eligibleApprovers(executor, r.id, req.requested_by);
    if (approvers.length) return { rule: r, approvers };
  }
  return { error: `No approver has authority for ${total.toFixed(2)} on this branch, department and category — ask management to set an approval limit that covers it` };
}

// Whether `employee` may decide on the request: holds shop_use_approve,
// isn't the requester, and (when routing rules exist) is on a matching rule
// whose limit covers the total.
async function approvalAuthority(executor, employee, req) {
  if (!employee?.permissions?.shop_use_approve) return { ok: false, error: 'You do not have permission to approve Shop Use requests' };
  if (Number(employee.id) === Number(req.requested_by)) return { ok: false, error: 'You cannot approve your own request' };
  const { rows: [{ n }] } = await executor.execute('SELECT COUNT(*) AS n FROM shop_use_approval_rules WHERE active = 1');
  if (!Number(n)) return { ok: true };
  const total = round2(req.total_estimated);
  for (const r of await matchingRules(executor, req)) {
    if (r.max_amount != null && Number(r.max_amount) < total) continue;
    const { rows: [hit] } = await executor.execute({ sql: 'SELECT 1 FROM shop_use_rule_approvers WHERE rule_id = ? AND employee_id = ?', args: [r.id, employee.id] });
    if (hit) return { ok: true, rule: r };
  }
  return { ok: false, error: `This request (${total.toFixed(2)}) is above your approval authority for this branch, department and category` };
}

// ── Accounting ─────────────────────────────────────────────────────────────
async function accountMapping(executor, category) {
  const { rows: [m] } = await executor.execute({ sql: 'SELECT * FROM shop_use_accounts WHERE category = ?', args: [category] });
  const { rows: [inv] } = await executor.execute({ sql: "SELECT value FROM settings WHERE key = 'shop_use_inventory_account'", args: [] });
  return {
    treatment: m?.treatment || CATEGORIES.find(c => c.key === category)?.treatment || 'expense',
    debit: m?.debit_account_code || null,
    credit: m?.credit_account_code || inv?.value || DEFAULT_INVENTORY_ACCOUNT,
  };
}

// Queues the accounting entry for an issue (Dr expense/asset, Cr inventory)
// or a return/reversal (the reverse). Stored with the document, in the same
// database transaction as its stock movement, so the two always go together.
// A category Finance hasn't mapped yet is queued as failed with that reason.
async function queuePosting(executor, { sourceType, sourceId, reference, request, amount, date, memo }) {
  const map = await accountMapping(executor, request.category);
  const isReturn = sourceType === 'return';
  const debit = isReturn ? map.credit : map.debit;
  const credit = isReturn ? map.debit : map.credit;
  const zero = !(round2(amount) > 0);
  const status = zero ? 'not_required' : (map.debit ? 'pending' : 'failed');
  const error = zero ? null : (map.debit ? null : `No ${map.treatment} account is mapped for ${categoryLabel(request.category)} — set it in Shop Use → Settings, then retry`);
  const r = await executor.execute({
    sql: `INSERT INTO shop_use_postings (source_type, source_id, reference, request_id, posting_date, branch_id, department, category,
            debit_account_code, credit_account_code, amount, memo, status, last_error)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [sourceType, sourceId, reference, request.id, date, request.branch_id || null, request.department || null, request.category,
      debit, credit, round2(amount), memo || null, status, error],
  });
  return Number(r.lastInsertRowid);
}

// Moves stock at the supplying branch (negative = out) and logs the movement
// against the Shop Use document number.
async function moveStock(executor, { productId, branchId, units, reference, reason }) {
  if (!units) return;
  if (branchId) {
    await executor.execute({
      sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP)
            ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`,
      args: [productId, branchId, units, productId, units],
    });
    await syncBinQty(executor, productId, branchId, units);
  }
  await executor.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [units, productId] });
  await executor.execute({
    sql: "INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?, ?, ?, 'shop_use', ?, ?)",
    args: [productId, branchId || null, units, reference, reason || null],
  });
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS, categoryLabel, DEFAULT_INVENTORY_ACCOUNT,
  round2, round4, empName, seesAll, audit, onHand, fulfillmentOf, refreshFulfillment,
  routeRequest, approvalAuthority, eligibleApprovers, accountMapping, queuePosting, moveStock, stockUnits,
};
