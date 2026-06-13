const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:pos.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let initPromise = null;

async function ensureReady() {
  if (!initPromise) initPromise = _init().catch(e => { initPromise = null; throw e; });
  return initPromise;
}

async function _init() {
  // Create all tables
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      category_id INTEGER REFERENCES categories(id),
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 8.5,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      min_stock INTEGER NOT NULL DEFAULT 5,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_number TEXT UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      loyalty_points INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      pin TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      employee_id INTEGER REFERENCES employees(id),
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      amount_tendered REAL DEFAULT 0,
      change_amount REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      discount_amount REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total REAL NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      description TEXT
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      phone TEXT,
      email TEXT,
      manager TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_number TEXT UNIQUE,
      name TEXT NOT NULL,
      contact_name TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      payment_terms TEXT DEFAULT 'Net 30',
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT UNIQUE NOT NULL,
      supplier_id INTEGER REFERENCES suppliers(id),
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      status TEXT NOT NULL DEFAULT 'draft',
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      notes TEXT,
      expected_date DATE,
      received_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity_ordered INTEGER NOT NULL DEFAULT 1,
      quantity_received INTEGER DEFAULT 0,
      unit_cost REAL NOT NULL,
      total REAL NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS security_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      permissions TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS employee_branches (
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      is_default INTEGER DEFAULT 0,
      PRIMARY KEY (employee_id, branch_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      employee_id INTEGER REFERENCES employees(id),
      branch_id INTEGER REFERENCES branches(id),
      status TEXT NOT NULL DEFAULT 'draft',
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      valid_until DATE,
      notes TEXT,
      converted_to_tx INTEGER REFERENCES transactions(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL REFERENCES quotations(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      discount_amount REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total REAL NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS account_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      employee_id INTEGER REFERENCES employees(id),
      branch_id INTEGER REFERENCES branches(id),
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS branch_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      stock_qty INTEGER NOT NULL DEFAULT 0,
      min_stock INTEGER NOT NULL DEFAULT 5,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, branch_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      branch_id INTEGER REFERENCES branches(id),
      quantity_change INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'adjustment',
      reference TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS branch_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT UNIQUE NOT NULL,
      from_branch_id INTEGER REFERENCES branches(id),
      to_branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      received_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS branch_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL REFERENCES branch_transfers(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity_requested INTEGER NOT NULL DEFAULT 1,
      quantity_received INTEGER DEFAULT 0
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS crm_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_number TEXT UNIQUE NOT NULL,
      company TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      source TEXT DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'new',
      estimated_value REAL DEFAULT 0,
      assigned_to INTEGER REFERENCES employees(id),
      customer_id INTEGER REFERENCES customers(id),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS crm_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opp_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      lead_id INTEGER REFERENCES crm_leads(id),
      customer_id INTEGER REFERENCES customers(id),
      employee_id INTEGER REFERENCES employees(id),
      stage TEXT NOT NULL DEFAULT 'qualification',
      probability INTEGER DEFAULT 50,
      value REAL DEFAULT 0,
      expected_close DATE,
      quote_id INTEGER REFERENCES quotations(id),
      notes TEXT,
      won INTEGER DEFAULT 0,
      won_at DATETIME,
      lost_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS crm_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES crm_leads(id),
      opportunity_id INTEGER REFERENCES crm_opportunities(id),
      customer_id INTEGER REFERENCES customers(id),
      employee_id INTEGER REFERENCES employees(id),
      type TEXT NOT NULL DEFAULT 'task',
      subject TEXT NOT NULL,
      description TEXT,
      due_date DATETIME,
      completed INTEGER DEFAULT 0,
      completed_at DATETIME,
      outcome TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS commission_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'percentage',
      rate REAL DEFAULT 0,
      tiers TEXT,
      apply_to TEXT DEFAULT 'all',
      min_sale_amount REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS employee_commission_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      plan_id INTEGER NOT NULL REFERENCES commission_plans(id),
      effective_from DATE NOT NULL,
      effective_to DATE
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS commission_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      plan_id INTEGER REFERENCES commission_plans(id),
      source_type TEXT NOT NULL DEFAULT 'transaction',
      source_id INTEGER NOT NULL DEFAULT 0,
      source_ref TEXT,
      sale_amount REAL NOT NULL DEFAULT 0,
      commission_rate REAL NOT NULL DEFAULT 0,
      commission_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      period TEXT NOT NULL,
      notes TEXT,
      approved_at DATETIME,
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS warehouse_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      code TEXT,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS storage_bins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id INTEGER REFERENCES warehouse_zones(id),
      branch_id INTEGER REFERENCES branches(id),
      bin_code TEXT UNIQUE NOT NULL,
      description TEXT,
      capacity INTEGER,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS product_bin_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      bin_id INTEGER NOT NULL REFERENCES storage_bins(id),
      branch_id INTEGER REFERENCES branches(id),
      quantity INTEGER NOT NULL DEFAULT 0,
      is_primary INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, bin_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_number TEXT UNIQUE NOT NULL,
      from_branch_id INTEGER REFERENCES branches(id),
      customer_id INTEGER REFERENCES customers(id),
      carrier TEXT,
      tracking_number TEXT,
      ship_date DATE,
      estimated_delivery DATE,
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      shipped_at DATETIME,
      delivered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS shipment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      bin_id INTEGER REFERENCES storage_bins(id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS cycle_count_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_number TEXT UNIQUE NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      scope_type TEXT NOT NULL DEFAULT 'all',
      scope_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      committed_at DATETIME
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS cycle_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES cycle_count_sessions(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT,
      bin_id INTEGER REFERENCES storage_bins(id),
      bin_code TEXT,
      expected_qty INTEGER NOT NULL DEFAULT 0,
      counted_qty INTEGER,
      variance INTEGER DEFAULT 0
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS cash_drawers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS drawer_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drawer_id INTEGER REFERENCES cash_drawers(id),
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      opening_float REAL DEFAULT 0,
      status TEXT DEFAULT 'open',
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS drawer_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES drawer_sessions(id) UNIQUE,
      cash_counted REAL DEFAULT 0,
      card_counted REAL DEFAULT 0,
      check_counted REAL DEFAULT 0,
      gift_card_counted REAL DEFAULT 0,
      credit_counted REAL DEFAULT 0,
      notes TEXT,
      reconciled_by INTEGER REFERENCES employees(id),
      reconciled_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS drawer_employee_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drawer_id INTEGER NOT NULL REFERENCES cash_drawers(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      can_use INTEGER DEFAULT 1,
      can_reconcile INTEGER DEFAULT 0,
      UNIQUE(drawer_id, employee_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'percentage',
      value REAL NOT NULL DEFAULT 0,
      min_purchase REAL DEFAULT 0,
      applies_to TEXT NOT NULL DEFAULT 'all',
      start_date DATE,
      end_date DATE,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS promotion_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      UNIQUE(promotion_id, item_type, item_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS promotion_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL COLLATE NOCASE,
      usage_limit INTEGER DEFAULT NULL,
      times_used INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS po_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL DEFAULT 'other',
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS purchase_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number TEXT UNIQUE NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      department TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      required_date DATE,
      converted_to_po_id INTEGER REFERENCES purchase_orders(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS purchase_request_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_cost REAL DEFAULT 0,
      notes TEXT,
      total REAL DEFAULT 0
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS currency_denominations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL DEFAULT 'USD',
      value REAL NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS reconciliation_note_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL REFERENCES drawer_reconciliations(id) ON DELETE CASCADE,
      denomination_id INTEGER NOT NULL REFERENCES currency_denominations(id),
      quantity INTEGER NOT NULL DEFAULT 0,
      UNIQUE(reconciliation_id, denomination_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT UNIQUE NOT NULL,
      original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      customer_id INTEGER REFERENCES customers(id),
      employee_id INTEGER REFERENCES employees(id),
      branch_id INTEGER REFERENCES branches(id),
      resolution TEXT NOT NULL DEFAULT 'refund',
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'processed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      transaction_item_id INTEGER REFERENCES transaction_items(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      tax_amount REAL DEFAULT 0,
      total REAL NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS product_variation_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      attr_values TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER DEFAULT 0
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS product_variations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sku TEXT UNIQUE NOT NULL,
      barcode TEXT,
      attributes TEXT NOT NULL DEFAULT '{}',
      price REAL,
      price_modifier REAL NOT NULL DEFAULT 0,
      cost REAL,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      min_stock INTEGER NOT NULL DEFAULT 5,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS woo_sync_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      local_id INTEGER NOT NULL,
      woo_id INTEGER NOT NULL,
      last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_type, local_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS woo_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      records_processed INTEGER DEFAULT 0,
      records_created INTEGER DEFAULT 0,
      records_updated INTEGER DEFAULT 0,
      records_failed INTEGER DEFAULT 0,
      error_details TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )` },
  ], 'write');

  // Migrations — each in its own try/catch
  const migrations = [
    'ALTER TABLE employees ADD COLUMN security_group_id INTEGER REFERENCES security_groups(id)',
    'ALTER TABLE employees ADD COLUMN default_branch_id INTEGER REFERENCES branches(id)',
    'ALTER TABLE customers ADD COLUMN credit_limit REAL DEFAULT 0',
    'ALTER TABLE customers ADD COLUMN account_balance REAL DEFAULT 0',
    'ALTER TABLE customers ADD COLUMN credit_enabled INTEGER DEFAULT 0',
    "ALTER TABLE customers ADD COLUMN customer_type TEXT DEFAULT 'cash'",
    'ALTER TABLE customers ADD COLUMN credit_terms_days INTEGER DEFAULT 30',
    'ALTER TABLE customers ADD COLUMN account_blocked INTEGER DEFAULT 0',
    'ALTER TABLE transactions ADD COLUMN branch_id INTEGER REFERENCES branches(id)',
    'ALTER TABLE transactions ADD COLUMN is_credit INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN password TEXT',
    'ALTER TABLE employees ADD COLUMN must_change_password INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)',
    'ALTER TABLE branches ADD COLUMN currency TEXT',
    'ALTER TABLE branches ADD COLUMN is_warehouse INTEGER DEFAULT 0',
    'ALTER TABLE transactions ADD COLUMN drawer_session_id INTEGER REFERENCES drawer_sessions(id)',
    'ALTER TABLE transactions ADD COLUMN voided_by INTEGER REFERENCES employees(id)',
    'ALTER TABLE transactions ADD COLUMN voided_at DATETIME',
    'ALTER TABLE transactions ADD COLUMN promotion_code TEXT',
    'ALTER TABLE transactions ADD COLUMN promotion_name TEXT',
    'ALTER TABLE transaction_items ADD COLUMN variation_id INTEGER REFERENCES product_variations(id)',
    'ALTER TABLE transaction_items ADD COLUMN variation_name TEXT',
    'ALTER TABLE products ADD COLUMN image_path TEXT',
  ];
  for (const sql of migrations) {
    try { await db.execute({ sql, args: [] }); } catch(e) {}
  }

  // Add CRM + commissions permissions to existing security groups
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT id, name, permissions FROM security_groups', args: [] });
    for (const g of groups) {
      const perms = JSON.parse(g.permissions || '{}');
      let changed = false;
      if (!('crm' in perms)) { perms.crm = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (!('commissions' in perms)) { perms.commissions = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (changed) await db.execute({ sql: 'UPDATE security_groups SET permissions = ? WHERE id = ?', args: [JSON.stringify(perms), g.id] });
    }
  } catch(e) {}

  // Add transfers permission to existing security groups that are missing it
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT id, name, permissions FROM security_groups', args: [] });
    for (const g of groups) {
      const perms = JSON.parse(g.permissions || '{}');
      if (!('transfers' in perms)) {
        perms.transfers = g.name === 'Cashier' ? false : true;
        await db.execute({ sql: 'UPDATE security_groups SET permissions = ? WHERE id = ?', args: [JSON.stringify(perms), g.id] });
      }
    }
  } catch(e) {}

  // Add multi_branch_access to existing security groups that are missing it
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT id, name, permissions FROM security_groups', args: [] });
    for (const g of groups) {
      const perms = JSON.parse(g.permissions || '{}');
      if (!('multi_branch_access' in perms)) {
        perms.multi_branch_access = (g.name === 'Administrator' || g.name === 'Manager');
        await db.execute({ sql: 'UPDATE security_groups SET permissions = ? WHERE id = ?', args: [JSON.stringify(perms), g.id] });
      }
    }
  } catch(e) {}

  // Add promotions permission to existing security groups
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT id, name, permissions FROM security_groups', args: [] });
    for (const g of groups) {
      const perms = JSON.parse(g.permissions || '{}');
      if (!('promotions' in perms)) {
        perms.promotions = (g.name === 'Administrator' || g.name === 'Manager');
        await db.execute({ sql: 'UPDATE security_groups SET permissions = ? WHERE id = ?', args: [JSON.stringify(perms), g.id] });
      }
    }
  } catch(e) {}

  // Add purchase_requests permission to existing security groups
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT id, name, permissions FROM security_groups', args: [] });
    for (const g of groups) {
      const perms = JSON.parse(g.permissions || '{}');
      if (!('purchase_requests' in perms)) {
        perms.purchase_requests = g.name !== 'Cashier';
        await db.execute({ sql: 'UPDATE security_groups SET permissions = ? WHERE id = ?', args: [JSON.stringify(perms), g.id] });
      }
    }
  } catch(e) {}

  // Add warehouse / shipping / cycle-counts permissions to existing security groups
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT id, name, permissions FROM security_groups', args: [] });
    for (const g of groups) {
      const perms = JSON.parse(g.permissions || '{}');
      let changed = false;
      if (!('warehouse' in perms)) { perms.warehouse = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (!('shipping' in perms)) { perms.shipping = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (!('cycle-counts' in perms)) { perms['cycle-counts'] = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (!('drawers' in perms)) { perms.drawers = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (!('void_transactions' in perms)) { perms.void_transactions = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (!('process_returns' in perms)) { perms.process_returns = (g.name === 'Administrator' || g.name === 'Manager'); changed = true; }
      if (changed) await db.execute({ sql: 'UPDATE security_groups SET permissions = ? WHERE id = ?', args: [JSON.stringify(perms), g.id] });
    }
  } catch(e) {}

  // Set default admin password on first run
  try {
    const { rows: [adminEmp] } = await db.execute({ sql: 'SELECT id, password FROM employees WHERE username = ?', args: ['admin'] });
    if (adminEmp && !adminEmp.password) {
      await db.execute({ sql: 'UPDATE employees SET password = ?, must_change_password = 1 WHERE username = ?', args: ['123456', 'admin'] });
    }
  } catch(e) {}

  // Initialize branch_inventory for branch 1 for products with global stock but no branch records
  try {
    await db.execute({ sql: `INSERT OR IGNORE INTO branch_inventory (product_id, branch_id, stock_qty, min_stock)
      SELECT p.id, 1, p.stock_qty, p.min_stock FROM products p
      WHERE p.stock_qty > 0 AND NOT EXISTS (SELECT 1 FROM branch_inventory WHERE product_id = p.id)`, args: [] });
  } catch(e) {}

  // Seed branches
  const { rows: [branchCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM branches', args: [] });
  if (Number(branchCount.c) === 0) {
    await db.execute({ sql: 'INSERT INTO branches (branch_code, name, address, city, state, zip, phone, manager) VALUES (?,?,?,?,?,?,?,?)', args: ['BR-001','Main Store','100 Commerce Way','Springfield','IL','62701','(217) 555-0100','Admin User'] });
    await db.execute({ sql: 'INSERT INTO branches (branch_code, name, address, city, state, zip, phone, manager) VALUES (?,?,?,?,?,?,?,?)', args: ['BR-002','North Branch','250 Oak Ave','Springfield','IL','62702','(217) 555-0200','Jane Doe'] });
  }

  // Seed suppliers
  const { rows: [supplierCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM suppliers', args: [] });
  if (Number(supplierCount.c) === 0) {
    await db.execute({ sql: 'INSERT INTO suppliers (supplier_number,name,contact_name,email,phone,address,city,state,zip,payment_terms) VALUES (?,?,?,?,?,?,?,?,?,?)', args: ['SUP-0001','TechSupply Co','Mark Johnson','orders@techsupply.com','555-9001','1 Tech Park','Chicago','IL','60601','Net 30'] });
    await db.execute({ sql: 'INSERT INTO suppliers (supplier_number,name,contact_name,email,phone,address,city,state,zip,payment_terms) VALUES (?,?,?,?,?,?,?,?,?,?)', args: ['SUP-0002','Fashion World','Lisa Chen','buying@fashionworld.com','555-9002','22 Style Ave','New York','NY','10001','Net 15'] });
    await db.execute({ sql: 'INSERT INTO suppliers (supplier_number,name,contact_name,email,phone,address,city,state,zip,payment_terms) VALUES (?,?,?,?,?,?,?,?,?,?)', args: ['SUP-0003','FoodCo Distributors','Tom Green','sales@foodco.com','555-9003','5 Harvest Rd','Joliet','IL','60431','Net 30'] });
  }

  // Seed security groups
  const { rows: [sgCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM security_groups', args: [] });
  if (Number(sgCount.c) === 0) {
    await db.execute({ sql: 'INSERT INTO security_groups (name, description, permissions) VALUES (?,?,?)', args: ['Administrator','Full system access',JSON.stringify({dashboard:true,pos:true,inventory:true,customers:true,transactions:true,reports:true,employees:true,settings:true,purchasing:true,branches:true,security:true,accounts:true,quotations:true,suppliers:true,transfers:true,crm:true,commissions:true,multi_branch_access:true,warehouse:true,shipping:true,'cycle-counts':true,drawers:true,void_transactions:true,promotions:true,process_returns:true,purchase_requests:true})] });
    await db.execute({ sql: 'INSERT INTO security_groups (name, description, permissions) VALUES (?,?,?)', args: ['Cashier','POS and basic operations',JSON.stringify({dashboard:true,pos:true,inventory:false,customers:true,transactions:true,reports:false,employees:false,settings:false,purchasing:false,branches:false,security:false,accounts:false,quotations:true,suppliers:false,transfers:false,crm:false,commissions:false,multi_branch_access:false,warehouse:false,shipping:false,'cycle-counts':false,drawers:false,void_transactions:false,promotions:false,process_returns:false,purchase_requests:false})] });
    await db.execute({ sql: 'INSERT INTO security_groups (name, description, permissions) VALUES (?,?,?)', args: ['Manager','Store management without admin',JSON.stringify({dashboard:true,pos:true,inventory:true,customers:true,transactions:true,reports:true,employees:true,settings:false,purchasing:true,branches:false,security:false,accounts:true,quotations:true,suppliers:true,transfers:true,crm:true,commissions:true,multi_branch_access:true,warehouse:true,shipping:true,'cycle-counts':true,drawers:true,void_transactions:true,promotions:true,process_returns:true,purchase_requests:true})] });

    // Assign to existing employees
    try {
      const { rows: [br1] } = await db.execute({ sql: 'SELECT id FROM branches WHERE branch_code = ?', args: ['BR-001'] });
      const { rows: [br2] } = await db.execute({ sql: 'SELECT id FROM branches WHERE branch_code = ?', args: ['BR-002'] });
      const { rows: [sg1] } = await db.execute({ sql: 'SELECT id FROM security_groups WHERE name = ?', args: ['Administrator'] });
      const { rows: [sg2] } = await db.execute({ sql: 'SELECT id FROM security_groups WHERE name = ?', args: ['Cashier'] });
      const { rows: [sg3] } = await db.execute({ sql: 'SELECT id FROM security_groups WHERE name = ?', args: ['Manager'] });
      if (br1 && sg1) {
        await db.execute({ sql: 'UPDATE employees SET default_branch_id = ?, security_group_id = ? WHERE username = ?', args: [br1.id, sg1.id, 'admin'] });
        await db.execute({ sql: 'UPDATE employees SET default_branch_id = ?, security_group_id = ? WHERE username = ?', args: [br1.id, sg2.id, 'jdoe'] });
      }
      if (br2 && sg3) {
        await db.execute({ sql: 'UPDATE employees SET default_branch_id = ?, security_group_id = ? WHERE username = ?', args: [br2.id, sg3.id, 'bsmith'] });
      }
      if (br1) {
        const { rows: [adm] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username = ?', args: ['admin'] });
        const { rows: [jdoe] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username = ?', args: ['jdoe'] });
        const { rows: [bsmith] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username = ?', args: ['bsmith'] });
        if (adm) await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [adm.id, br1.id] });
        if (jdoe) await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [jdoe.id, br1.id] });
        if (br2 && bsmith) await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [bsmith.id, br2.id] });
      }
    } catch(e) {}
  }

  // Seed categories and products
  const { rows: [catCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM categories', args: [] });
  if (Number(catCount.c) === 0) {
    await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: ['Electronics', 'Electronic devices and accessories'] });
    await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: ['Clothing', 'Apparel and accessories'] });
    await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: ['Food & Beverage', 'Food and drink items'] });
    await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: ['Home & Garden', 'Home improvement and garden supplies'] });
    await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: ['Sports & Outdoors', 'Sports equipment and outdoor gear'] });
    await db.execute({ sql: 'INSERT INTO categories (name, description) VALUES (?, ?)', args: ['Toys & Games', 'Toys, games, and entertainment'] });

    const pSql = 'INSERT INTO products (sku,barcode,name,description,category_id,price,cost,tax_rate,stock_qty,min_stock) VALUES (?,?,?,?,?,?,?,?,?,?)';
    // Electronics (category_id=1)
    await db.execute({ sql: pSql, args: ['ELEC-001','001001','Wireless Headphones','Premium over-ear headphones',1,79.99,35.00,8.5,25,5] });
    await db.execute({ sql: pSql, args: ['ELEC-002','001002','USB-C Cable 6ft','Fast charging cable',1,14.99,4.50,8.5,50,10] });
    await db.execute({ sql: pSql, args: ['ELEC-003','001003','Phone Case','Protective phone case',1,19.99,6.00,8.5,40,10] });
    await db.execute({ sql: pSql, args: ['ELEC-004','001004','Portable Charger 10000mAh','High capacity power bank',1,39.99,15.00,8.5,20,5] });
    await db.execute({ sql: pSql, args: ['ELEC-005','001005','Bluetooth Speaker','Waterproof portable speaker',1,59.99,22.00,8.5,15,5] });
    await db.execute({ sql: pSql, args: ['ELEC-006','001006','Smart Watch','Fitness tracking smartwatch',1,129.99,55.00,8.5,10,3] });
    // Clothing (category_id=2)
    await db.execute({ sql: pSql, args: ['CLTH-001','002001','T-Shirt Small','Cotton t-shirt - Small',2,24.99,8.00,8.5,30,10] });
    await db.execute({ sql: pSql, args: ['CLTH-002','002002','T-Shirt Medium','Cotton t-shirt - Medium',2,24.99,8.00,8.5,40,10] });
    await db.execute({ sql: pSql, args: ['CLTH-003','002003','T-Shirt Large','Cotton t-shirt - Large',2,24.99,8.00,8.5,35,10] });
    await db.execute({ sql: pSql, args: ['CLTH-004','002004','Jeans Regular','Classic denim jeans',2,59.99,22.00,8.5,20,5] });
    await db.execute({ sql: pSql, args: ['CLTH-005','002005','Baseball Cap','Adjustable cap',2,19.99,6.00,8.5,25,8] });
    await db.execute({ sql: pSql, args: ['CLTH-006','002006','Hoodie Medium','Fleece hoodie',2,44.99,16.00,8.5,18,5] });
    // Food & Beverage (category_id=3)
    await db.execute({ sql: pSql, args: ['FOOD-001','003001','Coffee Beans 1lb','Premium roasted beans',3,12.99,5.50,0,30,10] });
    await db.execute({ sql: pSql, args: ['FOOD-002','003002','Green Tea 20ct','Organic tea bags',3,7.99,3.00,0,45,15] });
    await db.execute({ sql: pSql, args: ['FOOD-003','003003','Dark Chocolate Bar','70% cacao chocolate',3,4.99,1.80,0,60,20] });
    await db.execute({ sql: pSql, args: ['FOOD-004','003004','Mixed Nuts 8oz','Premium mixed nuts',3,9.99,4.00,0,25,10] });
    await db.execute({ sql: pSql, args: ['FOOD-005','003005','Energy Drink 12oz','Natural energy drink',3,3.49,1.20,0,80,20] });
    await db.execute({ sql: pSql, args: ['FOOD-006','003006','Granola Bar','Oat and honey bar',3,2.49,0.90,0,100,25] });
    // Home & Garden (category_id=4)
    await db.execute({ sql: pSql, args: ['HOME-001','004001','Scented Candle','Soy wax candle',4,16.99,5.50,8.5,35,10] });
    await db.execute({ sql: pSql, args: ['HOME-002','004002','Ceramic Plant Pot','6 inch pot',4,12.99,4.50,8.5,20,5] });
    await db.execute({ sql: pSql, args: ['HOME-003','004003','Dish Soap 16oz','Eco-friendly soap',4,5.99,2.00,0,40,15] });
    await db.execute({ sql: pSql, args: ['HOME-004','004004','Picture Frame 5x7','Wooden frame',4,14.99,5.00,8.5,25,8] });
    await db.execute({ sql: pSql, args: ['HOME-005','004005','Throw Pillow 18x18','Decorative pillow',4,22.99,8.50,8.5,15,5] });
    // Sports (category_id=5)
    await db.execute({ sql: pSql, args: ['SPRT-001','005001','Water Bottle 32oz','Insulated steel bottle',5,29.99,10.00,8.5,30,10] });
    await db.execute({ sql: pSql, args: ['SPRT-002','005002','Resistance Bands Set','Set of 5 bands',5,24.99,8.50,8.5,20,5] });
    await db.execute({ sql: pSql, args: ['SPRT-003','005003','Jump Rope','Adjustable speed rope',5,14.99,5.00,8.5,25,8] });
    await db.execute({ sql: pSql, args: ['SPRT-004','005004','Yoga Mat','Non-slip yoga mat',5,34.99,12.00,8.5,12,4] });
    // Toys & Games (category_id=6)
    await db.execute({ sql: pSql, args: ['TOYS-001','006001','Building Blocks 50pc','Colorful blocks',6,19.99,7.50,8.5,20,5] });
    await db.execute({ sql: pSql, args: ['TOYS-002','006002','Family Card Game','Fun card game',6,14.99,5.50,8.5,15,5] });
    await db.execute({ sql: pSql, args: ['TOYS-003','006003','Jigsaw Puzzle 500pc','500 piece puzzle',6,17.99,6.50,8.5,12,5] });

    // Customers
    const cSql = 'INSERT INTO customers (customer_number,first_name,last_name,email,phone,address,city,state,zip,loyalty_points,total_spent) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
    await db.execute({ sql: cSql, args: ['CUST-0001','John','Smith','john.smith@email.com','555-0101','123 Main St','Springfield','IL','62701',250,125.00] });
    await db.execute({ sql: cSql, args: ['CUST-0002','Sarah','Johnson','sarah.j@email.com','555-0102','456 Oak Ave','Springfield','IL','62702',180,90.00] });
    await db.execute({ sql: cSql, args: ['CUST-0003','Michael','Brown','mbrown@email.com','555-0103','789 Pine Rd','Chicago','IL','60601',420,210.00] });
    await db.execute({ sql: cSql, args: ['CUST-0004','Emily','Davis','emily.d@email.com','555-0104','321 Elm St','Naperville','IL','60540',75,37.50] });
    await db.execute({ sql: cSql, args: ['CUST-0005','Robert','Wilson','rwilson@email.com','555-0105','654 Maple Dr','Joliet','IL','60431',310,155.00] });

    // Employees
    const eSql = 'INSERT INTO employees (employee_number,first_name,last_name,username,pin,role) VALUES (?,?,?,?,?,?)';
    await db.execute({ sql: eSql, args: ['EMP-0001','Admin','User','admin','1234','admin'] });
    await db.execute({ sql: eSql, args: ['EMP-0002','Jane','Doe','jdoe','5678','cashier'] });
    await db.execute({ sql: eSql, args: ['EMP-0003','Bob','Smith','bsmith','9012','cashier'] });

    // Settings
    const sSql = 'INSERT INTO settings (key, value, description) VALUES (?, ?, ?)';
    await db.execute({ sql: sSql, args: ['store_name','My Retail Store','Store name on receipts'] });
    await db.execute({ sql: sSql, args: ['store_address','100 Commerce Way, Springfield, IL 62701','Store address'] });
    await db.execute({ sql: sSql, args: ['store_phone','(217) 555-0100','Store phone'] });
    await db.execute({ sql: sSql, args: ['store_email','store@myretail.com','Store email'] });
    await db.execute({ sql: sSql, args: ['tax_rate','8.5','Default tax rate %'] });
    await db.execute({ sql: sSql, args: ['currency','USD','Currency code'] });
    await db.execute({ sql: sSql, args: ['receipt_footer','Thank you for shopping with us!','Receipt footer'] });
    await db.execute({ sql: sSql, args: ['loyalty_rate','0.5','Loyalty points per dollar'] });

    // Seed some past transactions
    const today = new Date();
    const txData = [
      { offset: 0, cid: 1, total: 94.98, method: 'card' },
      { offset: 0, cid: 2, total: 39.99, method: 'cash' },
      { offset: 0, cid: null, total: 25.47, method: 'cash' },
      { offset: 1, cid: 3, total: 149.97, method: 'card' },
      { offset: 1, cid: null, total: 17.48, method: 'cash' },
      { offset: 1, cid: 4, total: 59.99, method: 'card' },
      { offset: 2, cid: 5, total: 84.97, method: 'cash' },
      { offset: 2, cid: 1, total: 44.98, method: 'card' },
      { offset: 3, cid: 2, total: 29.99, method: 'cash' },
      { offset: 3, cid: null, total: 12.97, method: 'cash' },
      { offset: 4, cid: 3, total: 189.98, method: 'card' },
      { offset: 4, cid: null, total: 34.97, method: 'card' },
      { offset: 5, cid: 4, total: 54.98, method: 'cash' },
      { offset: 6, cid: 5, total: 79.99, method: 'card' },
    ];

    const txSql = 'INSERT INTO transactions (transaction_number, customer_id, employee_id, subtotal, tax_amount, discount_amount, total, payment_method, amount_tendered, change_amount, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
    const txiSql = 'INSERT INTO transaction_items (transaction_id, product_id, product_name, sku, quantity, unit_price, discount_amount, tax_amount, total) VALUES (?,?,?,?,?,?,?,?,?)';

    for (let i = 0; i < txData.length; i++) {
      const tx = txData[i];
      const d = new Date(today);
      d.setDate(d.getDate() - tx.offset);
      d.setHours(9 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60));
      const txNum = `TXN-${String(1000 + i).padStart(6,'0')}`;
      const tax = parseFloat((tx.total * 0.085).toFixed(2));
      const subtotal = parseFloat((tx.total - tax).toFixed(2));
      const tendered = tx.method === 'cash' ? Math.ceil(tx.total / 5) * 5 : tx.total;
      const txResult = await db.execute({ sql: txSql, args: [txNum, tx.cid, 1, subtotal, tax, 0, tx.total, tx.method, tendered, parseFloat((tendered - tx.total).toFixed(2)), 'completed', d.toISOString()] });
      const txId = Number(txResult.lastInsertRowid);
      const pid = (i % 28) + 1;
      const { rows: [prod] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [pid] });
      if (prod) {
        const qty = 1 + (i % 2);
        const lineTotal = parseFloat((prod.price * qty).toFixed(2));
        const lineTax = parseFloat((lineTotal * prod.tax_rate / 100).toFixed(2));
        await db.execute({ sql: txiSql, args: [txId, prod.id, prod.name, prod.sku, qty, prod.price, 0, lineTax, lineTotal] });
      }
    }
  }

  // Seed commission plans and demo records
  const { rows: [commPlanCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM commission_plans', args: [] });
  if (Number(commPlanCount.c) === 0) {
    try {
      const cpSql = 'INSERT INTO commission_plans (name,type,rate,tiers,apply_to,min_sale_amount,notes) VALUES (?,?,?,?,?,?,?)';
      const p1r = await db.execute({ sql: cpSql, args: ['Standard 5% Commission','percentage',5,null,'all',0,'5% on all sales — standard plan for sales staff'] });
      const p2r = await db.execute({ sql: cpSql, args: ['Tiered Performance Plan','tiered',0,JSON.stringify([{min:0,max:5000,rate:3},{min:5000,max:15000,rate:5},{min:15000,max:null,rate:7}]),'all',0,'3% up to $5k, 5% $5k-$15k, 7% above $15k per month'] });
      const p3r = await db.execute({ sql: cpSql, args: ['CRM Deals Only — 8%','percentage',8,null,'crm',500,'8% on won CRM opportunities over $500'] });
      const p4r = await db.execute({ sql: cpSql, args: ['Flat $2 Per Transaction','flat',2,null,'pos',0,'$2 per POS transaction, no minimum'] });
      const p1Id = Number(p1r.lastInsertRowid);
      const p2Id = Number(p2r.lastInsertRowid);
      const p4Id = Number(p4r.lastInsertRowid);

      const { rows: [adminRow] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username=?', args: ['admin'] });
      const { rows: [jdoeRow] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username=?', args: ['jdoe'] });
      const { rows: [bsmithRow] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username=?', args: ['bsmith'] });
      const adminId = adminRow?.id;
      const jdoeId = jdoeRow?.id;
      const bsmithId = bsmithRow?.id;

      const iaSql = 'INSERT INTO employee_commission_plans (employee_id,plan_id,effective_from) VALUES (?,?,?)';
      if (adminId)  await db.execute({ sql: iaSql, args: [adminId,  p1Id, '2026-01-01'] });
      if (jdoeId)   await db.execute({ sql: iaSql, args: [jdoeId,   p2Id, '2026-01-01'] });
      if (bsmithId) await db.execute({ sql: iaSql, args: [bsmithId, p4Id, '2026-01-01'] });

      const period = new Date().toISOString().slice(0,7);
      const irSql = 'INSERT INTO commission_records (employee_id,plan_id,source_type,source_id,source_ref,sale_amount,commission_rate,commission_amount,status,period) VALUES (?,?,?,?,?,?,?,?,?,?)';
      if (adminId) {
        await db.execute({ sql: irSql, args: [adminId, p1Id, 'transaction', 1, 'TXN-001000', 94.98, 5, 4.75, 'approved', period] });
        await db.execute({ sql: irSql, args: [adminId, p1Id, 'transaction', 4, 'TXN-001003', 149.97, 5, 7.50, 'pending', period] });
        await db.execute({ sql: irSql, args: [adminId, p1Id, 'opportunity', 1, 'OPP-00001', 4500, 5, 225.00, 'pending', period] });
      }
      if (jdoeId) {
        await db.execute({ sql: irSql, args: [jdoeId, p2Id, 'transaction', 2, 'TXN-001001', 39.99, 3, 1.20, 'paid', period] });
        await db.execute({ sql: irSql, args: [jdoeId, p2Id, 'transaction', 3, 'TXN-001002', 25.47, 3, 0.76, 'paid', period] });
        await db.execute({ sql: irSql, args: [jdoeId, p2Id, 'quotation', 1, 'QT-000001', 2200, 3, 66.00, 'approved', period] });
      }
      if (bsmithId) {
        await db.execute({ sql: irSql, args: [bsmithId, p4Id, 'transaction', 7, 'TXN-001006', 84.97, 0, 2.00, 'pending', period] });
        await db.execute({ sql: irSql, args: [bsmithId, p4Id, 'transaction', 8, 'TXN-001007', 44.98, 0, 2.00, 'paid', period] });
      }
    } catch(e) {}
  }

  // Seed CRM demo data
  const { rows: [crmCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM crm_leads', args: [] });
  if (Number(crmCount.c) === 0) {
    try {
      const { rows: [empRow] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username = ?', args: ['admin'] });
      const { rows: [emp2Row] } = await db.execute({ sql: 'SELECT id FROM employees WHERE username = ?', args: ['jdoe'] });
      const empId = empRow?.id || 1;
      const emp2Id = emp2Row?.id || 2;

      const lSql = 'INSERT INTO crm_leads (lead_number,company,first_name,last_name,email,phone,source,status,estimated_value,assigned_to,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
      const r1 = await db.execute({ sql: lSql, args: ['LEAD-00001','TechCorp Inc','Alice','Taylor','alice@techcorp.com','555-1001','referral','qualified',4500,empId,'Interested in bulk electronics order. Meeting scheduled.'] });
      const r2 = await db.execute({ sql: lSql, args: ['LEAD-00002','StyleHouse','Carlos','Martinez','carlos@stylehouse.com','555-1002','trade_show','proposal',2200,emp2Id,'Attended spring trade show. Sent initial quote.'] });
      const r3 = await db.execute({ sql: lSql, args: ['LEAD-00003','GreenLeaf Co','Nina','Patel','nina@greenleaf.com','555-1003','website','contacted',1500,empId,'Website inquiry for home goods. Follow up pending.'] });
      const r4 = await db.execute({ sql: lSql, args: ['LEAD-00004','SportZone','Derek','Hughes','derek@sportzone.com','555-1004','cold_call','new',3000,emp2Id,'Cold call lead. Has a chain of 3 sporting goods stores.'] });
      const r5 = await db.execute({ sql: lSql, args: ['LEAD-00005','FoodFirst','Maria','Chen','maria@foodfirst.com','555-1005','referral','negotiation',8000,empId,'Referred by John Smith. Negotiating pricing on F&B items.'] });
      const r1Id = Number(r1.lastInsertRowid);
      const r2Id = Number(r2.lastInsertRowid);
      const r3Id = Number(r3.lastInsertRowid);
      const r4Id = Number(r4.lastInsertRowid);
      const r5Id = Number(r5.lastInsertRowid);

      const oSql = 'INSERT INTO crm_opportunities (opp_number,title,lead_id,employee_id,stage,probability,value,expected_close,notes) VALUES (?,?,?,?,?,?,?,?,?)';
      const o1 = await db.execute({ sql: oSql, args: ['OPP-00001','TechCorp Electronics Bulk Order',r1Id,empId,'proposal',65,4500,new Date(Date.now()+14*86400000).toISOString().split('T')[0],'Proposal for 50 units smart watches and accessories'] });
      const o2 = await db.execute({ sql: oSql, args: ['OPP-00002','StyleHouse Apparel Contract',r2Id,emp2Id,'negotiation',80,2200,new Date(Date.now()+7*86400000).toISOString().split('T')[0],'Quarterly clothing supply agreement'] });
      const o3 = await db.execute({ sql: oSql, args: ['OPP-00003','FoodFirst F&B Supply Deal',r5Id,empId,'negotiation',75,8000,new Date(Date.now()+5*86400000).toISOString().split('T')[0],'Monthly supply of coffee, snacks, and beverages'] });
      const o1Id = Number(o1.lastInsertRowid);
      const o2Id = Number(o2.lastInsertRowid);
      const o3Id = Number(o3.lastInsertRowid);

      const aSql = 'INSERT INTO crm_activities (lead_id,opportunity_id,employee_id,type,subject,description,due_date,completed) VALUES (?,?,?,?,?,?,?,?)';
      const tomorrow = new Date(Date.now()+86400000).toISOString();
      const inTwoDays = new Date(Date.now()+2*86400000).toISOString();
      const inFiveDays = new Date(Date.now()+5*86400000).toISOString();
      const yesterday = new Date(Date.now()-86400000).toISOString();
      await db.execute({ sql: aSql, args: [r1Id, o1Id, empId,'call','Follow-up call with Alice Taylor','Discuss proposal details and answer questions',tomorrow,0] });
      await db.execute({ sql: aSql, args: [r2Id, o2Id, emp2Id,'meeting','Negotiation meeting - StyleHouse','Review final pricing terms',inTwoDays,0] });
      await db.execute({ sql: aSql, args: [r3Id, null, empId,'email','Send product catalog to GreenLeaf','Email home goods catalog with pricing',tomorrow,0] });
      await db.execute({ sql: aSql, args: [r4Id, null, emp2Id,'call','Initial discovery call - SportZone','Understand their needs and volume requirements',inFiveDays,0] });
      await db.execute({ sql: aSql, args: [r5Id, o3Id, empId,'meeting','Price negotiation - FoodFirst','Final price review meeting',new Date(Date.now()+3*86400000).toISOString(),0] });
      await db.execute({ sql: aSql, args: [r1Id, null, empId,'call','Initial contact - TechCorp','Introduced our product range',yesterday,1] });
    } catch(e) {}
  }

  // Seed default USD denominations
  const { rows: [denomCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM currency_denominations', args: [] });
  if (Number(denomCount.c) === 0) {
    const dSql = 'INSERT INTO currency_denominations (currency, value, label, sort_order) VALUES (?,?,?,?)';
    const usd = [
      ['USD', 100, '$100', 1], ['USD', 50, '$50', 2], ['USD', 20, '$20', 3],
      ['USD', 10, '$10', 4],   ['USD', 5,  '$5',  5], ['USD', 2,  '$2',  6],
      ['USD', 1,  '$1',  7],   ['USD', 0.50, '50¢', 8], ['USD', 0.25, '25¢', 9],
      ['USD', 0.10, '10¢', 10], ['USD', 0.05, '5¢', 11], ['USD', 0.01, '1¢', 12],
    ];
    for (const [cur, val, lbl, ord] of usd) {
      await db.execute({ sql: dSql, args: [cur, val, lbl, ord] });
    }
  }
}

module.exports = { db, ensureReady };
