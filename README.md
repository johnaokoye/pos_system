# RetailPOS

## Docker deployment

`docker-compose.yml` runs the app against local SQLite by default, persisted via a bind-mounted `./data` volume (`TURSO_DATABASE_URL: file:/app/data/pos.db`). Product images and PO attachments persist separately under `./uploads`. To use Turso instead, remove that env line and set `TURSO_DATABASE_URL` to a real `libsql://` URL plus `TURSO_AUTH_TOKEN`.

```bash
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

`GIT_COMMIT` gets baked into the image and shown in Settings and on the login screen, so you can confirm at a glance which commit a running deployment is actually on — handy since `--build` only rebuilds from whatever's already on disk in this directory. **Always `git pull` (or `git fetch && git reset --hard origin/master`) before running this** — rebuilding without updating the checkout first will happily produce an image with old code and no error. Plain `docker compose up -d --build` (without `GIT_COMMIT=...`) still works, it'll just show "unknown" as the build — a sign the version wasn't stamped, not that anything's broken.

### Resetting the database

Use this when test/demo data needs to be wiped before going live — e.g. after user acceptance testing on the production Docker deployment. Only applies when running on **local SQLite** (the default); if `TURSO_DATABASE_URL` is set to a real `libsql://` URL, delete/recreate the tables via the Turso dashboard or CLI instead.

```bash
docker compose down
rm -f ./data/pos.db ./data/pos.db-wal ./data/pos.db-shm
docker compose up -d
```

On next boot, `database.js` recreates the full schema and reseeds defaults — the three built-in security groups (Administrator, Manager, Cashier) and the default admin login `admin` / `123456` (forced password change on first login).

This wipes all transactions, products, customers, and `settings` table entries (SMTP, Cloudinary, WooCommerce, tax config, etc.) — those will need to be re-entered after reset.

To also clear test product images and PO attachments, remove their contents before restarting:

```bash
rm -rf ./uploads/products/* ./uploads/po-attachments/*
```
