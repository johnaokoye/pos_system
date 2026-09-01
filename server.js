require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const path = require('path');

const { ensureReady, db } = require('./database');
const { router: woocommerceRouter, runSyncAll: wooSyncAll } = require('./routes/woocommerce');
const { apiKeyAuth } = require('./lib/apiKeyAuth');
const { sessionAuth } = require('./lib/sessionAuth');
const { logActivity } = require('./routes/crm');
const rentalsRouter = require('./routes/rentals');

// Without these, any unhandled rejection (e.g. a bug in one request's async
// code) crashes the entire Node process per Node's default behavior since
// v15 — taking down every other in-flight request and, with no supervisor
// restarting `npm start`, leaving the app looking "frozen" until someone
// notices and manually restarts it. Log and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3001;

// Needed so req.secure reflects X-Forwarded-Proto from a reverse proxy (Vercel,
// or a self-hosted TLS-terminating proxy) — the session cookie's Secure flag
// depends on this being accurate (see lib/sessionAuth.js's setSessionCookie).
app.set('trust proxy', true);

app.use(cors());
// Gzips every response this app sends — API JSON, the ~750KB single-file
// SPA (public/index.html), and static assets — before anything else so it
// covers the whole pipeline. Cheap CPU cost, large win on the wire for the
// SPA payload and any sizeable API response (e.g. product/transaction lists).
app.use(compression());
// Default 100kb limit is too small for bulk CSV imports (inventory/rental
// item lists, PO line items, etc.) serialized to JSON — bump it so those
// requests don't get rejected before reaching the route handler.
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize DB before handling any request
app.use(async (req, res, next) => {
  try { await ensureReady(); next(); } catch(e) { res.status(500).json({ error: 'Database initialization failed' }); }
});

// API key authentication — validates X-API-Key / Authorization: Bearer headers.
// Requests without a key pass through unchanged (frontend browser sessions).
app.use('/api', apiKeyAuth);

// Session cookie authentication for the browser frontend. If apiKeyAuth already
// authenticated this request (req.apiKey set), this no-ops. Otherwise, a valid
// session cookie attaches req.employee; an absent/invalid one just passes
// through with req.employee unset — enforcement happens per-route via
// requireAuth()/requirePermission() (lib/permissions.js), not here.
app.use('/api', sessionAuth);

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
app.use('/api/discount-cards',  require('./routes/discount-cards'));
app.use('/api/cash-back-cards', require('./routes/cash-back-cards'));
app.use('/api/customer-categories', require('./routes/customer-categories'));
app.use('/api/denominations',   require('./routes/denominations'));
app.use('/api/woocommerce',    woocommerceRouter);
app.use('/api/api-keys',       require('./routes/api-keys'));
app.use('/api/rentals',        rentalsRouter);
app.use('/api/layaway',        require('./routes/layaway'));
app.use('/api/work-orders',    require('./routes/work-orders'));
app.use('/api/sales-targets',  require('./routes/sales-targets'));

// Any error under /api (oversized body, malformed JSON, etc.) must come back
// as JSON — App.api()'s res.json() call otherwise chokes on Express's default
// HTML error page (starts with "<!DOCTYPE", which isn't valid JSON).
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Request failed' });
});

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

  // Rental overdue detection — "overdue" is only ever computed live at read
  // time (see rental_agreements' display_status in routes/rentals.js), so
  // this is the one place that turns "due_date has passed" into a one-time
  // CRM activity per rental, guarded by overdue_notified_at so it only
  // fires once per rental. Not time-critical, checked every 30 minutes.
  setInterval(async () => {
    try {
      await ensureReady();
      const { rows: overdue } = await db.execute({
        sql: "SELECT * FROM rental_agreements WHERE status='active' AND due_date < date('now') AND overdue_notified_at IS NULL",
        args: [],
      });
      for (const agreement of overdue) {
        try {
          await db.execute({ sql: 'UPDATE rental_agreements SET overdue_notified_at = CURRENT_TIMESTAMP WHERE id = ?', args: [agreement.id] });
          // completed:false + a past due_date makes this surface in the CRM
          // Activities tab's existing Overdue bucket automatically, no new
          // frontend code needed (public/index.html's renderCrmActivities).
          await logActivity({
            customerId: agreement.customer_id, employeeId: agreement.employee_id,
            type: 'rental', subject: `Rental ${agreement.agreement_number} is overdue (due ${agreement.due_date})`,
            dueDate: agreement.due_date, completed: false,
          });
        } catch(e) {}
      }
    } catch (e) {}
  }, 30 * 60000);

  // Missed-pickup auto-pause — pickup_required rentals are due down to the
  // hour (due_date + checkout time-of-day, see lib/rentals.js's
  // dueDateTime), not just the day, so this runs far more often than the
  // day-granularity overdue check above. Checked every 5 minutes.
  setInterval(async () => {
    try {
      await ensureReady();
      await rentalsRouter.checkMissedPickups();
    } catch (e) {}
  }, 5 * 60000);
}

// Vercel serverless export
module.exports = app;
