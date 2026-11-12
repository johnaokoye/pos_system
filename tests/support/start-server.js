// The server Playwright tests run against: a throwaway database and its own
// port, never :3001 (which holds real data). Rebuilt from the seed on every run.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(os.tmpdir(), 'pos-playwright');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// Set before anything loads .env: dotenv leaves variables that already exist alone.
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.PORT = process.env.POS_TEST_PORT;
// Consignment is built in phases and switched off elsewhere until selling is
// in place (lib/stockLots.js); the tests run it.
process.env.CONSIGNMENT_ENABLED = '1';

const { ensureReady, db } = require('../../database');

(async () => {
  await ensureReady();
  // Skip the forced first-login password change.
  // A saved signature lets tests approve without writing a file into uploads/.
  await db.execute("UPDATE employees SET must_change_password = 0, approval_signature = '/uploads/approval-signatures/test.png' WHERE username = 'admin'");
  // A new database's seed leaves these keys off the Administrator group.
  await db.execute("UPDATE security_groups SET permissions = json_set(permissions, '$.sales_manager', json('true'), '$.pos_receive_payment', json('true'), '$.drawers_close', json('true')) WHERE name = 'Administrator'");
  // The seed fills branch_inventory before it adds the demo products, so a new
  // database has none at any branch, and POS shows everything out of stock.
  await db.execute(`INSERT OR IGNORE INTO branch_inventory (product_id, branch_id, stock_qty, min_stock)
    SELECT p.id, 1, p.stock_qty, p.min_stock FROM products p WHERE p.stock_qty > 0`);
  require('../../server');
})().catch(e => { console.error(e); process.exit(1); });
