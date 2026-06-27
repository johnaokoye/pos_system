require('dotenv').config();
const { createClient } = require('@libsql/client');

const local = createClient({ url: 'file:pos.db' });
const remote = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function getTableNames(client) {
  const res = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY name"
  );
  return res.rows.map(r => r.name);
}

async function getCreateSql(name) {
  const res = await local.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
    [name]
  );
  return res.rows[0]?.sql;
}

// Tables in FK-safe insertion order (matches database.js creation order)
const TABLE_ORDER = [
  'categories', 'products', 'customers', 'employees', 'transactions',
  'transaction_items', 'settings', 'branches', 'suppliers', 'purchase_orders',
  'purchase_order_items', 'security_groups', 'employee_branches', 'quotations',
  'quotation_items', 'account_payments', 'branch_inventory', 'stock_movements',
  'branch_transfers', 'branch_transfer_items', 'crm_leads', 'crm_opportunities',
  'crm_activities', 'commission_plans', 'employee_commission_plans',
  'commission_records', 'warehouse_zones', 'storage_bins', 'product_bin_assignments',
  'shipments', 'shipment_items', 'cycle_count_sessions', 'cycle_count_items',
  'cash_drawers', 'drawer_sessions', 'drawer_reconciliations', 'drawer_employee_access',
  'promotions', 'promotion_items', 'promotion_codes', 'po_attachments',
  'purchase_requests', 'purchase_request_items', 'currency_denominations',
  'reconciliation_note_counts', 'returns', 'return_items', 'product_variation_types',
  'product_variations', 'woo_sync_map', 'woo_sync_log',
];

async function migrate() {
  console.log('Reading local schema...');
  const localTables = await getTableNames(local);
  const remoteTables = new Set(await getTableNames(remote));
  console.log(`Local: ${localTables.length} tables, Remote: ${remoteTables.size} tables\n`);

  // Use TABLE_ORDER for known tables, append any extras at the end
  const orderedTables = [
    ...TABLE_ORDER.filter(t => localTables.includes(t)),
    ...localTables.filter(t => !TABLE_ORDER.includes(t)),
  ];

  // Create any tables missing from Turso
  const missing = orderedTables.filter(t => !remoteTables.has(t));
  if (missing.length > 0) {
    console.log(`Creating ${missing.length} missing tables in Turso...`);
    for (const table of missing) {
      let sql = await getCreateSql(table);
      if (!sql) continue;
      // Ensure CREATE TABLE IF NOT EXISTS
      sql = sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ');
      await remote.execute(sql);
      console.log(`  created ${table}`);
    }
    console.log();
  }

  // Disable FK checks on remote
  await remote.execute('PRAGMA foreign_keys = OFF');

  // Clear all remote tables in reverse dependency order
  console.log('Clearing remote tables...');
  for (const table of [...orderedTables].reverse()) {
    try {
      await remote.execute(`DELETE FROM "${table}"`);
      process.stdout.write(`  cleared ${table}\n`);
    } catch (e) {
      console.warn(`  warning: could not clear ${table}: ${e.message}`);
    }
  }

  // Copy data in FK-safe insertion order
  console.log('\nCopying data...');
  for (const table of orderedTables) {
    const res = await local.execute(`SELECT * FROM "${table}"`);
    const rows = res.rows;

    if (rows.length === 0) {
      console.log(`  ${table}: 0 rows (skipped)`);
      continue;
    }

    const cols = res.columns;
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

    // Batch in chunks of 50 to stay within Turso limits
    const CHUNK = 50;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const statements = chunk.map(row => ({
        sql,
        args: cols.map(c => row[c] ?? null),
      }));
      try {
        await remote.batch(statements, 'write');
        inserted += chunk.length;
      } catch (e) {
        console.error(`  error inserting into ${table} at row ${i}: ${e.message}`);
        throw e;
      }
    }

    console.log(`  ${table}: ${inserted} rows copied`);
  }

  await remote.execute('PRAGMA foreign_keys = ON');
  console.log('\nMigration complete!');
}

migrate().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
