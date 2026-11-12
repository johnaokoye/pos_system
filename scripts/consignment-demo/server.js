// Consignment demo server (Phase 5): its own seeded database in
// <tmp>/pos-consignment-demo, port 3201, consignment switched on. Never :3001 /
// pos.db. Usage: node scripts/consignment-demo/server.js fresh   (then demo.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const repo = path.resolve(__dirname, '../..');
const dir = path.join(os.tmpdir(), 'pos-consignment-demo');
fs.mkdirSync(dir, { recursive: true });
if (process.argv[2] === 'fresh') for (const f of fs.readdirSync(dir)) if (/^demo\.db/.test(f)) fs.rmSync(path.join(dir, f));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'demo.db')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.PORT = '3201';
process.env.CONSIGNMENT_ENABLED = '1';
process.chdir(repo);
const { ensureReady, db } = require(path.join(repo, 'database'));
(async () => {
  await ensureReady();
  await db.execute("UPDATE employees SET must_change_password = 0 WHERE username = 'admin'");
  require(path.join(repo, 'server'));
})().catch(e => { console.error(e); process.exit(1); });
