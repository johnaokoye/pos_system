# RetailPOS

## Docker deployment

`docker-compose.yml` runs the app against local SQLite by default, persisted via a bind-mounted `./data` volume (`TURSO_DATABASE_URL: file:/app/data/pos.db`). Product images and PO attachments persist separately under `./uploads`. To use Turso instead, remove that env line and set `TURSO_DATABASE_URL` to a real `libsql://` URL plus `TURSO_AUTH_TOKEN`.

```bash
docker compose up -d --build
```

**Always update the checkout before rebuilding** — `--build` only rebuilds from whatever source is already on disk in this directory; it does not pull anything. Run `git pull` (or `git fetch && git reset --hard origin/master`) first, every time.

The running app shows exactly which commit it was built from — in Settings and on the login screen (`Build: <short sha>`) — so a stale deploy is obvious instead of silently running old code. This is detected automatically at build time from `.git` (see the Dockerfile's `build` stage), no env var or extra flag needed; it only shows "unknown" if the image was built from a source with no `.git` at all (e.g. GitHub's "Download ZIP" instead of a clone).

### Deploying via Portainer

This repo is deployed as a Portainer **Git repository** stack (Repository URL + branch, not a pasted/uploaded `docker-compose.yml`) — that's what makes "redeploy" actually fetch new code instead of reusing whatever Portainer cloned last time:

1. When updating the stack, make sure whatever action you take actually re-pulls and rebuilds — Portainer's wording varies by version, but look for something like "Pull latest image"/"Re-clone repository" combined with a rebuild, not just "restart"/"redeploy existing containers". Enabling GitOps auto-updates (webhook, or polling on an interval) on the stack removes the manual step entirely — every push to `master` redeploys on its own.
2. After it comes up, open the app and check `Build: <sha>` (Settings, or the login screen before signing in) against the latest commit on GitHub's `master` branch. If it doesn't match, the stack didn't actually pick up the new code — re-check step 1.

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
