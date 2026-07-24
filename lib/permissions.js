// Server-side mirror of App._permissionTree / App.can() in public/index.html
// (search for "_permissionTree:" there). These two must be kept in sync by
// hand — the frontend is a single HTML file, so no code-sharing is possible.
// If you add a permission key to one, add it to the other.
const PERMISSION_TREE = [
  { key: 'dashboard', subs: [] },
  { key: 'pos', subs: [{ key: 'pos_discounts' }, { key: 'pos_refunds' }, { key: 'pos_void_items' }, { key: 'pos_hold' }] },
  { key: 'drawers', subs: [{ key: 'drawers_manage' }, { key: 'drawers_open' }, { key: 'drawers_close' }, { key: 'void_transactions' }] },
  { key: 'inventory', subs: [{ key: 'inventory_add' }, { key: 'inventory_edit' }, { key: 'inventory_delete' }, { key: 'inventory_adjust' }] },
  { key: 'customers', subs: [{ key: 'customers_add' }, { key: 'customers_edit' }, { key: 'customers_delete' }, { key: 'customers_credit' }] },
  { key: 'transactions', subs: [{ key: 'transactions_export' }, { key: 'transactions_refund' }, { key: 'transactions_returns' }] },
  { key: 'reports', subs: [{ key: 'reports_export' }, { key: 'reports_financial' }] },
  { key: 'employees', subs: [{ key: 'employees_add' }, { key: 'employees_edit' }, { key: 'employees_delete' }, { key: 'employees_salaries' }] },
  { key: 'suppliers', subs: [{ key: 'suppliers_add' }, { key: 'suppliers_edit' }, { key: 'suppliers_delete' }] },
  { key: 'services', subs: [] },
  { key: 'rentals', subs: [{ key: 'rentals_manage_items' }, { key: 'rentals_checkout' }, { key: 'rentals_returns' }, { key: 'rentals_issue' }] },
  { key: 'layaway', subs: [{ key: 'layaway_create' }, { key: 'layaway_payments' }, { key: 'layaway_cancel' }] },
  { key: 'purchase_requests', subs: [{ key: 'pr_create' }, { key: 'pr_approve' }, { key: 'pr_convert' }] },
  { key: 'purchasing', subs: [{ key: 'purchasing_create' }, { key: 'purchasing_approve' }, { key: 'purchasing_receive' }] },
  { key: 'transfers', subs: [{ key: 'transfers_create' }, { key: 'transfers_approve' }] },
  { key: 'quotations', subs: [{ key: 'quotations_create' }, { key: 'quotations_approve' }, { key: 'quotations_convert' }] },
  { key: 'accounts', subs: [{ key: 'accounts_create' }, { key: 'accounts_payments' }, { key: 'accounts_writeoff' }] },
  { key: 'crm', subs: [{ key: 'crm_leads' }, { key: 'crm_opportunities' }] },
  { key: 'commissions', subs: [{ key: 'commissions_plans' }, { key: 'commissions_approve' }, { key: 'commissions_pay' }] },
  { key: 'warehouse', subs: [{ key: 'warehouse_bins' }, { key: 'warehouse_assign' }] },
  { key: 'shipping', subs: [{ key: 'shipping_create' }, { key: 'shipping_carriers' }] },
  { key: 'cycle-counts', subs: [{ key: 'cyclecounts_create' }, { key: 'cyclecounts_approve' }] },
  { key: 'branches', subs: [{ key: 'branches_add' }, { key: 'branches_edit' }, { key: 'branches_delete' }] },
  { key: 'security', subs: [{ key: 'security_manage' }, { key: 'security_assign' }] },
  { key: 'promotions', subs: [{ key: 'promotions_create' }, { key: 'promotions_codes' }] },
  { key: 'settings', subs: [{ key: 'settings_company' }, { key: 'settings_tax' }, { key: 'settings_payment' }, { key: 'settings_integrations' }] },
];

// Mirrors App.can()'s bidirectional module<->sub-key check exactly, EXCEPT
// for the no-permissions case: the frontend fails OPEN (`if (!perms) return
// true`) because it only ever runs after a user is already logged in. Here,
// "no permissions object" means "no authenticated employee" — a routine,
// adversarial case — so this fails CLOSED instead. Never change this to
// return true; requireAuth()/requirePermission() below depend on it.
//
// Sub-key resolution: an EXPLICIT value on the sub-key (true or false)
// always wins over the parent module flag — a group with the module checked
// but a specific sub-permission unchecked must be denied that one feature.
// The parent is only consulted as a fallback when the sub-key was never
// configured at all (absent from the stored permissions blob), which keeps
// older security groups working the way they did before a given
// sub-permission existed (e.g. rentals_checkout defaulting on for groups
// saved before that key was introduced).
function can(permissions, key) {
  if (!permissions) return false;
  const mod = PERMISSION_TREE.find(m => m.key === key);
  if (mod) {
    return !!permissions[key] || mod.subs.some(s => !!permissions[s.key]);
  }
  const parent = PERMISSION_TREE.find(m => m.subs.some(s => s.key === key));
  if (parent) {
    if (Object.prototype.hasOwnProperty.call(permissions, key)) return !!permissions[key];
    return !!permissions[parent.key];
  }
  return !!permissions[key];
}

// A request authenticated via API key (req.apiKey, set by lib/apiKeyAuth.js)
// is already authorized by that middleware's own SCOPE_RULES — it never has
// an employee session, so it must bypass the employee-permission checks
// below entirely rather than being rejected for lacking one.
function requireAuth(req, res, next) {
  if (req.apiKey) return next();
  if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requirePermission(key) {
  return (req, res, next) => {
    if (req.apiKey) return next();
    if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
    if (!can(req.employee.permissions, key)) {
      return res.status(403).json({ error: `Missing permission: ${key}` });
    }
    next();
  };
}

// For endpoints reachable from more than one section of the app (e.g.
// categories are managed from both Settings and Inventory) — passes if the
// employee has ANY of the given keys, since the frontend's own gating is
// effectively an OR across those sections too.
function requireAnyPermission(...keys) {
  return (req, res, next) => {
    if (req.apiKey) return next();
    if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
    if (!keys.some(key => can(req.employee.permissions, key))) {
      return res.status(403).json({ error: `Missing permission: one of ${keys.join(', ')}` });
    }
    next();
  };
}

module.exports = { PERMISSION_TREE, can, requireAuth, requirePermission, requireAnyPermission };
