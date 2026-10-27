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
- **`routes/`** — One file per resource (33 files). Each imports `{ db }` from `../database` and uses `db.execute({ sql, args })`. All route files apply `requireAuth`/`requirePermission` from `lib/permissions.js` (backed by the cookie session set up in `lib/sessionAuth.js` — see Auth below); access control is enforced server-side, not just in the frontend. Notable non-obvious routes: `categories.js` (product categories, used in inventory filter dropdowns), `denominations.js` (currency note/coin values for drawer reconciliation), `email.js` (SMTP send, credentials from `settings` table). Cross-route exports: `routes/commissions.js` exports `calcCommission` (called by `routes/transactions.js` after every completed sale); `routes/customers.js` exports `runCreditCheck` (called by `routes/accounts.js` after credit payments). Returns (`returns` / `return_items` tables) are handled inside `routes/transactions.js` via `GET /:id/returns` and `POST /:id/returns`.

### Frontend
- **`public/index.html`** — ~9,690-line single-file vanilla JS SPA. All CSS, HTML templates, and JS live here. The entire application is one `App` object with `render<Section>()` methods (e.g. `renderPOS()`, `renderInventory()`, `renderCRM()`). `App.showSection(name)` is the router.
- **`App.api(method, url, data)`** — central fetch wrapper (`/api` prefix, JSON in/out, throws on non-2xx).
- **`App.can(key)`** — permission helper; reads `App.currentUser.permissions` (JSON blob from `security_groups`). Bidirectional: `can('inventory')` returns true if the user has `inventory` OR any of its sub-permissions (`inventory_add`, `inventory_edit`, …); `can('inventory_add')` returns true if the user has `inventory_add` OR the parent `inventory`. Use sub-permission keys to gate fine-grained features without granting the full module.
- **Auth** — `POST /api/employees/login` returns the employee record and also issues a session: `lib/sessionAuth.js` creates a random token, stores its SHA-256 hash in a `sessions` table, and sets it as an `HttpOnly`/`SameSite=Lax` cookie (`pos_session`) via `setSessionCookie`. Sessions last 8 hours with a sliding expiry — refreshed on every authenticated request — and are enforced per-route with `requireAuth`/`requirePermission` from `lib/permissions.js`; the frontend additionally keeps the returned employee record as `App.currentUser` in memory. Passwords are hashed with bcrypt (`bcryptjs`); legacy plaintext passwords are compared once on login and lazily rehashed to bcrypt on success. Default admin credentials on first run: username `admin`, password `123456` (forced password change on first login).

### Adding schema columns
New columns must be appended to the `migrations` array in `database.js:_init()` as `ALTER TABLE … ADD COLUMN` statements. Each runs inside an empty `try/catch` so duplicate-column errors are silently swallowed on re-runs — this is intentional, not a bug.

### File uploads (multer + Cloudinary)
- **Product images** — `POST /api/products/:id/image`, 5 MB limit, images only. When Cloudinary is configured, images are uploaded there via `lib/cloudinary.js`; otherwise stored locally in `uploads/products/` as `product-<id>-<timestamp>.<ext>` and served at `/uploads/products/<filename>`. Path persisted in `products.image_path`.
- **PO attachments** — handled in `routes/purchase-orders.js`; same Cloudinary-or-local fallback pattern, stored in `uploads/po-attachments/`, metadata in `po_attachments`.
- **PR attachments** — `/api/purchase-requests/:id/attachments` in `routes/purchase-requests.js`; same pattern, stored in `uploads/pr-attachments/` (blocked from static access in `server.js`), metadata in `pr_attachments`. Added at any stage; removable only while the request is draft/submitted/rejected.
- **WO intake photos** — `POST /api/work-orders/:id/photos` (images only, 15 MB, optional `accessory_id`), metadata in `work_order_photos`; local files in `uploads/wo-photos/` (a `PROTECTED_UPLOAD_DIRS` folder). Accessories handed in with the item are `work_order_accessories` (numbered `line_no` → A1, A2…, own `serial_number` + `description`); the item's own number is `work_orders.item_serial`. Both are added until picked up/cancelled, removable only at `intake`. At pickup (`PATCH /work-orders/:id/final-payment`) the cashier ticks accessories handed back (`accessories_returned` ids → `returned_at`/`returned_by`); any not ticked needs `accessories_note` (stored as `work_orders.accessories_pickup_note`). A Not Worth Fixing / Cancelled WO hands the item back with `PATCH /:id/return-to-customer` (same checklist, `checkAccessoryHandBack`/`recordAccessoryHandBack`); status is kept, `returned_to_customer_at/_by` record it.
- **Quote attachments** — `/api/quotations/:id/attachments` in `routes/quotations.js` (retail, rental and Special Project quotes); same pattern, stored in `uploads/quote-attachments/`, metadata in `quote_attachments`. On Special Projects, view needs `special_projects` or `special_projects_approve`; add/remove needs `special_projects`.
- **Attachment privacy** — `server.js` refuses static access to `uploads/{quote,po,rental-po}-attachments/` (they're only served via the authenticated `/download` routes), and redirects a logged-out browser hitting one of those download links to `/?next=<link>`; `App._resumeDownloadAfterLogin()` re-opens it after sign-in. `uploads/` folders listed in `PROTECTED_UPLOAD_DIRS` (`lib/protectedUploads.js` — customer ID/reference/address-proof scans, rental and PO-approval signatures, and `approval-signatures/` — each employee's saved approval signature, stamped on approved POs/PRs/Special Projects/commission records via `resolveApprovalSignature` in `lib/signatures.js`) stay static but require a session (401, or the same login redirect for a browser); emails that show those images must wrap their HTML in `inlineProtectedImages()` so they go out as CID attachments. Products and branding remain public.
- **Cloudinary** — `lib/cloudinary.js` exports `cloudUpload` / `cloudDestroy`. Configured via `cloudinary_cloud_name`, `cloudinary_api_key`, `cloudinary_api_secret` keys in the `settings` table (set through the Settings UI). Required for Vercel deployments where the local filesystem is ephemeral.

### Services & non-inventory items
`products` rows where `product_type IN ('service', 'non-inventory')` are surfaced via `renderServices()` in the frontend. There is no separate route or table — they use the same `/api/products` endpoint, filtered by type. These items have no stock tracking (`track_stock = 0`).

### Stock tracking duality
`products.stock_qty` is the global stock level. `branch_inventory (product_id, branch_id)` tracks per-branch stock separately. When `GET /api/products` is called with `?branch_id=`, the query joins `branch_inventory` and returns branch-level `stock_qty`; without that param it returns the global value. Always update both tables when stock changes.

### Units of measure
`units_of_measure` is the managed list (`/api/units`, `inventory_units`; `allow_decimal` for measured units like yards/kg). A product's stock unit is `products.base_unit_id` (NULL = Each); `product_units (product_id, unit_id, factor, price, barcode)` are its alternate units — `factor` stock units each, own price (NULL = order-only) and barcode. `GET /products` and `/products/:id` attach `units` (branch-tiered prices on the branch list) plus `base_unit_name/abbr/decimal`; the product form sends `base_unit_id` + `units` (replaced only when `units` is in the body). Lines (`transaction_items`, `quotation_items`, `layaway_plan_items`: `uom_id`, `sell_unit` name, snapshotted `units_per`; `purchase_order_items`: `uom_id`, `purchase_unit`, `units_per`) have `quantity` and `unit_price`/`unit_cost` in their unit — every stock move is `quantity × units_per` (`stockUnits()`), quantities can be decimal for an `allow_decimal` unit, and reports multiply by `COALESCE(ti.units_per, 1)` for units sold and COGS. Shared helpers in `lib/units.js` (`resolveUnit`, `resolvePurchaseUnit`, `lineName`, `parseQty`, `stockUnits`; requests send `uom_id`, legacy `sell_unit: 'case'` still resolves); variation, service and rental lines are always the stock unit. The old `products.case_qty/case_price/case_barcode` columns are folded into a "Case" product unit once at startup and then cleared. Frontend: `App._unitChoices()` / `_pickUnit()` (the unit prompt on POS, quotes and POs).

### Product variations
`product_variation_types` defines attribute axes per product (e.g. Size, Color); `product_variations` holds individual SKU-level variants with their own price/cost/stock. `transaction_items.variation_id` links a sold item to its specific variant.

### Key data relationships
- `employees` → `security_groups` (permissions JSON blob), `branches` (default branch + `employee_branches` join table)
- `transactions` / `transaction_items` → `products`, `customers`, `employees`, `branches`; returns stored in `returns` / `return_items` (linked via `original_transaction_id`)
- `purchase_orders` / `purchase_order_items` → `suppliers`, `branches`; PO attachments in `po_attachments` table
- Purchase request lines have `item_type` 'sale' | 'internal' | 'service'; a 'service' line (non-physical: promo video, design work) is free-typed with its scope in `notes`, never a product, and converts to a PO line with `purchase_order_items.item_type = 'service'` + `notes` (no stock on receive, no link-to-inventory)
- Supplier-priced (fuel) purchases: `purchase_requests.request_type = 'supplier_priced'` — catalog items only, $0 cost, qty = authorized maximum; approved request prints/emails an "Authorization to Pump" (`/email/pump-authorization-preview/:id`, `/email/send-pump-authorization/:id`). Converting sets `purchase_orders.supplier_priced = 1` and `purchase_order_items.authorized_qty`; such a PO can't be sent/approved until every line is costed and a `po_attachments` row with `document_type = 'supplier_invoice'` exists (`supplierPricedProblems` in `routes/purchase-orders.js`), is received only once approved, and over-max quantities only warn
- PO currency: `purchase_orders.currency` (NULL = base, `settings.currency`) + `exchange_rate` (base per 1 unit, defaulted from `alt_currencies` by `resolvePoCurrency` in `lib/poLines.js`); all PO amounts are in that currency, receiving converts with `poRate()` for `products.cost` and the A/P bill, and `poBilling` converts received value so it compares with base-currency bills; no rate (`missingRate`) blocks send/receive. PR conversion carries `currency` and each line's `product_url` (→ `purchase_order_items.product_url`)
- PO receipts: each `PATCH /purchase-orders/:id/receive` logs a `po_receipts` row (`RCV-`, its `bill_id`) + `po_receipt_items` (qty, stock units, product `prev_cost`/`new_cost`); the frontend shows a Confirm Counts step before sending it. `POST /:id/receipts/:rid/reverse` (`purchasing_receive`, reason required) takes the stock back off, restores cost if unchanged since, voids the receipt's A/P bill (refused if it has payments), and drops the PO to partial/approved so it can be received again; refused when branch on-hand < reversal or it would go below `quantity_damaged`. Quantity received before receipts were logged (`items[].quantity_unlogged`) is reversed per line via `POST /:id/reverse-unlogged` (no bill handling)
- TEMPORARY clean-up: POs received before receiving required approval can be sent back to `sent` via `PATCH /purchase-orders/:id/reinstate-for-approval` (`purchasing_approve`, reason required) — `reinstated_from_status` holds 'received'/'partial'; approve/reject restore that status (never draft/approved), cancel is blocked meanwhile, stock/receipts/A/P untouched. Safe to remove once those POs are signed off
- `products` images stored in `uploads/products/`, served at `/uploads/products/<filename>`
- `quotations` can be converted to transactions (`converted_to_tx` FK)
- Special Project rental lines (`quotation_items.is_rental_line`, with `rental_start`/`rental_end`): approving the project creates a pending `rental_agreements` row per line (`rental_agreements.quotation_id`, `quotation_items.rental_agreement_id`) that holds the item; it can't be checked out on its own — `POST /transactions` with that `quote_id` moves it to `awaiting_issue`, then it's issued/returned through Rentals as usual
- `branch_inventory` tracks per-branch stock separately from `products.stock_qty`
- CRM: `crm_leads` → `crm_opportunities` → `crm_activities`; opportunities can link to quotations
- Commissions: `commission_plans` → `employee_commission_plans` (per-employee assignment) → `commission_records` (auto-created by `calcCommission` on sale/opportunity won)
- Warehouse: `warehouse_zones` → `storage_bins` → `product_bin_assignments`; `cycle_count_sessions` / `cycle_count_items` for inventory counts
- Cash drawers: `cash_drawers` → `drawer_sessions` → `drawer_reconciliations` + `reconciliation_note_counts`; `currency_denominations` provides the note/coin values used during reconciliation (base + alternate currencies; `settings.alt_currencies` entries are `{ code, base_per_unit, rate }` — Settings asks for `base_per_unit` (1 USD = 155 JMD) and `rate` = 1/base_per_unit is kept for the POS conversions; `GET /api/settings/currency` returns just `{ base, rates: { USD: { base_per_unit } } }` (API key scope `accounts:read`; RetailPOS Books reads it for its exchange rates); counted foreign notes × base_per_unit, saved as `drawer_reconciliations.fx_rates` `{ USD: { base_per_unit } }`, older rows hold the plain `rate`). The float is returned first (`float_returned`; NULL = older count that included it in `cash_counted`), expected cash = cash sales + cash account payments − petty cash (`drawer_payouts`, POS payouts against a voucher number, permission `pos_petty_cash`). All drawer report figures come from `lib/drawerReport.js` (screen, print, `POST /email/send-drawer-report/:id` PDF)
- Accounts (AR): `customers` with `credit_enabled=1` carry `account_balance` / `credit_limit`; credit sales use `payment_method='credit'`; payments are received only at the POS by cashiers (`lib/customerPayments.js`, `/api/customer-payments`, permission `pos_receive_payment`; `POST /accounts/payments` now just returns 410) into `account_payments` with the drawer session — `payment_mode` 'open' (on account, applied to invoices later via `/:id/apply`) or 'invoices' (applied to chosen invoices). Receivables reps allocate/reallocate from RetailPOS Books via `PUT /accounts/payments/:id/allocations` (`setPaymentAllocations` — sets a payment's whole allocation list; never changes the payment), and every allocation change (Books or cashier) is logged in `payment_allocation_changes`; Books also reads `/accounts/customer/:id/receivables`, `/accounts/payments-feed` and `/accounts/allocation-totals`; unapplied amounts count against the oldest invoices in the overdue check, show in aging/statements, and payments count in the drawer's reconciliation; `runCreditCheck` auto-blocks customers whose oldest invoice still owing is past their payment terms or whose balance is over their credit limit (re-run after credit sales and payments); a manual `customers.block_override` ('block' = held by hand while current, 'unblock' = overdue but let through until current again) from the customer form's Block box (`PATCH /customers/:id/credit-block`, needs `customers_credit_block`) is applied on top — see `lib/creditBlock.js`
- Legacy invoices (old-system A/R): `ar_legacy_invoices` + `legacy_invoice_allocations` (not `transactions`/`payment_allocations`, so they never count as sales). Created only by RetailPOS Books via `POST /api/accounts/legacy-invoices` (API key scope `accounts:write`, idempotent on `external_id`), voided via `/:id/void` while unpaid. `lib/legacyInvoices.js` merges them with credit sales for open-invoice lists, oldest-first payment/write-off allocation, statements and the credit-check oldest-unpaid date — any new A/R code that lists or allocates invoices should go through it. Legacy credit notes (old-system credit owed) come the same way via `POST /api/accounts/legacy-credit-notes` (`accounts:write`, idempotent on `account_payments.external_id`) and are stored as an open `account_payments` row with `payment_method='credit_note'` and no drawer session — allocated like an unapplied payment, left out of drawer counts and the AR collections report, voidable (`/:id/void`) only while never allocated
- Accounts payable: `ap_bills` (vendor bills; `status` is only `open`/`void` — paid/partial/overdue are derived from `ap_payment_allocations` of non-void `ap_payments`), routes in `routes/payables.js`, shared helpers in `lib/payables.js`. `PATCH /purchase-orders/:id/receive` creates a bill per receipt (inside its transaction) when the vendor has `sync_ap` on and `voucher_default` isn't "Not vouchered"
- Sales credit (targets, salesperson dashboard/Transactions scoping): `COALESCE(salesperson_id, created_by, employee_id)` (`CREDITED_SQL` in `routes/transactions.js`). `ticketSalesperson()` stores the ticket's initiator in `salesperson_id` when they're an active Salesperson (POS dropdown locked to them), else the cashier's pick. `PATCH /transactions/salesperson` (`sales_manager`, ids[] ≤ 500, null clears) changes it after the sale, logged in `salesperson_changes`. Sale commission goes to the credited person; on a change `moveSaleCommissions` deletes the unpaid `commission_records` (source_type 'transaction') and reruns `calcCommission(..., asOf = sale date)` for the new person — paid records are left and returned as `commissions_paid`
- Inter-branch stock: `branch_transfers` records movement between branches; `transfers` permission gates the UI. Manual transfers start as a request (`POST /transfers`, `transfers_create`, status `requested`, no stock moves); the inventory team sets the sent quantities and sends it (`PATCH /:id/send`, `transfers_approve`) — stock leaves the source then, `quantity_requested` becomes the sent qty and `quantity_asked` keeps the original ask; then `pending` → (`/dispatch`) `in_transit` → `/receive`. Quick transfers (`POST /transfers/quick`, `transfers_quick`, for co-located branches) do send + receive in one transaction — recorded `received` with `is_quick = 1`. Quote/work-order transfers (`lib/transfers.js` `createTransfer` without `request`) skip the request step

### Permission keys
The `security_groups.permissions` JSON blob uses these keys (all boolean). Module-level keys grant full access; sub-keys gate specific actions within a module — `App.can()` checks both directions.

**Module keys:** `dashboard`, `pos`, `drawers`, `inventory`, `customers`, `transactions`, `reports`, `employees`, `suppliers`, `services`, `purchase_requests`, `purchasing`, `transfers`, `quotations`, `accounts`, `payables`, `crm`, `commissions`, `warehouse`, `shipping`, `cycle-counts`, `branches`, `security`, `user-sessions`, `assessment`, `promotions`, `settings`

**Sub-permission keys** (stored and checked via `App.can()` exactly as shown):
- `pos` → `pos_discounts`, `pos_discount_override`, `pos_refunds`, `pos_hold`, `pos_customer_lookup`, `pos_item_lookup`, `pos_tax_exempt`, `pos_reprint_ticket`, `pos_pay_on_account`, `pos_change_quantity`, `pos_cancel_ticket`, `pos_payment`
- `drawers` → `drawers_manage`, `drawers_open`, `drawers_close`, `void_transactions`
- `inventory` → `inventory_add`, `inventory_edit`, `inventory_delete`, `inventory_adjust`, `inventory_print_labels`, `inventory_merge`, `inventory_export`, `inventory_missing_data`, `inventory_template`, `inventory_import`, `inventory_import_history`, `inventory_scan_images`, `inventory_categories`, `inventory_brands`, `inventory_units`
- `customers` → `customers_add`, `customers_edit`, `customers_delete`, `customers_credit`, `customers_import`, `customers_import_history`, `customers_export`, `customers_export_balances`, `customers_missing_rental_info`, `customers_print_history`, `customers_rental_preapprove`, `customers_merge`
- `transactions` → `transactions_export`, `transactions_refund`, `transactions_credit_note`, `transactions_returns`
- `reports` → `reports_export`, `reports_financial`
- `employees` → `employees_add`, `employees_edit`, `employees_delete`, `employees_salaries`
- `suppliers` → `suppliers_add`, `suppliers_edit`, `suppliers_delete`
- `purchase_requests` → `pr_create`, `pr_approve`, `pr_convert`
- `purchasing` → `purchasing_create`, `purchasing_approve`, `purchasing_receive`
- `transfers` → `transfers_create`, `transfers_approve`, `transfers_pickup`, `transfers_dropoff`, `transfers_quick`
- `quotations` → `quotations_create`, `quotations_approve`, `quotations_convert`
- `accounts` → `accounts_create`, `accounts_payments`, `accounts_writeoff`
- `payables` → `payables_bills`, `payables_payments`, `payables_void`
- `crm` → `crm_leads`, `crm_opportunities`
- `commissions` → `commissions_plans`, `commissions_approve`, `commissions_pay`
- `warehouse` → `warehouse_bins`, `warehouse_assign`
- `shipping` → `shipping_create`, `shipping_carriers`
- `cycle-counts` → `cyclecounts_create`, `cyclecounts_approve`
- `branches` → `branches_add`, `branches_edit`, `branches_delete`
- `security` → `security_manage`, `security_assign`
- `user-sessions` → `sessions_logout` (Admin > Active Sessions; force-logout is the sub-key)
- `promotions` → `promotions_create`, `promotions_codes`
- `settings` → `settings_company`, `settings_tax`, `settings_payment`, `settings_integrations`

`multi_branch_access`, `pos_view_margin` (per-line margin on the POS cart), `customers_credit_block` (the credit-account Block box), `pos_receive_payment` (POS Receive Payment — cashiers only), `pos_petty_cash` (POS Petty Cash payouts) and `returns_override` (the manager PIN every return needs — checked server-side in `POST /transactions/:id/return`, stored as `returns.override_by`) are stored directly in the permissions blob and checked standalone; they have no sub-permissions and do not appear in `_permissionTree` — each is its own checkbox in the Security Group editor. `pos_view_margin` is deliberately not a `pos` sub-key, since subs are inherited from a full `pos` grant and cashiers shouldn't see cost by default; `customers_credit_block`, `pos_receive_payment`, `pos_petty_cash` and `returns_override` are kept out of `customers`/`pos`/`transactions` for the same reason.

**Shipping note:** The `shipping` permission and `renderShipping()` section are backed by `shipments` / `shipment_items` in `database.js` and a set of `/shipments*` routes inside `routes/warehouse.js` (mounted at `/api/warehouse`, not a standalone `/api/shipping`). Draft shipments can be created directly or from an online order (`POST /warehouse/shipments/from-order/:txId`); `PATCH /:id/ship` deducts inventory, `/deliver` marks it complete, `/cancel` restores stock if it had already shipped.

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
