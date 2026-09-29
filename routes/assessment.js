const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, can, canManageRentals } = require('../lib/permissions');

// Admin > Assessment: training progress per employee. A process counts as
// "completed" when the employee has taken at least one real record all the
// way to its finished state (a quote converted to a sale, a rental returned,
// a work order picked up, ...). Everything is derived from the existing
// module tables — nothing new is recorded — so history from before this
// screen existed counts too, and the optional `since` filter narrows it to a
// training window.
//
// Each process:
//   from       FROM clause (may include joins)
//   emp        column crediting the employee for the record
//   ref        human reference shown in the drill-down (quote number etc.)
//   started    WHERE fragment: the employee began this process ('1' for
//              single-step processes, where starting == completing)
//   completed  WHERE fragment: the record reached its finished state
//   startedAt  timestamp the process began (created_at)
//   doneAt     timestamp it finished — the `since` filter applies to this
//   status     column shown in the drill-down
//   perms      the process only applies to (and only counts toward the gold
//              trophy for) employees whose security group grants one of
//              these keys; 'rentals' is checked with canManageRentals() so
//              driver-only rental subs don't count
//
// Credit goes to whoever the record itself names (employee_id etc.), which
// the frontend fills in from the logged-in user.
const NOT_SIDE_TX = `COALESCE(t.notes,'') NOT LIKE 'Rental %' AND COALESCE(t.notes,'') NOT LIKE 'Work order %' AND COALESCE(t.notes,'') NOT LIKE 'Layaway %' AND COALESCE(t.notes,'') NOT LIKE 'Converted from quotation %'`;

const PROCESSES = [
  {
    key: 'pos_sale', label: 'POS Sale',
    description: 'Ring up and take payment for a sale at the Point of Sale.',
    perms: ['pos'],
    from: 'transactions t', emp: 't.employee_id', ref: 't.transaction_number', status: 't.status',
    started: `t.status = 'completed' AND t.source_return_id IS NULL AND COALESCE(t.source,'pos') = 'pos' AND ${NOT_SIDE_TX}`,
    completed: `t.status = 'completed' AND t.source_return_id IS NULL AND COALESCE(t.source,'pos') = 'pos' AND ${NOT_SIDE_TX}`,
    startedAt: 't.created_at', doneAt: 't.created_at',
  },
  {
    key: 'return', label: 'Return / Refund',
    description: 'Process a return against an earlier sale.',
    perms: ['pos_refunds', 'transactions_returns'],
    from: 'returns r', emp: 'r.employee_id', ref: 'r.return_number', status: 'r.resolution',
    started: '1', completed: '1',
    startedAt: 'r.created_at', doneAt: 'r.created_at',
  },
  {
    key: 'retail_quote', label: 'Retail Quotation',
    description: 'Create a retail quotation and convert it into a sale.',
    perms: ['quotations'],
    from: 'quotations q LEFT JOIN transactions qt ON qt.id = q.converted_to_tx',
    emp: 'COALESCE(q.original_employee_id, q.employee_id)', ref: 'q.quote_number', status: 'q.status',
    started: `COALESCE(q.quote_type,'retail') = 'retail'`,
    completed: `COALESCE(q.quote_type,'retail') = 'retail' AND q.status = 'converted'`,
    startedAt: 'q.created_at', doneAt: 'COALESCE(qt.created_at, q.created_at)',
  },
  {
    key: 'special_project', label: 'Special Project',
    description: 'Build a Special Project quote and see it through to conversion.',
    perms: ['special_projects'],
    from: 'quotations q LEFT JOIN transactions qt ON qt.id = q.converted_to_tx',
    emp: 'COALESCE(q.original_employee_id, q.employee_id)', ref: 'q.quote_number', status: 'q.status',
    started: `q.quote_type = 'special_project'`,
    completed: `q.quote_type = 'special_project' AND q.status = 'converted'`,
    startedAt: 'q.created_at', doneAt: 'COALESCE(qt.created_at, q.created_at)',
  },
  {
    key: 'rental_agreement', label: 'Rental Agreement',
    description: 'Open a rental agreement and complete it through to the items being returned.',
    perms: ['rentals'],
    from: 'rental_agreements ra', emp: 'ra.employee_id', ref: 'ra.agreement_number', status: 'ra.status',
    started: `ra.status NOT IN ('cancelled','voided')`,
    completed: `ra.status = 'returned'`,
    startedAt: 'ra.created_at', doneAt: 'COALESCE(ra.returned_at, ra.created_at)',
  },
  {
    key: 'work_order', label: 'Work Order',
    description: 'Take a work order from intake through to customer pickup and final payment.',
    perms: ['work_orders'],
    from: 'work_orders wo', emp: 'wo.employee_id', ref: 'wo.wo_number', status: 'wo.status',
    started: `wo.status NOT IN ('cancelled')`,
    completed: `wo.status = 'picked_up'`,
    startedAt: 'wo.created_at', doneAt: 'COALESCE(wo.picked_up_at, wo.created_at)',
  },
  {
    key: 'layaway', label: 'Layaway',
    description: 'Set up a layaway plan and take it through to fully paid.',
    perms: ['layaway'],
    from: 'layaway_plans lp', emp: 'lp.employee_id', ref: 'lp.plan_number', status: 'lp.status',
    started: `lp.status != 'cancelled'`,
    completed: `lp.status = 'completed'`,
    startedAt: 'lp.created_at', doneAt: 'COALESCE(lp.completed_at, lp.created_at)',
  },
  {
    key: 'account_payment', label: 'Account Payment',
    description: 'Record a payment against a customer account (AR).',
    perms: ['accounts_payments', 'pos_pay_on_account'],
    from: 'account_payments ap', emp: 'ap.employee_id', ref: 'ap.payment_number', status: `'recorded'`,
    started: '1', completed: '1',
    startedAt: 'ap.created_at', doneAt: 'ap.created_at',
  },
  {
    key: 'drawer_close', label: 'Drawer Reconciliation',
    description: 'Close a cash drawer session and reconcile the count.',
    perms: ['drawers_close', 'drawers_manage'],
    from: 'drawer_reconciliations dr', emp: 'dr.reconciled_by', ref: `'Session #' || dr.session_id`, status: `'reconciled'`,
    started: '1', completed: '1',
    startedAt: 'dr.reconciled_at', doneAt: 'dr.reconciled_at',
  },
  {
    key: 'purchase_request', label: 'Purchase Request',
    description: 'Raise a purchase request that gets converted into a purchase order.',
    perms: ['purchase_requests'],
    from: 'purchase_requests pr', emp: 'pr.employee_id', ref: 'pr.pr_number', status: 'pr.status',
    started: `pr.status NOT IN ('rejected','cancelled')`,
    completed: `pr.status IN ('converted','received')`,
    startedAt: 'pr.created_at', doneAt: 'pr.created_at',
  },
  {
    key: 'purchase_order', label: 'Purchase Order',
    description: 'Create a purchase order and receive the stock in.',
    perms: ['purchasing'],
    from: 'purchase_orders po', emp: 'po.employee_id', ref: 'po.po_number', status: 'po.status',
    started: `po.status NOT IN ('rejected','cancelled')`,
    completed: `po.status = 'received'`,
    startedAt: 'po.created_at', doneAt: 'COALESCE(po.received_at, po.created_at)',
  },
  {
    key: 'branch_transfer', label: 'Branch Transfer',
    description: 'Create a stock transfer between branches that gets fully received.',
    perms: ['transfers'],
    from: 'branch_transfers bt', emp: 'bt.employee_id', ref: 'bt.transfer_number', status: 'bt.status',
    started: `bt.status != 'cancelled'`,
    completed: `bt.status = 'received'`,
    startedAt: 'bt.created_at', doneAt: 'COALESCE(bt.received_at, bt.created_at)',
  },
  {
    key: 'cycle_count', label: 'Cycle Count',
    description: 'Run a cycle count and commit the results to stock.',
    perms: ['cycle-counts'],
    from: 'cycle_count_sessions cc', emp: 'cc.employee_id', ref: 'cc.session_number', status: 'cc.status',
    started: `cc.status != 'cancelled'`,
    completed: `cc.status = 'committed'`,
    startedAt: 'cc.created_at', doneAt: 'COALESCE(cc.committed_at, cc.created_at)',
  },
];

function applies(proc, permissions) {
  return proc.perms.some(k => (k === 'rentals' ? canManageRentals(permissions) : can(permissions, k)));
}

// YYYY-MM-DD only. Timestamps in these tables are a mix of SQLite
// "YYYY-MM-DD HH:MM:SS" and ISO "YYYY-MM-DDTHH:MM:SS.sssZ"; a date-only
// prefix compares correctly against both as a string.
function parseSince(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '0000-00-00';
}

router.use(requirePermission('assessment'));

router.get('/', async (req, res) => {
  try {
    const since = parseSince(req.query.since);
    const { rows: employees } = await db.execute({
      sql: `SELECT e.id, e.first_name, e.last_name, e.username, sg.name AS security_group_name, sg.permissions, b.name AS branch_name
            FROM employees e
            LEFT JOIN security_groups sg ON sg.id = e.security_group_id
            LEFT JOIN branches b ON b.id = e.default_branch_id
            WHERE e.active = 1
            ORDER BY e.first_name, e.last_name`,
      args: [],
    });

    // One grouped query per process — started/completed counts per employee
    // in a single pass.
    const perProcess = await Promise.all(PROCESSES.map(p => db.execute({
      sql: `SELECT ${p.emp} AS employee_id,
              SUM(CASE WHEN (${p.started}) AND ${p.startedAt} >= ? THEN 1 ELSE 0 END) AS started,
              SUM(CASE WHEN (${p.completed}) AND ${p.doneAt} >= ? THEN 1 ELSE 0 END) AS completed,
              MIN(CASE WHEN (${p.completed}) AND ${p.doneAt} >= ? THEN ${p.doneAt} END) AS first_completed_at,
              MAX(CASE WHEN (${p.completed}) AND ${p.doneAt} >= ? THEN ${p.doneAt} END) AS last_completed_at
            FROM ${p.from}
            WHERE ${p.emp} IS NOT NULL
            GROUP BY 1`,
      args: [since, since, since, since],
    }).then(r => new Map(r.rows.map(row => [Number(row.employee_id), row])))));

    const out = employees.map(e => {
      let permissions = {};
      try { permissions = e.permissions ? JSON.parse(e.permissions) : {}; } catch (_) {}
      const results = {};
      let applicable = 0, earned = 0, earnedAny = 0;
      PROCESSES.forEach((p, i) => {
        const row = perProcess[i].get(Number(e.id));
        const isApplicable = applies(p, permissions);
        const completed = Number(row?.completed || 0);
        results[p.key] = {
          applicable: isApplicable,
          started: Number(row?.started || 0),
          completed,
          first_completed_at: row?.first_completed_at || null,
          last_completed_at: row?.last_completed_at || null,
        };
        if (isApplicable) applicable++;
        if (isApplicable && completed > 0) earned++;
        if (completed > 0) earnedAny++;
      });
      return {
        id: e.id,
        name: `${e.first_name} ${e.last_name}`.trim(),
        username: e.username,
        security_group_name: e.security_group_name,
        branch_name: e.branch_name,
        results,
        applicable_count: applicable,
        badges_earned: earned,
        badges_total: earnedAny,
        gold: applicable > 0 && earned === applicable,
      };
    });

    res.json({
      since: since === '0000-00-00' ? null : since,
      processes: PROCESSES.map(({ key, label, description }) => ({ key, label, description })),
      employees: out,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Drill-down: the actual records behind one employee's badge, so a trainer
// can check what was done (and what's still in progress).
router.get('/:employeeId/:processKey', async (req, res) => {
  try {
    const p = PROCESSES.find(x => x.key === req.params.processKey);
    if (!p) return res.status(404).json({ error: 'Unknown process' });
    const since = parseSince(req.query.since);
    const { rows } = await db.execute({
      sql: `SELECT ${p.ref} AS ref, ${p.status} AS status, ${p.startedAt} AS started_at,
              CASE WHEN (${p.completed}) THEN ${p.doneAt} END AS completed_at,
              CASE WHEN (${p.completed}) THEN 1 ELSE 0 END AS is_completed
            FROM ${p.from}
            WHERE ${p.emp} = ? AND (${p.started})
              AND (CASE WHEN (${p.completed}) THEN ${p.doneAt} ELSE ${p.startedAt} END) >= ?
            ORDER BY ${p.startedAt} DESC
            LIMIT 50`,
      args: [parseInt(req.params.employeeId, 10), since],
    });
    res.json({ process: { key: p.key, label: p.label, description: p.description }, records: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.PROCESSES = PROCESSES;
