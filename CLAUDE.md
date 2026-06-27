# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start               # production start (default port 3001)
npm run dev             # dev with auto-reload via nodemon
PORT=3002 npm start     # run on a custom port
```

### Tests

Playwright end-to-end tests live in `tests/`. The config in `playwright.config.js` starts the server automatically via `webServer` (reuses an existing one on port 3001 if already running).

```bash
npx playwright test                    # run all tests
npx playwright test tests/auth.spec.js # run a single spec file
npx playwright test --headed           # run with browser visible
```

Test files: `auth.spec.js`, `dashboard.spec.js`, `pos.spec.js`, `inventory.spec.js`, `api.spec.js`. Shared login helper is in `tests/fixtures.js`. The config auto-builds `/tmp/libasound.so.2` stub on systems without `libasound2` installed (WSL/headless Linux).

There is no linter configured.

## Architecture

### Backend
- **`server.js`** — Express app. Mounts all routes under `/api/<resource>`, serves `public/` as static files, and falls back to `public/index.html` for all non-API routes (SPA routing). Exports `app` for Vercel serverless.
- **`database.js`** — Single source of truth for the schema. Uses `@libsql/client` which targets `file:pos.db` locally or a Turso remote DB when `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set. `ensureReady()` runs `_init()` once per process (promise-cached); all tables and schema migrations live there, including seed data and additive `ALTER TABLE` migrations for columns added post-launch.
- **`routes/`** — One file per resource (23 files). Each imports `{ db }` from `../database` and uses `db.execute({ sql, args })`. No shared auth middleware — the backend is unprotected; access control is enforced only in the frontend. Notable non-obvious routes: `categories.js` (product categories, used in inventory filter dropdowns), `denominations.js` (currency note/coin values for drawer reconciliation), `email.js` (SMTP send, credentials from `settings` table). Cross-route exports: `routes/commissions.js` exports `calcCommission` (called by `routes/transactions.js` after every completed sale); `routes/customers.js` exports `runCreditCheck` (called by `routes/accounts.js` after credit payments). Returns (`returns` / `return_items` tables) are handled inside `routes/transactions.js` via `GET /:id/returns` and `POST /:id/returns`.

### Frontend
- **`public/index.html`** — ~9,690-line single-file vanilla JS SPA. All CSS, HTML templates, and JS live here. The entire application is one `App` object with `render<Section>()` methods (e.g. `renderPOS()`, `renderInventory()`, `renderCRM()`). `App.showSection(name)` is the router.
- **`App.api(method, url, data)`** — central fetch wrapper (`/api` prefix, JSON in/out, throws on non-2xx).
- **`App.can(key)`** — permission helper; reads `App.currentUser.permissions` (JSON blob from `security_groups`). Bidirectional: `can('inventory')` returns true if the user has `inventory` OR any of its sub-permissions (`inventory_add`, `inventory_edit`, …); `can('inventory_add')` returns true if the user has `inventory_add` OR the parent `inventory`. Use sub-permission keys to gate fine-grained features without granting the full module.
- **Auth** — `POST /api/employees/login` returns the employee record; stored as `App.currentUser` in memory only (no token, no session, no cookies). Passwords are stored as plaintext. Default admin credentials on first run: username `admin`, password `123456` (forced password change on first login).

### Adding schema columns
New columns must be appended to the `migrations` array in `database.js:_init()` as `ALTER TABLE … ADD COLUMN` statements. Each runs inside an empty `try/catch` so duplicate-column errors are silently swallowed on re-runs — this is intentional, not a bug.

### File uploads (multer + Cloudinary)
- **Product images** — `POST /api/products/:id/image`, 5 MB limit, images only. When Cloudinary is configured, images are uploaded there via `lib/cloudinary.js`; otherwise stored locally in `uploads/products/` as `product-<id>-<timestamp>.<ext>` and served at `/uploads/products/<filename>`. Path persisted in `products.image_path`.
- **PO attachments** — handled in `routes/purchase-orders.js`; same Cloudinary-or-local fallback pattern, stored in `uploads/po-attachments/`, metadata in `po_attachments`.
- **Cloudinary** — `lib/cloudinary.js` exports `cloudUpload` / `cloudDestroy`. Configured via `cloudinary_cloud_name`, `cloudinary_api_key`, `cloudinary_api_secret` keys in the `settings` table (set through the Settings UI). Required for Vercel deployments where the local filesystem is ephemeral.

### Services & non-inventory items
`products` rows where `product_type IN ('service', 'non-inventory')` are surfaced via `renderServices()` in the frontend. There is no separate route or table — they use the same `/api/products` endpoint, filtered by type. These items have no stock tracking (`track_stock = 0`).

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
The `security_groups.permissions` JSON blob uses these keys (all boolean). Module-level keys grant full access; sub-keys gate specific actions within a module — `App.can()` checks both directions.

**Module keys:** `dashboard`, `pos`, `drawers`, `inventory`, `customers`, `transactions`, `reports`, `employees`, `suppliers`, `services`, `purchase_requests`, `purchasing`, `transfers`, `quotations`, `accounts`, `crm`, `commissions`, `warehouse`, `shipping`, `cycle-counts`, `branches`, `security`, `promotions`, `settings`

**Sub-permission keys** (stored and checked via `App.can()` exactly as shown):
- `pos` → `pos_discounts`, `pos_refunds`, `pos_void_items`, `pos_hold`
- `drawers` → `drawers_manage`, `drawers_open`, `drawers_close`, `void_transactions`
- `inventory` → `inventory_add`, `inventory_edit`, `inventory_delete`, `inventory_adjust`
- `customers` → `customers_add`, `customers_edit`, `customers_delete`, `customers_credit`
- `transactions` → `transactions_export`, `transactions_refund`, `transactions_returns`
- `reports` → `reports_export`, `reports_financial`
- `employees` → `employees_add`, `employees_edit`, `employees_delete`, `employees_salaries`
- `suppliers` → `suppliers_add`, `suppliers_edit`, `suppliers_delete`
- `purchase_requests` → `pr_create`, `pr_approve`, `pr_convert`
- `purchasing` → `purchasing_create`, `purchasing_approve`, `purchasing_receive`
- `transfers` → `transfers_create`, `transfers_approve`
- `quotations` → `quotations_create`, `quotations_approve`, `quotations_convert`
- `accounts` → `accounts_create`, `accounts_payments`, `accounts_writeoff`
- `crm` → `crm_leads`, `crm_opportunities`
- `commissions` → `commissions_plans`, `commissions_approve`, `commissions_pay`
- `warehouse` → `warehouse_bins`, `warehouse_assign`
- `shipping` → `shipping_create`, `shipping_carriers`
- `cycle-counts` → `cyclecounts_create`, `cyclecounts_approve`
- `branches` → `branches_add`, `branches_edit`, `branches_delete`
- `security` → `security_manage`, `security_assign`
- `promotions` → `promotions_create`, `promotions_codes`
- `settings` → `settings_company`, `settings_tax`, `settings_payment`, `settings_integrations`

`multi_branch_access` is stored directly in the permissions blob and checked standalone; it has no sub-permissions and does not appear in `_permissionTree`.

**Shipping note:** The `shipping` permission and `renderShipping()` section exist in the frontend, but there is no `routes/shipping.js` and no `/api/shipping` route mounted in `server.js`. The backend for shipping is not yet implemented.

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
