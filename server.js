require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const { ensureReady, db } = require('./database');
const { router: woocommerceRouter, runSyncAll: wooSyncAll } = require('./routes/woocommerce');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize DB before handling any request
app.use(async (req, res, next) => {
  try { await ensureReady(); next(); } catch(e) { res.status(500).json({ error: 'Database initialization failed' }); }
});

app.use('/api/products',         require('./routes/products'));
app.use('/api/categories',       require('./routes/categories'));
app.use('/api/customers',        require('./routes/customers'));
app.use('/api/transactions',     require('./routes/transactions'));
app.use('/api/employees',        require('./routes/employees'));
app.use('/api/reports',          require('./routes/reports'));
app.use('/api/settings',         require('./routes/settings'));
app.use('/api/branches',         require('./routes/branches'));
app.use('/api/suppliers',        require('./routes/suppliers'));
app.use('/api/purchase-orders',   require('./routes/purchase-orders'));
app.use('/api/purchase-requests', require('./routes/purchase-requests'));
app.use('/api/security-groups',  require('./routes/security-groups'));
app.use('/api/quotations',       require('./routes/quotations'));
app.use('/api/accounts',         require('./routes/accounts'));
app.use('/api/transfers',        require('./routes/transfers'));
app.use('/api/crm',              require('./routes/crm'));
app.use('/api/commissions',      require('./routes/commissions'));
app.use('/api/email',           require('./routes/email'));
app.use('/api/warehouse',       require('./routes/warehouse'));
app.use('/api/drawers',         require('./routes/drawers'));
app.use('/api/promotions',      require('./routes/promotions'));
app.use('/api/denominations',   require('./routes/denominations'));
app.use('/api/woocommerce',    woocommerceRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  POS System running at http://localhost:${PORT}\n`);
  });

  // WooCommerce auto-sync — check every 60 s, fire when interval has elapsed
  setInterval(async () => {
    try {
      await ensureReady();
      const { rows: [iRow] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_interval'", args: [] });
      const mins = parseInt(iRow?.value || '0');
      if (!mins) return;
      const { rows: [lRow] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_last_auto_sync'", args: [] });
      const last = lRow?.value ? new Date(lRow.value) : new Date(0);
      if ((Date.now() - last.getTime()) / 60000 >= mins) {
        wooSyncAll().catch(() => {});
      }
    } catch (e) {}
  }, 60000);
}

// Vercel serverless export
module.exports = app;
