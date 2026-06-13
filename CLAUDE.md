# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start               # production start (default port 3001)
npm run dev             # dev with auto-reload via nodemon
PORT=3002 npm start     # run on a custom port
```

There are no tests or linter configured.

## Architecture

### Backend
- **`server.js`** — Express app. Mounts all routes under `/api/<resource>`, serves `public/` as static files, and falls back to `public/index.html` for all non-API routes (SPA routing). Exports `app` for Vercel serverless.
- **`database.js`** — Single source of truth for the schema. Uses `@libsql/client` which targets `file:pos.db` locally or a Turso remote DB when `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set. `ensureReady()` runs `_init()` once per process (promise-cached); all tables and schema migrations live there, including seed data and additive `ALTER TABLE` migrations for columns added post-launch.
- **`routes/`** — One file per resource (23 files). Each imports `{ db }` from `../database` and uses `db.execute({ sql, args })`. No shared auth middleware — the backend is unprotected; access control is enforced only in the frontend. Cross-route exports: `routes/commissions.js` exports `calcCommission` (called by `routes/transactions.js` after every completed sale); `routes/customers.js` exports `runCreditCheck` (called by `routes/accounts.js` after credit payments). Returns (`returns` / `return_items` tables) are handled inside `routes/transactions.js` via `GET /:id/returns` and `POST /:id/returns`.

### Frontend
- **`public/index.html`** — ~9,245-line single-file vanilla JS SPA. All CSS, HTML templates, and JS live here. The entire application is one `App` object with `render<Section>()` methods (e.g. `renderPOS()`, `renderInventory()`, `renderCRM()`). `App.showSection(name)` is the router.
- **`App.api(method, url, data)`** — central fetch wrapper (`/api` prefix, JSON in/out, throws on non-2xx).
- **`App.can(key)`** — permission helper; reads `App.currentUser.permissions` (JSON blob from `security_groups`). Returns `true` if the user has the permission directly or via a parent permission in `_permissionTree`.
- **Auth** — `POST /api/employees/login` returns the employee record; stored as `App.currentUser` in memory only (no token, no session, no cookies). Passwords are stored as plaintext. Default admin credentials on first run: username `admin`, password `123456` (forced password change on first login).

### Adding schema columns
New columns must be appended to the `migrations` array in `database.js:_init()` as `ALTER TABLE … ADD COLUMN` statements. Each runs inside an empty `try/catch` so duplicate-column errors are silently swallowed on re-runs — this is intentional, not a bug.

### File uploads (multer)
- **Product images** — `POST /api/products/:id/image`, 5 MB limit, images only, stored in `uploads/products/` as `product-<id>-<timestamp>.<ext>`. Served at `/uploads/products/<filename>`. Path persisted in `products.image_path`.
- **PO attachments** — handled in `routes/purchase-orders.js`, stored in `uploads/po-attachments/`, metadata in the `po_attachments` table.

### Stock tracking duality
`products.stock_qty` is the global stock level. `branch_inventory (product_id, branch_id)` tracks per-branch stock separately. When `GET /api/products` is called with `?branch_id=`, the query joins `branch_inventory` and returns branch-level `stock_qty`; without that param it returns the global value. Always update both tables when stock changes.

### Product variations
`product_variation_types` defines attribute axes per product (e.g. Size, Color); `product_variations` holds individual SKU-level variants with their own price/cost/stock. `transaction_items.variation_id` links a sold item to its specific variant.

### Key data relationships
- `employees` → `security_groups` (permissions JSON blob), `branches` (default branch + `employee_branches` join table)
- `transactions` / `transaction_items` → `products`, `customers`, `employees`, `branches`; returns stored in `returns` / `return_items` (linked via `original_transaction_id`)
- `purchase_orders` / `purchase_order_items` → `suppliers`, `branches`; PO attachments in `po_attachments` table
- `products` images stored in `uploads/products/`, served at `/uploads/products/<filename>`
- `quotations` can be converted to transactions (`converted_to_tx` FK)
- `branch_inventory` tracks per-branch stock separately from `products.stock_qty`
- CRM: `crm_leads` → `crm_opportunities` → `crm_activities`; opportunities can link to quotations
- Commissions: `commission_plans` → `employee_commission_plans` (per-employee assignment) → `commission_records` (auto-created by `calcCommission` on sale/opportunity won)
- Warehouse: `warehouse_zones` → `storage_bins` → `product_bin_assignments`; `cycle_count_sessions` / `cycle_count_items` for inventory counts
- Cash drawers: `cash_drawers` → `drawer_sessions` → `drawer_reconciliations` + `reconciliation_note_counts`; `currency_denominations` provides the note/coin values used during reconciliation
- Accounts (AR): `customers` with `credit_enabled=1` carry `account_balance` / `credit_limit`; credit sales use `payment_method='credit'`; payments recorded in `account_payments`; `runCreditCheck` auto-blocks customers who exceed payment terms
- Inter-branch stock: `branch_transfers` records movement between branches; `transfers` permission gates the UI

### Permission keys
The `security_groups.permissions` JSON blob uses these keys (all boolean):
`dashboard`, `pos`, `inventory`, `customers`, `transactions`, `reports`, `employees`, `settings`, `purchasing`, `branches`, `security`, `accounts`, `quotations`, `suppliers`, `transfers`, `crm`, `commissions`, `multi_branch_access`, `warehouse`, `shipping`, `cycle-counts`, `drawers`, `void_transactions`, `promotions`, `process_returns`, `purchase_requests`

Three built-in groups seed on first run: **Administrator** (all true), **Manager** (all except `settings`, `branches`, `security`), **Cashier** (pos, customers, transactions, quotations, dashboard only).

### WooCommerce integration
`routes/woocommerce.js` syncs products and orders between the POS and a WooCommerce store. Credentials (`woo_url`, `woo_consumer_key`, `woo_consumer_secret`) are stored in the `settings` table. HTTP stores use OAuth 1.0a signing (implemented locally); HTTPS stores use Basic Auth. `server.js` polls every 60 seconds and fires a full sync when `woo_sync_interval` minutes have elapsed since `woo_last_auto_sync`. The route also exports `runSyncAll`, imported by `server.js` for that auto-sync.

### Environment variables
| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listen port | `3001` |
| `TURSO_DATABASE_URL` | Remote Turso DB URL | local `file:pos.db` |
| `TURSO_AUTH_TOKEN` | Turso auth token | (none) |

Email/SMTP is configured through the Settings UI and persisted in the `settings` table — not via env vars.

### Deployment
`vercel.json` routes all traffic to `server.js` as a serverless function. Switch the DB to Turso for stateful production use (local `pos.db` is ephemeral on Vercel).
